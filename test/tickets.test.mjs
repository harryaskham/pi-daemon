import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  FileMutationTicketStore,
  MutationTicketController,
  TicketStoreError,
  mutationTicketResource,
} from "../dist/tickets.js";

const roots = [];
const temporaryState = async () => {
  const path = await mkdtemp(join(tmpdir(), "pi-daemon-tickets-"));
  roots.push(path);
  return path;
};

test.after(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const spec = (cwd = "/work/a", overrides = {}) => ({
  cwd,
  target: { mode: "new" },
  isolation: { mode: "unisolated" },
  ...overrides,
});

const createInput = (key = "create-key", overrides = {}) => ({
  method: "POST",
  canonicalTarget: "/v1/session",
  idempotencyKey: key,
  command: {
    operation: "create",
    requestId: `request-${key}`,
    sessionId: `session-${key}`,
    generation: 1,
    spec: spec(),
    environmentSummary: {
      keys: [],
      persistence: "memory-only",
      provisioned: true,
    },
  },
  ...overrides,
});

const waitFor = async (predicate, message = "condition") => {
  const deadline = Date.now() + 2_000;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${message}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
};

test("mutation tickets durably deduplicate, execute once, and retain safe terminal results", async () => {
  const stateDir = await temporaryState();
  const store = new FileMutationTicketStore({ stateDir });
  let executions = 0;
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const controller = new MutationTicketController(store);
  await controller.recover(async (command) => {
    executions += 1;
    await gate;
    return { sessionId: command.sessionId, created: true };
  });

  const admitted = await controller.submit(createInput());
  assert.equal(admitted.state, "queued");
  assert.match(admitted.ticketId, /^ticket-[A-Za-z0-9_-]{43}$/);
  const duplicate = await controller.submit({
    ...createInput(),
    command: { ...createInput().command, requestId: "retry-request" },
  });
  assert.equal(duplicate.ticketId, admitted.ticketId);
  await waitFor(async () => (await controller.get(admitted.ticketId))?.state === "running");
  assert.equal(executions, 1);

  release();
  const terminal = await controller.wait(admitted.ticketId);
  assert.equal(terminal.state, "succeeded");
  assert.deepEqual(terminal.result, {
    sessionId: createInput().command.sessionId,
    created: true,
  });
  assert.equal(executions, 1);
  const resource = mutationTicketResource(terminal);
  assert.equal(resource.operation, "create");
  assert.equal(resource.links.session, "/v1/session/session-create-key");

  const persisted = await readFile(join(stateDir, "tickets", `${terminal.ticketId}.json`), "utf8");
  assert.equal(persisted.includes("PROVIDER_TOKEN"), false);
  assert.equal(persisted.includes("secret-value"), false);

  await assert.rejects(
    controller.submit(
      createInput("create-key", {
        command: { ...createInput().command, spec: spec("/different") },
      }),
    ),
    (error) => error instanceof TicketStoreError && error.code === "idempotency_conflict",
  );
});

test("legacy mutation tickets migrate to an empty provisioned environment summary", async () => {
  const stateDir = await temporaryState();
  const first = new FileMutationTicketStore({ stateDir });
  await first.recover();
  const ticket = await first.begin(createInput("legacy-environment"));
  const path = join(stateDir, "tickets", `${ticket.ticketId}.json`);
  const persisted = JSON.parse(await readFile(path, "utf8"));
  delete persisted.command.environmentSummary;
  persisted.fingerprint = "legacy-fingerprint";
  await writeFile(path, `${JSON.stringify(persisted)}\n`, { mode: 0o600 });

  const restarted = new FileMutationTicketStore({ stateDir });
  const recovery = await restarted.recover();
  assert.equal(recovery.queued.length, 1);
  assert.deepEqual(recovery.queued[0].command.environmentSummary, {
    keys: [],
    persistence: "memory-only",
    provisioned: true,
  });
});

test("restart replays queued tickets, makes running tickets indeterminate, and permits explicit reconciliation", async () => {
  const stateDir = await temporaryState();
  const first = new FileMutationTicketStore({ stateDir });
  await first.recover();
  const queued = await first.begin(createInput("queued"));
  const running = await first.begin(createInput("running"));
  await first.markRunning(running.ticketId);

  const replayed = [];
  const restarted = new FileMutationTicketStore({ stateDir });
  const controller = new MutationTicketController(restarted);
  const recovery = await controller.recover(async (command) => {
    replayed.push(command.sessionId);
    return { replayed: true };
  });
  assert.deepEqual(recovery.queued.map((record) => record.ticketId), [queued.ticketId]);
  assert.deepEqual(recovery.indeterminate.map((record) => record.ticketId), [running.ticketId]);
  assert.equal((await controller.get(running.ticketId)).state, "indeterminate");

  const replayTerminal = await controller.wait(queued.ticketId);
  assert.equal(replayTerminal.state, "succeeded");
  assert.deepEqual(replayed, [queued.sessionId]);

  const reconciled = await controller.reconcile(running.ticketId, {
    state: "failed",
    error: {
      code: "not_observed_in_pi_entries",
      message: "mutation was not observed in retained Pi entries",
      retryable: false,
    },
  });
  assert.equal(reconciled.state, "failed");
  await assert.rejects(
    controller.reconcile(running.ticketId, { state: "succeeded", result: {} }),
    (error) => error instanceof TicketStoreError && error.code === "ticket_not_indeterminate",
  );
});

test("ticket records enforce count, byte, and terminal age retention bounds", async () => {
  const stateDir = await temporaryState();
  let now = new Date("2026-07-14T10:00:00.000Z");
  const store = new FileMutationTicketStore({
    stateDir,
    maxTickets: 1,
    maxRecordBytes: 4096,
    retentionMs: 1_000,
    now: () => now,
  });
  await store.recover();
  const first = await store.begin(createInput("one"));
  await store.markFailed(first.ticketId, {
    code: "fixture_failure",
    message: "fixture failure",
    retryable: false,
  });
  await assert.rejects(
    store.begin(createInput("two")),
    (error) => error instanceof TicketStoreError && error.code === "ticket_capacity",
  );
  now = new Date("2026-07-14T10:00:02.000Z");
  const second = await store.begin(createInput("two"));
  assert.equal(second.state, "queued");
  assert.equal(await store.get(first.ticketId), undefined);
  await assert.rejects(
    new FileMutationTicketStore({
      stateDir,
      maxRecoveryBytes: 128,
    }).recover(),
    (error) =>
      error instanceof TicketStoreError &&
      error.code === "ticket_recovery_too_large",
  );

  const bounded = new FileMutationTicketStore({
    stateDir: await temporaryState(),
    maxRecordBytes: 1024,
  });
  await bounded.recover();
  await assert.rejects(
    bounded.begin(
      createInput("raw-env", {
        command: {
          ...createInput("raw-env").command,
          spec: { ...spec(), env: { PROVIDER_TOKEN: "must-not-persist" } },
        },
      }),
    ),
    (error) =>
      error instanceof TicketStoreError && error.code === "invalid_ticket_command",
  );
  await assert.rejects(
    bounded.begin(
      createInput("oversized", {
        command: {
          ...createInput("oversized").command,
          spec: spec("/large", { resources: { systemPrompt: "x".repeat(2048) } }),
        },
      }),
    ),
    (error) => error instanceof TicketStoreError && error.code === "ticket_record_too_large",
  );
});
