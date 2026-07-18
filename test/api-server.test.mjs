import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SERVICE_BEARER_ENV, ServiceBearerAuthenticator } from "../dist/api-auth.js";
import { ApiServer } from "../dist/api-server.js";
import { DASH_DEFAULT_LIMITS } from "../dist/dashboard-contract.js";
import { DASHBOARD_TUI_SUBPROTOCOL } from "../dist/session-api.js";
import { runCli } from "../dist/cli.js";
import { PiDaemonClient } from "../dist/client.js";
import { FileDurabilityStore, wakeTicketId } from "../dist/durability.js";
import { Multiplexer } from "../dist/multiplexer.js";
import { FileSessionCatalog } from "../dist/session-catalog.js";
import { SessionApiClient } from "../dist/session-client.js";
import {
  FileMutationTicketStore,
  MutationTicketController,
} from "../dist/tickets.js";

const TOKEN = "fixture-service-bearer-0123456789";

class EmptyFactory {
  async open() {
    throw new Error("not used by API admission tests");
  }
}

class SessionAdapter {
  async prompt() {
    return { text: "ok" };
  }
  identity() {
    return { sessionId: "pi-api-fixture" };
  }
  async dispose() {}
}

class SessionFactory {
  async open() {
    return new SessionAdapter();
  }
}

const startApi = async (limits, suppliedMultiplexer, tickets, extra = {}) => {
  const multiplexer =
    suppliedMultiplexer ??
    new Multiplexer({
      factory: new EmptyFactory(),
      hostInstanceId: "host-api-test",
    });
  const server = new ApiServer({
    multiplexer,
    authenticator: new ServiceBearerAuthenticator(TOKEN),
    tickets,
    host: "::1",
    port: 0,
    limits,
    ...extra,
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
  assert.deepEqual(allowed.value.data.transports, ["unix-ndjson", "http", "websocket"]);
  assert.deepEqual(allowed.value.data.rpcSubprotocols, ["pi-rpc.v1", "pi-daemon-rpc.v1"]);
  assert.equal(allowed.value.data.rpc.host.processTransportOwned, false);
  assert.equal(allowed.value.data.rpc.replay, true);
  assert.equal(allowed.value.data.acp.protocol, "ACP");
  assert.equal(allowed.value.data.acp.sdkVersion, "1.2.0");
  assert.equal(allowed.value.data.acp.websocketSubprotocol, "agent-client-protocol.v1");
  assert.equal(allowed.value.data.acp.inProcess, true);
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

test("authenticated API responses fail with a bounded typed error before oversized allocation", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "pi-daemon-api-response-bound-"));
  t.after(async () => rm(stateDir, { recursive: true, force: true }));
  const seed = new FileSessionCatalog({ stateDir });
  await seed.recover();
  for (let index = 0; index < 9; index += 1) {
    await seed.create({
      sessionId: `large-${index}`,
      generation: 1,
      residency: "dormant",
      state: "idle",
      spec: {
        cwd: `/work/large-${index}`,
        target: { mode: "new" },
        resources: { systemPrompt: "x".repeat(256 * 1024) },
        isolation: { mode: "unisolated" },
      },
    });
  }
  const multiplexer = new Multiplexer({
    factory: new EmptyFactory(),
    catalog: new FileSessionCatalog({ stateDir }),
    hostInstanceId: "host-api-response-bound",
  });
  await multiplexer.recover();
  const harness = await startApi(undefined, multiplexer);
  t.after(async () => harness.server.stop());
  const response = await requestJson(harness.address, {
    path: "/v1/session?limit=100",
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  assert.equal(response.status, 500);
  assert.equal(response.value.error.code, "outbound_record_too_large");
  assert.equal(JSON.stringify(response.value).includes("x".repeat(1024)), false);
});

test("authenticated CRUD mutations return durable deduplicated tickets and terminal resources", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "pi-daemon-api-mutations-"));
  t.after(async () => rm(stateDir, { recursive: true, force: true }));
  const multiplexer = new Multiplexer({
    factory: new SessionFactory(),
    durability: new FileDurabilityStore({ stateDir }),
    catalog: new FileSessionCatalog({ stateDir }),
    hostInstanceId: "host-api-mutations",
  });
  await multiplexer.recover();
  const tickets = new MutationTicketController(new FileMutationTicketStore({ stateDir }));
  const harness = await startApi(undefined, multiplexer, tickets);
  t.after(async () => harness.server.stop());
  const auth = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };
  const createBody = {
    requestId: "create-request",
    sessionId: "created-session",
    spec: {
      cwd: "/work/created",
      name: "created-name",
      target: { mode: "memory" },
      tools: { mode: "none" },
      isolation: { mode: "unisolated" },
    },
  };

  const created = await requestJson(harness.address, {
    method: "POST",
    path: "/v1/session",
    headers: {
      ...auth,
      "X-Request-Id": createBody.requestId,
      "Idempotency-Key": "create-once",
    },
    body: JSON.stringify(createBody),
  });
  assert.equal(created.status, 202);
  assert.equal(created.value.data.state, "queued");
  assert.equal(created.value.data.operation, "create");
  assert.equal(created.headers.location, `/v1/ticket/${created.value.data.ticketId}`);
  const createTerminal = await waitForTicket(
    harness.address,
    created.value.data.ticketId,
    auth.Authorization,
  );
  assert.equal(createTerminal.state, "succeeded");
  assert.equal(createTerminal.result.sessionId, "created-session");
  assert.equal(createTerminal.result.name, "created-name");

  const duplicate = await requestJson(harness.address, {
    method: "POST",
    path: "/v1/session",
    headers: {
      ...auth,
      "X-Request-Id": "create-retry",
      "Idempotency-Key": "create-once",
    },
    body: JSON.stringify({ ...createBody, requestId: "create-retry" }),
  });
  assert.equal(duplicate.status, 202);
  assert.equal(duplicate.value.requestId, "create-retry");
  assert.equal(duplicate.value.data.ticketId, created.value.data.ticketId);
  assert.equal(duplicate.value.data.state, "succeeded");
  const byIdempotency = await requestJson(harness.address, {
    path: "/v1/ticket?method=POST&target=%2Fv1%2Fsession",
    headers: {
      Authorization: auth.Authorization,
      "Idempotency-Key": "create-once",
    },
  });
  assert.equal(byIdempotency.status, 200);
  assert.equal(byIdempotency.value.data.ticketId, created.value.data.ticketId);
  assert.equal(byIdempotency.value.data.idempotencyKey, "create-once");

  const conflict = await requestJson(harness.address, {
    method: "POST",
    path: "/v1/session",
    headers: {
      ...auth,
      "X-Request-Id": "create-conflict",
      "Idempotency-Key": "create-once",
    },
    body: JSON.stringify({
      ...createBody,
      requestId: "create-conflict",
      spec: { ...createBody.spec, cwd: "/work/different" },
    }),
  });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.value.error.code, "idempotency_conflict");
  const unsupportedEnv = await requestJson(harness.address, {
    method: "POST",
    path: "/v1/session",
    headers: {
      ...auth,
      "X-Request-Id": "env-request",
      "Idempotency-Key": "env-once",
    },
    body: JSON.stringify({
      requestId: "env-request",
      sessionId: "env-session",
      spec: {
        ...createBody.spec,
        name: "env-name",
        env: { PROVIDER_TOKEN: "secret-value-must-not-persist" },
      },
    }),
  });
  assert.equal(unsupportedEnv.status, 202);
  const environmentTerminal = await waitForTicket(
    harness.address,
    unsupportedEnv.value.data.ticketId,
    auth.Authorization,
  );
  assert.equal(
    environmentTerminal.state,
    "succeeded",
    JSON.stringify(environmentTerminal.error),
  );
  const environmentSession = await requestJson(harness.address, {
    path: "/v1/session/env-session",
    headers: { Authorization: auth.Authorization },
  });
  assert.deepEqual(environmentSession.value.data.environment.keys, ["PROVIDER_TOKEN"]);
  assert.match(environmentSession.value.data.environment.digest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(environmentSession.value.data.environment.provisioned, true);
  const ticketFiles = await readdir(join(stateDir, "tickets"));
  const persistedTickets = await Promise.all(
    ticketFiles.map((name) => readFile(join(stateDir, "tickets", name), "utf8")),
  );
  assert.equal(
    persistedTickets.join("").includes("secret-value-must-not-persist"),
    false,
  );

  const fetched = await requestJson(harness.address, {
    path: "/v1/session/created-name",
    headers: { Authorization: auth.Authorization },
  });
  assert.equal(fetched.status, 200);
  const updated = await requestJson(harness.address, {
    method: "PUT",
    path: "/v1/session/created-name?waitForTerminal=true",
    headers: {
      ...auth,
      "X-Request-Id": "update-request",
      "Idempotency-Key": "update-once",
      "If-Match": fetched.headers.etag,
    },
    body: JSON.stringify({
      requestId: "update-request",
      expectedGeneration: fetched.value.data.generation,
      expectedRevision: fetched.value.data.revision,
      spec: { ...createBody.spec, name: "updated-name" },
    }),
  });
  assert.equal(updated.status, 202);
  assert.equal(updated.value.data.state, "succeeded");
  const updateTerminal = await waitForTicket(
    harness.address,
    updated.value.data.ticketId,
    auth.Authorization,
  );
  assert.equal(updateTerminal.state, "succeeded");
  assert.equal(updateTerminal.result.generation, 2);
  assert.equal(updateTerminal.result.name, "updated-name");
  const updateRetry = await requestJson(harness.address, {
    method: "PUT",
    path: "/v1/session/created-session",
    headers: {
      ...auth,
      "X-Request-Id": "update-retry",
      "Idempotency-Key": "update-once",
      "If-Match": fetched.headers.etag,
    },
    body: JSON.stringify({
      requestId: "update-retry",
      expectedGeneration: fetched.value.data.generation,
      expectedRevision: fetched.value.data.revision,
      spec: { ...createBody.spec, name: "updated-name" },
    }),
  });
  assert.equal(updateRetry.status, 202);
  assert.equal(updateRetry.value.requestId, "update-retry");
  assert.equal(updateRetry.value.data.ticketId, updated.value.data.ticketId);
  assert.equal(updateRetry.value.data.state, "succeeded");

  const current = await requestJson(harness.address, {
    path: "/v1/session/updated-name",
    headers: { Authorization: auth.Authorization },
  });
  const deleted = await requestJson(harness.address, {
    method: "DELETE",
    path: "/v1/session/updated-name?retainArtifacts=false",
    headers: {
      Authorization: auth.Authorization,
      "X-Request-Id": "delete-request",
      "Idempotency-Key": "delete-once",
      "If-Match": current.headers.etag,
    },
  });
  assert.equal(deleted.status, 202);
  const deleteTerminal = await waitForTicket(
    harness.address,
    deleted.value.data.ticketId,
    auth.Authorization,
  );
  assert.equal(deleteTerminal.state, "succeeded");
  assert.equal(deleteTerminal.result.deleted, true);
  const deleteRetry = await requestJson(harness.address, {
    method: "DELETE",
    path: "/v1/session/created-session?retainArtifacts=false",
    headers: {
      Authorization: auth.Authorization,
      "X-Request-Id": "delete-retry",
      "Idempotency-Key": "delete-once",
      "If-Match": current.headers.etag,
    },
  });
  assert.equal(deleteRetry.status, 202);
  assert.equal(deleteRetry.value.data.ticketId, deleted.value.data.ticketId);
  assert.equal(deleteRetry.value.data.state, "succeeded");
  const missing = await requestJson(harness.address, {
    path: "/v1/session/created-session",
    headers: { Authorization: auth.Authorization },
  });
  assert.equal(missing.status, 404);
});

test("queued environment-dependent mutation fails credentials_required after restart", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "pi-daemon-api-env-restart-"));
  t.after(async () => rm(stateDir, { recursive: true, force: true }));
  const store = new FileMutationTicketStore({ stateDir });
  await store.recover();
  const queued = await store.begin({
    method: "POST",
    canonicalTarget: "/v1/session",
    idempotencyKey: "env-restart",
    command: {
      operation: "create",
      requestId: "env-restart-request",
      sessionId: "env-restart-session",
      generation: 1,
      spec: {
        cwd: "/work/env-restart",
        target: { mode: "memory" },
        isolation: { mode: "unisolated" },
      },
      environmentSummary: {
        keys: ["OPENAI_API_KEY"],
        persistence: "memory-only",
        provisioned: true,
      },
    },
  });
  const multiplexer = new Multiplexer({
    factory: new SessionFactory(),
    catalog: new FileSessionCatalog({ stateDir }),
    hostInstanceId: "host-env-restart",
  });
  await multiplexer.recover();
  const tickets = new MutationTicketController(new FileMutationTicketStore({ stateDir }));
  const harness = await startApi(undefined, multiplexer, tickets);
  t.after(async () => harness.server.stop());
  const terminal = await waitForTicket(
    harness.address,
    queued.ticketId,
    `Bearer ${TOKEN}`,
  );
  assert.equal(terminal.state, "failed");
  assert.equal(terminal.error.code, "credentials_required");
  for (
    let attempt = 0;
    attempt < 100 && multiplexer.status().recovery.mutationRecoveryFailures === 0;
    attempt += 1
  ) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.equal(multiplexer.status().recovery.mutationRecoveryFailures, 1);
  assert.equal(multiplexer.status().recovery.phase, "degraded");
  assert.equal(multiplexer.status().ready, false);
  assert.equal(await multiplexer.retainedSession("env-restart-session"), undefined);
});

test("mutation reconciliation clears durable degraded readiness counters", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "pi-daemon-api-mutation-reconcile-"));
  t.after(async () => rm(stateDir, { recursive: true, force: true }));
  const first = new FileMutationTicketStore({ stateDir });
  await first.recover();
  const running = await first.begin({
    method: "POST",
    canonicalTarget: "/v1/session",
    idempotencyKey: "mutation-reconcile",
    command: {
      operation: "create",
      requestId: "mutation-reconcile-original",
      sessionId: "mutation-reconcile-session",
      generation: 1,
      spec: {
        cwd: "/work/mutation-reconcile",
        target: { mode: "memory" },
        isolation: { mode: "unisolated" },
      },
      environmentSummary: {
        keys: [],
        persistence: "memory-only",
        provisioned: true,
      },
    },
  });
  await first.markRunning(running.ticketId);
  const multiplexer = new Multiplexer({
    factory: new SessionFactory(),
    catalog: new FileSessionCatalog({ stateDir }),
    hostInstanceId: "host-mutation-reconcile",
  });
  await multiplexer.recover();
  const tickets = new MutationTicketController(new FileMutationTicketStore({ stateDir }));
  const harness = await startApi(undefined, multiplexer, tickets);
  t.after(async () => harness.server.stop());
  assert.equal(multiplexer.status().recovery.indeterminateMutationTickets, 1);
  assert.equal(multiplexer.status().ready, false);

  const reconciled = await requestJson(harness.address, {
    method: "POST",
    path: `/v1/ticket/${running.ticketId}/reconcile`,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
      "X-Request-Id": "mutation-reconcile-request",
    },
    body: JSON.stringify({
      requestId: "mutation-reconcile-request",
      state: "succeeded",
      evidence: { piEntryIds: ["entry-reconciled"] },
    }),
  });
  assert.equal(reconciled.status, 200);
  assert.equal(reconciled.value.data.state, "succeeded");
  assert.equal(multiplexer.status().recovery.indeterminateMutationTickets, 0);
  assert.equal(multiplexer.status().recovery.phase, "ready");
  assert.equal(multiplexer.status().ready, true);
});

test("authenticated wake ticket lookup and explicit Pi-entry reconciliation are durable", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "pi-daemon-api-reconcile-"));
  t.after(async () => rm(stateDir, { recursive: true, force: true }));
  const first = new FileDurabilityStore({ stateDir });
  await first.recover();
  const command = {
    protocolVersion: "1.0",
    requestId: "wake-before-restart",
    operation: "wake",
    sessionId: "reconcile-session",
    generation: 1,
    idempotencyKey: "reconcile-key",
    payload: { prompt: "prompt persisted before restart" },
  };
  await first.beginRequest(command);
  await first.markAccepted(command.sessionId, command.idempotencyKey);

  const multiplexer = new Multiplexer({
    factory: new EmptyFactory(),
    durability: new FileDurabilityStore({ stateDir }),
    hostInstanceId: "host-api-reconcile",
  });
  await multiplexer.recover();
  const harness = await startApi(undefined, multiplexer);
  t.after(async () => harness.server.stop());
  const authorization = `Bearer ${TOKEN}`;
  const ticketId = wakeTicketId(command.sessionId, command.idempotencyKey);

  const status = await requestJson(harness.address, {
    path: `/v1/ticket/${ticketId}`,
    headers: { Authorization: authorization },
  });
  assert.equal(status.status, 200);
  assert.equal(status.value.data.operation, "prompt");
  assert.equal(status.value.data.state, "indeterminate");

  const byKey = await requestJson(harness.address, {
    path: "/v1/ticket?method=WAKE&target=%2Fv1%2Fsession%2Freconcile-session%2Fwake",
    headers: {
      Authorization: authorization,
      "Idempotency-Key": command.idempotencyKey,
    },
  });
  assert.equal(byKey.status, 200);
  assert.equal(byKey.value.data.ticketId, ticketId);

  const reconciled = await requestJson(harness.address, {
    method: "POST",
    path: `/v1/ticket/${ticketId}/reconcile`,
    headers: {
      Authorization: authorization,
      "Content-Type": "application/json",
      "X-Request-Id": "reconcile-request",
    },
    body: JSON.stringify({
      requestId: "reconcile-request",
      state: "succeeded",
      evidence: { piEntryIds: ["entry-user-1", "entry-assistant-2"] },
    }),
  });
  assert.equal(reconciled.status, 200);
  assert.equal(reconciled.value.data.state, "succeeded");
  assert.deepEqual(reconciled.value.data.result, {
    reconciled: true,
    piEntryIds: ["entry-user-1", "entry-assistant-2"],
  });
  assert.equal(multiplexer.status().recovery.indeterminateRequests, 0);
  assert.equal(multiplexer.status().recovery.phase, "ready");
  assert.equal(multiplexer.status().ready, true);
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
  const workTwo = join(temporaryRoot, "work-two");
  const stateDir = join(temporaryRoot, "state");
  await Promise.all([
    mkdir(work, { recursive: true, mode: 0o700 }),
    mkdir(workTwo, { recursive: true, mode: 0o700 }),
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
  const socketPath = join(temporaryRoot, "daemon.sock");
  const authSeed = join(temporaryRoot, "auth-seed.json");
  await writeFile(authSeed, "{}\n", { mode: 0o600 });

  const code = await runCli(
    [
      "serve",
      "--socket",
      socketPath,
      "--state-dir",
      stateDir,
      "--agent-dir",
      join(temporaryRoot, "agent"),
      "--auth-seed-file",
      authSeed,
      "--allow-root",
      work,
      "--allow-root",
      workTwo,
      "--api-port",
      "0",
      "--api-bind",
      "::1",
      "--max-connections",
      "3",
      "--max-in-flight-requests-per-connection",
      "2",
      "--max-line-bytes",
      "2048",
      "--max-event-bytes",
      "1024",
      "--max-response-bytes",
      "1536",
      "--max-outbound-bytes-per-connection",
      "4096",
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
        const client = await PiDaemonClient.connect({ socketPath });
        try {
          const handshake = await client.handshake("transport-limits");
          assert.deepEqual(handshake.data.limits, {
            maxConnections: 3,
            maxInFlightRequestsPerConnection: 2,
            maxLineBytes: 2048,
            maxEventBytes: 1024,
            maxResponseBytes: 1536,
            maxOutboundBytesPerConnection: 4096,
            multiplexer: {
              maxSessions: 128,
              maxConcurrentTurns: 4,
              maxSessionQueueDepth: 32,
            },
          });
        } finally {
          client.close();
        }
        await shutdown();
      },
    },
  );
  assert.equal(code, 0);
  assert.deepEqual(output, []);
  assert.equal(errors.join("").includes(TOKEN), false);
  assert.equal(errors.join("").includes(temporaryRoot), false);
});

test("serve CLI generates and uses a stable default bearer when no external source exists", async (t) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "pi-daemon-api-cli-generated-"));
  t.after(async () => rm(temporaryRoot, { recursive: true, force: true }));
  const work = join(temporaryRoot, "work");
  const stateDir = join(temporaryRoot, "state");
  const socketPath = join(temporaryRoot, "daemon.sock");
  await mkdir(work, { recursive: true, mode: 0o700 });
  const previousToken = process.env[SERVICE_BEARER_ENV];
  delete process.env[SERVICE_BEARER_ENV];
  t.after(() => {
    if (previousToken !== undefined) process.env[SERVICE_BEARER_ENV] = previousToken;
  });
  const errors = [];
  const authSeed = join(temporaryRoot, "auth-seed.json");
  await writeFile(authSeed, "{}\n", { mode: 0o600 });
  let generatedToken;
  const code = await runCli(
    [
      "serve",
      "--socket",
      socketPath,
      "--state-dir",
      stateDir,
      "--agent-dir",
      join(temporaryRoot, "agent"),
      "--auth-seed-file",
      authSeed,
      "--allow-root",
      work,
      "--api-port",
      "0",
    ],
    { stdout: () => {}, stderr: (text) => errors.push(text) },
    {
      factory: new EmptyFactory(),
      waitForShutdown: async (shutdown) => {
        const ready = errors.map((line) => JSON.parse(line)).find((entry) => entry.event === "pi_daemon_ready");
        assert.ok(ready);
        generatedToken = (await readFile(join(stateDir, "api-token"), "utf8")).trimEnd();
        const response = await requestJson(
          { host: ready.api.host, port: ready.api.port },
          {
            path: "/v1/capabilities",
            headers: { Authorization: `Bearer ${generatedToken}` },
          },
        );
        assert.equal(response.status, 200);
        await shutdown();
      },
    },
  );
  assert.equal(code, 0);
  assert.ok(generatedToken.length >= 16);
  assert.equal(errors.join("").includes(generatedToken), false);
  assert.equal(errors.join("").includes(temporaryRoot), false);
  await assert.rejects(
    access(socketPath),
    (error) => error instanceof Error && "code" in error && error.code === "ENOENT",
  );
});

test("authenticated neutral Dashboard API preserves resources, idempotency, paths and TUI gating", async (t) => {
  const calls = [];
  const capabilities = {
    apiVersion: "1.0",
    authentication: "service-bearer",
    resources: {
      inventory: true,
      transcriptPreview: true,
      activation: true,
      ownership: true,
      export: true,
      leases: true,
    },
    presentations: {
      rich: { available: true },
      tui: {
        available: false,
        subprotocol: DASHBOARD_TUI_SUBPROTOCOL,
        unavailableReason: "view-seam-required",
      },
    },
    limits: { ...DASH_DEFAULT_LIMITS },
  };
  const dashboardApi = {
    async capabilities() {
      return capabilities;
    },
    async listSessions(query) {
      calls.push(["list", query]);
      return {
        sessions: [],
        index: {
          formatVersion: 1,
          loadedAt: "2026-07-18T12:00:00.000Z",
          stale: false,
          reconciling: false,
        },
      };
    },
    async getSessionInfo(inventoryId) {
      calls.push(["info", inventoryId]);
      return { inventoryId, cwd: "/private/work", source: { aliases: [] } };
    },
    async getTranscript(inventoryId, query, fingerprint) {
      calls.push(["transcript", inventoryId, query, fingerprint]);
      return {
        inventoryId,
        sourceFingerprint: fingerprint,
        records: [],
        order: "chronological",
        projection: {
          formatVersion: 1,
          cached: true,
          truncated: false,
          builtAt: "2026-07-18T12:00:00.000Z",
        },
        hydration: "not-requested",
      };
    },
    async activateSession(inventoryId, request) {
      calls.push(["activate", inventoryId, request]);
      return {
        ticketId: "activation-ticket",
        requestId: request.requestId,
        idempotencyKey: request.idempotencyKey,
        inventoryId,
        mode: request.mode,
        state: "queued",
        submittedAt: "2026-07-18T12:00:00.000Z",
        updatedAt: "2026-07-18T12:00:00.000Z",
      };
    },
    async getActivation(ticketId) {
      calls.push(["activation", ticketId]);
      return {
        ticketId,
        requestId: "activation-request",
        idempotencyKey: "activation-key",
        inventoryId: "inventory-private",
        mode: "fork",
        state: "succeeded",
        submittedAt: "2026-07-18T12:00:00.000Z",
        updatedAt: "2026-07-18T12:00:00.000Z",
      };
    },
    async exportSession(sessionRef, request) {
      calls.push(["export", sessionRef, request]);
      return {
        ticketId: "export-ticket",
        requestId: request.requestId,
        idempotencyKey: request.idempotencyKey,
        sessionRef,
        mode: request.mode,
        state: "queued",
        submittedAt: "2026-07-18T12:00:00.000Z",
        updatedAt: "2026-07-18T12:00:00.000Z",
      };
    },
    async getExport(ticketId) {
      calls.push(["export-ticket", ticketId]);
      return {
        ticketId,
        requestId: "export-request",
        idempotencyKey: "export-key",
        sessionRef: "managed-private",
        mode: "as-new",
        state: "succeeded",
        submittedAt: "2026-07-18T12:00:00.000Z",
        updatedAt: "2026-07-18T12:00:00.000Z",
      };
    },
    async renewLease(sessionRef, leaseId) {
      calls.push(["lease", sessionRef, leaseId]);
      return {
        sessionRef,
        leaseId,
        ownership: {
          mode: "direct",
          leaseId,
          sourceInventoryId: "inventory-private",
        },
      };
    },
  };
  const harness = await startApi(undefined, undefined, undefined, { dashboardApi });
  t.after(async () => harness.server.stop());
  const authorization = { Authorization: `Bearer ${TOKEN}` };

  const denied = await requestJson(harness.address, {
    path: "/v1/dashboard/inventory/inventory-private",
  });
  assert.equal(denied.status, 401);
  assert.equal(JSON.stringify(denied.value).includes("inventory-private"), false);

  const rootCapabilities = await requestJson(harness.address, {
    path: "/v1/capabilities",
    headers: authorization,
  });
  assert.equal(rootCapabilities.value.data.dashboard.authentication, "service-bearer");
  const dashCapabilities = await requestJson(harness.address, {
    path: "/v1/dashboard/capabilities",
    headers: authorization,
  });
  assert.deepEqual(dashCapabilities.value.data, capabilities);

  const list = await requestJson(harness.address, {
    path: "/v1/dashboard/inventory?limit=25&search=work&sourceKind=external,direct&unread=false",
    headers: authorization,
  });
  assert.equal(list.status, 200);
  assert.deepEqual(calls.at(-1), [
    "list",
    { limit: 25, search: "work", sourceKinds: ["external", "direct"], unread: false },
  ]);

  const info = await requestJson(harness.address, {
    path: "/v1/dashboard/inventory/inventory-private",
    headers: authorization,
  });
  assert.equal(info.value.data.source.aliases.length, 0);
  const transcript = await requestJson(harness.address, {
    path: "/v1/dashboard/inventory/inventory-private/transcript?limit=50&direction=older&fingerprint=sha256%3Afixture",
    headers: authorization,
  });
  assert.equal(transcript.value.data.hydration, "not-requested");
  assert.deepEqual(calls.at(-1), [
    "transcript",
    "inventory-private",
    { limit: 50, direction: "older" },
    "sha256:fixture",
  ]);

  const activationBody = {
    requestId: "activation-request",
    idempotencyKey: "activation-key",
    mode: "fork",
    expectedFingerprint: "sha256:fixture",
  };
  const activation = await requestJson(harness.address, {
    method: "POST",
    path: "/v1/dashboard/inventory/inventory-private/activate",
    headers: { ...authorization, "Idempotency-Key": "activation-key" },
    body: JSON.stringify(activationBody),
  });
  assert.equal(activation.status, 202);
  assert.equal(activation.value.requestId, "activation-request");
  assert.equal(activation.headers.location, "/v1/dashboard/activation/activation-ticket");
  const mismatch = await requestJson(harness.address, {
    method: "POST",
    path: "/v1/dashboard/inventory/inventory-private/activate",
    headers: { ...authorization, "Idempotency-Key": "wrong" },
    body: JSON.stringify(activationBody),
  });
  assert.equal(mismatch.status, 400);
  assert.equal(mismatch.value.error.code, "idempotency_key_mismatch");

  const exported = await requestJson(harness.address, {
    method: "POST",
    path: "/v1/dashboard/session/managed-private/export",
    headers: { ...authorization, "Idempotency-Key": "export-key" },
    body: JSON.stringify({
      requestId: "export-request",
      idempotencyKey: "export-key",
      mode: "as-new",
      expectedSourceFingerprint: "sha256:managed",
    }),
  });
  assert.equal(exported.status, 202);
  assert.equal(exported.value.requestId, "export-request");
  assert.equal(exported.headers.location, "/v1/dashboard/export/export-ticket");
  const lease = await requestJson(harness.address, {
    method: "POST",
    path: "/v1/dashboard/session/managed-private/lease",
    headers: authorization,
    body: JSON.stringify({ requestId: "lease-request", leaseId: "lease-private" }),
  });
  assert.equal(lease.status, 200);
  assert.equal(lease.value.requestId, "lease-request");
  assert.equal(lease.value.data.ownership.mode, "direct");

  const client = new SessionApiClient({
    baseUrl: `http://[${harness.address.host}]:${harness.address.port}`,
    bearerToken: TOKEN,
  });
  assert.equal((await client.dashboardCapabilities()).data.authentication, "service-bearer");
  assert.equal((await client.listDashboardSessions({ limit: 5 })).data.sessions.length, 0);
  assert.equal(
    (
      await client.activateDashboardSession("inventory-private", {
        requestId: "client-activation",
        idempotencyKey: "client-activation-key",
        mode: "fork",
        expectedFingerprint: "sha256:fixture",
      })
    ).data.ticketId,
    "activation-ticket",
  );
  assert.equal(
    (
      await client.renewDashboardLease("managed-private", {
        requestId: "client-lease",
        leaseId: "lease-private",
      })
    ).data.leaseId,
    "lease-private",
  );
  await assert.rejects(
    client.connectDashboardTui("managed-private"),
    /Unexpected server response: 501/,
  );

  const noProtocol = await rawUpgrade(
    harness.address,
    "/v1/dashboard/session/managed-private/tui",
    `Authorization: Bearer ${TOKEN}\r\n`,
  );
  assert.match(noProtocol, /^HTTP\/1\.1 426 Upgrade Required/);
  assert.match(noProtocol, /pi-daemon-tui\.v1/);
  const unavailable = await rawUpgrade(
    harness.address,
    "/v1/dashboard/session/managed-private/tui",
    `Authorization: Bearer ${TOKEN}\r\nSec-WebSocket-Protocol: ${DASHBOARD_TUI_SUBPROTOCOL}\r\n`,
  );
  assert.match(unavailable, /^HTTP\/1\.1 501 Not Implemented/);
  assert.match(unavailable, /tui_unavailable/);
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
  assert.match(authenticated, /^HTTP\/1\.1 426 Upgrade Required/);
  assert.match(authenticated, /rpc_subprotocol_required/);
  assert.equal(authenticated.includes(TOKEN), false);
});

const waitForTicket = async (address, ticketId, token) => {
  // Self-hosted Node jobs can be heavily CPU-throttled while sibling Nix jobs
  // build. Keep this finite but above the API's observed multi-second tail.
  const deadline = Date.now() + 15_000;
  while (true) {
    const response = await requestJson(address, {
      path: `/v1/ticket/${ticketId}`,
      headers: { Authorization: token },
    });
    assert.equal(response.status, 200);
    if (["succeeded", "failed", "indeterminate"].includes(response.value.data.state)) {
      return response.value.data;
    }
    if (Date.now() > deadline) throw new Error("timed out waiting for mutation ticket");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

const requestJson = async (address, options) => {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await requestJsonOnce(address, options);
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
};

const requestJsonOnce = async (address, options) =>
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

const connectWithRetry = async (address) => {
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
};

const rawUpgrade = async (address, path, extraHeaders = "") => {
  const socket = await connectWithRetry(address);
  return new Promise((resolve, reject) => {
    let response = "";
    socket.setEncoding("utf8");
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
    socket.on("data", (chunk) => (response += chunk));
    socket.on("end", () => resolve(response));
    socket.on("error", reject);
  });
};
