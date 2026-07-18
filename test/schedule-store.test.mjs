import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { FileScheduleStore, ScheduleStoreError } from "../dist/schedule-store.js";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "pi-daemon-schedules-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, stateDir: join(root, "state") };
}

function definition(overrides = {}) {
  return {
    scheduleId: "schedule-01",
    sessionRef: "session-01",
    enabled: true,
    cron: "0 9 * * 1-5",
    timezone: "Europe/London",
    prompt: "Prepare the daily status report.",
    overlapPolicy: "queue-one",
    missedWakePolicy: { mode: "run-once" },
    jitterMs: 1000,
    maxAdmissionDelayMs: 60000,
    nextTriggerAt: "2026-07-20T08:00:00.000Z",
    ...overrides,
  };
}

test("schedule store atomically persists optimistic revisions without running timers", async (t) => {
  const { stateDir } = await fixture(t);
  let now = new Date("2026-07-18T12:00:00.000Z");
  const store = new FileScheduleStore({ stateDir, now: () => now });
  const created = await store.create(definition());
  assert.equal(created.revision, 0);
  assert.equal(created.createdAt, now.toISOString());

  now = new Date("2026-07-18T12:01:00.000Z");
  const updated = await store.update("schedule-01", 0, definition({ enabled: false }));
  assert.equal(updated.revision, 1);
  assert.equal(updated.createdAt, created.createdAt);
  assert.equal(updated.updatedAt, now.toISOString());
  await assert.rejects(store.update("schedule-01", 0, definition()), (error) => error instanceof ScheduleStoreError && error.code === "revision_conflict");

  const path = join(stateDir, "schedules", "v1", "schedule-01.json");
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal((await stat(join(stateDir, "schedules", "v1"))).mode & 0o777, 0o700);
  assert.match(await readFile(path, "utf8"), /Prepare the daily status report/);

  const restarted = new FileScheduleStore({ stateDir });
  assert.deepEqual(await restarted.get("schedule-01"), updated);
  assert.equal((await restarted.recover()).quarantined.length, 0);
  await restarted.delete("schedule-01", 1);
  assert.equal(await restarted.get("schedule-01"), undefined);
});

test("schedule recovery quarantines corrupt records and never recovers unsafe files", async (t) => {
  const { stateDir } = await fixture(t);
  const store = new FileScheduleStore({ stateDir });
  await store.create(definition());
  const directory = store.schedulesDir;
  const path = join(directory, "schedule-01.json");
  await writeFile(path, "{broken", { mode: 0o600 });
  const recoveredStore = new FileScheduleStore({ stateDir });
  const recovery = await recoveredStore.recover();
  assert.equal(recovery.schedules.length, 0);
  assert.equal(recovery.quarantined.length, 1);
  assert.equal((await readdir(directory)).some((name) => name.includes(".corrupt-")), true);

  const unsafePath = join(directory, "schedule-unsafe.json");
  await writeFile(unsafePath, JSON.stringify({}), { mode: 0o600 });
  await chmod(unsafePath, 0o644);
  await assert.rejects(new FileScheduleStore({ stateDir }).recover(), /owner-only/);
  await rm(unsafePath);

  const target = join(directory, "target.json");
  await writeFile(target, "{}", { mode: 0o600 });
  await symlink(target, unsafePath);
  await assert.rejects(new FileScheduleStore({ stateDir }).recover(), /regular file/);
});

test("schedule store enforces global, per-session and recovery bounds", async (t) => {
  const { stateDir } = await fixture(t);
  const store = new FileScheduleStore({ stateDir, limits: { maxSchedules: 2, maxSchedulesPerSession: 1 } });
  await store.create(definition());
  await assert.rejects(store.create(definition({ scheduleId: "schedule-02" })), (error) => error instanceof ScheduleStoreError && error.code === "schedule_capacity");
  await store.create(definition({ scheduleId: "schedule-03", sessionRef: "session-02" }));
  await assert.rejects(store.create(definition({ scheduleId: "schedule-04", sessionRef: "session-03" })), (error) => error instanceof ScheduleStoreError && error.code === "schedule_capacity");

  const bounded = new FileScheduleStore({ stateDir, limits: { maxSchedules: 2, maxSchedulesPerSession: 2, maxRecoveryBytes: 1 } });
  await assert.rejects(bounded.recover(), (error) => error instanceof ScheduleStoreError && error.code === "recovery_limit");
});
