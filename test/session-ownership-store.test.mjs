import assert from "node:assert/strict";
import { chmod, lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  FileSessionOwnershipStore,
  SessionOwnershipStoreError,
  activationTicketResource,
  exportTicketResource,
  ownershipRecordInfo,
} from "../dist/session-ownership-store.js";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "pi-daemon-ownership-store-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  return root;
}

function ownershipRecord(overrides = {}) {
  return {
    formatVersion: 1,
    inventoryId: "inventory-one",
    managedSessionId: "managed-one",
    generation: 1,
    mode: "imported",
    status: "active",
    source: {
      canonicalPath: "/sessions/source.jsonl",
      value: "sha256:source",
      sizeBytes: 100,
      modifiedAt: "2026-07-18T12:00:00.000Z",
      device: "1",
      inode: "2",
      entryCount: 2,
      lastEntryId: "entry-two",
    },
    managedPath: "/managed/imported.jsonl",
    managedFingerprint: "sha256:managed",
    baseEntryIds: ["entry-one", "entry-two"],
    lease: {
      leaseId: "lease-one",
      acquiredAt: "2026-07-18T12:00:00.000Z",
      expiresAt: "2026-07-18T13:00:00.000Z",
    },
    exportedInventoryIds: [],
    createdAt: "2026-07-18T12:00:00.000Z",
    updatedAt: "2026-07-18T12:00:00.000Z",
    ...overrides,
  };
}

const activationRequest = (overrides = {}) => ({
  requestId: "request-activation",
  idempotencyKey: "activation-key",
  mode: "fork",
  expectedFingerprint: "sha256:source",
  policyRef: "trusted-runtime",
  ...overrides,
});

const exportRequest = (overrides = {}) => ({
  requestId: "request-export",
  idempotencyKey: "export-key",
  mode: "as-new",
  releaseAfterExport: false,
  ...overrides,
});

test("persists exact ownership mappings and resolves both identities", async (t) => {
  const stateDir = await fixture(t);
  const store = new FileSessionOwnershipStore({ stateDir });
  assert.deepEqual(await store.recover(), {
    records: [],
    queued: [],
    indeterminate: [],
    terminal: [],
  });
  const saved = await store.save(ownershipRecord());
  assert.equal(saved.inventoryId, "inventory-one");
  assert.equal((await store.getByInventory("inventory-one")).managedSessionId, "managed-one");
  assert.equal((await store.getByManagedSession("managed-one")).inventoryId, "inventory-one");
  assert.deepEqual(ownershipRecordInfo(saved), {
    mode: "imported",
    leaseId: "lease-one",
    sourceInventoryId: "inventory-one",
    exportedInventoryIds: [],
  });

  const restarted = new FileSessionOwnershipStore({ stateDir });
  assert.equal((await restarted.list()).length, 1);
  assert.equal((await restarted.getByManagedSession("managed-one")).source.lastEntryId, "entry-two");
  const path = join(stateDir, "web", "ownership-v1.json");
  assert.equal((await lstat(path)).mode & 0o777, 0o600);
  assert.equal((await readFile(path, "utf8")).includes("source.jsonl"), true);
});

test("activation and export tickets are durable, idempotent and typed", async (t) => {
  const stateDir = await fixture(t);
  const store = new FileSessionOwnershipStore({ stateDir });
  const activation = await store.beginActivation("inventory-one", activationRequest());
  assert.equal(activation.state, "queued");
  assert.deepEqual(await store.beginActivation("inventory-one", activationRequest()), activation);
  await assert.rejects(
    store.beginActivation("inventory-one", activationRequest({ mode: "direct" })),
    (error) => error instanceof SessionOwnershipStoreError && error.code === "idempotency_conflict",
  );
  await store.markRunning(activation.ticketId);
  const succeeded = await store.markActivationSucceeded(activation.ticketId, {
    managedSessionId: "managed-one",
    generation: 2,
  });
  assert.deepEqual(activationTicketResource(succeeded).managedSession, {
    sessionId: "managed-one",
    generation: 2,
  });

  const exported = await store.beginExport("managed-one", exportRequest());
  await store.markRunning(exported.ticketId);
  const exportedDone = await store.markExportSucceeded(exported.ticketId, {
    exportedInventoryId: "inventory-exported",
    sourceFingerprint: "sha256:exported",
  });
  assert.deepEqual(exportTicketResource(exportedDone), {
    ticketId: exported.ticketId,
    requestId: "request-export",
    idempotencyKey: "export-key",
    sessionRef: "managed-one",
    mode: "as-new",
    state: "succeeded",
    submittedAt: exported.submittedAt,
    updatedAt: exportedDone.updatedAt,
    exportedInventoryId: "inventory-exported",
    sourceFingerprint: "sha256:exported",
  });
});

test("restart makes running work indeterminate and never replays it", async (t) => {
  const stateDir = await fixture(t);
  const first = new FileSessionOwnershipStore({ stateDir });
  const running = await first.beginActivation("inventory-one", activationRequest());
  await first.markRunning(running.ticketId);
  const queued = await first.beginExport("managed-one", exportRequest());

  const restarted = new FileSessionOwnershipStore({ stateDir });
  const recovery = await restarted.recover();
  assert.equal(recovery.indeterminate.length, 1);
  assert.equal(recovery.indeterminate[0].ticketId, running.ticketId);
  assert.equal(recovery.queued.length, 1);
  assert.equal(recovery.queued[0].ticketId, queued.ticketId);
  assert.equal((await restarted.getTicket(running.ticketId)).state, "indeterminate");
  await assert.rejects(
    restarted.markRunning(running.ticketId),
    (error) =>
      error instanceof SessionOwnershipStoreError &&
      error.code === "invalid_ownership_ticket_transition",
  );
});

test("mapping uniqueness, state bytes and private corruption fail closed", async (t) => {
  const stateDir = await fixture(t);
  const store = new FileSessionOwnershipStore({ stateDir, maxStateBytes: 16 * 1024 });
  await store.save(ownershipRecord());
  await assert.rejects(
    store.save(
      ownershipRecord({
        inventoryId: "inventory-two",
        lease: { leaseId: "lease-two", acquiredAt: "2026-07-18T12:00:00.000Z" },
      }),
    ),
    (error) =>
      error instanceof SessionOwnershipStoreError &&
      error.code === "managed_session_already_owned",
  );

  const path = join(stateDir, "web", "ownership-v1.json");
  await writeFile(path, "not-json", { mode: 0o600 });
  await assert.rejects(new FileSessionOwnershipStore({ stateDir }).recover());
  await chmod(path, 0o666);
  await assert.rejects(
    new FileSessionOwnershipStore({ stateDir }).recover(),
    (error) => error instanceof Error,
  );
});
