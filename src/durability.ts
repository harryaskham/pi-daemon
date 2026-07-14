import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import type { OpenPayload, ProtocolCommand } from "./protocol.js";

export const DURABILITY_FORMAT_VERSION = 1 as const;

export type DurableOpenCommand = Extract<ProtocolCommand, { operation: "open" }>;
export type DurableWakeCommand = Extract<ProtocolCommand, { operation: "wake" }>;

export interface SessionManifest {
  formatVersion: typeof DURABILITY_FORMAT_VERSION;
  sessionId: string;
  generation: number;
  payload: OpenPayload;
  createdAt: string;
  updatedAt: string;
}

export type JournalState = "queued" | "accepted" | "completed" | "failed" | "indeterminate";

export interface JournalError {
  code: string;
  message: string;
  retryable: boolean;
}

export interface JournalEntry {
  formatVersion: typeof DURABILITY_FORMAT_VERSION;
  sessionId: string;
  generation: number;
  idempotencyKey: string;
  requestId: string;
  fingerprint: string;
  state: JournalState;
  command: DurableWakeCommand;
  createdAt: string;
  updatedAt: string;
  result?: unknown;
  error?: JournalError;
}

export interface RecoverySnapshot {
  manifests: SessionManifest[];
  queued: JournalEntry[];
  indeterminate: JournalEntry[];
}

export interface DurabilityStore {
  recover(): Promise<RecoverySnapshot>;
  saveManifest(command: DurableOpenCommand): Promise<SessionManifest>;
  closeSession(sessionId: string, retainArtifacts: boolean): Promise<void>;
  beginRequest(command: DurableWakeCommand): Promise<JournalEntry>;
  markAccepted(sessionId: string, idempotencyKey: string): Promise<JournalEntry>;
  markCompleted(sessionId: string, idempotencyKey: string, result: unknown): Promise<JournalEntry>;
  markFailed(
    sessionId: string,
    idempotencyKey: string,
    error: JournalError,
  ): Promise<JournalEntry>;
  pruneSession(sessionId: string): Promise<number>;
}

export interface FileDurabilityOptions {
  stateDir: string;
  maxTerminalEntriesPerSession?: number;
  terminalRetentionMs?: number;
  maxJournalRecordBytes?: number;
  now?: () => Date;
}

const DEFAULT_MAX_TERMINAL_ENTRIES = 256;
const DEFAULT_TERMINAL_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_JOURNAL_RECORD_BYTES = 1024 * 1024;

/**
 * Owner-local append-only request journal plus atomic logical-session manifests.
 *
 * Journal records intentionally contain the wake command so a queued request is
 * replayable after restart. Callers must protect the state directory as private
 * agent state; prompts/results are never copied into logs or status output.
 */
export class FileDurabilityStore implements DurabilityStore {
  readonly stateDir: string;
  readonly #sessionsDir: string;
  readonly #journalDir: string;
  readonly #maxTerminalEntries: number;
  readonly #terminalRetentionMs: number;
  readonly #maxJournalRecordBytes: number;
  readonly #now: () => Date;
  readonly #entries = new Map<string, Map<string, JournalEntry>>();
  readonly #loadedSessions = new Set<string>();
  readonly #sessionTails = new Map<string, Promise<void>>();
  #initialized = false;

  constructor(options: FileDurabilityOptions) {
    if (options.stateDir.length === 0) throw new Error("stateDir must not be empty");
    this.stateDir = options.stateDir;
    this.#sessionsDir = join(options.stateDir, "sessions");
    this.#journalDir = join(options.stateDir, "journal");
    this.#maxTerminalEntries = positiveInteger(
      options.maxTerminalEntriesPerSession ?? DEFAULT_MAX_TERMINAL_ENTRIES,
      "maxTerminalEntriesPerSession",
    );
    this.#terminalRetentionMs = nonNegativeInteger(
      options.terminalRetentionMs ?? DEFAULT_TERMINAL_RETENTION_MS,
      "terminalRetentionMs",
    );
    this.#maxJournalRecordBytes = positiveInteger(
      options.maxJournalRecordBytes ?? DEFAULT_MAX_JOURNAL_RECORD_BYTES,
      "maxJournalRecordBytes",
    );
    this.#now = options.now ?? (() => new Date());
  }

  async recover(): Promise<RecoverySnapshot> {
    await this.#initialize();
    const manifests = await this.#loadManifests();
    const journalNames = await readdir(this.#journalDir);
    for (const name of journalNames.sort()) {
      if (!name.endsWith(".jsonl")) continue;
      await this.#loadJournalFile(join(this.#journalDir, name));
    }

    const queued: JournalEntry[] = [];
    const indeterminate: JournalEntry[] = [];
    for (const [sessionId, entries] of this.#entries) {
      for (const entry of entries.values()) {
        if (entry.state === "accepted") {
          const transitioned = await this.#transition(
            sessionId,
            entry.idempotencyKey,
            "indeterminate",
          );
          indeterminate.push(cloneEntry(transitioned));
        } else if (entry.state === "queued") {
          queued.push(cloneEntry(entry));
        } else if (entry.state === "indeterminate") {
          indeterminate.push(cloneEntry(entry));
        }
      }
    }
    for (const sessionId of this.#entries.keys()) await this.pruneSession(sessionId);

    return {
      manifests: manifests.sort((a, b) => a.sessionId.localeCompare(b.sessionId)),
      queued: queued.sort(compareJournalEntries),
      indeterminate: indeterminate.sort(compareJournalEntries),
    };
  }

  async saveManifest(command: DurableOpenCommand): Promise<SessionManifest> {
    await this.#initialize();
    return this.#serialize(command.sessionId, async () => {
      await ensurePrivateDirectory(this.#sessionDir(command.sessionId), "logical session directory");
      const path = this.#manifestPath(command.sessionId);
      const previous = await readPrivateJsonIfExists<SessionManifest>(path);
      if (previous !== undefined) validateManifest(previous, path);
      const now = this.#timestamp();
      const manifest: SessionManifest = {
        formatVersion: DURABILITY_FORMAT_VERSION,
        sessionId: command.sessionId,
        generation: command.generation,
        payload: structuredClone(command.payload),
        createdAt: previous?.createdAt ?? now,
        updatedAt: now,
      };
      validateManifest(manifest, path);
      await atomicWritePrivateJson(path, manifest);
      return structuredClone(manifest);
    });
  }

  async closeSession(sessionId: string, retainArtifacts: boolean): Promise<void> {
    await this.#initialize();
    await this.#serialize(sessionId, async () => {
      await rm(this.#manifestPath(sessionId), { force: true });
      if (!retainArtifacts) {
        await rm(this.#sessionDir(sessionId), { recursive: true, force: true });
        await rm(this.#journalPath(sessionId), { force: true });
        this.#entries.delete(sessionId);
        this.#loadedSessions.delete(sessionId);
      }
    });
  }

  async beginRequest(command: DurableWakeCommand): Promise<JournalEntry> {
    await this.#initialize();
    return this.#serialize(command.sessionId, async () => {
      await this.#loadSessionJournal(command.sessionId);
      const entries = this.#entries.get(command.sessionId)!;
      const existing = entries.get(command.idempotencyKey);
      const fingerprint = requestFingerprint(command);
      if (existing !== undefined) {
        if (existing.fingerprint !== fingerprint) {
          throw new DurabilityError(
            "idempotency_conflict",
            "idempotency key was already used for a different wake request",
            { sessionId: command.sessionId, idempotencyKey: command.idempotencyKey },
          );
        }
        return cloneEntry(existing);
      }

      const now = this.#timestamp();
      const entry: JournalEntry = {
        formatVersion: DURABILITY_FORMAT_VERSION,
        sessionId: command.sessionId,
        generation: command.generation,
        idempotencyKey: command.idempotencyKey,
        requestId: command.requestId,
        fingerprint,
        state: "queued",
        command: structuredClone(command),
        createdAt: now,
        updatedAt: now,
      };
      await this.#append(entry);
      entries.set(entry.idempotencyKey, entry);
      return cloneEntry(entry);
    });
  }

  async markAccepted(sessionId: string, idempotencyKey: string): Promise<JournalEntry> {
    return this.#serialize(sessionId, async () => {
      await this.#loadSessionJournal(sessionId);
      return cloneEntry(await this.#transition(sessionId, idempotencyKey, "accepted"));
    });
  }

  async markCompleted(
    sessionId: string,
    idempotencyKey: string,
    result: unknown,
  ): Promise<JournalEntry> {
    const entry = await this.#serialize(sessionId, async () => {
      await this.#loadSessionJournal(sessionId);
      return cloneEntry(
        await this.#transition(sessionId, idempotencyKey, "completed", { result }),
      );
    });
    await this.pruneSession(sessionId);
    return entry;
  }

  async markFailed(
    sessionId: string,
    idempotencyKey: string,
    error: JournalError,
  ): Promise<JournalEntry> {
    const entry = await this.#serialize(sessionId, async () => {
      await this.#loadSessionJournal(sessionId);
      return cloneEntry(
        await this.#transition(sessionId, idempotencyKey, "failed", { error }),
      );
    });
    await this.pruneSession(sessionId);
    return entry;
  }

  async pruneSession(sessionId: string): Promise<number> {
    await this.#initialize();
    return this.#serialize(sessionId, async () => {
      await this.#loadSessionJournal(sessionId);
      const entries = this.#entries.get(sessionId)!;
      const now = this.#now().getTime();
      const terminal = [...entries.values()]
        .filter((entry) => isTerminal(entry.state))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      const keepTerminal = new Set(
        terminal
          .filter(
            (entry, index) =>
              index < this.#maxTerminalEntries &&
              now - Date.parse(entry.updatedAt) <= this.#terminalRetentionMs,
          )
          .map((entry) => entry.idempotencyKey),
      );
      const retained = [...entries.values()]
        .filter((entry) => !isTerminal(entry.state) || keepTerminal.has(entry.idempotencyKey))
        .sort(compareJournalEntries);
      const removed = entries.size - retained.length;
      if (removed === 0) return 0;

      await atomicWriteLines(this.#journalPath(sessionId), retained);
      this.#entries.set(
        sessionId,
        new Map(retained.map((entry) => [entry.idempotencyKey, entry])),
      );
      return removed;
    });
  }

  async #transition(
    sessionId: string,
    idempotencyKey: string,
    state: JournalState,
    patch: { result?: unknown; error?: JournalError } = {},
  ): Promise<JournalEntry> {
    const entries = this.#entries.get(sessionId);
    const current = entries?.get(idempotencyKey);
    if (current === undefined) {
      throw new DurabilityError("journal_entry_missing", "request journal entry does not exist", {
        sessionId,
        idempotencyKey,
      });
    }
    if (!allowedTransition(current.state, state)) {
      if (current.state === state) return current;
      throw new DurabilityError("invalid_journal_transition", "invalid request journal transition", {
        sessionId,
        idempotencyKey,
        from: current.state,
        to: state,
      });
    }

    const next: JournalEntry = {
      ...current,
      state,
      updatedAt: this.#timestamp(),
    };
    delete next.result;
    delete next.error;
    if (patch.result !== undefined) next.result = structuredClone(patch.result);
    if (patch.error !== undefined) next.error = { ...patch.error };
    await this.#append(next);
    entries!.set(idempotencyKey, next);
    return next;
  }

  async #loadManifests(): Promise<SessionManifest[]> {
    const manifests: SessionManifest[] = [];
    for (const name of (await readdir(this.#sessionsDir)).sort()) {
      const sessionDirectory = join(this.#sessionsDir, name);
      await ensurePrivateDirectory(sessionDirectory, "logical session directory");
      const path = join(sessionDirectory, "manifest.json");
      const value = await readPrivateJsonIfExists<unknown>(path);
      if (value === undefined) continue;
      validateManifest(value, path);
      if (name !== encodedSessionId(value.sessionId)) {
        throw corrupt("manifest session does not match directory", path);
      }
      manifests.push(structuredClone(value));
    }
    return manifests;
  }

  async #loadSessionJournal(sessionId: string): Promise<void> {
    if (this.#loadedSessions.has(sessionId)) return;
    const path = this.#journalPath(sessionId);
    await this.#loadJournalFile(path, sessionId);
    if (!this.#entries.has(sessionId)) this.#entries.set(sessionId, new Map());
    this.#loadedSessions.add(sessionId);
  }

  async #loadJournalFile(path: string, expectedSessionId?: string): Promise<void> {
    let content: string;
    try {
      await validatePrivateFileIfExists(path, "request journal");
      content = await readFile(path, "utf8");
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return;
      throw error;
    }
    const lines = content.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!;
      if (line.length === 0) continue;
      let value: unknown;
      try {
        value = JSON.parse(line) as unknown;
      } catch {
        throw new DurabilityError("corrupt_journal", "request journal contains invalid JSON", {
          path,
          line: index + 1,
        });
      }
      validateJournalEntry(value, path, index + 1);
      if (basename(path) !== `${encodedSessionId(value.sessionId)}.jsonl`) {
        throw new DurabilityError("corrupt_journal", "request journal session does not match path", {
          path,
          line: index + 1,
        });
      }
      if (expectedSessionId !== undefined && value.sessionId !== expectedSessionId) {
        throw new DurabilityError("corrupt_journal", "request journal session does not match path", {
          path,
          line: index + 1,
        });
      }
      const entries = this.#entries.get(value.sessionId) ?? new Map<string, JournalEntry>();
      entries.set(value.idempotencyKey, value);
      this.#entries.set(value.sessionId, entries);
      this.#loadedSessions.add(value.sessionId);
    }
  }

  async #append(entry: JournalEntry): Promise<void> {
    const path = this.#journalPath(entry.sessionId);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    let line: string;
    try {
      line = `${JSON.stringify(entry)}\n`;
    } catch (error) {
      throw new DurabilityError("journal_serialization_failed", "request state is not JSON serializable", {
        cause: error instanceof Error ? error.message : "unknown error",
      });
    }
    await validatePrivateFileIfExists(path, "request journal");
    const recordBytes = Buffer.byteLength(line, "utf8");
    if (recordBytes > this.#maxJournalRecordBytes) {
      throw new DurabilityError("journal_record_too_large", "request journal record exceeds byte limit", {
        maxJournalRecordBytes: this.#maxJournalRecordBytes,
        recordBytes,
      });
    }
    const handle = await open(path, "a", 0o600);
    try {
      await handle.writeFile(line, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await chmod(path, 0o600);
  }

  async #initialize(): Promise<void> {
    if (this.#initialized) return;
    await ensurePrivateDirectory(this.stateDir, "state directory");
    await ensurePrivateDirectory(this.#sessionsDir, "sessions directory");
    await ensurePrivateDirectory(this.#journalDir, "journal directory");
    this.#initialized = true;
  }

  #manifestPath(sessionId: string): string {
    return join(this.#sessionDir(sessionId), "manifest.json");
  }

  #sessionDir(sessionId: string): string {
    return join(this.#sessionsDir, encodedSessionId(sessionId));
  }

  #journalPath(sessionId: string): string {
    return join(this.#journalDir, `${encodedSessionId(sessionId)}.jsonl`);
  }

  #timestamp(): string {
    return this.#now().toISOString();
  }

  #serialize<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#sessionTails.get(sessionId) ?? Promise.resolve();
    const task = previous.then(operation, operation);
    const tail = task.then(
      () => undefined,
      () => undefined,
    );
    this.#sessionTails.set(sessionId, tail);
    void tail.then(() => {
      if (this.#sessionTails.get(sessionId) === tail) this.#sessionTails.delete(sessionId);
    });
    return task;
  }
}

export class DurabilityError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "DurabilityError";
    this.code = code;
    this.details = details;
  }
}

export function requestFingerprint(command: DurableWakeCommand): string {
  const semantic = {
    sessionId: command.sessionId,
    generation: command.generation,
    idempotencyKey: command.idempotencyKey,
    payload: command.payload,
  };
  return createHash("sha256").update(canonicalJson(semantic)).digest("hex");
}

export function encodedSessionId(sessionId: string): string {
  if (sessionId.length === 0) throw new Error("sessionId must not be empty");
  return `s-${Buffer.from(sessionId, "utf8").toString("base64url")}`;
}

function allowedTransition(from: JournalState, to: JournalState): boolean {
  switch (from) {
    case "queued":
      return to === "accepted" || to === "failed";
    case "accepted":
      return to === "completed" || to === "failed" || to === "indeterminate";
    case "completed":
    case "failed":
    case "indeterminate":
      return false;
  }
}

function isTerminal(state: JournalState): boolean {
  return state === "completed" || state === "failed" || state === "indeterminate";
}

function compareJournalEntries(a: JournalEntry, b: JournalEntry): number {
  return a.createdAt.localeCompare(b.createdAt) || a.idempotencyKey.localeCompare(b.idempotencyKey);
}

function validateManifest(value: unknown, path: string): asserts value is SessionManifest {
  if (!isRecord(value)) throw corrupt("manifest is not an object", path);
  if (value.formatVersion !== DURABILITY_FORMAT_VERSION) {
    throw corrupt("unsupported manifest format", path);
  }
  if (typeof value.sessionId !== "string" || value.sessionId.length === 0) {
    throw corrupt("manifest sessionId is invalid", path);
  }
  if (!Number.isSafeInteger(value.generation) || (value.generation as number) < 0) {
    throw corrupt("manifest generation is invalid", path);
  }
  if (!isRecord(value.payload)) throw corrupt("manifest payload is invalid", path);
  if (typeof value.createdAt !== "string" || typeof value.updatedAt !== "string") {
    throw corrupt("manifest timestamps are invalid", path);
  }
}

function validateJournalEntry(
  value: unknown,
  path: string,
  line: number,
): asserts value is JournalEntry {
  if (!isRecord(value)) throw corrupt("journal record is not an object", path, line);
  if (value.formatVersion !== DURABILITY_FORMAT_VERSION) {
    throw corrupt("unsupported journal format", path, line);
  }
  for (const field of ["sessionId", "idempotencyKey", "requestId", "fingerprint"]) {
    if (typeof value[field] !== "string" || value[field].length === 0) {
      throw corrupt(`journal ${field} is invalid`, path, line);
    }
  }
  if (!Number.isSafeInteger(value.generation) || (value.generation as number) < 0) {
    throw corrupt("journal generation is invalid", path, line);
  }
  if (!isJournalState(value.state)) throw corrupt("journal state is invalid", path, line);
  if (!isRecord(value.command) || value.command.operation !== "wake") {
    throw corrupt("journal command is invalid", path, line);
  }
  if (typeof value.createdAt !== "string" || typeof value.updatedAt !== "string") {
    throw corrupt("journal timestamps are invalid", path, line);
  }
}

function isJournalState(value: unknown): value is JournalState {
  return ["queued", "accepted", "completed", "failed", "indeterminate"].includes(
    value as JournalState,
  );
}

function corrupt(message: string, path: string, line?: number): DurabilityError {
  return new DurabilityError("corrupt_state", message, {
    path,
    ...(line === undefined ? {} : { line }),
  });
}

export async function ensurePrivateDirectory(path: string, label: string): Promise<void> {
  try {
    await mkdir(path, { recursive: true, mode: 0o700 });
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new DurabilityError("insecure_state_path", `${label} must be a real directory`, {
        path,
      });
    }
    const getuid = process.getuid;
    if (getuid !== undefined && info.uid !== getuid()) {
      throw new DurabilityError("insecure_state_path", `${label} must be owned by current user`, {
        path,
      });
    }
    if ((info.mode & 0o077) !== 0) {
      throw new DurabilityError("insecure_state_path", `${label} must be owner-only`, {
        path,
        mode: info.mode & 0o777,
      });
    }
  } catch (error) {
    if (error instanceof DurabilityError) throw error;
    throw error;
  }
}

export async function validatePrivateFileIfExists(path: string, label: string): Promise<void> {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return;
    throw error;
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new DurabilityError("insecure_state_path", `${label} must be a regular file`, { path });
  }
  const getuid = process.getuid;
  if (getuid !== undefined && info.uid !== getuid()) {
    throw new DurabilityError("insecure_state_path", `${label} must be owned by current user`, {
      path,
    });
  }
  if ((info.mode & 0o077) !== 0) {
    throw new DurabilityError("insecure_state_path", `${label} must be owner-only`, {
      path,
      mode: info.mode & 0o777,
    });
  }
}

export async function readPrivateJsonIfExists<T>(path: string): Promise<T | undefined> {
  try {
    await validatePrivateFileIfExists(path, "state file");
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    if (error instanceof SyntaxError) throw corrupt("state file contains invalid JSON", path);
    throw error;
  }
}

export async function atomicWritePrivateJson(path: string, value: unknown): Promise<void> {
  await atomicWrite(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function atomicWriteLines(path: string, values: unknown[]): Promise<void> {
  await atomicWrite(path, values.map((value) => JSON.stringify(value)).join("\n") + "\n");
}

async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
  await chmod(path, 0o600);
  const directory = await open(dirname(path), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

function cloneEntry(entry: JournalEntry): JournalEntry {
  return structuredClone(entry);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${field} must be a positive safe integer`);
  }
  return value;
}

function nonNegativeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative safe integer`);
  }
  return value;
}

/** Exposed for diagnostics/tests without leaking file content. */
export async function stateFileSize(path: string): Promise<number | undefined> {
  try {
    return (await stat(path)).size;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
}
