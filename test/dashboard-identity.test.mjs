import assert from "node:assert/strict";
import test from "node:test";

import { DashboardBrowserAuth } from "../dist/dashboard-auth.js";
import {
  DASHBOARD_LOCAL_OWNER_ID,
  StaticDashboardIdentityProvider,
  localOwnerIdentityProvider,
} from "../dist/dashboard-identity.js";

const ADMIN_TOKEN = "admin-fixture-token-0123456789abcdef";
const MEMBER_TOKEN = "member-fixture-token-0123456789abcdef";

function loginRequest(credential) {
  return {
    requestId: "request-login-identity",
    clientId: "client-identity",
    credential,
  };
}

function cookiePair(setCookie) {
  return setCookie.split(";", 1)[0];
}

test("static identity provider retains only bounded unique token digests", () => {
  const provider = new StaticDashboardIdentityProvider([
    {
      identityId: "admin-one",
      globalRole: "administrator",
      displayName: "Admin One",
      credential: ADMIN_TOKEN,
    },
    {
      identityId: "member-one",
      globalRole: "member",
      credential: MEMBER_TOKEN,
    },
  ]);
  assert.deepEqual(provider.authenticate(ADMIN_TOKEN), {
    identityId: "admin-one",
    globalRole: "administrator",
    displayName: "Admin One",
  });
  const member = provider.authenticate(MEMBER_TOKEN);
  assert.deepEqual(member, { identityId: "member-one", globalRole: "member" });
  member.identityId = "changed-by-caller";
  assert.equal(provider.authenticate(MEMBER_TOKEN).identityId, "member-one");
  assert.deepEqual(provider.principal("member-one"), {
    identityId: "member-one",
    globalRole: "member",
  });
  assert.equal(provider.principal("missing"), undefined);
  assert.equal(provider.authenticate("wrong-fixture-token-0123456789"), undefined);
  assert.equal(provider.authenticate("x"), undefined);
  assert.equal(provider.authenticate("x".repeat(5000)), undefined);

  assert.throws(
    () => new StaticDashboardIdentityProvider([
      { identityId: "same", globalRole: "administrator", credential: ADMIN_TOKEN },
      { identityId: "same", globalRole: "member", credential: MEMBER_TOKEN },
    ]),
    /IDs must be unique/,
  );
  assert.throws(
    () => new StaticDashboardIdentityProvider([
      { identityId: "one", globalRole: "administrator", credential: ADMIN_TOKEN },
      { identityId: "two", globalRole: "member", credential: ADMIN_TOKEN },
    ]),
    /credentials must be unique/,
  );
  assert.throws(
    () => new StaticDashboardIdentityProvider([
      { identityId: "member", globalRole: "member", credential: MEMBER_TOKEN },
    ]),
    /at least one administrator/,
  );
});

test("browser sessions bind the provider principal only in server-side state", () => {
  const provider = new StaticDashboardIdentityProvider([
    { identityId: "admin", globalRole: "administrator", credential: ADMIN_TOKEN },
    { identityId: "member", globalRole: "member", credential: MEMBER_TOKEN },
  ]);
  const auth = new DashboardBrowserAuth({
    identityProvider: provider,
    sessionTtlMs: 60_000,
  });
  const login = auth.login(loginRequest(MEMBER_TOKEN));
  assert.equal(JSON.stringify(login).includes("member"), false);
  assert.equal(JSON.stringify(login).includes(MEMBER_TOKEN), false);
  const authenticated = auth.authenticate(cookiePair(login.setCookie));
  assert.deepEqual(authenticated.principal, {
    identityId: "member",
    globalRole: "member",
  });
  assert.throws(
    () => new DashboardBrowserAuth({
      credential: ADMIN_TOKEN,
      identityProvider: provider,
      sessionTtlMs: 60_000,
    }),
    /exactly one/,
  );
});

test("provider revocation or principal-role change invalidates existing browser sessions", () => {
  let principal = { identityId: "member", globalRole: "member" };
  const provider = {
    authenticate(credential) {
      return credential === MEMBER_TOKEN && principal !== undefined
        ? structuredClone(principal)
        : undefined;
    },
    principal(identityId) {
      return principal?.identityId === identityId ? structuredClone(principal) : undefined;
    },
  };
  const auth = new DashboardBrowserAuth({ identityProvider: provider, sessionTtlMs: 60_000 });
  const login = auth.login(loginRequest(MEMBER_TOKEN));
  const cookie = cookiePair(login.setCookie);
  assert.equal(auth.authenticate(cookie).principal.globalRole, "member");
  principal = { identityId: "member", globalRole: "administrator" };
  assert.throws(() => auth.authenticate(cookie), /browser session is invalid/);

  const second = auth.login(loginRequest(MEMBER_TOKEN));
  principal = undefined;
  assert.throws(() => auth.authenticate(cookiePair(second.setCookie)), /browser session is invalid/);
});

test("single credential compatibility always resolves the local-owner administrator", () => {
  assert.deepEqual(localOwnerIdentityProvider(ADMIN_TOKEN).authenticate(ADMIN_TOKEN), {
    identityId: DASHBOARD_LOCAL_OWNER_ID,
    globalRole: "administrator",
    displayName: "Local owner",
  });
  const auth = new DashboardBrowserAuth({ credential: ADMIN_TOKEN, sessionTtlMs: 60_000 });
  const login = auth.login(loginRequest(ADMIN_TOKEN));
  assert.equal(
    auth.authenticate(cookiePair(login.setCookie)).principal.identityId,
    DASHBOARD_LOCAL_OWNER_ID,
  );
});
