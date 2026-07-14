import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SERVICE_BEARER_ENV, ServiceBearerAuthenticator } from "../dist/api-auth.js";
import { ApiServer } from "../dist/api-server.js";
import { runCli } from "../dist/cli.js";
import { Multiplexer } from "../dist/multiplexer.js";
import { FileSessionCatalog } from "../dist/session-catalog.js";

const TOKEN = "fixture-service-bearer-0123456789";

class EmptyFactory {
  async open() {
    throw new Error("not used by API admission tests");
  }
}

const startApi = async (limits, suppliedMultiplexer) => {
  const multiplexer =
    suppliedMultiplexer ??
    new Multiplexer({
      factory: new EmptyFactory(),
      hostInstanceId: "host-api-test",
    });
  const server = new ApiServer({
    multiplexer,
    authenticator: new ServiceBearerAuthenticator(TOKEN),
    host: "127.0.0.1",
    port: 0,
    limits,
  });
  const address = await server.start();
  return { multiplexer, server, address };
};

test("API listener defaults to loopback and refuses implicit remote plaintext", () => {
  const base = {
    multiplexer: new Multiplexer({ factory: new EmptyFactory() }),
    authenticator: new ServiceBearerAuthenticator(TOKEN),
  };
  const loopback = new ApiServer(base);
  assert.equal(loopback.host, "127.0.0.1");
  assert.throws(() => new ApiServer({ ...base, host: "0.0.0.0" }), /non-loopback plaintext/);
  assert.doesNotThrow(
    () => new ApiServer({ ...base, host: "0.0.0.0", allowInsecureRemote: true, port: 0 }),
  );
});

test("all JSON routes authenticate before revealing capabilities or route state", async (t) => {
  const harness = await startApi();
  t.after(async () => harness.server.stop());

  for (const path of ["/v1/capabilities", "/v1/session/private-name", "/does-not-exist"]) {
    const denied = await requestJson(harness.address, { path });
    assert.equal(denied.status, 401);
    assert.equal(denied.headers["www-authenticate"], "Bearer");
    assert.equal(denied.value.error.code, "unauthorized");
    assert.equal(JSON.stringify(denied.value).includes("private-name"), false);
    assert.equal(JSON.stringify(denied.value).includes(TOKEN), false);
  }

  const wrong = await requestJson(harness.address, {
    path: "/v1/capabilities",
    headers: { Authorization: `Bearer ${TOKEN}x` },
  });
  assert.equal(wrong.status, 401);

  const allowed = await requestJson(harness.address, {
    path: "/v1/capabilities",
    headers: { Authorization: `Bearer ${TOKEN}`, "X-Request-Id": "capabilities-1" },
  });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.value.requestId, "capabilities-1");
  assert.equal(allowed.value.hostInstanceId, "host-api-test");
  assert.equal(allowed.value.data.authentication, "service-bearer");
  assert.deepEqual(allowed.value.data.transports, ["unix-ndjson", "http"]);
  assert.deepEqual(allowed.value.data.rpcSubprotocols, []);
  assert.equal(JSON.stringify(allowed.value).includes(TOKEN), false);
});

test("authenticated session reads expose bounded resident/dormant catalog resources", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "pi-daemon-api-catalog-"));
  t.after(async () => rm(stateDir, { recursive: true, force: true }));
  const seed = new FileSessionCatalog({ stateDir });
  await seed.recover();
  for (const id of ["a", "b"]) {
    await seed.create({
      sessionId: id,
      name: `name-${id}`,
      generation: 1,
      residency: "dormant",
      state: "idle",
      spec: {
        cwd: `/work/${id}`,
        target: { mode: "new" },
        isolation: { mode: "unisolated" },
      },
    });
  }
  const multiplexer = new Multiplexer({
    factory: new EmptyFactory(),
    catalog: new FileSessionCatalog({ stateDir }),
    hostInstanceId: "host-api-catalog",
  });
  await multiplexer.recover();
  const harness = await startApi(undefined, multiplexer);
  t.after(async () => harness.server.stop());
  const headers = { Authorization: `Bearer ${TOKEN}` };

  const first = await requestJson(harness.address, {
    path: "/v1/session?limit=1",
    headers,
  });
  assert.equal(first.status, 200);
  assert.equal(first.value.data.sessions[0].sessionId, "a");
  assert.equal(first.value.data.sessions[0].residency, "dormant");
  assert.ok(first.value.data.nextCursor);

  const second = await requestJson(harness.address, {
    path: `/v1/session?limit=1&cursor=${encodeURIComponent(first.value.data.nextCursor)}`,
    headers,
  });
  assert.deepEqual(second.value.data.sessions.map((session) => session.sessionId), ["b"]);

  const byName = await requestJson(harness.address, {
    path: "/v1/session/name-a",
    headers,
  });
  assert.equal(byName.status, 200);
  assert.equal(byName.headers.etag, '"YQ:1"');
  assert.equal(byName.value.data.sessionId, "a");
  assert.equal(byName.value.data.links.self, "/v1/session/a");

  const missing = await requestJson(harness.address, {
    path: "/v1/session/missing",
    headers,
  });
  assert.equal(missing.status, 404);
  assert.equal(missing.value.error.code, "session_not_found");

  const invalidLimit = await requestJson(harness.address, {
    path: "/v1/session?limit=101",
    headers,
  });
  assert.equal(invalidLimit.status, 400);
  assert.equal(invalidLimit.value.error.code, "invalid_limit");
});

test("authenticated JSON bodies are byte bounded before future CRUD dispatch", async (t) => {
  const harness = await startApi({ maxBodyBytes: 32 });
  t.after(async () => harness.server.stop());
  const headers = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };

  const invalid = await requestJson(harness.address, {
    method: "POST",
    path: "/v1/session",
    headers,
    body: "not-json",
  });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.value.error.code, "invalid_json");

  const oversized = await requestJson(harness.address, {
    method: "POST",
    path: "/v1/session",
    headers,
    body: JSON.stringify({ value: "x".repeat(64) }),
  });
  assert.equal(oversized.status, 413);
  assert.equal(oversized.value.error.code, "body_too_large");

  const reserved = await requestJson(harness.address, {
    method: "POST",
    path: "/v1/session",
    headers,
    body: "{}",
  });
  assert.equal(reserved.status, 501);
  assert.equal(reserved.value.error.code, "not_implemented");
});

test("serve CLI enables an ephemeral loopback API without logging the bearer", async (t) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "pi-daemon-api-cli-"));
  t.after(async () => rm(temporaryRoot, { recursive: true, force: true }));
  const work = join(temporaryRoot, "work");
  const stateDir = join(temporaryRoot, "state");
  await Promise.all([
    mkdir(work, { recursive: true, mode: 0o700 }),
    mkdir(stateDir, { recursive: true, mode: 0o700 }),
  ]);
  const previousToken = process.env[SERVICE_BEARER_ENV];
  process.env[SERVICE_BEARER_ENV] = TOKEN;
  t.after(() => {
    if (previousToken === undefined) delete process.env[SERVICE_BEARER_ENV];
    else process.env[SERVICE_BEARER_ENV] = previousToken;
  });
  const output = [];
  const errors = [];
  const io = { stdout: (text) => output.push(text), stderr: (text) => errors.push(text) };

  const code = await runCli(
    [
      "serve",
      "--socket",
      join(temporaryRoot, "daemon.sock"),
      "--state-dir",
      stateDir,
      "--allow-root",
      work,
      "--api-port",
      "0",
    ],
    io,
    {
      factory: new EmptyFactory(),
      waitForShutdown: async (shutdown) => {
        const ready = errors.map((line) => JSON.parse(line)).find((entry) => entry.event === "pi_daemon_ready");
        assert.ok(ready);
        assert.equal(ready.api.enabled, true);
        const response = await requestJson(
          { host: ready.api.host, port: ready.api.port },
          {
            path: "/v1/capabilities",
            headers: { Authorization: `Bearer ${TOKEN}` },
          },
        );
        assert.equal(response.status, 200);
        await shutdown();
      },
    },
  );
  assert.equal(code, 0);
  assert.deepEqual(output, []);
  assert.equal(errors.join("").includes(TOKEN), false);
});

test("serve CLI fails closed and removes the Unix socket when no bearer source exists", async (t) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "pi-daemon-api-cli-denied-"));
  t.after(async () => rm(temporaryRoot, { recursive: true, force: true }));
  const work = join(temporaryRoot, "work");
  const stateDir = join(temporaryRoot, "state");
  const socketPath = join(temporaryRoot, "daemon.sock");
  await Promise.all([
    mkdir(work, { recursive: true, mode: 0o700 }),
    mkdir(stateDir, { recursive: true, mode: 0o700 }),
  ]);
  const previousToken = process.env[SERVICE_BEARER_ENV];
  delete process.env[SERVICE_BEARER_ENV];
  t.after(() => {
    if (previousToken !== undefined) process.env[SERVICE_BEARER_ENV] = previousToken;
  });
  const errors = [];
  const code = await runCli(
    [
      "serve",
      "--socket",
      socketPath,
      "--state-dir",
      stateDir,
      "--allow-root",
      work,
      "--api-port",
      "0",
    ],
    { stdout: () => {}, stderr: (text) => errors.push(text) },
    { factory: new EmptyFactory() },
  );
  assert.equal(code, 1);
  assert.match(errors.join(""), /requires exactly one bearer source/);
  await assert.rejects(
    access(socketPath),
    (error) => error instanceof Error && "code" in error && error.code === "ENOENT",
  );
});

test("WebSocket upgrades fail closed on bearer auth before stream routing", async (t) => {
  const harness = await startApi();
  t.after(async () => harness.server.stop());

  const denied = await rawUpgrade(harness.address, "/v1/session/private-name/rpc");
  assert.match(denied, /^HTTP\/1\.1 401 Unauthorized/);
  assert.equal(denied.includes("private-name"), false);
  assert.equal(denied.includes(TOKEN), false);

  const authenticated = await rawUpgrade(
    harness.address,
    "/v1/session/private-name/rpc",
    `Authorization: Bearer ${TOKEN}\r\n`,
  );
  assert.match(authenticated, /^HTTP\/1\.1 501 Not Implemented/);
  assert.match(authenticated, /stream_not_implemented/);
  assert.equal(authenticated.includes(TOKEN), false);
});

const requestJson = async (address, options) =>
  new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: address.host,
        port: address.port,
        method: options.method ?? "GET",
        path: options.path,
        headers: options.headers,
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => (body += chunk));
        response.on("end", () => {
          resolve({
            status: response.statusCode,
            headers: response.headers,
            value: JSON.parse(body),
          });
        });
      },
    );
    request.on("error", reject);
    if (options.body !== undefined) request.write(options.body);
    request.end();
  });

const rawUpgrade = async (address, path, extraHeaders = "") =>
  new Promise((resolve, reject) => {
    const socket = createConnection(address.port, address.host);
    let response = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      socket.write(
        `GET ${path} HTTP/1.1\r\n` +
          `Host: ${address.host}:${address.port}\r\n` +
          "Connection: Upgrade\r\n" +
          "Upgrade: websocket\r\n" +
          "Sec-WebSocket-Version: 13\r\n" +
          "Sec-WebSocket-Key: Zml4dHVyZS1rZXktMTIzNA==\r\n" +
          extraHeaders +
          "\r\n",
      );
    });
    socket.on("data", (chunk) => (response += chunk));
    socket.on("end", () => resolve(response));
    socket.on("error", reject);
  });
