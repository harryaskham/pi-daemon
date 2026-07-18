import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  InProcessDashboardBackend,
  InProcessDashboardBackendError,
} from "../dist/dashboard-backend.js";
import { asDashboardCursor } from "../dist/dashboard-contract.js";
import { createDashboardContractFixtures } from "../dist/dashboard-fixtures.js";
import { Multiplexer } from "../dist/multiplexer.js";
import { FileSessionCatalog } from "../dist/session-catalog.js";

class FakeRpcController {
  listeners = new Set();
  handles = [];
  responses = [];
  cancelPendingCalls = 0;

  snapshot() {
    return { rpcState: { isStreaming: false, model: { id: "fixture" } }, leafId: "entry-assistant-01" };
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(output) {
    for (const listener of this.listeners) listener(output);
  }

  async handle(command) {
    this.handles.push(command);
    if (command.type === "get_state") {
      return { id: command.id, type: "response", command: "get_state", success: true, data: this.snapshot().rpcState };
    }
    if (command.type === "get_entries") {
      return { id: command.id, type: "response", command: "get_entries", success: true, data: { entries: [], leafId: this.snapshot().leafId } };
    }
    return { id: command.id, type: "response", command: command.type, success: true };
  }

  respondToExtensionUi(response) {
    this.responses.push(response);
    return response.id === "ui-fixture";
  }

  cancelPendingUi() {
    this.cancelPendingCalls += 1;
  }

  setPromptScheduler() {}
}

class FakeAdapter {
  constructor(sessionId, generation, controller) {
    this.sessionId = sessionId;
    this.generation = generation;
    this.controller = controller;
    this.promptCalls = 0;
    this.disposed = 0;
  }

  identity() {
    return { sessionId: `pi-${this.sessionId}`, sessionFile: `/work/${this.sessionId}.jsonl` };
  }

  async prompt() {
    this.promptCalls += 1;
    return { text: "unexpected" };
  }

  async rpcController() {
    return this.controller;
  }

  async dispose() {
    this.disposed += 1;
  }
}

class FakeFactory {
  opens = [];
  adapters = [];
  controller = new FakeRpcController();

  async open(request) {
    this.opens.push(request);
    const adapter = new FakeAdapter(request.sessionId, request.generation, this.controller);
    this.adapters.push(adapter);
    return adapter;
  }
}

function openCommand(sessionId = "session-fixture-01", generation = 3) {
  return {
    protocolVersion: "1.0",
    requestId: `open-${sessionId}`,
    operation: "open",
    sessionId,
    generation,
    payload: {
      cwd: "/work/fixture",
      session: { mode: "new" },
      resources: {
        extensions: "none",
        skills: "none",
        promptTemplates: "none",
        themes: "none",
        contextFiles: "none",
        tools: "none",
      },
    },
  };
}

function closeCommand(sessionId = "session-fixture-01", generation = 3) {
  return {
    protocolVersion: "1.0",
    requestId: `close-${sessionId}`,
    operation: "close",
    sessionId,
    generation,
    payload: { retainSession: true },
  };
}

async function harness(t, options = {}) {
  const stateDir = await mkdtemp(join(tmpdir(), "pi-daemon-dashboard-backend-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const catalog = new FileSessionCatalog({ stateDir });
  const factory = new FakeFactory();
  const multiplexer = new Multiplexer({
    factory,
    catalog,
    hostInstanceId: "host-fixture-01",
    idleSessionTtlMs: 1,
  });
  await multiplexer.recover();
  await multiplexer.open(openCommand());
  const fixtures = createDashboardContractFixtures();
  const calls = { list: [], info: [], project: [], activation: [], export: [] };
  const inventory = {
    async list(query) {
      calls.list.push(query);
      return fixtures.inventory;
    },
    async getInfo(inventoryId) {
      calls.info.push(inventoryId);
      return inventoryId === fixtures.sessionInfo.inventoryId ? fixtures.sessionInfo : undefined;
    },
  };
  const projector = {
    async project(request) {
      calls.project.push(request);
      return fixtures.transcript;
    },
  };
  const ownership = {
    async activateSession(inventoryId, request) {
      calls.activation.push({ inventoryId, request });
      return fixtures.activationTicket;
    },
    async getActivation() { return fixtures.activationTicket; },
    async exportSession(sessionRef, request) {
      calls.export.push({ sessionRef, request });
      return fixtures.exportTicket;
    },
    async getExport() { return fixtures.exportTicket; },
  };
  const backend = new InProcessDashboardBackend({
    inventory,
    projector,
    ownership,
    multiplexer,
    ...(options.tuiChannels === undefined ? {} : { tuiChannels: options.tuiChannels }),
    limits: { leaseTtlMs: 3_000, ...(options.limits ?? {}) },
  });
  t.after(() => backend.dispose());
  return { backend, calls, factory, fixtures, multiplexer };
}

test("embedded backend delegates inventory, preview, ownership and catalog without transport policy", async (t) => {
  const { backend, calls, fixtures } = await harness(t);
  assert.deepEqual(await backend.listSessions({ limit: 20 }), fixtures.inventory);
  assert.equal((await backend.getSessionInfo(fixtures.sessionInfo.inventoryId)).inventoryId, fixtures.sessionInfo.inventoryId);
  assert.deepEqual(await backend.getTranscript(fixtures.sessionInfo.inventoryId, { limit: 20 }), fixtures.transcript);
  assert.equal(calls.project[0].path, fixtures.sessionInfo.source.canonicalPath);
  assert.equal(calls.project[0].expectedFingerprint, fixtures.sessionInfo.source.fingerprint.value);
  assert.deepEqual(await backend.activateSession(fixtures.sessionInfo.inventoryId, fixtures.activationRequest), fixtures.activationTicket);
  assert.deepEqual(await backend.getActivation(fixtures.activationTicket.ticketId), fixtures.activationTicket);
  assert.deepEqual(await backend.exportSession(fixtures.sessionInfo.managed.sessionId, fixtures.exportRequest), fixtures.exportTicket);
  assert.deepEqual(await backend.getExport(fixtures.exportTicket.ticketId), fixtures.exportTicket);
  assert.equal((await backend.getManagedSession(fixtures.sessionInfo.managed.sessionId)).generation, 3);
  const capabilities = await backend.capabilities();
  assert.equal(capabilities.presentations.rich.available, true);
  assert.equal(capabilities.presentations.tui.available, false);
  assert.equal(capabilities.limits.visibleLeaseExpiryMs, 3_000);
  await assert.rejects(
    backend.openTuiChannel({ sessionRef: fixtures.sessionInfo.managed.sessionId, role: "observer", dimensions: { rows: 24, columns: 80 } }),
    (error) => error instanceof InProcessDashboardBackendError && error.code === "tui_unavailable",
  );
});

test("rich channels coalesce controller events, enforce roles, replay and durable identity", async (t) => {
  const { backend, factory, fixtures, multiplexer } = await harness(t);
  const sessionRef = fixtures.sessionInfo.managed.sessionId;
  const controller = await backend.openSessionChannel({ sessionRef, generation: 3, role: "controller" });
  assert.equal(controller.role, "controller");
  assert.equal(controller.snapshot.entries.length, fixtures.transcript.records.length);
  assert.deepEqual(controller.identity, { hostInstanceId: "host-fixture-01", sessionId: sessionRef, generation: 3 });
  assert.equal(multiplexer.residencyLeaseCount(sessionRef, 3), 1);

  const initialCursor = controller.snapshot.highWaterCursor;
  const controllerEvents = [];
  controller.subscribe((event) => controllerEvents.push(event));
  factory.controller.emit({ type: "message_update", message: { role: "assistant", content: [] } });
  assert.equal(controllerEvents[0].kind, "session_event");

  const observer = await backend.openSessionChannel({ sessionRef, role: "observer", cursor: initialCursor });
  const activeInfo = await backend.getSessionInfo(fixtures.sessionInfo.inventoryId);
  assert.equal(activeInfo.runtime.readerCount, 2);
  assert.equal(activeInfo.runtime.warmLeaseCount, 2);
  const observerEvents = [];
  observer.subscribe((event) => observerEvents.push(event));
  assert.equal(observerEvents[0].kind, "session_event");
  assert.equal(observer.snapshot.highWaterCursor, controllerEvents[0].cursor);
  const denied = await observer.command({
    correlationId: "prompt-observer",
    identity: observer.identity,
    operation: "prompt",
    payload: { message: "must not run" },
  });
  assert.equal(denied.state, "rejected");
  assert.equal(denied.error.code, "controller_required");
  const read = await observer.command({
    correlationId: "state-observer",
    identity: observer.identity,
    operation: "get_state",
    payload: { type: "prompt", id: "spoofed", message: "must stay read-only" },
  });
  assert.equal(read.state, "completed");
  assert.equal(factory.controller.handles.at(-1).type, "get_state");
  assert.equal(factory.controller.handles.at(-1).id, "state-observer");

  const command = {
    correlationId: "prompt-controller",
    idempotencyKey: "prompt-key",
    identity: controller.identity,
    operation: "prompt",
    payload: { message: "run once" },
  };
  assert.equal((await controller.command(command)).state, "streaming");
  const duplicate = await controller.command({ ...command, correlationId: "prompt-controller-retry" });
  assert.equal(duplicate.state, "streaming");
  assert.equal(duplicate.correlationId, "prompt-controller-retry");
  assert.equal(factory.controller.handles.filter((value) => value.type === "prompt").length, 1);
  const conflicting = await controller.command({
    ...command,
    correlationId: "prompt-conflict",
    payload: { message: "different content" },
  });
  assert.equal(conflicting.state, "rejected");
  assert.equal(conflicting.error.code, "idempotency_conflict");

  factory.controller.emit({
    type: "extension_ui_request",
    id: "ui-fixture",
    method: "confirm",
    title: "Continue?",
    message: "Bounded fixture",
  });
  assert.equal(controllerEvents.at(-1).kind, "extension_ui");
  await controller.answerExtensionUi("ui-fixture", { confirmed: true });
  assert.equal(factory.controller.responses.length, 1);
  factory.controller.emit({ type: "non_serializable", value: 1n });
  assert.equal(controllerEvents.at(-1).kind, "session_event");
  assert.equal(controllerEvents.at(-1).event.type, "serialization_error");
  await assert.rejects(
    observer.answerExtensionUi("ui-fixture", { confirmed: false }),
    (error) => error instanceof InProcessDashboardBackendError && error.code === "controller_required",
  );

  const stale = await backend.openSessionChannel({
    sessionRef,
    role: "observer",
    cursor: asDashboardCursor("dash:not-a-valid-cursor"),
  });
  const staleEvents = [];
  stale.subscribe((event) => staleEvents.push(event));
  assert.equal(staleEvents[0].kind, "replay_gap");
  assert.equal(staleEvents[0].snapshotFollows, true);

  const contender = await backend.openSessionChannel({ sessionRef, role: "controller" });
  assert.equal(contender.role, "observer");
  assert.equal((await contender.requestControl("control-busy")).state, "rejected");
  assert.equal((await controller.releaseControl("release-control")).state, "completed");
  assert.equal((await contender.requestControl("control-grant")).state, "completed");
  assert.equal(contender.role, "controller");

  await controller.close();
  await observer.close();
  await stale.close();
  await contender.close();
  assert.equal(multiplexer.residencyLeaseCount(sessionRef, 3), 0);
});

test("bounded replay reports a gap instead of silently skipping evicted events", async (t) => {
  const { backend, factory, fixtures } = await harness(t, { limits: { maxReplayEvents: 1 } });
  const sessionRef = fixtures.sessionInfo.managed.sessionId;
  const first = await backend.openSessionChannel({ sessionRef, role: "observer" });
  const cursor = first.snapshot.highWaterCursor;
  factory.controller.emit({ type: "message_update", index: 1 });
  factory.controller.emit({ type: "message_update", index: 2 });
  const resumed = await backend.openSessionChannel({ sessionRef, role: "observer", cursor });
  const events = [];
  resumed.subscribe((event) => events.push(event));
  assert.equal(events[0].kind, "replay_gap");
  assert.equal(events[0].reason, "cursor-expired");
  assert.equal(events[0].snapshotFollows, true);
  await first.close();
  await resumed.close();
});

test("TUI channel delegation remains transport-neutral and backend-owned leases release", async (t) => {
  let closed = 0;
  const opens = [];
  const tuiChannels = {
    async open(context) {
      opens.push(context);
      return {
        presentation: "tui",
        identity: context.identity,
        role: "observer",
        snapshot: {
          identity: context.identity,
          dimensions: context.options.dimensions,
          rows: [],
          cursor: { row: 0, column: 0, visible: false },
          highWaterCursor: asDashboardCursor("tui:fixture:0"),
        },
        async resize() {},
        async sendInput() {},
        async requestControl(correlationId) { return { correlationId, state: "completed" }; },
        async releaseControl(correlationId) { return { correlationId, state: "completed" }; },
        subscribe() { return () => {}; },
        async close() { closed += 1; },
      };
    },
  };
  const { backend, fixtures, multiplexer } = await harness(t, { tuiChannels });
  assert.equal((await backend.capabilities()).presentations.tui.available, true);
  const sessionRef = fixtures.sessionInfo.managed.sessionId;
  const channel = await backend.openTuiChannel({
    sessionRef,
    generation: 3,
    role: "observer",
    dimensions: { rows: 24, columns: 80 },
  });
  assert.equal(opens.length, 1);
  assert.deepEqual(channel.snapshot.dimensions, { rows: 24, columns: 80 });
  assert.equal(multiplexer.residencyLeaseCount(sessionRef, 3), 1);
  await channel.close();
  assert.equal(closed, 1);
  assert.equal(multiplexer.residencyLeaseCount(sessionRef, 3), 0);
});

test("embedded channel hydrates dormant sessions without prompting and releases its lease", async (t) => {
  const { backend, factory, fixtures, multiplexer } = await harness(t);
  const sessionRef = fixtures.sessionInfo.managed.sessionId;
  await multiplexer.close(closeCommand());
  assert.equal((await multiplexer.retainedSession(sessionRef)).residency, "dormant");
  const channel = await backend.openSessionChannel({ sessionRef, generation: 3, role: "observer" });
  assert.equal((await multiplexer.retainedSession(sessionRef)).residency, "resident");
  assert.equal(factory.opens.length, 2);
  assert.equal(factory.adapters.reduce((count, adapter) => count + adapter.promptCalls, 0), 0);
  assert.equal(multiplexer.residencyLeaseCount(sessionRef, 3), 1);
  await channel.close();
  assert.equal(multiplexer.residencyLeaseCount(sessionRef, 3), 0);
});
