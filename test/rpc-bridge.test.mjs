import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";

import { ServiceBearerAuthenticator } from "../dist/api-auth.js";
import { ApiServer } from "../dist/api-server.js";
import { Multiplexer } from "../dist/multiplexer.js";
import { RpcStdioBridge } from "../dist/rpc-bridge.js";
import { FileSessionCatalog } from "../dist/session-catalog.js";

const TOKEN = "rpc-bridge-fixture-token-0123456789";

class FakeController {
  listeners = new Set();
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
    if (command.type === "prompt") return await new Promise(() => {});
    return {
      type: "response",
      command: typeof command.type === "string" ? command.type : "unknown",
      success: true,
      ...(typeof command.id === "string" ? { id: command.id } : {}),
      data: { sessionId: "pi-bridge", echoed: command.marker ?? null },
    };
  }

  snapshot() {
    return {
      rpcState: { sessionId: "pi-bridge", isStreaming: false },
      leafId: "leaf-bridge",
    };
  }

  respondToExtensionUi() {
    return true;
  }

  cancelPendingUi() {}
}

class FakeAdapter {
  constructor(controller) {
    this.controller = controller;
  }
  identity() {
    return { sessionId: "pi-bridge" };
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
  controllers = [];
  async open() {
    const controller = new FakeController();
    this.controllers.push(controller);
    return new FakeAdapter(controller);
  }
}

const openCommand = (generation, requestId = `open-${generation}`) => ({
  protocolVersion: "1.0",
  kind: "command",
  requestId,
  operation: "open",
  sessionId: "rpc-session",
  generation,
  payload: {
    cwd: "/work/rpc-session",
    name: "rpc-bridge-name",
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

async function startHarness(t) {
  const stateDir = await mkdtemp(join(tmpdir(), "pi-daemon-rpc-bridge-"));
  t.after(async () => rm(stateDir, { recursive: true, force: true }));
  const factory = new FakeFactory();
  const multiplexer = new Multiplexer({
    factory,
    catalog: new FileSessionCatalog({ stateDir }),
    hostInstanceId: `host-${randomBytes(4).toString("hex")}`,
  });
  await multiplexer.recover();
  await multiplexer.open(openCommand(1));
  const server = new ApiServer({
    multiplexer,
    authenticator: new ServiceBearerAuthenticator(TOKEN),
    host: "::1",
    port: 0,
  });
  const address = await server.start();
  t.after(async () => {
    await server.stop();
    await multiplexer.dispose(1_000);
  });
  return { factory, multiplexer, address };
}

function streamValues(stream) {
  let text = "";
  const values = [];
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    text += chunk;
    while (true) {
      const newline = text.indexOf("\n");
      if (newline < 0) break;
      const line = text.slice(0, newline);
      text = text.slice(newline + 1);
      if (line !== "") values.push(JSON.parse(line));
    }
  });
  return values;
}

async function waitFor(predicate, message) {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${message}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

function apiUrl(address) {
  const host = address.host.includes(":") ? `[${address.host}]` : address.host;
  return `http://${host}:${address.port}`;
}

function createBridge(address, input, output, status, limits, sessionRef = "rpc-session") {
  return new RpcStdioBridge({
    baseUrl: apiUrl(address),
    sessionRef,
    bearerToken: TOKEN,
    input,
    output,
    statusOutput: status,
    limits: {
      reconnectAttempts: 20,
      reconnectBaseDelayMs: 5,
      reconnectMaxDelayMs: 20,
      ...limits,
    },
  });
}

test("framed remote attachment translates stock Pi RPC JSONL on stdio", async (t) => {
  const harness = await startHarness(t);
  const input = new PassThrough();
  const output = new PassThrough();
  const status = new PassThrough();
  const outputValues = streamValues(output);
  const statusValues = streamValues(status);
  const bridge = createBridge(
    harness.address,
    input,
    output,
    status,
    undefined,
    "rpc-bridge-name",
  );
  const running = bridge.run();

  await waitFor(
    () => statusValues.some((value) => value.event === "attached"),
    "bridge attachment",
  );
  input.write(`${JSON.stringify({ type: "get_state", id: "request-1", marker: "one" })}\n`);
  await waitFor(() => outputValues.some((value) => value.id === "request-1"), "RPC response");
  assert.deepEqual(outputValues.find((value) => value.id === "request-1"), {
    type: "response",
    command: "get_state",
    success: true,
    id: "request-1",
    data: { sessionId: "pi-bridge", echoed: "one" },
  });

  harness.factory.controllers[0].emit({ type: "agent_start" });
  await waitFor(
    () => outputValues.some((value) => value.type === "agent_start"),
    "raw session event",
  );
  input.end();
  const result = await running;
  assert.equal(result.code, 0);
  assert.equal(result.gaps, 0);
  assert.equal(typeof result.lastCursor, "string");
  assert.ok(result.lastCursor.length > 16);
});

test("bridge reconnects by cursor, reports a generation gap, and does not replay sent commands", async (t) => {
  const harness = await startHarness(t);
  const input = new PassThrough();
  const output = new PassThrough();
  const status = new PassThrough();
  const outputValues = streamValues(output);
  const statusValues = streamValues(status);
  const bridge = createBridge(harness.address, input, output, status, {
    reconnectAttempts: 20,
  });
  const running = bridge.run();
  await waitFor(
    () => statusValues.some((value) => value.event === "attached"),
    "initial attachment",
  );

  input.write(`${JSON.stringify({ type: "get_state", id: "before-replace" })}\n`);
  await waitFor(
    () => outputValues.some((value) => value.id === "before-replace"),
    "initial response",
  );
  await harness.multiplexer.close({
    protocolVersion: "1.0",
    requestId: "replace-close",
    operation: "close",
    sessionId: "rpc-session",
    generation: 1,
    payload: { retainSession: true },
  });
  await harness.multiplexer.open(openCommand(2, "replace-open"));
  await waitFor(
    () => statusValues.some((value) => value.event === "replay_gap"),
    "generation replay gap",
  );
  assert.equal(
    statusValues.find((value) => value.event === "replay_gap").reason,
    "generation_changed",
  );
  await waitFor(
    () => statusValues.filter((value) => value.event === "attached").length >= 2,
    "replacement attachment",
  );

  input.write(`${JSON.stringify({ type: "get_state", id: "after-replace" })}\n`);
  await waitFor(
    () => outputValues.some((value) => value.id === "after-replace"),
    "replacement response",
  );
  input.end();
  const result = await running;
  assert.equal(result.code, 0);
  assert.equal(result.gaps, 1);
  assert.ok(result.reconnects >= 1);
  assert.equal(harness.factory.controllers[0].calls.length, 1);
  assert.equal(harness.factory.controllers[1].calls.length, 1);
});

test("disconnect marks accepted in-flight commands indeterminate instead of replaying them", async (t) => {
  const harness = await startHarness(t);
  const input = new PassThrough();
  const output = new PassThrough();
  const status = new PassThrough();
  const outputValues = streamValues(output);
  const statusValues = streamValues(status);
  const bridge = createBridge(harness.address, input, output, status, {
    reconnectAttempts: 20,
  });
  const running = bridge.run();
  await waitFor(
    () => statusValues.some((value) => value.event === "attached"),
    "initial attachment",
  );
  input.write(`${JSON.stringify({ type: "prompt", id: "accepted-prompt", message: "bounded" })}\n`);
  await waitFor(
    () => harness.factory.controllers[0].calls.some((value) => value.id === "accepted-prompt"),
    "accepted command",
  );
  await harness.multiplexer.close({
    protocolVersion: "1.0",
    requestId: "indeterminate-close",
    operation: "close",
    sessionId: "rpc-session",
    generation: 1,
    payload: { retainSession: true },
  });
  await harness.multiplexer.open(openCommand(2, "indeterminate-open"));
  await waitFor(
    () => outputValues.some((value) => value.id === "accepted-prompt"),
    "indeterminate response",
  );
  assert.deepEqual(outputValues.find((value) => value.id === "accepted-prompt"), {
    type: "response",
    command: "prompt",
    success: false,
    error: "connection_lost_indeterminate",
    id: "accepted-prompt",
  });
  await waitFor(
    () => statusValues.filter((value) => value.event === "attached").length >= 2,
    "replacement attachment",
  );
  input.end();
  const result = await running;
  assert.equal(result.code, 0);
  assert.equal(harness.factory.controllers[0].calls.length, 1);
  assert.equal(harness.factory.controllers[1].calls.length, 0);
});

test("stdin EOF applies a terminal deadline to uncompleted RPC commands", async (t) => {
  const harness = await startHarness(t);
  const input = new PassThrough();
  const output = new PassThrough();
  const status = new PassThrough();
  const outputValues = streamValues(output);
  const statusValues = streamValues(status);
  const bridge = createBridge(harness.address, input, output, status, {
    terminalDrainTimeoutMs: 25,
  });
  const running = bridge.run();
  await waitFor(
    () => statusValues.some((value) => value.event === "attached"),
    "terminal attachment",
  );
  input.end(`${JSON.stringify({ type: "prompt", id: "hung-prompt", message: "bounded" })}\n`);
  const result = await running;
  assert.equal(result.code, 1);
  assert.deepEqual(outputValues.find((value) => value.id === "hung-prompt"), {
    type: "response",
    command: "prompt",
    success: false,
    error: "bridge_failed_indeterminate",
    id: "hung-prompt",
  });
  assert.equal(
    statusValues.some(
      (value) => value.event === "fatal" && /deadline/.test(value.message),
    ),
    true,
  );
});

test("pi-daemon-rpc subprocess behaves like stock Pi RPC stdio", async (t) => {
  const harness = await startHarness(t);
  const child = spawn(
    process.execPath,
    [
      new URL("../dist/rpc-stdio-cli.js", import.meta.url).pathname,
      "--url",
      apiUrl(harness.address),
      "--session",
      "rpc-session",
    ],
    {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PI_DAEMON_BEARER_TOKEN: TOKEN },
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  child.stdin.end(
    await readFile(new URL("../fixtures/pi-rpc-stdio/pico.input.jsonl", import.meta.url)),
  );
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  assert.equal(code, 0);
  const response = JSON.parse(stdout.trim());
  const expected = JSON.parse(
    await readFile(
      new URL("../fixtures/pi-rpc-stdio/pico.expected.json", import.meta.url),
      "utf8",
    ),
  );
  assert.deepEqual(
    Object.fromEntries(Object.keys(expected).map((key) => [key, response[key]])),
    expected,
  );
  assert.deepEqual(response.data, { sessionId: "pi-bridge", echoed: null });
  assert.match(stderr, /"event":"attached"/);
  assert.equal(stderr.includes(TOKEN), false);
});

test("blocked stdout is abandoned on a bounded terminal flush deadline", async (t) => {
  const harness = await startHarness(t);
  const input = new PassThrough();
  const output = new Writable({
    highWaterMark: 1,
    write(_chunk, _encoding, _callback) {
      // Deliberately never acknowledge the write.
    },
  });
  const status = new PassThrough();
  const statusValues = streamValues(status);
  const bridge = createBridge(harness.address, input, output, status, {
    outputDrainTimeoutMs: 25,
  });
  const running = bridge.run();
  await waitFor(
    () => statusValues.some((value) => value.event === "attached"),
    "blocked-output attachment",
  );
  input.end(`${JSON.stringify({ type: "get_state", id: "blocked-output" })}\n`);
  const result = await running;
  assert.equal(result.code, 1);
});

test("bridge refuses to transmit a bearer over implicit remote plaintext", () => {
  assert.throws(
    () =>
      new RpcStdioBridge({
        baseUrl: "http://192.0.2.10:7463",
        sessionRef: "rpc-session",
        bearerToken: TOKEN,
        input: new PassThrough(),
        output: new PassThrough(),
      }),
    /allowInsecureRemote/,
  );
  assert.doesNotThrow(
    () =>
      new RpcStdioBridge({
        baseUrl: "http://192.0.2.10:7463",
        sessionRef: "rpc-session",
        bearerToken: TOKEN,
        input: new PassThrough(),
        output: new PassThrough(),
        allowInsecureRemote: true,
      }),
  );
});

test("bridge rejects invalid input and never writes bearer values", async (t) => {
  const harness = await startHarness(t);
  const input = new PassThrough();
  const output = new PassThrough();
  const status = new PassThrough();
  const outputValues = streamValues(output);
  const statusValues = streamValues(status);
  const bridge = createBridge(harness.address, input, output, status, {
    maxLineBytes: 64,
    maxPendingBytes: 128,
  });
  const running = bridge.run();
  input.end(`${"x".repeat(65)}\n`);
  const result = await running;
  assert.equal(result.code, 1);
  assert.deepEqual(outputValues, []);
  assert.equal(statusValues.some((value) => value.event === "fatal"), true);
  assert.equal(JSON.stringify(statusValues).includes(TOKEN), false);
});
