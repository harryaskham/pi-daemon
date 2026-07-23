import assert from "node:assert/strict";
import {
  chmod,
  mkdtemp,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { connect } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import WebSocket from "ws";

import { DASH_CSRF_HEADER, DashboardBrowserAuth } from "../dist/dashboard-auth.js";
import { DASH_STREAM_SUBPROTOCOL } from "../dist/dashboard-contract.js";
import { createDashboardContractFixtures } from "../dist/dashboard-fixtures.js";
import { loadPiDaemonConfig } from "../dist/config.js";
import { DashboardServer, createDashboardServerFromConfig } from "../dist/dashboard-server.js";
import { DashboardSettingsStore, DashboardWorkspaceStore } from "../dist/dashboard-store.js";
import { loadDashboardTls } from "../dist/dashboard-tls.js";
import { generateTlsPair } from "./tls-fixture.mjs";

const CREDENTIAL = "dashboard-server-fixture-credential-012345";

async function fixture(t, overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), "pi-daemon-dashboard-server-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const assetsDir = join(root, "assets-root");
  await mkdir(join(assetsDir, "assets"), { recursive: true, mode: 0o700 });
  await writeFile(
    join(assetsDir, "index.html"),
    '<!doctype html><html><head><link rel="stylesheet" href="/dash/assets/app-12345678.css"></head><body><div id="root"></div><script type="module" src="/dash/assets/app-12345678.js"></script></body></html>',
    { mode: 0o600 },
  );
  await writeFile(join(assetsDir, "assets", "app-12345678.js"), "globalThis.__dashLoaded=true;\n", { mode: 0o600 });
  await writeFile(join(assetsDir, "assets", "app-12345678.css"), ":root{color-scheme:dark}\n", { mode: 0o600 });
  const stateDir = join(root, "state");
  const auth = new DashboardBrowserAuth({
    credential: CREDENTIAL,
    sessionTtlMs: 60_000,
    secureCookies: overrides.secureCookies ?? false,
  });
  const calls = [];
  const fixtures = createDashboardContractFixtures();
  let schedule;
  let draft;
  let draftTicket;
  const scheduleCapabilities = { contractVersion: "1.0", persistence: true, timerRuntime: false, cronSyntax: "posix-five-field", timezoneDatabase: "runtime-iana", optimisticConcurrency: "expected-revision", overlapPolicies: ["skip", "queue-one", "reject"], missedWakePolicies: ["skip", "run-once", "bounded-catch-up"], promptHandling: "owner-private-sensitive-content", terminalTicketSummary: "content-free", clock: "wall-clock-utc-instants", limits: { maxSchedules: 1024, maxSchedulesPerSession: 32, maxPromptBytes: 65536, maxRecordBytes: 131072, maxRecoveryBytes: 134217728, maxCatchUpRuns: 24, maxJitterMs: 86400000, maxAdmissionDelayMs: 86400000 } };
  const backend = {
    async capabilities() { calls.push("capabilities"); return { ...fixtures.capabilities, resources: { ...fixtures.capabilities.resources, schedules: true, sessionDrafts: true } }; },
    async listSessions(query) { calls.push(["listSessions", query]); return fixtures.inventory; },
    async getSessionInfo(id) { calls.push(["getSessionInfo", id]); return fixtures.sessionInfo; },
    async getTranscript(id, query) { calls.push(["getTranscript", id, query]); return fixtures.transcript; },
    async activateSession(id, request) { calls.push(["activateSession", id, request]); return fixtures.activationTicket; },
    async getActivation(id) { calls.push(["getActivation", id]); return fixtures.activationTicket; },
    async exportSession(id, request) { calls.push(["exportSession", id, request]); return fixtures.exportTicket; },
    async getExport(id) { calls.push(["getExport", id]); return fixtures.exportTicket; },
    async createSessionDraft(request) { const now = "2026-07-19T14:40:00.000Z"; draft = { contractVersion: "1.0", draftId: request.draftId ?? "draft-server-01", revision: 1, state: "draft", createdAt: now, updatedAt: now, spec: request.spec, firstMessageStartsSession: true }; calls.push(["createSessionDraft", request]); return draft; },
    async getSessionDraft(id) { calls.push(["getSessionDraft", id]); if (draft === undefined) throw new Error("draft not found"); return draft; },
    async cancelSessionDraft(id, request) { calls.push(["cancelSessionDraft", id, request]); draft = { ...draft, revision: draft.revision + 1, state: "cancelled" }; return draft; },
    async sendSessionDraft(id, request) { calls.push(["sendSessionDraft", id, request]); const now = "2026-07-19T14:40:01.000Z"; draftTicket = { ticketId: "draft-send-server-01", draftId: id, draftRevision: request.expectedRevision, requestId: request.requestId, idempotencyKey: request.idempotencyKey, state: "queued", submittedAt: now, updatedAt: now }; return draftTicket; },
    async getSessionDraftSend(id) { calls.push(["getSessionDraftSend", id]); if (draftTicket === undefined) throw new Error("ticket not found"); return draftTicket; },
    async scheduleCapabilities() { return scheduleCapabilities; },
    async listSchedules() { return schedule === undefined ? [] : [schedule]; },
    async getSchedule() { return schedule; },
    async createSchedule(request) { const now = "2026-07-18T12:00:00.000Z"; schedule = { contractVersion: "1.0", ...request.schedule, revision: 0, createdAt: now, updatedAt: now }; return schedule; },
    async updateSchedule(_id, request) { schedule = { ...schedule, ...request.schedule, prompt: request.schedule.prompt ?? schedule.prompt, revision: schedule.revision + 1 }; return schedule; },
    async deleteSchedule() { schedule = undefined; },
    async scheduleStatus() { return { timerRuntime: false, externalTimersSupported: true, scheduleCount: schedule === undefined ? 0 : 1, enabledCount: schedule?.enabled ? 1 : 0 }; },
    async getManagedSession() { throw new Error("not used by HTTP fixture"); },
    async openSessionChannel() { throw new Error("not used by HTTP fixture"); },
    async openTuiChannel() { throw new Error("not used by HTTP fixture"); },
  };
  const limits = {
    maxHttpBodyBytes: 4096,
    maxWebSocketFrameBytes: 1024,
    maxOutboundBytesPerConnection: 8192,
    ...overrides.limits,
  };
  const server = new DashboardServer({
    backend,
    auth,
    workspaceStore: new DashboardWorkspaceStore({ stateDir, limits }),
    settingsStore: new DashboardSettingsStore({
      stateDir,
      limits,
      configuredUi: { theme: { name: "nord-midnight", density: "compact" } },
    }),
    assetsDir,
    host: overrides.host ?? "127.0.0.1",
    port: 0,
    serverInstanceId: "dash-server-fixture",
    ...(overrides.publicOrigin === undefined ? {} : { publicOrigin: overrides.publicOrigin }),
    ...(overrides.allowInsecureHttp === undefined
      ? {}
      : { allowInsecureHttp: overrides.allowInsecureHttp }),
    ...(overrides.trustForwardedHeaders === undefined
      ? {}
      : { trustForwardedHeaders: overrides.trustForwardedHeaders }),
    ...(overrides.tls === undefined ? {} : { tls: overrides.tls }),
    limits,
    ...(overrides.streamHandler === undefined ? {} : { streamHandler: overrides.streamHandler }),
  });
  const address = await server.start();
  t.after(async () => server.stop());
  return { root, assetsDir, stateDir, auth, backend, calls, fixtures, server, ...address };
}

async function login(origin, overrides = {}) {
  const response = await fetch(`${origin}/dash/v1/login`, {
    method: "POST",
    headers: {
      Origin: origin,
      "Content-Type": "application/json",
      "X-Request-ID": "request-login-fixture",
    },
    body: JSON.stringify({
      requestId: "request-login-fixture",
      clientId: "client-fixture",
      workspaceId: "workspace-fixture",
      credential: CREDENTIAL,
      ...overrides,
    }),
  });
  const json = await response.json();
  return {
    response,
    json,
    cookie: response.headers.get("set-cookie")?.split(";", 1)[0],
    csrf: json.data?.csrfToken,
  };
}

function privateHeaders(origin, session, mutation = false) {
  return {
    Cookie: session.cookie,
    ...(mutation ? { Origin: origin, "X-Pi-Daemon-CSRF": session.csrf } : {}),
  };
}

async function jsonResponse(response) {
  return { response, json: await response.json() };
}

async function httpCall({ host, port, path, method = "GET", headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      { host, port, path, method, headers },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.once("end", () =>
          resolve({
            status: response.statusCode,
            headers: response.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    request.once("error", reject);
    if (body !== undefined) request.write(body);
    request.end();
  });
}

async function httpsCall({ host, port, path, method = "GET", headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const request = httpsRequest(
      {
        host,
        port,
        path,
        method,
        servername: "dash.example.test",
        rejectUnauthorized: false,
        headers: { Host: "dash.example.test", ...headers },
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.once("end", () =>
          resolve({
            status: response.statusCode,
            headers: response.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    request.once("error", reject);
    if (body !== undefined) request.write(body);
    request.end();
  });
}

async function peerSerial(host, port, servername = "dash.example.test") {
  return new Promise((resolve, reject) => {
    const socket = tlsConnect({ host, port, servername, rejectUnauthorized: false });
    socket.once("secureConnect", () => {
      const serial = socket.getPeerCertificate().serialNumber;
      socket.end();
      resolve(serial);
    });
    socket.once("error", reject);
  });
}

async function eventually(check, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("condition did not become true before timeout");
}

test("serves only local content-hashed assets with strict CSP and immutable caching", async (t) => {
  const { origin, assetsDir, server } = await fixture(t);
  const index = await fetch(`${origin}/dash/`);
  assert.equal(index.status, 200);
  assert.equal(index.headers.get("cache-control"), "no-store, max-age=0");
  assert.match(index.headers.get("content-security-policy"), /default-src 'none'/);
  assert.match(index.headers.get("content-security-policy"), /script-src 'self'/);
  assert.match(index.headers.get("content-security-policy"), /connect-src 'self'/);
  assert.doesNotMatch(index.headers.get("content-security-policy"), /connect-src[^;]*\bws:/);
  assert.equal(index.headers.get("x-content-type-options"), "nosniff");
  assert.equal(index.headers.get("x-frame-options"), "DENY");
  assert.doesNotMatch(await index.text(), /credential|bearer|token/i);

  const asset = await fetch(`${origin}/dash/assets/app-12345678.js`);
  assert.equal(asset.status, 200);
  assert.equal(asset.headers.get("cache-control"), "public, max-age=31536000, immutable");
  assert.equal(asset.headers.get("content-type"), "text/javascript; charset=utf-8");
  assert.match(await asset.text(), /__dashLoaded/);

  const traversal = await fetch(`${origin}/dash/assets/%2e%2e%2findex.html`);
  assert.equal(traversal.status, 404);
  const unhashed = await fetch(`${origin}/dash/assets/app.js`);
  assert.equal(unhashed.status, 404);
  const secret = join(assetsDir, "secret");
  await writeFile(secret, "secret", { mode: 0o600 });
  await symlink(secret, join(assetsDir, "assets", "link-12345678.js"));
  assert.equal((await fetch(`${origin}/dash/assets/link-12345678.js`)).status, 404);

  const wrongHostStatus = await new Promise((resolve, reject) => {
    const url = new URL(`${origin}/dash/`);
    const request = httpRequest(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        headers: { Host: "evil.invalid" },
      },
      (response) => {
        response.resume();
        response.once("end", () => resolve(response.statusCode));
      },
    );
    request.once("error", reject);
    request.end();
  });
  assert.equal(wrongHostStatus, 403);
  const latency = server.metrics.snapshot().summaries.dashboard_http_latency_ms;
  assert.ok(latency.count >= 6);
  assert.ok(latency.max >= latency.min);
});

test("loads bounded owner-controlled TLS file and descriptor sources", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-daemon-dashboard-tls-material-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { certFile, keyFile } = await generateTlsPair(root, "material");

  const fileMaterial = await loadDashboardTls({ certFile, keyFile, reloadIntervalMs: 1_000 });
  assert.ok(fileMaterial.cert.length > 0);
  assert.ok(fileMaterial.key.length > 0);
  assert.equal(typeof fileMaterial.reload, "function");

  await chmod(keyFile, 0o644);
  await assert.rejects(
    loadDashboardTls({ certFile, keyFile }),
    /private-key file must be owner-only/,
  );
  await chmod(keyFile, 0o600);

  const certHandle = await open(certFile, "r");
  const keyHandle = await open(keyFile, "r");
  try {
    const fdMaterial = await loadDashboardTls({ certFd: certHandle.fd, keyFd: keyHandle.fd });
    assert.ok(fdMaterial.cert.equals(fileMaterial.cert));
    assert.ok(fdMaterial.key.equals(fileMaterial.key));
    assert.equal(fdMaterial.reload, undefined);
  } finally {
    await certHandle.close();
    await keyHandle.close();
  }
});

test("native HTTPS enforces SNI, HSTS, secure cookies, downgrade and proxy authority", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-daemon-dashboard-native-tls-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { certFile, keyFile } = await generateTlsPair(root, "native");
  const tls = await loadDashboardTls({ certFile, keyFile });
  const direct = await fixture(t, {
    publicOrigin: "https://dash.example.test",
    secureCookies: true,
    tls,
  });

  const health = await httpsCall({ host: direct.host, port: direct.port, path: "/dash/healthz" });
  assert.equal(health.status, 204);
  assert.equal(health.headers["strict-transport-security"], "max-age=31536000");
  assert.equal(health.headers["cache-control"], "no-store, max-age=0");
  await assert.rejects(fetch(`http://${direct.host}:${direct.port}/dash/healthz`));
  await assert.rejects(peerSerial(direct.host, direct.port, "wrong.example.test"));

  const loginBody = JSON.stringify({
    requestId: "native-tls-login",
    clientId: "native-tls-client",
    workspaceId: "native-tls-workspace",
    credential: CREDENTIAL,
  });
  const loginResponse = await httpsCall({
    host: direct.host,
    port: direct.port,
    path: "/dash/v1/login",
    method: "POST",
    headers: {
      Origin: "https://dash.example.test",
      "Content-Type": "application/json",
      "Content-Length": String(Buffer.byteLength(loginBody)),
    },
    body: loginBody,
  });
  assert.equal(loginResponse.status, 200);
  assert.match(loginResponse.headers["set-cookie"][0], /^__Host-pi-daemon-dash=/);
  assert.match(loginResponse.headers["set-cookie"][0], /; Secure(?:;|$)/);

  const untrustedForwarded = await httpsCall({
    host: direct.host,
    port: direct.port,
    path: "/dash/healthz",
    headers: { "X-Forwarded-Host": "dash.example.test" },
  });
  assert.equal(untrustedForwarded.status, 403);

  const trusted = await fixture(t, {
    publicOrigin: "https://dash.example.test",
    secureCookies: true,
    tls,
    trustForwardedHeaders: true,
  });
  const exactForwarded = await httpsCall({
    host: trusted.host,
    port: trusted.port,
    path: "/dash/healthz",
    headers: {
      "X-Forwarded-Host": "dash.example.test",
      "X-Forwarded-Proto": "https",
      "X-Forwarded-Port": "443",
    },
  });
  assert.equal(exactForwarded.status, 204);
  const spoofedForwarded = await httpsCall({
    host: trusted.host,
    port: trusted.port,
    path: "/dash/healthz",
    headers: { "X-Forwarded-Proto": "http" },
  });
  assert.equal(spoofedForwarded.status, 403);
});

test("loopback reverse proxy mode verifies forwarded authority without deriving it", async (t) => {
  const proxy = await fixture(t, {
    publicOrigin: "https://dash.example.test",
    secureCookies: true,
    trustForwardedHeaders: true,
  });
  const exact = await httpCall({
    host: proxy.host,
    port: proxy.port,
    path: "/dash/healthz",
    headers: {
      Host: "dash.example.test",
      "X-Forwarded-Host": "dash.example.test",
      "X-Forwarded-Proto": "https",
      "X-Forwarded-Port": "443",
    },
  });
  assert.equal(exact.status, 204);
  assert.equal(exact.headers["strict-transport-security"], "max-age=31536000");

  const spoofed = await httpCall({
    host: proxy.host,
    port: proxy.port,
    path: "/dash/healthz",
    headers: {
      Host: "dash.example.test",
      "X-Forwarded-Host": "evil.example.test",
      "X-Forwarded-Proto": "https",
    },
  });
  assert.equal(spoofed.status, 403);
});

test("file-backed native TLS rotates atomically without dropping the listener", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-daemon-dashboard-tls-rotation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { certFile, keyFile } = await generateTlsPair(root, "current");
  const loaded = await loadDashboardTls({ certFile, keyFile, reloadIntervalMs: 1_000 });
  const server = await fixture(t, {
    publicOrigin: "https://dash.example.test",
    secureCookies: true,
    tls: { ...loaded, reloadIntervalMs: 25 },
  });
  const before = await peerSerial(server.host, server.port);

  const { certFile: nextCert, keyFile: nextKey } = await generateTlsPair(root, "next");
  await rename(nextCert, certFile);
  await rename(nextKey, keyFile);

  const after = await eventually(async () => {
    const serial = await peerSerial(server.host, server.port);
    return serial !== before ? serial : undefined;
  });
  assert.notEqual(after, before);
  assert.ok(server.server.metrics.snapshot().counters.dashboard_tls_rotations >= 1);
  assert.equal(
    (await httpsCall({ host: server.host, port: server.port, path: "/dash/healthz" })).status,
    204,
  );
});

test("authenticates before route existence and enforces exact Origin plus CSRF on mutations", async (t) => {
  const { origin } = await fixture(t);
  const first = await jsonResponse(await fetch(`${origin}/dash/v1/sessions/existing`, {
    headers: { "X-Request-ID": "request-unauthorized" },
  }));
  const second = await jsonResponse(await fetch(`${origin}/dash/v1/not-a-route`, {
    headers: { "X-Request-ID": "request-unauthorized" },
  }));
  assert.equal(first.response.status, 401);
  assert.equal(second.response.status, 401);
  assert.deepEqual(first.json, second.json);

  const noOrigin = await fetch(`${origin}/dash/v1/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ requestId: "request-login", clientId: "client", credential: CREDENTIAL }),
  });
  assert.equal(noOrigin.status, 403);
  const wrong = await login(origin, { credential: `${CREDENTIAL}-wrong` });
  assert.equal(wrong.response.status, 401);
  assert.equal(JSON.stringify(wrong.json).includes(CREDENTIAL), false);

  const session = await login(origin);
  assert.equal(session.response.status, 200);
  assert.match(session.response.headers.get("set-cookie"), /HttpOnly; SameSite=Strict/);
  const privateGet = await fetch(`${origin}/dash/v1/settings`, {
    headers: privateHeaders(origin, session),
  });
  assert.equal(privateGet.status, 200);
  const missingCsrf = await fetch(`${origin}/dash/v1/settings`, {
    method: "PATCH",
    headers: {
      ...privateHeaders(origin, session),
      Origin: origin,
      "Content-Type": "application/json",
      "If-Match": '"settings:0"',
    },
    body: JSON.stringify({ requestId: "request", idempotencyKey: "key", expectedRevision: 0, patch: {} }),
  });
  assert.equal(missingCsrf.status, 403);
  const wrongOrigin = await fetch(`${origin}/dash/v1/settings`, {
    method: "PATCH",
    headers: {
      ...privateHeaders(origin, session, true),
      Origin: "http://evil.invalid",
      "Content-Type": "application/json",
      "If-Match": '"settings:0"',
    },
    body: JSON.stringify({ requestId: "request", idempotencyKey: "key", expectedRevision: 0, patch: {} }),
  });
  assert.equal(wrongOrigin.status, 403);

  const logout = await fetch(`${origin}/dash/v1/logout`, {
    method: "POST",
    headers: privateHeaders(origin, session, true),
  });
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get("set-cookie"), /Max-Age=0/);
  assert.equal((await fetch(`${origin}/dash/v1/settings`, {
    headers: privateHeaders(origin, session),
  })).status, 401);
});

test("bootstrap stays preview-only and backend resources use bounded typed query routing", async (t) => {
  const { origin, calls, fixtures } = await fixture(t);
  const session = await login(origin);
  const bootstrap = await jsonResponse(await fetch(`${origin}/dash/v1/bootstrap`, {
    headers: privateHeaders(origin, session),
  }));
  assert.equal(bootstrap.response.status, 200);
  assert.equal(bootstrap.response.headers.get(DASH_CSRF_HEADER), session.json.data.csrfToken);
  assert.equal(bootstrap.json.data.capabilities.apiVersion, "1.0");
  assert.equal(bootstrap.json.data.capabilities.limits.browserSessionTtlMs, 60_000);
  assert.equal(bootstrap.json.data.workspace.workspaceId, "workspace-fixture");
  assert.equal(bootstrap.json.data.settings.effective.theme.density, "compact");
  assert.deepEqual(calls.map((call) => Array.isArray(call) ? call[0] : call), ["capabilities", "listSessions"]);

  calls.length = 0;
  const sessions = await fetch(`${origin}/dash/v1/sessions?limit=5&search=fixture&unread=true&runtime=running`, {
    headers: privateHeaders(origin, session),
  });
  assert.equal(sessions.status, 200);
  assert.deepEqual(calls[0], ["listSessions", { limit: 5, search: "fixture", runtime: ["running"], unread: true }]);
  assert.equal((await fetch(`${origin}/dash/v1/sessions?limit=99999`, {
    headers: privateHeaders(origin, session),
  })).status, 400);

  calls.length = 0;
  const transcript = await jsonResponse(await fetch(`${origin}/dash/v1/sessions/inventory-fixture-01/transcript?limit=10&direction=older`, {
    headers: privateHeaders(origin, session),
  }));
  assert.equal(transcript.response.status, 200);
  assert.equal(transcript.json.data.hydration, "not-requested");
  assert.deepEqual(calls[0], ["getTranscript", "inventory-fixture-01", { limit: 10, direction: "older" }]);
  assert.deepEqual(transcript.json.data.records, fixtures.transcript.records);

  calls.length = 0;
  const activation = await fetch(`${origin}/dash/v1/sessions/inventory-fixture-01/activate`, {
    method: "POST",
    headers: {
      ...privateHeaders(origin, session, true),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(fixtures.activationRequest),
  });
  assert.equal(activation.status, 202);
  assert.deepEqual(calls[0], ["activateSession", "inventory-fixture-01", fixtures.activationRequest]);
  const unsafeActivation = await fetch(`${origin}/dash/v1/sessions/inventory-fixture-01/activate`, {
    method: "POST",
    headers: {
      ...privateHeaders(origin, session, true),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ ...fixtures.activationRequest, credential: "must-not-reach-backend" }),
  });
  assert.equal(unsafeActivation.status, 400);
  assert.equal(calls.length, 1);

  const exported = await fetch(`${origin}/dash/v1/sessions/session-fixture-01/export`, {
    method: "POST",
    headers: {
      ...privateHeaders(origin, session, true),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(fixtures.exportRequest),
  });
  assert.equal(exported.status, 202);
  assert.deepEqual(calls[1], ["exportSession", "session-fixture-01", fixtures.exportRequest]);
});

test("lazy draft BFF CRUD is authenticated, revisioned, and separate from first-send execution", async (t) => {
  const h = await fixture(t);
  const session = await login(h.origin);
  const mutation = privateHeaders(h.origin, session, true);
  const spec = {
    cwd: h.root,
    persistence: "persistent",
    tools: { mode: "none" },
    resources: {
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      projectTrust: "deny",
    },
    isolation: { mode: "unisolated" },
  };
  const createBody = {
    requestId: "draft-create-server",
    idempotencyKey: "draft-create-server-key",
    draftId: "draft-server-01",
    spec,
  };
  const created = await fetch(`${h.origin}/dash/v1/session-drafts`, {
    method: "POST",
    headers: {
      ...mutation,
      "Content-Type": "application/json",
      "X-Request-ID": createBody.requestId,
      "Idempotency-Key": createBody.idempotencyKey,
    },
    body: JSON.stringify(createBody),
  });
  assert.equal(created.status, 201);
  const etag = created.headers.get("etag");
  assert.ok(etag);
  const createdBody = await created.json();
  assert.equal(createdBody.data.state, "draft");
  assert.equal(h.calls.some(([kind]) => kind === "createSessionDraft"), true);

  const read = await fetch(`${h.origin}/dash/v1/session-drafts/draft-server-01`, {
    headers: privateHeaders(h.origin, session),
  });
  assert.equal(read.status, 200);
  assert.equal(read.headers.get("etag"), etag);

  const sendBody = {
    requestId: "draft-send-server",
    idempotencyKey: "draft-send-server-key",
    expectedRevision: 1,
    message: "start once",
  };
  const sent = await fetch(`${h.origin}/dash/v1/session-drafts/draft-server-01/send`, {
    method: "POST",
    headers: {
      ...mutation,
      "Content-Type": "application/json",
      "X-Request-ID": sendBody.requestId,
      "Idempotency-Key": sendBody.idempotencyKey,
      "If-Match": etag,
    },
    body: JSON.stringify(sendBody),
  });
  assert.equal(sent.status, 202);
  const sentBody = await sent.json();
  assert.equal(sentBody.data.state, "queued");
  assert.equal(
    (await fetch(`${h.origin}/dash/v1/session-draft-send/${sentBody.data.ticketId}`, {
      headers: privateHeaders(h.origin, session),
    })).status,
    200,
  );

  const cancelBody = {
    requestId: "draft-cancel-server",
    idempotencyKey: "draft-cancel-server-key",
    expectedRevision: 1,
  };
  const cancelled = await fetch(`${h.origin}/dash/v1/session-drafts/draft-server-01`, {
    method: "DELETE",
    headers: {
      ...mutation,
      "Content-Type": "application/json",
      "X-Request-ID": cancelBody.requestId,
      "Idempotency-Key": cancelBody.idempotencyKey,
      "If-Match": etag,
    },
    body: JSON.stringify(cancelBody),
  });
  assert.equal(cancelled.status, 200);
  assert.equal((await cancelled.json()).data.state, "cancelled");

  const missingPrecondition = await fetch(`${h.origin}/dash/v1/session-drafts/draft-server-01/send`, {
    method: "POST",
    headers: {
      ...mutation,
      "Content-Type": "application/json",
      "X-Request-ID": sendBody.requestId,
      "Idempotency-Key": sendBody.idempotencyKey,
    },
    body: JSON.stringify(sendBody),
  });
  assert.equal(missingPrecondition.status, 412);
  assert.doesNotMatch(JSON.stringify(createdBody), /bearer|authorization|api[_-]?key/i);
});

test("schedule BFF routes keep prompts input-only and enforce CSRF, idempotency and exact ETags", async (t) => {
  const { origin } = await fixture(t);
  const session = await login(origin);
  const schedule = { scheduleId: "dash-job", sessionRef: "session-fixture-01", enabled: true, cron: "0 9 * * 1-5", timezone: "UTC", prompt: "private prompt sentinel", overlapPolicy: "skip", missedWakePolicy: { mode: "skip" }, jitterMs: 0, maxAdmissionDelayMs: 300000 };
  const request = { requestId: "schedule-create", idempotencyKey: "schedule-key", schedule };
  const missingCsrf = await fetch(`${origin}/dash/v1/schedules`, { method: "POST", headers: { Cookie: session.cookie, Origin: origin, "Content-Type": "application/json", "Idempotency-Key": request.idempotencyKey, "X-Request-ID": request.requestId }, body: JSON.stringify(request) });
  assert.equal(missingCsrf.status, 403);
  const created = await jsonResponse(await fetch(`${origin}/dash/v1/schedules`, { method: "POST", headers: { ...privateHeaders(origin, session, true), "Content-Type": "application/json", "Idempotency-Key": request.idempotencyKey, "X-Request-ID": request.requestId }, body: JSON.stringify(request) }));
  assert.equal(created.response.status, 201);
  assert.equal(created.response.headers.get("etag"), '"ZGFzaC1qb2I:0"');
  assert.equal(created.json.data.promptConfigured, true);
  assert.equal(JSON.stringify(created.json).includes("private prompt sentinel"), false);
  const listed = await jsonResponse(await fetch(`${origin}/dash/v1/schedules`, { headers: privateHeaders(origin, session) }));
  assert.equal(listed.json.data.schedules.length, 1);
  assert.equal(JSON.stringify(listed.json).includes("private prompt sentinel"), false);
  const update = { requestId: "schedule-update", idempotencyKey: "schedule-update-key", expectedRevision: 0, schedule: { ...schedule, enabled: false } };
  delete update.schedule.prompt;
  const stale = await fetch(`${origin}/dash/v1/schedules/dash-job`, { method: "PUT", headers: { ...privateHeaders(origin, session, true), "Content-Type": "application/json", "Idempotency-Key": update.idempotencyKey, "X-Request-ID": update.requestId, "If-Match": '"stale:0"' }, body: JSON.stringify(update) });
  assert.equal(stale.status, 412);
  const updated = await jsonResponse(await fetch(`${origin}/dash/v1/schedules/dash-job`, { method: "PUT", headers: { ...privateHeaders(origin, session, true), "Content-Type": "application/json", "Idempotency-Key": update.idempotencyKey, "X-Request-ID": update.requestId, "If-Match": '"ZGFzaC1qb2I:0"' }, body: JSON.stringify(update) }));
  assert.equal(updated.response.status, 200);
  assert.equal(updated.json.data.enabled, false);
  assert.equal(JSON.stringify(updated.json).includes("private prompt sentinel"), false);
  assert.equal((await fetch(`${origin}/dash/v1/schedules/capabilities`, { headers: privateHeaders(origin, session) })).status, 200);
  assert.equal((await fetch(`${origin}/dash/v1/schedules/status`, { headers: privateHeaders(origin, session) })).status, 200);
});

test("workspace and UI settings routes persist only the authenticated workspace with ETags", async (t) => {
  const { origin } = await fixture(t);
  const session = await login(origin);
  const workspaceGet = await jsonResponse(await fetch(`${origin}/dash/v1/workspaces/workspace-fixture`, {
    headers: privateHeaders(origin, session),
  }));
  assert.equal(workspaceGet.response.status, 200);
  const workspaceTag = workspaceGet.response.headers.get("etag");
  const workspacePut = await jsonResponse(await fetch(`${origin}/dash/v1/workspaces/workspace-fixture`, {
    method: "PUT",
    headers: {
      ...privateHeaders(origin, session, true),
      "Content-Type": "application/json",
      "If-Match": workspaceTag,
    },
    body: JSON.stringify({
      requestId: "request-workspace",
      idempotencyKey: "idempotency-workspace",
      expectedRevision: 0,
      selectedPaneId: "pane-main",
      layout: { type: "leaf", paneId: "pane-main", content: { type: "info", inventoryId: "inventory-fixture-01" } },
      seenCursors: {},
    }),
  }));
  assert.equal(workspacePut.response.status, 200);
  assert.equal(workspacePut.json.data.revision, 1);
  assert.equal((await fetch(`${origin}/dash/v1/workspaces/other-workspace`, {
    headers: privateHeaders(origin, session),
  })).status, 404);

  const settingsGet = await jsonResponse(await fetch(`${origin}/dash/v1/settings`, {
    headers: privateHeaders(origin, session),
  }));
  const settingsPatch = await jsonResponse(await fetch(`${origin}/dash/v1/settings`, {
    method: "PATCH",
    headers: {
      ...privateHeaders(origin, session, true),
      "Content-Type": "application/json",
      "If-Match": settingsGet.response.headers.get("etag"),
    },
    body: JSON.stringify({
      requestId: "request-settings",
      idempotencyKey: "idempotency-settings",
      expectedRevision: settingsGet.json.data.revision,
      patch: { editor: { mode: "vim" }, motion: { reduced: true } },
    }),
  }));
  assert.equal(settingsPatch.response.status, 200);
  assert.equal(settingsPatch.json.data.effective.editor.mode, "vim");
  assert.equal(settingsPatch.json.data.sources["editor.mode"], "runtime");
  const unsafe = await fetch(`${origin}/dash/v1/settings`, {
    method: "PATCH",
    headers: {
      ...privateHeaders(origin, session, true),
      "Content-Type": "application/json",
      "If-Match": settingsPatch.response.headers.get("etag"),
    },
    body: JSON.stringify({
      requestId: "request-unsafe",
      idempotencyKey: "idempotency-unsafe",
      expectedRevision: 1,
      patch: { auth: { tokenFile: "/tmp/no" } },
    }),
  });
  assert.equal(unsafe.status, 400);

  const reset = await jsonResponse(await fetch(`${origin}/dash/v1/settings`, {
    method: "DELETE",
    headers: {
      ...privateHeaders(origin, session, true),
      "If-Match": settingsPatch.response.headers.get("etag"),
      "Idempotency-Key": "idempotency-reset",
      "X-Expected-Revision": "1",
    },
  }));
  assert.equal(reset.response.status, 200);
  assert.deepEqual(reset.json.data.runtimeOverlay, {});
  assert.equal(reset.json.data.effective.theme.density, "compact");
});

test("instance YAML constructs the same secure server without exposing a daemon bearer", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-daemon-dashboard-config-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const configDir = join(root, "config");
  const stateDir = join(root, "state");
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  const configPath = join(configDir, "config.yaml");
  await writeFile(
    configPath,
    [
      "instance: test",
      "web:",
      "  enabled: true",
      "  mode: dedicated",
      "  bind: 127.0.0.1",
      "  port: 0",
      "  auth:",
      "    sessionTtlMs: 60000",
      "  inventory:",
      "    maxSessions: 250",
      "  ui:",
      "    editor:",
      "      mode: vim",
    ].join("\n") + "\n",
    { mode: 0o600 },
  );
  const loadedConfig = await loadPiDaemonConfig({ cliConfigPath: configPath, cliInstance: "test" });
  const fixtures = createDashboardContractFixtures();
  const backend = {
    async capabilities() { return fixtures.capabilities; },
    async listSessions() { return fixtures.inventory; },
    async getSessionInfo() { return fixtures.sessionInfo; },
    async getTranscript() { return fixtures.transcript; },
    async activateSession() { return fixtures.activationTicket; },
    async getActivation() { return fixtures.activationTicket; },
    async exportSession() { return fixtures.exportTicket; },
    async getExport() { return fixtures.exportTicket; },
    async getManagedSession() { throw new Error("unused"); },
    async openSessionChannel() { throw new Error("unused"); },
    async openTuiChannel() { throw new Error("unused"); },
  };
  const server = await createDashboardServerFromConfig({
    loadedConfig,
    backend,
    stateDir,
    serverInstanceId: "dash-config-fixture",
  });
  const { origin } = await server.start();
  t.after(async () => server.stop());
  const packagedIndex = await fetch(`${origin}/dash/`);
  assert.equal(packagedIndex.status, 200);
  assert.match(await packagedIndex.text(), /<div id="root"><\/div>/);
  const generatedCredential = (await readFile(join(stateDir, "web-token"), "utf8")).trim();
  const session = await login(origin, { credential: generatedCredential });
  assert.equal(session.response.status, 200);
  const settings = await jsonResponse(await fetch(`${origin}/dash/v1/settings`, {
    headers: privateHeaders(origin, session),
  }));
  assert.equal(settings.json.data.effective.editor.mode, "vim");
  assert.equal(settings.json.data.sources["editor.mode"], "config");
  assert.equal(JSON.stringify(settings.json).includes(CREDENTIAL), false);
});

test("slow partial HTTP bodies are terminated by the whole-request deadline", async (t) => {
  const { host, port, origin } = await fixture(t, { limits: { requestTimeoutMs: 75 } });
  const reply = await new Promise((resolve, reject) => {
    const socket = connect({ host, port });
    let data = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("slow request was not terminated"));
    }, 1500);
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => { data += chunk; });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.once("close", () => {
      clearTimeout(timer);
      resolve(data);
    });
    socket.once("connect", () => {
      socket.write([
        "POST /dash/v1/login HTTP/1.1",
        `Host: ${new URL(origin).host}`,
        `Origin: ${origin}`,
        "Content-Type: application/json",
        "Content-Length: 100",
        "Connection: close",
        "",
        "{",
      ].join("\r\n"));
    });
  });
  assert.match(reply, /HTTP\/1\.1 408 Request Timeout/);
});

test("HTTP bodies, static output, WebSocket origin/protocol and frame bytes are bounded", async (t) => {
  await assert.rejects(
    fixture(t, { host: "0.0.0.0" }),
    /plaintext Dashboard listener is loopback-only/,
  );
  await assert.rejects(
    fixture(t, { publicOrigin: "http://dash.example.test" }),
    /non-loopback Dashboard publicOrigin requires HTTPS/,
  );
  await assert.rejects(
    fixture(t, { limits: { maxWebSocketFrameBytes: 2048, maxOutboundBytesPerConnection: 1024 } }),
    /cannot exceed/,
  );
  await assert.rejects(
    fixture(t, { publicOrigin: "https://dash.example.test" }),
    /cookie security must match/,
  );
  let accepted;
  const ready = new Promise((resolve) => { accepted = resolve; });
  const { origin } = await fixture(t, {
    limits: { maxHttpBodyBytes: 256, maxWebSocketFrameBytes: 64 },
    streamHandler: ({ peer }) => {
      peer.send({ kind: "ready" });
      accepted(peer);
    },
  });
  const oversized = await fetch(`${origin}/dash/v1/login`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ padding: "x".repeat(1000) }),
  });
  assert.equal(oversized.status, 413);

  const session = await login(origin);
  const wsUrl = origin.replace(/^http/, "ws") + "/dash/v1/stream";
  const socket = new WebSocket(wsUrl, DASH_STREAM_SUBPROTOCOL, {
    origin,
    headers: { Cookie: session.cookie },
  });
  const firstMessage = new Promise((resolve, reject) => {
    socket.once("message", (data) => resolve(JSON.parse(data.toString())));
    socket.once("error", reject);
  });
  assert.deepEqual(await firstMessage, { kind: "ready" });
  await ready;
  const closed = new Promise((resolve) => socket.once("close", (code) => resolve(code)));
  socket.send("x".repeat(1000));
  assert.equal(await closed, 1009);

  const revocable = new WebSocket(wsUrl, DASH_STREAM_SUBPROTOCOL, {
    origin,
    headers: { Cookie: session.cookie },
  });
  await new Promise((resolve, reject) => {
    revocable.once("open", resolve);
    revocable.once("error", reject);
  });
  const revokedClose = new Promise((resolve) => revocable.once("close", (code) => resolve(code)));
  const logout = await fetch(`${origin}/dash/v1/logout`, {
    method: "POST",
    headers: privateHeaders(origin, session, true),
  });
  assert.equal(logout.status, 200);
  assert.equal(await revokedClose, 1008);

  const denied = new WebSocket(wsUrl, DASH_STREAM_SUBPROTOCOL, {
    origin: "http://evil.invalid",
    headers: { Cookie: session.cookie },
  });
  const deniedStatus = await new Promise((resolve) => {
    denied.once("unexpected-response", (_request, response) => resolve(response.statusCode));
    denied.once("error", () => resolve(0));
  });
  assert.equal(deniedStatus, 401);
});
