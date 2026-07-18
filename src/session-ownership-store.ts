import { createHash } from "node:crypto";
import { join, resolve } from "node:path";

import type {
  ActivationRequest,
  ActivationTicket,
  DashboardFingerprint,
  DashboardTicketState,
  SessionExportRequest,
  SessionExportTicket,
  SessionOwnershipInfo,
  SessionSourceFingerprint,
} from "./dashboard-contract.js";
import {
  atomicWritePrivateJson,
  ensurePrivateDirectory,
  readPrivateJsonIfExists,
  stateFileSize,
} from "./durability.js";
import type { ApiErrorBody } from "./session-api.js";

export const SESSION_OWNERSHIP_FORMAT_VERSION = 1 as const;
export const DEFAULT_MAX_OWNERSHIP_RECORDS = 10_000;
export const DEFAULT_MAX_OWNERSHIP_TICKETS = 4_096;
export const DEFAULT_MAX_OWNERSHIP_STATE_BYTES = 64 * 1024 * 1024;
export const DEFAULT_OWNERSHIP_TICKET_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export type SessionOwnershipMode = "direct" | "imported";
export type SessionOwnershipStatus = "active" | "released" | "conflict";

export interface SessionOwnershipSourceVersion extends SessionSourceFingerprint {
  canonicalPath: string;
  entryCount: number;
  lastEntryId?: string;
}

export interface SessionOwnershipLease {
  leaseId: string;
  acquiredAt: string;
  expiresAt?: string;
}

export interface SessionOwnershipRecord {
  formatVersion: typeof SESSION_OWNERSHIP_FORMAT_VERSION;
  inventoryId: string;
  managedSessionId: string;
  generation: number;
  mode: SessionOwnershipMode;
  status: SessionOwnershipStatus;
  source: SessionOwnershipSourceVersion;
  managedPath: string;
  managedFingerprint?: DashboardFingerprint;
  baseEntryIds: string[];
  lease: SessionOwnershipLease;
  exportedInventoryIds: string[];
  conflict?: { code: string; detectedAt: string };
  createdAt: string;
  updatedAt: string;
}

export type OwnershipTicketKind = "activation" | "export";

export interface OwnershipActivationTicketRecord {
  formatVersion: typeof SESSION_OWNERSHIP_FORMAT_VERSION;
  kind: "activation";
  ticketId: string;
  scope: string;
  idempotencyKey: string;
  requestFingerprint: string;
  state: DashboardTicketState;
  requestId: string;
  target: string;
  request: ActivationRequest;
  submittedAt: string;
  updatedAt: string;
  result?: { managedSessionId?: string; generation?: number };
  error?: ApiErrorBody;
}

export interface OwnershipExportTicketRecord {
  formatVersion: typeof SESSION_OWNERSHIP_FORMAT_VERSION;
  kind: "export";
  ticketId: string;
  scope: string;
  idempotencyKey: string;
  requestFingerprint: string;
  state: DashboardTicketState;
  requestId: string;
  target: string;
  request: SessionExportRequest;
  submittedAt: string;
  updatedAt: string;
  result?: { exportedInventoryId?: string; sourceFingerprint?: DashboardFingerprint };
  error?: ApiErrorBody;
}

export type OwnershipTicketRecord =
  | OwnershipActivationTicketRecord
  | OwnershipExportTicketRecord;

interface PersistedOwnershipState {
  formatVersion: typeof SESSION_OWNERSHIP_FORMAT_VERSION;
  revision: number;
  records: SessionOwnershipRecord[];
  tickets: OwnershipTicketRecord[];
}

export interface SessionOwnershipRecovery {
  records: SessionOwnershipRecord[];
  queued: OwnershipTicketRecord[];
  indeterminate: OwnershipTicketRecord[];
  terminal: OwnershipTicketRecord[];
}

export interface SessionOwnershipStore {
  recover(): Promise<SessionOwnershipRecovery>;
  beginActivation(inventoryId: string, request: ActivationRequest): Promise<OwnershipActivationTicketRecord>;
  beginExport(sessionRef: string, request: SessionExportRequest): Promise<OwnershipExportTicketRecord>;
  getTicket(ticketId: string): Promise<OwnershipTicketRecord | undefined>;
  markRunning(ticketId: string): Promise<OwnershipTicketRecord>;
  markActivationSucceeded(
    ticketId: string,
    result: { managedSessionId?: string; generation?: number },
  ): Promise<OwnershipActivationTicketRecord>;
  markExportSucceeded(
    ticketId: string,
    result: { exportedInventoryId?: string; sourceFingerprint?: DashboardFingerprint },
  ): Promise<OwnershipExportTicketRecord>;
  markFailed(ticketId: string, error: ApiErrorBody): Promise<OwnershipTicketRecord>;
  getByInventory(inventoryId: string): Promise<SessionOwnershipRecord | undefined>;
  getByManagedSession(sessionId: string): Promise<SessionOwnershipRecord | undefined>;
  save(record: SessionOwnershipRecord): Promise<SessionOwnershipRecord>;
  list(): Promise<SessionOwnershipRecord[]>;
}

export interface FileSessionOwnershipStoreOptions {
  stateDir: string;
  maxRecords?: number;
  maxTickets?: number;
  maxStateBytes?: number;
  ticketRetentionMs?: number;
  now?: () => Date;
}

/** One bounded owner-private ownership/mutation state file. */
export class FileSessionOwnershipStore implements SessionOwnershipStore {
  readonly stateDir: string;
  readonly #file: string;
  readonly #maxRecords: number;
  readonly #maxTickets: number;
  readonly #maxStateBytes: number;
  readonly #ticketRetentionMs: number;
  readonly #now: () => Date;
  readonly #recordsByInventory = new Map<string, SessionOwnershipRecord>();
  readonly #recordsBySession = new Map<string, string>();
  readonly #tickets = new Map<string, OwnershipTicketRecord>();
  readonly #ticketScopes = new Map<string, string>();
  #revision = 0;
  #recovery: Promise<SessionOwnershipRecovery> | undefined;
  #tail: Promise<void> = Promise.resolve();

  constructor(options: FileSessionOwnershipStoreOptions) {
    this.stateDir = resolve(options.stateDir);
    this.#file = join(this.stateDir, "web", "ownership-v1.json");
    this.#maxRecords = positiveInteger(
      options.maxRecords ?? DEFAULT_MAX_OWNERSHIP_RECORDS,
      "maxRecords",
    );
    this.#maxTickets = positiveInteger(
      options.maxTickets ?? DEFAULT_MAX_OWNERSHIP_TICKETS,
      "maxTickets",
    );
    this.#maxStateBytes = positiveInteger(
      options.maxStateBytes ?? DEFAULT_MAX_OWNERSHIP_STATE_BYTES,
      "maxStateBytes",
    );
    this.#ticketRetentionMs = nonNegativeInteger(
      options.ticketRetentionMs ?? DEFAULT_OWNERSHIP_TICKET_RETENTION_MS,
      "ticketRetentionMs",
    );
    this.#now = options.now ?? (() => new Date());
  }

  recover(): Promise<SessionOwnershipRecovery> {
    this.#recovery ??= this.#load();
    return this.#recovery.then(cloneRecovery);
  }

  async beginActivation(
    inventoryId: string,
    request: ActivationRequest,
  ): Promise<OwnershipActivationTicketRecord> {
    return this.#begin("activation", inventoryId, request) as Promise<OwnershipActivationTicketRecord>;
  }

  async beginExport(
    sessionRef: string,
    request: SessionExportRequest,
  ): Promise<OwnershipExportTicketRecord> {
    return this.#begin("export", sessionRef, request) as Promise<OwnershipExportTicketRecord>;
  }

  async getTicket(ticketId: string): Promise<OwnershipTicketRecord | undefined> {
    await this.recover();
    return cloneOptional(this.#tickets.get(ticketId));
  }

  async markRunning(ticketId: string): Promise<OwnershipTicketRecord> {
    return this.#transition(ticketId, "running");
  }

  async markActivationSucceeded(
    ticketId: string,
    result: { managedSessionId?: string; generation?: number },
  ): Promise<OwnershipActivationTicketRecord> {
    const record = await this.#transition(ticketId, "succeeded", { result });
    if (record.kind !== "activation") throw kindMismatch(ticketId);
    return record;
  }

  async markExportSucceeded(
    ticketId: string,
    result: { exportedInventoryId?: string; sourceFingerprint?: DashboardFingerprint },
  ): Promise<OwnershipExportTicketRecord> {
    const record = await this.#transition(ticketId, "succeeded", { result });
    if (record.kind !== "export") throw kindMismatch(ticketId);
    return record;
  }

  markFailed(ticketId: string, error: ApiErrorBody): Promise<OwnershipTicketRecord> {
    return this.#transition(ticketId, "failed", { error });
  }

  async getByInventory(inventoryId: string): Promise<SessionOwnershipRecord | undefined> {
    await this.recover();
    return cloneOptional(this.#recordsByInventory.get(inventoryId));
  }

  async getByManagedSession(sessionId: string): Promise<SessionOwnershipRecord | undefined> {
    await this.recover();
    const inventoryId = this.#recordsBySession.get(sessionId);
    return inventoryId === undefined
      ? undefined
      : cloneOptional(this.#recordsByInventory.get(inventoryId));
  }

  async save(record: SessionOwnershipRecord): Promise<SessionOwnershipRecord> {
    await this.recover();
    return this.#serialize(async () => {
      validateOwnershipRecord(record);
      const current = this.#recordsByInventory.get(record.inventoryId);
      const sessionOwner = this.#recordsBySession.get(record.managedSessionId);
      if (sessionOwner !== undefined && sessionOwner !== record.inventoryId) {
        throw new SessionOwnershipStoreError(
          "managed_session_already_owned",
          "managed session is already linked to another inventory item",
        );
      }
      if (current === undefined && this.#recordsByInventory.size >= this.#maxRecords) {
        throw new SessionOwnershipStoreError(
          "ownership_capacity",
          "ownership record capacity reached",
          true,
        );
      }
      if (current !== undefined && current.managedSessionId !== record.managedSessionId) {
        this.#recordsBySession.delete(current.managedSessionId);
      }
      const clone = structuredClone(record);
      this.#recordsByInventory.set(clone.inventoryId, clone);
      this.#recordsBySession.set(clone.managedSessionId, clone.inventoryId);
      await this.#write();
      return structuredClone(clone);
    });
  }

  async list(): Promise<SessionOwnershipRecord[]> {
    await this.recover();
    return [...this.#recordsByInventory.values()]
      .sort((left, right) => left.inventoryId.localeCompare(right.inventoryId))
      .map((record) => structuredClone(record));
  }

  async #begin(
    kind: OwnershipTicketKind,
    target: string,
    request: ActivationRequest | SessionExportRequest,
  ): Promise<OwnershipTicketRecord> {
    await this.recover();
    return this.#serialize(async () => {
      validateTicketRequest(kind, target, request);
      const scope = ticketScope(kind, target, request.idempotencyKey);
      const fingerprint = digestJson({ kind, target, request });
      const existingId = this.#ticketScopes.get(scope);
      if (existingId !== undefined) {
        const existing = this.#tickets.get(existingId)!;
        if (existing.requestFingerprint !== fingerprint) {
          throw new SessionOwnershipStoreError(
            "idempotency_conflict",
            "idempotency key was already used for another ownership operation",
          );
        }
        return structuredClone(existing);
      }
      this.#pruneTickets();
      if (this.#tickets.size >= this.#maxTickets) {
        throw new SessionOwnershipStoreError(
          "ownership_ticket_capacity",
          "ownership ticket capacity reached",
          true,
        );
      }
      const now = this.#timestamp();
      const common = {
        formatVersion: SESSION_OWNERSHIP_FORMAT_VERSION,
        ticketId: ownershipTicketId(scope),
        scope,
        idempotencyKey: request.idempotencyKey,
        requestFingerprint: fingerprint,
        state: "queued" as const,
        requestId: request.requestId,
        target,
        submittedAt: now,
        updatedAt: now,
      };
      const record: OwnershipTicketRecord =
        kind === "activation"
          ? { ...common, kind, request: structuredClone(request as ActivationRequest) }
          : { ...common, kind, request: structuredClone(request as SessionExportRequest) };
      validateTicketRecord(record);
      this.#registerTicket(record);
      await this.#write();
      return structuredClone(record);
    });
  }

  async #transition(
    ticketId: string,
    state: DashboardTicketState,
    patch: { result?: unknown; error?: ApiErrorBody } = {},
  ): Promise<OwnershipTicketRecord> {
    await this.recover();
    return this.#serialize(async () => {
      const current = this.#tickets.get(ticketId);
      if (current === undefined) {
        throw new SessionOwnershipStoreError(
          "ownership_ticket_not_found",
          "ownership ticket does not exist",
        );
      }
      if (!allowedTicketTransition(current.state, state)) {
        if (current.state === state) return structuredClone(current);
        throw new SessionOwnershipStoreError(
          "invalid_ownership_ticket_transition",
          "ownership ticket transition is invalid",
        );
      }
      const next = {
        ...current,
        state,
        updatedAt: this.#timestamp(),
      } as OwnershipTicketRecord;
      delete next.result;
      delete next.error;
      if (patch.result !== undefined) next.result = structuredClone(patch.result) as never;
      if (patch.error !== undefined) next.error = structuredClone(patch.error);
      validateTicketRecord(next);
      this.#tickets.set(ticketId, next);
      await this.#write();
      return structuredClone(next);
    });
  }

  async #load(): Promise<SessionOwnershipRecovery> {
    await ensurePrivateDirectory(this.stateDir, "state directory");
    await ensurePrivateDirectory(join(this.stateDir, "web"), "dashboard state directory");
    const bytes = await stateFileSize(this.#file);
    if (bytes !== undefined && bytes > this.#maxStateBytes) {
      throw new SessionOwnershipStoreError(
        "ownership_state_too_large",
        "ownership state exceeds byte limit",
      );
    }
    const value = await readPrivateJsonIfExists<unknown>(this.#file);
    if (value === undefined) {
      return { records: [], queued: [], indeterminate: [], terminal: [] };
    }
    validateState(value, this.#maxRecords, this.#maxTickets);
    this.#revision = value.revision;
    for (const record of value.records) this.#registerRecord(record);
    let changed = false;
    for (const record of value.tickets) {
      const recovered =
        record.state === "running"
          ? { ...record, state: "indeterminate" as const, updatedAt: this.#timestamp() }
          : record;
      if (recovered !== record) changed = true;
      this.#registerTicket(recovered);
    }
    const pruned = this.#pruneTickets();
    if (changed || pruned > 0) await this.#write();
    return this.#recoverySnapshot();
  }

  #registerRecord(record: SessionOwnershipRecord): void {
    if (this.#recordsByInventory.has(record.inventoryId)) {
      throw new SessionOwnershipStoreError(
        "corrupt_ownership_state",
        "duplicate inventory ownership record",
      );
    }
    if (this.#recordsBySession.has(record.managedSessionId)) {
      throw new SessionOwnershipStoreError(
        "corrupt_ownership_state",
        "duplicate managed session ownership record",
      );
    }
    this.#recordsByInventory.set(record.inventoryId, structuredClone(record));
    this.#recordsBySession.set(record.managedSessionId, record.inventoryId);
  }

  #registerTicket(record: OwnershipTicketRecord): void {
    const existing = this.#ticketScopes.get(record.scope);
    if (existing !== undefined && existing !== record.ticketId) {
      throw new SessionOwnershipStoreError(
        "corrupt_ownership_state",
        "duplicate ownership ticket scope",
      );
    }
    this.#tickets.set(record.ticketId, structuredClone(record));
    this.#ticketScopes.set(record.scope, record.ticketId);
  }

  #pruneTickets(): number {
    const cutoff = this.#now().getTime() - this.#ticketRetentionMs;
    const terminal = [...this.#tickets.values()]
      .filter((record) => isTerminal(record.state))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    const keep = new Set(
      terminal
        .filter(
          (record, index) =>
            index < this.#maxTickets && Date.parse(record.updatedAt) >= cutoff,
        )
        .map((record) => record.ticketId),
    );
    let removed = 0;
    for (const [ticketId, record] of this.#tickets) {
      if (!isTerminal(record.state) || keep.has(ticketId)) continue;
      this.#tickets.delete(ticketId);
      this.#ticketScopes.delete(record.scope);
      removed += 1;
    }
    return removed;
  }

  #recoverySnapshot(): SessionOwnershipRecovery {
    const records = [...this.#recordsByInventory.values()].map((record) => structuredClone(record));
    const tickets = [...this.#tickets.values()];
    return {
      records,
      queued: tickets.filter((record) => record.state === "queued").map((record) => structuredClone(record)),
      indeterminate: tickets
        .filter((record) => record.state === "indeterminate")
        .map((record) => structuredClone(record)),
      terminal: tickets.filter((record) => isTerminal(record.state)).map((record) => structuredClone(record)),
    };
  }

  async #write(): Promise<void> {
    const state: PersistedOwnershipState = {
      formatVersion: SESSION_OWNERSHIP_FORMAT_VERSION,
      revision: this.#revision + 1,
      records: [...this.#recordsByInventory.values()].sort((left, right) =>
        left.inventoryId.localeCompare(right.inventoryId),
      ),
      tickets: [...this.#tickets.values()].sort((left, right) =>
        left.ticketId.localeCompare(right.ticketId),
      ),
    };
    const bytes = Buffer.byteLength(JSON.stringify(state), "utf8");
    if (bytes > this.#maxStateBytes) {
      throw new SessionOwnershipStoreError(
        "ownership_state_too_large",
        "ownership state exceeds byte limit",
      );
    }
    await atomicWritePrivateJson(this.#file, state);
    this.#revision = state.revision;
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

export class SessionOwnershipStoreError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, message: string, retryable = false) {
    super(message);
    this.name = "SessionOwnershipStoreError";
    this.code = code;
    this.retryable = retryable;
  }
}

export function ownershipRecordInfo(record: SessionOwnershipRecord): SessionOwnershipInfo {
  return {
    mode: record.mode === "direct" ? "direct" : "imported",
    leaseId: record.lease.leaseId,
    sourceInventoryId: record.inventoryId,
    exportedInventoryIds: [...record.exportedInventoryIds],
    ...(record.conflict === undefined ? {} : { conflict: { ...record.conflict } }),
  };
}

export function activationTicketResource(
  record: OwnershipActivationTicketRecord,
): ActivationTicket {
  return {
    ticketId: record.ticketId,
    requestId: record.requestId,
    idempotencyKey: record.idempotencyKey,
    inventoryId: record.target,
    mode: record.request.mode,
    state: record.state,
    submittedAt: record.submittedAt,
    updatedAt: record.updatedAt,
    ...(record.result?.managedSessionId === undefined
      ? {}
      : {
          managedSession: {
            sessionId: record.result.managedSessionId,
            generation: record.result.generation ?? 1,
          },
        }),
    ...(record.error === undefined ? {} : { error: structuredClone(record.error) }),
  };
}

export function exportTicketResource(record: OwnershipExportTicketRecord): SessionExportTicket {
  return {
    ticketId: record.ticketId,
    requestId: record.requestId,
    idempotencyKey: record.idempotencyKey,
    sessionRef: record.target,
    mode: record.request.mode,
    state: record.state,
    submittedAt: record.submittedAt,
    updatedAt: record.updatedAt,
    ...(record.result?.exportedInventoryId === undefined
      ? {}
      : { exportedInventoryId: record.result.exportedInventoryId }),
    ...(record.result?.sourceFingerprint === undefined
      ? {}
      : { sourceFingerprint: record.result.sourceFingerprint }),
    ...(record.error === undefined ? {} : { error: structuredClone(record.error) }),
  };
}

function validateState(
  value: unknown,
  maxRecords: number,
  maxTickets: number,
): asserts value is PersistedOwnershipState {
  if (
    !isRecord(value) ||
    value.formatVersion !== SESSION_OWNERSHIP_FORMAT_VERSION ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 0 ||
    !Array.isArray(value.records) ||
    value.records.length > maxRecords ||
    !Array.isArray(value.tickets) ||
    value.tickets.length > maxTickets
  ) {
    throw corrupt();
  }
  for (const record of value.records) validateOwnershipRecord(record);
  for (const record of value.tickets) validateTicketRecord(record);
}

function validateOwnershipRecord(value: unknown): asserts value is SessionOwnershipRecord {
  if (
    !isRecord(value) ||
    value.formatVersion !== SESSION_OWNERSHIP_FORMAT_VERSION ||
    typeof value.inventoryId !== "string" ||
    value.inventoryId.length === 0 ||
    typeof value.managedSessionId !== "string" ||
    value.managedSessionId.length === 0 ||
    !Number.isSafeInteger(value.generation) ||
    (value.generation as number) < 1 ||
    !["direct", "imported"].includes(value.mode as string) ||
    !["active", "released", "conflict"].includes(value.status as string) ||
    !isRecord(value.source) ||
    typeof value.source.canonicalPath !== "string" ||
    !isAbsolutePath(value.source.canonicalPath) ||
    typeof value.source.value !== "string" ||
    !Number.isSafeInteger(value.source.sizeBytes) ||
    (value.source.sizeBytes as number) < 0 ||
    typeof value.source.modifiedAt !== "string" ||
    !Number.isSafeInteger(value.source.entryCount) ||
    (value.source.entryCount as number) < 0 ||
    (value.source.device !== undefined && typeof value.source.device !== "string") ||
    (value.source.inode !== undefined && typeof value.source.inode !== "string") ||
    (value.source.lastEntryId !== undefined && typeof value.source.lastEntryId !== "string") ||
    typeof value.managedPath !== "string" ||
    !isAbsolutePath(value.managedPath) ||
    (value.managedFingerprint !== undefined && typeof value.managedFingerprint !== "string") ||
    !Array.isArray(value.baseEntryIds) ||
    new Set(value.baseEntryIds).size !== value.baseEntryIds.length ||
    !value.baseEntryIds.every((id) => typeof id === "string" && id.length > 0) ||
    !isRecord(value.lease) ||
    typeof value.lease.leaseId !== "string" ||
    typeof value.lease.acquiredAt !== "string" ||
    (value.lease.expiresAt !== undefined && typeof value.lease.expiresAt !== "string") ||
    !Array.isArray(value.exportedInventoryIds) ||
    new Set(value.exportedInventoryIds).size !== value.exportedInventoryIds.length ||
    !value.exportedInventoryIds.every((id) => typeof id === "string" && id.length > 0) ||
    (value.conflict !== undefined &&
      (!isRecord(value.conflict) ||
        typeof value.conflict.code !== "string" ||
        typeof value.conflict.detectedAt !== "string")) ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string"
  ) {
    throw corrupt();
  }
}

function validateTicketRecord(value: unknown): asserts value is OwnershipTicketRecord {
  if (
    !isRecord(value) ||
    value.formatVersion !== SESSION_OWNERSHIP_FORMAT_VERSION ||
    !["activation", "export"].includes(value.kind as string) ||
    typeof value.ticketId !== "string" ||
    typeof value.scope !== "string" ||
    typeof value.idempotencyKey !== "string" ||
    typeof value.requestFingerprint !== "string" ||
    !["queued", "running", "succeeded", "failed", "indeterminate"].includes(value.state as string) ||
    typeof value.requestId !== "string" ||
    typeof value.target !== "string" ||
    !isRecord(value.request) ||
    value.request.requestId !== value.requestId ||
    value.request.idempotencyKey !== value.idempotencyKey ||
    (value.kind === "activation" &&
      !["reuse", "direct", "fork", "preview-only"].includes(value.request.mode as string)) ||
    (value.kind === "export" &&
      !["as-new", "append-to-origin"].includes(value.request.mode as string)) ||
    (value.error !== undefined && !isRecord(value.error)) ||
    typeof value.submittedAt !== "string" ||
    typeof value.updatedAt !== "string"
  ) {
    throw corrupt();
  }
}

function validateTicketRequest(
  kind: OwnershipTicketKind,
  target: string,
  request: ActivationRequest | SessionExportRequest,
): void {
  if (target.length === 0 || target.length > 256) {
    throw new SessionOwnershipStoreError("invalid_ownership_target", "ownership target is invalid");
  }
  if (request.requestId.length === 0 || request.requestId.length > 128) {
    throw new SessionOwnershipStoreError("invalid_request_id", "ownership request ID is invalid");
  }
  if (request.idempotencyKey.length === 0 || request.idempotencyKey.length > 512) {
    throw new SessionOwnershipStoreError("invalid_idempotency_key", "idempotency key is invalid");
  }
  if (kind === "activation" && !("mode" in request)) throw corrupt();
}

function allowedTicketTransition(
  from: DashboardTicketState,
  to: DashboardTicketState,
): boolean {
  if (from === to) return true;
  if (from === "queued") return to === "running" || to === "failed";
  if (from === "running") {
    return to === "succeeded" || to === "failed" || to === "indeterminate";
  }
  return false;
}

function isTerminal(state: DashboardTicketState): boolean {
  return state === "succeeded" || state === "failed" || state === "indeterminate";
}

function ticketScope(kind: OwnershipTicketKind, target: string, key: string): string {
  return `${kind}\n${target}\n${key}`;
}

function ownershipTicketId(scope: string): string {
  return `dash-ticket-${createHash("sha256").update(scope).digest("base64url").slice(0, 43)}`;
}

function digestJson(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("base64url");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function cloneRecovery(value: SessionOwnershipRecovery): SessionOwnershipRecovery {
  return structuredClone(value);
}

function cloneOptional<T>(value: T | undefined): T | undefined {
  return value === undefined ? undefined : structuredClone(value);
}

function kindMismatch(ticketId: string): SessionOwnershipStoreError {
  return new SessionOwnershipStoreError(
    "ownership_ticket_kind_mismatch",
    `ownership ticket ${ticketId} has the wrong operation kind`,
  );
}

function corrupt(): SessionOwnershipStoreError {
  return new SessionOwnershipStoreError(
    "corrupt_ownership_state",
    "ownership state is invalid",
  );
}

function isAbsolutePath(value: string): boolean {
  return resolve(value) === value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${field} must be positive`);
  return value;
}

function nonNegativeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${field} must not be negative`);
  return value;
}
