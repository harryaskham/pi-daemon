import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  DashboardSessionDraftService,
  FileDashboardSessionDraftStore,
  dashboardSessionDraftSpecToSessionSpec,
} from "../dist/dashboard-session-drafts.js";
import {
  DashboardSessionDraftMaterializer,
  DashboardSessionDraftMaterializerError,
  MultiplexerDashboardSessionDraftRuntime,
} from "../dist/dashboard-session-materializer.js";
import { FileDurabilityStore } from "../dist/durability.js";
import { Multiplexer, MultiplexerError } from "../dist/multiplexer.js";
import { parseSessionConfiguration } from "../dist/session-config.js";
import { FileSessionCatalog, sessionSpecDigest } from "../dist/session-catalog.js";

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

class FakeRuntime {
  materializations = [];
  controllers = [];
  admissions = [];
  discards = [];
  materializeGate;
  promptGate;
  acquireError;
  admission = { accepted: true };

  async materialize(input) {
    this.materializations.push(input);
    if (this.materializeGate !== undefined) await this.materializeGate.promise;
    return structuredClone(input.targetSession);
  }

  async acquirePromptController(session) {
    this.controllers.push(structuredClone(session));
    if (this.acquireError !== undefined) throw this.acquireError;
    return {
      admit: async (input) => {
        this.admissions.push(input);
        if (this.promptGate !== undefined) await this.promptGate.promise;
        return structuredClone(this.admission);
      },
      release() {},
    };
  }

  async discard(session) {
    this.discards.push(structuredClone(session));
  }
}

async function fixture(t, runtime = new FakeRuntime()) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "pi-daemon-draft-materializer-")),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "work");
  await mkdir(cwd, { mode: 0o700 });
  const stateDir = join(root, "state");
  const store = new FileDashboardSessionDraftStore({ stateDir });
  const service = new DashboardSessionDraftService({ store, allowedRoots: [root] });
  const materializer = new DashboardSessionDraftMaterializer({ store, runtime });
  await materializer.recover();
  return { root, cwd, stateDir, store, service, materializer, runtime };
}

function spec(cwd, overrides = {}) {
  return {
    cwd,
    persistence: "persistent",
    tools: { mode: "none" },
    resources: {
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      projectTrust: "deny",
    },
    isolation: { mode: "unisolated" },
    ...overrides,
  };
}

async function draft(service, cwd, suffix = "one", overrides = {}) {
  return service.create({
    requestId: `create-${suffix}`,
    idempotencyKey: `create-key-${suffix}`,
    draftId: `draft-${suffix}`,
    spec: spec(cwd, overrides),
  });
}

function sendRequest(resource, suffix = "one", message = "first message") {
  return {
    requestId: `send-${suffix}`,
    idempotencyKey: `send-key-${suffix}`,
    expectedRevision: resource.revision,
    message,
  };
}

async function waitFor(predicate, message = "condition") {
  const deadline = Date.now() + 2_000;
  while (!(await predicate())) {
    if (Date.now() >= deadline) assert.fail(`timed out waiting for ${message}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

test("materializer source owns no subprocess or ambient shell path", async () => {
  const source = await readFile(
    new URL("../src/dashboard-session-materializer.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /node:child_process|\bspawn(?:Sync)?\b|\bexec(?:File|Sync)?\b|\bfork\b/u);
});

test("first send joins concurrent duplicates and materializes plus prompts exactly once", async (t) => {
  const harness = await fixture(t);
  const created = await draft(harness.service, harness.cwd);
  assert.equal(harness.runtime.materializations.length, 0);
  assert.equal(harness.runtime.admissions.length, 0);
  const request = sendRequest(created);

  const [first, duplicate] = await Promise.all([
    harness.materializer.submitSend(created.draftId, request),
    harness.materializer.submitSend(created.draftId, request),
  ]);
  assert.equal(first.ticketId, duplicate.ticketId);
  const terminal = await harness.materializer.wait(first.ticketId);
  assert.equal(terminal.state, "succeeded");
  assert.equal(terminal.draftRevision, created.revision);
  assert.equal(harness.runtime.materializations.length, 1);
  assert.equal(harness.runtime.controllers.length, 1);
  assert.equal(harness.runtime.admissions.length, 1);
  assert.equal(harness.runtime.admissions[0].message, "first message");
  assert.deepEqual(terminal.session, harness.runtime.materializations[0].targetSession);

  await assert.rejects(
    harness.materializer.submitSend(
      created.draftId,
      sendRequest(created, "one", "different semantic message"),
    ),
    (error) => error.code === "draft_idempotency_conflict",
  );
});

test("real multiplexer integration opens one runtime and admits one first prompt", async (t) => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "pi-daemon-draft-multiplexer-")),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "work");
  const stateDir = join(root, "state");
  await mkdir(cwd, { mode: 0o700 });
  const opens = [];
  const promptCommands = [];
  const rpc = {
    setPromptScheduler() {},
    async handle(command) {
      promptCommands.push(command);
      return { id: command.id, type: command.type, success: true };
    },
  };
  const factory = {
    async open(request) {
      opens.push(request);
      return {
        identity: () => ({
          sessionId: `pi-${request.sessionId}`,
          sessionFile: join(stateDir, `${request.sessionId}.jsonl`),
        }),
        async rpcController() { return rpc; },
        async prompt() { throw new Error("materializer must use Pi RPC preflight"); },
        async dispose() {},
      };
    },
  };
  const multiplexer = new Multiplexer({
    factory,
    durability: new FileDurabilityStore({ stateDir }),
    catalog: new FileSessionCatalog({ stateDir }),
    hostInstanceId: "draft-materializer-host",
  });
  await multiplexer.recover();
  t.after(() => multiplexer.dispose(1_000));
  const store = new FileDashboardSessionDraftStore({ stateDir });
  const service = new DashboardSessionDraftService({ store, allowedRoots: [root] });
  const materializer = new DashboardSessionDraftMaterializer({
    store,
    runtime: new MultiplexerDashboardSessionDraftRuntime({ multiplexer }),
  });
  await materializer.recover();
  const created = await draft(service, cwd, "multiplexer");
  const request = sendRequest(created, "multiplexer", "one admitted message");
  const [first, duplicate] = await Promise.all([
    materializer.submitSend(created.draftId, request),
    materializer.submitSend(created.draftId, request),
  ]);
  assert.equal(first.ticketId, duplicate.ticketId);
  const terminal = await materializer.wait(first.ticketId);
  assert.equal(terminal.state, "succeeded");
  assert.equal(opens.length, 1);
  assert.equal(promptCommands.length, 1);
  assert.equal(promptCommands[0].type, "prompt");
  assert.equal(promptCommands[0].message, "one admitted message");
  assert.equal(multiplexer.status(terminal.session.sessionId).generation, 1);
});

test("controller conflict fails before prompt and discards the unstarted session", async (t) => {
  const runtime = new FakeRuntime();
  runtime.acquireError = new DashboardSessionDraftMaterializerError(
    "controller_busy",
    "another controller already owns the session",
    true,
  );
  const harness = await fixture(t, runtime);
  const created = await draft(harness.service, harness.cwd, "controller");
  const admitted = await harness.materializer.submitSend(
    created.draftId,
    sendRequest(created, "controller"),
  );
  const terminal = await harness.materializer.wait(admitted.ticketId);
  assert.equal(terminal.state, "failed");
  assert.equal(terminal.error.code, "controller_busy");
  assert.equal(terminal.error.retryable, true);
  assert.equal(runtime.admissions.length, 0);
  assert.deepEqual(runtime.discards, [runtime.materializations[0].targetSession]);
});

test("cancellation before prompt wins the CAS and cleans up materialized state", async (t) => {
  const runtime = new FakeRuntime();
  runtime.materializeGate = deferred();
  const harness = await fixture(t, runtime);
  const created = await draft(harness.service, harness.cwd, "cancel");
  const admitted = await harness.materializer.submitSend(
    created.draftId,
    sendRequest(created, "cancel"),
  );
  await waitFor(() => runtime.materializations.length === 1, "materialization start");
  const materializing = await harness.service.get(created.draftId);
  await harness.service.cancel(created.draftId, {
    requestId: "cancel-request",
    idempotencyKey: "cancel-key",
    expectedRevision: materializing.revision,
  });
  runtime.materializeGate.resolve();
  const terminal = await harness.materializer.wait(admitted.ticketId);
  assert.equal(terminal.state, "failed");
  assert.equal(terminal.error.code, "draft_cancelled");
  assert.equal(runtime.admissions.length, 0);
  assert.deepEqual(runtime.discards, [runtime.materializations[0].targetSession]);
});

test("cancellation after prompt submission is indeterminate and never replayed", async (t) => {
  const runtime = new FakeRuntime();
  runtime.promptGate = deferred();
  const harness = await fixture(t, runtime);
  const created = await draft(harness.service, harness.cwd, "cancel-race");
  const admitted = await harness.materializer.submitSend(
    created.draftId,
    sendRequest(created, "cancel-race"),
  );
  await waitFor(async () => {
    const work = await harness.store.getSendWork(admitted.ticketId);
    return work?.phase === "prompt-submitting";
  }, "prompt-submitting checkpoint");
  const current = await harness.service.get(created.draftId);
  await harness.service.cancel(created.draftId, {
    requestId: "cancel-race-request",
    idempotencyKey: "cancel-race-key",
    expectedRevision: current.revision,
  });
  runtime.promptGate.resolve();
  const terminal = await harness.materializer.wait(admitted.ticketId);
  assert.equal(terminal.state, "indeterminate");
  assert.equal(terminal.error.code, "draft_cancel_indeterminate");
  assert.equal(runtime.admissions.length, 1);
  assert.equal(runtime.discards.length, 0);
});

test("restart resumes create-before-prompt checkpoint with one deterministic target", async (t) => {
  const harness = await fixture(t);
  const created = await draft(harness.service, harness.cwd, "restart-ready");
  const ticket = await harness.store.submitSend(
    created.draftId,
    sendRequest(created, "restart-ready"),
  );
  await harness.store.transitionSend(ticket.ticketId, {
    expectedState: "queued",
    state: "running",
    phase: "materializing",
  });
  const initialWork = await harness.store.getSendWork(ticket.ticketId);
  await harness.store.transitionSend(ticket.ticketId, {
    expectedState: "running",
    state: "running",
    phase: "ready-to-prompt",
    session: initialWork.targetSession,
  });

  const restartedStore = new FileDashboardSessionDraftStore({ stateDir: harness.stateDir });
  const restartedRuntime = new FakeRuntime();
  const restarted = new DashboardSessionDraftMaterializer({
    store: restartedStore,
    runtime: restartedRuntime,
  });
  const recovery = await restarted.recover();
  assert.deepEqual(recovery.recoverableTicketIds, [ticket.ticketId]);
  const terminal = await restarted.wait(ticket.ticketId);
  assert.equal(terminal.state, "succeeded");
  assert.deepEqual(restartedRuntime.materializations[0].targetSession, initialWork.targetSession);
  assert.equal(restartedRuntime.admissions.length, 1);
});

test("restart converts prompt-submitting to indeterminate without runtime calls", async (t) => {
  const harness = await fixture(t);
  const created = await draft(harness.service, harness.cwd, "restart-prompt");
  const ticket = await harness.store.submitSend(
    created.draftId,
    sendRequest(created, "restart-prompt"),
  );
  await harness.store.transitionSend(ticket.ticketId, {
    expectedState: "queued",
    state: "running",
    phase: "materializing",
  });
  const work = await harness.store.getSendWork(ticket.ticketId);
  await harness.store.transitionSend(ticket.ticketId, {
    expectedState: "running",
    state: "running",
    phase: "ready-to-prompt",
    session: work.targetSession,
  });
  await harness.store.transitionSend(ticket.ticketId, {
    expectedState: "running",
    state: "running",
    phase: "prompt-submitting",
    session: work.targetSession,
  });

  const restartedStore = new FileDashboardSessionDraftStore({ stateDir: harness.stateDir });
  const restartedRuntime = new FakeRuntime();
  const restarted = new DashboardSessionDraftMaterializer({
    store: restartedStore,
    runtime: restartedRuntime,
  });
  const recovery = await restarted.recover();
  assert.deepEqual(recovery.recoverableTicketIds, []);
  const terminal = await restarted.getSend(ticket.ticketId);
  assert.equal(terminal.state, "indeterminate");
  assert.equal(terminal.error.code, "draft_send_indeterminate");
  assert.equal(restartedRuntime.materializations.length, 0);
  assert.equal(restartedRuntime.admissions.length, 0);
});

test("multiplexer gateway opens the deterministic session and admits through Pi RPC", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pi-daemon-draft-gateway-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const opens = [];
  const closes = [];
  const prompts = [];
  const rpc = {
    async handle(command) {
      prompts.push(command);
      return { id: command.id, type: command.type, success: true };
    },
  };
  const multiplexer = {
    async retainedSession() { return undefined; },
    async open(command, options) {
      opens.push({ command, options });
      return { created: true, session: { sessionId: command.sessionId, generation: command.generation } };
    },
    async rpcController() { return rpc; },
    async close(command) { closes.push(command); return true; },
  };
  const gateway = new MultiplexerDashboardSessionDraftRuntime({ multiplexer });
  const targetSession = { sessionId: "dash-deterministic", generation: 1 };
  const controller = new AbortController();
  const identity = await gateway.materialize({
    ticketId: "ticket-one",
    requestId: "request-one",
    draftId: "draft-one",
    draftRevision: 1,
    targetSession,
    spec: spec(root),
    signal: controller.signal,
  });
  assert.deepEqual(identity, targetSession);
  assert.equal(opens.length, 1);
  assert.equal(opens[0].command.sessionId, targetSession.sessionId);
  assert.equal(opens[0].command.generation, targetSession.generation);
  assert.equal(opens[0].options.runtimeOptions.persistedSpec.tools.mode, "none");

  const promptController = await gateway.acquirePromptController(targetSession, controller.signal);
  assert.deepEqual(
    await promptController.admit({
      ticketId: "ticket-one",
      requestId: "prompt-one",
      session: targetSession,
      message: "hello",
      signal: controller.signal,
    }),
    { accepted: true },
  );
  assert.deepEqual(prompts, [{ id: "prompt-one", type: "prompt", message: "hello" }]);
  await gateway.discard(targetSession);
  assert.equal(closes[0].payload.retainSession, false);
});

test("multiplexer gateway safely recreates a dormant memory target at the same identity", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pi-daemon-draft-memory-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const targetSession = { sessionId: "dash-memory", generation: 1 };
  const draftSpec = spec(root, { persistence: "memory" });
  const prepared = parseSessionConfiguration(dashboardSessionDraftSpecToSessionSpec(draftSpec));
  const deletes = [];
  const opens = [];
  const multiplexer = {
    async retainedSession() {
      return {
        sessionId: targetSession.sessionId,
        generation: targetSession.generation,
        revision: 4,
        policyDigest: sessionSpecDigest(prepared.persistedSpec),
        spec: prepared.persistedSpec,
      };
    },
    status() {
      throw new MultiplexerError("session_not_found", "not resident");
    },
    async deleteRetainedSession(sessionId, options) {
      deletes.push({ sessionId, options });
      return true;
    },
    async open(command) {
      opens.push(command);
      return { created: true, session: { sessionId: command.sessionId, generation: command.generation } };
    },
  };
  const gateway = new MultiplexerDashboardSessionDraftRuntime({ multiplexer });
  const identity = await gateway.materialize({
    ticketId: "ticket-memory",
    requestId: "request-memory",
    draftId: "draft-memory",
    draftRevision: 1,
    targetSession,
    spec: draftSpec,
    signal: new AbortController().signal,
  });
  assert.deepEqual(identity, targetSession);
  assert.deepEqual(deletes, [{
    sessionId: targetSession.sessionId,
    options: {
      requestId: deletes[0].options.requestId,
      expectedGeneration: 1,
      expectedRevision: 4,
    },
  }]);
  assert.equal(opens.length, 1);
  assert.equal(opens[0].generation, 1);
});

test("prompt rejection is definitive, content-free and removes the empty session", async (t) => {
  const runtime = new FakeRuntime();
  runtime.admission = {
    accepted: false,
    error: {
      code: "draft_prompt_rejected",
      message: "dashboard session draft first message was rejected",
      retryable: false,
    },
  };
  const harness = await fixture(t, runtime);
  const created = await draft(harness.service, harness.cwd, "rejected");
  const admitted = await harness.materializer.submitSend(
    created.draftId,
    sendRequest(created, "rejected", "private prompt text"),
  );
  const terminal = await harness.materializer.wait(admitted.ticketId);
  assert.equal(terminal.state, "failed");
  assert.equal(terminal.error.code, "draft_prompt_rejected");
  assert.equal(JSON.stringify(terminal).includes("private prompt text"), false);
  assert.equal(runtime.discards.length, 1);
});
