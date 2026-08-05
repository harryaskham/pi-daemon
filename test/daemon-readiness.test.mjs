import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { PiDaemonClient } from "../dist/client.js";
import { captureChildOutput, waitForDaemonReady } from "./daemon-readiness.mjs";

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await exited;
}

async function listen(server, socketPath) {
  await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
}

async function closeServer(server, connections) {
  for (const connection of connections) connection.destroy();
  if (!server.listening) return;
  await new Promise((resolve) => server.close(resolve));
}

function protocolServer(connections, responseForRequest) {
  return createServer((connection) => {
    connections.add(connection);
    connection.once("close", () => connections.delete(connection));
    connection.setEncoding("utf8");
    let input = "";
    connection.on("data", (chunk) => {
      input += chunk;
      for (;;) {
        const newline = input.indexOf("\n");
        if (newline === -1) break;
        const line = input.slice(0, newline);
        input = input.slice(newline + 1);
        const request = JSON.parse(line);
        const response = responseForRequest(request);
        if (response !== undefined) connection.write(`${JSON.stringify(response)}\n`);
      }
    });
  });
}

async function leaveStaleSocket(t, socketPath) {
  await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 });
  const fixture = spawn(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      [
        'import { createServer } from "node:net";',
        "const server = createServer();",
        "server.listen(process.env.READINESS_FIXTURE_SOCKET, () => process.send({ ready: true }));",
        "setInterval(() => {}, 1_000);",
      ].join("\n"),
    ],
    {
      env: { ...process.env, READINESS_FIXTURE_SOCKET: socketPath },
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    },
  );
  t.after(() => stopChild(fixture));
  const [message] = await once(fixture, "message");
  assert.deepEqual(message, { ready: true });
  await stopChild(fixture);
  assert.equal((await stat(socketPath)).isSocket(), true);
}

function keepaliveChild(t) {
  const child = spawn(
    process.execPath,
    ["--eval", "setInterval(() => {}, 1_000)"],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  t.after(() => stopChild(child));
  return child;
}

test("semantic readiness survives a stale socket until the delayed listener answers", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-daemon-readiness-delay-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const socketPath = join(root, "exact", "run", "pi-daemon.sock");
  await leaveStaleSocket(t, socketPath);

  // This is the production race in a hermetic fixture: the socket inode exists,
  // but no listener owns it and the kernel refuses the connection.
  await assert.rejects(
    PiDaemonClient.connect({ socketPath, connectTimeoutMs: 1_000 }),
    (error) => error instanceof Error && "code" in error && error.code === "ECONNREFUSED",
  );

  const child = keepaliveChild(t);
  const output = captureChildOutput(child);
  const connections = new Set();
  const server = protocolServer(connections, (request) => ({
    protocolVersion: request.protocolVersion,
    kind: "response",
    requestId: request.requestId,
    hostInstanceId: "readiness-fixture-host",
    ok: true,
    data: {},
  }));
  t.after(() => closeServer(server, connections));

  let attempts = 0;
  let resolveFirstAttempt;
  const firstAttemptFinished = new Promise((resolve) => { resolveFirstAttempt = resolve; });
  const readiness = waitForDaemonReady({
    socketPath,
    child,
    timeoutMs: 5_000,
    diagnostics: output.diagnostics,
    connect: async (options) => {
      attempts += 1;
      try {
        return await PiDaemonClient.connect(options);
      } finally {
        if (attempts === 1) resolveFirstAttempt();
      }
    },
  });

  // Start the real listener only after the readiness helper has observed the
  // refused stale socket. No timing gap controls this transition.
  await firstAttemptFinished;
  await rm(socketPath, { force: true });
  await listen(server, socketPath);

  const client = await readiness;
  assert.ok(attempts >= 2);
  assert.equal(client.socketPath, socketPath);
  client.close();
});

test("semantic readiness fails promptly when the child exits and redacts bounded stderr", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-daemon-readiness-exit-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const socketPath = join(root, "run", "pi-daemon.sock");
  const secret = "readiness-secret-never-diagnose";
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      [
        `const raw = ${JSON.stringify(secret)} + "x".repeat(8_192) + "\\n";`,
        'const safe = JSON.stringify({ event: "readiness_fixture", code: "listener_failed" }) + "\\n";',
        "process.stderr.write(raw + safe, () => process.send({ diagnosticsWritten: true }));",
        "process.on(\"message\", () => process.exit(17));",
        "setInterval(() => {}, 1_000);",
      ].join("\n"),
    ],
    { stdio: ["ignore", "pipe", "pipe", "ipc"] },
  );
  t.after(() => stopChild(child));
  const output = captureChildOutput(child, { maxBytesPerStream: 256 });
  const [message] = await once(child, "message");
  assert.deepEqual(message, { diagnosticsWritten: true });

  const readiness = waitForDaemonReady({
    socketPath,
    child,
    timeoutMs: 30_000,
    diagnostics: output.diagnostics,
  });
  child.send({ exit: true });
  await assert.rejects(readiness, (error) => {
    assert.match(error.message, /reason=child_stopped/);
    assert.match(error.message, /childExitCode=17/);
    assert.match(error.message, /expectedSocketState=missing/);
    assert.match(error.message, /event=readiness_fixture code=listener_failed/);
    assert.equal(error.message.includes(secret), false);
    return true;
  });
  const snapshot = output.snapshot();
  assert.equal(snapshot.stderr.capturedBytes, 256);
  assert.ok(snapshot.stderr.droppedBytes > 0);
});

test("semantic readiness times out when an exact listener never answers", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-daemon-readiness-silent-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const socketPath = join(root, "run", "pi-daemon.sock");
  const child = keepaliveChild(t);
  const output = captureChildOutput(child);
  const connections = new Set();
  const server = protocolServer(connections, () => undefined);
  await listen(server, socketPath);
  t.after(() => closeServer(server, connections));

  await assert.rejects(
    waitForDaemonReady({
      socketPath,
      child,
      timeoutMs: 150,
      diagnostics: output.diagnostics,
    }),
    (error) => {
      assert.match(error.message, /reason=deadline/);
      assert.match(error.message, /expectedSocketState=socket/);
      return true;
    },
  );
});

test("semantic readiness rejects a listener that is not Pi Daemon", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-daemon-readiness-wrong-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const socketPath = join(root, "run", "pi-daemon.sock");
  const child = keepaliveChild(t);
  const output = captureChildOutput(child);
  const connections = new Set();
  const server = protocolServer(connections, (request) => ({
    requestId: request.requestId,
    kind: "not-a-pi-daemon-response",
  }));
  await listen(server, socketPath);
  t.after(() => closeServer(server, connections));

  await assert.rejects(
    waitForDaemonReady({
      socketPath,
      child,
      timeoutMs: 5_000,
      diagnostics: output.diagnostics,
    }),
    (error) => {
      assert.match(error.message, /reason=semantic_probe_rejected/);
      assert.match(error.message, /expectedSocketState=socket/);
      return true;
    },
  );
});
