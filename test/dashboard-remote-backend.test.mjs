import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { performance } from "node:perf_hooks";
import test from "node:test";

import {
  RemoteDashboardBackend,
  RemoteDashboardBackendError,
} from "../dist/dashboard-remote-backend.js";
import { asDashboardCursor } from "../dist/dashboard-contract.js";
import { createDashboardContractFixtures } from "../dist/dashboard-fixtures.js";
import { createExtensionViewFixture, createExtensionViewResponseFixture } from "../dist/extension-view-fixtures.js";
import {
  assertDashboardBackendResourceConformance,
  assertDashboardRichChannelConformance,
  assertDashboardScheduleConformance,
} from "./dashboard-backend-conformance.mjs";

const immediate = () => new Promise((resolve) => setImmediate(resolve));

class FakeSocket extends EventEmitter {
  readyState = 0;
  sent = [];
  #server;
  #closed = false;

  constructor(server) {
    super();
    this.#server = server;
    queueMicrotask(() => {
      if (this.#closed) return;
      this.readyState = 1;
      this.emit("open");
      this.#server.open(this);
    });
  }

  send(text) {
    if (this.readyState !== 1) throw new Error("socket is not open");
    const frame = JSON.parse(text);
    this.sent.push(frame);
    this.#server.receive(this, frame);
  }

  frame(value) {
    if (this.readyState !== 1) return;
    this.emit("message", Buffer.from(JSON.stringify(value), "utf8"), false);
  }

  close(code = 1000) {
    if (this.#closed) return;
    this.#closed = true;
    this.readyState = 3;
    queueMicrotask(() => this.emit("close", code));
  }

  terminate() {
    this.close(1006);
  }
}

class FakeRemoteService {
  fixtures = createDashboardContractFixtures();
  rpcSockets = [];
  tuiSockets = [];
  rpcOptions = [];
  tuiOptions = [];
  transcriptFingerprints = [];
  heldRpcCommands = false;
  rpcGapReason = "cursor_expired";
  rpcRejectStatuses = [];
  forceRpcObserver = false;
  rpcHostInstanceId = "host-remote-01";
  rpcEventDuringReady = undefined;
  rpcCommandCounts = new Map();
  rpcControlActions = [];
  rpcSequence = 0;
  heldTuiActions = false;
  tuiActionCounts = new Map();
  tuiSequence = 0;

  constructor({ tui = true } = {}) {
    this.session = {
      sessionId: this.fixtures.sessionInfo.managed.sessionId,
      name: "Remote fixture",
      generation: this.fixtures.sessionInfo.managed.generation,
      revision: 7,
      residency: "dormant",
      state: "idle",
      createdAt: "2026-07-18T11:00:00.000Z",
      updatedAt: "2026-07-18T12:00:00.000Z",
      lastUsedAt: "2026-07-18T12:00:00.000Z",
      spec: { cwd: "/work/fixture", target: { mode: "memory" } },
      environment: { keys: [], persistence: "memory-only", provisioned: true },
      links: { self: "/v1/session/fixture", rpc: "/rpc", apc: "/apc" },
    };
    this.serviceCapabilities = {
      ...this.fixtures.serviceCapabilities,
      resources: { ...this.fixtures.serviceCapabilities.resources, schedules: true, sessionDrafts: true },
      presentations: {
        ...this.fixtures.serviceCapabilities.presentations,
        tui: {
          available: tui,
          subprotocol: "pi-daemon-tui.v1",
          ...(tui ? {} : { unavailableReason: "fixture-disabled" }),
        },
      },
    };
  }

  result(data) {
    return Promise.resolve({ data });
  }

  dashboardCapabilities() {
    return this.result(this.serviceCapabilities);
  }

  listDashboardSessions(query) {
    this.lastListQuery = query;
    return this.result(this.fixtures.inventory);
  }

  getDashboardSession(inventoryId) {
    assert.equal(inventoryId, this.fixtures.sessionInfo.inventoryId);
    return this.result(this.fixtures.sessionInfo);
  }

  getDashboardTranscript(inventoryId, query, fingerprint) {
    assert.equal(inventoryId, this.fixtures.sessionInfo.inventoryId);
    this.lastTranscriptQuery = query;
    this.transcriptFingerprints.push(fingerprint);
    return this.result(this.fixtures.transcript);
  }

  activateDashboardSession(inventoryId, request) {
    assert.equal(inventoryId, this.fixtures.sessionInfo.inventoryId);
    assert.deepEqual(request, this.fixtures.activationRequest);
    return this.result(this.fixtures.activationTicket);
  }

  getDashboardActivation() {
    return this.result(this.fixtures.activationTicket);
  }

  exportDashboardSession(sessionRef, request) {
    assert.equal(sessionRef, this.session.sessionId);
    assert.deepEqual(request, this.fixtures.exportRequest);
    return this.result(this.fixtures.exportTicket);
  }

  getDashboardExport() {
    return this.result(this.fixtures.exportTicket);
  }

  createDashboardSessionDraft(request) {
    const now = "2026-07-19T14:40:00.000Z";
    this.draft = { contractVersion: "1.0", draftId: request.draftId ?? "draft-remote-01", revision: 1, state: "draft", createdAt: now, updatedAt: now, spec: request.spec, firstMessageStartsSession: true };
    return this.result(this.draft);
  }
  getDashboardSessionDraft() { return this.result(this.draft); }
  cancelDashboardSessionDraft(_draftId, request) { this.draft = { ...this.draft, revision: request.expectedRevision + 1, state: "cancelled" }; return this.result(this.draft); }
  sendDashboardSessionDraft(draftId, request) { const now = "2026-07-19T14:40:01.000Z"; this.draftTicket = { ticketId: "draft-send-remote-01", draftId, draftRevision: request.expectedRevision, requestId: request.requestId, idempotencyKey: request.idempotencyKey, state: "queued", submittedAt: now, updatedAt: now }; return this.result(this.draftTicket); }
  getDashboardSessionDraftSend() { return this.result(this.draftTicket); }

  scheduleCapabilities() {
    return this.result({ contractVersion: "1.0", persistence: true, timerRuntime: false, cronSyntax: "posix-five-field", timezoneDatabase: "runtime-iana", optimisticConcurrency: "expected-revision", overlapPolicies: ["skip", "queue-one", "reject"], missedWakePolicies: ["skip", "run-once", "bounded-catch-up"], promptHandling: "owner-private-sensitive-content", terminalTicketSummary: "content-free", clock: "wall-clock-utc-instants", limits: { maxSchedules: 1024, maxSchedulesPerSession: 32, maxPromptBytes: 65536, maxRecordBytes: 131072, maxRecoveryBytes: 134217728, maxCatchUpRuns: 24, maxJitterMs: 86400000, maxAdmissionDelayMs: 86400000 } });
  }

  listSchedules() { return this.result({ schedules: this.schedule === undefined ? [] : [this.schedule] }); }
  getSchedule() { return this.result(this.schedule); }
  createSchedule(scheduleId, definition) {
    const now = "2026-07-18T12:00:00.000Z";
    this.schedule = { contractVersion: "1.0", ...definition, scheduleId, revision: 0, createdAt: now, updatedAt: now };
    return this.result(this.schedule);
  }
  updateSchedule(scheduleId, definition) {
    const { expectedRevision: _expectedRevision, ...write } = definition;
    this.schedule = { ...this.schedule, ...write, scheduleId, revision: this.schedule.revision + 1 };
    return this.result(this.schedule);
  }
  deleteSchedule() { this.schedule = undefined; return this.result({ deleted: true }); }
  scheduleStatus() { return this.result({ timerRuntime: false, externalTimersSupported: true, scheduleCount: this.schedule === undefined ? 0 : 1, enabledCount: this.schedule?.enabled ? 1 : 0 }); }

  getSession(sessionRef) {
    assert.equal(sessionRef, this.session.sessionId);
    return this.result(this.session);
  }

  createDashboardRpcSocket(sessionRef, options) {
    assert.equal(sessionRef, this.session.sessionId);
    this.rpcOptions.push(options);
    const socket = new FakeSocket({
      open: (opened) => {
        const rejectedStatus = this.rpcRejectStatuses.shift();
        if (rejectedStatus !== undefined) {
          opened.emit("unexpected-response", {}, {
            statusCode: rejectedStatus,
            resume() {},
          });
          return;
        }
        if (options.cursor !== undefined) {
          opened.frame({
            kind: "replay_gap",
            reason: this.rpcGapReason,
            requestedCursor: options.cursor,
            highWaterCursor: this.rpcCursor(),
            snapshotFollows: true,
          });
        }
        opened.frame({
          kind: "attach_ready",
          connectionId: `rpc-${this.rpcSockets.length}`,
          role: this.forceRpcObserver ? "observer" : options.role,
          hostInstanceId: this.rpcHostInstanceId,
          sessionId: this.session.sessionId,
          generation: this.session.generation,
          highWaterCursor: this.rpcCursor(),
          snapshot: {
            session: { ...this.session, residency: "resident" },
            requestState: { state: "idle", queuedTurns: 0 },
            rpcState: { isStreaming: false, model: { id: "fixture-model" } },
            leafId: this.fixtures.transcript.currentLeafId,
          },
        });
        if (this.rpcEventDuringReady !== undefined) {
          this.rpcSequence += 1;
          opened.frame({
            kind: "event",
            sequence: this.rpcSequence,
            cursor: this.rpcCursor(this.rpcSequence),
            event: this.rpcEventDuringReady,
          });
        }
      },
      receive: (opened, frame) => this.receiveRpc(opened, frame),
    });
    this.rpcSockets.push(socket);
    return socket;
  }

  createDashboardTuiSocket(sessionRef, options) {
    assert.equal(sessionRef, this.session.sessionId);
    this.tuiOptions.push(options);
    const socket = new FakeSocket({
      open: (opened) => {
        if (options.cursor !== undefined) {
          opened.frame({
            kind: "replay_gap",
            gap: {
              kind: "replay_gap",
              identity: this.identity(),
              reason: "cursor-expired",
              requestedCursor: options.cursor,
              highWaterCursor: this.tuiCursor(),
              snapshotFollows: true,
            },
          });
        }
        opened.frame({
          kind: "snapshot",
          role: options.role,
          snapshot: {
            identity: this.identity(),
            dimensions: options.dimensions,
            rows: [],
            cursor: { row: 0, column: 0, visible: false },
            title: "Remote fixture",
            highWaterCursor: this.tuiCursor(),
          },
        });
      },
      receive: (opened, frame) => this.receiveTui(opened, frame),
    });
    this.tuiSockets.push(socket);
    return socket;
  }

  receiveRpc(socket, frame) {
    if (frame.kind === "command") {
      const type = frame.command.type;
      this.rpcCommandCounts.set(type, (this.rpcCommandCounts.get(type) ?? 0) + 1);
      if (this.heldRpcCommands && type === "prompt") return;
      socket.frame({
        kind: "response",
        response: {
          type: "response",
          command: type,
          id: frame.command.id,
          success: true,
          data: type === "get_state" ? { isStreaming: false } : { accepted: true },
        },
      });
      return;
    }
    if (frame.kind === "control") {
      this.rpcControlActions.push(frame.action);
      socket.frame({
        kind: "control",
        action: frame.action === "request_control" ? "control_granted" : "release_control",
        connectionId: "rpc-control",
      });
      return;
    }
    if (frame.kind === "extension_ui_response") {
      socket.frame({
        kind: "response",
        response: { type: "response", command: "extension_ui_response", success: true },
      });
    }
  }

  receiveTui(socket, frame) {
    this.tuiActionCounts.set(
      frame.kind,
      (this.tuiActionCounts.get(frame.kind) ?? 0) + 1,
    );
    if (this.heldTuiActions) return;
    if (frame.kind === "control") {
      const role = frame.action === "request" ? "controller" : "observer";
      socket.frame({
        kind: "command_result",
        correlationId: frame.correlationId,
        role,
        result: {
          correlationId: frame.correlationId,
          state: "completed",
          data: { role },
        },
      });
      return;
    }
    socket.frame({ kind: "ack", correlationId: frame.correlationId, role: "controller" });
  }

  emitRpc(event) {
    const cursor = this.rpcCursor(++this.rpcSequence);
    for (const socket of this.rpcSockets) {
      if (socket.readyState === 1) {
        socket.frame({ kind: "event", sequence: this.rpcSequence, cursor, event });
      }
    }
    return cursor;
  }

  emitTui() {
    const cursor = this.tuiCursor(++this.tuiSequence);
    const delta = {
      kind: "tui_delta",
      identity: this.identity(),
      sequence: this.tuiSequence,
      cursor,
      dimensions: { rows: 24, columns: 80 },
      changedRows: [],
      cursorState: { row: 0, column: 0, visible: false },
    };
    for (const socket of this.tuiSockets) {
      if (socket.readyState === 1) socket.frame({ kind: "delta", delta });
    }
    return delta;
  }

  identity() {
    return {
      hostInstanceId: this.rpcHostInstanceId,
      sessionId: this.session.sessionId,
      generation: this.session.generation,
    };
  }

  rpcCursor(sequence = this.rpcSequence) {
    return `rpc-cursor-${sequence}`;
  }

  tuiCursor(sequence = this.tuiSequence) {
    return asDashboardCursor(`tui-cursor-${sequence}`);
  }
}

class LargeTranscriptRemoteService extends FakeRemoteService {
  transcriptCalls = [];

  constructor() {
    super();
    const base = this.fixtures.transcript.records.find((record) => record.kind === "message");
    assert.ok(base);
    this.largeRecords = Array.from({ length: 8 }, (_, index) => ({
      ...structuredClone(base),
      recordId: `large-record-${index}`,
      key: { entryId: `large-entry-${index}` },
      content: [{ type: "text", text: `${index}:${"x".repeat(300_000)}` }],
    }));
  }

  getDashboardTranscript(inventoryId, query, fingerprint) {
    assert.equal(inventoryId, this.fixtures.sessionInfo.inventoryId);
    assert.ok(query.limit <= 3, `unsafe dedicated transcript page limit ${query.limit}`);
    this.transcriptCalls.push({ query, fingerprint });
    const end = query.cursor === undefined
      ? this.largeRecords.length
      : Number(String(query.cursor).slice("large-cursor-".length));
    const start = Math.max(0, end - query.limit);
    return this.result({
      ...this.fixtures.transcript,
      records: this.largeRecords.slice(start, end),
      ...(start > 0 ? { olderCursor: asDashboardCursor(`large-cursor-${start}`) } : {}),
      ...(end < this.largeRecords.length
        ? { newerCursor: asDashboardCursor(`large-cursor-${end}`) }
        : {}),
    });
  }
}

function backend(service, limits = {}) {
  return new RemoteDashboardBackend({
    client: service,
    limits: {
      reconnectAttempts: 4,
      reconnectBaseDelayMs: 1,
      reconnectMaxDelayMs: 2,
      ...limits,
    },
  });
}

async function waitFor(predicate, description, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("remote backend delegates neutral resources with exact fingerprint and capability translation", async (t) => {
  const service = new FakeRemoteService();
  const remote = backend(service);
  t.after(() => remote.dispose());
  const fixtures = service.fixtures;

  await assertDashboardBackendResourceConformance({
    backend: remote,
    fixtures,
    sessionRef: service.session.sessionId,
  });
  const capabilities = await remote.capabilities();
  assert.equal(capabilities.presentations.tui.available, true);
  assert.equal(service.transcriptFingerprints.at(-1), fixtures.sessionInfo.source.fingerprint.value);
});

test("remote backend delegates lazy draft CRUD and send ticket routes", async () => {
  const service = new FakeRemoteService();
  const remote = backend(service);
  const spec = {
    cwd: "/work/remote",
    persistence: "persistent",
    tools: { mode: "none" },
    resources: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, projectTrust: "deny" },
    isolation: { mode: "unisolated" },
  };
  const draft = await remote.createSessionDraft({ requestId: "remote-create", idempotencyKey: "remote-create-key", draftId: "draft-remote-01", spec });
  assert.equal(draft.state, "draft");
  const ticket = await remote.sendSessionDraft(draft.draftId, { requestId: "remote-send", idempotencyKey: "remote-send-key", expectedRevision: draft.revision, message: "start" });
  assert.equal(ticket.draftRevision, draft.revision);
  assert.deepEqual(await remote.getSessionDraftSend(ticket.ticketId), ticket);
  assert.equal((await remote.cancelSessionDraft(draft.draftId, { requestId: "remote-cancel", idempotencyKey: "remote-cancel-key", expectedRevision: draft.revision })).state, "cancelled");
  remote.dispose();
});

test("shared schedule conformance passes for the remote backend with server-side prompt retention", async () => {
  const service = new FakeRemoteService();
  const backend = new RemoteDashboardBackend({ client: service });
  await assertDashboardScheduleConformance({ backend, sessionRef: service.session.sessionId });
  backend.dispose();
});

test("older remote daemons expose typed schedule capability absence", async () => {
  const service = new FakeRemoteService();
  delete service.serviceCapabilities.resources.schedules;
  const backend = new RemoteDashboardBackend({ client: service });
  assert.equal((await backend.capabilities()).resources.schedules, false);
  await assert.rejects(backend.listSchedules(), (error) => error instanceof RemoteDashboardBackendError && error.code === "schedules_unavailable");
  backend.dispose();
});

test("shared Rich-channel conformance passes for the remote backend", async (t) => {
  const service = new FakeRemoteService();
  const remote = backend(service);
  t.after(() => remote.dispose());
  await assertDashboardRichChannelConformance({
    backend: remote,
    sessionRef: service.session.sessionId,
    emitSessionEvent: async (event) => service.emitRpc(event),
    expectedEntries: service.fixtures.transcript.records.length,
  });
  assert.equal(service.rpcSockets.length, 1);
});

test("events arriving during remote snapshot capture are delivered exactly once", async (t) => {
  const service = new FakeRemoteService();
  service.rpcEventDuringReady = { type: "message_update", duringCapture: true };
  const remote = backend(service);
  t.after(() => remote.dispose());
  const channel = await remote.openSessionChannel({
    sessionRef: service.session.sessionId,
    role: "observer",
  });
  const events = [];
  channel.subscribe((event) => events.push(event));
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "session_event");
  assert.equal(events[0].event.duringCapture, true);
  assert.equal(channel.snapshot.highWaterCursor, service.rpcCursor(1));
  await channel.close();
});

test("remote RPC gap reasons map into the exact Dashboard contract", async (t) => {
  for (const [rpcReason, dashboardReason] of [
    ["cursor_expired", "cursor-expired"],
    ["host_restarted", "host-restarted"],
    ["generation_changed", "generation-changed"],
  ]) {
    const service = new FakeRemoteService();
    service.rpcGapReason = rpcReason;
    const remote = backend(service);
    const channel = await remote.openSessionChannel({
      sessionRef: service.session.sessionId,
      role: "observer",
      cursor: asDashboardCursor(`previous-${rpcReason}`),
    });
    const events = [];
    channel.subscribe((event) => events.push(event));
    assert.equal(events[0].kind, "replay_gap");
    assert.equal(events[0].reason, dashboardReason);
    assert.equal(events[0].snapshotFollows, true);
    assert.equal(channel.snapshot.highWaterCursor, service.rpcCursor());
    await channel.close();
    remote.dispose();
  }
});

test("dedicated transcript paging preserves valid output above the client response bound", async (t) => {
  const service = new LargeTranscriptRemoteService();
  const remote = backend(service);
  t.after(() => remote.dispose());
  const page = await remote.getTranscript(
    service.fixtures.sessionInfo.inventoryId,
    { limit: 8 },
  );
  assert.ok(Buffer.byteLength(JSON.stringify(page), "utf8") > 2 * 1024 * 1024);
  assert.deepEqual(
    page.records.map((record) => record.recordId),
    service.largeRecords.map((record) => record.recordId),
  );
  assert.equal(service.transcriptCalls.length, 3);
  assert.ok(service.transcriptCalls.every(({ query }) => query.limit <= 3));
});

test("remote Rich panes coalesce one attachment, enforce roles, correlate commands and stream under budget", async (t) => {
  const service = new FakeRemoteService();
  const remote = backend(service);
  t.after(() => remote.dispose());
  const controller = await remote.openSessionChannel({
    sessionRef: service.session.sessionId,
    generation: 3,
    role: "controller",
  });
  const observer = await remote.openSessionChannel({
    sessionRef: service.session.sessionId,
    role: "observer",
    cursor: controller.snapshot.highWaterCursor,
  });
  assert.equal(service.rpcSockets.length, 1);
  assert.equal(service.rpcOptions[0].hydrate, true);
  assert.equal(controller.role, "controller");
  assert.equal(observer.role, "observer");
  assert.equal(controller.snapshot.entries.length, service.fixtures.transcript.records.length);

  const controllerEvents = [];
  const observerEvents = [];
  controller.subscribe((event) => controllerEvents.push(event));
  observer.subscribe((event) => observerEvents.push(event));
  const samples = [];
  for (let index = 0; index < 80; index += 1) {
    const startedAt = performance.now();
    service.emitRpc({ type: "message_update", index });
    samples.push(performance.now() - startedAt);
  }
  samples.sort((a, b) => a - b);
  const p95 = samples[Math.floor(samples.length * 0.95)];
  t.diagnostic(`remote Rich fixture p95=${p95.toFixed(2)}ms`);
  assert.ok(p95 < 50);
  assert.equal(controllerEvents.length, 80);
  assert.equal(observerEvents.length, 80);
  service.emitRpc({
    type: "extension_ui_request",
    id: "remote-extension-view",
    method: "render_view",
    view: createExtensionViewFixture(),
  });
  assert.equal(controllerEvents.at(-1).kind, "extension_view");
  assert.equal(controllerEvents.at(-1).provenance.validation, "validated");
  await assert.rejects(
    controller.answerExtensionUi("remote-extension-view", {
      ...createExtensionViewResponseFixture(),
      actionId: "not-declared",
    }),
    (error) => error.code === "invalid-view",
  );
  await controller.answerExtensionUi("remote-extension-view", createExtensionViewResponseFixture());
  service.emitRpc({
    type: "extension_ui_request",
    id: "remote-extension-view-invalid",
    method: "render_view",
    view: { version: "9.0", fallbackText: "Remote TUI fallback." },
  });
  assert.equal(controllerEvents.at(-1).kind, "extension_view");
  assert.equal(controllerEvents.at(-1).provenance.validation, "rejected");
  assert.equal(controllerEvents.at(-1).fallback.text, "Remote TUI fallback.");

  const denied = await observer.command({
    correlationId: "observer-prompt",
    identity: observer.identity,
    operation: "prompt",
    payload: { message: "must not run" },
  });
  assert.equal(denied.error.code, "controller_required");
  for (const operation of [
    "get_state",
    "get_entries",
    "get_session_stats",
    "get_commands",
    "get_available_models",
    "get_tree",
  ]) {
    const result = await observer.command({
      correlationId: `read-${operation}`,
      identity: observer.identity,
      operation,
      payload: { type: "prompt", id: "spoofed" },
    });
    assert.equal(result.state, "completed", operation);
  }
  for (const operation of [
    "steer",
    "follow_up",
    "abort",
    "set_model",
    "set_thinking_level",
    "set_steering_mode",
    "set_follow_up_mode",
    "compact",
    "set_auto_compaction",
    "set_auto_retry",
    "abort_retry",
    "set_session_name",
    "fork",
    "clone",
  ]) {
    const result = await controller.command({
      correlationId: `mutate-${operation}`,
      identity: controller.identity,
      operation,
      payload: { type: "get_state", id: "spoofed" },
    });
    assert.equal(result.state, "completed", operation);
    assert.equal(service.rpcCommandCounts.get(operation), 1, operation);
  }
  const command = {
    correlationId: "controller-prompt",
    idempotencyKey: "prompt-once",
    identity: controller.identity,
    operation: "prompt",
    payload: { message: "run once" },
  };
  assert.equal((await controller.command(command)).state, "streaming");
  assert.equal((await controller.command({ ...command, correlationId: "controller-retry" })).state, "streaming");
  assert.equal(service.rpcCommandCounts.get("prompt"), 1);
  const oversized = await controller.command({
    correlationId: "oversized-command",
    identity: controller.identity,
    operation: "prompt",
    payload: { message: "x".repeat(600_000) },
  });
  assert.equal(oversized.state, "rejected");
  assert.equal(oversized.error.code, "remote_frame_too_large");
  assert.equal(service.rpcCommandCounts.get("prompt"), 1);
  await controller.answerExtensionUi("ui-one", { confirmed: true });

  const contender = await remote.openSessionChannel({
    sessionRef: service.session.sessionId,
    role: "controller",
  });
  assert.equal(contender.role, "observer");
  assert.equal((await controller.releaseControl("release")).state, "completed");
  assert.equal((await contender.requestControl("grant")).state, "completed");
  assert.equal(contender.role, "controller");

  await controller.close();
  await observer.close();
  await contender.close();
});

test("remote Rich reconnect retains cursor, emits a gap and never replays an accepted command", async (t) => {
  const service = new FakeRemoteService();
  const remote = backend(service);
  t.after(() => remote.dispose());
  const channel = await remote.openSessionChannel({
    sessionRef: service.session.sessionId,
    role: "controller",
  });
  const events = [];
  channel.subscribe((event) => events.push(event));
  service.emitRpc({ type: "message_update", marker: "before-disconnect" });
  const initialIdentity = channel.identity;
  service.heldRpcCommands = true;
  const pending = channel.command({
    correlationId: "accepted-before-loss",
    idempotencyKey: "accepted-before-loss",
    identity: channel.identity,
    operation: "prompt",
    payload: { message: "do not replay" },
  });
  const unkeyed = channel.command({
    correlationId: "unkeyed-before-loss",
    identity: channel.identity,
    operation: "prompt",
    payload: { message: "also do not replay" },
  });
  service.rpcGapReason = "host_restarted";
  service.rpcHostInstanceId = "host-remote-02";
  service.rpcSockets[0].terminate();
  const [result, unkeyedResult] = await Promise.all([pending, unkeyed]);
  assert.equal(result.state, "indeterminate");
  assert.equal(result.error.code, "connection_lost_indeterminate");
  assert.equal(unkeyedResult.state, "indeterminate");
  await waitFor(() => service.rpcSockets.length === 2, "Rich reconnect");
  await waitFor(() => events.some((event) => event.kind === "replay_gap"), "Rich replay gap");
  assert.equal(service.rpcOptions[1].cursor, service.rpcCursor(1));
  assert.notDeepEqual(channel.identity, initialIdentity);
  assert.equal(channel.identity.hostInstanceId, "host-remote-02");
  assert.equal(channel.snapshot.identity.hostInstanceId, "host-remote-02");
  assert.equal(
    events.find((event) => event.kind === "replay_gap").reason,
    "host-restarted",
  );
  assert.equal(service.rpcCommandCounts.get("prompt"), 2);
  assert.equal((await channel.command({
    correlationId: "retry-after-loss",
    idempotencyKey: "accepted-before-loss",
    identity: channel.identity,
    operation: "prompt",
    payload: { message: "do not replay" },
  })).state, "indeterminate");
  const conflict = await channel.command({
    correlationId: "changed-retry-after-loss",
    idempotencyKey: "accepted-before-loss",
    identity: channel.identity,
    operation: "prompt",
    payload: { message: "changed content" },
  });
  assert.equal(conflict.state, "rejected");
  assert.equal(conflict.error.code, "idempotency_conflict");
  assert.equal(service.rpcCommandCounts.get("prompt"), 2);
  await channel.close();
});

test("controller pane close releases upstream control without promoting observers", async (t) => {
  const service = new FakeRemoteService();
  const remote = backend(service);
  t.after(() => remote.dispose());
  const controller = await remote.openSessionChannel({
    sessionRef: service.session.sessionId,
    role: "controller",
  });
  const observer = await remote.openSessionChannel({
    sessionRef: service.session.sessionId,
    role: "observer",
  });
  await controller.close();
  await waitFor(
    () => service.rpcControlActions.includes("release_control"),
    "upstream controller release",
  );
  assert.equal(observer.role, "observer");
  assert.equal((await observer.requestControl("explicit-takeover")).state, "completed");
  assert.equal(observer.role, "controller");
  await observer.close();
});

test("reconnect downgrades and notifies only the prior controller claimant", async (t) => {
  const service = new FakeRemoteService();
  const remote = backend(service);
  t.after(() => remote.dispose());
  const controller = await remote.openSessionChannel({
    sessionRef: service.session.sessionId,
    role: "controller",
  });
  const observer = await remote.openSessionChannel({
    sessionRef: service.session.sessionId,
    role: "observer",
  });
  const controllerEvents = [];
  const observerEvents = [];
  controller.subscribe((event) => controllerEvents.push(event));
  observer.subscribe((event) => observerEvents.push(event));
  service.forceRpcObserver = true;
  service.rpcSockets[0].terminate();
  await waitFor(() => service.rpcSockets.length === 2, "controller reconnect denial");
  await waitFor(() => controller.role === "observer", "controller claimant downgrade");
  assert.equal(
    controllerEvents.some((event) => event.kind === "control" && event.action === "control_denied"),
    true,
  );
  assert.equal(
    observerEvents.some((event) => event.kind === "control" && event.action === "control_denied"),
    false,
  );
  await controller.close();
  await observer.close();
});

test("remote reconnect retries server failures but stops on terminal admission errors", async (t) => {
  const transient = new FakeRemoteService();
  const transientBackend = backend(transient);
  t.after(() => transientBackend.dispose());
  const transientChannel = await transientBackend.openSessionChannel({
    sessionRef: transient.session.sessionId,
    role: "observer",
  });
  transient.rpcRejectStatuses.push(503);
  transient.rpcSockets[0].terminate();
  await waitFor(() => transient.rpcSockets.length === 3, "retry after 503");
  assert.equal((await transientChannel.command({
    correlationId: "state-after-retry",
    identity: transientChannel.identity,
    operation: "get_state",
  })).state, "completed");
  await transientChannel.close();

  const terminal = new FakeRemoteService();
  const terminalBackend = backend(terminal);
  t.after(() => terminalBackend.dispose());
  const terminalChannel = await terminalBackend.openSessionChannel({
    sessionRef: terminal.session.sessionId,
    role: "observer",
  });
  terminal.rpcRejectStatuses.push(401);
  terminal.rpcSockets[0].terminate();
  await waitFor(() => terminal.rpcSockets.length === 2, "terminal reconnect attempt");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(terminal.rpcSockets.length, 2);
  assert.throws(
    () => terminalChannel.command({
      correlationId: "must-be-closed",
      identity: terminalChannel.identity,
      operation: "get_state",
    }),
    (error) => error instanceof RemoteDashboardBackendError && error.code === "channel_closed",
  );
});

test("closing the last pane cancels a pending reconnect", async () => {
  const service = new FakeRemoteService();
  const remote = backend(service, { reconnectBaseDelayMs: 50, reconnectMaxDelayMs: 50 });
  const channel = await remote.openSessionChannel({
    sessionRef: service.session.sessionId,
    role: "observer",
  });
  service.rpcSockets[0].terminate();
  await channel.close();
  await new Promise((resolve) => setTimeout(resolve, 75));
  assert.equal(service.rpcSockets.length, 1);
  remote.dispose();
});

test("remote command deadlines become indeterminate without replay", async (t) => {
  const service = new FakeRemoteService();
  service.heldRpcCommands = true;
  const remote = backend(service, { operationTimeoutMs: 5 });
  t.after(() => remote.dispose());
  const channel = await remote.openSessionChannel({
    sessionRef: service.session.sessionId,
    role: "controller",
  });
  const result = await channel.command({
    correlationId: "timed-command",
    idempotencyKey: "timed-command",
    identity: channel.identity,
    operation: "prompt",
    payload: { message: "bounded deadline" },
  });
  assert.equal(result.state, "indeterminate");
  assert.equal(result.error.code, "remote_command_timeout");
  assert.equal(service.rpcCommandCounts.get("prompt"), 1);
  assert.equal((await channel.command({
    correlationId: "timed-command-retry",
    idempotencyKey: "timed-command",
    identity: channel.identity,
    operation: "prompt",
    payload: { message: "bounded deadline" },
  })).state, "indeterminate");
  assert.equal(service.rpcCommandCounts.get("prompt"), 1);
  await channel.close();
});

test("remote TUI reconnect never replays unacknowledged semantic input", async (t) => {
  const service = new FakeRemoteService();
  const remote = backend(service);
  t.after(() => remote.dispose());
  const channel = await remote.openTuiChannel({
    sessionRef: service.session.sessionId,
    role: "controller",
    dimensions: { rows: 24, columns: 80 },
  });
  service.heldTuiActions = true;
  const pending = channel.sendInput({ type: "text", text: "do not replay" });
  service.tuiSockets[0].terminate();
  await assert.rejects(
    pending,
    (error) =>
      error instanceof RemoteDashboardBackendError &&
      error.code === "connection_lost_indeterminate",
  );
  service.heldTuiActions = false;
  await waitFor(() => service.tuiSockets.length === 2, "TUI reconnect");
  assert.equal(service.tuiActionCounts.get("input"), 1);
  await channel.close();
});

test("remote TUI panes share one socket and preserve semantic control/input", async (t) => {
  const service = new FakeRemoteService();
  const remote = backend(service);
  t.after(() => remote.dispose());
  const controller = await remote.openTuiChannel({
    sessionRef: service.session.sessionId,
    role: "controller",
    dimensions: { rows: 24, columns: 80 },
  });
  const observer = await remote.openTuiChannel({
    sessionRef: service.session.sessionId,
    role: "observer",
    dimensions: { rows: 24, columns: 80 },
    cursor: controller.snapshot.highWaterCursor,
  });
  assert.equal(service.tuiSockets.length, 1);
  const controllerEvents = [];
  const observerEvents = [];
  controller.subscribe((event) => controllerEvents.push(event));
  observer.subscribe((event) => observerEvents.push(event));
  await controller.sendInput({ type: "text", text: "hello" });
  await controller.resize({ rows: 30, columns: 100 });
  await assert.rejects(
    async () => observer.sendInput({ type: "text", text: "denied" }),
    (error) => error instanceof RemoteDashboardBackendError && error.code === "controller_required",
  );
  service.emitTui();
  assert.equal(controllerEvents.at(-1).kind, "tui_delta");
  assert.deepEqual(controllerEvents.at(-1), observerEvents.at(-1));
  assert.equal((await controller.releaseControl("release-tui")).state, "completed");
  assert.equal((await observer.requestControl("grant-tui")).state, "completed");
  assert.equal(observer.role, "controller");
  await controller.close();
  await observer.close();
});

test("remote capability version mismatches fail before attachment", async () => {
  const service = new FakeRemoteService();
  service.serviceCapabilities = { ...service.serviceCapabilities, apiVersion: "2.0" };
  const remote = backend(service);
  await assert.rejects(
    remote.capabilities(),
    (error) =>
      error instanceof RemoteDashboardBackendError &&
      error.code === "remote_capability_mismatch",
  );
  assert.equal(service.rpcSockets.length, 0);
  assert.equal(service.tuiSockets.length, 0);
  remote.dispose();
});

test("remote TUI capability failure is typed before any attachment", async () => {
  const service = new FakeRemoteService({ tui: false });
  const remote = backend(service);
  await assert.rejects(
    remote.openTuiChannel({
      sessionRef: service.session.sessionId,
      role: "observer",
      dimensions: { rows: 24, columns: 80 },
    }),
    (error) => error instanceof RemoteDashboardBackendError && error.code === "tui_unavailable",
  );
  assert.equal(service.tuiSockets.length, 0);
  remote.dispose();
  await immediate();
});
