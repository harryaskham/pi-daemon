import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DashboardAuthorizationService } from "../dist/dashboard-authorization.js";
import {
  DashboardAuthorizationEnforcer,
  managedSessionRef,
  primarySessionRef,
} from "../dist/dashboard-authorization-enforcer.js";
import { asDashboardCursor } from "../dist/dashboard-contract.js";
import { createDashboardContractFixtures } from "../dist/dashboard-fixtures.js";

const LOCAL_OWNER = { identityId: "local-owner", globalRole: "administrator" };
const ADMIN = { identityId: "admin", globalRole: "administrator" };
const MEMBER = { identityId: "member", globalRole: "member" };
const OTHER = { identityId: "other", globalRole: "member" };

async function fixture(t, overrides = {}) {
  const stateDir = await mkdtemp(join(tmpdir(), "pi-daemon-auth-enforcer-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const base = createDashboardContractFixtures().sessionInfo;
  const records = Array.from({ length: 6 }, (_, index) => ({
    ...base,
    inventoryId: `inventory-${index + 1}`,
    piSessionId: `pi-session-${index + 1}`,
    title: `Session ${index + 1}`,
    managed: {
      ...base.managed,
      sessionId: `managed-session-${index + 1}`,
    },
    source: {
      ...base.source,
      aliases: [{ inventoryId: `inventory-${index + 1}` }],
    },
  }));
  const calls = [];
  const backend = {
    async listSessions(query) {
      calls.push(["list", structuredClone(query)]);
      const offset = query.cursor === undefined ? 0 : Number(String(query.cursor).split(":").at(-1));
      const limit = query.limit ?? 2;
      const page = records.slice(offset, offset + limit);
      const next = offset + page.length;
      return {
        sessions: page.map(({ source: _source, ownership: _ownership, diagnostics: _diagnostics, runtime: _runtime, cwd: _cwd, ...record }) => record),
        ...(next < records.length ? { nextCursor: asDashboardCursor(`backend:${next}`) } : {}),
        index: { formatVersion: 1, loadedAt: "2026-07-23T00:00:00.000Z", stale: false, reconciling: false },
      };
    },
    async getSessionInfo(id) {
      calls.push(["info", id]);
      const value = records.find((record) => record.inventoryId === id);
      if (value === undefined) {
        throw Object.assign(new Error("inventory session does not exist"), {
          code: "inventory_not_found",
        });
      }
      return structuredClone(value);
    },
    async getManagedSession(id) {
      calls.push(["managed", id]);
      const value = records.find((record) => record.managed.sessionId === id);
      if (value === undefined) {
        throw Object.assign(new Error("managed session does not exist"), {
          code: "session_not_found",
        });
      }
      return { sessionId: id, generation: value.managed.generation };
    },
    ...overrides.backend,
  };
  const authorization = new DashboardAuthorizationService({
    stateDir,
    mode: overrides.mode ?? "multi-user",
  });
  const enforcer = new DashboardAuthorizationEnforcer({
    backend,
    authorization,
    maxInventoryPageItems: 2,
    maxScanPages: overrides.maxScanPages ?? 4,
    maxCursors: 4,
    cursorTtlMs: 60_000,
  });
  await enforcer.initialize();
  return { authorization, backend, calls, enforcer, records };
}

async function grantRead(authorization, record) {
  const resource = primarySessionRef(record);
  const policy = await authorization.adoptResource(ADMIN, resource, ADMIN.identityId);
  await authorization.setGrant({
    principal: ADMIN,
    resource,
    subjectIdentityId: MEMBER.identityId,
    role: "read",
    expectedRevision: policy.revision,
  });
  return resource;
}

test("single-owner migration preserves visibility while replacing only opaque cursor internals", async (t) => {
  const { enforcer } = await fixture(t, { mode: "single-owner" });
  const first = await enforcer.listSessions(LOCAL_OWNER, { limit: 2 });
  assert.deepEqual(first.sessions.map(({ inventoryId }) => inventoryId), [
    "inventory-1",
    "inventory-2",
  ]);
  assert.match(first.nextCursor, /^authorized-inventory:/);
  const second = await enforcer.listSessions(LOCAL_OWNER, {
    limit: 2,
    cursor: first.nextCursor,
  });
  assert.deepEqual(second.sessions.map(({ inventoryId }) => inventoryId), [
    "inventory-3",
    "inventory-4",
  ]);
});

test("inventory paging scans a fixed bound and exposes only principal-bound opaque cursors", async (t) => {
  const { authorization, calls, enforcer, records } = await fixture(t);
  await grantRead(authorization, records[1]);
  await grantRead(authorization, records[3]);
  await grantRead(authorization, records[5]);

  const first = await enforcer.listSessions(MEMBER, { limit: 2 });
  assert.deepEqual(first.sessions.map(({ inventoryId }) => inventoryId), ["inventory-2", "inventory-4"]);
  assert.match(first.nextCursor, /^authorized-inventory:/);
  assert.equal(calls.filter(([kind]) => kind === "list").length, 4);
  assert.equal(JSON.stringify(first).includes("inventory-1"), false);

  await assert.rejects(
    enforcer.listSessions(OTHER, { limit: 2, cursor: first.nextCursor }),
    (error) => error.code === "inventory_cursor_invalid" && error.status === 400,
  );
  const second = await enforcer.listSessions(MEMBER, { limit: 2, cursor: first.nextCursor });
  assert.deepEqual(second.sessions.map(({ inventoryId }) => inventoryId), ["inventory-6"]);
  assert.equal(second.nextCursor, undefined);
});

test("unauthorized-only scan-ahead never emits a cardinality cursor", async (t) => {
  const { enforcer } = await fixture(t, { maxScanPages: 1 });
  const page = await enforcer.listSessions(MEMBER, { limit: 1 });
  assert.deepEqual(page.sessions, []);
  assert.equal(page.nextCursor, undefined);
});

test("absent and unauthorized inventory references have the same bounded denial", async (t) => {
  const { authorization, calls, enforcer, records } = await fixture(t);
  await grantRead(authorization, records[0]);

  const unauthorized = await enforcer.requireInventorySession(MEMBER, "inventory-2", "read")
    .then(() => undefined, (error) => error);
  const absent = await enforcer.requireInventorySession(MEMBER, "inventory-missing", "read")
    .then(() => undefined, (error) => error);
  assert.deepEqual(
    [unauthorized.code, unauthorized.status, unauthorized.message],
    [absent.code, absent.status, absent.message],
  );
  assert.deepEqual(
    calls.filter(([kind]) => kind === "info").map(([, id]) => id),
    ["inventory-2", "inventory-missing"],
  );

  const allowed = await enforcer.requireInventorySession(MEMBER, "inventory-1", "read");
  assert.equal(allowed.info.inventoryId, "inventory-1");
  assert.equal(allowed.role, "read");
});

test("managed-session references authorize before opening the machine backend", async (t) => {
  const { authorization, calls, enforcer, records } = await fixture(t);
  const resource = managedSessionRef(records[0].managed.sessionId);
  const policy = await authorization.adoptResource(ADMIN, resource, ADMIN.identityId);
  await authorization.setGrant({
    principal: ADMIN,
    resource,
    subjectIdentityId: MEMBER.identityId,
    role: "control",
    expectedRevision: policy.revision,
  });

  const allowed = await enforcer.requireManagedSession(
    MEMBER,
    records[0].managed.sessionId,
    "control",
  );
  assert.deepEqual(allowed, { resource, role: "control" });
  await assert.rejects(
    enforcer.requireManagedSession(OTHER, records[0].managed.sessionId, "read"),
    (error) => error.code === "not_found" && error.status === 404,
  );
  assert.equal(calls.filter(([kind]) => kind === "managed").length, 1);
  assert.equal(calls.filter(([kind]) => kind === "list").length, 0);
});
