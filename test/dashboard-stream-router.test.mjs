import assert from "node:assert/strict";
import test from "node:test";

import { createDashboardStreamHandler } from "../dist/dashboard-stream-router.js";
import { createDashboardContractFixtures } from "../dist/dashboard-fixtures.js";

const SESSION = {
  sessionKey: "cookie-session",
  clientId: "client-fixture",
  workspaceId: "workspace-fixture",
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
};
const LIMITS = {
  maxSubscriptionsPerConnection: 2,
  maxInFlightCommandsPerConnection: 1,
  maxTuiRows: 40,
  maxTuiColumns: 120,
};

class FakePeer {
  sent = [];
  closeCalls = [];
  message;
  closed;
  send(value) { this.sent.push(structuredClone(value)); return true; }
  onMessage(listener) { this.message = listener; return () => {}; }
  onClose(listener) { this.closed = listener; return () => {}; }
  close(code, reason) { this.closeCalls.push([code, reason]); }
  async receive(value) { await this.message(typeof value === "string" ? value : JSON.stringify(value)); await settle(); }
  disconnect() { this.closed?.(); }
}

function base(kind, correlationId, extra = {}) {
  return {
    dashVersion: "1.0",
    kind,
    clientId: SESSION.clientId,
    workspaceId: SESSION.workspaceId,
    correlationId,
    ...extra,
  };
}

function fakeBackend(overrides = {}) {
  const fixtures = createDashboardContractFixtures();
  const identity = fixtures.streamReady.identity;
  const channels = [];
  const calls = [];
  const makeRich = (options) => {
    const listeners = new Set();
    const channel = {
      presentation: "rich",
      identity,
      role: options.role,
      snapshot: fixtures.streamReady.snapshot,
      closed: 0,
      async command(command) { calls.push(["command", command]); return { correlationId: command.correlationId, state: command.operation === "prompt" ? "streaming" : "completed" }; },
      async requestControl(correlationId) { calls.push(["requestControl", correlationId]); return { correlationId, state: "completed" }; },
      async releaseControl(correlationId) { calls.push(["releaseControl", correlationId]); return { correlationId, state: "completed" }; },
      async answerExtensionUi(requestId, response) { calls.push(["extensionUi", requestId, response]); },
      subscribe(listener) { listeners.add(listener); for (const event of overrides.initialEvents ?? []) listener(event); return () => listeners.delete(listener); },
      emit(event) { for (const listener of listeners) listener(event); },
      async close() { channel.closed += 1; listeners.clear(); },
    };
    channels.push(channel);
    return channel;
  };
  const backend = {
    async capabilities() { return fixtures.capabilities; },
    async getSessionInfo() { return fixtures.sessionInfo; },
    async openSessionChannel(options) { calls.push(["openRich", options]); return makeRich(options); },
    async openTuiChannel(options) { calls.push(["openTui", options]); throw Object.assign(new Error("TUI unavailable"), { code: "tui_unavailable" }); },
    ...overrides.backend,
  };
  return { backend, calls, channels, fixtures, identity };
}

function connect(backend) {
  const peer = new FakePeer();
  createDashboardStreamHandler({ backend, serverInstanceId: "dash-router-fixture", limits: LIMITS })({ session: SESSION, peer });
  return peer;
}

async function hello(peer) {
  await peer.receive(base("hello", "hello-1", { requestedVersion: "1.0" }));
  assert.equal(peer.sent.at(-1).kind, "ready");
}

async function subscribe(peer, extra = {}) {
  await peer.receive(base("subscribe", "subscribe-1", {
    subscriptionId: "pane-1",
    presentation: "rich",
    sessionRef: "session-fixture-01",
    generation: 3,
    role: "controller",
    ...extra,
  }));
}

function settle() { return new Promise((resolve) => setImmediate(resolve)); }

// The router is deliberately testable without ws or a raw socket: this is the
// same bounded public seam DashboardServer supplies after cookie authentication.
test("routes authenticated rich frames with exact identity and correlation", async () => {
  const { backend, calls, channels, fixtures } = fakeBackend();
  const peer = connect(backend);
  await hello(peer);
  await subscribe(peer);
  const ready = peer.sent.at(-1);
  assert.equal(ready.kind, "subscription_ready");
  assert.equal(ready.correlationId, "subscribe-1");
  assert.deepEqual(ready.identity, fixtures.streamReady.identity);

  await peer.receive(base("command", "command-1", {
    subscriptionId: "pane-1",
    idempotencyKey: "command-key-1",
    operation: "prompt",
    payload: { message: "hello" },
  }));
  assert.equal(peer.sent.at(-1).kind, "command_result");
  assert.equal(peer.sent.at(-1).result.state, "streaming");
  assert.deepEqual(calls.find(([kind]) => kind === "command")[1].identity, fixtures.streamReady.identity);

  await peer.receive(base("control", "control-1", { subscriptionId: "pane-1", action: "release" }));
  await peer.receive(base("extension_ui_response", "ui-1", {
    subscriptionId: "pane-1",
    requestId: "extension-request-1",
    response: { confirmed: true },
  }));
  assert.deepEqual(calls.find(([kind]) => kind === "extensionUi"), ["extensionUi", "extension-request-1", { confirmed: true }]);

  channels[0].emit(fixtures.streamEvent.event);
  assert.equal(peer.sent.at(-1).kind, "session_event");
  assert.equal(peer.sent.at(-1).subscriptionId, "pane-1");
});

test("reconnect replay gap is emitted before its fresh atomic snapshot", async () => {
  const fixtures = createDashboardContractFixtures();
  const { backend } = fakeBackend({ initialEvents: [fixtures.streamReplayGap.gap] });
  const peer = connect(backend);
  await hello(peer);
  await subscribe(peer, { cursor: fixtures.streamReplayGap.gap.requestedCursor });
  const kinds = peer.sent.slice(1).map((frame) => frame.kind);
  assert.deepEqual(kinds, ["replay_gap", "subscription_ready"]);
  assert.equal(peer.sent.at(-1).snapshot.highWaterCursor, fixtures.streamReady.snapshot.highWaterCursor);
});

test("malformed, unauthenticated identity and channel-limit failures are isolated", async () => {
  const { backend, calls } = fakeBackend();
  const peer = connect(backend);
  await peer.receive("{");
  assert.equal(peer.sent.at(-1).error.code, "invalid_json");
  await peer.receive({ ...base("hello", "wrong-client", { requestedVersion: "1.0" }), clientId: "other-client" });
  assert.equal(peer.sent.at(-1).error.code, "identity_mismatch");
  await hello(peer);
  await subscribe(peer);
  await peer.receive(base("subscribe", "subscribe-2", {
    subscriptionId: "pane-2", presentation: "rich", sessionRef: "session-fixture-01", role: "observer",
  }));
  await peer.receive(base("subscribe", "subscribe-3", {
    subscriptionId: "pane-3", presentation: "rich", sessionRef: "session-fixture-01", role: "observer",
  }));
  assert.equal(peer.sent.at(-1).error.code, "subscription_capacity");
  await peer.receive(base("command", "bad-command", { subscriptionId: "pane-1", operation: "not-a-command", credential: "must-not-reach-backend" }));
  assert.equal(peer.sent.at(-1).error.code, "invalid_frame");
  assert.equal(calls.filter(([kind]) => kind === "command").length, 0);
  assert.deepEqual(peer.closeCalls, []);
});

test("slow backend work is bounded, does not block control frames, and is never replayed", async () => {
  let release;
  let commandCalls = 0;
  const slow = new Promise((resolve) => { release = resolve; });
  const { backend } = fakeBackend({
    backend: {
      async openSessionChannel(options) {
        const { backend: inner } = fakeBackend();
        const channel = await inner.openSessionChannel(options);
        channel.command = async (command) => { commandCalls += 1; await slow; return { correlationId: command.correlationId, state: "completed" }; };
        return channel;
      },
    },
  });
  const peer = connect(backend);
  await hello(peer);
  await subscribe(peer);
  await peer.receive(base("command", "slow-1", { subscriptionId: "pane-1", operation: "get_state" }));
  await peer.receive(base("control", "over-capacity", { subscriptionId: "pane-1", action: "request" }));
  assert.equal(peer.sent.at(-1).error.code, "command_capacity");
  peer.disconnect();
  release();
  await settle();
  assert.equal(commandCalls, 1);
  assert.equal(peer.sent.some((frame) => frame.correlationId === "slow-1" && frame.kind === "command_result"), false);
});

test("TUI input/resize are validated and socket close tears every channel down", async () => {
  const tuiCalls = [];
  const fixtures = createDashboardContractFixtures();
  const identity = fixtures.streamReady.identity;
  const channels = [];
  const { backend } = fakeBackend({
    backend: {
      async openTuiChannel(options) {
        const channel = {
          presentation: "tui", identity, role: "controller", closed: 0,
          snapshot: { ...fixtures.streamTuiDelta.delta, rows: [], cursor: fixtures.streamTuiDelta.delta.cursorState, highWaterCursor: fixtures.streamTuiDelta.delta.cursor },
          async resize(value) { tuiCalls.push(["resize", value]); },
          async sendInput(value) { tuiCalls.push(["input", value]); },
          async requestControl(correlationId) { return { correlationId, state: "completed" }; },
          async releaseControl(correlationId) { return { correlationId, state: "completed" }; },
          subscribe() { return () => {}; },
          async close() { channel.closed += 1; },
        };
        channels.push(channel);
        return channel;
      },
    },
  });
  const peer = connect(backend);
  await hello(peer);
  await subscribe(peer, { presentation: "tui", tuiDimensions: { rows: 24, columns: 80 } });
  await peer.receive(base("tui_resize", "resize-1", { subscriptionId: "pane-1", dimensions: { rows: 30, columns: 100 } }));
  await peer.receive(base("tui_input", "input-1", { subscriptionId: "pane-1", input: { type: "key", key: "Enter", modifiers: ["ctrl"] } }));
  assert.deepEqual(tuiCalls, [["resize", { rows: 30, columns: 100 }], ["input", { type: "key", key: "Enter", modifiers: ["ctrl"] }]]);
  await peer.receive(base("tui_resize", "resize-bad", { subscriptionId: "pane-1", dimensions: { rows: 999, columns: 80 } }));
  assert.equal(peer.sent.at(-1).error.code, "invalid_frame");
  peer.disconnect();
  await settle();
  assert.equal(channels[0].closed, 1);
});
