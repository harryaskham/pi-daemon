import { createHash } from "node:crypto";
import { readdir, rm } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import {
  atomicWritePrivateJson,
  encodedSessionId,
  ensurePrivateDirectory,
  readPrivateJsonIfExists,
  stateFileSize,
} from "./durability.js";
import type {
  SessionApiState,
  SessionEnvironmentSummary,
  SessionResource,
  SessionSpec,
  SessionTerminalSummary,
} from "./session-api.js";

export const SESSION_CATALOG_FORMAT_VERSION = 1 as const;
export const DEFAULT_MAX_CATALOG_SESSIONS = 4096;
export const DEFAULT_MAX_CATALOG_RECORD_BYTES = 1024 * 1024;
export const DEFAULT_CATALOG_PAGE_SIZE = 50;
export const MAX_CATALOG_PAGE_SIZE = 100;

export type SessionResidency = "resident" | "dormant";
export type PersistedSessionSpec = Omit<SessionSpec, "env">;
export type SessionTerminalState = SessionTerminalSummary["state"];

export interface SessionConversationIdentity {
  sessionId: string;
  sessionFile?: string;
}

export type SessionTerminalRecord = SessionTerminalSummary;

export interface SessionCatalogRecord {
  formatVersion: typeof SESSION_CATALOG_FORMAT_VERSION;
  sessionId: string;
  name?: string;
  generation: number;
  revision: number;
  residency: SessionResidency;
  state: SessionApiState;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string;
  spec: PersistedSessionSpec;
  environment: SessionEnvironmentSummary;
  policyDigest: string;
  conversation?: SessionConversationIdentity;
  lastTerminal?: SessionTerminalRecord;
}

export interface SessionCatalogPage {
  sessions: SessionCatalogRecord[];
  nextCursor?: string;
}

export interface SessionCatalogCreateInput {
  sessionId: string;
  name?: string;
  generation: number;
  spec: PersistedSessionSpec;
  environment?: SessionEnvironmentSummary;
  residency?: SessionResidency;
  state?: SessionApiState;
  conversation?: SessionConversationIdentity;
  policyDigest?: string;
}

type SessionCatalogPatch = Omit<
  Partial<SessionCatalogRecord>,
  "name" | "conversation"
> & {
  name?: string | undefined;
  conversation?: SessionConversationIdentity | undefined;
};

export interface SessionCatalogReplaceInput {
  expectedGeneration: number;
  expectedRevision: number;
  generation: number;
  name?: string | null;
  spec: PersistedSessionSpec;
  environment: SessionEnvironmentSummary;
  residency: SessionResidency;
  state: SessionApiState;
  conversation?: SessionConversationIdentity | null;
  policyDigest?: string;
}

export interface SessionCatalogStore {
  recover(): Promise<SessionCatalogRecord[]>;
  create(input: SessionCatalogCreateInput): Promise<SessionCatalogRecord>;
  replace(sessionRef: string, input: SessionCatalogReplaceInput): Promise<SessionCatalogRecord>;
  get(sessionRef: string): Promise<SessionCatalogRecord | undefined>;
  list(options?: { limit?: number; cursor?: string }): Promise<SessionCatalogPage>;
  markResident(
    sessionId: string,
    generation: number,
    conversation?: SessionConversationIdentity,
  ): Promise<SessionCatalogRecord>;
  markDormant(sessionId: string, generation: number): Promise<SessionCatalogRecord>;
  markState(
    sessionId: string,
    generation: number,
    state: SessionApiState,
    options?: { lastUsedAt?: string; terminal?: SessionTerminalRecord },
  ): Promise<SessionCatalogRecord>;
  delete(sessionRef: string): Promise<SessionCatalogRecord | undefined>;
}

export class SessionCatalogError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly details: Record<string, unknown> | undefined;

  constructor(
    code: string,
    message: string,
    options: { retryable?: boolean; details?: Record<string, unknown> } = {},
  ) {
    super(message);
    this.name = "SessionCatalogError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }
}

export class FileSessionCatalog implements SessionCatalogStore {
  readonly stateDir: string;
  readonly #catalogDir: string;
  readonly #maxSessions: number;
  readonly #maxRecordBytes: number;
  readonly #now: () => Date;
  readonly #records = new Map<string, SessionCatalogRecord>();
  readonly #names = new Map<string, string>();
  #tail: Promise<void> = Promise.resolve();
  #recovery: Promise<void> | undefined;
  #initialized = false;
  #recovered = false;

  constructor(options: {
    stateDir: string;
    maxSessions?: number;
    maxRecordBytes?: number;
    now?: () => Date;
  }) {
    if (options.stateDir.length === 0) throw new Error("stateDir must not be empty");
    this.stateDir = options.stateDir;
    this.#catalogDir = join(options.stateDir, "catalog");
    this.#maxSessions = positiveInteger(
      options.maxSessions ?? DEFAULT_MAX_CATALOG_SESSIONS,
      "maxSessions",
    );
    this.#maxRecordBytes = positiveInteger(
      options.maxRecordBytes ?? DEFAULT_MAX_CATALOG_RECORD_BYTES,
      "maxRecordBytes",
    );
    this.#now = options.now ?? (() => new Date());
  }

  async recover(): Promise<SessionCatalogRecord[]> {
    await this.#ensureRecovered();
    return this.#all();
  }

  async create(input: SessionCatalogCreateInput): Promise<SessionCatalogRecord> {
    return this.#serialize(async () => {
      await this.#ensureRecovered();
      validateCatalogSessionId(input.sessionId);
      validateGeneration(input.generation);
      validatePersistedSpec(input.spec);
      if (this.#records.has(input.sessionId)) {
        throw new SessionCatalogError("session_exists", "session ID already exists", {
          details: { sessionId: input.sessionId },
        });
      }
      const nameOwner = this.#names.get(input.sessionId);
      if (nameOwner !== undefined && nameOwner !== input.sessionId) {
        throw new SessionCatalogError(
          "session_name_conflict",
          "session ID conflicts with an existing session name",
          { details: { sessionId: input.sessionId } },
        );
      }
      if (this.#records.size >= this.#maxSessions) {
        throw new SessionCatalogError("catalog_capacity", "retained session capacity reached", {
          retryable: true,
          details: { maxSessions: this.#maxSessions },
        });
      }
      if (input.name !== undefined) this.#assertNameAvailable(input.name, input.sessionId);
      const now = this.#timestamp();
      const record: SessionCatalogRecord = {
        formatVersion: SESSION_CATALOG_FORMAT_VERSION,
        sessionId: input.sessionId,
        generation: input.generation,
        revision: 1,
        residency: input.residency ?? "resident",
        state: input.state ?? "idle",
        createdAt: now,
        updatedAt: now,
        lastUsedAt: now,
        spec: structuredClone(input.spec),
        environment: structuredClone(input.environment ?? emptyEnvironment()),
        policyDigest: input.policyDigest ?? sessionSpecDigest(input.spec),
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.conversation === undefined
          ? {}
          : { conversation: structuredClone(input.conversation) }),
      };
      validateCatalogRecord(record, this.#path(record.sessionId));
      await this.#write(record);
      this.#records.set(record.sessionId, record);
      if (record.name !== undefined) this.#names.set(record.name, record.sessionId);
      return cloneRecord(record);
    });
  }

  async replace(
    sessionRef: string,
    input: SessionCatalogReplaceInput,
  ): Promise<SessionCatalogRecord> {
    return this.#serialize(async () => {
      await this.#ensureRecovered();
      const current = this.#require(sessionRef);
      this.#assertVersion(current, input.expectedGeneration, input.expectedRevision);
      validateGeneration(input.generation);
      if (input.generation < current.generation) {
        throw new SessionCatalogError("stale_generation", "session generation is stale", {
          details: { currentGeneration: current.generation, receivedGeneration: input.generation },
        });
      }
      validatePersistedSpec(input.spec);
      const nextName = input.name === null ? undefined : (input.name ?? current.name);
      if (nextName !== undefined) this.#assertNameAvailable(nextName, current.sessionId);
      const next = this.#next(current, {
        generation: input.generation,
        residency: input.residency,
        state: input.state,
        spec: structuredClone(input.spec),
        environment: structuredClone(input.environment),
        policyDigest: input.policyDigest ?? sessionSpecDigest(input.spec),
        ...(nextName === undefined ? { name: undefined } : { name: nextName }),
        ...(input.conversation === null
          ? { conversation: undefined }
          : input.conversation === undefined
            ? {}
            : { conversation: structuredClone(input.conversation) }),
      });
      await this.#write(next);
      this.#replaceIndexes(current, next);
      return cloneRecord(next);
    });
  }

  async get(sessionRef: string): Promise<SessionCatalogRecord | undefined> {
    return this.#serialize(async () => {
      await this.#ensureRecovered();
      const record = this.#resolve(sessionRef);
      return record === undefined ? undefined : cloneRecord(record);
    });
  }

  async list(options: { limit?: number; cursor?: string } = {}): Promise<SessionCatalogPage> {
    return this.#serialize(async () => {
      await this.#ensureRecovered();
      const limit = pageLimit(options.limit ?? DEFAULT_CATALOG_PAGE_SIZE);
      const after = options.cursor === undefined ? undefined : decodeCursor(options.cursor);
      const records = this.#all().filter((record) => after === undefined || record.sessionId > after);
      const sessions = records.slice(0, limit);
      const page: SessionCatalogPage = { sessions };
      if (records.length > sessions.length) {
        page.nextCursor = encodeCursor(sessions[sessions.length - 1]!.sessionId);
      }
      return page;
    });
  }

  async markResident(
    sessionId: string,
    generation: number,
    conversation?: SessionConversationIdentity,
  ): Promise<SessionCatalogRecord> {
    return this.#transition(sessionId, generation, {
      residency: "resident",
      state: "idle",
      ...(conversation === undefined ? {} : { conversation: structuredClone(conversation) }),
    });
  }

  async markDormant(sessionId: string, generation: number): Promise<SessionCatalogRecord> {
    return this.#transition(sessionId, generation, {
      residency: "dormant",
      state: "idle",
    });
  }

  async markState(
    sessionId: string,
    generation: number,
    state: SessionApiState,
    options: { lastUsedAt?: string; terminal?: SessionTerminalRecord } = {},
  ): Promise<SessionCatalogRecord> {
    return this.#transition(sessionId, generation, {
      state,
      ...(options.lastUsedAt === undefined ? {} : { lastUsedAt: options.lastUsedAt }),
      ...(options.terminal === undefined
        ? {}
        : { lastTerminal: structuredClone(options.terminal) }),
    });
  }

  async delete(sessionRef: string): Promise<SessionCatalogRecord | undefined> {
    return this.#serialize(async () => {
      await this.#ensureRecovered();
      const current = this.#resolve(sessionRef);
      if (current === undefined) return undefined;
      await rm(this.#path(current.sessionId), { force: true });
      this.#records.delete(current.sessionId);
      if (current.name !== undefined) this.#names.delete(current.name);
      return cloneRecord(current);
    });
  }

  async #transition(
    sessionId: string,
    generation: number,
    patch: SessionCatalogPatch,
  ): Promise<SessionCatalogRecord> {
    return this.#serialize(async () => {
      await this.#ensureRecovered();
      const current = this.#require(sessionId);
      if (current.generation !== generation) {
        throw new SessionCatalogError("stale_generation", "session generation does not match", {
          details: { currentGeneration: current.generation, receivedGeneration: generation },
        });
      }
      const next = this.#next(current, patch);
      await this.#write(next);
      this.#replaceIndexes(current, next);
      return cloneRecord(next);
    });
  }

  #next(
    current: SessionCatalogRecord,
    patch: SessionCatalogPatch,
  ): SessionCatalogRecord {
    const next = {
      ...current,
      ...patch,
      formatVersion: SESSION_CATALOG_FORMAT_VERSION,
      sessionId: current.sessionId,
      revision: current.revision + 1,
      updatedAt: this.#timestamp(),
    } as SessionCatalogRecord;
    if (patch.name === undefined && "name" in patch) delete next.name;
    if (patch.conversation === undefined && "conversation" in patch) delete next.conversation;
    validateCatalogRecord(next, this.#path(next.sessionId));
    return next;
  }

  #replaceIndexes(current: SessionCatalogRecord, next: SessionCatalogRecord): void {
    if (current.name !== undefined && current.name !== next.name) this.#names.delete(current.name);
    this.#records.set(next.sessionId, next);
    if (next.name !== undefined) this.#names.set(next.name, next.sessionId);
  }

  #resolve(sessionRef: string): SessionCatalogRecord | undefined {
    const byId = this.#records.get(sessionRef);
    if (byId !== undefined) return byId;
    const sessionId = this.#names.get(sessionRef);
    return sessionId === undefined ? undefined : this.#records.get(sessionId);
  }

  #require(sessionRef: string): SessionCatalogRecord {
    const record = this.#resolve(sessionRef);
    if (record === undefined) {
      throw new SessionCatalogError("session_not_found", "retained session does not exist", {
        details: { sessionRef },
      });
    }
    return record;
  }

  #assertNameAvailable(name: string, sessionId: string): void {
    validateName(name);
    const byId = this.#records.get(name);
    const byName = this.#names.get(name);
    if ((byId !== undefined && byId.sessionId !== sessionId) || (byName !== undefined && byName !== sessionId)) {
      throw new SessionCatalogError("session_name_conflict", "session name is already in use", {
        details: { name },
      });
    }
  }

  #assertVersion(
    record: SessionCatalogRecord,
    expectedGeneration: number,
    expectedRevision: number,
  ): void {
    if (record.generation !== expectedGeneration || record.revision !== expectedRevision) {
      throw new SessionCatalogError("session_precondition_failed", "session version changed", {
        details: {
          expectedGeneration,
          expectedRevision,
          currentGeneration: record.generation,
          currentRevision: record.revision,
        },
      });
    }
  }

  #register(record: SessionCatalogRecord, path: string): void {
    const nameOwner = this.#names.get(record.sessionId);
    if (nameOwner !== undefined && nameOwner !== record.sessionId) {
      throw corrupt("catalog session ID conflicts with another session name", path);
    }
    if (record.name !== undefined) {
      const owner = this.#names.get(record.name);
      if (owner !== undefined && owner !== record.sessionId) {
        throw corrupt("duplicate catalog session name", path);
      }
      if (this.#records.has(record.name) && record.name !== record.sessionId) {
        throw corrupt("catalog name conflicts with another session ID", path);
      }
      this.#names.set(record.name, record.sessionId);
    }
    this.#records.set(record.sessionId, record);
  }

  #all(): SessionCatalogRecord[] {
    return [...this.#records.values()]
      .sort((a, b) => a.sessionId.localeCompare(b.sessionId))
      .map(cloneRecord);
  }

  async #write(record: SessionCatalogRecord): Promise<void> {
    let serialized: string;
    try {
      serialized = JSON.stringify(record);
    } catch {
      throw new SessionCatalogError(
        "catalog_serialization_failed",
        "session catalog record is not JSON serializable",
      );
    }
    const recordBytes = Buffer.byteLength(serialized, "utf8");
    if (recordBytes > this.#maxRecordBytes) {
      throw new SessionCatalogError(
        "catalog_record_too_large",
        "session catalog record exceeds byte limit",
        { details: { maxRecordBytes: this.#maxRecordBytes, recordBytes } },
      );
    }
    await atomicWritePrivateJson(this.#path(record.sessionId), record);
  }

  #path(sessionId: string): string {
    return join(this.#catalogDir, `${encodedSessionId(sessionId)}.json`);
  }

  async #initialize(): Promise<void> {
    if (this.#initialized) return;
    await ensurePrivateDirectory(this.stateDir, "state directory");
    await ensurePrivateDirectory(this.#catalogDir, "session catalog directory");
    this.#initialized = true;
  }

  async #ensureRecovered(): Promise<void> {
    if (this.#recovered) return;
    this.#recovery ??= this.#load();
    await this.#recovery;
  }

  async #load(): Promise<void> {
    await this.#initialize();
    for (const name of (await readdir(this.#catalogDir)).sort()) {
      if (!name.endsWith(".json")) continue;
      const path = join(this.#catalogDir, name);
      const bytes = await stateFileSize(path);
      if (bytes !== undefined && bytes > this.#maxRecordBytes) {
        throw new SessionCatalogError(
          "catalog_record_too_large",
          "session catalog record exceeds byte limit",
          { details: { path, maxRecordBytes: this.#maxRecordBytes, recordBytes: bytes } },
        );
      }
      const value = await readPrivateJsonIfExists<unknown>(path);
      if (value === undefined) continue;
      validateCatalogRecord(value, path);
      if (name !== `${encodedSessionId(value.sessionId)}.json`) {
        throw corrupt("catalog session does not match path", path);
      }
      if (this.#records.has(value.sessionId)) {
        throw corrupt("duplicate catalog session ID", path);
      }
      this.#register(value, path);
    }
    if (this.#records.size > this.#maxSessions) {
      throw new SessionCatalogError(
        "catalog_capacity",
        "retained session catalog exceeds configured capacity",
        { details: { maxSessions: this.#maxSessions, actual: this.#records.size } },
      );
    }

    // A process restart makes every previously resident SDK object dormant
    // until the multiplexer explicitly reopens and marks it resident.
    for (const record of [...this.#records.values()]) {
      if (record.residency !== "resident") continue;
      const next = this.#next(record, {
        residency: "dormant",
        state: record.state === "failed" ? "failed" : "idle",
      });
      await this.#write(next);
      this.#records.set(next.sessionId, next);
    }
    this.#recovered = true;
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.#tail.then(operation, operation);
    this.#tail = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  #timestamp(): string {
    return this.#now().toISOString();
  }
}

export function catalogRecordToSessionResource(
  record: SessionCatalogRecord,
): SessionResource {
  const sessionRef = encodeURIComponent(record.sessionId);
  return {
    sessionId: record.sessionId,
    ...(record.name === undefined ? {} : { name: record.name }),
    generation: record.generation,
    revision: record.revision,
    residency: record.residency,
    state: record.state,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    lastUsedAt: record.lastUsedAt,
    spec: structuredClone(record.spec),
    environment: structuredClone(record.environment),
    ...(record.lastTerminal === undefined
      ? {}
      : { lastTerminal: structuredClone(record.lastTerminal) }),
    links: {
      self: `/v1/session/${sessionRef}`,
      rpc: `/v1/session/${sessionRef}/rpc`,
      apc: `/v1/session/${sessionRef}/apc`,
    },
  };
}

export function sessionSpecDigest(spec: PersistedSessionSpec): string {
  validatePersistedSpec(spec);
  return createHash("sha256").update(canonicalJson(spec)).digest("hex");
}

export function emptyEnvironment(): SessionEnvironmentSummary {
  return { keys: [], persistence: "memory-only", provisioned: true };
}

function validateCatalogRecord(
  value: unknown,
  path: string,
): asserts value is SessionCatalogRecord {
  if (!isRecord(value)) throw corrupt("catalog record is not an object", path);
  if (value.formatVersion !== SESSION_CATALOG_FORMAT_VERSION) {
    throw corrupt("unsupported catalog format", path);
  }
  validateSessionIdField(value.sessionId, path);
  if (value.name !== undefined) validateNameField(value.name, path);
  validateGenerationField(value.generation, path);
  if (!Number.isSafeInteger(value.revision) || (value.revision as number) < 1) {
    throw corrupt("catalog revision is invalid", path);
  }
  if (!(["resident", "dormant"] as unknown[]).includes(value.residency)) {
    throw corrupt("catalog residency is invalid", path);
  }
  if (!(["opening", "idle", "running", "failed", "closing"] as unknown[]).includes(value.state)) {
    throw corrupt("catalog runtime state is invalid", path);
  }
  if (value.residency === "dormant" && value.state !== "idle" && value.state !== "failed") {
    throw corrupt("dormant catalog session has an active runtime state", path);
  }
  for (const field of ["createdAt", "updatedAt", "lastUsedAt", "policyDigest"]) {
    if (typeof value[field] !== "string" || value[field].length === 0) {
      throw corrupt(`catalog ${field} is invalid`, path);
    }
  }
  validatePersistedSpecField(value.spec, path);
  validateEnvironment(value.environment, path);
  if (value.conversation !== undefined) validateConversation(value.conversation, path);
  if (value.lastTerminal !== undefined) validateTerminal(value.lastTerminal, path);
}

function validatePersistedSpec(spec: PersistedSessionSpec): void {
  if (!isRecord(spec)) throw new SessionCatalogError("invalid_session_spec", "session spec must be an object");
  if ("env" in spec) {
    throw new SessionCatalogError("secret_persistence_refused", "raw environment must not be persisted");
  }
  if (typeof spec.cwd !== "string" || spec.cwd.length < 1 || spec.cwd.length > 4096) {
    throw new SessionCatalogError("invalid_session_spec", "session cwd is invalid");
  }
  if (!isRecord(spec.target) || typeof spec.target.mode !== "string") {
    throw new SessionCatalogError("invalid_session_spec", "session target is invalid");
  }
}

function validatePersistedSpecField(value: unknown, path: string): asserts value is PersistedSessionSpec {
  try {
    validatePersistedSpec(value as PersistedSessionSpec);
  } catch (error) {
    throw corrupt(error instanceof Error ? error.message : "catalog spec is invalid", path);
  }
}

function validateEnvironment(value: unknown, path: string): asserts value is SessionEnvironmentSummary {
  if (!isRecord(value) || !Array.isArray(value.keys)) {
    throw corrupt("catalog environment summary is invalid", path);
  }
  const keys = value.keys;
  if (!keys.every((key) => typeof key === "string" && key.length > 0 && key.length <= 256)) {
    throw corrupt("catalog environment keys are invalid", path);
  }
  const stringKeys = keys as string[];
  const sortedKeys = [...stringKeys].sort((a, b) => a.localeCompare(b));
  if (
    new Set(stringKeys).size !== stringKeys.length ||
    sortedKeys.some((key, index) => key !== stringKeys[index])
  ) {
    throw corrupt("catalog environment keys must be unique and sorted", path);
  }
  if (value.persistence !== "memory-only" && value.persistence !== "reference") {
    throw corrupt("catalog environment persistence is invalid", path);
  }
  if (typeof value.provisioned !== "boolean") {
    throw corrupt("catalog environment provisioned flag is invalid", path);
  }
  if (value.digest !== undefined && typeof value.digest !== "string") {
    throw corrupt("catalog environment digest is invalid", path);
  }
}

function validateConversation(value: unknown, path: string): asserts value is SessionConversationIdentity {
  if (!isRecord(value)) throw corrupt("catalog conversation identity is invalid", path);
  if (typeof value.sessionId !== "string" || value.sessionId.length === 0) {
    throw corrupt("catalog Pi session ID is invalid", path);
  }
  if (
    value.sessionFile !== undefined &&
    (typeof value.sessionFile !== "string" ||
      value.sessionFile.length === 0 ||
      !isAbsolute(value.sessionFile) ||
      resolve(value.sessionFile) !== value.sessionFile)
  ) {
    throw corrupt("catalog Pi session file is invalid", path);
  }
}

function validateTerminal(value: unknown, path: string): asserts value is SessionTerminalRecord {
  if (!isRecord(value) || !["succeeded", "failed", "indeterminate"].includes(value.state as string)) {
    throw corrupt("catalog terminal record is invalid", path);
  }
  if (typeof value.at !== "string") throw corrupt("catalog terminal timestamp is invalid", path);
  if (value.requestId !== undefined && typeof value.requestId !== "string") {
    throw corrupt("catalog terminal request ID is invalid", path);
  }
  if (value.errorCode !== undefined && typeof value.errorCode !== "string") {
    throw corrupt("catalog terminal error code is invalid", path);
  }
}

export function validateCatalogSessionId(sessionId: string): void {
  if (sessionId.length < 1 || sessionId.length > 256) {
    throw new SessionCatalogError("invalid_session_id", "session ID length is invalid");
  }
  if (Buffer.byteLength(encodedSessionId(sessionId), "utf8") > 240) {
    throw new SessionCatalogError("invalid_session_id", "session ID is too large for a safe path");
  }
}

function validateSessionIdField(value: unknown, path: string): asserts value is string {
  try {
    if (typeof value !== "string") throw new Error("catalog session ID is invalid");
    validateCatalogSessionId(value);
  } catch (error) {
    throw corrupt(error instanceof Error ? error.message : "catalog session ID is invalid", path);
  }
}

function validateName(name: string): void {
  if (name.length < 1 || name.length > 128) {
    throw new SessionCatalogError("invalid_session_name", "session name length is invalid");
  }
}

function validateNameField(value: unknown, path: string): asserts value is string {
  try {
    if (typeof value !== "string") throw new Error("catalog session name is invalid");
    validateName(value);
  } catch (error) {
    throw corrupt(error instanceof Error ? error.message : "catalog session name is invalid", path);
  }
}

function validateGeneration(generation: number): void {
  if (!Number.isSafeInteger(generation) || generation < 0) {
    throw new SessionCatalogError("invalid_generation", "session generation must be a non-negative integer");
  }
}

function validateGenerationField(value: unknown, path: string): asserts value is number {
  try {
    validateGeneration(value as number);
  } catch (error) {
    throw corrupt(error instanceof Error ? error.message : "catalog generation is invalid", path);
  }
}

function encodeCursor(sessionId: string): string {
  return Buffer.from(JSON.stringify({ after: sessionId }), "utf8").toString("base64url");
}

function decodeCursor(cursor: string): string {
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    if (!isRecord(value) || typeof value.after !== "string" || value.after.length === 0) {
      throw new Error("invalid cursor");
    }
    return value.after;
  } catch {
    throw new SessionCatalogError("invalid_cursor", "session cursor is invalid");
  }
}

function pageLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_CATALOG_PAGE_SIZE) {
    throw new SessionCatalogError(
      "invalid_limit",
      `session page limit must be between 1 and ${MAX_CATALOG_PAGE_SIZE}`,
    );
  }
  return limit;
}

function cloneRecord(record: SessionCatalogRecord): SessionCatalogRecord {
  return structuredClone(record);
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

function corrupt(message: string, path: string): SessionCatalogError {
  return new SessionCatalogError("corrupt_catalog", message, { details: { path } });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${field} must be a positive safe integer`);
  }
  return value;
}
