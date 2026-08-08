import assert from "node:assert/strict";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import * as sessionInventorySurface from "../dist/session-inventory.js";
import {
  DEFAULT_SESSION_INVENTORY_LIMITS,
  SESSION_INVENTORY_FORMAT_VERSION,
  SESSION_INVENTORY_SEARCH_KEY_VERSION,
  SESSION_INVENTORY_SNAPSHOT_VERSION,
  SessionInventory,
  SessionInventoryError,
  resolveSessionInventoryConfig,
} from "../dist/session-inventory.js";
import * as sessionInventoryContract from "../dist/session-inventory-contract.js";
import { formatSessionSourceFingerprint } from "../dist/source-fingerprint.js";

class FakeCatalog {
  constructor(records = []) {
    this.records = records;
  }

  async recover() {
    return structuredClone(this.records);
  }
}

test("focused inventory internals preserve the exact public runtime surface", () => {
  assert.deepEqual(Object.keys(sessionInventorySurface).sort(), [
    "DEFAULT_SESSION_INVENTORY_LIMITS",
    "SESSION_INVENTORY_FORMAT_VERSION",
    "SESSION_INVENTORY_SEARCH_KEY_VERSION",
    "SESSION_INVENTORY_SNAPSHOT_VERSION",
    "SessionInventory",
    "SessionInventoryError",
    "resolveSessionInventoryConfig",
  ]);
  assert.equal(SessionInventoryError, sessionInventoryContract.SessionInventoryError);
  assert.equal(DEFAULT_SESSION_INVENTORY_LIMITS, sessionInventoryContract.DEFAULT_SESSION_INVENTORY_LIMITS);
  assert.equal(SESSION_INVENTORY_FORMAT_VERSION, sessionInventoryContract.SESSION_INVENTORY_FORMAT_VERSION);
  assert.equal(SESSION_INVENTORY_SEARCH_KEY_VERSION, sessionInventoryContract.SESSION_INVENTORY_SEARCH_KEY_VERSION);
  assert.equal(SESSION_INVENTORY_SNAPSHOT_VERSION, sessionInventoryContract.SESSION_INVENTORY_SNAPSHOT_VERSION);
});

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "pi-daemon-inventory-"));
  const stateDir = join(root, "state");
  const sessionsRoot = join(root, "sessions");
  await Promise.all([
    mkdir(stateDir, { mode: 0o700 }),
    mkdir(sessionsRoot, { mode: 0o700 }),
  ]);
  t.after(async () => rm(root, { recursive: true, force: true }));
  return { root, stateDir, sessionsRoot };
}

async function writeSession(
  directory,
  {
    filename,
    id,
    cwd = "/work/project",
    name,
    userText = "Inspect the nebula inventory fixture",
    timestamp = "2026-07-18T12:00:00.000Z",
    parentSession,
  },
) {
  const epoch = Date.parse(timestamp);
  const entries = [
    {
      type: "session",
      version: 3,
      id,
      timestamp,
      cwd,
      ...(parentSession === undefined ? {} : { parentSession }),
    },
    {
      type: "message",
      id: `${id}-user`,
      parentId: null,
      timestamp,
      message: { role: "user", content: [{ type: "text", text: userText }], timestamp: epoch },
    },
    {
      type: "message",
      id: `${id}-assistant`,
      parentId: `${id}-user`,
      timestamp,
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Bounded response" },
          { type: "toolCall", id: `${id}-tool`, name: "read", arguments: { path: "x" } },
        ],
        timestamp: epoch + 1,
      },
    },
    ...(name === undefined
      ? []
      : [
          {
            type: "session_info",
            id: `${id}-name`,
            parentId: `${id}-assistant`,
            timestamp: new Date(epoch + 2).toISOString(),
            name,
          },
        ]),
  ];
  const path = join(directory, filename);
  await writeFile(path, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, {
    mode: 0o600,
  });
  return path;
}

function catalogRecord(
  sessionId,
  {
    name,
    cwd = `/work/${sessionId}`,
    conversation,
    state = "idle",
    residency = "dormant",
    recovery,
    updatedAt = "2026-07-18T12:00:00.000Z",
  } = {},
) {
  return {
    formatVersion: 1,
    sessionId,
    ...(name === undefined ? {} : { name }),
    generation: 1,
    revision: 1,
    residency,
    state,
    createdAt: "2026-07-18T11:00:00.000Z",
    updatedAt,
    lastUsedAt: updatedAt,
    spec: {
      cwd,
      target: conversation === undefined ? { mode: "memory" } : { mode: "open", path: conversation.sessionFile },
      isolation: { mode: "unisolated" },
    },
    environment: { keys: [], persistence: "memory-only", provisioned: true },
    policyDigest: `digest-${sessionId}`,
    ...(conversation === undefined ? {} : { conversation }),
    ...(recovery === undefined ? {} : { recovery }),
  };
}

const issueCodes = (result) => new Set(result.issues.map((issue) => issue.code));

async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
  assert.fail("condition did not become true before deadline");
}

test("persisted inventory boots before reconcile and never stores full search text", async (t) => {
  const { stateDir, sessionsRoot } = await fixture(t);
  const source = await writeSession(sessionsRoot, {
    filename: "one.jsonl",
    id: "pi-one",
    name: "Named session",
    userText: "ultra secret nebula body used only to build keyed search grams",
  });
  const inventory = new SessionInventory({
    stateDir,
    catalog: new FakeCatalog(),
    roots: [sessionsRoot],
    activationPolicy: () => ({ eligible: true, modes: ["direct", "fork"] }),
  });

  await inventory.initialize();
  assert.equal((await inventory.list()).sessions.length, 0);
  assert.equal(inventory.status().stale, true);

  const reconciled = await inventory.reconcile();
  assert.equal(reconciled.records, 1);
  const page = await inventory.list({ search: "nebula body" });
  assert.equal(page.sessions.length, 1);
  assert.equal(page.sessions[0].title, "Named session");
  assert.deepEqual(page.sessions[0].activation, {
    eligible: true,
    modes: ["direct", "fork"],
  });
  assert.equal(page.index.stale, false);

  const info = await inventory.getInfo(page.sessions[0].inventoryId);
  assert.equal(info.cwd, "/work/project");
  assert.equal(info.source.canonicalPath, await realpath(source));
  assert.equal(info.source.fingerprint.sizeBytes > 0, true);
  assert.equal(info.toolCallCount, 1);

  const indexPath = join(stateDir, "web", "inventory-v1.json");
  const indexText = await readFile(indexPath, "utf8");
  const headPath = join(stateDir, "web", "inventory-v1.head.json");
  const headSnapshotPath = join(stateDir, "web", "inventory-v1.head.snapshot");
  const headText = await readFile(headPath, "utf8");
  const headSnapshot = await readFile(headSnapshotPath);
  assert.equal(headText.includes("canonicalPath"), false);
  assert.equal(headSnapshot.includes(Buffer.from("canonicalPath")), false);
  assert.equal(headText.includes("searchBloom"), false);
  assert.equal(headText.includes("/work/project"), false);
  assert.equal(indexText.includes("ultra secret nebula body"), false);
  assert.equal(indexText.includes("searchExcerpt"), false);
  assert.equal(indexText.includes("searchBloom"), true);
  assert.equal((await lstat(indexPath)).mode & 0o777, 0o600);
  assert.equal((await lstat(headSnapshotPath)).mode & 0o777, 0o600);
  assert.equal((await lstat(join(stateDir, "web", "inventory-search-key-v1.json"))).mode & 0o777, 0o600);

  // A snapshot produced by another Node major is an optimization miss, not
  // corruption: startup must use the portable JSON hot-head without quarantine.
  const incompatibleHeadSnapshot = Buffer.from(headSnapshot);
  incompatibleHeadSnapshot.writeUInt8(255, 9);
  await writeFile(headSnapshotPath, incompatibleHeadSnapshot, { mode: 0o600 });
  await rm(source);
  const restarted = new SessionInventory({
    stateDir,
    catalog: new FakeCatalog(),
    roots: [sessionsRoot],
  });
  await restarted.initialize();
  assert.equal(restarted.status().records, 1);
  assert.equal((await restarted.list({ limit: 1 })).sessions[0].title, "Named session");
  assert.equal((await restarted.list({ search: "nebula body" })).sessions.length, 1);
  assert.equal(
    (await readdir(join(stateDir, "web"))).some((name) => name.includes("head.snapshot.quarantine")),
    false,
  );
});

test("activation recency is durable, sorts to the top, and preserves source modified truth", async (t) => {
  const { stateDir, sessionsRoot } = await fixture(t);
  await writeSession(sessionsRoot, {
    filename: "older.jsonl",
    id: "pi-older",
    name: "Older session",
    timestamp: "2026-07-18T10:00:00.000Z",
  });
  await writeSession(sessionsRoot, {
    filename: "newer.jsonl",
    id: "pi-newer",
    name: "Newer session",
    timestamp: "2026-07-18T11:00:00.000Z",
  });
  const inventory = new SessionInventory({
    stateDir,
    catalog: new FakeCatalog(),
    roots: [sessionsRoot],
    activationPolicy: () => ({ eligible: true, modes: ["direct", "fork"] }),
  });
  await inventory.reconcile();
  let page = await inventory.list();
  assert.deepEqual(page.sessions.map((record) => record.piSessionId), ["pi-newer", "pi-older"]);
  const beforeActivationPage = await inventory.list({ limit: 1 });
  assert.ok(beforeActivationPage.nextCursor);
  const older = page.sessions[1];
  const sourceModifiedAt = older.modifiedAt;
  const activatedAt = "2026-07-18T12:00:00.000Z";
  const activated = await inventory.markActive(older.inventoryId, { at: activatedAt });
  assert.equal(activated.activityAt, activatedAt);
  assert.equal(activated.modifiedAt, sourceModifiedAt);
  assert.equal(activated.presence.activation, "selected");
  await assert.rejects(
    inventory.list({ limit: 1, cursor: beforeActivationPage.nextCursor }),
    (error) => error instanceof SessionInventoryError && error.code === "stale_inventory_cursor",
  );
  page = await inventory.list({ limit: 1 });
  assert.equal(page.sessions[0].piSessionId, "pi-older");
  assert.equal(page.sessions[0].modifiedAt, sourceModifiedAt);
  assert.equal(page.sessions[0].activityAt, activatedAt);

  const restarted = new SessionInventory({
    stateDir,
    catalog: new FakeCatalog(),
    roots: [sessionsRoot],
    activationPolicy: () => ({ eligible: true, modes: ["direct", "fork"] }),
  });
  await restarted.initialize();
  await restarted.waitForFullIndex();
  assert.equal((await restarted.list({ limit: 1 })).sessions[0].piSessionId, "pi-older");
  await restarted.reconcile();
  assert.equal((await restarted.list({ limit: 1 })).sessions[0].activityAt, activatedAt);
});

test("managed/external/memory rows merge without collapsing duplicate Pi IDs", async (t) => {
  const { stateDir, sessionsRoot } = await fixture(t);
  const first = await writeSession(sessionsRoot, {
    filename: "first.jsonl",
    id: "duplicate-pi-id",
    userText: "first branch",
  });
  await writeSession(sessionsRoot, {
    filename: "second.jsonl",
    id: "duplicate-pi-id",
    userText: "second branch",
  });
  await symlink(first, join(sessionsRoot, "linked.jsonl"));
  await writeFile(join(sessionsRoot, "corrupt.jsonl"), "not json\n", { mode: 0o600 });

  const catalog = new FakeCatalog([
    catalogRecord("managed-one", {
      name: "Managed conversation",
      conversation: { sessionId: "duplicate-pi-id", sessionFile: first },
      residency: "resident",
    }),
    catalogRecord("memory-one", {
      name: "Memory conversation",
      recovery: {
        state: "reprovision_required",
        code: "tool_adapter_reprovision_required",
        retryable: true,
      },
    }),
  ]);
  const inventory = new SessionInventory({ stateDir, catalog, roots: [sessionsRoot] });
  const result = await inventory.reconcile();
  const codes = issueCodes(result);
  assert.equal(codes.has("inventory_duplicate_pi_session_id"), true);
  assert.equal(codes.has("inventory_symlink_skipped"), true);
  assert.equal(codes.has("corrupt_inventory_source"), true);

  const page = await inventory.list({ limit: 10 });
  assert.equal(page.sessions.length, 3);
  const managed = page.sessions.find((record) => record.sourceKind === "managed");
  const external = page.sessions.find((record) => record.sourceKind === "external");
  const memory = page.sessions.find((record) => record.sourceKind === "memory");
  assert.equal(managed.title, "Managed conversation");
  assert.equal(managed.presence.runtime, "resident-idle");
  assert.deepEqual(managed.activation, { eligible: true, modes: ["reuse"] });
  assert.deepEqual(external.activation, {
    eligible: false,
    modes: ["preview-only"],
    reasonCode: "activation-policy-required",
  });
  assert.equal(memory.title, "Memory conversation");
  assert.equal(memory.managed.recovery.code, "tool_adapter_reprovision_required");

  const memoryInfo = await inventory.getInfo(memory.inventoryId);
  assert.deepEqual(memoryInfo.managed.recovery, {
    state: "reprovision_required",
    code: "tool_adapter_reprovision_required",
    retryable: true,
  });
  const info = await inventory.getInfo(managed.inventoryId);
  assert.equal(info.source.aliases.length, 1);
  assert.equal(info.diagnostics[0].code, "duplicate_pi_session_id");
});

test("pagination/filter cursors are stable, opaque, and revision/query bound", async (t) => {
  const { stateDir, sessionsRoot } = await fixture(t);
  for (let index = 0; index < 4; index += 1) {
    await writeSession(sessionsRoot, {
      filename: `${index}.jsonl`,
      id: `pi-${index}`,
      name: `Session ${index}`,
      timestamp: new Date(Date.parse("2026-07-18T12:00:00.000Z") + index * 1000).toISOString(),
    });
  }
  const inventory = new SessionInventory({
    stateDir,
    catalog: new FakeCatalog(),
    roots: [sessionsRoot],
  });
  await inventory.reconcile();
  const first = await inventory.list({ limit: 2 });
  assert.deepEqual(first.sessions.map((record) => record.title), ["Session 3", "Session 2"]);
  assert.equal(typeof first.nextCursor, "string");
  const second = await inventory.list({ limit: 2, cursor: first.nextCursor });
  assert.deepEqual(second.sessions.map((record) => record.title), ["Session 1", "Session 0"]);

  await assert.rejects(
    inventory.list({ limit: 2, cursor: first.nextCursor, search: "Session" }),
    (error) => error instanceof SessionInventoryError && error.code === "stale_inventory_cursor",
  );
  assert.equal((await inventory.list({ sourceKinds: ["external"] })).sessions.length, 4);
  assert.equal((await inventory.list({ runtime: ["running"] })).sessions.length, 0);
  await assert.rejects(
    inventory.list({ search: "x".repeat(1025) }),
    (error) => error instanceof SessionInventoryError && error.code === "inventory_search_too_large",
  );

  await writeSession(sessionsRoot, {
    filename: "new.jsonl",
    id: "pi-new",
    name: "Newest",
    timestamp: "2026-07-18T13:00:00.000Z",
  });
  await inventory.reconcile();
  await assert.rejects(
    inventory.list({ limit: 2, cursor: first.nextCursor }),
    (error) => error instanceof SessionInventoryError && error.code === "stale_inventory_cursor",
  );
});

test("persisted freshness is age bounded independently of filesystem access", async (t) => {
  const { stateDir } = await fixture(t);
  let now = Date.parse("2026-07-18T12:00:00.000Z");
  const inventory = new SessionInventory({
    stateDir,
    catalog: new FakeCatalog([catalogRecord("memory")]),
    now: () => new Date(now),
    limits: { indexMaxAgeMs: 60_000 },
  });
  await inventory.reconcile();
  assert.equal(inventory.status().stale, false);
  now += 60_001;
  assert.equal(inventory.status().stale, true);
});

test("periodic reconcile repairs missed filesystem changes without request-path scans", async (t) => {
  const { stateDir, sessionsRoot } = await fixture(t);
  await writeSession(sessionsRoot, {
    filename: "initial.jsonl",
    id: "initial",
    name: "Initial",
  });
  const inventory = new SessionInventory({
    stateDir,
    catalog: new FakeCatalog(),
    roots: [sessionsRoot],
    limits: { reconcileIntervalMs: 20 },
  });
  await inventory.start();
  await waitFor(async () => (await inventory.list()).sessions.length === 1);

  await writeSession(sessionsRoot, {
    filename: "later.jsonl",
    id: "later",
    name: "Later",
    timestamp: "2026-07-18T13:00:00.000Z",
  });
  await waitFor(async () => (await inventory.list()).sessions.length === 2);
  assert.equal((await inventory.list()).sessions[0].title, "Later");
  await inventory.stop();
});

test("authenticated snapshot tampering falls back to canonical JSON", async (t) => {
  const { stateDir, sessionsRoot } = await fixture(t);
  await writeSession(sessionsRoot, {
    filename: "valid.jsonl",
    id: "valid",
    name: "Valid",
  });
  const inventory = new SessionInventory({ stateDir, catalog: new FakeCatalog(), roots: [sessionsRoot] });
  await inventory.reconcile();
  const snapshotPath = join(stateDir, "web", "inventory-v1.snapshot");
  const snapshot = await readFile(snapshotPath);
  snapshot[snapshot.length - 1] ^= 0xff;
  await writeFile(snapshotPath, snapshot, { mode: 0o600 });

  const restarted = new SessionInventory({ stateDir, catalog: new FakeCatalog(), roots: [sessionsRoot] });
  await restarted.initialize();
  await restarted.waitForFullIndex();
  assert.equal(restarted.status().records, 1);
  assert.equal(
    (await readdir(join(stateDir, "web"))).some((name) => name.includes("inventory-v1.snapshot.quarantine-snapshot-corrupt")),
    true,
  );
});

test("root, source, index, and overlap failures are bounded and fail safe", async (t) => {
  const { stateDir, sessionsRoot } = await fixture(t);
  await writeFile(join(sessionsRoot, "oversized.jsonl"), "x".repeat(512), { mode: 0o600 });
  const bounded = new SessionInventory({
    stateDir,
    catalog: new FakeCatalog(),
    roots: [sessionsRoot],
    limits: { maxSourceBytes: 256, maxLineBytes: 128 },
  });
  const result = await bounded.reconcile();
  assert.equal(issueCodes(result).has("inventory_source_too_large"), true);
  assert.equal((await bounded.list()).sessions.length, 0);

  await chmod(sessionsRoot, 0o777);
  const insecure = new SessionInventory({ stateDir, catalog: new FakeCatalog(), roots: [sessionsRoot] });
  await assert.rejects(
    insecure.reconcile(),
    (error) => error instanceof SessionInventoryError && error.code === "insecure_inventory_root",
  );
  await chmod(sessionsRoot, 0o700);

  const overlap = new SessionInventory({ stateDir, catalog: new FakeCatalog(), roots: [stateDir] });
  await assert.rejects(
    overlap.reconcile(),
    (error) => error instanceof SessionInventoryError && error.code === "insecure_inventory_root",
  );

  const valid = await writeSession(sessionsRoot, {
    filename: "valid.jsonl",
    id: "valid",
    name: "Valid",
  });
  void valid;
  const healthy = new SessionInventory({ stateDir, catalog: new FakeCatalog(), roots: [sessionsRoot] });
  await healthy.reconcile();
  const indexPath = join(stateDir, "web", "inventory-v1.json");
  await Promise.all([
    writeFile(indexPath, "{bad-json", { mode: 0o600 }),
    writeFile(join(stateDir, "web", "inventory-v1.head.json"), "{bad-json", { mode: 0o600 }),
    writeFile(join(stateDir, "web", "inventory-v1.head.snapshot"), "bad-head-snapshot", { mode: 0o600 }),
    writeFile(join(stateDir, "web", "inventory-v1.snapshot"), "bad-snapshot", { mode: 0o600 }),
  ]);
  const restarted = new SessionInventory({ stateDir, catalog: new FakeCatalog(), roots: [sessionsRoot] });
  await restarted.initialize();
  await restarted.waitForFullIndex();
  assert.equal(restarted.status().stale, true);
  assert.equal(restarted.status().lastErrorCode, "corrupt_inventory_index");
  assert.equal((await restarted.list()).sessions.length, 0);
  assert.equal(
    (await readdir(join(stateDir, "web"))).some((name) => name.includes("inventory-v1.json.quarantine-index-corrupt")),
    true,
  );
});

test("loaded YAML roots and canonical source fingerprints share exact cross-module shapes", () => {
  const fingerprint = formatSessionSourceFingerprint(new Uint8Array(32));
  assert.equal(fingerprint, `sha256:${"A".repeat(43)}`);
  assert.throws(() => formatSessionSourceFingerprint(new Uint8Array(31)), RangeError);

  const resolved = resolveSessionInventoryConfig(
    {
      instance: "work",
      path: "/config/work/config.yaml",
      explicitPath: true,
      present: true,
      config: {
        web: {
          inventory: {
            roots: ["./sessions", "../shared"],
            reconcileIntervalMs: 12_345,
            maxSessions: 321,
          },
        },
      },
      resolvePath: (value) => join("/config/work", value),
    },
    { defaultSessionRoot: "/agent/sessions" },
  );
  assert.deepEqual(resolved.roots, [
    "/agent/sessions",
    "/config/work/sessions",
    "/config/shared",
  ]);
  assert.deepEqual(resolved.limits, {
    reconcileIntervalMs: 12_345,
    maxSessions: 321,
  });
});
