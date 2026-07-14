import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, resolve } from "node:path";

import {
  DurabilityError,
  requestFingerprint,
  type DurableOpenCommand,
  type DurabilityStore,
  type JournalEntry,
  type RecoverySnapshot,
} from "./durability.js";
import type { SessionEnvironmentSummary, TicketResource } from "./session-api.js";
import { wakeTicketResource } from "./tickets.js";
import type {
  OpenPayload,
  ProtocolCommand,
  SessionTarget,
  WakePayload,
} from "./protocol.js";
import {
  HostMetrics,
  NOOP_LOGGER,
  type MetricsSnapshot,
  type StructuredLogger,
} from "./observability.js";
import { eventEnvelope, parseCommand, type EventEnvelope } from "./protocol.js";
import type { PiRpcController } from "./pi-rpc-controller.js";
import {
  SessionConfigurationError,
  requireProvisionedEnvironment,
  type PreparedSessionRuntimeOptions,
} from "./session-config.js";
import {
  SessionCatalogError,
  sessionSpecDigest,
  validateCatalogSessionId,
  type PersistedSessionSpec,
  type SessionCatalogPage,
  type SessionCatalogRecord,
  type SessionCatalogReplaceInput,
  type SessionCatalogStore,
  type SessionConversationIdentity,
  type SessionTerminalRecord,
} from "./session-catalog.js";

export type SessionState = "opening" | "idle" | "running" | "failed" | "closing";

export interface SessionOpenRequest {
  sessionId: string;
  generation: number;
  cwd: string;
  agentDir?: string;
  session?: SessionTarget;
  model?: OpenPayload["model"];
  resources?: OpenPayload["resources"];
  runtimeOptions?: PreparedSessionRuntimeOptions;
  signal?: AbortSignal;
}

export interface AdapterEvent {
  event: string;
  data?: unknown;
}

export interface PromptRequest {
  requestId: string;
  idempotencyKey: string;
  prompt: string;
  source?: string;
  signal: AbortSignal;
  onEvent: (event: AdapterEvent) => void;
}

/** One isolated SDK session. Implemented by the real Pi adapter in PD-006. */
export interface SessionAdapter {
  prompt(request: PromptRequest): Promise<unknown>;
  identity?(): SessionConversationIdentity;
  setIdentityChangeHandler?(
    handler: ((identity: SessionConversationIdentity) => Promise<void>) | undefined,
  ): void;
  setSessionNameChangeHandler?(handler: ((name: string) => Promise<void>) | undefined): void;
  rpcController?(): Promise<PiRpcController>;
  steer?(message: string): Promise<void> | void;
  followUp?(message: string): Promise<void> | void;
  abort?(): Promise<void> | void;
  dispose(): Promise<void> | void;
}

/** Factory seam used by both the real Pi adapter and credential-free tests. */
export interface SessionFactory {
  open(request: SessionOpenRequest): Promise<SessionAdapter>;
  readiness?(): unknown;
}

export interface MultiplexerLimits {
  maxSessions: number;
  maxConcurrentTurns: number;
  maxSessionQueueDepth: number;
}

export const DEFAULT_MULTIPLEXER_LIMITS: Readonly<MultiplexerLimits> = {
  maxSessions: 128,
  maxConcurrentTurns: 4,
  maxSessionQueueDepth: 32,
};

export interface SessionSnapshot {
  sessionId: string;
  generation: number;
  state: SessionState;
  sequence: number;
  queuedTurns: number;
  activeRequestId?: string;
  lastErrorCode?: string;
  lastUsedAt: string;
  idleForMs: number;
}

export interface RecoveryHealthSnapshot {
  phase: "not_started" | "recovering" | "ready" | "degraded";
  pendingReplays: number;
  pendingMutationTickets: number;
  indeterminateMutationTickets: number;
  mutationRecoveryFailures: number;
  openedSessions: number;
  replayedRequests: number;
  indeterminateRequests: number;
  failureCount: number;
  failureCodes: Record<string, number>;
  startedAt?: string;
  completedAt?: string;
}

export interface HostSnapshot {
  hostInstanceId: string;
  ready: boolean;
  durable: boolean;
  draining: boolean;
  limits: MultiplexerLimits;
  activeTurns: number;
  queuedTurns: number;
  startedAt: string;
  uptimeMs: number;
  memory: { rss: number; heapUsed: number; heapTotal: number; external: number };
  adapterReadiness?: unknown;
  metrics: MetricsSnapshot;
  recovery: RecoveryHealthSnapshot;
  retainedSessions?: number;
  dormantSessions?: number;
  sessions: SessionSnapshot[];
}

export interface RecoveryReport {
  recovered: RecoverySnapshot;
  catalog: SessionCatalogRecord[];
  opened: string[];
  replayed: string[];
  pendingReplays: number;
  failures: Array<{ sessionId: string; code: string; message: string }>;
}

export interface RecoveryOptions {
  queuedReplay?: "wait" | "background";
  openTimeoutMs?: number;
  totalOpenTimeoutMs?: number;
}

export interface OpenResult {
  created: boolean;
  session: SessionSnapshot;
}

export interface WakeResult {
  result: unknown;
  session: SessionSnapshot;
}

export interface WakeAdmission {
  ticket: TicketResource;
  completion: Promise<WakeResult>;
}

export class MultiplexerError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly details: Record<string, unknown> | undefined;

  constructor(
    code: string,
    message: string,
    options: { retryable?: boolean; details?: Record<string, unknown> } = {},
  ) {
    super(message);
    this.name = "MultiplexerError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }
}

interface NormalizedOpenPolicy {
  cwd: string;
  agentDir?: string;
  session: SessionTarget;
  model?: OpenPayload["model"];
  resources?: OpenPayload["resources"];
}

interface SessionSlot {
  sessionId: string;
  generation: number;
  state: SessionState;
  policy: NormalizedOpenPolicy;
  policyKey: string;
  openCommand: DurableOpenCommand;
  adapter: SessionAdapter;
  durableConversation: boolean;
  sequence: number;
  pendingTurns: number;
  turnTail: Promise<void>;
  activeRequestId?: string;
  activeAbort?: AbortController;
  lastErrorCode?: string;
  lastUsedAt: number;
  inFlight: Map<
    string,
    { fingerprint: string; promise: Promise<WakeResult>; abort: AbortController }
  >;
  controls: Map<string, { fingerprint: string; promise: Promise<void> }>;
}

interface SemaphoreWaiter {
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  abortListener?: () => void;
}

class Semaphore {
  readonly #limit: number;
  readonly #waiters: SemaphoreWaiter[] = [];
  #active = 0;

  constructor(limit: number) {
    this.#limit = positiveInteger(limit, "maxConcurrentTurns");
  }

  get active(): number {
    return this.#active;
  }

  get queued(): number {
    return this.#waiters.length;
  }

  acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) {
      return Promise.reject(abortError());
    }
    if (this.#active < this.#limit) {
      this.#active += 1;
      return Promise.resolve(this.#releaseOnce());
    }

    return new Promise<() => void>((resolve, reject) => {
      const waiter: SemaphoreWaiter = { resolve, reject };
      if (signal !== undefined) {
        const onAbort = (): void => {
          const index = this.#waiters.indexOf(waiter);
          if (index >= 0) this.#waiters.splice(index, 1);
          reject(abortError());
        };
        waiter.signal = signal;
        waiter.abortListener = onAbort;
        signal.addEventListener("abort", onAbort, { once: true });
      }
      this.#waiters.push(waiter);
    });
  }

  #releaseOnce(): () => void {
    let released = false;
    return (): void => {
      if (released) return;
      released = true;
      this.#release();
    };
  }

  #release(): void {
    while (this.#waiters.length > 0) {
      const waiter = this.#waiters.shift()!;
      if (waiter.abortListener !== undefined && waiter.signal !== undefined) {
        waiter.signal.removeEventListener("abort", waiter.abortListener);
      }
      if (waiter.signal?.aborted) {
        waiter.reject(abortError());
        continue;
      }
      waiter.resolve(this.#releaseOnce());
      return;
    }
    this.#active -= 1;
  }
}

export type EventListener = (event: EventEnvelope) => void;

/**
 * In-process registry and scheduler for independent logical Pi sessions.
 *
 * The class deliberately depends only on SessionFactory and the optional
 * neutral DurabilityStore. It contains no Pi SDK imports, transport concerns,
 * or client-specific orchestration.
 */
export class Multiplexer {
  readonly hostInstanceId: string;
  readonly limits: MultiplexerLimits;
  readonly metrics: HostMetrics;
  readonly idleSessionTtlMs: number;
  readonly adapterDisposeTimeoutMs: number;
  readonly #factory: SessionFactory;
  readonly #durability: DurabilityStore | undefined;
  readonly #catalog: SessionCatalogStore | undefined;
  readonly #turns: Semaphore;
  readonly #sessions = new Map<string, SessionSlot>();
  readonly #catalogRecords = new Map<string, SessionCatalogRecord>();
  readonly #lifecycleTails = new Map<string, Promise<void>>();
  readonly #recoveryBlockedSessions = new Set<string>();
  readonly #listeners = new Set<EventListener>();
  readonly #logger: StructuredLogger;
  readonly #now: () => number;
  readonly #startedAt: number;
  #draining = false;
  #ready: boolean;
  #recovered = false;
  #backgroundRecovery: Promise<void> | undefined;
  #recoveryHealth: RecoveryHealthSnapshot = {
    phase: "not_started",
    pendingReplays: 0,
    pendingMutationTickets: 0,
    indeterminateMutationTickets: 0,
    mutationRecoveryFailures: 0,
    openedSessions: 0,
    replayedRequests: 0,
    indeterminateRequests: 0,
    failureCount: 0,
    failureCodes: {},
  };

  constructor(options: {
    factory: SessionFactory;
    durability?: DurabilityStore;
    catalog?: SessionCatalogStore;
    hostInstanceId?: string;
    limits?: Partial<MultiplexerLimits>;
    metrics?: HostMetrics;
    logger?: StructuredLogger;
    idleSessionTtlMs?: number;
    adapterDisposeTimeoutMs?: number;
    now?: () => number;
  }) {
    this.#factory = options.factory;
    this.#durability = options.durability;
    this.#catalog = options.catalog;
    this.#ready = options.durability === undefined && options.catalog === undefined;
    if (this.#ready) {
      const now = (options.now ?? Date.now)();
      this.#recoveryHealth = {
        ...this.#recoveryHealth,
        phase: "ready",
        startedAt: new Date(now).toISOString(),
        completedAt: new Date(now).toISOString(),
      };
    }
    this.hostInstanceId = options.hostInstanceId ?? randomUUID();
    this.metrics = options.metrics ?? new HostMetrics();
    this.#logger = options.logger ?? NOOP_LOGGER;
    this.#now = options.now ?? Date.now;
    this.#startedAt = this.#now();
    this.idleSessionTtlMs = nonNegativeInteger(
      options.idleSessionTtlMs ?? 30 * 60 * 1000,
      "idleSessionTtlMs",
    );
    this.adapterDisposeTimeoutMs = positiveInteger(
      options.adapterDisposeTimeoutMs ?? 5_000,
      "adapterDisposeTimeoutMs",
    );
    this.limits = {
      maxSessions: positiveInteger(
        options.limits?.maxSessions ?? DEFAULT_MULTIPLEXER_LIMITS.maxSessions,
        "maxSessions",
      ),
      maxConcurrentTurns: positiveInteger(
        options.limits?.maxConcurrentTurns ?? DEFAULT_MULTIPLEXER_LIMITS.maxConcurrentTurns,
        "maxConcurrentTurns",
      ),
      maxSessionQueueDepth: nonNegativeInteger(
        options.limits?.maxSessionQueueDepth ?? DEFAULT_MULTIPLEXER_LIMITS.maxSessionQueueDepth,
        "maxSessionQueueDepth",
      ),
    };
    this.#turns = new Semaphore(this.limits.maxConcurrentTurns);
  }

  subscribe(listener: EventListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async recover(options: RecoveryOptions = {}): Promise<RecoveryReport> {
    if (this.#recovered) {
      throw new MultiplexerError("already_recovered", "durable state was already recovered");
    }

    const queuedReplay = options.queuedReplay ?? "wait";
    const openTimeoutMs = positiveInteger(options.openTimeoutMs ?? 30_000, "openTimeoutMs");
    const totalOpenTimeoutMs = positiveInteger(
      options.totalOpenTimeoutMs ?? 120_000,
      "totalOpenTimeoutMs",
    );
    const recoveryStartedAt = this.#now();
    const openDeadline = recoveryStartedAt + totalOpenTimeoutMs;
    this.#recoveryHealth = {
      phase: "recovering",
      pendingReplays: 0,
      pendingMutationTickets: this.#recoveryHealth.pendingMutationTickets,
      indeterminateMutationTickets: this.#recoveryHealth.indeterminateMutationTickets,
      mutationRecoveryFailures: this.#recoveryHealth.mutationRecoveryFailures,
      openedSessions: 0,
      replayedRequests: 0,
      indeterminateRequests: 0,
      failureCount: 0,
      failureCodes: {},
      startedAt: new Date(recoveryStartedAt).toISOString(),
    };

    const catalog = (await this.#catalog?.recover()) ?? [];
    this.#catalogRecords.clear();
    for (const record of catalog) this.#catalogRecords.set(record.sessionId, record);
    const recovered =
      (await this.#durability?.recover()) ??
      ({ manifests: [], queued: [], indeterminate: [] } satisfies RecoverySnapshot);
    this.#recovered = true;
    // Recovery opens use the same generation/lifecycle path as live admission.
    // Public readiness remains false while recoveryHealth.phase is recovering.
    this.#ready = true;
    const report: RecoveryReport = {
      recovered,
      catalog,
      opened: [],
      replayed: [],
      pendingReplays: recovered.queued.length,
      failures: [],
    };

    this.#recoveryHealth.indeterminateRequests = recovered.indeterminate.length;
    this.metrics.increment("recovery_indeterminate_requests", recovered.indeterminate.length);

    const manifests = new Map(
      recovered.manifests.map((manifest) => [manifest.sessionId, manifest]),
    );
    const restoredIds = new Set<string>();
    const restore = async (
      sessionId: string,
      generation: number,
      payload: OpenPayload,
      openOptions: {
        runtimeOptions?: PreparedSessionRuntimeOptions;
        catalogSpec?: PersistedSessionSpec;
        environmentSummary?: SessionEnvironmentSummary;
      } = {},
    ): Promise<void> => {
      try {
        const parsed = parseCommand({
          protocolVersion: "1.0",
          requestId: `restore-open-${randomUUID()}`,
          operation: "open",
          sessionId,
          generation,
          payload,
        });
        if (parsed.operation !== "open") throw new Error("restored command is not open");
        const remainingMs = openDeadline - this.#now();
        if (remainingMs <= 0) {
          throw new MultiplexerError(
            "recovery_deadline_exceeded",
            "session recovery exceeded its total deadline",
            { retryable: true },
          );
        }
        await runWithAbortTimeout(
          (signal) => this.open(parsed, { signal, ...openOptions }),
          Math.min(openTimeoutMs, remainingMs),
          "recovery_open_timeout",
          "timed out restoring logical session",
        );
        report.opened.push(sessionId);
      } catch (error) {
        const normalized = asMultiplexerError(
          error,
          "restore_open_failed",
          "failed to restore logical session",
        );
        report.failures.push({ sessionId, code: normalized.code, message: normalized.message });
        if (normalized.code === "recovery_open_timeout") {
          this.#recoveryBlockedSessions.add(sessionId);
        }
      }
    };

    for (const record of catalog) {
      const manifest = manifests.get(record.sessionId);
      if (manifest === undefined) continue;
      if (manifest.generation !== record.generation) {
        report.failures.push({
          sessionId: record.sessionId,
          code: "manifest_generation_mismatch",
          message: "retained session generation does not match its runtime manifest",
        });
        continue;
      }
      let payload: OpenPayload;
      let conversation = record.conversation ?? manifest.conversation;
      try {
        payload = manifest.payload;
        if (
          record.conversation === undefined &&
          conversation !== undefined &&
          this.#catalog !== undefined
        ) {
          const migrated = await this.#catalog.markResident(
            record.sessionId,
            record.generation,
            conversation,
          );
          this.#catalogRecords.set(migrated.sessionId, migrated);
          conversation = migrated.conversation;
        }
      } catch (error) {
        const normalized = asMultiplexerError(
          error,
          "restore_open_failed",
          "failed to prepare retained logical session",
        );
        report.failures.push({
          sessionId: record.sessionId,
          code: normalized.code,
          message: normalized.message,
        });
        continue;
      }
      if (payload.session.mode === "memory") {
        continue;
      }
      if (conversation?.sessionFile === undefined && payload.session.mode !== "open") {
        report.failures.push({
          sessionId: record.sessionId,
          code: "conversation_identity_missing",
          message: "durable session has no resolved Pi conversation identity",
        });
        continue;
      }
      restoredIds.add(record.sessionId);
      if (record.configuration !== "prepared") {
        await restore(record.sessionId, record.generation, payload);
        continue;
      }
      try {
        requireProvisionedEnvironment(record.environment, undefined);
        const sessionFile = conversation?.sessionFile ?? payload.session.path;
        const runtimeOptions: PreparedSessionRuntimeOptions = {
          persistedSpec: {
            ...record.spec,
            target:
              sessionFile === undefined
                ? record.spec.target
                : { mode: "open", path: sessionFile },
          },
          environmentOverlay: Object.freeze({}),
        };
        await restore(record.sessionId, record.generation, payload, {
          runtimeOptions,
          catalogSpec: record.spec,
          environmentSummary: record.environment,
        });
      } catch (error) {
        const normalized = asMultiplexerError(
          error,
          "restore_open_failed",
          "failed to restore configured logical session",
        );
        report.failures.push({
          sessionId: record.sessionId,
          code: normalized.code,
          message: normalized.message,
        });
      }
    }

    for (const manifest of recovered.manifests) {
      if (restoredIds.has(manifest.sessionId) || this.#catalogRecords.has(manifest.sessionId)) {
        continue;
      }
      if (manifest.payload.session.mode === "memory") continue;
      let payload = manifest.payload;
      if (manifest.conversation?.sessionFile !== undefined) {
        payload = {
          ...manifest.payload,
          session: { mode: "open", path: manifest.conversation.sessionFile },
        };
      } else if (manifest.payload.session.mode !== "open") {
        report.failures.push({
          sessionId: manifest.sessionId,
          code: "conversation_identity_missing",
          message: "legacy manifest has no resolved Pi conversation identity",
        });
        continue;
      }
      await restore(manifest.sessionId, manifest.generation, payload);
    }

    this.#ready = true;
    const refreshHealth = (completed: boolean): void => {
      const failureCodes: Record<string, number> = {};
      for (const failure of report.failures) {
        failureCodes[failure.code] = (failureCodes[failure.code] ?? 0) + 1;
      }
      this.#recoveryHealth = {
        ...this.#recoveryHealth,
        phase:
          !completed || this.#recoveryHealth.pendingMutationTickets > 0
            ? "recovering"
            : report.failures.length === 0 &&
                recovered.indeterminate.length === 0 &&
                this.#recoveryHealth.indeterminateMutationTickets === 0 &&
                this.#recoveryHealth.mutationRecoveryFailures === 0
              ? "ready"
              : "degraded",
        pendingReplays: report.pendingReplays,
        openedSessions: report.opened.length,
        replayedRequests: report.replayed.length,
        indeterminateRequests: recovered.indeterminate.length,
        failureCount: report.failures.length,
        failureCodes,
        ...(completed ? { completedAt: new Date(this.#now()).toISOString() } : {}),
      };
    };
    refreshHealth(false);

    const bySession = new Map<string, JournalEntry[]>();
    for (const entry of recovered.queued) {
      const entries = bySession.get(entry.sessionId) ?? [];
      entries.push(entry);
      bySession.set(entry.sessionId, entries);
    }
    const replayQueued = async (): Promise<void> => {
      await Promise.all(
        [...bySession.entries()].map(async ([sessionId, entries]) => {
          for (const entry of entries) {
            try {
              const parsed = parseCommand(entry.command);
              if (parsed.operation !== "wake") throw new Error("restored command is not wake");
              await this.wake(parsed);
              report.replayed.push(entry.idempotencyKey);
            } catch (error) {
              const normalized = asMultiplexerError(
                error,
                "restore_wake_failed",
                "failed to replay queued wake",
              );
              report.failures.push({
                sessionId,
                code: normalized.code,
                message: normalized.message,
              });
            } finally {
              report.pendingReplays = Math.max(0, report.pendingReplays - 1);
              refreshHealth(false);
            }
          }
        }),
      );
      refreshHealth(true);
      this.metrics.increment("recovery_completed");
      this.metrics.increment("recovery_failures", report.failures.length);
    };

    if (queuedReplay === "background" && recovered.queued.length > 0) {
      this.#backgroundRecovery = replayQueued().finally(() => {
        this.#backgroundRecovery = undefined;
      });
      void this.#backgroundRecovery.catch((error) => {
        this.#logger.write("error", "background_recovery_failed", {
          errorCode: errorCode(error),
        });
      });
      return report;
    }
    await replayQueued();
    return report;
  }

  async waitForBackgroundRecovery(timeoutMs = 30_000): Promise<boolean> {
    const recovery = this.#backgroundRecovery;
    if (recovery === undefined) return true;
    return settlesWithin(recovery, nonNegativeInteger(timeoutMs, "timeoutMs"));
  }

  recoverySettled(): Promise<void> {
    return this.#backgroundRecovery ?? Promise.resolve();
  }

  setMutationRecoveryHealth(
    pending: number,
    indeterminate: number,
    failures = this.#recoveryHealth.mutationRecoveryFailures,
  ): void {
    nonNegativeInteger(pending, "pendingMutationTickets");
    nonNegativeInteger(indeterminate, "indeterminateMutationTickets");
    nonNegativeInteger(failures, "mutationRecoveryFailures");
    const recovering = pending > 0 || this.#recoveryHealth.pendingReplays > 0;
    const degraded =
      indeterminate > 0 ||
      this.#recoveryHealth.indeterminateRequests > 0 ||
      this.#recoveryHealth.failureCount > 0 ||
      failures > 0;
    this.#recoveryHealth = {
      ...this.#recoveryHealth,
      phase: recovering ? "recovering" : degraded ? "degraded" : "ready",
      pendingMutationTickets: pending,
      indeterminateMutationTickets: indeterminate,
      mutationRecoveryFailures: failures,
      ...(!recovering && this.#recoveryHealth.completedAt === undefined
        ? { completedAt: new Date(this.#now()).toISOString() }
        : {}),
    };
  }

  async open(
    command: Extract<ProtocolCommand, { operation: "open" }>,
    options: {
      signal?: AbortSignal;
      runtimeOptions?: PreparedSessionRuntimeOptions;
      environmentSummary?: SessionEnvironmentSummary;
      catalogSpec?: PersistedSessionSpec;
    } = {},
  ): Promise<OpenResult> {
    this.#assertAdmitting("open");
    if (this.#recoveryBlockedSessions.has(command.sessionId) && options.signal === undefined) {
      throw new MultiplexerError(
        "recovery_open_timeout",
        "session recovery is blocked by a timed-out runtime open; restart required",
        { retryable: true },
      );
    }
    throwIfAborted(options.signal);
    this.metrics.increment("open_attempts");
    const openStartedAt = this.#now();
    return this.#withLifecycle(command.sessionId, async () => {
      this.#assertAdmitting("open");
      throwIfAborted(options.signal);
      const existing = this.#sessions.get(command.sessionId);
      const policy = normalizeOpenPolicy(command.payload);
      const catalogSpec =
        options.catalogSpec ??
        options.runtimeOptions?.persistedSpec ??
        persistedSpecFromOpen(command.payload);
      const catalogDigest = sessionSpecDigest(catalogSpec);
      const policyKey =
        options.runtimeOptions === undefined ? canonicalJson(policy) : catalogDigest;
      if (this.#catalog !== undefined) validateCatalogSessionId(command.sessionId);
      const retained = await this.#catalog?.get(command.sessionId);

      if (existing === undefined && retained !== undefined) {
        if (command.generation < retained.generation) {
          throw new MultiplexerError("stale_generation", "session generation is stale", {
            details: {
              currentGeneration: retained.generation,
              receivedGeneration: command.generation,
            },
          });
        }
        if (
          command.generation === retained.generation &&
          catalogDigest !== retained.policyDigest
        ) {
          throw new MultiplexerError(
            "session_policy_conflict",
            "open policy differs for the retained generation",
            { details: { generation: retained.generation } },
          );
        }
      }

      const runtimePolicy =
        existing === undefined
          ? resolvedRuntimePolicy(policy, retained, command.generation)
          : policy;

      if (existing !== undefined) {
        if (command.generation < existing.generation) {
          throw new MultiplexerError("stale_generation", "session generation is stale", {
            details: { currentGeneration: existing.generation, receivedGeneration: command.generation },
          });
        }
        if (command.generation === existing.generation) {
          if (policyKey !== existing.policyKey) {
            throw new MultiplexerError(
              "session_policy_conflict",
              "open policy differs for the current generation",
              { details: { generation: existing.generation } },
            );
          }
          existing.lastUsedAt = this.#now();
          this.metrics.increment("open_reuses");
          return { created: false, session: snapshot(existing, this.#now()) };
        }
        if (existing.pendingTurns > 0 || existing.state === "running") {
          throw new MultiplexerError(
            "session_busy",
            "cannot replace a session generation while turns are pending",
            { retryable: true, details: { currentGeneration: existing.generation } },
          );
        }
        existing.state = "closing";
        await existing.adapter.dispose();
        this.#sessions.delete(command.sessionId);
      } else if (this.#sessions.size >= this.limits.maxSessions) {
        throw new MultiplexerError("session_capacity", "logical session capacity reached", {
          retryable: true,
          details: { maxSessions: this.limits.maxSessions },
        });
      }

      const request: SessionOpenRequest = {
        sessionId: command.sessionId,
        generation: command.generation,
        ...runtimePolicy,
        ...(options.runtimeOptions === undefined
          ? {}
          : { runtimeOptions: options.runtimeOptions }),
      };
      if (options.signal !== undefined) {
        Object.defineProperty(request, "signal", {
          value: options.signal,
          enumerable: false,
          configurable: false,
          writable: false,
        });
      }

      let adapter: SessionAdapter | undefined;
      let conversation: SessionConversationIdentity | undefined;
      try {
        adapter = await this.#factory.open(request);
        throwIfAborted(options.signal);
        conversation = validateOpenedConversation(
          adapter.identity?.(),
          options.runtimeOptions?.persistedSpec.target.mode ?? command.payload.session.mode,
          this.#durability !== undefined || this.#catalog !== undefined,
        );
        if (this.#catalog !== undefined) {
          const catalogRecord =
            retained === undefined
              ? await this.#catalog.create({
                  sessionId: command.sessionId,
                  ...(catalogSpec.name === undefined ? {} : { name: catalogSpec.name }),
                  generation: command.generation,
                  spec: catalogSpec,
                  ...(options.environmentSummary === undefined
                    ? {}
                    : { environment: options.environmentSummary }),
                  residency: "resident",
                  state: "idle",
                  ...(conversation === undefined ? {} : { conversation }),
                  policyDigest: catalogDigest,
                  configuration:
                    options.runtimeOptions === undefined ? "legacy" : "prepared",
                })
              : await this.#catalog.replace(command.sessionId, {
                  expectedGeneration: retained.generation,
                  expectedRevision: retained.revision,
                  generation: command.generation,
                  ...(catalogSpec.name === undefined
                    ? retained.name === undefined
                      ? {}
                      : { name: retained.name }
                    : { name: catalogSpec.name }),
                  spec: catalogSpec,
                  environment: options.environmentSummary ?? retained.environment,
                  residency: "resident",
                  state: "idle",
                  ...(conversation === undefined ? {} : { conversation }),
                  policyDigest: catalogDigest,
                  configuration:
                    options.runtimeOptions === undefined
                      ? (retained.configuration ?? "legacy")
                      : "prepared",
                });
          this.#catalogRecords.set(catalogRecord.sessionId, catalogRecord);
        }
        await this.#durability?.saveManifest(command, conversation);
      } catch (error) {
        await Promise.resolve(adapter?.dispose()).catch(() => {});
        const catalog = this.#catalog;
        if (catalog !== undefined && !this.#sessions.has(command.sessionId)) {
          await catalog
            .get(command.sessionId)
            .then(async (record) => {
              if (record === undefined) return;
              const dormant = await catalog.markDormant(record.sessionId, record.generation);
              this.#catalogRecords.set(dormant.sessionId, dormant);
            })
            .catch(() => {});
        }
        this.metrics.increment("open_failures");
        this.#logger.write("warn", "session_open_failed", {
          sessionId: command.sessionId,
          generation: command.generation,
          errorCode: errorCode(error),
        });
        this.#emitProvisional(
          command.sessionId,
          command.generation,
          "openFailed",
          command.requestId,
          { error: safeError(error) },
        );
        throw asMultiplexerError(error, "open_failed", "failed to open logical session");
      }

      const slot: SessionSlot = {
        sessionId: command.sessionId,
        generation: command.generation,
        state: "idle",
        policy,
        policyKey,
        openCommand: structuredClone(command),
        adapter,
        durableConversation: conversation?.sessionFile !== undefined,
        sequence: 0,
        pendingTurns: 0,
        turnTail: Promise.resolve(),
        lastUsedAt: this.#now(),
        inFlight: new Map(),
        controls: new Map(),
      };
      this.#sessions.set(command.sessionId, slot);
      adapter.setIdentityChangeHandler?.(async (identity) =>
        this.#persistConversationIdentity(slot, identity),
      );
      adapter.setSessionNameChangeHandler?.(async (name) =>
        this.#persistSessionName(slot, name),
      );
      this.metrics.increment("sessions_opened");
      this.metrics.observe("open_latency_ms", this.#now() - openStartedAt);
      this.#logger.write("info", "session_opened", {
        sessionId: command.sessionId,
        generation: command.generation,
      });
      this.#emit(slot, "opened", command.requestId, { state: slot.state });
      return { created: true, session: snapshot(slot, this.#now()) };
    });
  }

  async submitWake(
    command: Extract<ProtocolCommand, { operation: "wake" }>,
  ): Promise<WakeAdmission> {
    if (this.#durability === undefined) {
      throw new MultiplexerError(
        "durable_admission_unavailable",
        "asynchronous wake admission requires durable request storage",
      );
    }
    const slot = this.#requireSession(command.sessionId, command.generation);
    if (!slot.durableConversation) {
      throw new MultiplexerError(
        "durable_admission_unavailable",
        "memory-only sessions cannot create durable wake tickets",
      );
    }
    const completion = this.wake(command);
    void completion.catch(() => {});
    try {
      const entry = await this.#durability.beginRequest(command);
      return { ticket: wakeTicketResource(entry), completion };
    } catch (error) {
      await completion.catch(() => {});
      throw asMultiplexerError(
        error,
        "durability_failed",
        "failed to persist asynchronous wake admission",
      );
    }
  }

  async requestTicket(ticketId: string): Promise<TicketResource | undefined> {
    const entry = await this.#durability?.getRequestByTicket(ticketId);
    return entry === undefined ? undefined : wakeTicketResource(entry);
  }

  async requestTicketByIdempotency(
    sessionId: string,
    idempotencyKey: string,
  ): Promise<TicketResource | undefined> {
    const entry = await this.#durability?.getRequest(sessionId, idempotencyKey);
    return entry === undefined ? undefined : wakeTicketResource(entry);
  }

  async reconcileWakeTicket(
    ticketId: string,
    outcome:
      | { state: "completed"; result: unknown }
      | { state: "failed"; error: { code: string; message: string; retryable: boolean } },
  ): Promise<TicketResource> {
    if (this.#durability === undefined) {
      throw new MultiplexerError(
        "durable_admission_unavailable",
        "wake reconciliation requires durable request storage",
      );
    }
    try {
      const resource = wakeTicketResource(
        await this.#durability.reconcileRequest(ticketId, outcome),
      );
      this.#recoveryHealth.indeterminateRequests = Math.max(
        0,
        this.#recoveryHealth.indeterminateRequests - 1,
      );
      this.setMutationRecoveryHealth(
        this.#recoveryHealth.pendingMutationTickets,
        this.#recoveryHealth.indeterminateMutationTickets,
      );
      return resource;
    } catch (error) {
      throw asMultiplexerError(error, "reconciliation_failed", "wake reconciliation failed");
    }
  }

  wake(command: Extract<ProtocolCommand, { operation: "wake" }>): Promise<WakeResult> {
    this.#assertAdmitting("wake");
    this.metrics.increment("wake_attempts");
    const slot = this.#requireSession(command.sessionId, command.generation);
    const fingerprint = requestFingerprint(command);
    const existing = slot.inFlight.get(command.idempotencyKey);
    if (existing !== undefined) {
      if (existing.fingerprint !== fingerprint) {
        throw new MultiplexerError(
          "idempotency_conflict",
          "idempotency key is active for a different wake request",
        );
      }
      this.metrics.increment("wake_dedup_joins");
      return existing.promise;
    }

    // One pending turn is the active slot; the configured depth bounds waiters.
    if (slot.pendingTurns >= this.limits.maxSessionQueueDepth + 1) {
      this.metrics.increment("wake_queue_rejections");
      throw new MultiplexerError("session_queue_full", "logical session turn queue is full", {
        retryable: true,
        details: { maxSessionQueueDepth: this.limits.maxSessionQueueDepth },
      });
    }

    const wasEmpty = slot.pendingTurns === 0;
    const queuedAt = this.#now();
    const abort = new AbortController();
    slot.pendingTurns += 1;
    if (wasEmpty) {
      // Install cancellation before journal I/O/promise microtasks so an abort
      // received immediately after wake admission still cancels this turn.
      slot.activeAbort = abort;
      slot.activeRequestId = command.requestId;
    }

    const pending = this.#prepareWake(slot, command, abort, queuedAt);
    const tracked = pending.finally(() => {
      const current = slot.inFlight.get(command.idempotencyKey);
      if (current?.promise === tracked) slot.inFlight.delete(command.idempotencyKey);
    });
    slot.inFlight.set(command.idempotencyKey, { fingerprint, promise: tracked, abort });
    return tracked;
  }

  async #prepareWake(
    slot: SessionSlot,
    command: Extract<ProtocolCommand, { operation: "wake" }>,
    abort: AbortController,
    queuedAt: number,
  ): Promise<WakeResult> {
    const durability = slot.durableConversation ? this.#durability : undefined;
    let journal: JournalEntry | undefined;
    try {
      journal = await durability?.beginRequest(command);
    } catch (error) {
      this.#releaseReservation(slot, abort);
      throw asMultiplexerError(error, "durability_failed", "failed to persist queued wake");
    }

    if (journal?.state === "completed") {
      this.metrics.increment("wake_dedup_terminal_hits");
      this.#releaseReservation(slot, abort);
      return { result: journal.result, session: snapshot(slot, this.#now()) };
    }
    if (journal?.state === "failed") {
      this.metrics.increment("wake_dedup_terminal_hits");
      this.#releaseReservation(slot, abort);
      throw journalFailure(journal);
    }
    if (journal?.state === "accepted" || journal?.state === "indeterminate") {
      this.metrics.increment("wake_indeterminate_refusals");
      this.#releaseReservation(slot, abort);
      throw new MultiplexerError(
        "request_indeterminate",
        "wake may have been submitted before a host interruption; automatic replay is refused",
        { details: { idempotencyKey: command.idempotencyKey, state: journal.state } },
      );
    }
    if (slot.state === "failed") {
      const failure = new MultiplexerError("session_failed", "logical session is failed", {
        details: { lastErrorCode: slot.lastErrorCode },
      });
      await durability
        ?.markFailed(slot.sessionId, command.idempotencyKey, journalError(failure))
        .catch(() => {});
      this.#releaseReservation(slot, abort);
      throw failure;
    }

    this.#emit(slot, "promptAccepted", command.requestId, {
      idempotencyKey: command.idempotencyKey,
      queuedTurns: Math.max(0, slot.pendingTurns - 1),
    });
    const task = slot.turnTail.then(async () => this.#runWake(slot, command, abort, queuedAt));
    slot.turnTail = task.then(
      () => undefined,
      () => undefined,
    );
    return task.finally(() => this.#releaseReservation(slot, abort));
  }

  async steer(command: Extract<ProtocolCommand, { operation: "steer" }>): Promise<void> {
    return this.#runEphemeralControl(command, async (slot) => {
      if (slot.adapter.steer === undefined) {
        throw new MultiplexerError("unsupported_operation", "session adapter does not support steer");
      }
      await slot.adapter.steer(command.payload.message);
    });
  }

  async followUp(command: Extract<ProtocolCommand, { operation: "followUp" }>): Promise<void> {
    return this.#runEphemeralControl(command, async (slot) => {
      if (slot.adapter.followUp === undefined) {
        throw new MultiplexerError(
          "unsupported_operation",
          "session adapter does not support followUp",
        );
      }
      await slot.adapter.followUp(command.payload.message);
    });
  }

  #runEphemeralControl(
    command: Extract<ProtocolCommand, { operation: "steer" | "followUp" }>,
    invoke: (slot: SessionSlot) => Promise<void>,
  ): Promise<void> {
    const slot = this.#requireSession(command.sessionId, command.generation);
    const fingerprint = controlFingerprint(command);
    const existing = slot.controls.get(command.idempotencyKey);
    if (existing !== undefined) {
      if (existing.fingerprint !== fingerprint) {
        throw new MultiplexerError(
          "idempotency_conflict",
          "control idempotency key was used for a different command",
        );
      }
      return existing.promise;
    }
    if (slot.state !== "running") {
      throw new MultiplexerError("session_not_running", "logical session is not running", {
        retryable: true,
        details: { state: slot.state },
      });
    }
    const promise = invoke(slot).then(() => {
      slot.lastUsedAt = this.#now();
    });
    slot.controls.set(command.idempotencyKey, { fingerprint, promise });
    while (slot.controls.size > 256) {
      const oldest = slot.controls.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      slot.controls.delete(oldest);
    }
    return promise;
  }

  async abort(command: Extract<ProtocolCommand, { operation: "abort" }>): Promise<boolean> {
    const slot = this.#requireSession(command.sessionId, command.generation);
    if (slot.activeAbort === undefined) return false;
    slot.activeAbort.abort();
    if (slot.state === "running") await slot.adapter.abort?.();
    return true;
  }

  async close(command: Extract<ProtocolCommand, { operation: "close" }>): Promise<boolean> {
    return this.#withLifecycle(command.sessionId, async () => {
      const slot = this.#sessions.get(command.sessionId);
      const retained =
        this.#catalogRecords.get(command.sessionId) ??
        (await this.#catalog?.get(command.sessionId));
      if (slot === undefined) {
        if (retained === undefined) return false;
        if (retained.generation !== command.generation) {
          throw new MultiplexerError("stale_generation", "session generation does not match", {
            details: {
              currentGeneration: retained.generation,
              receivedGeneration: command.generation,
            },
          });
        }
        const retainArtifacts = command.payload.retainSession ?? true;
        if (retainArtifacts) {
          if (retained.residency !== "dormant") {
            const dormant = await this.#catalog?.markDormant(
              retained.sessionId,
              retained.generation,
            );
            if (dormant !== undefined) this.#catalogRecords.set(dormant.sessionId, dormant);
          }
        } else {
          await this.#durability?.closeSession(retained.sessionId, false);
          await this.#catalog?.delete(retained.sessionId);
          this.#catalogRecords.delete(retained.sessionId);
          this.#emitProvisional(
            retained.sessionId,
            retained.generation,
            "sessionDeleted",
            command.requestId,
            {},
          );
        }
        return true;
      }
      this.#assertGeneration(slot, command.generation);
      if (slot.pendingTurns > 0 || slot.state === "running") {
        throw new MultiplexerError("session_busy", "cannot close a session with pending turns", {
          retryable: true,
        });
      }
      const retainArtifacts = command.payload.retainSession ?? true;
      slot.state = "closing";
      await slot.adapter.dispose();
      if (this.#catalog !== undefined) {
        if (retainArtifacts) {
          const dormant = await this.#catalog.markDormant(slot.sessionId, slot.generation);
          this.#catalogRecords.set(dormant.sessionId, dormant);
          this.#emit(slot, "sessionDormant", command.requestId, {});
        } else {
          await this.#catalog.delete(slot.sessionId);
          this.#catalogRecords.delete(slot.sessionId);
          this.#emit(slot, "sessionDeleted", command.requestId, {});
        }
      }
      await this.#durability?.closeSession(command.sessionId, retainArtifacts);
      this.#emit(slot, "sessionClosed", command.requestId, { retainSession: retainArtifacts });
      this.#sessions.delete(command.sessionId);
      this.metrics.increment("sessions_closed");
      this.#logger.write("info", "session_closed", {
        sessionId: command.sessionId,
        generation: command.generation,
        retainArtifacts,
      });
      return true;
    });
  }

  async rpcController(
    sessionRef: string,
    generation?: number,
  ): Promise<PiRpcController> {
    let slot = this.#sessions.get(sessionRef);
    if (slot === undefined && this.#catalog !== undefined) {
      const retained = await this.#catalog.get(sessionRef);
      if (retained === undefined) {
        throw new MultiplexerError("session_not_found", "retained session does not exist");
      }
      slot = this.#sessions.get(retained.sessionId);
    }
    if (slot === undefined) {
      if (this.#catalog === undefined) {
        throw new MultiplexerError("session_not_found", "logical session is not open");
      }
      throw new MultiplexerError(
        "session_not_resident",
        "session is dormant and must be explicitly reopened before RPC attach",
        { retryable: true },
      );
    }
    if (generation !== undefined) this.#assertGeneration(slot, generation);
    if (slot.adapter.rpcController === undefined) {
      throw new MultiplexerError(
        "rpc_unavailable",
        "session adapter does not provide the Pi RPC runtime surface",
      );
    }
    const controller = await slot.adapter.rpcController();
    controller.setPromptScheduler?.(async (run, signal) => {
      const release = await this.#turns.acquire(signal);
      try {
        return await run();
      } finally {
        release();
      }
    });
    return controller;
  }

  async retainedSession(sessionRef: string): Promise<SessionCatalogRecord | undefined> {
    try {
      return await this.#catalog?.get(sessionRef);
    } catch (error) {
      throw asMultiplexerError(error, "catalog_read_failed", "failed to read retained session");
    }
  }

  async retainedSessions(
    options: { limit?: number; cursor?: string } = {},
  ): Promise<SessionCatalogPage> {
    if (this.#catalog === undefined) return { sessions: [] };
    try {
      return await this.#catalog.list(options);
    } catch (error) {
      throw asMultiplexerError(error, "catalog_read_failed", "failed to list retained sessions");
    }
  }

  async replaceDormantSession(
    sessionRef: string,
    input: SessionCatalogReplaceInput,
  ): Promise<SessionCatalogRecord> {
    if (this.#catalog === undefined) {
      throw new MultiplexerError("catalog_unavailable", "durable session catalog is disabled");
    }
    const current = await this.#catalog.get(sessionRef);
    if (current === undefined) {
      throw new MultiplexerError("session_not_found", "retained session does not exist");
    }
    if (this.#sessions.has(current.sessionId)) {
      throw new MultiplexerError("session_busy", "resident session must be replaced through open", {
        retryable: true,
      });
    }
    try {
      const next = await this.#catalog.replace(current.sessionId, input);
      this.#catalogRecords.set(next.sessionId, next);
      this.#emitProvisional(
        next.sessionId,
        next.generation,
        "sessionUpdated",
        undefined,
        { revision: next.revision, residency: next.residency },
      );
      return next;
    } catch (error) {
      throw asMultiplexerError(error, "catalog_update_failed", "failed to update retained session");
    }
  }

  async deleteRetainedSession(
    sessionRef: string,
    options: {
      requestId: string;
      expectedGeneration: number;
      expectedRevision: number;
    },
  ): Promise<boolean> {
    const catalog = this.#catalog;
    if (catalog === undefined) return false;
    const current = await catalog.get(sessionRef);
    if (current === undefined) return false;
    if (
      current.generation !== options.expectedGeneration ||
      current.revision !== options.expectedRevision
    ) {
      throw new MultiplexerError("session_precondition_failed", "session version changed", {
        details: {
          expectedGeneration: options.expectedGeneration,
          expectedRevision: options.expectedRevision,
          currentGeneration: current.generation,
          currentRevision: current.revision,
        },
      });
    }
    if (this.#sessions.has(current.sessionId)) {
      return this.close({
        protocolVersion: "1.0",
        requestId: options.requestId,
        operation: "close",
        sessionId: current.sessionId,
        generation: current.generation,
        payload: { retainSession: false },
      });
    }
    return this.#withLifecycle(current.sessionId, async () => {
      const latest = await catalog.get(current.sessionId);
      if (latest === undefined) return false;
      if (
        latest.generation !== options.expectedGeneration ||
        latest.revision !== options.expectedRevision
      ) {
        throw new MultiplexerError("session_precondition_failed", "session version changed");
      }
      await this.#durability?.closeSession(latest.sessionId, false);
      await catalog.delete(latest.sessionId);
      this.#catalogRecords.delete(latest.sessionId);
      this.#emitProvisional(
        latest.sessionId,
        latest.generation,
        "sessionDeleted",
        options.requestId,
        {},
      );
      return true;
    });
  }

  status(): HostSnapshot;
  status(sessionId: string): SessionSnapshot;
  status(sessionId?: string): HostSnapshot | SessionSnapshot {
    const now = this.#now();
    if (sessionId !== undefined) {
      const slot = this.#sessions.get(sessionId);
      if (slot === undefined) {
        throw new MultiplexerError("session_not_found", "logical session is not open");
      }
      return snapshot(slot, now);
    }
    const memory = process.memoryUsage();
    const readiness = safeReadiness(this.#factory);
    const recovery = structuredClone(this.#recoveryHealth);
    const result: HostSnapshot = {
      hostInstanceId: this.hostInstanceId,
      ready:
        this.#ready &&
        !this.#draining &&
        recovery.phase === "ready" &&
        adapterReadinessReady(readiness),
      durable: this.#durability !== undefined || this.#catalog !== undefined,
      draining: this.#draining,
      limits: { ...this.limits },
      activeTurns: this.#turns.active,
      queuedTurns: this.#turns.queued,
      startedAt: new Date(this.#startedAt).toISOString(),
      uptimeMs: Math.max(0, now - this.#startedAt),
      memory: {
        rss: memory.rss,
        heapUsed: memory.heapUsed,
        heapTotal: memory.heapTotal,
        external: memory.external,
      },
      metrics: this.metrics.snapshot(),
      recovery,
      ...(this.#catalog === undefined
        ? {}
        : {
            retainedSessions: this.#catalogRecords.size,
            dormantSessions: [...this.#catalogRecords.values()].filter(
              (record) => record.residency === "dormant",
            ).length,
          }),
      sessions: [...this.#sessions.values()]
        .sort((a, b) => a.sessionId.localeCompare(b.sessionId))
        .map((slot) => snapshot(slot, now)),
    };
    if (readiness !== undefined) result.adapterReadiness = readiness;
    return result;
  }

  beginDrain(): void {
    if (this.#draining) return;
    this.#draining = true;
    this.metrics.increment("drains_started");
    this.#logger.write("info", "host_draining", { residentSessions: this.#sessions.size });
    for (const slot of this.#sessions.values()) {
      this.#emit(slot, "hostDraining", undefined, {});
    }
  }

  async drain(timeoutMs = 30_000): Promise<{ timedOut: boolean; abortedTurns: number }> {
    nonNegativeInteger(timeoutMs, "timeoutMs");
    this.beginDrain();
    const slots = [...this.#sessions.values()];
    const tails = slots.map((slot) => slot.turnTail);
    if (slots.every((slot) => slot.pendingTurns === 0)) {
      this.metrics.increment("drains_completed");
      return { timedOut: false, abortedTurns: 0 };
    }
    if (await settlesWithin(Promise.allSettled(tails), timeoutMs)) {
      this.metrics.increment("drains_completed");
      return { timedOut: false, abortedTurns: 0 };
    }

    let abortedTurns = 0;
    for (const slot of this.#sessions.values()) {
      for (const entry of slot.inFlight.values()) {
        if (!entry.abort.signal.aborted) {
          entry.abort.abort();
          abortedTurns += 1;
        }
      }
      if (slot.state === "running") void Promise.resolve(slot.adapter.abort?.()).catch(() => {});
    }
    this.metrics.increment("drains_timed_out");
    this.metrics.increment("drain_aborted_turns", abortedTurns);
    this.#logger.write("warn", "host_drain_timeout", { timeoutMs, abortedTurns });
    return { timedOut: true, abortedTurns };
  }

  async sweepIdleSessions(now = this.#now()): Promise<string[]> {
    if (this.idleSessionTtlMs === 0) return [];
    const evicted: string[] = [];
    for (const slot of [...this.#sessions.values()]) {
      if (
        slot.state !== "idle" ||
        slot.pendingTurns > 0 ||
        now - slot.lastUsedAt < this.idleSessionTtlMs
      ) {
        continue;
      }
      try {
        await this.#withLifecycle(slot.sessionId, async () => {
          const current = this.#sessions.get(slot.sessionId);
          if (
            current !== slot ||
            current.state !== "idle" ||
            current.pendingTurns > 0 ||
            now - current.lastUsedAt < this.idleSessionTtlMs
          ) {
            return;
          }
          current.state = "closing";
          const disposal = await settleOutcomeWithin(
            Promise.resolve().then(async () => current.adapter.dispose()),
            this.adapterDisposeTimeoutMs,
          );
          if (disposal === "timeout") {
            throw new MultiplexerError(
              "adapter_dispose_timeout",
              "session adapter disposal exceeded its deadline",
              { retryable: true },
            );
          }
          if (disposal instanceof Error) throw disposal;
          if (this.#catalog !== undefined) {
            const dormant = await this.#catalog.markDormant(
              current.sessionId,
              current.generation,
            );
            this.#catalogRecords.set(dormant.sessionId, dormant);
            this.#emit(current, "sessionDormant", undefined, { reason: "idle_eviction" });
          }
          this.#emit(current, "sessionEvicted", undefined, {
            idleForMs: now - current.lastUsedAt,
          });
          this.#sessions.delete(current.sessionId);
          evicted.push(current.sessionId);
          this.metrics.increment("sessions_evicted");
          this.#logger.write("info", "session_evicted", {
            sessionId: current.sessionId,
            generation: current.generation,
            idleForMs: now - current.lastUsedAt,
          });
        });
      } catch (error) {
        const current = this.#sessions.get(slot.sessionId);
        if (current === slot) {
          current.state = "failed";
          current.lastErrorCode = errorCode(error);
        }
        this.metrics.increment("idle_sweep_failures");
        this.#logger.write("warn", "session_eviction_failed", {
          sessionId: slot.sessionId,
          generation: slot.generation,
          errorCode: errorCode(error),
        });
      }
    }
    return evicted;
  }

  async dispose(timeoutMs = 5_000): Promise<void> {
    nonNegativeInteger(timeoutMs, "timeoutMs");
    await this.drain(timeoutMs);
    const slots = [...this.#sessions.values()];
    for (const slot of slots) {
      for (const entry of slot.inFlight.values()) entry.abort.abort();
    }
    await settlesWithin(Promise.allSettled(slots.map(async (slot) => slot.turnTail)), timeoutMs);
    const disposalTimeout = Math.min(timeoutMs, this.adapterDisposeTimeoutMs);
    await Promise.allSettled(
      slots.map(async (slot) => {
        const disposal = await settleOutcomeWithin(
          Promise.resolve().then(async () => slot.adapter.dispose()),
          disposalTimeout,
        );
        if (disposal === "timeout") {
          this.metrics.increment("adapter_dispose_timeouts");
          this.#logger.write("warn", "adapter_dispose_timeout", {
            sessionId: slot.sessionId,
            generation: slot.generation,
            timeoutMs: disposalTimeout,
          });
          return;
        }
        if (disposal instanceof Error) {
          this.metrics.increment("adapter_dispose_failures");
          this.#logger.write("warn", "adapter_dispose_failed", {
            sessionId: slot.sessionId,
            generation: slot.generation,
            errorCode: errorCode(disposal),
          });
          return;
        }
        if (this.#catalog !== undefined) {
          const dormant = await this.#catalog.markDormant(slot.sessionId, slot.generation);
          this.#catalogRecords.set(dormant.sessionId, dormant);
        }
      }),
    );
    this.#sessions.clear();
  }

  async #runWake(
    slot: SessionSlot,
    command: Extract<ProtocolCommand, { operation: "wake" }>,
    abort: AbortController,
    queuedAt: number,
  ): Promise<WakeResult> {
    if (this.#sessions.get(slot.sessionId) !== slot || slot.generation !== command.generation) {
      throw new MultiplexerError("stale_generation", "session changed before queued turn started");
    }
    const durability = slot.durableConversation ? this.#durability : undefined;
    let release: (() => void) | undefined;
    let turnStartedAt = 0;
    let journalState: "queued" | "accepted" | "terminal" = "queued";
    slot.activeAbort = abort;
    slot.activeRequestId = command.requestId;
    try {
      release = await this.#turns.acquire(abort.signal);
      turnStartedAt = this.#now();
      this.metrics.observe("queue_wait_ms", turnStartedAt - queuedAt);
      if (durability !== undefined) {
        await durability.markAccepted(slot.sessionId, command.idempotencyKey);
        journalState = "accepted";
      }
      slot.state = "running";
      slot.lastUsedAt = this.#now();
      await this.#syncCatalogState(slot, "running");
      this.metrics.increment("turns_started");
      this.#logger.write("info", "turn_started", {
        sessionId: slot.sessionId,
        generation: slot.generation,
        requestId: command.requestId,
      });
      this.#emit(slot, "agentStart", command.requestId, {});
      const request: PromptRequest = {
        requestId: command.requestId,
        idempotencyKey: command.idempotencyKey,
        prompt: command.payload.prompt,
        signal: abort.signal,
        onEvent: (event) => this.#emit(slot, event.event, command.requestId, event.data),
      };
      if (command.payload.source !== undefined) request.source = command.payload.source;
      const result = await slot.adapter.prompt(request);
      if (durability !== undefined) {
        try {
          await durability.markCompleted(slot.sessionId, command.idempotencyKey, result);
          journalState = "terminal";
        } catch (error) {
          throw new MultiplexerError(
            "durability_completion_failed",
            "model turn completed but its terminal result could not be persisted",
            { details: { cause: safeError(error) } },
          );
        }
      }
      slot.state = "idle";
      slot.lastUsedAt = this.#now();
      await this.#syncCatalogState(slot, "idle", {
        state: "succeeded",
        at: new Date(slot.lastUsedAt).toISOString(),
        requestId: command.requestId,
      });
      delete slot.lastErrorCode;
      this.metrics.increment("turns_completed");
      this.metrics.observe("turn_duration_ms", this.#now() - turnStartedAt);
      this.#logger.write("info", "turn_completed", {
        sessionId: slot.sessionId,
        generation: slot.generation,
        requestId: command.requestId,
      });
      this.#emit(slot, "agentEnd", command.requestId, {});
      this.#emit(slot, "sessionIdle", command.requestId, {});
      return { result, session: snapshot(slot, this.#now()) };
    } catch (error) {
      const normalized = asMultiplexerError(error, "turn_failed", "logical session turn failed");
      if (
        durability !== undefined &&
        journalState !== "terminal" &&
        normalized.code !== "durability_completion_failed"
      ) {
        await durability
          .markFailed(slot.sessionId, command.idempotencyKey, journalError(normalized))
          .catch(() => {});
      }
      slot.state = normalized.code === "aborted" ? "idle" : "failed";
      slot.lastUsedAt = this.#now();
      await this.#syncCatalogState(slot, slot.state, {
        state:
          normalized.code === "durability_completion_failed" ? "indeterminate" : "failed",
        at: new Date(slot.lastUsedAt).toISOString(),
        requestId: command.requestId,
        errorCode: normalized.code,
      });
      slot.lastErrorCode = normalized.code;
      this.metrics.increment(normalized.code === "aborted" ? "turns_aborted" : "turns_failed");
      if (turnStartedAt > 0) this.metrics.observe("turn_duration_ms", this.#now() - turnStartedAt);
      this.#logger.write(normalized.code === "aborted" ? "info" : "warn", "turn_failed", {
        sessionId: slot.sessionId,
        generation: slot.generation,
        requestId: command.requestId,
        errorCode: normalized.code,
        retryable: normalized.retryable,
      });
      this.#emit(slot, "requestFailed", command.requestId, {
        error: { code: normalized.code, message: normalized.message, retryable: normalized.retryable },
      });
      if (slot.state === "idle") this.#emit(slot, "sessionIdle", command.requestId, {});
      throw normalized;
    } finally {
      delete slot.activeAbort;
      delete slot.activeRequestId;
      release?.();
    }
  }

  async #persistSessionName(slot: SessionSlot, name: string): Promise<void> {
    if (this.#sessions.get(slot.sessionId) !== slot) {
      throw new MultiplexerError(
        "stale_generation",
        "session changed before its Pi RPC name could be persisted",
      );
    }
    const nextCommand: DurableOpenCommand = {
      ...slot.openCommand,
      payload: { ...slot.openCommand.payload, name },
    };
    try {
      if (this.#catalog !== undefined) {
        const current = await this.#catalog.get(slot.sessionId);
        if (current === undefined) {
          throw new MultiplexerError("session_not_found", "retained session does not exist");
        }
        const spec = { ...current.spec, name };
        const record = await this.#catalog.replace(slot.sessionId, {
          expectedGeneration: current.generation,
          expectedRevision: current.revision,
          generation: current.generation,
          name,
          spec,
          environment: current.environment,
          residency: "resident",
          state: current.state,
          ...(current.conversation === undefined
            ? {}
            : { conversation: current.conversation }),
          policyDigest: sessionSpecDigest(spec),
        });
        this.#catalogRecords.set(record.sessionId, record);
      }
      const conversation = slot.adapter.identity?.();
      await this.#durability?.saveManifest(nextCommand, conversation);
      slot.openCommand = structuredClone(nextCommand);
      this.#emit(slot, "sessionNameChanged", undefined, { name });
    } catch (error) {
      throw asMultiplexerError(
        error,
        "session_name_persist_failed",
        "failed to persist Pi RPC session name",
      );
    }
  }

  async #persistConversationIdentity(
    slot: SessionSlot,
    identity: SessionConversationIdentity,
  ): Promise<void> {
    if (this.#sessions.get(slot.sessionId) !== slot) {
      throw new MultiplexerError(
        "stale_generation",
        "session changed before Pi conversation identity could be persisted",
      );
    }
    const conversation = validateOpenedConversation(
      identity,
      slot.durableConversation ? "new" : "memory",
      true,
    );
    try {
      if (this.#catalog !== undefined) {
        const record = await this.#catalog.markResident(
          slot.sessionId,
          slot.generation,
          conversation,
        );
        this.#catalogRecords.set(record.sessionId, record);
      }
      await this.#durability?.saveManifest(slot.openCommand, conversation);
      slot.durableConversation = conversation?.sessionFile !== undefined;
      this.#emit(slot, "conversationChanged", undefined, { conversation });
    } catch (error) {
      this.metrics.increment("conversation_identity_failures");
      this.#logger.write("warn", "conversation_identity_persist_failed", {
        sessionId: slot.sessionId,
        generation: slot.generation,
        errorCode: errorCode(error),
      });
      throw asMultiplexerError(
        error,
        "conversation_identity_persist_failed",
        "failed to persist replaced Pi conversation identity",
      );
    }
  }

  async #syncCatalogState(
    slot: SessionSlot,
    state: SessionState,
    terminal?: SessionTerminalRecord,
  ): Promise<void> {
    if (this.#catalog === undefined) return;
    try {
      const record = await this.#catalog.markState(slot.sessionId, slot.generation, state, {
        lastUsedAt: new Date(slot.lastUsedAt).toISOString(),
        ...(terminal === undefined ? {} : { terminal }),
      });
      this.#catalogRecords.set(record.sessionId, record);
    } catch (error) {
      this.metrics.increment("catalog_update_failures");
      this.#logger.write("warn", "session_catalog_update_failed", {
        sessionId: slot.sessionId,
        generation: slot.generation,
        state,
        errorCode: errorCode(error),
      });
    }
  }

  #releaseReservation(slot: SessionSlot, abort: AbortController): void {
    slot.pendingTurns -= 1;
    if (slot.activeAbort === abort) {
      delete slot.activeAbort;
      delete slot.activeRequestId;
    }
  }

  #requireSession(sessionId: string, generation: number): SessionSlot {
    const slot = this.#sessions.get(sessionId);
    if (slot === undefined) {
      throw new MultiplexerError("session_not_found", "logical session is not open");
    }
    this.#assertGeneration(slot, generation);
    return slot;
  }

  #assertGeneration(slot: SessionSlot, generation: number): void {
    if (generation !== slot.generation) {
      throw new MultiplexerError("stale_generation", "session generation does not match", {
        details: { currentGeneration: slot.generation, receivedGeneration: generation },
      });
    }
  }

  #assertAdmitting(operation: "open" | "wake"): void {
    if (!this.#ready) {
      throw new MultiplexerError(
        "host_not_ready",
        "durable state must be recovered before admitting requests",
        { retryable: true },
      );
    }
    if (this.#draining) {
      throw new MultiplexerError("host_draining", `host is draining; ${operation} rejected`, {
        retryable: true,
      });
    }
  }

  #emit(slot: SessionSlot, event: string, requestId?: string, data?: unknown): void {
    slot.sequence += 1;
    const input: Parameters<typeof eventEnvelope>[0] = {
      event,
      hostInstanceId: this.hostInstanceId,
      sessionId: slot.sessionId,
      generation: slot.generation,
      sequence: slot.sequence,
    };
    if (requestId !== undefined) input.requestId = requestId;
    if (data !== undefined) input.data = data;
    this.#publish(eventEnvelope(input));
  }

  #emitProvisional(
    sessionId: string,
    generation: number,
    event: string,
    requestId?: string,
    data?: unknown,
  ): void {
    const input: Parameters<typeof eventEnvelope>[0] = {
      event,
      hostInstanceId: this.hostInstanceId,
      sessionId,
      generation,
      sequence: 1,
    };
    if (requestId !== undefined) input.requestId = requestId;
    if (data !== undefined) input.data = data;
    this.#publish(eventEnvelope(input));
  }

  #publish(event: EventEnvelope): void {
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch {
        // A transport/subscriber failure must not corrupt a logical session.
      }
    }
  }

  #withLifecycle<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#lifecycleTails.get(sessionId) ?? Promise.resolve();
    const task = previous.then(operation, operation);
    const tail = task.then(
      () => undefined,
      () => undefined,
    );
    this.#lifecycleTails.set(sessionId, tail);
    void tail.then(() => {
      if (this.#lifecycleTails.get(sessionId) === tail) this.#lifecycleTails.delete(sessionId);
    });
    return task;
  }
}

function normalizeOpenPolicy(payload: OpenPayload): NormalizedOpenPolicy {
  const policy: NormalizedOpenPolicy = {
    cwd: payload.cwd,
    session: { ...payload.session },
  };
  if (payload.agentDir !== undefined) policy.agentDir = payload.agentDir;
  if (payload.model !== undefined) policy.model = { ...payload.model };
  if (payload.resources !== undefined) policy.resources = { ...payload.resources };
  return policy;
}

function resolvedRuntimePolicy(
  policy: NormalizedOpenPolicy,
  retained: SessionCatalogRecord | undefined,
  generation: number,
): NormalizedOpenPolicy {
  if (retained === undefined || retained.generation !== generation) return policy;
  const sessionFile = retained.conversation?.sessionFile;
  if (sessionFile !== undefined) {
    return { ...policy, session: { mode: "open", path: sessionFile } };
  }
  if (policy.session.mode === "open") return policy;
  if (policy.session.mode === "memory") {
    throw new MultiplexerError(
      "ephemeral_session_unavailable",
      "memory-only session cannot be reopened after eviction or restart",
    );
  }
  throw new MultiplexerError(
    "conversation_identity_missing",
    "retained session has no resolved Pi conversation identity",
  );
}

function validateOpenedConversation(
  identity: SessionConversationIdentity | undefined,
  targetMode: PersistedSessionSpec["target"]["mode"],
  required: boolean,
): SessionConversationIdentity | undefined {
  if (identity === undefined) {
    if (required) {
      throw new MultiplexerError(
        "conversation_identity_missing",
        "session adapter did not report its resolved Pi conversation identity",
      );
    }
    return undefined;
  }
  if (typeof identity.sessionId !== "string" || identity.sessionId.length === 0) {
    throw new MultiplexerError(
      "conversation_identity_invalid",
      "session adapter reported an invalid Pi session ID",
    );
  }
  if (
    identity.sessionFile !== undefined &&
    (identity.sessionFile.length === 0 ||
      !isAbsolute(identity.sessionFile) ||
      resolve(identity.sessionFile) !== identity.sessionFile)
  ) {
    throw new MultiplexerError(
      "conversation_identity_invalid",
      "session adapter reported a non-canonical Pi session file",
    );
  }
  if (targetMode === "memory" && identity.sessionFile !== undefined) {
    throw new MultiplexerError(
      "conversation_identity_invalid",
      "memory-only session unexpectedly reported a persistent Pi session file",
    );
  }
  if (targetMode !== "memory" && required && identity.sessionFile === undefined) {
    throw new MultiplexerError(
      "conversation_identity_missing",
      "persistent session did not resolve to a Pi session file",
    );
  }
  return structuredClone(identity);
}

function persistedSpecFromOpen(payload: OpenPayload): PersistedSessionSpec {
  const target: PersistedSessionSpec["target"] = { mode: payload.session.mode };
  if (payload.session.path !== undefined) target.path = payload.session.path;
  const spec: PersistedSessionSpec = {
    cwd: payload.cwd,
    target,
    tools: { mode: "none", include: [], exclude: [] },
    resources: {
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      ...(payload.resources?.systemPrompt === undefined
        ? {}
        : { systemPrompt: payload.resources.systemPrompt }),
    },
    isolation: { mode: "unisolated" },
  };
  if (payload.name !== undefined) spec.name = payload.name;
  if (payload.agentDir !== undefined) spec.agentDir = payload.agentDir;
  if (payload.model !== undefined) spec.model = { ...payload.model };
  return spec;
}

function snapshot(slot: SessionSlot, now: number): SessionSnapshot {
  const result: SessionSnapshot = {
    sessionId: slot.sessionId,
    generation: slot.generation,
    state: slot.state,
    sequence: slot.sequence,
    queuedTurns: Math.max(0, slot.pendingTurns - (slot.state === "running" ? 1 : 0)),
    lastUsedAt: new Date(slot.lastUsedAt).toISOString(),
    idleForMs: slot.state === "idle" ? Math.max(0, now - slot.lastUsedAt) : 0,
  };
  if (slot.activeRequestId !== undefined) result.activeRequestId = slot.activeRequestId;
  if (slot.lastErrorCode !== undefined) result.lastErrorCode = slot.lastErrorCode;
  return result;
}

function controlFingerprint(
  command: Extract<ProtocolCommand, { operation: "steer" | "followUp" }>,
): string {
  return createHash("sha256")
    .update(
      canonicalJson({
        operation: command.operation,
        sessionId: command.sessionId,
        generation: command.generation,
        idempotencyKey: command.idempotencyKey,
        payload: command.payload,
      }),
      "utf8",
    )
    .digest("hex");
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

function safeReadiness(factory: SessionFactory): unknown {
  try {
    return factory.readiness?.();
  } catch (error) {
    return { ready: false, errorCode: errorCode(error) };
  }
}

function adapterReadinessReady(value: unknown): boolean {
  if (value === undefined) return true;
  if (value !== null && typeof value === "object" && "ready" in value) {
    return (value as { ready?: unknown }).ready !== false;
  }
  return true;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  signal?.throwIfAborted();
}

async function runWithAbortTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  code: string,
  message: string,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(controller.signal),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new MultiplexerError(code, message, { retryable: true }));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function settleOutcomeWithin(
  promise: Promise<unknown>,
  timeoutMs: number,
): Promise<"settled" | "timeout" | Error> {
  if (timeoutMs === 0) return "timeout";
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(
        () => "settled" as const,
        (error: unknown) =>
          error instanceof Error ? error : new Error("adapter operation failed"),
      ),
      new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function settlesWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  if (timeoutMs === 0) return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function errorCode(error: unknown): string {
  if (
    error instanceof MultiplexerError ||
    error instanceof DurabilityError ||
    error instanceof SessionCatalogError
  ) {
    return error.code;
  }
  if (error !== null && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return error instanceof Error ? error.name : "unknown_error";
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

function safeError(error: unknown): { name: string; message: string } {
  if (error instanceof Error) return { name: error.name, message: error.message };
  return { name: "Error", message: "unknown error" };
}

function asMultiplexerError(error: unknown, code: string, message: string): MultiplexerError {
  if (error instanceof MultiplexerError) return error;
  if (
    error instanceof DurabilityError ||
    error instanceof SessionCatalogError ||
    error instanceof SessionConfigurationError
  ) {
    return new MultiplexerError(error.code, error.message, {
      retryable: error instanceof SessionCatalogError ? error.retryable : false,
      ...(error.details === undefined ? {} : { details: error.details }),
    });
  }
  if (isAbortError(error)) {
    return new MultiplexerError("aborted", "logical session turn was aborted", { retryable: true });
  }
  return new MultiplexerError(code, message, {
    details: { cause: safeError(error) },
  });
}

function journalError(error: MultiplexerError): {
  code: string;
  message: string;
  retryable: boolean;
} {
  return { code: error.code, message: error.message, retryable: error.retryable };
}

function journalFailure(entry: JournalEntry): MultiplexerError {
  if (entry.error === undefined) {
    return new MultiplexerError("request_failed", "durable wake request previously failed");
  }
  return new MultiplexerError(entry.error.code, entry.error.message, {
    retryable: entry.error.retryable,
    details: { cached: true, idempotencyKey: entry.idempotencyKey },
  });
}

function abortError(): Error {
  return new DOMException("operation aborted", "AbortError");
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export function openRequestFromCommand(
  command: Extract<ProtocolCommand, { operation: "open" }>,
): SessionOpenRequest {
  const policy = normalizeOpenPolicy(command.payload);
  return { sessionId: command.sessionId, generation: command.generation, ...policy };
}

export function wakePayloadFromCommand(
  command: Extract<ProtocolCommand, { operation: "wake" }>,
): WakePayload {
  return { ...command.payload };
}
