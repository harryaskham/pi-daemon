import { createHash } from "node:crypto";
import { readdir, rm } from "node:fs/promises";
import { basename, join } from "node:path";

import {
  atomicWritePrivateJson,
  ensurePrivateDirectory,
  readPrivateJsonIfExists,
  stateFileSize,
  wakeTicketId,
  type JournalEntry,
} from "./durability.js";
import type { ApiErrorBody, TicketResource } from "./session-api.js";
import type { PersistedSessionSpec } from "./session-catalog.js";

export const TICKET_FORMAT_VERSION = 1 as const;
export const DEFAULT_MAX_TICKETS = 4096;
export const DEFAULT_MAX_TICKET_RECORD_BYTES = 1024 * 1024;
export const DEFAULT_TICKET_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export type MutationTicketState =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "indeterminate";

export type MutationTicketCommand =
  | {
      operation: "create";
      requestId: string;
      sessionId: string;
      generation: number;
      spec: PersistedSessionSpec;
    }
  | {
      operation: "update";
      requestId: string;
      sessionId: string;
      expectedGeneration: number;
      expectedRevision: number;
      generation: number;
      spec: PersistedSessionSpec;
    }
  | {
      operation: "delete";
      requestId: string;
      sessionId: string;
      expectedGeneration: number;
      expectedRevision: number;
      retainArtifacts: boolean;
    };

export interface MutationTicketRecord {
  formatVersion: typeof TICKET_FORMAT_VERSION;
  ticketId: string;
  scope: string;
  idempotencyKey: string;
  fingerprint: string;
  operation: MutationTicketCommand["operation"];
  state: MutationTicketState;
  requestId: string;
  sessionId: string;
  generation?: number;
  command: MutationTicketCommand;
  submittedAt: string;
  updatedAt: string;
  result?: unknown;
  error?: ApiErrorBody;
}

export interface MutationTicketRecovery {
  queued: MutationTicketRecord[];
  indeterminate: MutationTicketRecord[];
  terminal: MutationTicketRecord[];
  pruned: number;
}

export interface MutationTicketBeginInput {
  method: "POST" | "PUT" | "DELETE";
  canonicalTarget: string;
  idempotencyKey: string;
  command: MutationTicketCommand;
}

export interface MutationTicketStore {
  recover(): Promise<MutationTicketRecovery>;
  begin(input: MutationTicketBeginInput): Promise<MutationTicketRecord>;
  get(ticketId: string): Promise<MutationTicketRecord | undefined>;
  getByIdempotency(
    method: "POST" | "PUT" | "DELETE",
    canonicalTarget: string,
    idempotencyKey: string,
  ): Promise<MutationTicketRecord | undefined>;
  markRunning(ticketId: string): Promise<MutationTicketRecord>;
  markSucceeded(ticketId: string, result: unknown): Promise<MutationTicketRecord>;
  markFailed(ticketId: string, error: ApiErrorBody): Promise<MutationTicketRecord>;
  reconcile(
    ticketId: string,
    outcome:
      | { state: "succeeded"; result: unknown }
      | { state: "failed"; error: ApiErrorBody },
  ): Promise<MutationTicketRecord>;
  prune(): Promise<number>;
}

export interface FileMutationTicketStoreOptions {
  stateDir: string;
  maxTickets?: number;
  maxRecordBytes?: number;
  retentionMs?: number;
  now?: () => Date;
}

/**
 * Owner-private, bounded mutation tickets. Commands are deliberately restricted
 * to secret-free persisted session specs; raw environment overlays cannot enter
 * this store.
 */
export class FileMutationTicketStore implements MutationTicketStore {
  readonly stateDir: string;
  readonly #ticketsDir: string;
  readonly #maxTickets: number;
  readonly #maxRecordBytes: number;
  readonly #retentionMs: number;
  readonly #now: () => Date;
  readonly #tickets = new Map<string, MutationTicketRecord>();
  readonly #scopes = new Map<string, string>();
  #recovery: Promise<MutationTicketRecovery> | undefined;
  #tail: Promise<void> = Promise.resolve();

  constructor(options: FileMutationTicketStoreOptions) {
    if (options.stateDir.length === 0) throw new Error("stateDir must not be empty");
    this.stateDir = options.stateDir;
    this.#ticketsDir = join(options.stateDir, "tickets");
    this.#maxTickets = positiveInteger(options.maxTickets ?? DEFAULT_MAX_TICKETS, "maxTickets");
    this.#maxRecordBytes = positiveInteger(
      options.maxRecordBytes ?? DEFAULT_MAX_TICKET_RECORD_BYTES,
      "maxRecordBytes",
    );
    this.#retentionMs = nonNegativeInteger(
      options.retentionMs ?? DEFAULT_TICKET_RETENTION_MS,
      "retentionMs",
    );
    this.#now = options.now ?? (() => new Date());
  }

  recover(): Promise<MutationTicketRecovery> {
    this.#recovery ??= this.#load();
    return this.#recovery.then(cloneRecovery);
  }

  async begin(input: MutationTicketBeginInput): Promise<MutationTicketRecord> {
    await this.recover();
    return this.#serialize(async () => {
      validateBeginInput(input);
      const scope = ticketScope(input.method, input.canonicalTarget, input.idempotencyKey);
      const fingerprint = commandFingerprint(input.command);
      const existingId = this.#scopes.get(scope);
      if (existingId !== undefined) {
        const existing = this.#tickets.get(existingId)!;
        if (existing.fingerprint !== fingerprint) {
          throw new TicketStoreError(
            "idempotency_conflict",
            "idempotency key was already used for a different mutation",
            { ticketId: existing.ticketId },
          );
        }
        return cloneRecord(existing);
      }

      await this.#pruneLocked();
      if (this.#tickets.size >= this.#maxTickets) {
        throw new TicketStoreError("ticket_capacity", "retained ticket capacity reached", {
          maxTickets: this.#maxTickets,
        });
      }
      const ticketId = mutationTicketId(scope);
      const collision = this.#tickets.get(ticketId);
      if (collision !== undefined && collision.scope !== scope) {
        throw new TicketStoreError("ticket_id_collision", "ticket identifier collision");
      }
      const now = this.#timestamp();
      const record: MutationTicketRecord = {
        formatVersion: TICKET_FORMAT_VERSION,
        ticketId,
        scope,
        idempotencyKey: input.idempotencyKey,
        fingerprint,
        operation: input.command.operation,
        state: "queued",
        requestId: input.command.requestId,
        sessionId: input.command.sessionId,
        ...(input.command.operation === "delete"
          ? { generation: input.command.expectedGeneration }
          : { generation: input.command.generation }),
        command: structuredClone(input.command),
        submittedAt: now,
        updatedAt: now,
      };
      validateRecord(record, this.#path(ticketId));
      await this.#write(record);
      this.#register(record);
      return cloneRecord(record);
    });
  }

  async get(ticketId: string): Promise<MutationTicketRecord | undefined> {
    await this.recover();
    const record = this.#tickets.get(ticketId);
    return record === undefined ? undefined : cloneRecord(record);
  }

  async getByIdempotency(
    method: "POST" | "PUT" | "DELETE",
    canonicalTarget: string,
    idempotencyKey: string,
  ): Promise<MutationTicketRecord | undefined> {
    await this.recover();
    const ticketId = this.#scopes.get(ticketScope(method, canonicalTarget, idempotencyKey));
    if (ticketId === undefined) return undefined;
    const record = this.#tickets.get(ticketId);
    return record === undefined ? undefined : cloneRecord(record);
  }

  async markRunning(ticketId: string): Promise<MutationTicketRecord> {
    return this.#transition(ticketId, "running");
  }

  async markSucceeded(ticketId: string, result: unknown): Promise<MutationTicketRecord> {
    const record = await this.#transition(ticketId, "succeeded", { result });
    await this.prune();
    return record;
  }

  async markFailed(ticketId: string, error: ApiErrorBody): Promise<MutationTicketRecord> {
    const record = await this.#transition(ticketId, "failed", { error });
    await this.prune();
    return record;
  }

  async reconcile(
    ticketId: string,
    outcome:
      | { state: "succeeded"; result: unknown }
      | { state: "failed"; error: ApiErrorBody },
  ): Promise<MutationTicketRecord> {
    await this.recover();
    return this.#serialize(async () => {
      const current = this.#tickets.get(ticketId);
      if (current === undefined) throw ticketMissing(ticketId);
      if (current.state !== "indeterminate") {
        throw new TicketStoreError(
          "ticket_not_indeterminate",
          "only an indeterminate ticket can be reconciled",
          { ticketId, state: current.state },
        );
      }
      return this.#transitionLocked(
        current,
        outcome.state,
        outcome.state === "succeeded" ? { result: outcome.result } : { error: outcome.error },
        true,
      );
    });
  }

  async prune(): Promise<number> {
    await this.recover();
    return this.#serialize(async () => this.#pruneLocked());
  }

  async #load(): Promise<MutationTicketRecovery> {
    await ensurePrivateDirectory(this.stateDir, "state directory");
    await ensurePrivateDirectory(this.#ticketsDir, "ticket directory");
    this.#tickets.clear();
    this.#scopes.clear();
    for (const name of (await readdir(this.#ticketsDir)).sort()) {
      if (!name.endsWith(".json")) continue;
      const path = join(this.#ticketsDir, name);
      const bytes = await stateFileSize(path);
      if (bytes !== undefined && bytes > this.#maxRecordBytes) {
        throw new TicketStoreError("ticket_record_too_large", "ticket record exceeds byte limit", {
          path,
          maxRecordBytes: this.#maxRecordBytes,
          recordBytes: bytes,
        });
      }
      const value = await readPrivateJsonIfExists<unknown>(path);
      if (value === undefined) continue;
      validateRecord(value, path);
      if (name !== `${value.ticketId}.json`) {
        throw corrupt("ticket ID does not match path", path);
      }
      this.#register(value, path);
    }

    for (const record of [...this.#tickets.values()]) {
      if (record.state !== "running") continue;
      await this.#transitionLocked(record, "indeterminate", {}, true);
    }
    const pruned = await this.#pruneLocked();
    const queued: MutationTicketRecord[] = [];
    const indeterminate: MutationTicketRecord[] = [];
    const terminal: MutationTicketRecord[] = [];
    for (const record of this.#tickets.values()) {
      if (record.state === "queued") queued.push(cloneRecord(record));
      else if (record.state === "indeterminate") indeterminate.push(cloneRecord(record));
      else if (record.state !== "running") terminal.push(cloneRecord(record));
    }
    const compare = (a: MutationTicketRecord, b: MutationTicketRecord): number =>
      a.submittedAt.localeCompare(b.submittedAt) || a.ticketId.localeCompare(b.ticketId);
    return {
      queued: queued.sort(compare),
      indeterminate: indeterminate.sort(compare),
      terminal: terminal.sort(compare),
      pruned,
    };
  }

  async #transition(
    ticketId: string,
    state: MutationTicketState,
    patch: { result?: unknown; error?: ApiErrorBody } = {},
  ): Promise<MutationTicketRecord> {
    await this.recover();
    return this.#serialize(async () => {
      const current = this.#tickets.get(ticketId);
      if (current === undefined) throw ticketMissing(ticketId);
      return this.#transitionLocked(current, state, patch);
    });
  }

  async #transitionLocked(
    current: MutationTicketRecord,
    state: MutationTicketState,
    patch: { result?: unknown; error?: ApiErrorBody },
    reconciliation = false,
  ): Promise<MutationTicketRecord> {
    if (current.state === state) return cloneRecord(current);
    if (!allowedTransition(current.state, state, reconciliation)) {
      throw new TicketStoreError("invalid_ticket_transition", "invalid ticket state transition", {
        ticketId: current.ticketId,
        from: current.state,
        to: state,
      });
    }
    const next: MutationTicketRecord = {
      ...current,
      state,
      updatedAt: this.#timestamp(),
    };
    delete next.result;
    delete next.error;
    if ("result" in patch) next.result = structuredClone(patch.result);
    if (patch.error !== undefined) next.error = structuredClone(patch.error);
    await this.#write(next);
    this.#tickets.set(next.ticketId, next);
    return cloneRecord(next);
  }

  async #pruneLocked(): Promise<number> {
    const now = this.#now().getTime();
    const terminal = [...this.#tickets.values()]
      .filter((record) => isTerminal(record.state))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const expired = terminal.filter(
      (record) => now - Date.parse(record.updatedAt) > this.#retentionMs,
    );
    let removed = 0;
    for (const record of expired) {
      await rm(this.#path(record.ticketId), { force: true });
      this.#tickets.delete(record.ticketId);
      this.#scopes.delete(record.scope);
      removed += 1;
    }
    return removed;
  }

  async #write(record: MutationTicketRecord): Promise<void> {
    let serialized: string;
    try {
      serialized = JSON.stringify(record);
    } catch {
      throw new TicketStoreError(
        "ticket_serialization_failed",
        "ticket record is not JSON serializable",
      );
    }
    const recordBytes = Buffer.byteLength(serialized, "utf8");
    if (recordBytes > this.#maxRecordBytes) {
      throw new TicketStoreError("ticket_record_too_large", "ticket record exceeds byte limit", {
        maxRecordBytes: this.#maxRecordBytes,
        recordBytes,
      });
    }
    await atomicWritePrivateJson(this.#path(record.ticketId), record);
  }

  #register(record: MutationTicketRecord, path?: string): void {
    if (this.#tickets.has(record.ticketId)) {
      throw corrupt("duplicate ticket ID", path ?? this.#path(record.ticketId));
    }
    if (this.#scopes.has(record.scope)) {
      throw corrupt("duplicate ticket idempotency scope", path ?? this.#path(record.ticketId));
    }
    this.#tickets.set(record.ticketId, structuredClone(record));
    this.#scopes.set(record.scope, record.ticketId);
  }

  #path(ticketId: string): string {
    return join(this.#ticketsDir, `${ticketId}.json`);
  }

  #timestamp(): string {
    return this.#now().toISOString();
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.#tail.then(operation, operation);
    this.#tail = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }
}

export type MutationExecutor = (command: MutationTicketCommand) => Promise<unknown>;

/** Executes queued tickets once, joins duplicates, and retains terminal state. */
export class MutationTicketController {
  readonly #store: MutationTicketStore;
  readonly #runs = new Map<string, Promise<MutationTicketRecord>>();
  #executor: MutationExecutor | undefined;
  #recovered = false;

  constructor(store: MutationTicketStore) {
    this.#store = store;
  }

  async recover(executor: MutationExecutor): Promise<MutationTicketRecovery> {
    if (this.#recovered) {
      throw new TicketStoreError("tickets_already_recovered", "ticket controller already recovered");
    }
    this.#executor = executor;
    const recovery = await this.#store.recover();
    this.#recovered = true;
    for (const record of recovery.queued) this.#launch(record);
    return recovery;
  }

  async submit(input: MutationTicketBeginInput): Promise<MutationTicketRecord> {
    if (!this.#recovered || this.#executor === undefined) {
      throw new TicketStoreError("tickets_not_ready", "ticket controller is not ready");
    }
    const record = await this.#store.begin(input);
    if (record.state === "queued") this.#launch(record);
    return record;
  }

  get(ticketId: string): Promise<MutationTicketRecord | undefined> {
    return this.#store.get(ticketId);
  }

  getByIdempotency(
    method: "POST" | "PUT" | "DELETE",
    canonicalTarget: string,
    idempotencyKey: string,
  ): Promise<MutationTicketRecord | undefined> {
    return this.#store.getByIdempotency(method, canonicalTarget, idempotencyKey);
  }

  async wait(ticketId: string): Promise<MutationTicketRecord | undefined> {
    const run = this.#runs.get(ticketId);
    if (run !== undefined) return cloneRecord(await run);
    return this.#store.get(ticketId);
  }

  reconcile(
    ticketId: string,
    outcome:
      | { state: "succeeded"; result: unknown }
      | { state: "failed"; error: ApiErrorBody },
  ): Promise<MutationTicketRecord> {
    return this.#store.reconcile(ticketId, outcome);
  }

  #launch(record: MutationTicketRecord): void {
    if (this.#runs.has(record.ticketId)) return;
    const run = Promise.resolve().then(async () => {
      const running = await this.#store.markRunning(record.ticketId);
      try {
        const result = await this.#executor!(running.command);
        return await this.#store.markSucceeded(record.ticketId, result);
      } catch (error) {
        const normalized = safeTicketError(error);
        try {
          return await this.#store.markFailed(record.ticketId, normalized);
        } catch (persistError) {
          if (
            persistError instanceof TicketStoreError &&
            persistError.code === "ticket_record_too_large"
          ) {
            return await this.#store.markFailed(record.ticketId, {
              code: "terminal_result_too_large",
              message: "terminal ticket result exceeds retention limit",
              retryable: false,
            });
          }
          throw persistError;
        }
      }
    });
    this.#runs.set(record.ticketId, run);
    void run.finally(() => this.#runs.delete(record.ticketId)).catch(() => {});
  }
}

export class TicketStoreError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly details: Record<string, unknown> | undefined;

  constructor(
    code: string,
    message: string,
    details?: Record<string, unknown>,
    retryable = false,
  ) {
    super(message);
    this.name = "TicketStoreError";
    this.code = code;
    this.retryable = retryable;
    this.details = details;
  }
}

export function mutationTicketId(scope: string): string {
  const digest = createHash("sha256").update(scope, "utf8").digest("base64url");
  return `ticket-${digest.slice(0, 43)}`;
}

export function ticketScope(
  method: "POST" | "PUT" | "DELETE",
  canonicalTarget: string,
  idempotencyKey: string,
): string {
  return `${method}\n${canonicalTarget}\n${idempotencyKey}`;
}

export function wakeTicketResource(entry: JournalEntry): TicketResource {
  const sessionRef = encodeURIComponent(entry.sessionId);
  const state =
    entry.state === "accepted"
      ? "running"
      : entry.state === "completed"
        ? "succeeded"
        : entry.state;
  return {
    ticketId: wakeTicketId(entry.sessionId, entry.idempotencyKey),
    requestId: entry.requestId,
    idempotencyKey: entry.idempotencyKey,
    operation: "prompt",
    state,
    submittedAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    sessionId: entry.sessionId,
    generation: entry.generation,
    ...(entry.result === undefined
      ? {}
      : {
          result: structuredClone(entry.result) as NonNullable<TicketResource["result"]>,
        }),
    ...(entry.error === undefined ? {} : { error: structuredClone(entry.error) }),
    links: {
      self: `/v1/ticket/${encodeURIComponent(
        wakeTicketId(entry.sessionId, entry.idempotencyKey),
      )}`,
      session: `/v1/session/${sessionRef}`,
    },
  };
}

export function mutationTicketResource(record: MutationTicketRecord): TicketResource {
  const sessionRef = encodeURIComponent(record.sessionId);
  return {
    ticketId: record.ticketId,
    requestId: record.requestId,
    idempotencyKey: record.idempotencyKey,
    operation: record.operation,
    state: record.state,
    submittedAt: record.submittedAt,
    updatedAt: record.updatedAt,
    sessionId: record.sessionId,
    ...(record.generation === undefined ? {} : { generation: record.generation }),
    ...(record.result === undefined
      ? {}
      : {
          result: structuredClone(record.result) as NonNullable<TicketResource["result"]>,
        }),
    ...(record.error === undefined ? {} : { error: structuredClone(record.error) }),
    links: {
      self: `/v1/ticket/${encodeURIComponent(record.ticketId)}`,
      session: `/v1/session/${sessionRef}`,
    },
  };
}

function commandFingerprint(command: MutationTicketCommand): string {
  const { requestId: ignoredRequestId, ...semantic } = command;
  void ignoredRequestId;
  return createHash("sha256").update(canonicalJson(semantic), "utf8").digest("hex");
}

function validateBeginInput(input: MutationTicketBeginInput): void {
  if (!(["POST", "PUT", "DELETE"] as unknown[]).includes(input.method)) {
    throw new TicketStoreError("invalid_ticket_method", "ticket method is invalid");
  }
  if (input.canonicalTarget.length === 0 || input.canonicalTarget.length > 4096) {
    throw new TicketStoreError("invalid_ticket_target", "ticket target is invalid");
  }
  if (input.idempotencyKey.length === 0 || input.idempotencyKey.length > 512) {
    throw new TicketStoreError("invalid_idempotency_key", "idempotency key is invalid");
  }
  if (!isMutationCommand(input.command)) {
    throw new TicketStoreError("invalid_ticket_command", "ticket command is invalid");
  }
}

function validateRecord(value: unknown, path: string): asserts value is MutationTicketRecord {
  if (!isRecord(value)) throw corrupt("ticket is not an object", path);
  if (value.formatVersion !== TICKET_FORMAT_VERSION) {
    throw corrupt("unsupported ticket format", path);
  }
  for (const field of [
    "ticketId",
    "scope",
    "idempotencyKey",
    "fingerprint",
    "requestId",
    "sessionId",
    "submittedAt",
    "updatedAt",
  ]) {
    if (typeof value[field] !== "string" || value[field].length === 0) {
      throw corrupt(`ticket ${field} is invalid`, path);
    }
  }
  if (!/^ticket-[A-Za-z0-9_-]{43}$/.test(value.ticketId as string)) {
    throw corrupt("ticket ID is invalid", path);
  }
  if (mutationTicketId(value.scope as string) !== value.ticketId) {
    throw corrupt("ticket ID does not match idempotency scope", path);
  }
  const scopeParts = (value.scope as string).split("\n");
  if (
    scopeParts.length !== 3 ||
    scopeParts[2] !== value.idempotencyKey ||
    scopeParts[0] !== operationMethod(value.operation)
  ) {
    throw corrupt("ticket idempotency scope is invalid", path);
  }
  if (!isTicketState(value.state)) throw corrupt("ticket state is invalid", path);
  if (!isMutationCommand(value.command)) throw corrupt("ticket command is invalid", path);
  if (commandFingerprint(value.command) !== value.fingerprint) {
    throw corrupt("ticket fingerprint does not match command", path);
  }
  if (value.requestId !== value.command.requestId) {
    throw corrupt("ticket request ID does not match command", path);
  }
  if ((value.idempotencyKey as string).length > 512) {
    throw corrupt("ticket idempotency key is invalid", path);
  }
  if (value.operation !== value.command.operation) {
    throw corrupt("ticket operation does not match command", path);
  }
  if (value.sessionId !== value.command.sessionId) {
    throw corrupt("ticket session does not match command", path);
  }
  if (
    value.generation !== undefined &&
    (!Number.isSafeInteger(value.generation) || (value.generation as number) < 0)
  ) {
    throw corrupt("ticket generation is invalid", path);
  }
  if (value.error !== undefined && !isApiError(value.error)) {
    throw corrupt("ticket error is invalid", path);
  }
  if (value.state === "failed" && value.error === undefined) {
    throw corrupt("failed ticket has no error", path);
  }
}

function isMutationCommand(value: unknown): value is MutationTicketCommand {
  if (!isRecord(value)) return false;
  if (!(["create", "update", "delete"] as unknown[]).includes(value.operation)) return false;
  if (
    typeof value.requestId !== "string" ||
    value.requestId.length === 0 ||
    typeof value.sessionId !== "string" ||
    value.sessionId.length === 0
  ) {
    return false;
  }
  if (value.operation === "delete") {
    return (
      Number.isSafeInteger(value.expectedGeneration) &&
      (value.expectedGeneration as number) >= 0 &&
      Number.isSafeInteger(value.expectedRevision) &&
      (value.expectedRevision as number) >= 1 &&
      typeof value.retainArtifacts === "boolean"
    );
  }
  if (!Number.isSafeInteger(value.generation) || (value.generation as number) < 0) return false;
  if (!isRecord(value.spec) || "env" in value.spec) return false;
  if (value.operation === "update") {
    return (
      Number.isSafeInteger(value.expectedGeneration) &&
      (value.expectedGeneration as number) >= 0 &&
      Number.isSafeInteger(value.expectedRevision) &&
      (value.expectedRevision as number) >= 1
    );
  }
  return true;
}

function isApiError(value: unknown): value is ApiErrorBody {
  return (
    isRecord(value) &&
    typeof value.code === "string" &&
    value.code.length > 0 &&
    typeof value.message === "string" &&
    typeof value.retryable === "boolean"
  );
}

function operationMethod(operation: unknown): "POST" | "PUT" | "DELETE" | undefined {
  if (operation === "create") return "POST";
  if (operation === "update") return "PUT";
  if (operation === "delete") return "DELETE";
  return undefined;
}

function allowedTransition(
  from: MutationTicketState,
  to: MutationTicketState,
  reconciliation: boolean,
): boolean {
  if (from === "queued") return to === "running" || to === "failed";
  if (from === "running") {
    return to === "succeeded" || to === "failed" || to === "indeterminate";
  }
  if (from === "indeterminate" && reconciliation) {
    return to === "succeeded" || to === "failed";
  }
  return false;
}

function isTerminal(state: MutationTicketState): boolean {
  return state === "succeeded" || state === "failed" || state === "indeterminate";
}

function isTicketState(value: unknown): value is MutationTicketState {
  return ["queued", "running", "succeeded", "failed", "indeterminate"].includes(
    value as MutationTicketState,
  );
}

function safeTicketError(error: unknown): ApiErrorBody {
  if (isRecord(error)) {
    const code = typeof error.code === "string" && error.code.length > 0 ? error.code : undefined;
    const retryable = typeof error.retryable === "boolean" ? error.retryable : false;
    if (code !== undefined) {
      return {
        code,
        message: error instanceof Error ? error.message : "mutation failed",
        retryable,
      };
    }
  }
  return {
    code: "mutation_failed",
    message: error instanceof Error ? error.message : "mutation failed",
    retryable: false,
  };
}

function ticketMissing(ticketId: string): TicketStoreError {
  return new TicketStoreError("ticket_not_found", "ticket not found", { ticketId });
}

function corrupt(message: string, path: string): TicketStoreError {
  return new TicketStoreError("corrupt_ticket", message, { path: basename(path) });
}

function cloneRecord(record: MutationTicketRecord): MutationTicketRecord {
  return structuredClone(record);
}

function cloneRecovery(recovery: MutationTicketRecovery): MutationTicketRecovery {
  return {
    queued: recovery.queued.map(cloneRecord),
    indeterminate: recovery.indeterminate.map(cloneRecord),
    terminal: recovery.terminal.map(cloneRecord),
    pruned: recovery.pruned,
  };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
