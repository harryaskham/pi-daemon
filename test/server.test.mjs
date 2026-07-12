import assert from "node:assert/strict";
import { chmod, lstat, mkdtemp } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { PiDaemonClient, ProtocolResponseError } from "../dist/client.js";
import { runCli } from "../dist/cli.js";
import { Multiplexer } from "../dist/multiplexer.js";
import { ProtocolServer } from "../dist/server.js";

const openCommand = (sessionId) => ({
  protocolVersion: "1.0",
  requestId: `open-${sessionId}`,
  operation: "open",
  sessionId,
  generation: 1,
  payload: { cwd: `/work/${sessionId}`, session: { mode: "memory" } },
});

const wakeCommand = (sessionId) => ({
  protocolVersion: "1.0",
  requestId: `wake-${sessionId}`,
  operation: "wake",
  sessionId,
  generation: 1,
  idempotencyKey: `key-${sessionId}`,
  payload: { prompt: `prompt-${sessionId}` },
});

class EventAdapter {
  calls = 0;

  async prompt(request) {
    this.calls += 1;
    request.onEvent({ event: "messageUpdate", data: { delta: request.prompt } });
    return { text: `answer:${request.prompt}` };
  }

  dispose() {}
}

class EventFactory {
  adapters = new Map();

  async open(request) {
    const adapter = new EventAdapter();
    this.adapters.set(request.sessionId, adapter);
    return adapter;
  }
}

const startServer = async (limits) => {
  const directory = await mkdtemp(join(tmpdir(), "pi-daemon-socket-"));
  const socketPath = join(directory, "daemon.sock");
  const factory = new EventFactory();
  const multiplexer = new Multiplexer({ factory, hostInstanceId: "host-test" });
  const server = new ProtocolServer({ socketPath, multiplexer, limits });
  await server.start();
  return { directory, socketPath, factory, multiplexer, server };
};

test("Unix client/server handshake open wake and status round trip", async (t) => {
  const harness = await startServer();
  t.after(async () => harness.server.stop());
  const client = await PiDaemonClient.connect({ socketPath: harness.socketPath });
  t.after(() => client.close());
  const events = [];
  client.subscribe((event) => events.push(event));

  const handshake = await client.handshake("hello");
  assert.equal(handshake.data.protocolVersion, "1.0");
  assert.equal(handshake.data.host.hostInstanceId, "host-test");
  assert.equal(handshake.data.capabilities.transport, "unix-ndjson");

  const opened = await client.request(openCommand("a"));
  assert.equal(opened.data.created, true);
  const wake = await client.request(wakeCommand("a"));
  assert.deepEqual(wake.data.result, { text: "answer:prompt-a" });
  assert.equal(harness.factory.adapters.get("a").calls, 1);
  assert.ok(events.some((event) => event.event === "messageUpdate"));

  const status = await client.request({
    protocolVersion: "1.0",
    requestId: "status-a",
    operation: "status",
    sessionId: "a",
    payload: {},
  });
  assert.equal(status.data.sessionId, "a");
  assert.equal(status.data.state, "idle");
  assert.equal((await lstat(harness.socketPath)).mode & 0o777, 0o600);
});

test("session events are not broadcast to unrelated client connections", async (t) => {
  const harness = await startServer();
  t.after(async () => harness.server.stop());
  const a = await PiDaemonClient.connect({ socketPath: harness.socketPath });
  const b = await PiDaemonClient.connect({ socketPath: harness.socketPath });
  t.after(() => {
    a.close();
    b.close();
  });
  const aEvents = [];
  const bEvents = [];
  a.subscribe((event) => aEvents.push(event));
  b.subscribe((event) => bEvents.push(event));
  await a.request(openCommand("a"));
  await b.request(openCommand("b"));
  aEvents.length = 0;
  bEvents.length = 0;

  await a.request(wakeCommand("a"));
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(aEvents.length > 0);
  assert.equal(bEvents.some((event) => event.sessionId === "a"), false);
});

test("typed server errors reject requests without subscribing the failed client", async (t) => {
  const harness = await startServer();
  t.after(async () => harness.server.stop());
  const failedClient = await PiDaemonClient.connect({ socketPath: harness.socketPath });
  const owner = await PiDaemonClient.connect({ socketPath: harness.socketPath });
  t.after(() => {
    failedClient.close();
    owner.close();
  });
  const leaked = [];
  failedClient.subscribe((event) => leaked.push(event));
  await assert.rejects(
    failedClient.request(wakeCommand("missing")),
    (error) => error instanceof ProtocolResponseError && error.code === "session_not_found",
  );
  await owner.request(openCommand("missing"));
  leaked.length = 0;
  await owner.request(wakeCommand("missing"));
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(leaked.length, 0);
});

test("malformed and oversized NDJSON receive an error then close", async (t) => {
  const harness = await startServer({ maxLineBytes: 64 });
  t.after(async () => harness.server.stop());
  for (const input of ["not-json\n", "x".repeat(65)]) {
    const response = await rawRoundTrip(harness.socketPath, input);
    assert.equal(response.ok, false);
    assert.ok(["invalid_json", "line_too_large"].includes(response.error.code));
  }
});

test("server refuses a group/world-writable socket directory", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-daemon-insecure-socket-"));
  await chmod(directory, 0o777);
  const multiplexer = new Multiplexer({ factory: new EventFactory() });
  const server = new ProtocolServer({
    socketPath: join(directory, "daemon.sock"),
    multiplexer,
  });
  await assert.rejects(server.start(), /must not be group\/world writable/);
});

test("active socket path is never replaced by a second server", async (t) => {
  const first = await startServer();
  t.after(async () => first.server.stop());
  const secondMux = new Multiplexer({ factory: new EventFactory() });
  const second = new ProtocolServer({ socketPath: first.socketPath, multiplexer: secondMux });
  await assert.rejects(second.start(), /socket is already active/);

  const client = await PiDaemonClient.connect({ socketPath: first.socketPath });
  t.after(() => client.close());
  assert.equal((await client.handshake()).ok, true);
});

test("CLI version, probe and low-level request use the same protocol client", async (t) => {
  const harness = await startServer();
  t.after(async () => harness.server.stop());
  const output = [];
  const errors = [];
  const io = { stdout: (text) => output.push(text), stderr: (text) => errors.push(text) };

  assert.equal(await runCli(["version"], io), 0);
  assert.equal(output.pop(), "0.1.0\n");
  assert.equal(await runCli(["probe", "--socket", harness.socketPath], io), 0);
  assert.match(output.pop(), /"protocolVersion": "1.0"/);
  assert.equal(
    await runCli(
      [
        "request",
        "--socket",
        harness.socketPath,
        "--json",
        JSON.stringify(openCommand("cli")),
      ],
      io,
    ),
    0,
  );
  assert.match(output.pop(), /"created": true/);
  assert.deepEqual(errors, []);
});

const rawRoundTrip = async (socketPath, input) => {
  const socket = createConnection(socketPath);
  let buffer = "";
  return new Promise((resolve, reject) => {
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(input));
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline >= 0) {
        const value = JSON.parse(buffer.slice(0, newline));
        socket.destroy();
        resolve(value);
      }
    });
    socket.on("error", reject);
    socket.on("close", () => {
      if (buffer.length === 0) reject(new Error("socket closed without response"));
    });
  });
};
