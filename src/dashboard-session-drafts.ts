import { createHash, randomUUID } from "node:crypto";
import { rename } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { realpath } from "node:fs/promises";

import {
  atomicWritePrivateJson,
  DurabilityError,
  ensurePrivateDirectory,
  readPrivateJsonIfExists,
  stateFileSize,
  validatePrivateFileIfExists,
} from "./durability.js";
import type { PiDaemonWebRuntimePolicyConfig } from "./config.js";
import type {
  ApiErrorBody,
  SessionModelSpec,
  SessionResourceSpec,
  SessionSpec,
  SessionThinkingLevel,
  SessionToolSpec,
} from "./session-api.js";

export const DASHBOARD_SESSION_DRAFT_CONTRACT_VERSION = "1.0" as const;
export const DASHBOARD_SESSION_DRAFT_STORE_FORMAT_VERSION = 1 as const;
export const DASHBOARD_SESSION_DRAFT_STATES = [
  "draft",
  "materializing",
  "live",
  "failed",
  "indeterminate",
  "cancelled",
] as const;
export const DASHBOARD_SESSION_DRAFT_TICKET_STATES = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "indeterminate",
] as const;

export type DashboardSessionDraftState =
  (typeof DASHBOARD_SESSION_DRAFT_STATES)[number];
export type DashboardSessionDraftTicketState =
  (typeof DASHBOARD_SESSION_DRAFT_TICKET_STATES)[number];

export interface DashboardSessionDraftLimits {
  maxDrafts: number;
  maxTickets: number;
  maxStateBytes: number;
  maxCwdChars: number;
  maxNameChars: number;
  maxMessageChars: number;
  maxToolNames: number;
  maxToolNameChars: number;
  terminalRetentionMs: number;
}

export const DEFAULT_DASHBOARD_SESSION_DRAFT_LIMITS = Object.freeze({
  maxDrafts: 256,
  maxTickets: 512,
  maxStateBytes: 16 * 1024 * 1024,
  maxCwdChars: 4_096,
  maxNameChars: 128,
  maxMessageChars: 256 * 1024,
  maxToolNames: 32,
  maxToolNameChars: 128,
  terminalRetentionMs: 7 * 24 * 60 * 60 * 1_000,
}) satisfies Readonly<DashboardSessionDraftLimits>;

export interface DashboardSessionDraftSpec {
  cwd: string;
  name?: string;
  persistence: "persistent" | "memory";
  model?: {
    provider: string;
    id: string;
    thinkingLevel?: SessionThinkingLevel;
  };
  tools: {
    mode: "default" | "none" | "no-builtin" | "allowlist";
    include?: string[];
    exclude?: string[];
  };
  resources: {
    noExtensions: boolean;
    noSkills: boolean;
    noPromptTemplates: boolean;
    noThemes: boolean;
    noContextFiles: boolean;
    projectTrust: "default" | "deny" | "approve";
  };
  isolation: { mode: "unisolated" };
}

export interface DashboardSessionDraftIdentity {
  sessionId: string;
  generation: number;
}

export interface DashboardSessionDraftMaterialization {
  ticketId: string;
  state: DashboardSessionDraftTicketState;
  session?: DashboardSessionDraftIdentity;
  error?: ApiErrorBody;
}

export interface DashboardSessionDraftResource {
  contractVersion: typeof DASHBOARD_SESSION_DRAFT_CONTRACT_VERSION;
  draftId: string;
  revision: number;
  state: DashboardSessionDraftState;
  createdAt: string;
  updatedAt: string;
  spec: DashboardSessionDraftSpec;
  firstMessageStartsSession: true;
  materialization?: DashboardSessionDraftMaterialization;
}

export interface DashboardSessionDraftCreateRequest {
  requestId: string;
  idempotencyKey: string;
  draftId?: string;
  spec: DashboardSessionDraftSpec;
}

export interface DashboardSessionDraftCancelRequest {
  requestId: string;
  idempotencyKey: string;
  expectedRevision: number;
}

export interface DashboardSessionDraftSendRequest {
  requestId: string;
  idempotencyKey: string;
  expectedRevision: number;
  message: string;
}

export interface DashboardSessionDraftSendTicket {
  ticketId: string;
  draftId: string;
  draftRevision: number;
  requestId: string;
  idempotencyKey: string;
  state: DashboardSessionDraftTicketState;
  submittedAt: string;
  updatedAt: string;
  session?: DashboardSessionDraftIdentity;
  error?: ApiErrorBody;
}

export const DASHBOARD_SESSION_DRAFT_PRIVATE_PHASES = [
  "materializing",
  "ready-to-prompt",
  "prompt-submitting",
] as const;
export type DashboardSessionDraftPrivatePhase =
  (typeof DASHBOARD_SESSION_DRAFT_PRIVATE_PHASES)[number];

export interface DashboardSessionDraftSendWork {
  ticket: DashboardSessionDraftSendTicket;
  message: string;
  phase: DashboardSessionDraftPrivatePhase;
  /** Deterministic before side effects; never regenerated during recovery. */
  targetSession: DashboardSessionDraftIdentity;
}

export interface DashboardSessionDraftRecovery {
  drafts: number;
  tickets: number;
  queuedTickets: number;
  runningTickets: number;
  indeterminateTickets: number;
  /** Queued/materializing/ready-to-prompt work safe for the executor to resume. */
  recoverableTicketIds: string[];
  quarantined?: string;
}

export interface DashboardSessionDraftTransition {
  expectedState: "queued" | "running";
  state: Exclude<DashboardSessionDraftTicketState, "queued">;
  /** Required for running checkpoints; may only advance monotonically. */
  phase?: DashboardSessionDraftPrivatePhase;
  session?: DashboardSessionDraftIdentity;
  error?: ApiErrorBody;
}

export interface DashboardSessionDraftExecution {
  submitSend(
    draftId: string,
    request: DashboardSessionDraftSendRequest,
  ): Promise<DashboardSessionDraftSendTicket>;
  getSend(ticketId: string): Promise<DashboardSessionDraftSendTicket | undefined>;
}

export interface DashboardSessionDraftStore extends DashboardSessionDraftExecution {
  recover(): Promise<DashboardSessionDraftRecovery>;
  create(request: DashboardSessionDraftCreateRequest): Promise<DashboardSessionDraftResource>;
  get(draftId: string): Promise<DashboardSessionDraftResource | undefined>;
  cancel(
    draftId: string,
    request: DashboardSessionDraftCancelRequest,
  ): Promise<DashboardSessionDraftResource>;
  submitSend(
    draftId: string,
    request: DashboardSessionDraftSendRequest,
  ): Promise<DashboardSessionDraftSendTicket>;
  getSend(ticketId: string): Promise<DashboardSessionDraftSendTicket | undefined>;
  getSendWork(ticketId: string): Promise<DashboardSessionDraftSendWork | undefined>;
  transitionSend(
    ticketId: string,
    transition: DashboardSessionDraftTransition,
  ): Promise<DashboardSessionDraftSendTicket>;
}

interface StoredDraft {
  resource: DashboardSessionDraftResource;
  createIdempotencyKey: string;
  createFingerprint: string;
  cancelIdempotencyKey?: string;
  cancelFingerprint?: string;
}

interface StoredTicket {
  ticket: DashboardSessionDraftSendTicket;
  fingerprint: string;
  message: string;
  phase: DashboardSessionDraftPrivatePhase;
  targetSession: DashboardSessionDraftIdentity;
}

interface DraftStateEnvelope {
  formatVersion: typeof DASHBOARD_SESSION_DRAFT_STORE_FORMAT_VERSION;
  drafts: StoredDraft[];
  tickets: StoredTicket[];
}

export interface FileDashboardSessionDraftStoreOptions {
  stateDir: string;
  limits?: Partial<DashboardSessionDraftLimits>;
  now?: () => Date;
  randomId?: () => string;
}

export class DashboardSessionDraftError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly details: Record<string, unknown> | undefined;

  constructor(
    code: string,
    message: string,
    options: { retryable?: boolean; details?: Record<string, unknown> } = {},
  ) {
    super(message);
    this.name = "DashboardSessionDraftError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }
}

/**
 * One atomic private store for draft resources and first-send tickets. It never
 * opens a Pi runtime, resolves a model, loads resources, or submits a prompt.
 */
export class FileDashboardSessionDraftStore implements DashboardSessionDraftStore {
  readonly path: string;
  readonly limits: DashboardSessionDraftLimits;
  readonly #now: () => Date;
  readonly #randomId: () => string;
  readonly #drafts = new Map<string, StoredDraft>();
  readonly #tickets = new Map<string, StoredTicket>();
  #recovery: Promise<DashboardSessionDraftRecovery> | undefined;
  #tail: Promise<void> = Promise.resolve();

  constructor(options: FileDashboardSessionDraftStoreOptions) {
    if (!options.stateDir) throw new Error("stateDir must not be empty");
    this.path = resolve(options.stateDir, "web", "session-drafts-v1.json");
    this.limits = resolveDashboardSessionDraftLimits(options.limits);
    this.#now = options.now ?? (() => new Date());
    this.#randomId = options.randomId ?? randomUUID;
  }

  recover(): Promise<DashboardSessionDraftRecovery> {
    this.#recovery ??= this.#load();
    return this.#recovery.then((value) => structuredClone(value));
  }

  async create(
    request: DashboardSessionDraftCreateRequest,
  ): Promise<DashboardSessionDraftResource> {
    await this.recover();
    const validated = validateDashboardSessionDraftCreateRequest(request, this.limits);
    const fingerprint = semanticFingerprint({ draftId: validated.draftId, spec: validated.spec });
    return this.#serialize(async () => {
      const duplicate = [...this.#drafts.values()].find(
        (record) => record.createIdempotencyKey === validated.idempotencyKey,
      );
      if (duplicate !== undefined) {
        if (duplicate.createFingerprint !== fingerprint) {
          throw conflict("draft_idempotency_conflict", "draft idempotency key was reused");
        }
        return cloneDraft(duplicate.resource);
      }
      this.#prune();
      if (this.#drafts.size >= this.limits.maxDrafts) {
        throw new DashboardSessionDraftError(
          "draft_capacity",
          "dashboard session draft capacity reached",
          { retryable: true },
        );
      }
      const draftId = validated.draftId ?? this.#newId("draft");
      if (this.#drafts.has(draftId)) {
        throw conflict("draft_exists", "dashboard session draft already exists");
      }
      const now = this.#timestamp();
      const resource = validateDashboardSessionDraftResource(
        {
          contractVersion: DASHBOARD_SESSION_DRAFT_CONTRACT_VERSION,
          draftId,
          revision: 1,
          state: "draft",
          createdAt: now,
          updatedAt: now,
          spec: validated.spec,
          firstMessageStartsSession: true,
        },
        this.limits,
      );
      this.#drafts.set(draftId, {
        resource,
        createIdempotencyKey: validated.idempotencyKey,
        createFingerprint: fingerprint,
      });
      await this.#write();
      return cloneDraft(resource);
    });
  }

  async get(draftId: string): Promise<DashboardSessionDraftResource | undefined> {
    await this.recover();
    validateId(draftId, "draftId");
    const record = this.#drafts.get(draftId);
    return record === undefined ? undefined : cloneDraft(record.resource);
  }

  async cancel(
    draftId: string,
    request: DashboardSessionDraftCancelRequest,
  ): Promise<DashboardSessionDraftResource> {
    await this.recover();
    validateId(draftId, "draftId");
    const validated = validateDashboardSessionDraftCancelRequest(request);
    const fingerprint = semanticFingerprint({ draftId, expectedRevision: validated.expectedRevision });
    return this.#serialize(async () => {
      const stored = this.#drafts.get(draftId);
      if (stored === undefined) throw notFound("draft_not_found", "dashboard session draft not found");
      if (stored.cancelIdempotencyKey === validated.idempotencyKey) {
        if (stored.cancelFingerprint !== fingerprint) {
          throw conflict("draft_idempotency_conflict", "draft cancel key was reused");
        }
        return cloneDraft(stored.resource);
      }
      if (stored.resource.revision !== validated.expectedRevision) {
        throw conflict("draft_revision_conflict", "dashboard session draft revision changed");
      }
      if (!["draft", "materializing"].includes(stored.resource.state)) {
        throw conflict("draft_not_cancellable", "dashboard session draft is no longer cancellable");
      }
      const activeTicket = stored.resource.materialization?.ticketId === undefined
        ? undefined
        : this.#tickets.get(stored.resource.materialization.ticketId);
      let draftState: "cancelled" | "indeterminate" = "cancelled";
      let cancellationError = draftCancelledError();
      if (
        activeTicket !== undefined &&
        ["queued", "running"].includes(activeTicket.ticket.state)
      ) {
        const crossedPromptBoundary =
          activeTicket.ticket.state === "running" &&
          activeTicket.phase === "prompt-submitting";
        if (crossedPromptBoundary) {
          draftState = "indeterminate";
          cancellationError = draftCancelIndeterminateError();
        }
        activeTicket.ticket = validateDashboardSessionDraftSendTicket({
          ...activeTicket.ticket,
          state: crossedPromptBoundary ? "indeterminate" : "failed",
          updatedAt: this.#timestamp(),
          error: cancellationError,
        });
      }
      stored.resource = validateDashboardSessionDraftResource(
        {
          ...stored.resource,
          revision: stored.resource.revision + 1,
          state: draftState,
          updatedAt: this.#timestamp(),
          ...(activeTicket === undefined
            ? {}
            : {
                materialization: {
                  ticketId: activeTicket.ticket.ticketId,
                  state: activeTicket.ticket.state,
                  ...(activeTicket.ticket.session === undefined
                    ? {}
                    : { session: activeTicket.ticket.session }),
                  error: cancellationError,
                },
              }),
        },
        this.limits,
      );
      stored.cancelIdempotencyKey = validated.idempotencyKey;
      stored.cancelFingerprint = fingerprint;
      await this.#write();
      return cloneDraft(stored.resource);
    });
  }

  async submitSend(
    draftId: string,
    request: DashboardSessionDraftSendRequest,
  ): Promise<DashboardSessionDraftSendTicket> {
    await this.recover();
    validateId(draftId, "draftId");
    const validated = validateDashboardSessionDraftSendRequest(request, this.limits);
    const fingerprint = semanticFingerprint({
      draftId,
      draftRevision: validated.expectedRevision,
      message: validated.message,
    });
    return this.#serialize(async () => {
      const duplicate = [...this.#tickets.values()].find(
        (record) =>
          record.ticket.draftId === draftId &&
          record.ticket.idempotencyKey === validated.idempotencyKey,
      );
      if (duplicate !== undefined) {
        if (duplicate.fingerprint !== fingerprint) {
          throw conflict("draft_idempotency_conflict", "draft send key was reused");
        }
        return cloneTicket(duplicate.ticket);
      }
      const stored = this.#drafts.get(draftId);
      if (stored === undefined) throw notFound("draft_not_found", "dashboard session draft not found");
      if (stored.resource.revision !== validated.expectedRevision) {
        throw conflict("draft_revision_conflict", "dashboard session draft revision changed");
      }
      if (stored.resource.state !== "draft") {
        throw conflict("draft_not_sendable", "dashboard session draft is not awaiting its first message");
      }
      this.#prune();
      if (this.#tickets.size >= this.limits.maxTickets) {
        throw new DashboardSessionDraftError(
          "draft_ticket_capacity",
          "dashboard session draft ticket capacity reached",
          { retryable: true },
        );
      }
      const now = this.#timestamp();
      const ticket = validateDashboardSessionDraftSendTicket({
        ticketId: this.#newId("draft-send"),
        draftId,
        draftRevision: validated.expectedRevision,
        requestId: validated.requestId,
        idempotencyKey: validated.idempotencyKey,
        state: "queued",
        submittedAt: now,
        updatedAt: now,
      });
      this.#tickets.set(ticket.ticketId, {
        ticket,
        fingerprint,
        message: validated.message,
        phase: "materializing",
        targetSession: deterministicDraftSession(draftId),
      });
      stored.resource = validateDashboardSessionDraftResource(
        {
          ...stored.resource,
          revision: stored.resource.revision + 1,
          state: "materializing",
          updatedAt: now,
          materialization: { ticketId: ticket.ticketId, state: "queued" },
        },
        this.limits,
      );
      await this.#write();
      return cloneTicket(ticket);
    });
  }

  async getSend(ticketId: string): Promise<DashboardSessionDraftSendTicket | undefined> {
    await this.recover();
    validateId(ticketId, "ticketId");
    const record = this.#tickets.get(ticketId);
    return record === undefined ? undefined : cloneTicket(record.ticket);
  }

  async getSendWork(ticketId: string): Promise<DashboardSessionDraftSendWork | undefined> {
    await this.recover();
    validateId(ticketId, "ticketId");
    const record = this.#tickets.get(ticketId);
    return record === undefined
      ? undefined
      : {
          ticket: cloneTicket(record.ticket),
          message: record.message,
          phase: record.phase,
          targetSession: structuredClone(record.targetSession),
        };
  }

  async transitionSend(
    ticketId: string,
    transition: DashboardSessionDraftTransition,
  ): Promise<DashboardSessionDraftSendTicket> {
    await this.recover();
    validateId(ticketId, "ticketId");
    return this.#serialize(async () => {
      const stored = this.#tickets.get(ticketId);
      if (stored === undefined) throw notFound("draft_ticket_not_found", "draft send ticket not found");
      if (stored.ticket.state !== transition.expectedState) {
        throw conflict("draft_ticket_state_conflict", "draft send ticket state changed");
      }
      validateTicketTransition(transition, stored.phase, stored.targetSession, stored.ticket.session);
      const nextPhase = transition.phase ?? stored.phase;
      const draft = this.#drafts.get(stored.ticket.draftId);
      if (draft === undefined) throw new DashboardSessionDraftError("corrupt_draft_state", "draft ticket has no draft");
      const updatedAt = this.#timestamp();
      stored.phase = nextPhase;
      stored.ticket = validateDashboardSessionDraftSendTicket({
        ...stored.ticket,
        state: transition.state,
        updatedAt,
        ...(transition.session === undefined ? {} : { session: transition.session }),
        ...(transition.error === undefined ? {} : { error: transition.error }),
      });
      const draftState: DashboardSessionDraftState =
        transition.state === "succeeded" ? "live" :
          transition.state === "failed" ? "failed" :
            transition.state === "indeterminate" ? "indeterminate" : "materializing";
      draft.resource = validateDashboardSessionDraftResource(
        {
          ...draft.resource,
          revision: draft.resource.revision + 1,
          state: draftState,
          updatedAt,
          materialization: {
            ticketId,
            state: transition.state,
            ...(stored.ticket.session === undefined ? {} : { session: stored.ticket.session }),
            ...(stored.ticket.error === undefined ? {} : { error: stored.ticket.error }),
          },
        },
        this.limits,
      );
      await this.#write();
      return cloneTicket(stored.ticket);
    });
  }

  async #load(): Promise<DashboardSessionDraftRecovery> {
    await ensurePrivateDirectory(dirname(dirname(this.path)), "daemon state directory");
    await ensurePrivateDirectory(dirname(this.path), "dashboard state directory");
    let quarantined: string | undefined;
    await validatePrivateFileIfExists(this.path, "dashboard session draft state");
    const size = await stateFileSize(this.path);
    if (size !== undefined && size > this.limits.maxStateBytes) {
      quarantined = await this.#quarantine();
    }
    if (quarantined === undefined) {
      try {
        const value = await readPrivateJsonIfExists<unknown>(this.path);
        if (value !== undefined) this.#restore(value);
      } catch (error) {
        if (error instanceof DurabilityError && error.code === "insecure_state_path") throw error;
        quarantined = await this.#quarantine();
      }
    }
    const recoveredRunning = this.#markRecoveredRunningIndeterminate();
    this.#prune();
    if (quarantined !== undefined || recoveredRunning) await this.#write();
    return this.#recoverySnapshot(quarantined);
  }

  #markRecoveredRunningIndeterminate(): boolean {
    let changed = false;
    for (const stored of this.#tickets.values()) {
      if (stored.ticket.state !== "running" || stored.phase !== "prompt-submitting") continue;
      const updatedAt = this.#timestamp();
      const error: ApiErrorBody = {
        code: "draft_send_indeterminate",
        message: "draft first-send outcome is indeterminate after restart",
        retryable: false,
      };
      stored.ticket = validateDashboardSessionDraftSendTicket({
        ...stored.ticket,
        state: "indeterminate",
        updatedAt,
        error,
      });
      const draft = this.#drafts.get(stored.ticket.draftId);
      if (draft !== undefined) {
        draft.resource = validateDashboardSessionDraftResource(
          {
            ...draft.resource,
            revision: draft.resource.revision + 1,
            state: "indeterminate",
            updatedAt,
            materialization: {
              ticketId: stored.ticket.ticketId,
              state: "indeterminate",
              ...(stored.ticket.session === undefined
                ? {}
                : { session: stored.ticket.session }),
              error,
            },
          },
          this.limits,
        );
      }
      changed = true;
    }
    return changed;
  }

  #restore(value: unknown): void {
    const envelope = strictRecord(value, "draft state envelope");
    strictKeys(envelope, ["formatVersion", "drafts", "tickets"], "draft state envelope");
    if (envelope.formatVersion !== DASHBOARD_SESSION_DRAFT_STORE_FORMAT_VERSION) {
      throw new Error("unsupported dashboard session draft store format");
    }
    if (!Array.isArray(envelope.drafts) || !Array.isArray(envelope.tickets)) {
      throw new Error("dashboard session draft arrays are invalid");
    }
    if (
      envelope.drafts.length > this.limits.maxDrafts ||
      envelope.tickets.length > this.limits.maxTickets
    ) {
      throw new Error("dashboard session draft capacity exceeded");
    }
    for (const value of envelope.drafts) {
      const record = storedDraft(value, this.limits);
      if (this.#drafts.has(record.resource.draftId)) throw new Error("duplicate draft identity");
      this.#drafts.set(record.resource.draftId, record);
    }
    for (const value of envelope.tickets) {
      const record = storedTicket(value, this.limits);
      if (this.#tickets.has(record.ticket.ticketId)) throw new Error("duplicate ticket identity");
      if (!this.#drafts.has(record.ticket.draftId)) throw new Error("ticket draft is missing");
      this.#tickets.set(record.ticket.ticketId, record);
    }
  }

  async #write(): Promise<void> {
    const envelope: DraftStateEnvelope = {
      formatVersion: DASHBOARD_SESSION_DRAFT_STORE_FORMAT_VERSION,
      drafts: [...this.#drafts.values()].map((value) => structuredClone(value)),
      tickets: [...this.#tickets.values()].map((value) => structuredClone(value)),
    };
    const bytes = Buffer.byteLength(JSON.stringify(envelope), "utf8") + 1;
    if (bytes > this.limits.maxStateBytes) {
      throw new DashboardSessionDraftError("draft_state_too_large", "draft state exceeds byte limit");
    }
    await atomicWritePrivateJson(this.path, envelope);
  }

  async #quarantine(): Promise<string | undefined> {
    const exists = await stateFileSize(this.path);
    if (exists === undefined) return undefined;
    const target = `${this.path}.corrupt-${this.#timestamp().replace(/[:.]/gu, "-")}`;
    await rename(this.path, target);
    return target;
  }

  #prune(): void {
    const threshold = this.#now().getTime() - this.limits.terminalRetentionMs;
    const terminal = new Set<DashboardSessionDraftTicketState>([
      "succeeded",
      "failed",
      "indeterminate",
    ]);
    for (const [ticketId, stored] of this.#tickets) {
      if (!terminal.has(stored.ticket.state)) continue;
      if (Date.parse(stored.ticket.updatedAt) >= threshold) continue;
      this.#tickets.delete(ticketId);
    }
    for (const [draftId, stored] of this.#drafts) {
      if (!["cancelled", "live", "failed", "indeterminate"].includes(stored.resource.state)) continue;
      if (Date.parse(stored.resource.updatedAt) >= threshold) continue;
      if ([...this.#tickets.values()].some((ticket) => ticket.ticket.draftId === draftId)) continue;
      this.#drafts.delete(draftId);
    }
  }

  #recoverySnapshot(quarantined?: string): DashboardSessionDraftRecovery {
    const tickets = [...this.#tickets.values()].map((value) => value.ticket);
    return {
      drafts: this.#drafts.size,
      tickets: this.#tickets.size,
      queuedTickets: tickets.filter((ticket) => ticket.state === "queued").length,
      runningTickets: tickets.filter((ticket) => ticket.state === "running").length,
      indeterminateTickets: tickets.filter((ticket) => ticket.state === "indeterminate").length,
      recoverableTicketIds: [...this.#tickets.values()]
        .filter((stored) =>
          stored.ticket.state === "queued" ||
          (stored.ticket.state === "running" && stored.phase !== "prompt-submitting"),
        )
        .map((stored) => stored.ticket.ticketId)
        .sort((left, right) => left.localeCompare(right)),
      ...(quarantined === undefined ? {} : { quarantined }),
    };
  }

  #newId(prefix: string): string {
    const value = `${prefix}-${this.#randomId()}`;
    validateId(value, `${prefix}Id`);
    return value;
  }

  #timestamp(): string {
    const now = this.#now();
    if (!Number.isFinite(now.getTime())) throw new Error("now returned an invalid date");
    return now.toISOString();
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const guarded = async (): Promise<T> => {
      const drafts = new Map(
        [...this.#drafts].map(([key, value]) => [key, structuredClone(value)]),
      );
      const tickets = new Map(
        [...this.#tickets].map(([key, value]) => [key, structuredClone(value)]),
      );
      try {
        return await operation();
      } catch (error) {
        this.#drafts.clear();
        this.#tickets.clear();
        for (const [key, value] of drafts) this.#drafts.set(key, value);
        for (const [key, value] of tickets) this.#tickets.set(key, value);
        throw error;
      }
    };
    const result = this.#tail.then(guarded, guarded);
    this.#tail = result.then(() => undefined, () => undefined);
    return result;
  }
}

export interface DashboardSessionDraftServiceOptions {
  store: DashboardSessionDraftStore;
  allowedRoots: readonly string[];
  limits?: Partial<DashboardSessionDraftLimits>;
  authorizeSpec?: (spec: DashboardSessionDraftSpec) => void;
}

/** Syntax/root policy and CRUD facade; intentionally has no runtime dependency. */
export class DashboardSessionDraftService {
  readonly store: DashboardSessionDraftStore;
  readonly limits: DashboardSessionDraftLimits;
  readonly #allowedRoots: Promise<readonly string[]>;
  readonly #authorizeSpec: ((spec: DashboardSessionDraftSpec) => void) | undefined;

  constructor(options: DashboardSessionDraftServiceOptions) {
    if (options.allowedRoots.length === 0) throw new Error("allowedRoots must not be empty");
    this.store = options.store;
    this.limits = resolveDashboardSessionDraftLimits(options.limits);
    this.#authorizeSpec = options.authorizeSpec;
    // Freeze existing roots to their canonical startup identity. This keeps
    // Darwin's /var -> /private/var alias (and equivalent symlink aliases)
    // comparable with the canonical cwd. A root absent at startup retains its
    // lexical identity, so creating it later works but a later symlink target
    // does not silently become authoritative.
    this.#allowedRoots = Promise.all(options.allowedRoots.map(async (root) => {
      const resolved = resolve(root);
      return realpath(resolved).catch(() => resolved);
    }));
  }

  recover(): Promise<DashboardSessionDraftRecovery> {
    return this.store.recover();
  }

  async create(
    request: DashboardSessionDraftCreateRequest,
  ): Promise<DashboardSessionDraftResource> {
    const validated = validateDashboardSessionDraftCreateRequest(request, this.limits);
    const cwd = await realpath(validated.spec.cwd).catch(() => {
      throw new DashboardSessionDraftError("draft_cwd_invalid", "draft cwd is unavailable");
    });
    const allowedRoots = await this.#allowedRoots;
    if (!allowedRoots.some((root) => isWithin(root, cwd))) {
      throw new DashboardSessionDraftError("draft_cwd_not_allowed", "draft cwd is outside allowed roots");
    }
    const spec = { ...validated.spec, cwd };
    this.#authorizeSpec?.(spec);
    return this.store.create({
      ...validated,
      spec,
    });
  }

  get(draftId: string): Promise<DashboardSessionDraftResource | undefined> {
    return this.store.get(draftId);
  }

  cancel(
    draftId: string,
    request: DashboardSessionDraftCancelRequest,
  ): Promise<DashboardSessionDraftResource> {
    return this.store.cancel(draftId, request);
  }

  submitSend(
    draftId: string,
    request: DashboardSessionDraftSendRequest,
  ): Promise<DashboardSessionDraftSendTicket> {
    return this.store.submitSend(draftId, request);
  }

  getSend(ticketId: string): Promise<DashboardSessionDraftSendTicket | undefined> {
    return this.store.getSend(ticketId);
  }
}

export function dashboardSessionDraftSpecToSessionSpec(
  draft: DashboardSessionDraftSpec,
  runtimePolicy?: PiDaemonWebRuntimePolicyConfig,
): SessionSpec {
  const selectedModel = draft.model ?? runtimePolicy?.model;
  const model: SessionModelSpec | undefined = selectedModel === undefined
    ? undefined
    : { ...selectedModel };
  const tools: SessionToolSpec = {
    mode: draft.tools.mode,
    ...(draft.tools.include === undefined ? {} : { include: [...draft.tools.include] }),
    ...(draft.tools.exclude === undefined ? {} : { exclude: [...draft.tools.exclude] }),
  };
  const resources: SessionResourceSpec = {
    ...(runtimePolicy?.resources ?? {}),
    ...draft.resources,
    ...(draft.resources.noExtensions && runtimePolicy?.resources?.extensions !== undefined
      ? { extensions: [] }
      : {}),
    ...(draft.resources.noSkills && runtimePolicy?.resources?.skills !== undefined
      ? { skills: [] }
      : {}),
    ...(draft.resources.noPromptTemplates && runtimePolicy?.resources?.promptTemplates !== undefined
      ? { promptTemplates: [] }
      : {}),
    ...(draft.resources.noThemes && runtimePolicy?.resources?.themes !== undefined
      ? { themes: [] }
      : {}),
  };
  return {
    cwd: draft.cwd,
    ...(draft.name === undefined ? {} : { name: draft.name }),
    target: { mode: draft.persistence === "memory" ? "memory" : "new" },
    ...(model === undefined ? {} : { model }),
    tools,
    resources,
    ...(runtimePolicy?.settings === undefined
      ? {}
      : { settings: structuredClone(runtimePolicy.settings) }),
    isolation: { mode: "unisolated" },
  };
}

export function resolveDashboardSessionDraftLimits(
  overrides: Partial<DashboardSessionDraftLimits> | undefined,
): DashboardSessionDraftLimits {
  const limits = { ...DEFAULT_DASHBOARD_SESSION_DRAFT_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new RangeError(`dashboard session draft limit ${name} must be positive`);
    }
  }
  return limits;
}

export function validateDashboardSessionDraftCreateRequest(
  value: unknown,
  limits: DashboardSessionDraftLimits = DEFAULT_DASHBOARD_SESSION_DRAFT_LIMITS,
): DashboardSessionDraftCreateRequest {
  const input = strictRecord(value, "draft create request");
  strictKeys(input, ["requestId", "idempotencyKey", "draftId", "spec"], "draft create request");
  return {
    requestId: boundedId(input.requestId, "requestId", 128),
    idempotencyKey: boundedId(input.idempotencyKey, "idempotencyKey", 512),
    ...(input.draftId === undefined ? {} : { draftId: validateId(input.draftId, "draftId") }),
    spec: validateDashboardSessionDraftSpec(input.spec, limits),
  };
}

export function validateDashboardSessionDraftCancelRequest(
  value: unknown,
): DashboardSessionDraftCancelRequest {
  const input = strictRecord(value, "draft cancel request");
  strictKeys(input, ["requestId", "idempotencyKey", "expectedRevision"], "draft cancel request");
  return {
    requestId: boundedId(input.requestId, "requestId", 128),
    idempotencyKey: boundedId(input.idempotencyKey, "idempotencyKey", 512),
    expectedRevision: positiveInteger(input.expectedRevision, "expectedRevision"),
  };
}

export function validateDashboardSessionDraftSendRequest(
  value: unknown,
  limits: DashboardSessionDraftLimits = DEFAULT_DASHBOARD_SESSION_DRAFT_LIMITS,
): DashboardSessionDraftSendRequest {
  const input = strictRecord(value, "draft send request");
  strictKeys(input, ["requestId", "idempotencyKey", "expectedRevision", "message"], "draft send request");
  const message = boundedString(input.message, "message", 1, limits.maxMessageChars);
  return {
    requestId: boundedId(input.requestId, "requestId", 128),
    idempotencyKey: boundedId(input.idempotencyKey, "idempotencyKey", 512),
    expectedRevision: positiveInteger(input.expectedRevision, "expectedRevision"),
    message,
  };
}

export function validateDashboardSessionDraftSpec(
  value: unknown,
  limits: DashboardSessionDraftLimits = DEFAULT_DASHBOARD_SESSION_DRAFT_LIMITS,
): DashboardSessionDraftSpec {
  const input = strictRecord(value, "draft spec");
  strictKeys(input, ["cwd", "name", "persistence", "model", "tools", "resources", "isolation"], "draft spec");
  if (input.persistence !== "persistent" && input.persistence !== "memory") {
    throw invalid("draft persistence is invalid");
  }
  const tools = strictRecord(input.tools, "draft tools");
  strictKeys(tools, ["mode", "include", "exclude"], "draft tools");
  if (!["default", "none", "no-builtin", "allowlist"].includes(tools.mode as string)) {
    throw invalid("draft tool mode is invalid");
  }
  const toolMode = tools.mode as DashboardSessionDraftSpec["tools"]["mode"];
  const include = optionalStringArray(tools.include, "tools.include", limits);
  const exclude = optionalStringArray(tools.exclude, "tools.exclude", limits);
  if (tools.mode === "none" && ((include?.length ?? 0) > 0 || (exclude?.length ?? 0) > 0)) {
    throw invalid("none tool mode cannot include tool names");
  }
  const resources = strictRecord(input.resources, "draft resources");
  const resourceKeys = [
    "noExtensions",
    "noSkills",
    "noPromptTemplates",
    "noThemes",
    "noContextFiles",
    "projectTrust",
  ] as const;
  strictKeys(resources, resourceKeys, "draft resources");
  for (const key of resourceKeys.slice(0, -1)) {
    if (typeof resources[key] !== "boolean") throw invalid(`draft resource ${key} is invalid`);
  }
  if (!["default", "deny", "approve"].includes(resources.projectTrust as string)) {
    throw invalid("draft project trust is invalid");
  }
  const projectTrust = resources.projectTrust as DashboardSessionDraftSpec["resources"]["projectTrust"];
  const isolation = strictRecord(input.isolation, "draft isolation");
  strictKeys(isolation, ["mode"], "draft isolation");
  if (isolation.mode !== "unisolated") throw invalid("draft isolation mode is invalid");
  let model: DashboardSessionDraftSpec["model"];
  if (input.model !== undefined) {
    const source = strictRecord(input.model, "draft model");
    strictKeys(source, ["provider", "id", "thinkingLevel"], "draft model");
    const thinkingLevel = source.thinkingLevel;
    if (
      thinkingLevel !== undefined &&
      !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(
        thinkingLevel as string,
      )
    ) {
      throw invalid("draft thinking level is invalid");
    }
    model = {
      provider: boundedString(source.provider, "model.provider", 1, 128),
      id: boundedString(source.id, "model.id", 1, 256),
      ...(thinkingLevel === undefined ? {} : { thinkingLevel: thinkingLevel as SessionThinkingLevel }),
    };
  }
  return {
    cwd: boundedString(input.cwd, "cwd", 1, limits.maxCwdChars),
    ...(input.name === undefined
      ? {}
      : { name: boundedString(input.name, "name", 1, limits.maxNameChars) }),
    persistence: input.persistence,
    ...(model === undefined ? {} : { model }),
    tools: {
      mode: toolMode,
      ...(include === undefined ? {} : { include }),
      ...(exclude === undefined ? {} : { exclude }),
    },
    resources: {
      noExtensions: resources.noExtensions as boolean,
      noSkills: resources.noSkills as boolean,
      noPromptTemplates: resources.noPromptTemplates as boolean,
      noThemes: resources.noThemes as boolean,
      noContextFiles: resources.noContextFiles as boolean,
      projectTrust,
    },
    isolation: { mode: "unisolated" },
  };
}

export function validateDashboardSessionDraftResource(
  value: unknown,
  limits: DashboardSessionDraftLimits = DEFAULT_DASHBOARD_SESSION_DRAFT_LIMITS,
): DashboardSessionDraftResource {
  const input = strictRecord(value, "draft resource");
  strictKeys(input, [
    "contractVersion", "draftId", "revision", "state", "createdAt", "updatedAt",
    "spec", "firstMessageStartsSession", "materialization",
  ], "draft resource");
  if (input.contractVersion !== DASHBOARD_SESSION_DRAFT_CONTRACT_VERSION) throw invalid("draft contract version is invalid");
  if (!DASHBOARD_SESSION_DRAFT_STATES.includes(input.state as DashboardSessionDraftState)) throw invalid("draft state is invalid");
  if (input.firstMessageStartsSession !== true) throw invalid("draft first-message marker is invalid");
  const result: DashboardSessionDraftResource = {
    contractVersion: DASHBOARD_SESSION_DRAFT_CONTRACT_VERSION,
    draftId: validateId(input.draftId, "draftId"),
    revision: positiveInteger(input.revision, "revision"),
    state: input.state as DashboardSessionDraftState,
    createdAt: timestamp(input.createdAt, "createdAt"),
    updatedAt: timestamp(input.updatedAt, "updatedAt"),
    spec: validateDashboardSessionDraftSpec(input.spec, limits),
    firstMessageStartsSession: true,
  };
  if (input.materialization !== undefined) {
    result.materialization = materialization(input.materialization);
  }
  if (result.state === "draft" && result.materialization !== undefined) throw invalid("draft state cannot have materialization");
  return result;
}

export function validateDashboardSessionDraftSendTicket(
  value: unknown,
): DashboardSessionDraftSendTicket {
  const input = strictRecord(value, "draft send ticket");
  strictKeys(input, [
    "ticketId", "draftId", "draftRevision", "requestId", "idempotencyKey", "state",
    "submittedAt", "updatedAt", "session", "error",
  ], "draft send ticket");
  if (!DASHBOARD_SESSION_DRAFT_TICKET_STATES.includes(input.state as DashboardSessionDraftTicketState)) throw invalid("draft ticket state is invalid");
  const result: DashboardSessionDraftSendTicket = {
    ticketId: validateId(input.ticketId, "ticketId"),
    draftId: validateId(input.draftId, "draftId"),
    draftRevision: positiveInteger(input.draftRevision, "draftRevision"),
    requestId: boundedId(input.requestId, "requestId", 128),
    idempotencyKey: boundedId(input.idempotencyKey, "idempotencyKey", 512),
    state: input.state as DashboardSessionDraftTicketState,
    submittedAt: timestamp(input.submittedAt, "submittedAt"),
    updatedAt: timestamp(input.updatedAt, "updatedAt"),
  };
  if (input.session !== undefined) result.session = draftSessionIdentity(input.session);
  if (input.error !== undefined) result.error = draftError(input.error);
  if (result.state === "succeeded" && result.session === undefined) throw invalid("succeeded draft ticket requires session identity");
  if (result.state === "failed" && result.error === undefined) throw invalid("failed draft ticket requires error");
  return result;
}

function validateTicketTransition(
  transition: DashboardSessionDraftTransition,
  currentPhase: DashboardSessionDraftPrivatePhase,
  targetSession: DashboardSessionDraftIdentity,
  currentSession: DashboardSessionDraftIdentity | undefined,
): void {
  const allowed = transition.expectedState === "queued"
    ? ["running", "failed", "indeterminate"]
    : ["running", "succeeded", "failed", "indeterminate"];
  if (!allowed.includes(transition.state)) {
    throw conflict("draft_ticket_transition", "draft ticket transition is invalid");
  }
  const phase = transition.phase ?? currentPhase;
  const phaseOrder = new Map<DashboardSessionDraftPrivatePhase, number>([
    ["materializing", 0],
    ["ready-to-prompt", 1],
    ["prompt-submitting", 2],
  ]);
  if (phaseOrder.get(phase)! < phaseOrder.get(currentPhase)!) {
    throw conflict("draft_ticket_phase_conflict", "draft send phase cannot move backwards");
  }
  if (transition.expectedState === "running" && transition.state === "running" && transition.phase === undefined) {
    throw invalid("running checkpoint transition requires phase");
  }
  const session = transition.session ?? currentSession;
  if (transition.session !== undefined) {
    const validated = draftSessionIdentity(transition.session);
    if (!sameSession(validated, targetSession)) {
      throw conflict("draft_session_identity_conflict", "materialized session differs from admitted target");
    }
  }
  if (["ready-to-prompt", "prompt-submitting"].includes(phase)) {
    if (session === undefined || !sameSession(session, targetSession)) {
      throw invalid("ready-to-prompt phases require the admitted target session");
    }
  }
  if (transition.state === "succeeded") {
    if (session === undefined || !sameSession(session, targetSession)) {
      throw invalid("succeeded transition requires the admitted target session");
    }
  }
  if (transition.state === "failed" && transition.error === undefined) {
    throw invalid("failed transition requires error");
  }
  if (transition.error !== undefined) draftError(transition.error);
}

function materialization(value: unknown): DashboardSessionDraftMaterialization {
  const input = strictRecord(value, "draft materialization");
  strictKeys(input, ["ticketId", "state", "session", "error"], "draft materialization");
  if (!DASHBOARD_SESSION_DRAFT_TICKET_STATES.includes(input.state as DashboardSessionDraftTicketState)) throw invalid("draft materialization state is invalid");
  return {
    ticketId: validateId(input.ticketId, "ticketId"),
    state: input.state as DashboardSessionDraftTicketState,
    ...(input.session === undefined ? {} : { session: draftSessionIdentity(input.session) }),
    ...(input.error === undefined ? {} : { error: draftError(input.error) }),
  };
}

function draftSessionIdentity(value: unknown): DashboardSessionDraftIdentity {
  const input = strictRecord(value, "draft session identity");
  strictKeys(input, ["sessionId", "generation"], "draft session identity");
  return {
    sessionId: validateId(input.sessionId, "sessionId"),
    generation: nonNegativeInteger(input.generation, "generation"),
  };
}

function draftError(value: unknown): ApiErrorBody {
  const input = strictRecord(value, "draft error");
  strictKeys(input, ["code", "message", "retryable", "details"], "draft error");
  if (input.details !== undefined) throw invalid("draft error details are not browser-safe");
  return {
    code: boundedId(input.code, "error.code", 128),
    message: boundedString(input.message, "error.message", 1, 1_024),
    retryable: boolean(input.retryable, "error.retryable"),
  };
}

function draftCancelledError(): ApiErrorBody {
  return { code: "draft_cancelled", message: "dashboard session draft was cancelled", retryable: false };
}

function draftCancelIndeterminateError(): ApiErrorBody {
  return {
    code: "draft_cancel_indeterminate",
    message: "draft cancellation raced prompt submission; outcome is indeterminate",
    retryable: false,
  };
}

function storedDraft(
  value: unknown,
  limits: DashboardSessionDraftLimits,
): StoredDraft {
  const input = strictRecord(value, "stored draft");
  strictKeys(input, ["resource", "createIdempotencyKey", "createFingerprint", "cancelIdempotencyKey", "cancelFingerprint"], "stored draft");
  return {
    resource: validateDashboardSessionDraftResource(input.resource, limits),
    createIdempotencyKey: boundedId(input.createIdempotencyKey, "createIdempotencyKey", 512),
    createFingerprint: digest(input.createFingerprint, "createFingerprint"),
    ...(input.cancelIdempotencyKey === undefined ? {} : { cancelIdempotencyKey: boundedId(input.cancelIdempotencyKey, "cancelIdempotencyKey", 512) }),
    ...(input.cancelFingerprint === undefined ? {} : { cancelFingerprint: digest(input.cancelFingerprint, "cancelFingerprint") }),
  };
}

function storedTicket(
  value: unknown,
  limits: DashboardSessionDraftLimits,
): StoredTicket {
  const input = strictRecord(value, "stored draft ticket");
  strictKeys(input, ["ticket", "fingerprint", "message", "phase", "targetSession"], "stored draft ticket");
  if (!DASHBOARD_SESSION_DRAFT_PRIVATE_PHASES.includes(input.phase as DashboardSessionDraftPrivatePhase)) {
    throw invalid("stored draft ticket phase is invalid");
  }
  return {
    ticket: validateDashboardSessionDraftSendTicket(input.ticket),
    fingerprint: digest(input.fingerprint, "fingerprint"),
    message: boundedString(input.message, "message", 1, limits.maxMessageChars),
    phase: input.phase as DashboardSessionDraftPrivatePhase,
    targetSession: draftSessionIdentity(input.targetSession),
  };
}

function optionalStringArray(
  value: unknown,
  field: string,
  limits: DashboardSessionDraftLimits,
): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > limits.maxToolNames) throw invalid(`${field} is invalid`);
  const result = value.map((item, index) =>
    boundedId(item, `${field}[${index}]`, limits.maxToolNameChars),
  );
  if (new Set(result).size !== result.length) throw invalid(`${field} contains duplicates`);
  return result;
}

function strictRecord(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw invalid(`${field} must be an object`);
  return value as Record<string, unknown>;
}

function strictKeys(value: Record<string, unknown>, allowed: readonly string[], field: string): void {
  const set = new Set(allowed);
  if (Object.keys(value).some((key) => !set.has(key))) throw invalid(`${field} contains an unsupported field`);
}

function boundedString(value: unknown, field: string, min: number, max: number): string {
  if (typeof value !== "string" || value.length < min || value.length > max || /[\u0000]/u.test(value)) throw invalid(`${field} is invalid`);
  return value;
}

function boundedId(value: unknown, field: string, max: number): string {
  const result = boundedString(value, field, 1, max);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(result)) throw invalid(`${field} is invalid`);
  return result;
}

function validateId(value: unknown, field: string): string {
  return boundedId(value, field, 128);
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw invalid(`${field} is invalid`);
  return value as number;
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw invalid(`${field} is invalid`);
  return value as number;
}

function boolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw invalid(`${field} is invalid`);
  return value;
}

function timestamp(value: unknown, field: string): string {
  const result = boundedString(value, field, 20, 64);
  if (!Number.isFinite(Date.parse(result))) throw invalid(`${field} is invalid`);
  return result;
}

function digest(value: unknown, field: string): string {
  const result = boundedString(value, field, 64, 64);
  if (!/^[a-f0-9]{64}$/u.test(result)) throw invalid(`${field} is invalid`);
  return result;
}

function deterministicDraftSession(draftId: string): DashboardSessionDraftIdentity {
  const digest = createHash("sha256").update(draftId, "utf8").digest("hex");
  return { sessionId: `dash-${digest.slice(0, 40)}`, generation: 1 };
}

function sameSession(
  left: DashboardSessionDraftIdentity,
  right: DashboardSessionDraftIdentity,
): boolean {
  return left.sessionId === right.sessionId && left.generation === right.generation;
}

function semanticFingerprint(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
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

function cloneDraft(value: DashboardSessionDraftResource): DashboardSessionDraftResource {
  return structuredClone(value);
}

function cloneTicket(value: DashboardSessionDraftSendTicket): DashboardSessionDraftSendTicket {
  return structuredClone(value);
}

function invalid(message: string): DashboardSessionDraftError {
  return new DashboardSessionDraftError("invalid_draft", message);
}

function conflict(code: string, message: string): DashboardSessionDraftError {
  return new DashboardSessionDraftError(code, message);
}

function notFound(code: string, message: string): DashboardSessionDraftError {
  return new DashboardSessionDraftError(code, message);
}

function isWithin(root: string, candidate: string): boolean {
  const child = relative(resolve(root), resolve(candidate));
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}
