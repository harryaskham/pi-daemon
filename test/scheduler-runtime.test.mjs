import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { FileScheduleStore } from "../dist/schedule-store.js";
import { SchedulerRuntime, nextCronOccurrence } from "../dist/scheduler-runtime.js";

class FakeClock {
  now;
  monotonic = 0;
  nextId = 1;
  timers = new Map();
  constructor(instant) { this.now = Date.parse(instant); }
  wallNow = () => this.now;
  monotonicNow = () => this.monotonic;
  setTimer = (callback, delay) => {
    const id = this.nextId++;
    this.timers.set(id, { at: this.monotonic + delay, callback });
    return id;
  };
  clearTimer = (id) => { this.timers.delete(id); };
  async advance(ms, wallMs = ms) {
    const target = this.monotonic + ms;
    this.now += wallMs;
    while (true) {
      const due = [...this.timers.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (due === undefined) break;
      this.monotonic = due[1].at;
      this.timers.delete(due[0]);
      due[1].callback();
      await settle();
    }
    this.monotonic = target;
    await settle();
  }
}

const settle = async () => {
  for (let count = 0; count < 12; count += 1) await new Promise((resolve) => setImmediate(resolve));
};

async function fixture(t, instant = "2026-07-20T08:59:00.000Z") {
  const root = await mkdtemp(join(tmpdir(), "pi-daemon-scheduler-runtime-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const clock = new FakeClock(instant);
  const store = new FileScheduleStore({ stateDir: join(root, "state"), now: () => new Date(clock.wallNow()) });
  return { clock, store };
}

function definition(overrides = {}) {
  return {
    scheduleId: "schedule-01",
    sessionRef: "session-01",
    enabled: true,
    cron: "0 9 * * *",
    timezone: "UTC",
    prompt: "private scheduled prompt",
    overlapPolicy: "skip",
    missedWakePolicy: { mode: "run-once" },
    jitterMs: 0,
    maxAdmissionDelayMs: 60_000,
    ...overrides,
  };
}

function gateway(options = {}) {
  const admissions = [];
  let running = options.running ?? false;
  let sequence = 0;
  return {
    admissions,
    setRunning(value) { running = value; },
    async resolveSession() { return { sessionId: "session-01", generation: 3, state: running ? "running" : "idle" }; },
    async admit(request) {
      await options.beforeAdmit?.(request);
      admissions.push(request);
      sequence += 1;
      const ticket = { ticketId: `wake-${sequence}`, state: options.initialState ?? "queued", updatedAt: new Date().toISOString() };
      return { ticket, completion: options.completion?.(ticket) ?? Promise.resolve({ ...ticket, state: "succeeded" }) };
    },
  };
}

test("fake clock fires once, persists before admission, and retains terminal ticket truth", async (t) => {
  const { clock, store } = await fixture(t);
  await store.create(definition());
  let preAdmission;
  const admission = gateway({ beforeAdmit: async () => { preAdmission = await store.get("schedule-01"); } });
  const runtime = new SchedulerRuntime({ store, gateway: admission, clock });
  await runtime.start();
  assert.equal((await store.get("schedule-01")).nextTriggerAt, "2026-07-20T09:00:00.000Z");
  await clock.advance(60_000);
  await runtime.reload();
  assert.equal(admission.admissions.length, 1);
  assert.equal(preAdmission.lastTrigger.disposition, "rejected");
  assert.equal(preAdmission.nextTriggerAt, "2026-07-21T09:00:00.000Z");
  await settle();
  const resource = await store.get("schedule-01");
  assert.equal(resource.lastTrigger.disposition, "admitted");
  assert.equal(resource.lastTrigger.terminalTicket.state, "completed");
  assert.equal(runtime.status().activeAdmissions, 0);
  runtime.stop();
});

test("crash window advances durably and restart never replays possibly accepted work", async (t) => {
  const { clock, store } = await fixture(t, "2026-07-20T09:00:00.000Z");
  await store.create(definition({ nextTriggerAt: "2026-07-20T09:00:00.000Z" }));
  const admission = gateway({ beforeAdmit: async () => { throw new Error("simulated crash before admission response"); } });
  const first = new SchedulerRuntime({ store, gateway: admission, clock });
  await first.start();
  assert.equal((await store.get("schedule-01")).nextTriggerAt, "2026-07-21T09:00:00.000Z");
  first.stop();

  const restartedAdmission = gateway();
  const restarted = new SchedulerRuntime({ store: new FileScheduleStore({ stateDir: store.schedulesDir.replace(/\/schedules\/v1$/u, ""), now: () => new Date(clock.wallNow()) }), gateway: restartedAdmission, clock });
  await restarted.start();
  assert.equal(restartedAdmission.admissions.length, 0);
  restarted.stop();
});

test("overlap policies are bounded and queue-one coalesces to one deferred admission", async (t) => {
  const { clock, store } = await fixture(t, "2026-07-20T09:00:00.000Z");
  await store.create(definition({ cron: "* * * * *", nextTriggerAt: "2026-07-20T09:00:00.000Z", overlapPolicy: "queue-one" }));
  let resolveCompletion;
  const admission = gateway({ completion: (ticket) => new Promise((resolve) => { resolveCompletion = () => resolve({ ...ticket, state: "succeeded" }); }) });
  const runtime = new SchedulerRuntime({ store, gateway: admission, clock });
  await runtime.start();
  assert.equal(admission.admissions.length, 1);
  admission.setRunning(true);
  await clock.advance(3 * 60_000);
  await runtime.reload();
  assert.equal(runtime.status().queuedOverlaps, 1);
  assert.equal(admission.admissions.length, 1);
  admission.setRunning(false);
  resolveCompletion();
  await settle();
  await runtime.reload();
  assert.equal(admission.admissions.length, 2);
  assert.equal(runtime.status().queuedOverlaps, 0);
  await runtime.drain(100);
});

test("missed-wake catch-up is oldest-first and globally bounded", async (t) => {
  const { clock, store } = await fixture(t, "2026-07-20T12:00:00.000Z");
  await store.create(definition({ cron: "* * * * *", nextTriggerAt: "2026-07-20T09:00:00.000Z", missedWakePolicy: { mode: "bounded-catch-up", maxRuns: 3 }, maxAdmissionDelayMs: 1 }));
  const admission = gateway({ initialState: "succeeded" });
  const runtime = new SchedulerRuntime({ store, gateway: admission, clock });
  await runtime.start();
  assert.deepEqual(admission.admissions.map((value) => value.scheduledFor), [
    "2026-07-20T09:00:00.000Z",
    "2026-07-20T09:01:00.000Z",
    "2026-07-20T09:02:00.000Z",
  ]);
  assert.equal((await store.get("schedule-01")).nextTriggerAt, "2026-07-20T12:01:00.000Z");
  runtime.stop();
});

test("cron search handles DST gaps and repeated civil minutes", () => {
  const spring = nextCronOccurrence("30 1 * * *", "Europe/London", Date.parse("2026-03-28T02:00:00.000Z"));
  assert.equal(new Date(spring).toISOString(), "2026-03-30T00:30:00.000Z");
  const first = nextCronOccurrence("30 1 * * *", "Europe/London", Date.parse("2026-10-24T02:00:00.000Z"));
  const second = nextCronOccurrence("30 1 * * *", "Europe/London", first);
  assert.equal(new Date(first).toISOString(), "2026-10-25T00:30:00.000Z");
  assert.equal(new Date(second).toISOString(), "2026-10-25T01:30:00.000Z");
});

test("long fake-clock soak keeps timers, overlap state and retained memory bounded", async (t) => {
  const { clock, store } = await fixture(t, "2026-07-20T00:00:30.000Z");
  await store.create(definition({ cron: "* * * * *", jitterMs: 0 }));
  const admission = gateway();
  const runtime = new SchedulerRuntime({ store, gateway: admission, clock });
  await runtime.start();
  for (let minute = 0; minute < 200; minute += 1) {
    await clock.advance(60_000);
    await runtime.reload();
  }
  assert.ok(admission.admissions.length >= 199 && admission.admissions.length <= 200);
  assert.ok(clock.timers.size <= 1);
  assert.equal(runtime.status().activeAdmissions, 0);
  assert.equal(runtime.status().queuedOverlaps, 0);
  assert.equal((await store.list()).length, 1);
  runtime.stop();
});
