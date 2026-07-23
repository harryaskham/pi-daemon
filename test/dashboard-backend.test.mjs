import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  InProcessDashboardBackend,
  InProcessDashboardBackendError,
} from "../dist/dashboard-backend.js";
import { asDashboardCursor } from "../dist/dashboard-contract.js";
import { TranscriptProjectionError } from "../dist/transcript-projector.js";
import { createDashboardContractFixtures } from "../dist/dashboard-fixtures.js";
import { createExtensionViewFixture, createExtensionViewResponseFixture } from "../dist/extension-view-fixtures.js";
import { ExtensionViewValidationError } from "../dist/extension-view-contract.js";
import { createDashboardStreamHandler } from "../dist/dashboard-stream-router.js";
import { Multiplexer } from "../dist/multiplexer.js";
import { FileSessionCatalog } from "../dist/session-catalog.js";
import { FileScheduleStore } from "../dist/schedule-store.js";
import {
  DashboardSessionDraftService,
  FileDashboardSessionDraftStore,
} from "../dist/dashboard-session-drafts.js";
import {
  assertDashboardBackendResourceConformance,
  assertDashboardRichChannelConformance,
  assertDashboardScheduleConformance,
} from "./dashboard-backend-conformance.mjs";

class FakeRpcController {
  listeners = new Set();
  handles = [];
  responses = [];
  navigations = [];
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

  async navigateTree(request) {
    this.navigations.push(request);
    return {
      cancelled: false,
      editorText: "fixture branch text",
      ...(request.summarize === true ? { summaryEntryId: "summary-fixture" } : {}),
    };
  }

  respondToExtensionUi(response) {
    this.responses.push(response);
    return ["ui-fixture", "view-fixture"].includes(response.id);
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

async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(message);
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
  const work = join(stateDir, "work");
  await mkdir(work, { mode: 0o700 });
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
  const projector = options.projector ?? {
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
  const schedules = options.schedules ? new FileScheduleStore({ stateDir }) : undefined;
  const drafts = options.drafts
    ? new DashboardSessionDraftService({
        store: new FileDashboardSessionDraftStore({ stateDir }),
        allowedRoots: [work],
      })
    : undefined;
  if (drafts !== undefined) await drafts.recover();
  const backend = new InProcessDashboardBackend({
    inventory,
    projector,
    ownership,
    multiplexer,
    ...(schedules === undefined ? {} : { schedules }),
    ...(drafts === undefined ? {} : { drafts }),
    ...(options.tuiChannels === undefined ? {} : { tuiChannels: options.tuiChannels }),
    limits: { leaseTtlMs: 3_000, ...(options.limits ?? {}) },
  });
  t.after(() => backend.dispose());
  return { backend, calls, factory, fixtures, multiplexer, schedules, drafts, work };
}

test("embedded backend delegates inventory, preview, ownership and catalog without transport policy", async (t) => {
  const { backend, calls, fixtures } = await harness(t);
  await assertDashboardBackendResourceConformance({ backend, fixtures });
  assert.equal(calls.project[0].path, fixtures.sessionInfo.source.canonicalPath);
  assert.equal(calls.project[0].expectedFingerprint, fixtures.sessionInfo.source.fingerprint.value);
  const capabilities = await backend.capabilities();
  assert.equal(capabilities.presentations.rich.available, true);
  assert.equal(capabilities.presentations.tui.available, false);
  assert.equal(capabilities.limits.visibleLeaseExpiryMs, 3_000);
  await assert.rejects(
    backend.openTuiChannel({ sessionRef: fixtures.sessionInfo.managed.sessionId, role: "observer", dimensions: { rows: 24, columns: 80 } }),
    (error) => error instanceof InProcessDashboardBackendError && error.code === "tui_unavailable",
  );
});

test("preview retries once from a stable current file when periodic inventory fingerprint is stale", async (t) => {
  const requests = [];
  let currentTranscript;
  const projector = {
    async project(request) {
      requests.push(request);
      if (request.expectedFingerprint !== undefined) {
        throw new TranscriptProjectionError(
          "source_fingerprint_changed",
          "session source changed since inventory",
          true,
        );
      }
      return currentTranscript;
    },
  };
  const h = await harness(t, { projector });
  currentTranscript = {
    ...h.fixtures.transcript,
    sourceFingerprint: "sha256:current-preview-fingerprint",
  };
  const result = await h.backend.getTranscript(h.fixtures.sessionInfo.inventoryId, { limit: 20 });
  assert.equal(result.sourceFingerprint, "sha256:current-preview-fingerprint");
  assert.equal(requests.length, 2);
  assert.equal(requests[0].expectedFingerprint, h.fixtures.sessionInfo.source.fingerprint.value);
  assert.equal(requests[1].expectedFingerprint, undefined);
});

test("shared schedule conformance passes for the embedded backend with prompt-redacted output", async (t) => {
  const { backend, fixtures } = await harness(t, { schedules: true });
  assert.equal((await backend.capabilities()).resources.schedules, true);
  await assertDashboardScheduleConformance({
    backend,
    sessionRef: fixtures.sessionInfo.managed.sessionId,
  });
});

test("lazy draft CRUD delegates to private persistence without opening runtime or RPC", async (t) => {
  const { backend, factory, work } = await harness(t, { drafts: true });
  assert.equal((await backend.capabilities()).resources.sessionDrafts, true);
  const initialOpens = factory.opens.length;
  const initialRpc = factory.controller.handles.length;
  const request = {
    requestId: "draft-create-backend",
    idempotencyKey: "draft-create-backend-key",
    draftId: "draft-backend-01",
    spec: {
      cwd: work,
      persistence: "persistent",
      tools: { mode: "none" },
      resources: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, projectTrust: "deny" },
      isolation: { mode: "unisolated" },
    },
  };
  const draft = await backend.createSessionDraft(request);
  assert.equal(draft.state, "draft");
  assert.deepEqual(await backend.getSessionDraft(draft.draftId), draft);
  const cancelled = await backend.cancelSessionDraft(draft.draftId, {
    requestId: "draft-cancel-backend",
    idempotencyKey: "draft-cancel-backend-key",
    expectedRevision: draft.revision,
  });
  assert.equal(cancelled.state, "cancelled");
  assert.equal(factory.opens.length, initialOpens);
  assert.equal(factory.controller.handles.length, initialRpc);
  assert.throws(
    () => backend.sendSessionDraft(draft.draftId, {
      requestId: "draft-send-backend",
      idempotencyKey: "draft-send-backend-key",
      expectedRevision: cancelled.revision,
      message: "must not queue without executor",
    }),
    (error) => error instanceof InProcessDashboardBackendError && error.code === "draft_execution_unavailable",
  );
});

test("shared Rich-channel conformance passes for the embedded backend", async (t) => {
  const { backend, factory, fixtures } = await harness(t);
  await assertDashboardRichChannelConformance({
    backend,
    sessionRef: fixtures.sessionInfo.managed.sessionId,
    emitSessionEvent: async (event) => factory.controller.emit(event),
    expectedEntries: fixtures.transcript.records.length,
  });
});

test("rich channels coalesce controller events, enforce roles, replay and durable identity", async (t) => {
  const { backend, factory, fixtures, multiplexer } = await harness(t);
  const sessionRef = fixtures.sessionInfo.managed.sessionId;
  assert.equal(backend.hasController(sessionRef), false);
  const controller = await backend.openSessionChannel({ sessionRef, generation: 3, role: "controller" });
  assert.equal(controller.role, "controller");
  assert.equal(backend.hasController(sessionRef), true);
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

  const navigated = await controller.command({
    correlationId: "tree-navigate-controller",
    identity: controller.identity,
    operation: "navigate_tree",
    payload: { entryId: "entry-user-01", summarize: true, label: "abandoned" },
  });
  assert.deepEqual(navigated, {
    correlationId: "tree-navigate-controller",
    state: "completed",
    data: { cancelled: false, editorText: "fixture branch text", summaryEntryId: "summary-fixture" },
  });
  assert.deepEqual(factory.controller.navigations, [{ entryId: "entry-user-01", summarize: true, label: "abandoned" }]);

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
  factory.controller.emit({
    type: "extension_ui_request",
    id: "view-fixture",
    method: "render_view",
    view: createExtensionViewFixture(),
  });
  assert.equal(controllerEvents.at(-1).kind, "extension_view");
  assert.equal(controllerEvents.at(-1).provenance.validation, "validated");
  assert.equal(controllerEvents.at(-1).view.root.type, "stack");
  await assert.rejects(
    controller.answerExtensionUi("view-fixture", {
      ...createExtensionViewResponseFixture(),
      revision: 3,
    }),
    (error) => error instanceof ExtensionViewValidationError && error.code === "invalid-view",
  );
  await controller.answerExtensionUi("view-fixture", createExtensionViewResponseFixture());
  factory.controller.emit({
    type: "extension_ui_request",
    id: "view-invalid",
    method: "render_view",
    view: { protocol: "pi-declarative-view", version: "2.0", fallbackText: "Use TUI." },
  });
  assert.equal(controllerEvents.at(-1).kind, "extension_view");
  assert.equal(controllerEvents.at(-1).provenance.validation, "rejected");
  assert.equal(controllerEvents.at(-1).view, undefined);
  assert.equal(controllerEvents.at(-1).fallback.text, "Use TUI.");
  await controller.answerExtensionUi("ui-fixture", { confirmed: true });
  assert.equal(factory.controller.responses.length, 2);
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
  assert.equal(backend.hasController(sessionRef), false);
  assert.equal((await contender.requestControl("control-grant")).state, "completed");
  assert.equal(contender.role, "controller");
  assert.equal(backend.hasController(sessionRef), true);

  await controller.close();
  await observer.close();
  await stale.close();
  await contender.close();
  assert.equal(backend.hasController(sessionRef), false);
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

test("browser stream router conforms against the real in-process backend and fully tears down", async (t) => {
  const { backend, factory, fixtures, multiplexer } = await harness(t);
  const sent = [];
  let onMessage;
  let onClose;
  const peer = {
    send(frame) { sent.push(structuredClone(frame)); return true; },
    onMessage(listener) { onMessage = listener; return () => {}; },
    onClose(listener) { onClose = listener; return () => {}; },
    close() {},
  };
  const authorization = {
    async require() { return "admin"; },
    async requireManagedSession(_principal, sessionRef) {
      return { resource: { kind: "session", id: `managed:${sessionRef}` }, role: "admin" };
    },
  };
  const session = {
    sessionKey: "authenticated-cookie-session",
    principal: { identityId: "local-owner", globalRole: "administrator" },
    clientId: "client-in-process",
    workspaceId: "workspace-in-process",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
  createDashboardStreamHandler({
    backend,
    authorization,
    serverInstanceId: "dash-in-process-fixture",
    limits: {
      maxSubscriptionsPerConnection: 4,
      maxInFlightCommandsPerConnection: 2,
      maxTuiRows: 40,
      maxTuiColumns: 120,
    },
  })({
    session,
    revalidateSession: () => session,
    peer,
  });
  const frame = (kind, correlationId, extra = {}) => JSON.stringify({
    dashVersion: "1.0",
    kind,
    correlationId,
    clientId: "client-in-process",
    workspaceId: "workspace-in-process",
    ...extra,
  });
  await onMessage(frame("hello", "hello-real", { requestedVersion: "1.0" }));
  await waitFor(() => sent.some((value) => value.kind === "ready"), "stream hello did not become ready");
  await onMessage(frame("subscribe", "subscribe-real", {
    subscriptionId: "pane-real",
    presentation: "rich",
    sessionRef: fixtures.sessionInfo.managed.sessionId,
    generation: 3,
    role: "controller",
  }));
  await waitFor(() => sent.some((value) => value.kind === "subscription_ready"), "stream subscription did not become ready");
  assert.equal(sent.find((value) => value.kind === "subscription_ready").identity.generation, 3);
  assert.equal(multiplexer.residencyLeaseCount(fixtures.sessionInfo.managed.sessionId, 3), 1);
  await onMessage(frame("command", "command-real", {
    subscriptionId: "pane-real",
    operation: "get_state",
  }));
  await waitFor(() => sent.some((value) => value.kind === "command_result" && value.correlationId === "command-real"), "stream command did not complete");
  assert.equal(sent.find((value) => value.correlationId === "command-real").result.state, "completed");
  assert.equal(factory.controller.handles.at(-1).type, "get_state");
  onClose();
  await waitFor(() => multiplexer.residencyLeaseCount(fixtures.sessionInfo.managed.sessionId, 3) === 0, "stream teardown leaked its residency lease");
  assert.equal(multiplexer.residencyLeaseCount(fixtures.sessionInfo.managed.sessionId, 3), 0);
  assert.equal(backend.hasController(fixtures.sessionInfo.managed.sessionId), false);
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
