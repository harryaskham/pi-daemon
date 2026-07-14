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
const ACP_PROTOCOL = "agent-client-protocol.v1";

class FakeController {
  listeners = new Set();
  calls = [];
  uiResponses = [];
  thinkingLevel = "off";
  model = { provider: "fixture", id: "model-a", name: "Fixture A" };
  holdPrompt = false;

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  emit(event) {
    for (const listener of this.listeners) listener(event);
  }
  snapshot() {
    return { rpcState: this.#state(), leafId: "leaf-1" };
  }
  cancelPendingUi() {}
  respondToExtensionUi(response) {
    this.uiResponses.push(response);
    if (this.holdPrompt) {
      this.holdPrompt = false;
      queueMicrotask(() => this.emit({ type: "agent_settled" }));
    }
    return true;
  }
  async handle(command) {
    this.calls.push(command);
    const ok = (data) => ({
      type: "response",
      command: command.type,
      success: true,
      ...(command.id === undefined ? {} : { id: command.id }),
      ...(data === undefined ? {} : { data }),
    });
    switch (command.type) {
      case "get_state":
        return ok(this.#state());
      case "get_available_models":
        return ok({
          models: [this.model, { provider: "fixture", id: "model-b", name: "Fixture B" }],
        });
      case "get_commands":
        return ok({ commands: [{ name: "fixture-command", description: "Fixture" }] });
      case "get_messages":
        return ok({
          messages: [
            { role: "user", content: "historic user" },
            { role: "assistant", content: [{ type: "text", text: "historic answer" }] },
          ],
        });
      case "set_thinking_level":
        this.thinkingLevel = command.level;
        return ok();
      case "set_model":
        this.model = { provider: command.provider, id: command.modelId, name: "Selected" };
        return ok(this.model);
      case "get_session_stats":
        return ok({ sessionId: "pi-fixture", totalMessages: 2 });
      case "compact":
        return ok({ summary: "compacted", tokensBefore: 10 });
      case "prompt":
        if (!this.holdPrompt) {
          queueMicrotask(() => {
            this.emit({
              type: "message_update",
              assistantMessageEvent: { type: "text_delta", delta: "answer" },
            });
            this.emit({
              type: "message_update",
              assistantMessageEvent: { type: "thinking_delta", delta: "thought" },
            });
            this.emit({
              type: "tool_execution_start",
              toolCallId: "tool-1",
              toolName: "read",
              args: { path: "/work/rpc-session/file.txt" },
            });
            this.emit({
              type: "tool_execution_end",
              toolCallId: "tool-1",
              toolName: "read",
              result: { content: [{ type: "text", text: "file" }] },
              isError: false,
            });
            this.emit({ type: "agent_settled" });
          });
        }
        return ok();
      case "abort":
        this.holdPrompt = false;
        queueMicrotask(() => this.emit({ type: "agent_settled" }));
        return ok();
      default:
        return ok();
    }
  }
  #state() {
    return {
      sessionId: "pi-fixture",
      sessionFile: "/state/fixture.jsonl",
      model: this.model,
      thinkingLevel: this.thinkingLevel,
      isStreaming: this.holdPrompt,
      isCompacting: false,
      steeringMode: "one-at-a-time",
      followUpMode: "one-at-a-time",
      autoCompactionEnabled: true,
      messageCount: 2,
      pendingMessageCount: 0,
    };
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

async function startHarness(t, acpLimits) {
  const stateDir = await mkdtemp(join(tmpdir(), "pi-daemon-acp-"));
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
    requestId: "open-acp-session",
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
    host: "::1",
    port: 0,
    acpLimits,
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
    this.#socket.write(maskedFrame(0x1, Buffer.from(JSON.stringify(value), "utf8")));
  }
  async next(timeoutMs = 2_000) {
    if (this.#messages.length > 0) return this.#messages.shift();
    if (this.#closed) throw new Error("WebSocket closed");
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject };
      const timer = setTimeout(() => {
        const index = this.#waiters.indexOf(waiter);
        if (index >= 0) this.#waiters.splice(index, 1);
        reject(new Error("timed out waiting for WebSocket frame"));
      }, timeoutMs);
      waiter.resolve = (value) => {
        clearTimeout(timer);
        resolve(value);
      };
      this.#waiters.push(waiter);
    });
  }
  close() {
    if (this.#closed) return;
    this.#socket.write(maskedFrame(0x8, Buffer.from([0x03, 0xe8])));
    this.#socket.end();
  }
  #parse() {
    while (this.#buffer.length >= 2) {
      const opcode = this.#buffer[0] & 0x0f;
      let length = this.#buffer[1] & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.#buffer.length < 4) return;
        length = this.#buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.#buffer.length < 10) return;
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
      if (opcode === 0x1) this.#deliver(JSON.parse(payload.toString("utf8")));
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

async function connect(address, options = {}) {
  const socket = await connectWithRetry(address);
  const key = randomBytes(16).toString("base64");
  const query = options.generation === undefined ? "" : `?generation=${options.generation}`;
  socket.write(
    [
      `GET /v1/session/rpc-session/apc${query} HTTP/1.1`,
      `Host: ${address.host}:${address.port}`,
      "Upgrade: websocket",
      "Connection: Upgrade",
      "Sec-WebSocket-Version: 13",
      `Sec-WebSocket-Key: ${key}`,
      `Sec-WebSocket-Protocol: ${options.protocol ?? ACP_PROTOCOL}`,
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
  return { ...response, websocket: new TestWebSocket(socket, response.leftover) };
}

async function connectWithRetry(address) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const socket = createConnection(address.port, address.host);
      await new Promise((resolve, reject) => {
        socket.once("connect", resolve);
        socket.once("error", reject);
      });
      return socket;
    } catch (error) {
      if (
        attempt >= 20 ||
        !(error instanceof Error) ||
        !("code" in error) ||
        !["EADDRNOTAVAIL", "ECONNREFUSED"].includes(error.code)
      ) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
    }
  }
}

async function readHandshake(socket) {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const boundary = buffer.indexOf("\r\n\r\n");
      if (boundary < 0) return;
      const lines = buffer.subarray(0, boundary).toString("utf8").split("\r\n");
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
    const onError = (error) => reject(error);
    socket.on("data", onData);
    socket.once("error", onError);
  });
}

function maskedFrame(opcode, payload) {
  const mask = randomBytes(4);
  let header;
  if (payload.length < 126) {
    header = Buffer.from([0x80 | opcode, 0x80 | payload.length]);
  } else {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
  }
  const masked = Buffer.from(payload);
  for (let index = 0; index < masked.length; index += 1) masked[index] ^= mask[index % 4];
  return Buffer.concat([header, mask, masked]);
}

async function nextResponse(ws, id) {
  while (true) {
    const message = await ws.next();
    if (message.id === id && ("result" in message || "error" in message)) return message;
  }
}

async function request(ws, id, method, params, onServerRequest) {
  ws.send({ jsonrpc: "2.0", id, method, params });
  const notifications = [];
  while (true) {
    const message = await ws.next();
    if (message.id === id && ("result" in message || "error" in message)) {
      return { response: message, notifications };
    }
    if (message.method !== undefined && message.id !== undefined) {
      const result = await onServerRequest?.(message);
      ws.send({ jsonrpc: "2.0", id: message.id, result: result ?? {} });
    } else {
      notifications.push(message);
    }
  }
}

const initializeParams = {
  protocolVersion: 1,
  clientCapabilities: {},
  clientInfo: { name: "fixture-client", version: "1.0.0" },
};

async function initializeAndBind(ws) {
  const initialized = await request(ws, 1, "initialize", initializeParams);
  assert.equal(initialized.response.result.protocolVersion, 1);
  const created = await request(ws, 2, "session/new", {
    cwd: "/work/rpc-session",
    mcpServers: [],
  });
  assert.equal(created.response.result.sessionId, "rpc-session");
  return { initialized, created };
}

test("ACP initialize, scoped new/list/load, config, prompt updates, and builtins use one runtime", async (t) => {
  const harness = await startHarness(t);
  const connected = await connect(harness.address);
  assert.equal(connected.status, 101);
  assert.equal(connected.headers["sec-websocket-protocol"], ACP_PROTOCOL);
  const ws = connected.websocket;
  const { initialized } = await initializeAndBind(ws);
  assert.equal(initialized.response.result.agentInfo.name, "pi-daemon-acp");
  assert.equal(initialized.response.result._meta.piDaemon.wireProtocol, "ACP");

  const listed = await request(ws, 3, "session/list", {});
  assert.equal(listed.response.result.sessions[0].sessionId, "rpc-session");
  const mode = await request(ws, 4, "session/set_mode", {
    sessionId: "rpc-session",
    modeId: "max",
  });
  assert.deepEqual(mode.response.result, {});
  const configured = await request(ws, 5, "session/set_config_option", {
    sessionId: "rpc-session",
    configId: "model",
    value: "fixture/model-b",
  });
  assert.equal(configured.response.result.configOptions[0].currentValue, "fixture/model-b");

  const prompted = await request(ws, 6, "session/prompt", {
    sessionId: "rpc-session",
    prompt: [
      { type: "text", text: "hello" },
      { type: "image", data: "AA==", mimeType: "image/png" },
    ],
  });
  assert.equal(prompted.response.result.stopReason, "end_turn");
  const updates = prompted.notifications
    .filter((message) => message.method === "session/update")
    .map((message) => message.params.update.sessionUpdate);
  assert.ok(updates.includes("agent_message_chunk"));
  assert.ok(updates.includes("agent_thought_chunk"));
  assert.ok(updates.includes("tool_call"));
  assert.ok(updates.includes("tool_call_update"));
  assert.equal(harness.controller.calls.find((command) => command.type === "prompt").images.length, 1);

  const builtin = await request(ws, 7, "session/prompt", {
    sessionId: "rpc-session",
    prompt: [{ type: "text", text: "/session" }],
  });
  assert.equal(builtin.response.result.stopReason, "end_turn");
  assert.equal(harness.controller.calls.some((command) => command.type === "get_session_stats"), true);

  const loaded = await request(ws, 8, "session/load", {
    sessionId: "rpc-session",
    cwd: "/work/rpc-session",
    mcpServers: [],
  });
  assert.ok(loaded.notifications.some((message) => message.params?.update?.sessionUpdate === "user_message_chunk"));
  ws.close();
});

test("ACP permission request routes to the active client and cancellation settles the turn", async (t) => {
  const harness = await startHarness(t);
  const connected = await connect(harness.address);
  const ws = connected.websocket;
  await initializeAndBind(ws);
  harness.controller.holdPrompt = true;
  const permissionHandler = async (message) => {
    assert.equal(message.method, "session/request_permission");
    return { outcome: { outcome: "selected", optionId: "yes" } };
  };
  const promptPromise = request(
    ws,
    10,
    "session/prompt",
    { sessionId: "rpc-session", prompt: [{ type: "text", text: "permission" }] },
    permissionHandler,
  );
  await new Promise((resolve) => setImmediate(resolve));
  harness.controller.emit({
    type: "extension_ui_request",
    id: "ui-1",
    method: "confirm",
    title: "Confirm",
    message: "Proceed?",
  });
  const result = await promptPromise;
  assert.equal(result.response.result.stopReason, "end_turn");
  assert.deepEqual(harness.controller.uiResponses, [
    { type: "extension_ui_response", id: "ui-1", confirmed: true },
  ]);

  harness.controller.holdPrompt = true;
  ws.send({
    jsonrpc: "2.0",
    id: 11,
    method: "session/prompt",
    params: { sessionId: "rpc-session", prompt: [{ type: "text", text: "cancel" }] },
  });
  await new Promise((resolve) => setImmediate(resolve));
  ws.send({
    jsonrpc: "2.0",
    method: "session/cancel",
    params: { sessionId: "rpc-session" },
  });
  const cancelled = await nextResponse(ws, 11);
  assert.equal(cancelled.id, 11);
  assert.equal(cancelled.result.stopReason, "cancelled");
  ws.close();
});

test("ACP multi-client busy behavior, bearer, route, generation, and subprotocol fail closed", async (t) => {
  const harness = await startHarness(t, { maxConnectionsPerHub: 2 });
  const first = await connect(harness.address);
  const second = await connect(harness.address);
  await initializeAndBind(first.websocket);
  await initializeAndBind(second.websocket);
  harness.controller.holdPrompt = true;
  first.websocket.send({
    jsonrpc: "2.0",
    id: 20,
    method: "session/prompt",
    params: { sessionId: "rpc-session", prompt: [{ type: "text", text: "held" }] },
  });
  await new Promise((resolve) => setImmediate(resolve));
  const busy = await request(second.websocket, 21, "session/prompt", {
    sessionId: "rpc-session",
    prompt: [{ type: "text", text: "busy" }],
  });
  assert.ok(busy.response.error);
  first.websocket.send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: "rpc-session" } });
  assert.equal((await nextResponse(first.websocket, 20)).result.stopReason, "cancelled");

  const denied = await connect(harness.address, { token: `${TOKEN}x` });
  assert.equal(denied.status, 401);
  const protocol = await connect(harness.address, { protocol: "not-acp" });
  assert.equal(protocol.status, 426);
  const stale = await connect(harness.address, { generation: 2 });
  assert.equal(stale.status, 409);
  first.websocket.close();
  second.websocket.close();
});
