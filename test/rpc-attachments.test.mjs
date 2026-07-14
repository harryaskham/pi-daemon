import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ServiceBearerAuthenticator } from "../dist/api-auth.js";
import { ApiServer } from "../dist/api-server.js";
import { Multiplexer } from "../dist/multiplexer.js";
import { FileSessionCatalog } from "../dist/session-catalog.js";

const TOKEN = "fixture-service-bearer-0123456789";

class FakeController {
  listeners = new Set();
  uiResponses = [];
  cancelledUi = 0;
  calls = [];

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event) {
    for (const listener of this.listeners) listener(event);
  }

  async handle(command) {
    this.calls.push(command);
    if (command.type === "get_state") {
      return {
        type: "response",
        command: "get_state",
        success: true,
        ...(command.id === undefined ? {} : { id: command.id }),
        data: { sessionId: "pi-fixture", source: command.source ?? null },
      };
    }
    if (command.type === "get_entries") {
      return {
        type: "response",
        command: "get_entries",
        success: true,
        ...(command.id === undefined ? {} : { id: command.id }),
        data: { entries: [], leafId: "leaf-1" },
      };
    }
    return {
      type: "response",
      command: typeof command.type === "string" ? command.type : "unknown",
      success: true,
      ...(command.id === undefined ? {} : { id: command.id }),
      data: { source: command.source ?? null },
    };
  }

  snapshot() {
    return {
      rpcState: { sessionId: "pi-fixture", isStreaming: false },
      leafId: "leaf-1",
    };
  }

  respondToExtensionUi(response) {
    this.uiResponses.push(response);
    return response.id === "ui-1";
  }

  cancelPendingUi() {
    this.cancelledUi += 1;
  }
}

class FakeAdapter {
  constructor(controller) {
    this.controller = controller;
  }
  identity() {
    return { sessionId: "pi-fixture" };
  }
  async rpcController() {
    return this.controller;
  }
  async prompt() {
    return { text: "ok" };
  }
  async dispose() {}
}

class FakeFactory {
  controllers = new Map();
  async open(request) {
    const controller = new FakeController();
    this.controllers.set(request.sessionId, controller);
    return new FakeAdapter(controller);
  }
}

async function startHarness(t, rpcLimits) {
  const stateDir = await mkdtemp(join(tmpdir(), "pi-daemon-rpc-attach-"));
  t.after(async () => rm(stateDir, { recursive: true, force: true }));
  const factory = new FakeFactory();
  const multiplexer = new Multiplexer({
    factory,
    catalog: new FileSessionCatalog({ stateDir }),
    hostInstanceId: `host-${randomBytes(4).toString("hex")}`,
  });
  await multiplexer.recover();
  await multiplexer.open({
    protocolVersion: "1.0",
    kind: "command",
    requestId: "open-rpc-session",
    operation: "open",
    sessionId: "rpc-session",
    generation: 1,
    payload: {
      cwd: "/work/rpc-session",
      session: { mode: "memory" },
      resources: {
        extensions: "none",
        skills: "none",
        promptTemplates: "none",
        themes: "none",
        contextFiles: "none",
        tools: "none",
      },
    },
  });
  const server = new ApiServer({
    multiplexer,
    authenticator: new ServiceBearerAuthenticator(TOKEN),
    host: "127.0.0.1",
    port: 0,
    rpcLimits,
  });
  const address = await server.start();
  t.after(async () => {
    await server.stop();
    await multiplexer.dispose(1_000);
  });
  return {
    server,
    multiplexer,
    controller: factory.controllers.get("rpc-session"),
    address,
  };
}

class TestWebSocket {
  #socket;
  #buffer;
  #messages = [];
  #waiters = [];
  #closed = false;

  constructor(socket, initial) {
    this.#socket = socket;
    this.#buffer = initial;
    socket.on("data", (chunk) => {
      this.#buffer = Buffer.concat([this.#buffer, chunk]);
      this.#parse();
    });
    socket.on("close", () => this.#finish());
    socket.on("end", () => this.#finish());
    this.#parse();
  }

  send(value) {
    const payload = Buffer.from(JSON.stringify(value), "utf8");
    this.#socket.write(maskedFrame(0x1, payload));
  }

  sendRaw(value) {
    this.#socket.write(value);
  }

  async next(timeoutMs = 2_000) {
    if (this.#messages.length > 0) return this.#messages.shift();
    if (this.#closed) throw new Error("WebSocket closed");
    return new Promise((resolve, reject) => {
      let timer;
      const waiter = {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject,
      };
      timer = setTimeout(() => {
        const index = this.#waiters.indexOf(waiter);
        if (index >= 0) this.#waiters.splice(index, 1);
        reject(new Error("timed out waiting for WebSocket frame"));
      }, timeoutMs);
      this.#waiters.push(waiter);
    });
  }

  async expectNoMessage(timeoutMs = 75) {
    await assert.rejects(this.next(timeoutMs), /timed out/);
  }

  async waitClosed(timeoutMs = 2_000) {
    if (this.#closed) return;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for WebSocket close")), timeoutMs);
      const done = () => {
        clearTimeout(timer);
        resolve();
      };
      this.#socket.once("close", done);
      this.#socket.once("end", done);
    });
  }

  pause() {
    this.#socket.pause();
  }

  resume() {
    this.#socket.resume();
  }

  close() {
    if (this.#closed) return;
    this.#socket.write(maskedFrame(0x8, Buffer.from([0x03, 0xe8])));
    this.#socket.end();
  }

  terminate() {
    this.#socket.destroy();
  }

  #parse() {
    while (this.#buffer.length >= 2) {
      const first = this.#buffer[0];
      const opcode = first & 0x0f;
      let length = this.#buffer[1] & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.#buffer.length < 4) return;
        length = this.#buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.#buffer.length < 10) return;
        assert.equal(this.#buffer.readUInt32BE(2), 0);
        length = this.#buffer.readUInt32BE(6);
        offset = 10;
      }
      if (this.#buffer.length < offset + length) return;
      const payload = this.#buffer.subarray(offset, offset + length);
      this.#buffer = this.#buffer.subarray(offset + length);
      if (opcode === 0x9) {
        this.#socket.write(maskedFrame(0x0a, payload));
        continue;
      }
      if (opcode === 0x8) {
        this.#finish();
        continue;
      }
      if (opcode !== 0x1) continue;
      this.#deliver(JSON.parse(payload.toString("utf8")));
    }
  }

  #deliver(value) {
    const waiter = this.#waiters.shift();
    if (waiter === undefined) this.#messages.push(value);
    else waiter.resolve(value);
  }

  #finish() {
    if (this.#closed) return;
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) waiter.reject(new Error("WebSocket closed"));
  }
}

async function connectWebSocket(address, options = {}) {
  const protocol = options.protocol ?? "pi-daemon-rpc.v1";
  const query = new URLSearchParams();
  if (options.role !== undefined) query.set("role", options.role);
  if (options.cursor !== undefined) query.set("cursor", options.cursor);
  if (options.generation !== undefined) query.set("generation", String(options.generation));
  const suffix = query.size === 0 ? "" : `?${query}`;
  const path = `/v1/session/rpc-session/rpc${suffix}`;
  const socket = createConnection(address.port, address.host);
  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  const key = randomBytes(16).toString("base64");
  socket.write(
    [
      `GET ${path} HTTP/1.1`,
      `Host: ${address.host}:${address.port}`,
      "Upgrade: websocket",
      "Connection: Upgrade",
      "Sec-WebSocket-Version: 13",
      `Sec-WebSocket-Key: ${key}`,
      `Sec-WebSocket-Protocol: ${protocol}`,
      `Authorization: Bearer ${options.token ?? TOKEN}`,
      "",
      "",
    ].join("\r\n"),
  );
  const response = await readHandshake(socket);
  if (response.status !== 101) {
    socket.destroy();
    return response;
  }
  return {
    ...response,
    websocket: new TestWebSocket(socket, response.leftover),
  };
}

async function readHandshake(socket) {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const boundary = buffer.indexOf("\r\n\r\n");
      if (boundary < 0) return;
      const header = buffer.subarray(0, boundary).toString("utf8");
      const lines = header.split("\r\n");
      const status = Number(lines[0].split(" ")[1]);
      const headers = Object.fromEntries(
        lines.slice(1).map((line) => {
          const index = line.indexOf(":");
          return [line.slice(0, index).toLowerCase(), line.slice(index + 1).trim()];
        }),
      );
      const length = Number(headers["content-length"] ?? 0);
      const bodyStart = boundary + 4;
      if (status !== 101 && buffer.length < bodyStart + length) return;
      socket.off("data", onData);
      socket.off("error", onError);
      const body = buffer.subarray(bodyStart, bodyStart + length);
      resolve({
        status,
        headers,
        body: body.length === 0 ? undefined : JSON.parse(body.toString("utf8")),
        leftover: buffer.subarray(status === 101 ? bodyStart : bodyStart + length),
      });
    };
    const onError = (error) => {
      socket.off("data", onData);
      reject(error);
    };
    socket.on("data", onData);
    socket.once("error", onError);
  });
}

function maskedFrame(opcode, payload) {
  const mask = randomBytes(4);
  let header;
  if (payload.length < 126) {
    header = Buffer.from([0x80 | opcode, 0x80 | payload.length]);
  } else if (payload.length <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 127;
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(payload.length, 6);
  }
  const masked = Buffer.from(payload);
  for (let index = 0; index < masked.length; index += 1) masked[index] ^= mask[index % 4];
  return Buffer.concat([header, mask, masked]);
}

async function ready(connection) {
  assert.equal(connection.status, 101);
  const frame = await connection.websocket.next();
  assert.equal(frame.kind, "attach_ready");
  return frame;
}

test("framed attachments route colliding responses privately and replay broadcast events", async (t) => {
  const harness = await startHarness(t);
  const controllerConnection = await connectWebSocket(harness.address, { role: "controller" });
  const observerConnection = await connectWebSocket(harness.address, { role: "observer" });
  const controllerReady = await ready(controllerConnection);
  const observerReady = await ready(observerConnection);
  assert.equal(controllerReady.role, "controller");
  assert.equal(observerReady.role, "observer");
  assert.equal(controllerReady.snapshot.leafId, "leaf-1");
  assert.equal(controllerReady.snapshot.requestState.sessionId, "rpc-session");
  assert.equal(controllerReady.snapshot.requestState.queuedTurns, 0);

  controllerConnection.websocket.send({
    kind: "command",
    command: { id: "same", type: "get_state", source: "controller" },
  });
  observerConnection.websocket.send({
    kind: "command",
    command: { id: "same", type: "get_state", source: "observer" },
  });
  const controllerResponse = await controllerConnection.websocket.next();
  const observerResponse = await observerConnection.websocket.next();
  assert.equal(controllerResponse.response.data.source, "controller");
  assert.equal(observerResponse.response.data.source, "observer");
  await controllerConnection.websocket.expectNoMessage();
  await observerConnection.websocket.expectNoMessage();

  observerConnection.websocket.send({
    kind: "command",
    command: { id: "denied", type: "prompt", message: "no" },
  });
  assert.equal((await observerConnection.websocket.next()).response.error, "controller_required");

  harness.controller.emit({ type: "message_update", delta: "one" });
  const firstControllerEvent = await controllerConnection.websocket.next();
  const firstObserverEvent = await observerConnection.websocket.next();
  assert.equal(firstControllerEvent.sequence, 1);
  assert.equal(firstObserverEvent.cursor, firstControllerEvent.cursor);

  observerConnection.websocket.terminate();
  harness.controller.emit({ type: "agent_settled", marker: "two" });
  const secondControllerEvent = await controllerConnection.websocket.next();
  assert.equal(secondControllerEvent.sequence, 2);

  const reconnected = await connectWebSocket(harness.address, {
    role: "observer",
    cursor: firstObserverEvent.cursor,
  });
  const reconnectReady = await ready(reconnected);
  assert.equal(reconnectReady.highWaterCursor.length > 0, true);
  const replayed = await reconnected.websocket.next();
  assert.equal(replayed.sequence, 2);
  assert.equal(replayed.event.marker, "two");
  await reconnected.websocket.expectNoMessage();

  controllerConnection.websocket.close();
  reconnected.websocket.close();
  assert.equal(harness.multiplexer.status("rpc-session").state, "idle");
});

test("controller ownership and extension UI use explicit first-controller semantics", async (t) => {
  const harness = await startHarness(t);
  const first = await connectWebSocket(harness.address, { role: "controller" });
  const second = await connectWebSocket(harness.address, { role: "controller" });
  assert.equal((await ready(first)).role, "controller");
  assert.equal((await ready(second)).role, "observer");
  const denied = await second.websocket.next();
  assert.equal(denied.action, "control_denied");
  second.websocket.send({ kind: "control", action: "request_control" });
  assert.equal((await second.websocket.next()).action, "control_denied");

  first.websocket.terminate();
  second.websocket.send({ kind: "control", action: "request_control" });
  assert.equal((await second.websocket.next()).action, "control_granted");

  const observer = await connectWebSocket(harness.address, { role: "observer" });
  await ready(observer);
  harness.controller.emit({
    type: "extension_ui_request",
    id: "ui-1",
    method: "confirm",
    title: "Confirm",
    message: "Proceed?",
  });
  assert.equal((await second.websocket.next()).event.type, "extension_ui_request");
  assert.equal((await observer.websocket.next()).event.type, "extension_ui_request");
  observer.websocket.send({
    kind: "extension_ui_response",
    response: { type: "extension_ui_response", id: "ui-1", confirmed: false },
  });
  assert.equal((await observer.websocket.next()).response.error, "controller_required");
  second.websocket.send({
    kind: "extension_ui_response",
    response: { type: "extension_ui_response", id: "ui-1", confirmed: true },
  });
  assert.equal((await second.websocket.next()).response.success, true);
  assert.deepEqual(harness.controller.uiResponses, [
    { type: "extension_ui_response", id: "ui-1", confirmed: true },
  ]);
  second.websocket.send({ kind: "control", action: "release_control" });
  assert.equal((await second.websocket.next()).action, "release_control");
  second.websocket.send({ kind: "control", action: "request_control" });
  assert.equal((await second.websocket.next()).action, "control_granted");

  harness.controller.emit({
    type: "extension_ui_request",
    id: "ui-pending",
    method: "input",
    title: "Pending",
  });
  await second.websocket.next();
  await observer.websocket.next();
  second.websocket.terminate();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(harness.controller.cancelledUi >= 1);
  observer.websocket.close();
});

test("raw compatibility is live-only and rejects a second requested controller", async (t) => {
  const harness = await startHarness(t);
  const first = await connectWebSocket(harness.address, {
    protocol: "pi-rpc.v1",
    role: "controller",
  });
  assert.equal(first.status, 101);
  const second = await connectWebSocket(harness.address, {
    protocol: "pi-rpc.v1",
    role: "controller",
  });
  assert.equal(second.status, 409);
  assert.equal(second.body.error.code, "controller_busy");

  first.websocket.send({ id: "raw-state", type: "get_state", source: "raw" });
  const response = await first.websocket.next();
  assert.equal(response.type, "response");
  assert.equal(response.data.source, "raw");
  harness.controller.emit({ type: "agent_settled" });
  assert.deepEqual(await first.websocket.next(), { type: "agent_settled" });
  const observer = await connectWebSocket(harness.address, {
    protocol: "pi-rpc.v1",
    role: "observer",
  });
  assert.equal(observer.status, 101);
  observer.websocket.send({ id: "raw-denied", type: "prompt", message: "no" });
  assert.equal((await observer.websocket.next()).error, "controller_required");
  observer.websocket.close();
  first.websocket.close();
});

test("expired, prior-host, and prior-generation cursors emit gaps before fresh snapshots", async (t) => {
  const harness = await startHarness(t, { maxReplayEvents: 2 });
  const first = await connectWebSocket(harness.address, { role: "observer" });
  const initial = await ready(first);
  first.websocket.terminate();
  for (const marker of [1, 2, 3]) harness.controller.emit({ type: "agent_settled", marker });

  const expired = await connectWebSocket(harness.address, {
    role: "observer",
    cursor: initial.highWaterCursor,
  });
  const expiredGap = await expired.websocket.next();
  assert.equal(expiredGap.kind, "replay_gap");
  assert.equal(expiredGap.reason, "cursor_expired");
  assert.equal((await expired.websocket.next()).kind, "attach_ready");
  expired.websocket.close();

  const decoded = JSON.parse(Buffer.from(initial.highWaterCursor, "base64url").toString("utf8"));
  const wrongHost = Buffer.from(JSON.stringify({ ...decoded, h: "previous-host" })).toString("base64url");
  const hostReconnect = await connectWebSocket(harness.address, { cursor: wrongHost });
  assert.equal((await hostReconnect.websocket.next()).reason, "host_restarted");
  assert.equal((await hostReconnect.websocket.next()).kind, "attach_ready");
  hostReconnect.websocket.close();

  const wrongGeneration = Buffer.from(JSON.stringify({ ...decoded, g: 99 })).toString("base64url");
  const generationReconnect = await connectWebSocket(harness.address, { cursor: wrongGeneration });
  assert.equal((await generationReconnect.websocket.next()).reason, "generation_changed");
  assert.equal((await generationReconnect.websocket.next()).kind, "attach_ready");
  generationReconnect.websocket.close();
});

test("real host restart identity forces a framed replay gap and fresh snapshot", async (t) => {
  const firstHost = await startHarness(t);
  const first = await connectWebSocket(firstHost.address, { role: "observer" });
  const firstReady = await ready(first);
  await firstHost.server.stop();
  await firstHost.multiplexer.dispose(1_000);
  await first.websocket.waitClosed();

  const secondHost = await startHarness(t);
  const reconnected = await connectWebSocket(secondHost.address, {
    role: "observer",
    cursor: firstReady.highWaterCursor,
  });
  const gap = await reconnected.websocket.next();
  assert.equal(gap.kind, "replay_gap");
  assert.equal(gap.reason, "host_restarted");
  const fresh = await reconnected.websocket.next();
  assert.equal(fresh.kind, "attach_ready");
  assert.notEqual(fresh.hostInstanceId, firstReady.hostInstanceId);
  reconnected.websocket.close();
});

test("session replacement detaches old-generation readers without exiting the replacement", async (t) => {
  const harness = await startHarness(t);
  const attached = await connectWebSocket(harness.address, { role: "observer", generation: 1 });
  assert.equal((await ready(attached)).generation, 1);
  await harness.multiplexer.close({
    protocolVersion: "1.0",
    requestId: "replace-close",
    operation: "close",
    sessionId: "rpc-session",
    generation: 1,
    payload: { retainSession: true },
  });
  await attached.websocket.waitClosed();
  await harness.multiplexer.open({
    protocolVersion: "1.0",
    requestId: "replace-open",
    operation: "open",
    sessionId: "rpc-session",
    generation: 2,
    payload: {
      cwd: "/work/rpc-session",
      session: { mode: "memory" },
      resources: {
        extensions: "none",
        skills: "none",
        promptTemplates: "none",
        themes: "none",
        contextFiles: "none",
        tools: "none",
      },
    },
  });
  const replacement = await connectWebSocket(harness.address, {
    role: "observer",
    generation: 2,
  });
  assert.equal((await ready(replacement)).generation, 2);
  assert.equal(harness.multiplexer.status("rpc-session").generation, 2);
  replacement.websocket.close();
});

test("ping keepalive closes a reader that stops returning pong frames", async (t) => {
  const harness = await startHarness(t, { keepAliveMs: 20 });
  const connection = await connectWebSocket(harness.address, { role: "observer" });
  await ready(connection);
  connection.websocket.pause();
  await new Promise((resolve) => setTimeout(resolve, 60));
  connection.websocket.resume();
  await connection.websocket.waitClosed();
  assert.equal(harness.multiplexer.status("rpc-session").state, "idle");
});

test("malformed, unmasked, and oversized client frames close only their reader", async (t) => {
  const harness = await startHarness(t, {
    maxMessageBytes: 4096,
    maxOutboundBytesPerConnection: 8192,
  });
  const unmasked = await connectWebSocket(harness.address, { role: "observer" });
  await ready(unmasked);
  const payload = Buffer.from(JSON.stringify({ kind: "control", action: "request_control" }));
  unmasked.websocket.sendRaw(Buffer.concat([Buffer.from([0x81, payload.length]), payload]));
  await unmasked.websocket.waitClosed();

  const malformed = await connectWebSocket(harness.address, { role: "observer" });
  await ready(malformed);
  malformed.websocket.sendRaw(maskedFrame(0x1, Buffer.from("not-json")));
  await malformed.websocket.waitClosed();

  const oversized = await connectWebSocket(harness.address, { role: "observer" });
  await ready(oversized);
  const header = Buffer.alloc(8);
  header[0] = 0x81;
  header[1] = 0x80 | 126;
  header.writeUInt16BE(4097, 2);
  randomBytes(4).copy(header, 4);
  oversized.websocket.sendRaw(header);
  await oversized.websocket.waitClosed();

  const healthy = await connectWebSocket(harness.address, { role: "observer" });
  assert.equal((await ready(healthy)).snapshot.requestState.sessionId, "rpc-session");
  healthy.websocket.close();
});

test("upgrade auth, generation, subprotocol, and slow-reader failures stay connection-local", async (t) => {
  const harness = await startHarness(t, {
    maxMessageBytes: 4096,
    maxOutboundBytesPerConnection: 4096,
    maxReplayEvents: 16,
    maxReplayBytes: 32 * 1024,
  });
  const denied = await connectWebSocket(harness.address, { token: `${TOKEN}x` });
  assert.equal(denied.status, 401);
  const unsupported = await connectWebSocket(harness.address, { protocol: "unsupported.v1" });
  assert.equal(unsupported.status, 426);
  const stale = await connectWebSocket(harness.address, { generation: 2 });
  assert.equal(stale.status, 409);

  const slow = await connectWebSocket(harness.address, { role: "observer" });
  const healthy = await connectWebSocket(harness.address, { role: "observer" });
  await ready(slow);
  await ready(healthy);
  slow.websocket.pause();
  const healthyReader = (async () => {
    for (let index = 0; index < 10_100; index += 1) {
      const frame = await healthy.websocket.next(10_000);
      if (frame.event?.marker === "healthy") return true;
    }
    return false;
  })();
  for (let index = 0; index < 10_000; index += 1) {
    harness.controller.emit({
      type: "message_update",
      index,
      delta: "x".repeat(2_500),
    });
    if (index % 10 === 0) await new Promise((resolve) => setImmediate(resolve));
  }
  harness.controller.emit({ type: "agent_settled", marker: "healthy" });
  assert.equal(await healthyReader, true);
  slow.websocket.resume();
  await slow.websocket.waitClosed();
  healthy.websocket.close();
});
