import { randomUUID } from "node:crypto";

import type {
  OpenPayload,
  ProtocolCommand,
  SessionTarget,
  WakePayload,
} from "./protocol.js";
import { eventEnvelope, type EventEnvelope } from "./protocol.js";

export type SessionState = "opening" | "idle" | "running" | "failed" | "closing";

export interface SessionOpenRequest {
  sessionId: string;
  generation: number;
  cwd: string;
  agentDir?: string;
  session: SessionTarget;
  model?: OpenPayload["model"];
  resources?: OpenPayload["resources"];
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
  steer?(message: string): Promise<void> | void;
  followUp?(message: string): Promise<void> | void;
  abort?(): Promise<void> | void;
  dispose(): Promise<void> | void;
}

/** Factory seam used by both the real Pi adapter and credential-free tests. */
export interface SessionFactory {
  open(request: SessionOpenRequest): Promise<SessionAdapter>;
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
}

export interface HostSnapshot {
  hostInstanceId: string;
  draining: boolean;
  limits: MultiplexerLimits;
  activeTurns: number;
  queuedTurns: number;
  sessions: SessionSnapshot[];
}

export interface OpenResult {
  created: boolean;
  session: SessionSnapshot;
}

export interface WakeResult {
  result: unknown;
  session: SessionSnapshot;
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
  adapter: SessionAdapter;
  sequence: number;
  pendingTurns: number;
  turnTail: Promise<void>;
  activeRequestId?: string;
  activeAbort?: AbortController;
  lastErrorCode?: string;
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
 * The class deliberately depends only on SessionFactory. It contains no Pi SDK
 * imports, transport concerns, client-specific orchestration, or durable state.
 */
export class Multiplexer {
  readonly hostInstanceId: string;
  readonly limits: MultiplexerLimits;
  readonly #factory: SessionFactory;
  readonly #turns: Semaphore;
  readonly #sessions = new Map<string, SessionSlot>();
  readonly #lifecycleTails = new Map<string, Promise<void>>();
  readonly #listeners = new Set<EventListener>();
  #draining = false;

  constructor(options: {
    factory: SessionFactory;
    hostInstanceId?: string;
    limits?: Partial<MultiplexerLimits>;
  }) {
    this.#factory = options.factory;
    this.hostInstanceId = options.hostInstanceId ?? randomUUID();
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

  async open(command: Extract<ProtocolCommand, { operation: "open" }>): Promise<OpenResult> {
    this.#assertAdmitting("open");
    return this.#withLifecycle(command.sessionId, async () => {
      this.#assertAdmitting("open");
      const existing = this.#sessions.get(command.sessionId);
      const policy = normalizeOpenPolicy(command.payload);
      const policyKey = canonicalJson(policy);

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
          return { created: false, session: snapshot(existing) };
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
        ...policy,
      };

      let adapter: SessionAdapter;
      try {
        adapter = await this.#factory.open(request);
      } catch (error) {
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
        adapter,
        sequence: 0,
        pendingTurns: 0,
        turnTail: Promise.resolve(),
      };
      this.#sessions.set(command.sessionId, slot);
      this.#emit(slot, "opened", command.requestId, { state: slot.state });
      return { created: true, session: snapshot(slot) };
    });
  }

  wake(command: Extract<ProtocolCommand, { operation: "wake" }>): Promise<WakeResult> {
    this.#assertAdmitting("wake");
    const slot = this.#requireSession(command.sessionId, command.generation);
    if (slot.state === "failed") {
      throw new MultiplexerError("session_failed", "logical session is failed", {
        details: { lastErrorCode: slot.lastErrorCode },
      });
    }
    // One pending turn is the active slot; the configured depth bounds waiters.
    if (slot.pendingTurns >= this.limits.maxSessionQueueDepth + 1) {
      throw new MultiplexerError("session_queue_full", "logical session turn queue is full", {
        retryable: true,
        details: { maxSessionQueueDepth: this.limits.maxSessionQueueDepth },
      });
    }

    const wasEmpty = slot.pendingTurns === 0;
    const abort = new AbortController();
    slot.pendingTurns += 1;
    if (wasEmpty) {
      // Install cancellation before the promise microtask starts so an abort
      // received immediately after promptAccepted still cancels this turn.
      slot.activeAbort = abort;
      slot.activeRequestId = command.requestId;
    }
    this.#emit(slot, "promptAccepted", command.requestId, {
      idempotencyKey: command.idempotencyKey,
      queuedTurns: Math.max(0, slot.pendingTurns - 1),
    });

    const task = slot.turnTail.then(async () => this.#runWake(slot, command, abort));
    slot.turnTail = task.then(
      () => undefined,
      () => undefined,
    );
    return task.finally(() => {
      slot.pendingTurns -= 1;
    });
  }

  async steer(command: Extract<ProtocolCommand, { operation: "steer" }>): Promise<void> {
    const slot = this.#requireRunningSession(command.sessionId, command.generation);
    if (slot.adapter.steer === undefined) {
      throw new MultiplexerError("unsupported_operation", "session adapter does not support steer");
    }
    await slot.adapter.steer(command.payload.message);
  }

  async followUp(command: Extract<ProtocolCommand, { operation: "followUp" }>): Promise<void> {
    const slot = this.#requireRunningSession(command.sessionId, command.generation);
    if (slot.adapter.followUp === undefined) {
      throw new MultiplexerError("unsupported_operation", "session adapter does not support followUp");
    }
    await slot.adapter.followUp(command.payload.message);
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
      if (slot === undefined) return false;
      this.#assertGeneration(slot, command.generation);
      if (slot.pendingTurns > 0 || slot.state === "running") {
        throw new MultiplexerError("session_busy", "cannot close a session with pending turns", {
          retryable: true,
        });
      }
      slot.state = "closing";
      await slot.adapter.dispose();
      this.#emit(slot, "sessionClosed", command.requestId, {
        retainSession: command.payload.retainSession ?? true,
      });
      this.#sessions.delete(command.sessionId);
      return true;
    });
  }

  status(sessionId?: string): HostSnapshot | SessionSnapshot {
    if (sessionId !== undefined) {
      const slot = this.#sessions.get(sessionId);
      if (slot === undefined) {
        throw new MultiplexerError("session_not_found", "logical session is not open");
      }
      return snapshot(slot);
    }
    return {
      hostInstanceId: this.hostInstanceId,
      draining: this.#draining,
      limits: { ...this.limits },
      activeTurns: this.#turns.active,
      queuedTurns: this.#turns.queued,
      sessions: [...this.#sessions.values()]
        .sort((a, b) => a.sessionId.localeCompare(b.sessionId))
        .map(snapshot),
    };
  }

  /** Stop admitting open/wake requests. Bounded turn draining lands in PD-008. */
  beginDrain(): void {
    if (this.#draining) return;
    this.#draining = true;
    for (const slot of this.#sessions.values()) {
      this.#emit(slot, "hostDraining", undefined, {});
    }
  }

  async dispose(): Promise<void> {
    this.beginDrain();
    const slots = [...this.#sessions.values()];
    for (const slot of slots) slot.activeAbort?.abort();
    await Promise.allSettled(slots.map(async (slot) => slot.turnTail));
    await Promise.allSettled(slots.map(async (slot) => slot.adapter.dispose()));
    this.#sessions.clear();
  }

  async #runWake(
    slot: SessionSlot,
    command: Extract<ProtocolCommand, { operation: "wake" }>,
    abort: AbortController,
  ): Promise<WakeResult> {
    if (this.#sessions.get(slot.sessionId) !== slot || slot.generation !== command.generation) {
      throw new MultiplexerError("stale_generation", "session changed before queued turn started");
    }
    let release: (() => void) | undefined;
    slot.activeAbort = abort;
    slot.activeRequestId = command.requestId;
    try {
      release = await this.#turns.acquire(abort.signal);
      slot.state = "running";
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
      slot.state = "idle";
      delete slot.lastErrorCode;
      this.#emit(slot, "agentEnd", command.requestId, {});
      this.#emit(slot, "sessionIdle", command.requestId, {});
      return { result, session: snapshot(slot) };
    } catch (error) {
      const normalized = asMultiplexerError(error, "turn_failed", "logical session turn failed");
      slot.state = normalized.code === "aborted" ? "idle" : "failed";
      slot.lastErrorCode = normalized.code;
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

  #requireSession(sessionId: string, generation: number): SessionSlot {
    const slot = this.#sessions.get(sessionId);
    if (slot === undefined) {
      throw new MultiplexerError("session_not_found", "logical session is not open");
    }
    this.#assertGeneration(slot, generation);
    return slot;
  }

  #requireRunningSession(sessionId: string, generation: number): SessionSlot {
    const slot = this.#requireSession(sessionId, generation);
    if (slot.state !== "running") {
      throw new MultiplexerError("session_not_running", "logical session has no active turn", {
        retryable: true,
      });
    }
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

function snapshot(slot: SessionSlot): SessionSnapshot {
  const result: SessionSnapshot = {
    sessionId: slot.sessionId,
    generation: slot.generation,
    state: slot.state,
    sequence: slot.sequence,
    queuedTurns: Math.max(0, slot.pendingTurns - (slot.state === "running" ? 1 : 0)),
  };
  if (slot.activeRequestId !== undefined) result.activeRequestId = slot.activeRequestId;
  if (slot.lastErrorCode !== undefined) result.lastErrorCode = slot.lastErrorCode;
  return result;
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
  if (isAbortError(error)) {
    return new MultiplexerError("aborted", "logical session turn was aborted", { retryable: true });
  }
  return new MultiplexerError(code, message, {
    details: { cause: safeError(error) },
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
