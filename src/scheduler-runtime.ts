import { createHash } from "node:crypto";

import type { Multiplexer } from "./multiplexer.js";
import { type ScheduleExecutionOverride, type ScheduleLastTrigger, type ScheduleResource, type ScheduleTerminalTicketSummary } from "./schedule-contract.js";
import { PROTOCOL_VERSION } from "./protocol.js";
import { FileScheduleStore, ScheduleStoreError } from "./schedule-store.js";
import type { TicketResource } from "./session-api.js";
import { ensureSessionResident } from "./session-residency.js";

const MAX_CRON_SEARCH_MINUTES = 5 * 366 * 24 * 60;
const CLOCK_RECHECK_MS = 60_000;

export interface SchedulerClock {
  wallNow(): number;
  monotonicNow(): number;
  setTimer(callback: () => void | Promise<void>, delayMs: number): unknown;
  clearTimer(handle: unknown): void;
}

export interface SchedulerSession {
  sessionId: string;
  generation: number;
  state: "opening" | "idle" | "running" | "failed" | "closing" | "dormant";
}

export type SchedulerTicketState = "queued" | "running" | "succeeded" | "failed" | "indeterminate";

export interface SchedulerTicket {
  ticketId: string;
  state: SchedulerTicketState;
  updatedAt: string;
  errorCode?: string;
}

export interface SchedulerAdmission {
  ticket: SchedulerTicket;
  completion: Promise<SchedulerTicket>;
}

export interface SchedulerAdmissionRequest {
  scheduleId: string;
  scheduledFor: string;
  sessionId: string;
  generation: number;
  requestId: string;
  idempotencyKey: string;
  prompt: string;
  execution?: ScheduleExecutionOverride;
  signal: AbortSignal;
}

/** Runtime-neutral seam around durable prompt-ticket admission. */
export interface SchedulerAdmissionGateway {
  resolveSession(sessionRef: string): Promise<SchedulerSession | undefined>;
  admit(request: SchedulerAdmissionRequest): Promise<SchedulerAdmission>;
  isDraining?(): boolean;
}

export interface SchedulerRuntimeStatus {
  running: boolean;
  draining: boolean;
  activeAdmissions: number;
  queuedOverlaps: number;
  nextWakeAt?: string;
}

/** Content-free controller projection; prompts never cross status surfaces. */
export interface SchedulerScheduleStatus {
  scheduleId: string;
  sessionRef: string;
  enabled: boolean;
  revision: number;
  nextTriggerAt?: string;
  lastTrigger?: ScheduleLastTrigger;
}

interface PendingOverlap {
  scheduleId: string;
  scheduledFor: number;
}

/**
 * Bounded durable cron loop. Every occurrence decision is committed before
 * calling admission; therefore a crash can lose an unaccepted occurrence but
 * can never blindly replay work that might already have been accepted.
 */
export class SchedulerRuntime {
  readonly #store: FileScheduleStore;
  readonly #gateway: SchedulerAdmissionGateway;
  readonly #clock: SchedulerClock;
  readonly #activeBySession = new Map<string, Set<string>>();
  readonly #pendingOverlaps = new Map<string, PendingOverlap>();
  readonly #abort = new AbortController();
  #timer: unknown;
  #running = false;
  #draining = false;
  #nextWakeAt: number | undefined;
  #tail: Promise<void> = Promise.resolve();
  #settlements = new Set<Promise<void>>();

  constructor(options: { store: FileScheduleStore; gateway: SchedulerAdmissionGateway; clock?: SchedulerClock }) {
    this.#store = options.store;
    this.#gateway = options.gateway;
    this.#clock = options.clock ?? systemSchedulerClock;
  }

  async start(): Promise<void> {
    if (this.#running) return;
    if (this.#draining) throw new Error("scheduler is draining");
    await this.#store.recover();
    this.#running = true;
    await this.recompute();
  }

  /** Stop timer admission without cancelling already admitted work. */
  stop(): void {
    this.#running = false;
    this.#clearTimer();
  }

  /** Call after schedule CRUD or an observed wall-clock/timezone change. */
  recompute(): Promise<void> {
    return this.#serialize(async () => {
      if (!this.#running || this.#draining) return;
      await this.#normalizeSchedules();
      await this.#runDue();
      await this.#arm();
    });
  }

  reload(): Promise<void> {
    return this.recompute();
  }

  notifyClockChange(): Promise<void> {
    return this.recompute();
  }

  /** Flush current settlements and serialized work they causally enqueue. */
  async settle(): Promise<void> {
    const settlements = [...this.#settlements];
    let tail = this.#tail;
    await Promise.allSettled([tail, ...settlements]);
    while (tail !== this.#tail) {
      tail = this.#tail;
      await Promise.allSettled([tail]);
    }
  }

  async schedules(): Promise<SchedulerScheduleStatus[]> {
    return (await this.#store.list()).map((schedule) => ({
      scheduleId: schedule.scheduleId,
      sessionRef: schedule.sessionRef,
      enabled: schedule.enabled,
      revision: schedule.revision,
      ...(schedule.nextTriggerAt === undefined ? {} : { nextTriggerAt: schedule.nextTriggerAt }),
      ...(schedule.lastTrigger === undefined ? {} : { lastTrigger: structuredClone(schedule.lastTrigger) }),
    }));
  }

  beginDrain(): void {
    this.#draining = true;
    this.#running = false;
    this.#abort.abort();
    this.#pendingOverlaps.clear();
    this.#clearTimer();
  }

  async drain(timeoutMs = 30_000): Promise<{ timedOut: boolean }> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0) throw new RangeError("timeoutMs must be a non-negative safe integer");
    this.beginDrain();
    const work = Promise.allSettled([this.#tail, ...this.#settlements]);
    if (timeoutMs === 0) return { timedOut: this.#settlements.size > 0 };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = await Promise.race([
      work.then(() => false),
      new Promise<true>((resolve) => { timer = setTimeout(() => resolve(true), timeoutMs); }),
    ]);
    if (timer !== undefined) clearTimeout(timer);
    return { timedOut };
  }

  status(): SchedulerRuntimeStatus {
    return {
      running: this.#running,
      draining: this.#draining,
      activeAdmissions: [...this.#activeBySession.values()].reduce((sum, value) => sum + value.size, 0),
      queuedOverlaps: this.#pendingOverlaps.size,
      ...(this.#nextWakeAt === undefined ? {} : { nextWakeAt: new Date(this.#nextWakeAt).toISOString() }),
    };
  }

  async #normalizeSchedules(): Promise<void> {
    const now = this.#clock.wallNow();
    for (const schedule of await this.#store.list()) {
      if (!schedule.enabled) {
        if (schedule.nextTriggerAt !== undefined) await this.#persist(schedule, undefined, schedule.lastTrigger);
        continue;
      }
      const persisted = schedule.nextTriggerAt === undefined ? undefined : Date.parse(schedule.nextTriggerAt);
      // Retain stale instants for missed-wake policy, but recompute all future
      // instants so wall-clock and timezone database changes take effect.
      if (persisted === undefined || persisted > now) {
        // A backward wall-clock correction must not select an instant already
        // decided before the jump. The durable trigger instant is the lower
        // bound across restart as well as within this process.
        const last = schedule.lastTrigger === undefined
          ? undefined
          : Date.parse(schedule.lastTrigger.scheduledFor);
        const boundary = last === undefined ? now : Math.max(now, last);
        const next = nextCronOccurrence(schedule.cron, schedule.timezone, boundary);
        if (schedule.nextTriggerAt !== new Date(next).toISOString()) {
          await this.#persist(schedule, next, schedule.lastTrigger);
        }
      }
    }
  }

  async #runDue(): Promise<void> {
    const now = this.#clock.wallNow();
    for (const original of await this.#store.list()) {
      if (!original.enabled || original.nextTriggerAt === undefined) continue;
      const first = Date.parse(original.nextTriggerAt);
      if (first > now) continue;
      const jittered = first + stableJitter(original.scheduleId, original.nextTriggerAt, original.jitterMs);
      if (jittered > now) continue;
      const selected = this.#selectDue(original, first, now);
      let current: ScheduleResource | undefined = original;
      for (const scheduledFor of selected.run) {
        current = await this.#decideAndAdmit(current, scheduledFor, now);
        if (current === undefined) break;
      }
      if (current === undefined) continue;
      const next = nextCronOccurrence(current.cron, current.timezone, now);
      if (current.nextTriggerAt !== new Date(next).toISOString()) {
        await this.#persist(current, next, current.lastTrigger);
      }
    }
  }

  #selectDue(schedule: ScheduleResource, first: number, now: number): { run: number[] } {
    const delay = now - first;
    if (delay <= schedule.maxAdmissionDelayMs) return { run: [first] };
    if (schedule.missedWakePolicy.mode === "skip") return { run: [] };
    if (schedule.missedWakePolicy.mode === "run-once") {
      return { run: [previousCronOccurrence(schedule.cron, schedule.timezone, now + 60_000)] };
    }
    const run: number[] = [];
    let occurrence = first;
    while (occurrence <= now && run.length < schedule.missedWakePolicy.maxRuns) {
      run.push(occurrence);
      occurrence = nextCronOccurrence(schedule.cron, schedule.timezone, occurrence);
    }
    return { run };
  }

  async #decideAndAdmit(schedule: ScheduleResource, scheduledFor: number, observedAt: number): Promise<ScheduleResource | undefined> {
    const scheduled = new Date(scheduledFor).toISOString();
    const next = nextCronOccurrence(schedule.cron, schedule.timezone, scheduledFor);
    // "rejected" is the conservative pre-admission truth. It is persisted
    // before any call capable of accepting model work.
    let current = await this.#persist(schedule, next, trigger(scheduled, observedAt, "rejected"));
    if (current === undefined || this.#draining || this.#gateway.isDraining?.()) return current;

    const session = await this.#gateway.resolveSession(current.sessionRef);
    if (session === undefined || session.state === "failed" || session.state === "closing" || session.state === "dormant") return current;
    const active = session.state === "running" || (this.#activeBySession.get(session.sessionId)?.size ?? 0) > 0;
    if (active) {
      if (current.overlapPolicy === "skip") return this.#persist(current, next, trigger(scheduled, observedAt, "skipped"));
      if (current.overlapPolicy === "queue-one") {
        this.#pendingOverlaps.set(current.scheduleId, { scheduleId: current.scheduleId, scheduledFor });
        return this.#persist(current, next, trigger(scheduled, observedAt, "skipped"));
      }
      return current;
    }

    const identity = scheduleAdmissionIdentity(current.scheduleId, scheduled);
    try {
      const admission = await this.#gateway.admit({
        scheduleId: current.scheduleId,
        scheduledFor: scheduled,
        sessionId: session.sessionId,
        generation: session.generation,
        requestId: `scheduler-${identity.slice(0, 32)}`,
        idempotencyKey: `schedule-${identity}`,
        prompt: current.prompt,
        ...(current.execution === undefined ? {} : { execution: current.execution }),
        signal: this.#abort.signal,
      });
      current = await this.#persist(current, next, trigger(scheduled, observedAt, "admitted"));
      if (current === undefined) return undefined;
      this.#trackAdmission(current, session.sessionId, scheduled, admission);
      return current;
    } catch {
      return current;
    }
  }

  #trackAdmission(schedule: ScheduleResource, sessionId: string, scheduledFor: string, admission: SchedulerAdmission): void {
    if (admission.ticket.state === "succeeded" || admission.ticket.state === "failed" || admission.ticket.state === "indeterminate") {
      const settlement = this.#recordTerminal(schedule.scheduleId, scheduledFor, admission.ticket).finally(() => this.#settlements.delete(settlement));
      this.#settlements.add(settlement);
      void settlement.catch(() => {});
      return;
    }
    const active = this.#activeBySession.get(sessionId) ?? new Set<string>();
    active.add(admission.ticket.ticketId);
    this.#activeBySession.set(sessionId, active);
    const settlement = admission.completion.then(async (ticket) => {
      await this.#recordTerminal(schedule.scheduleId, scheduledFor, ticket);
    }, async () => {
      // Admission implementations must retain the actual ticket state. A
      // rejected completion alone is not evidence that accepted work failed.
    }).finally(async () => {
      active.delete(admission.ticket.ticketId);
      if (active.size === 0) this.#activeBySession.delete(sessionId);
      this.#settlements.delete(settlement);
      const pending = this.#pendingOverlaps.get(schedule.scheduleId);
      if (pending !== undefined && !this.#draining) {
        this.#pendingOverlaps.delete(schedule.scheduleId);
        await this.#serialize(async () => {
          const latest = await this.#store.get(pending.scheduleId);
          if (latest?.enabled) await this.#decideAndAdmit(latest, pending.scheduledFor, this.#clock.wallNow());
          await this.#arm();
        });
      }
    });
    this.#settlements.add(settlement);
    void settlement.catch(() => {});
  }

  async #recordTerminal(scheduleId: string, scheduledFor: string, ticket: SchedulerTicket): Promise<void> {
    if (ticket.state !== "succeeded" && ticket.state !== "failed" && ticket.state !== "indeterminate") return;
    const current = await this.#store.get(scheduleId);
    if (current?.lastTrigger?.scheduledFor !== scheduledFor || current.lastTrigger.disposition !== "admitted") return;
    const terminal: ScheduleTerminalTicketSummary = {
      ticketId: ticket.ticketId,
      state: ticket.state === "succeeded" ? "completed" : ticket.state,
      updatedAt: ticket.updatedAt,
      ...(ticket.errorCode === undefined ? {} : { errorCode: ticket.errorCode }),
    };
    await this.#persist(current, current.nextTriggerAt === undefined ? undefined : Date.parse(current.nextTriggerAt), { ...current.lastTrigger, terminalTicket: terminal });
  }

  async #persist(schedule: ScheduleResource, next: number | undefined, last: ScheduleLastTrigger | undefined): Promise<ScheduleResource | undefined> {
    try {
      return await this.#store.updateRuntimeState(schedule.scheduleId, schedule.revision, {
        ...(next === undefined ? {} : { nextTriggerAt: new Date(next).toISOString() }),
        ...(last === undefined ? {} : { lastTrigger: last }),
      });
    } catch (error) {
      if (error instanceof ScheduleStoreError && (error.code === "revision_conflict" || error.code === "not_found")) return this.#store.get(schedule.scheduleId);
      throw error;
    }
  }

  async #arm(): Promise<void> {
    this.#clearTimer();
    if (!this.#running || this.#draining) return;
    const now = this.#clock.wallNow();
    const nextFireHeap: number[] = [];
    for (const schedule of await this.#store.list()) {
      if (!schedule.enabled || schedule.nextTriggerAt === undefined) continue;
      const selected = Date.parse(schedule.nextTriggerAt);
      heapPush(nextFireHeap, selected + stableJitter(schedule.scheduleId, schedule.nextTriggerAt, schedule.jitterMs));
    }
    const target = nextFireHeap[0];
    if (target === undefined) return;
    this.#nextWakeAt = target;
    const delay = Math.max(0, Math.min(CLOCK_RECHECK_MS, target - now));
    const anchor = this.#clock.monotonicNow();
    this.#timer = this.#clock.setTimer(() => {
      this.#timer = undefined;
      // The monotonic timer is only a wakeup hint; cron selection always uses
      // fresh wall time, preventing elapsed monotonic time from inventing work.
      void anchor;
      return this.recompute().catch(() => {});
    }, delay);
  }

  #clearTimer(): void {
    if (this.#timer !== undefined) this.#clock.clearTimer(this.#timer);
    this.#timer = undefined;
    this.#nextWakeAt = undefined;
  }

  #serialize(operation: () => Promise<void>): Promise<void> {
    const result = this.#tail.then(operation, operation);
    this.#tail = result.catch(() => {});
    return result;
  }
}

export function createMultiplexerSchedulerGateway(multiplexer: Multiplexer): SchedulerAdmissionGateway {
  return {
    isDraining: () => multiplexer.status().draining,
    resolveSession: async (sessionRef) => {
      try {
        const retained = await ensureSessionResident(multiplexer, sessionRef);
        const live = multiplexer.status(retained.sessionId);
        return { sessionId: live.sessionId, generation: live.generation, state: live.state };
      } catch {
        // Deleted sessions and sessions that cannot be safely reprovisioned
        // fail this occurrence closed without stopping the timer loop.
        return undefined;
      }
    },
    admit: async (request) => {
      if (request.execution !== undefined) throw new Error("per-turn execution overrides are not supported by prompt admission");
      const admitted = await multiplexer.submitWake({
        protocolVersion: PROTOCOL_VERSION,
        operation: "wake",
        requestId: request.requestId,
        sessionId: request.sessionId,
        generation: request.generation,
        idempotencyKey: request.idempotencyKey,
        payload: { prompt: request.prompt, source: "scheduler", waitForTerminal: false },
      });
      return {
        ticket: schedulerTicket(admitted.ticket),
        completion: admitted.completion.then(async () => schedulerTicket((await multiplexer.requestTicket(admitted.ticket.ticketId)) ?? admitted.ticket), async () => schedulerTicket((await multiplexer.requestTicket(admitted.ticket.ticketId)) ?? admitted.ticket)),
      };
    },
  };
}

export function nextCronOccurrence(cron: string, timezone: string, afterMs: number): number {
  return seekCron(cron, timezone, afterMs, 1);
}

export function previousCronOccurrence(cron: string, timezone: string, beforeMs: number): number {
  return seekCron(cron, timezone, beforeMs, -1);
}

function seekCron(cron: string, timezone: string, boundaryMs: number, direction: 1 | -1): number {
  if (!Number.isFinite(boundaryMs)) throw new RangeError("cron boundary must be finite");
  const fields = parseCron(cron);
  let cursor = direction === 1 ? Math.floor(boundaryMs / 60_000) * 60_000 + 60_000 : Math.ceil(boundaryMs / 60_000) * 60_000 - 60_000;
  const formatter = new Intl.DateTimeFormat("en-US", { timeZone: timezone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", weekday: "short" });
  for (let scanned = 0; scanned < MAX_CRON_SEARCH_MINUTES; scanned += 1, cursor += direction * 60_000) {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(cursor)).map((part) => [part.type, part.value]));
    const minute = Number(parts.minute), hour = Number(parts.hour), day = Number(parts.day), month = Number(parts.month);
    const dow = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday ?? "");
    const domMatch = fields[2]!.values.has(day), dowMatch = fields[4]!.values.has(dow) || (dow === 0 && fields[4]!.values.has(7));
    const dayMatch = fields[2]!.wildcard || fields[4]!.wildcard ? domMatch && dowMatch : domMatch || dowMatch;
    if (fields[0]!.values.has(minute) && fields[1]!.values.has(hour) && dayMatch && fields[3]!.values.has(month)) return cursor;
  }
  throw new Error("cron occurrence is outside bounded search horizon");
}

function parseCron(cron: string): Array<{ wildcard: boolean; values: Set<number> }> {
  const ranges = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]] as const;
  return cron.trim().split(/ +/u).map((field, index) => {
    const [min, max] = ranges[index]!;
    const values = new Set<number>();
    for (const item of field.split(",")) {
      const [base, stepText] = item.split("/");
      const step = stepText === undefined ? 1 : Number(stepText);
      const [start, end] = base === "*" ? [min, max] : base!.includes("-") ? base!.split("-").map(Number) : [Number(base), Number(base)];
      for (let value = start!; value <= end!; value += step) values.add(value);
    }
    return { wildcard: field.startsWith("*"), values };
  });
}

function heapPush(heap: number[], value: number): void {
  heap.push(value);
  let index = heap.length - 1;
  while (index > 0) {
    const parent = Math.floor((index - 1) / 2);
    if (heap[parent]! <= value) break;
    heap[index] = heap[parent]!;
    index = parent;
  }
  heap[index] = value;
}

function stableJitter(scheduleId: string, instant: string, maximum: number): number {
  if (maximum === 0) return 0;
  const digest = createHash("sha256").update(`${scheduleId}\n${instant}`, "utf8").digest();
  return digest.readUInt32BE(0) % (maximum + 1);
}

function scheduleAdmissionIdentity(scheduleId: string, scheduledFor: string): string {
  return createHash("sha256").update(`${scheduleId}\n${scheduledFor}`, "utf8").digest("base64url").slice(0, 43);
}

function trigger(scheduledFor: string, observedAt: number, disposition: ScheduleLastTrigger["disposition"]): ScheduleLastTrigger {
  return { scheduledFor, observedAt: new Date(observedAt).toISOString(), disposition };
}

function schedulerTicket(ticket: TicketResource): SchedulerTicket {
  return {
    ticketId: ticket.ticketId,
    state: ticket.state,
    updatedAt: ticket.updatedAt,
    ...(ticket.error?.code === undefined ? {} : { errorCode: ticket.error.code }),
  };
}

const systemSchedulerClock: SchedulerClock = {
  wallNow: Date.now,
  monotonicNow: () => performance.now(),
  setTimer: (callback, delayMs) => setTimeout(() => { void callback(); }, delayMs),
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};
