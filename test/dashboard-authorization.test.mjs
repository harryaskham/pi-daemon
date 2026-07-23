import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  DashboardAuthorizationError,
  DashboardAuthorizationService,
  dashboardAuthorizationEtag,
} from "../dist/dashboard-authorization.js";

const ADMIN = Object.freeze({ identityId: "admin-one", globalRole: "administrator" });
const OWNER = Object.freeze({ identityId: "owner-one", globalRole: "member" });
const READER = Object.freeze({ identityId: "reader-one", globalRole: "member" });
const OTHER = Object.freeze({ identityId: "other-one", globalRole: "member" });
const SESSION = Object.freeze({ kind: "session", id: "inventory-session-one" });

async function fixture(t, options = {}) {
  const stateDir = await mkdtemp(join(tmpdir(), "pi-daemon-authorization-"));
  await chmod(stateDir, 0o700);
  t.after(async () => rm(stateDir, { recursive: true, force: true }));
  const service = new DashboardAuthorizationService({
    stateDir,
    mode: "multi-user",
    ...options,
  });
  await service.initialize();
  return { service, stateDir };
}

function hidden(error) {
  return error instanceof DashboardAuthorizationError &&
    error.code === "not_found" &&
    error.status === 404 &&
    error.message === "dashboard resource was not found";
}

test("central policies enforce read/control/admin without revealing absence", async (t) => {
  const { service } = await fixture(t);
  const created = await service.registerCreatedResource(OWNER, SESSION);
  assert.equal(created.ownerIdentityId, OWNER.identityId);
  assert.equal(created.revision, 1);
  assert.equal(
    dashboardAuthorizationEtag(created),
    '"dashboard-authorization:session:inventory-session-one:1"',
  );
  assert.equal(await service.effectiveRole(OWNER, SESSION), "admin");
  assert.equal(await service.effectiveRole(READER, SESSION), undefined);
  await assert.rejects(service.require(READER, SESSION, "read"), hidden);
  await assert.rejects(
    service.require(READER, { kind: "session", id: "does-not-exist" }, "read"),
    hidden,
  );

  const granted = await service.setGrant({
    principal: OWNER,
    resource: SESSION,
    subjectIdentityId: READER.identityId,
    role: "read",
    expectedRevision: created.revision,
  });
  assert.equal(granted.revision, 2);
  assert.deepEqual(await service.policy(OWNER, SESSION), granted);
  await assert.rejects(service.policy(READER, SESSION), hidden);
  assert.equal(await service.require(READER, SESSION, "read"), "read");
  await assert.rejects(service.require(READER, SESSION, "control"), hidden);
  await assert.rejects(
    service.setGrant({
      principal: OTHER,
      resource: SESSION,
      subjectIdentityId: OTHER.identityId,
      role: "admin",
      expectedRevision: granted.revision,
    }),
    hidden,
  );
  await assert.rejects(
    service.setGrant({
      principal: OWNER,
      resource: SESSION,
      subjectIdentityId: OTHER.identityId,
      role: "control",
      expectedRevision: created.revision,
    }),
    (error) => error instanceof DashboardAuthorizationError && error.code === "authorization_revision_conflict",
  );

  const controlled = await service.setGrant({
    principal: OWNER,
    resource: SESSION,
    subjectIdentityId: READER.identityId,
    role: "control",
    expectedRevision: granted.revision,
  });
  assert.equal(await service.require(READER, SESSION, "control"), "control");
  const revoked = await service.revokeGrant({
    principal: OWNER,
    resource: SESSION,
    subjectIdentityId: READER.identityId,
    expectedRevision: controlled.revision,
  });
  assert.equal(revoked.grants.length, 0);
  await assert.rejects(service.require(READER, SESSION, "read"), hidden);
});

test("ownership transfer is revisioned, durable and content-free audited", async (t) => {
  const { service, stateDir } = await fixture(t);
  const created = await service.adoptResource(ADMIN, SESSION, OWNER.identityId);
  const shared = await service.setGrant({
    principal: OWNER,
    resource: SESSION,
    subjectIdentityId: READER.identityId,
    role: "control",
    expectedRevision: created.revision,
  });
  const transferred = await service.transferOwnership({
    principal: OWNER,
    resource: SESSION,
    newOwnerIdentityId: READER.identityId,
    previousOwnerRole: "read",
    expectedRevision: shared.revision,
  });
  assert.equal(transferred.ownerIdentityId, READER.identityId);
  assert.deepEqual(transferred.grants, [{ identityId: OWNER.identityId, role: "read" }]);
  assert.equal(await service.effectiveRole(READER, SESSION), "admin");
  assert.equal(await service.effectiveRole(OWNER, SESSION), "read");

  const audit = await service.auditEvents(ADMIN);
  assert.deepEqual(audit.events.map(({ action }) => action), [
    "resource-adopted",
    "grant-set",
    "ownership-transferred",
  ]);
  assert.equal(audit.events.at(-1).previousOwnerIdentityId, OWNER.identityId);
  assert.equal(JSON.stringify(audit).includes("credential"), false);
  assert.equal(JSON.stringify(audit).includes("/Users/"), false);
  assert.deepEqual(
    (await service.auditEvents(READER, { resource: SESSION })).events.map(({ action }) => action),
    ["resource-adopted", "grant-set", "ownership-transferred"],
  );
  await assert.rejects(service.auditEvents(OWNER), hidden);
  await assert.rejects(
    service.auditEvents(OTHER, { resource: SESSION }),
    hidden,
  );

  const path = join(stateDir, "web", "authorization-v1.json");
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  const restarted = new DashboardAuthorizationService({ stateDir, mode: "multi-user" });
  await restarted.initialize();
  assert.equal(await restarted.effectiveRole(READER, SESSION), "admin");
  assert.equal(await restarted.effectiveRole(OWNER, SESSION), "read");
});

test("single-owner migration is implicit while multi-user unknown resources fail closed", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "pi-daemon-authorization-migration-"));
  await chmod(stateDir, 0o700);
  t.after(async () => rm(stateDir, { recursive: true, force: true }));
  const localOwner = Object.freeze({ identityId: "local-owner", globalRole: "member" });
  const single = new DashboardAuthorizationService({ stateDir });
  assert.equal(await single.effectiveRole(localOwner, SESSION), "admin");
  assert.equal(await single.effectiveRole(OTHER, SESSION), undefined);

  const multi = new DashboardAuthorizationService({ stateDir, mode: "multi-user" });
  assert.equal(await multi.effectiveRole(localOwner, SESSION), undefined);
  assert.equal(await multi.effectiveRole(ADMIN, SESSION), "admin");
});

test("authorization corruption and insecure files fail closed without quarantine reset", async (t) => {
  const { service, stateDir } = await fixture(t);
  await service.registerCreatedResource(OWNER, SESSION);
  const path = join(stateDir, "web", "authorization-v1.json");
  await writeFile(path, "{not-json}\n", "utf8");
  const corrupt = new DashboardAuthorizationService({ stateDir, mode: "multi-user" });
  await assert.rejects(
    corrupt.initialize(),
    (error) => error instanceof DashboardAuthorizationError && error.code === "authorization_state_corrupt",
  );
  assert.equal(await readFile(path, "utf8"), "{not-json}\n");

  await writeFile(path, "{}\n", { mode: 0o644 });
  await chmod(path, 0o644);
  const insecure = new DashboardAuthorizationService({ stateDir, mode: "multi-user" });
  await assert.rejects(
    insecure.initialize(),
    (error) => error instanceof DashboardAuthorizationError && error.code === "authorization_state_corrupt",
  );

  const linkedRoot = `${stateDir}-link`;
  await symlink(stateDir, linkedRoot, "dir");
  t.after(async () => rm(linkedRoot, { force: true }));
  await assert.rejects(
    new DashboardAuthorizationService({ stateDir: linkedRoot }).initialize(),
    /owner-only real directory/,
  );
});

test("failed durable writes roll authorization state back in memory", async (t) => {
  const { service } = await fixture(t, { limits: { maxBytes: 128 } });
  const mutation = service.registerCreatedResource(OWNER, SESSION);
  const concurrentRead = service.effectiveRole(OWNER, SESSION);
  await assert.rejects(
    mutation,
    (error) => error instanceof DashboardAuthorizationError && error.code === "authorization_state_capacity",
  );
  assert.equal(await concurrentRead, undefined);
  assert.equal(await service.effectiveRole(OWNER, SESSION), undefined);
});

test("policy, grant and retained audit bounds are explicit", async (t) => {
  assert.throws(
    () => new DashboardAuthorizationService({
      stateDir: "/unused",
      limits: { maxBytes: 64 * 1024 * 1024 + 1 },
    }),
    /hard limit/,
  );
  const { service } = await fixture(t, {
    limits: { maxPolicies: 1, maxGrantsPerPolicy: 1, maxAuditEvents: 2 },
  });
  const created = await service.registerCreatedResource(OWNER, SESSION);
  const granted = await service.setGrant({
    principal: OWNER,
    resource: SESSION,
    subjectIdentityId: READER.identityId,
    role: "read",
    expectedRevision: created.revision,
  });
  await assert.rejects(
    service.setGrant({
      principal: OWNER,
      resource: SESSION,
      subjectIdentityId: OTHER.identityId,
      role: "read",
      expectedRevision: granted.revision,
    }),
    (error) => error instanceof DashboardAuthorizationError && error.code === "authorization_grant_capacity",
  );
  await assert.rejects(
    service.registerCreatedResource(OWNER, { kind: "workspace", id: "workspace-two" }),
    (error) => error instanceof DashboardAuthorizationError && error.code === "authorization_policy_capacity",
  );
  const revoked = await service.revokeGrant({
    principal: OWNER,
    resource: SESSION,
    subjectIdentityId: READER.identityId,
    expectedRevision: granted.revision,
  });
  assert.equal(revoked.revision, 3);
  const audit = await service.auditEvents(ADMIN);
  assert.equal(audit.events.length, 2);
  assert.equal(audit.droppedEvents, 1);
  assert.equal(audit.nextSequence, 4);
});
