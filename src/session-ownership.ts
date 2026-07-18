import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, open, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { TextDecoder } from "node:util";

import {
  CURRENT_SESSION_VERSION,
  SessionManager,
  type FileEntry,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";

import type {
  ActivationRequest,
  ActivationTicket,
  DashboardFingerprint,
  SessionExportRequest,
  SessionExportTicket,
  SessionInfoResource,
  SessionInventoryActivation,
} from "./dashboard-contract.js";
import type { SessionStorageMode } from "./config.js";
import {
  atomicWritePrivateBytes,
  encodedSessionId,
  ensurePrivateDirectory,
} from "./durability.js";
import {
  Multiplexer,
  MultiplexerError,
  type OpenResult,
} from "./multiplexer.js";
import type { ProtocolCommand } from "./protocol.js";
import { catalogRecordToSessionResource } from "./session-catalog.js";
import {
  parseSessionConfiguration,
  sessionOpenPayloadFromSpec,
} from "./session-config.js";
import type { SessionResource, SessionSpec } from "./session-api.js";
import type {
  SessionInventory,
  SessionInventoryActivationInput,
  SessionInventoryOwnershipResolution,
} from "./session-inventory.js";
import {
  SessionOwnershipStoreError,
  activationTicketResource,
  exportTicketResource,
  ownershipRecordInfo,
  type OwnershipActivationTicketRecord,
  type OwnershipExportTicketRecord,
  type OwnershipTicketRecord,
  type SessionOwnershipRecord,
  type SessionOwnershipSourceVersion,
  type SessionOwnershipStore,
} from "./session-ownership-store.js";
import { formatSessionSourceFingerprint } from "./source-fingerprint.js";

export const DIRECT_COOPT_POLICY_REF = "direct-co-opt-confirmed-v1" as const;
export const DEFAULT_OWNERSHIP_MAX_SOURCE_BYTES = 256 * 1024 * 1024;
export const DEFAULT_OWNERSHIP_MAX_LINE_BYTES = 1024 * 1024;
export const DEFAULT_OWNERSHIP_MAX_ENTRIES = 100_000;
export const DEFAULT_OWNERSHIP_LEASE_MS = 60_000;

export interface SessionOwnershipLimits {
  maxSourceBytes: number;
  maxLineBytes: number;
  maxEntries: number;
  leaseMs: number;
}

export interface SessionOwnershipRuntimeOpenInput {
  sessionId: string;
  generation: number;
  requestId: string;
  spec: SessionSpec;
  resolvedSourcePath?: string;
}

export interface SessionOwnershipRuntimeOpenResult {
  session: SessionResource;
  sessionFile?: string;
}

export interface SessionOwnershipRuntime {
  get(sessionRef: string): Promise<SessionResource | undefined>;
  open(input: SessionOwnershipRuntimeOpenInput): Promise<SessionOwnershipRuntimeOpenResult>;
  close(sessionId: string, generation: number): Promise<void>;
}

export type SessionOwnershipRuntimeSpecFactory = (input: {
  info: SessionInfoResource;
  mode: "direct" | "fork";
  managedSessionId: string;
  sessionDir: string;
}) => SessionSpec | Promise<SessionSpec>;

export type SessionWriterObservation = "none" | "self" | "other" | "unknown";
export type SessionWriterProbe = (path: string) =>
  | SessionWriterObservation
  | Promise<SessionWriterObservation>;

export interface SessionOwnershipServiceOptions {
  stateDir: string;
  inventory: Pick<SessionInventory, "getInfo" | "list" | "reconcile">;
  store: SessionOwnershipStore;
  runtime: SessionOwnershipRuntime;
  runtimeSpec: SessionOwnershipRuntimeSpecFactory;
  piSessionsRoot: string;
  daemonSessionsRoot: string;
  sourceRoots: readonly string[];
  allowedCwdRoots: readonly string[];
  storageMode?: SessionStorageMode;
  writerProbe?: SessionWriterProbe;
  hasController?: (sessionId: string) => boolean | Promise<boolean>;
  isMutationActive?: (sessionId: string) => boolean | Promise<boolean>;
  limits?: Partial<SessionOwnershipLimits>;
  now?: () => Date;
}

interface InspectedSessionFile {
  canonicalPath: string;
  header: FileEntry & { type: "session" };
  entries: SessionEntry[];
  raw: Buffer;
  version: SessionOwnershipSourceVersion;
}

/**
 * Explicit owner for preview -> managed session transitions and exports.
 * Operations are durable tickets; running work becomes indeterminate on crash.
 */
export class SessionOwnershipService {
  readonly stateDir: string;
  readonly piSessionsRoot: string;
  readonly daemonSessionsRoot: string;
  readonly storageMode: SessionStorageMode;
  readonly limits: Readonly<SessionOwnershipLimits>;
  readonly #inventory: SessionOwnershipServiceOptions["inventory"];
  readonly #store: SessionOwnershipStore;
  readonly #runtime: SessionOwnershipRuntime;
  readonly #runtimeSpec: SessionOwnershipRuntimeSpecFactory;
  readonly #sourceRoots: readonly string[];
  readonly #allowedCwdRoots: readonly string[];
  #canonicalStateDir = "";
  #canonicalSourceRoots: readonly string[] = [];
  #canonicalAllowedCwdRoots: readonly string[] = [];
  readonly #writerProbe: SessionWriterProbe;
  readonly #hasController: (sessionId: string) => boolean | Promise<boolean>;
  readonly #isMutationActive: (sessionId: string) => boolean | Promise<boolean>;
  readonly #now: () => Date;
  readonly #inFlight = new Map<string, Promise<OwnershipTicketRecord>>();
  #initialization: Promise<void> | undefined;

  constructor(options: SessionOwnershipServiceOptions) {
    this.stateDir = resolve(options.stateDir);
    this.piSessionsRoot = resolve(options.piSessionsRoot);
    this.daemonSessionsRoot = resolve(options.daemonSessionsRoot);
    this.storageMode = options.storageMode ?? "pi-session-root";
    this.limits = Object.freeze(resolveLimits(options.limits));
    this.#inventory = options.inventory;
    this.#store = options.store;
    this.#runtime = options.runtime;
    this.#runtimeSpec = options.runtimeSpec;
    this.#sourceRoots = Object.freeze(options.sourceRoots.map((root) => resolve(root)));
    this.#allowedCwdRoots = Object.freeze(
      options.allowedCwdRoots.map((root) => resolve(root)),
    );
    this.#writerProbe = options.writerProbe ?? (() => "unknown");
    this.#hasController = options.hasController ?? (() => false);
    this.#isMutationActive = options.isMutationActive ?? (() => false);
    this.#now = options.now ?? (() => new Date());
  }

  async initialize(): Promise<void> {
    this.#initialization ??= this.#runInitialize();
    await this.#initialization;
  }

  async recover(): Promise<{
    queued: number;
    indeterminate: number;
    records: number;
  }> {
    await this.initialize();
    const recovery = await this.#store.recover();
    return {
      queued: recovery.queued.length,
      indeterminate: recovery.indeterminate.length,
      records: recovery.records.length,
    };
  }

  async activationPolicy(
    input: SessionInventoryActivationInput,
  ): Promise<SessionInventoryActivation> {
    await this.initialize();
    const mapping = await this.#store.getByInventory(input.inventoryId);
    if (mapping?.status === "active") return { eligible: true, modes: ["reuse"] };
    if (input.managed !== undefined) return { eligible: true, modes: ["reuse"] };
    if (input.canonicalPath === undefined || !isAbsolute(input.cwd)) {
      return {
        eligible: false,
        modes: ["preview-only"],
        reasonCode: "missing-source-or-cwd",
      };
    }
    try {
      await this.#assertSourceRoot(input.canonicalPath);
      await this.#assertCwd(input.cwd);
      return { eligible: true, modes: ["direct", "fork", "preview-only"] };
    } catch (error) {
      return {
        eligible: false,
        modes: ["preview-only"],
        reasonCode: ownershipErrorCode(error),
      };
    }
  }

  async resolveInventoryOwnership(
    input: SessionInventoryActivationInput,
  ): Promise<SessionInventoryOwnershipResolution | undefined> {
    await this.initialize();
    const mapping = await this.#store.getByInventory(input.inventoryId);
    if (mapping === undefined) return undefined;
    return {
      sourceKind:
        mapping.status === "released"
          ? "exported"
          : mapping.mode === "direct"
            ? "direct"
            : "imported",
      ownership: ownershipRecordInfo(mapping),
      activation:
        mapping.status === "active"
          ? { eligible: true, modes: ["reuse"] }
          : { eligible: true, modes: ["fork", "preview-only"] },
    };
  }

  async activateSession(
    inventoryId: string,
    request: ActivationRequest,
  ): Promise<ActivationTicket> {
    await this.initialize();
    const ticket = await this.#store.beginActivation(inventoryId, request);
    const completed = await this.#runTicket(ticket, () => this.#activate(ticket));
    if (completed.kind !== "activation") throw new Error("activation ticket kind changed");
    return activationTicketResource(completed);
  }

  async getActivation(ticketId: string): Promise<ActivationTicket> {
    await this.initialize();
    const ticket = await this.#store.getTicket(ticketId);
    if (ticket === undefined || ticket.kind !== "activation") {
      throw new SessionOwnershipError(
        "activation_ticket_not_found",
        "activation ticket does not exist",
      );
    }
    return activationTicketResource(ticket);
  }

  async exportSession(
    sessionRef: string,
    request: SessionExportRequest,
  ): Promise<SessionExportTicket> {
    await this.initialize();
    const ticket = await this.#store.beginExport(sessionRef, request);
    const completed = await this.#runTicket(ticket, () => this.#export(ticket));
    if (completed.kind !== "export") throw new Error("export ticket kind changed");
    return exportTicketResource(completed);
  }

  async getExport(ticketId: string): Promise<SessionExportTicket> {
    await this.initialize();
    const ticket = await this.#store.getTicket(ticketId);
    if (ticket === undefined || ticket.kind !== "export") {
      throw new SessionOwnershipError("export_ticket_not_found", "export ticket does not exist");
    }
    return exportTicketResource(ticket);
  }

  async beforeManagedWrite(sessionId: string): Promise<void> {
    await this.initialize();
    const mapping = await this.#store.getByManagedSession(sessionId);
    if (mapping === undefined || mapping.status !== "active" || mapping.mode !== "direct") return;
    const current = await inspectSessionFile(mapping.source.canonicalPath, this.limits);
    if (!sameSourceVersion(current.version, mapping.source)) {
      await this.#markConflict(mapping, "external_write_conflict");
      throw new SessionOwnershipError(
        "external_write_conflict",
        "direct session source changed outside the managed write boundary",
        true,
      );
    }
  }

  async afterManagedWrite(sessionId: string): Promise<void> {
    await this.initialize();
    const mapping = await this.#store.getByManagedSession(sessionId);
    if (mapping === undefined || mapping.status !== "active") return;
    const current = await inspectSessionFile(mapping.managedPath, this.limits);
    if (!entryIdsHavePrefix(current.entries, mapping.baseEntryIds)) {
      await this.#markConflict(mapping, "managed_history_diverged");
      throw new SessionOwnershipError(
        "managed_history_diverged",
        "managed session no longer extends the recorded ownership base",
      );
    }
    const now = this.#timestamp();
    await this.#store.save({
      ...mapping,
      ...(mapping.mode === "direct" ? { source: current.version } : {}),
      managedFingerprint: current.version.value,
      baseEntryIds: current.entries.map((entry) => entry.id),
      lease: {
        ...mapping.lease,
        expiresAt: new Date(this.#now().getTime() + this.limits.leaseMs).toISOString(),
      },
      updatedAt: now,
    });
  }

  async renewLease(sessionRef: string, leaseId: string): Promise<SessionOwnershipRecord> {
    await this.initialize();
    const mapping = await this.#requireMapping(sessionRef);
    if (mapping.status !== "active" || mapping.lease.leaseId !== leaseId) {
      throw new SessionOwnershipError(
        "ownership_lease_mismatch",
        "ownership lease is stale or inactive",
      );
    }
    return this.#store.save({
      ...mapping,
      lease: {
        ...mapping.lease,
        expiresAt: new Date(this.#now().getTime() + this.limits.leaseMs).toISOString(),
      },
      updatedAt: this.#timestamp(),
    });
  }

  async checkForExternalConflicts(): Promise<string[]> {
    await this.initialize();
    const conflicted: string[] = [];
    for (const mapping of await this.#store.list()) {
      if (mapping.status !== "active" || mapping.mode !== "direct") continue;
      try {
        await this.beforeManagedWrite(mapping.managedSessionId);
      } catch (error) {
        if (error instanceof SessionOwnershipError && error.code === "external_write_conflict") {
          conflicted.push(mapping.managedSessionId);
          continue;
        }
        throw error;
      }
    }
    return conflicted;
  }

  async release(sessionRef: string): Promise<void> {
    await this.initialize();
    const mapping = await this.#requireMapping(sessionRef);
    if (await this.#hasController(mapping.managedSessionId)) {
      throw new SessionOwnershipError(
        "controller_active",
        "cannot release a session while a controller is attached",
        true,
      );
    }
    if (await this.#isMutationActive(mapping.managedSessionId)) {
      throw new SessionOwnershipError(
        "session_busy",
        "cannot release a session while a mutation is active",
        true,
      );
    }
    await this.#runtime.close(mapping.managedSessionId, mapping.generation);
    await this.#store.save({
      ...mapping,
      status: "released",
      updatedAt: this.#timestamp(),
    });
    await this.#inventory.reconcile();
  }

  async sessionDirForNewSession(cwd: string, managedSessionId: string): Promise<string> {
    return this.#sessionDirForManagedSession(cwd, managedSessionId);
  }

  async #activate(
    ticket: OwnershipActivationTicketRecord,
  ): Promise<OwnershipActivationTicketRecord> {
    const request = ticket.request;
    if (request.mode === "preview-only") {
      return this.#store.markActivationSucceeded(ticket.ticketId, {});
    }
    const info = await this.#inventory.getInfo(ticket.target);
    if (info === undefined) {
      throw new SessionOwnershipError("inventory_not_found", "inventory item does not exist");
    }
    const existing = await this.#store.getByInventory(ticket.target);
    if (request.mode === "reuse") {
      const activeMapping = existing?.status === "active" ? existing : undefined;
      const managedSessionId = activeMapping?.managedSessionId ?? info.managed?.sessionId;
      const generation = activeMapping?.generation ?? info.managed?.generation;
      if (managedSessionId === undefined || generation === undefined) {
        throw new SessionOwnershipError(
          "ownership_mapping_not_found",
          "inventory item has no managed session to reuse",
        );
      }
      if (activeMapping !== undefined) {
        await this.renewLease(activeMapping.managedSessionId, activeMapping.lease.leaseId);
      }
      return this.#store.markActivationSucceeded(ticket.ticketId, {
        managedSessionId,
        generation,
      });
    }
    if (request.mode === "direct" && request.policyRef !== DIRECT_COOPT_POLICY_REF) {
      throw new SessionOwnershipError(
        "direct_confirmation_required",
        `direct co-opt requires policyRef=${DIRECT_COOPT_POLICY_REF}`,
      );
    }
    if (request.expectedFingerprint === undefined) {
      throw new SessionOwnershipError(
        "source_fingerprint_required",
        "direct and fork activation require the preview source fingerprint",
      );
    }
    if (
      info.managed !== undefined &&
      ((await this.#hasController(info.managed.sessionId)) ||
        (await this.#isMutationActive(info.managed.sessionId)))
    ) {
      throw new SessionOwnershipError(
        "session_busy",
        "inventory source is already controlled or mutating in a managed session",
        true,
      );
    }
    const sourcePath = info.source.canonicalPath;
    if (sourcePath === undefined) {
      throw new SessionOwnershipError(
        "inventory_source_unavailable",
        "inventory item has no activatable source file",
      );
    }
    await this.#assertSourceRoot(sourcePath);
    await this.#assertCwd(info.cwd);
    const source = await inspectSessionFile(sourcePath, this.limits);
    if (
      request.expectedFingerprint !== undefined &&
      request.expectedFingerprint !== source.version.value
    ) {
      throw new SessionOwnershipError(
        "source_fingerprint_changed",
        "session source changed since inventory preview",
        true,
      );
    }
    await this.#assertNoCompetingOwner(ticket.target, source.canonicalPath);
    const writer = await this.#writerProbe(source.canonicalPath);
    if (writer === "other") {
      throw new SessionOwnershipError(
        "source_writer_active",
        "another process appears to have the source session open for writing",
        true,
      );
    }
    const mode = request.mode;
    const managedSessionId = deterministicManagedSessionId(
      ticket.target,
      mode,
      ticket.idempotencyKey,
    );
    const sessionDir =
      mode === "direct"
        ? dirname(source.canonicalPath)
        : await this.#sessionDirForManagedSession(info.cwd, managedSessionId);
    const suppliedSpec = await this.#runtimeSpec({
      info,
      mode,
      managedSessionId,
      sessionDir,
    });
    const spec = ownershipSpec(suppliedSpec, info, request, mode, sessionDir);
    const opened = await this.#runtime.open({
      sessionId: managedSessionId,
      generation: 1,
      requestId: request.requestId,
      spec,
      ...(mode === "fork" ? { resolvedSourcePath: source.canonicalPath } : {}),
    });
    if (opened.sessionFile === undefined) {
      throw new SessionOwnershipError(
        "managed_session_not_persisted",
        "ownership activation did not create a persistent Pi session",
      );
    }
    if (mode === "fork") await chmod(opened.sessionFile, 0o600);
    const managed = await inspectSessionFile(opened.sessionFile, this.limits);
    const now = this.#timestamp();
    const record: SessionOwnershipRecord = {
      formatVersion: 1,
      inventoryId: ticket.target,
      managedSessionId,
      generation: opened.session.generation,
      mode: mode === "direct" ? "direct" : "imported",
      status: "active",
      source: source.version,
      managedPath: managed.canonicalPath,
      managedFingerprint: managed.version.value,
      baseEntryIds: source.entries.map((entry) => entry.id),
      lease: {
        leaseId: `lease-${randomUUID()}`,
        acquiredAt: now,
        expiresAt: new Date(this.#now().getTime() + this.limits.leaseMs).toISOString(),
      },
      exportedInventoryIds: [],
      createdAt: now,
      updatedAt: now,
    };
    await this.#store.save(record);
    await this.#inventory.reconcile();
    return this.#store.markActivationSucceeded(ticket.ticketId, {
      managedSessionId,
      generation: opened.session.generation,
    });
  }

  async #export(ticket: OwnershipExportTicketRecord): Promise<OwnershipExportTicketRecord> {
    const mapping = await this.#requireMapping(ticket.target);
    if (mapping.status !== "active") {
      throw new SessionOwnershipError(
        "ownership_not_active",
        "only an active managed session can be exported",
      );
    }
    if (await this.#hasController(mapping.managedSessionId)) {
      throw new SessionOwnershipError(
        "controller_active",
        "cannot export while a controller is attached",
        true,
      );
    }
    if (await this.#isMutationActive(mapping.managedSessionId)) {
      throw new SessionOwnershipError(
        "session_busy",
        "cannot export while a mutation is active",
        true,
      );
    }
    if (ticket.request.expectedSourceFingerprint === undefined) {
      throw new SessionOwnershipError(
        "source_fingerprint_required",
        "export requires the managed source fingerprint",
      );
    }
    const managed = await inspectSessionFile(mapping.managedPath, this.limits);
    if (
      ticket.request.expectedSourceFingerprint !== undefined &&
      ticket.request.expectedSourceFingerprint !== managed.version.value
    ) {
      throw new SessionOwnershipError(
        "source_fingerprint_changed",
        "managed session changed since export request",
        true,
      );
    }

    let exportedPath: string;
    let exportedInventoryId: string;
    let exportedFingerprint: DashboardFingerprint;
    if (ticket.request.mode === "as-new") {
      const exported = await this.#exportAsNew(managed);
      exportedPath = exported.canonicalPath;
      exportedFingerprint = exported.version.value;
      await this.#inventory.reconcile();
      exportedInventoryId = await this.#inventoryIdForPiSession(exported.header.id);
    } else {
      const exported = await this.#appendToOrigin(mapping, managed);
      exportedPath = exported.canonicalPath;
      exportedFingerprint = exported.version.value;
      exportedInventoryId = mapping.inventoryId;
      await this.#inventory.reconcile();
    }
    void exportedPath;
    const exports = [...new Set([...mapping.exportedInventoryIds, exportedInventoryId])];
    await this.#store.save({
      ...mapping,
      exportedInventoryIds: exports,
      ...(ticket.request.mode === "append-to-origin"
        ? {
            source: (await inspectSessionFile(mapping.source.canonicalPath, this.limits)).version,
            baseEntryIds: managed.entries.map((entry) => entry.id),
          }
        : {}),
      updatedAt: this.#timestamp(),
    });
    if (ticket.request.releaseAfterExport === true) {
      await this.release(mapping.managedSessionId);
    }
    return this.#store.markExportSucceeded(ticket.ticketId, {
      exportedInventoryId,
      sourceFingerprint: exportedFingerprint,
    });
  }

  async #exportAsNew(managed: InspectedSessionFile): Promise<InspectedSessionFile> {
    const targetDir = await this.#piSessionDirForCwd(managed.header.cwd);
    const id = randomUUID();
    const timestamp = this.#timestamp();
    const header = {
      type: "session" as const,
      version: CURRENT_SESSION_VERSION,
      id,
      timestamp,
      cwd: managed.header.cwd,
      parentSession: managed.canonicalPath,
    };
    const filename = `${timestamp.replace(/[:.]/g, "-")}_${id}.jsonl`;
    const path = join(targetDir, filename);
    await assertPathAbsent(path);
    await atomicWritePrivateBytes(path, encodeSession(header, managed.entries));
    return inspectSessionFile(path, this.limits);
  }

  async #appendToOrigin(
    mapping: SessionOwnershipRecord,
    managed: InspectedSessionFile,
  ): Promise<InspectedSessionFile> {
    if (mapping.mode !== "imported") {
      throw new SessionOwnershipError(
        "append_origin_unavailable",
        "append-to-origin is only valid for imported sessions",
      );
    }
    const writer = await this.#writerProbe(mapping.source.canonicalPath);
    if (writer === "other") {
      throw new SessionOwnershipError(
        "source_writer_active",
        "another process appears to have the origin open for writing",
        true,
      );
    }
    const origin = await inspectSessionFile(mapping.source.canonicalPath, this.limits);
    if (!sameSourceVersion(origin.version, mapping.source)) {
      await this.#markConflict(mapping, "external_write_conflict");
      throw new SessionOwnershipError(
        "external_write_conflict",
        "origin changed since import; export as a new sibling instead",
        true,
      );
    }
    if (!entriesEqualPrefix(managed.entries, origin.entries)) {
      throw new SessionOwnershipError(
        "managed_history_diverged",
        "managed history does not preserve the exact imported origin prefix",
      );
    }
    const delta = managed.entries.slice(origin.entries.length);
    if (!entriesFormContinuation(delta, origin.entries.at(-1)?.id)) {
      throw new SessionOwnershipError(
        "managed_history_diverged",
        "managed delta is not a linear continuation of the origin",
      );
    }
    const latest = await inspectSessionFile(mapping.source.canonicalPath, this.limits);
    if (!sameSourceVersion(latest.version, mapping.source)) {
      await this.#markConflict(mapping, "external_write_conflict");
      throw new SessionOwnershipError(
        "external_write_conflict",
        "origin changed during export admission",
        true,
      );
    }
    await atomicWritePrivateBytes(
      mapping.source.canonicalPath,
      encodeSession(origin.header, [...origin.entries, ...delta]),
    );
    return inspectSessionFile(mapping.source.canonicalPath, this.limits);
  }

  async #runTicket(
    ticket: OwnershipTicketRecord,
    operation: () => Promise<OwnershipTicketRecord>,
  ): Promise<OwnershipTicketRecord> {
    if (ticket.state !== "queued") return ticket;
    const existing = this.#inFlight.get(ticket.ticketId);
    if (existing !== undefined) return existing;
    const task = (async () => {
      await this.#store.markRunning(ticket.ticketId);
      try {
        return await operation();
      } catch (error) {
        return this.#store.markFailed(ticket.ticketId, safeOwnershipError(error));
      }
    })();
    this.#inFlight.set(ticket.ticketId, task);
    try {
      return await task;
    } finally {
      if (this.#inFlight.get(ticket.ticketId) === task) this.#inFlight.delete(ticket.ticketId);
    }
  }

  async #requireMapping(sessionRef: string): Promise<SessionOwnershipRecord> {
    return (
      (await this.#store.getByManagedSession(sessionRef)) ??
      (await this.#store.getByInventory(sessionRef)) ??
      Promise.reject(
        new SessionOwnershipError(
          "ownership_mapping_not_found",
          "session ownership mapping does not exist",
        ),
      )
    );
  }

  async #assertNoCompetingOwner(inventoryId: string, sourcePath: string): Promise<void> {
    for (const record of await this.#store.list()) {
      if (
        record.status === "active" &&
        record.inventoryId !== inventoryId &&
        record.source.canonicalPath === sourcePath
      ) {
        throw new SessionOwnershipError(
          "source_already_owned",
          "source session is already owned by another managed session",
          true,
        );
      }
    }
  }

  async #assertSourceRoot(path: string): Promise<string> {
    const canonical = await realpath(path);
    if (!this.#canonicalSourceRoots.some((root) => isWithin(root, canonical))) {
      throw new SessionOwnershipError(
        "source_root_not_allowed",
        "session source is outside approved inventory roots",
      );
    }
    if (
      isWithin(this.#canonicalStateDir, canonical) ||
      isWithin(canonical, this.#canonicalStateDir)
    ) {
      throw new SessionOwnershipError(
        "source_root_not_allowed",
        "session source must not overlap daemon state",
      );
    }
    return canonical;
  }

  async #assertCwd(path: string): Promise<string> {
    const canonical = await realpath(path);
    const info = await stat(canonical);
    if (!info.isDirectory()) {
      throw new SessionOwnershipError("cwd_not_directory", "session cwd is not a directory");
    }
    if (!this.#canonicalAllowedCwdRoots.some((root) => isWithin(root, canonical))) {
      throw new SessionOwnershipError(
        "cwd_not_allowed",
        "session cwd is outside configured workload roots",
      );
    }
    return canonical;
  }

  async #markConflict(record: SessionOwnershipRecord, code: string): Promise<void> {
    await this.#store.save({
      ...record,
      status: "conflict",
      conflict: { code, detectedAt: this.#timestamp() },
      updatedAt: this.#timestamp(),
    });
    await this.#runtime.close(record.managedSessionId, record.generation).catch(() => {});
    await this.#inventory.reconcile().catch(() => {});
  }

  async #inventoryIdForPiSession(piSessionId: string): Promise<string> {
    const page = await this.#inventory.list({ search: piSessionId, limit: 100 });
    const record = page.sessions.find((candidate) => candidate.piSessionId === piSessionId);
    if (record === undefined) {
      throw new SessionOwnershipError(
        "export_inventory_missing",
        "exported session was not indexed after publication",
        true,
      );
    }
    return record.inventoryId;
  }

  async #sessionDirForManagedSession(
    cwd: string,
    managedSessionId: string,
  ): Promise<string> {
    if (this.storageMode === "pi-session-root") return this.#piSessionDirForCwd(cwd);
    const directory = join(this.daemonSessionsRoot, encodedSessionId(managedSessionId));
    await ensurePrivateDirectory(directory, "daemon-owned Pi session directory");
    return realpath(directory);
  }

  async #piSessionDirForCwd(cwd: string): Promise<string> {
    const resolvedRoot = await realpath(this.piSessionsRoot);
    const directory = join(resolvedRoot, piProjectDirectoryName(cwd));
    if (!isWithin(resolvedRoot, directory)) {
      throw new SessionOwnershipError(
        "session_storage_outside_pi_root",
        "derived Pi session directory escapes the canonical sessions subtree",
      );
    }
    await ensurePrivateDirectory(directory, "Pi project session directory");
    return realpath(directory);
  }

  async #runInitialize(): Promise<void> {
    await ensurePrivateDirectory(this.stateDir, "state directory");
    await ensurePrivateDirectory(this.piSessionsRoot, "Pi sessions data root");
    await ensurePrivateDirectory(this.daemonSessionsRoot, "daemon sessions data root");
    const canonicalState = await realpath(this.stateDir);
    this.#canonicalStateDir = canonicalState;
    const canonicalPi = await validatePrivateRoot(this.piSessionsRoot);
    const canonicalDaemon = await validatePrivateRoot(this.daemonSessionsRoot);
    if (
      isWithin(canonicalState, canonicalPi) ||
      isWithin(canonicalPi, canonicalState) ||
      isWithin(canonicalPi, canonicalDaemon) ||
      isWithin(canonicalDaemon, canonicalPi) ||
      !isWithin(canonicalState, canonicalDaemon)
    ) {
      throw new SessionOwnershipError(
        "ownership_root_overlap",
        "Pi sessions must be outside daemon state and daemon-owned sessions must remain inside it",
      );
    }
    this.#canonicalSourceRoots = Object.freeze(
      await Promise.all(this.#sourceRoots.map((root) => validatePrivateRoot(root))),
    );
    if (
      this.#canonicalSourceRoots.some(
        (root) => isWithin(canonicalState, root) || isWithin(root, canonicalState),
      )
    ) {
      throw new SessionOwnershipError(
        "ownership_root_overlap",
        "inventory source roots must not overlap daemon state",
      );
    }
    this.#canonicalAllowedCwdRoots = Object.freeze(
      await Promise.all(this.#allowedCwdRoots.map((root) => realpath(root))),
    );
    await this.#store.recover();
  }

  #timestamp(): string {
    return this.#now().toISOString();
  }
}

/** Multiplexer adapter used by embedded DashboardBackend implementations. */
export class MultiplexerSessionOwnershipRuntime implements SessionOwnershipRuntime {
  readonly #multiplexer: Multiplexer;

  constructor(multiplexer: Multiplexer) {
    this.#multiplexer = multiplexer;
  }

  async get(sessionRef: string): Promise<SessionResource | undefined> {
    const record = await this.#multiplexer.retainedSession(sessionRef);
    return record === undefined ? undefined : catalogRecordToSessionResource(record);
  }

  async open(input: SessionOwnershipRuntimeOpenInput): Promise<SessionOwnershipRuntimeOpenResult> {
    const prepared = parseSessionConfiguration(input.spec);
    const runtimeOptions = {
      ...prepared.runtimeOptions,
      ...(input.resolvedSourcePath === undefined
        ? {}
        : { resolvedSourceSessionPath: input.resolvedSourcePath }),
    };
    const command: Extract<ProtocolCommand, { operation: "open" }> = {
      protocolVersion: "1.0",
      requestId: input.requestId,
      operation: "open",
      sessionId: input.sessionId,
      generation: input.generation,
      payload: sessionOpenPayloadFromSpec(prepared.persistedSpec),
    };
    const opened: OpenResult = await this.#multiplexer.open(command, {
      runtimeOptions,
      environmentSummary: prepared.environmentSummary,
      catalogSpec: prepared.persistedSpec,
    });
    const record = await this.#multiplexer.retainedSession(input.sessionId);
    return {
      session:
        record === undefined
          ? snapshotToResource(opened, prepared.persistedSpec)
          : catalogRecordToSessionResource(record),
      ...(record?.conversation?.sessionFile === undefined
        ? {}
        : { sessionFile: record.conversation.sessionFile }),
    };
  }

  async close(sessionId: string, generation: number): Promise<void> {
    await this.#multiplexer.close({
      protocolVersion: "1.0",
      requestId: `ownership-release-${randomUUID()}`,
      operation: "close",
      sessionId,
      generation,
      payload: { retainSession: true },
    });
  }
}

export class SessionOwnershipError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, message: string, retryable = false) {
    super(message);
    this.name = "SessionOwnershipError";
    this.code = code;
    this.retryable = retryable;
  }
}

async function inspectSessionFile(
  path: string,
  limits: Readonly<SessionOwnershipLimits>,
): Promise<InspectedSessionFile> {
  const requestedPath = resolve(path);
  const requestedInfo = await lstat(requestedPath);
  if (requestedInfo.isSymbolicLink() || !requestedInfo.isFile()) {
    throw new SessionOwnershipError(
      "invalid_session_source",
      "session source must be a regular non-symlink file",
    );
  }
  const canonicalPath = await realpath(requestedPath);
  const info = await lstat(canonicalPath);
  if (!info.isFile()) {
    throw new SessionOwnershipError(
      "invalid_session_source",
      "session source must be a regular non-symlink file",
    );
  }
  const getuid = process.getuid;
  if (getuid !== undefined && info.uid !== getuid()) {
    throw new SessionOwnershipError(
      "source_owner_mismatch",
      "session source must be owned by current user",
    );
  }
  if (info.size < 1 || info.size > limits.maxSourceBytes) {
    throw new SessionOwnershipError(
      "source_too_large",
      "session source exceeds byte limit",
    );
  }
  const handle = await open(canonicalPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  let raw: Buffer;
  let openedInfo;
  try {
    openedInfo = await handle.stat();
    if (
      !openedInfo.isFile() ||
      openedInfo.size < 1 ||
      openedInfo.size > limits.maxSourceBytes
    ) {
      throw new SessionOwnershipError(
        "source_too_large",
        "session source exceeds byte limit",
      );
    }
    raw = await handle.readFile();
  } finally {
    await handle.close();
  }
  if (raw.byteLength > limits.maxSourceBytes) {
    throw new SessionOwnershipError("source_too_large", "session source exceeds byte limit");
  }
  const lines = splitBoundedLines(raw, limits.maxLineBytes);
  if (lines.length < 1 || lines.length - 1 > limits.maxEntries) {
    throw new SessionOwnershipError(
      "source_entry_capacity",
      "session source entry count exceeds limit",
    );
  }
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const parsed: unknown[] = [];
  try {
    for (const line of lines) parsed.push(JSON.parse(decoder.decode(line)) as unknown);
  } catch {
    throw new SessionOwnershipError(
      "corrupt_session_source",
      "session source contains invalid UTF-8 or JSON",
    );
  }
  const header = parsed[0];
  if (
    !isRecord(header) ||
    header.type !== "session" ||
    typeof header.id !== "string" ||
    typeof header.cwd !== "string"
  ) {
    throw new SessionOwnershipError(
      "corrupt_session_source",
      "session source header is invalid",
    );
  }
  // Pi's parser validates/migrates entry shapes and tree metadata.
  let manager: SessionManager;
  try {
    manager = SessionManager.open(canonicalPath, dirname(canonicalPath), header.cwd);
  } catch {
    throw new SessionOwnershipError(
      "corrupt_session_source",
      "session source cannot be opened by Pi",
    );
  }
  const entries = manager.getEntries();
  const digest = createHash("sha256").update(raw).digest();
  return {
    canonicalPath,
    header: manager.getHeader()!,
    entries,
    raw,
    version: {
      canonicalPath,
      value: formatSessionSourceFingerprint(digest),
      sizeBytes: raw.byteLength,
      modifiedAt: new Date(Number(openedInfo.mtimeMs)).toISOString(),
      device: String(openedInfo.dev),
      inode: String(openedInfo.ino),
      entryCount: entries.length,
      ...(entries.at(-1) === undefined ? {} : { lastEntryId: entries.at(-1)!.id }),
    },
  };
}

function ownershipSpec(
  supplied: SessionSpec,
  info: SessionInfoResource,
  request: ActivationRequest,
  mode: "direct" | "fork",
  sessionDir: string,
): SessionSpec {
  const target: SessionSpec["target"] =
    mode === "direct"
      ? { mode: "open", path: info.source.canonicalPath!, sessionDir }
      : {
          mode: "fork",
          sourceSession: info.inventoryId,
          sessionDir,
        };
  return {
    ...structuredClone(supplied),
    cwd: info.cwd,
    ...(request.desiredSessionName === undefined
      ? supplied.name === undefined
        ? {}
        : { name: supplied.name }
      : { name: request.desiredSessionName }),
    target,
    isolation: { mode: "unisolated" },
  };
}

function sameSourceVersion(
  left: SessionOwnershipSourceVersion,
  right: SessionOwnershipSourceVersion,
): boolean {
  return (
    left.canonicalPath === right.canonicalPath &&
    left.value === right.value &&
    left.sizeBytes === right.sizeBytes &&
    left.modifiedAt === right.modifiedAt &&
    left.device === right.device &&
    left.inode === right.inode
  );
}

function entryIdsHavePrefix(entries: SessionEntry[], ids: string[]): boolean {
  return ids.length <= entries.length && ids.every((id, index) => entries[index]?.id === id);
}

function entriesEqualPrefix(managed: SessionEntry[], origin: SessionEntry[]): boolean {
  if (origin.length > managed.length) return false;
  return origin.every(
    (entry, index) => canonicalJson(entry) === canonicalJson(managed[index]),
  );
}

function entriesFormContinuation(entries: SessionEntry[], parentId: string | undefined): boolean {
  let expected = parentId ?? null;
  for (const entry of entries) {
    if (entry.parentId !== expected) return false;
    expected = entry.id;
  }
  return true;
}

function encodeSession(
  header: FileEntry & { type: "session" },
  entries: SessionEntry[],
): Buffer {
  return Buffer.from(
    `${[header, ...entries].map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    "utf8",
  );
}

function splitBoundedLines(raw: Buffer, maxLineBytes: number): Buffer[] {
  const lines: Buffer[] = [];
  let start = 0;
  for (let index = 0; index < raw.length; index += 1) {
    if (raw[index] !== 0x0a) continue;
    let line = raw.subarray(start, index);
    if (line.length > 0 && line[line.length - 1] === 0x0d) line = line.subarray(0, -1);
    if (line.length > maxLineBytes) {
      throw new SessionOwnershipError(
        "source_line_too_large",
        "session source line exceeds byte limit",
      );
    }
    if (line.length > 0) lines.push(line);
    start = index + 1;
  }
  if (start < raw.length) {
    const line = raw.subarray(start);
    if (line.length > maxLineBytes) {
      throw new SessionOwnershipError(
        "source_line_too_large",
        "session source line exceeds byte limit",
      );
    }
    if (line.length > 0) lines.push(line);
  }
  return lines;
}

async function validatePrivateRoot(path: string): Promise<string> {
  const input = await lstat(path);
  if (input.isSymbolicLink() || !input.isDirectory()) {
    throw new SessionOwnershipError(
      "insecure_ownership_root",
      "ownership root must be a real directory",
    );
  }
  const canonical = await realpath(path);
  const info = await lstat(canonical);
  if (!info.isDirectory()) {
    throw new SessionOwnershipError(
      "insecure_ownership_root",
      "ownership root must be a real directory",
    );
  }
  const getuid = process.getuid;
  if (getuid !== undefined && info.uid !== getuid()) {
    throw new SessionOwnershipError(
      "insecure_ownership_root",
      "ownership root must be owned by current user",
    );
  }
  if ((info.mode & 0o022) !== 0) {
    throw new SessionOwnershipError(
      "insecure_ownership_root",
      "ownership root must not be group/world writable",
    );
  }
  return canonical;
}

async function assertPathAbsent(path: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return;
    throw error;
  }
  throw new SessionOwnershipError("export_collision", "export target already exists");
}

function piProjectDirectoryName(cwd: string): string {
  const canonical = resolve(cwd);
  return `--${canonical.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

function deterministicManagedSessionId(
  inventoryId: string,
  mode: string,
  idempotencyKey: string,
): string {
  const digest = createHash("sha256")
    .update(`${inventoryId}\n${mode}\n${idempotencyKey}`)
    .digest("base64url")
    .slice(0, 32);
  return `dash-${digest}`;
}

function safeOwnershipError(error: unknown): {
  code: string;
  message: string;
  retryable: boolean;
} {
  if (error instanceof SessionOwnershipError) {
    return { code: error.code, message: error.message, retryable: error.retryable };
  }
  if (error instanceof SessionOwnershipStoreError) {
    return { code: error.code, message: error.message, retryable: error.retryable };
  }
  if (error instanceof MultiplexerError) {
    return { code: error.code, message: error.message, retryable: error.retryable };
  }
  return {
    code: "ownership_operation_failed",
    message: "session ownership operation failed",
    retryable: false,
  };
}

function ownershipErrorCode(error: unknown): string {
  return error instanceof SessionOwnershipError || error instanceof SessionOwnershipStoreError
    ? error.code
    : "ownership_unavailable";
}

function resolveLimits(overrides: Partial<SessionOwnershipLimits> | undefined): SessionOwnershipLimits {
  const limits = {
    maxSourceBytes: overrides?.maxSourceBytes ?? DEFAULT_OWNERSHIP_MAX_SOURCE_BYTES,
    maxLineBytes: overrides?.maxLineBytes ?? DEFAULT_OWNERSHIP_MAX_LINE_BYTES,
    maxEntries: overrides?.maxEntries ?? DEFAULT_OWNERSHIP_MAX_ENTRIES,
    leaseMs: overrides?.leaseMs ?? DEFAULT_OWNERSHIP_LEASE_MS,
  };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be positive`);
  }
  if (limits.maxLineBytes > limits.maxSourceBytes) {
    throw new Error("maxLineBytes cannot exceed maxSourceBytes");
  }
  return limits;
}

function snapshotToResource(opened: OpenResult, spec: SessionSpec): SessionResource {
  const now = new Date().toISOString();
  const { env: ignoredEnvironment, ...persistedSpec } = spec;
  void ignoredEnvironment;
  return {
    sessionId: opened.session.sessionId,
    generation: opened.session.generation,
    revision: 1,
    residency: "resident",
    state: opened.session.state === "running" ? "running" : "idle",
    createdAt: now,
    updatedAt: now,
    lastUsedAt: now,
    spec: structuredClone(persistedSpec),
    environment: { keys: [], persistence: "memory-only", provisioned: true },
    links: {
      self: `/v1/session/${encodeURIComponent(opened.session.sessionId)}`,
      rpc: `/v1/session/${encodeURIComponent(opened.session.sessionId)}/rpc`,
      apc: `/v1/session/${encodeURIComponent(opened.session.sessionId)}/apc`,
    },
  };
}

function isWithin(root: string, path: string): boolean {
  const child = relative(resolve(root), resolve(path));
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
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

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
