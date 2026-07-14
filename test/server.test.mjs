import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { PiDaemonClient, ProtocolResponseError } from "../dist/client.js";
import { runCli } from "../dist/cli.js";
import { FileDurabilityStore } from "../dist/durability.js";
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

const attachCommand = (sessionId, operation = "attach", generation = 1) => ({
  protocolVersion: "1.0",
  requestId: `${operation}-${sessionId}-${generation}`,
  operation,
  sessionId,
  generation,
  payload: {},
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

  constructor(sessionId, sessionFile) {
    this.sessionId = sessionId;
    this.sessionFile = sessionFile;
  }

  identity() {
    return {
      sessionId: `pi-${this.sessionId}`,
      ...(this.sessionFile === undefined ? {} : { sessionFile: this.sessionFile }),
    };
  }

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
    const adapter = new EventAdapter(
      request.sessionId,
      request.session.mode === "memory"
        ? undefined
        : `/tmp/pi-daemon-${request.sessionId}.jsonl`,
    );
    this.adapters.set(request.sessionId, adapter);
    return adapter;
  }
}

const startServer = async (limits, factory = new EventFactory()) => {
  const directory = await mkdtemp(join(tmpdir(), "pi-daemon-socket-"));
  const socketPath = join(directory, "daemon.sock");
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
  const attached = await client.request(attachCommand("a"));
  assert.equal(attached.data.attached, true);
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

test("wake can durably acknowledge a prompt ticket without waiting for terminal completion", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "pi-daemon-async-wake-"));
  const socketPath = join(directory, "daemon.sock");
  const factory = new EventFactory();
  const multiplexer = new Multiplexer({
    factory,
    durability: new FileDurabilityStore({ stateDir: join(directory, "state") }),
    hostInstanceId: "host-async-wake",
  });
  await multiplexer.recover();
  const server = new ProtocolServer({ socketPath, multiplexer });
  await server.start();
  t.after(async () => server.stop());
  const client = await PiDaemonClient.connect({ socketPath });
  t.after(() => client.close());
  await client.request({
    ...openCommand("async"),
    payload: {
      ...openCommand("async").payload,
      session: { mode: "new" },
    },
  });

  const admitted = await client.request({
    ...wakeCommand("async"),
    payload: { prompt: "prompt-async", waitForTerminal: false },
  });
  assert.equal(admitted.data.ticket.operation, "prompt");
  assert.ok(["queued", "running", "succeeded"].includes(admitted.data.ticket.state));
  const deadline = Date.now() + 2_000;
  let terminal;
  do {
    terminal = await multiplexer.requestTicket(admitted.data.ticket.ticketId);
    if (terminal?.state === "succeeded") break;
    if (Date.now() > deadline) throw new Error("timed out waiting for prompt ticket");
    await new Promise((resolve) => setTimeout(resolve, 2));
  } while (true);
  assert.deepEqual(terminal.result, { text: "answer:prompt-async" });
  assert.equal(factory.adapters.get("async").calls, 1);
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
  await a.request(attachCommand("a"));
  await b.request(attachCommand("b"));
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
  await owner.request(attachCommand("missing"));
  leaked.length = 0;
  await owner.request(wakeCommand("missing"));
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(leaked.length, 0);
});

test("subscriptions are explicit generation-bound and detachable", async (t) => {
  const harness = await startServer();
  t.after(async () => harness.server.stop());
  const client = await PiDaemonClient.connect({ socketPath: harness.socketPath });
  t.after(() => client.close());
  const events = [];
  client.subscribe((event) => events.push(event));

  await client.request(openCommand("explicit"));
  await client.request({
    protocolVersion: "1.0",
    requestId: "status-explicit",
    operation: "status",
    sessionId: "explicit",
    payload: {},
  });
  await client.request(wakeCommand("explicit"));
  assert.equal(events.length, 0, "open and wake must not create an implicit subscription");

  await assert.rejects(
    client.request(attachCommand("explicit", "attach", 2)),
    (error) => error instanceof ProtocolResponseError && error.code === "stale_generation",
  );
  const attached = await client.request(attachCommand("explicit"));
  assert.equal(attached.data.generation, 1);
  await client.request({
    ...wakeCommand("explicit"),
    requestId: "wake-explicit-attached",
    idempotencyKey: "key-explicit-attached",
  });
  assert.ok(events.some((event) => event.event === "messageUpdate"));

  events.length = 0;
  const detached = await client.request(attachCommand("explicit", "detach"));
  assert.equal(detached.data.detached, true);
  await client.request({
    ...wakeCommand("explicit"),
    requestId: "wake-explicit-detached",
    idempotencyKey: "key-explicit-detached",
  });
  assert.equal(events.length, 0);
});

test("closing a session clears every attachment before an ID and generation can be reused", async (t) => {
  const harness = await startServer();
  t.after(async () => harness.server.stop());
  const owner = await PiDaemonClient.connect({ socketPath: harness.socketPath });
  const observer = await PiDaemonClient.connect({ socketPath: harness.socketPath });
  t.after(() => {
    owner.close();
    observer.close();
  });
  const observed = [];
  observer.subscribe((event) => observed.push(event));

  await owner.request(openCommand("reused"));
  await observer.request(attachCommand("reused"));
  await owner.request({
    protocolVersion: "1.0",
    requestId: "close-reused",
    operation: "close",
    sessionId: "reused",
    generation: 1,
    payload: {},
  });
  assert.ok(observed.some((event) => event.event === "sessionClosed"));

  observed.length = 0;
  await owner.request({ ...openCommand("reused"), requestId: "open-reused-again" });
  await owner.request({
    ...wakeCommand("reused"),
    requestId: "wake-reused-again",
    idempotencyKey: "key-reused-again",
  });
  assert.equal(observed.length, 0);
});

test("oversized and non-serializable events become bounded typed replacements", async (t) => {
  const factory = {
    async open(request) {
      return {
        async prompt(prompt) {
          if (request.sessionId === "oversized") {
            prompt.onEvent({ event: "messageUpdate", data: { delta: "x".repeat(4096) } });
          } else if (request.sessionId === "nonserial") {
            prompt.onEvent({ event: "toolUpdate", data: { value: 1n } });
          } else {
            prompt.onEvent({ event: "messageUpdate", data: { delta: "small" } });
          }
          return { text: "ok" };
        },
        dispose() {},
      };
    },
  };
  const harness = await startServer(
    { maxEventBytes: 512, maxResponseBytes: 1024, maxOutboundBytesPerConnection: 4096 },
    factory,
  );
  t.after(async () => harness.server.stop());
  const client = await PiDaemonClient.connect({ socketPath: harness.socketPath });
  t.after(() => client.close());
  const events = [];
  client.subscribe((event) => events.push(event));

  for (const sessionId of ["oversized", "nonserial"]) {
    await client.request(openCommand(sessionId));
    await client.request(attachCommand(sessionId));
    await client.request(wakeCommand(sessionId));
  }
  const dropped = events.filter((event) => event.event === "eventDropped");
  assert.deepEqual(
    dropped.map((event) => event.data.error.code),
    ["outbound_record_too_large", "outbound_not_serializable"],
  );

  events.length = 0;
  await client.request(openCommand("small"));
  await client.request(attachCommand("small"));
  await client.request(wakeCommand("small"));
  assert.ok(events.some((event) => event.event === "messageUpdate"));
  assert.equal(client.closed, false, "a dropped event must not disrupt other sessions");
});

test("oversized response data becomes a typed error without closing the connection", async (t) => {
  const factory = {
    async open() {
      return {
        async prompt() {
          return { text: "x".repeat(4096) };
        },
        dispose() {},
      };
    },
  };
  const harness = await startServer(
    { maxEventBytes: 1024, maxResponseBytes: 768, maxOutboundBytesPerConnection: 4096 },
    factory,
  );
  t.after(async () => harness.server.stop());
  const client = await PiDaemonClient.connect({ socketPath: harness.socketPath });
  t.after(() => client.close());

  await client.request(openCommand("response"));
  await assert.rejects(
    client.request(wakeCommand("response")),
    (error) =>
      error instanceof ProtocolResponseError && error.code === "outbound_record_too_large",
  );
  const status = await client.request({
    protocolVersion: "1.0",
    requestId: "status-after-overflow",
    operation: "status",
    sessionId: "response",
    payload: {},
  });
  assert.equal(status.data.state, "idle");
  assert.equal(client.closed, false);
});

test("protocol record limits cannot exceed the aggregate outbound queue", () => {
  const multiplexer = new Multiplexer({ factory: new EventFactory() });
  assert.throws(
    () =>
      new ProtocolServer({
        socketPath: "/unused/pi-daemon.sock",
        multiplexer,
        limits: { maxEventBytes: 2048, maxOutboundBytesPerConnection: 1024 },
      }),
    /maxEventBytes must not exceed maxOutboundBytesPerConnection/,
  );
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

test("probe returns temporary failure for degraded provider readiness", async (t) => {
  const factory = new EventFactory();
  factory.readiness = () => ({
    ready: false,
    availableModels: 3,
    authenticatedModels: 0,
    authErrorCount: 1,
    authErrorCodes: ["auth_unavailable"],
  });
  const harness = await startServer(undefined, factory);
  t.after(async () => harness.server.stop());
  const output = [];
  const errors = [];
  const code = await runCli(
    ["probe", "--socket", harness.socketPath, "--timeout-ms", "500"],
    { stdout: (text) => output.push(text), stderr: (text) => errors.push(text) },
  );
  assert.equal(code, 75);
  assert.match(output.join(""), /"ready": false/);
  assert.equal(output.join("").includes("auth.json"), false);
  assert.deepEqual(errors, []);
});

test("client request timeout rejects a hung command without an unbounded waiter", async (t) => {
  const factory = {
    async open() {
      return {
        async prompt() {
          return new Promise(() => {});
        },
        dispose() {},
      };
    },
  };
  const harness = await startServer(undefined, factory);
  t.after(async () => harness.server.stop());
  const client = await PiDaemonClient.connect({
    socketPath: harness.socketPath,
    requestTimeoutMs: 20,
  });
  t.after(() => client.close());
  await client.request(openCommand("hung-client"));
  await assert.rejects(client.request(wakeCommand("hung-client")), /timed out waiting/);
});

test("serve shutdown honors one whole deadline when adapter disposal hangs", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-daemon-shutdown-deadline-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const stateDir = join(root, "state");
  const work = join(root, "work");
  const socketPath = join(root, "daemon.sock");
  await Promise.all([
    mkdir(stateDir, { mode: 0o700 }),
    mkdir(work, { mode: 0o700 }),
  ]);
  const factory = {
    async open(request) {
      return {
        identity() {
          return { sessionId: `pi-${request.sessionId}` };
        },
        async prompt() {
          return { text: "unused" };
        },
        async dispose() {
          return new Promise(() => {});
        },
      };
    },
  };
  const errors = [];
  const started = Date.now();
  const code = await runCli(
    [
      "serve",
      "--socket",
      socketPath,
      "--state-dir",
      stateDir,
      "--allow-root",
      work,
      "--idle-session-ttl-ms",
      "0",
    ],
    { stdout: () => {}, stderr: (text) => errors.push(text) },
    {
      factory,
      waitForShutdown: async (shutdown) => {
        const client = await PiDaemonClient.connect({ socketPath });
        try {
          await client.request({
            ...openCommand("shutdown"),
            payload: { cwd: work, session: { mode: "memory" } },
          });
        } finally {
          client.close();
        }
        await shutdown(20);
      },
    },
  );
  assert.equal(code, 0);
  assert.ok(Date.now() - started < 1_000);
  assert.ok(
    errors.some((line) =>
      ["adapter_dispose_timeout", "host_shutdown_timeout"].includes(
        JSON.parse(line).event,
      ),
    ),
  );
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
