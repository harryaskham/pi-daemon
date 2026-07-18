import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  DASH_BROWSER_COOKIE,
  DASH_BROWSER_SECURE_COOKIE,
  DashboardAuthError,
  DashboardBrowserAuth,
  ensureDashboardCredentialFile,
  readPrivateDashboardCredential,
} from "../dist/dashboard-auth.js";

const CREDENTIAL = "fixture-web-credential-0123456789";

function loginRequest(overrides = {}) {
  return {
    requestId: "request-login-01",
    clientId: "client-browser-01",
    credential: CREDENTIAL,
    ...overrides,
  };
}

function cookiePair(setCookie) {
  return setCookie.split(";", 1)[0];
}

test("web credential exchange issues revocable HttpOnly Strict sessions without retaining plaintext", () => {
  let now = new Date("2026-07-18T12:00:00.000Z");
  const auth = new DashboardBrowserAuth({
    credential: CREDENTIAL,
    sessionTtlMs: 60_000,
    now: () => now,
  });
  const login = auth.login(loginRequest({ workspaceId: "workspace-fixture" }));
  assert.match(login.setCookie, new RegExp(`^${DASH_BROWSER_COOKIE}=v1\\.`));
  assert.match(login.setCookie, /; Path=\/dash\/; HttpOnly; SameSite=Strict; Max-Age=60$/);
  assert.doesNotMatch(login.setCookie, /Secure/);
  assert.equal(login.session.clientId, "client-browser-01");
  assert.equal(login.session.workspaceId, "workspace-fixture");
  assert.equal(login.session.expiresAt, "2026-07-18T12:01:00.000Z");
  assert.notEqual(login.session.csrfToken, CREDENTIAL);
  assert.equal(JSON.stringify(login).includes(CREDENTIAL), false);

  const session = auth.authenticate(cookiePair(login.setCookie));
  assert.equal(session.workspaceId, "workspace-fixture");
  auth.authorizeCsrf(session, login.session.csrfToken);
  assert.throws(
    () => auth.authorizeCsrf(session, "wrong-csrf"),
    (error) => error instanceof DashboardAuthError && error.code === "csrf_failed",
  );
  const expiredCookie = auth.revoke(session);
  assert.match(expiredCookie, /Max-Age=0/);
  assert.throws(
    () => auth.authenticate(cookiePair(login.setCookie)),
    (error) => error instanceof DashboardAuthError && error.code === "unauthorized",
  );

  const second = auth.login(loginRequest({ requestId: "request-login-02" }));
  now = new Date("2026-07-18T12:01:00.001Z");
  assert.throws(
    () => auth.authenticate(cookiePair(second.setCookie)),
    (error) => error instanceof DashboardAuthError && error.code === "unauthorized",
  );
  assert.equal(auth.activeSessions, 0);
});

test("secure deployments use a __Host cookie and all login failures are content-free", () => {
  assert.throws(
    () => new DashboardBrowserAuth({ credential: CREDENTIAL, sessionTtlMs: 8 * 24 * 60 * 60 * 1000 }),
    /seven-day/,
  );
  const auth = new DashboardBrowserAuth({
    credential: CREDENTIAL,
    sessionTtlMs: 60_000,
    secureCookies: true,
    maxSessions: 1,
  });
  assert.throws(
    () => auth.login({ requestId: null, clientId: null, credential: CREDENTIAL }),
    (error) => error instanceof DashboardAuthError && error.code === "invalid_request",
  );
  assert.throws(
    () => auth.login(loginRequest({ credential: `${CREDENTIAL}-wrong` })),
    (error) =>
      error instanceof DashboardAuthError &&
      error.code === "login_failed" &&
      !error.message.includes(CREDENTIAL),
  );
  const login = auth.login(loginRequest());
  assert.match(login.setCookie, new RegExp(`^${DASH_BROWSER_SECURE_COOKIE}=`));
  assert.match(login.setCookie, /; Secure$/);
  assert.throws(
    () => auth.login(loginRequest({ requestId: "request-login-capacity" })),
    (error) => error instanceof DashboardAuthError && error.code === "browser_session_capacity",
  );
  assert.throws(() => auth.authenticate(`${cookiePair(login.setCookie)}; ${cookiePair(login.setCookie)}`));
});

test("first launch atomically creates one stable owner-only web credential", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-daemon-web-auth-create-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const path = join(root, "private", "web-token");
  const created = await Promise.all([
    ensureDashboardCredentialFile(path),
    ensureDashboardCredentialFile(path),
  ]);
  assert.deepEqual(created.sort(), [false, true]);
  const credential = await readPrivateDashboardCredential(path);
  assert.match(credential, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(await ensureDashboardCredentialFile(path), false);
  assert.equal(await readPrivateDashboardCredential(path), credential);
});

test("credential files are owner-only regular bounded files", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-daemon-web-auth-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const path = join(root, "web-token");
  await writeFile(path, `${CREDENTIAL}\n`, { mode: 0o600 });
  assert.equal(await readPrivateDashboardCredential(path), CREDENTIAL);
  const auth = await DashboardBrowserAuth.fromTokenFile(path, { sessionTtlMs: 30_000 });
  assert.equal(auth.login(loginRequest()).session.clientId, "client-browser-01");

  await chmod(path, 0o644);
  await assert.rejects(readPrivateDashboardCredential(path), /owner-only/);
  await chmod(path, 0o600);
  const link = join(root, "web-token-link");
  await symlink(path, link);
  await assert.rejects(readPrivateDashboardCredential(link), /non-symlink/);
  const oversized = join(root, "oversized");
  await writeFile(oversized, "x".repeat(5000), { mode: 0o600 });
  await assert.rejects(readPrivateDashboardCredential(oversized), /byte limit/);
});
