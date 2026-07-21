import assert from "node:assert/strict";
import {
  appendFile,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { SessionManager } from "@earendil-works/pi-coding-agent";

import { SessionInventory } from "../dist/session-inventory.js";
import {
  DIRECT_COOPT_POLICY_REF,
  MultiplexerSessionOwnershipRuntime,
  SessionOwnershipService,
} from "../dist/session-ownership.js";
import { FileSessionOwnershipStore } from "../dist/session-ownership-store.js";

class EmptyCatalog {
  async recover() {
    return [];
  }
}

class FakeOwnershipRuntime {
  records = new Map();
  opens = [];
  closes = [];

  async get(sessionRef) {
    return this.records.get(sessionRef);
  }

  async open(input) {
    this.opens.push(structuredClone(input));
    let sessionFile;
    if (input.spec.target.mode === "open") {
      sessionFile = input.spec.target.path;
    } else if (input.spec.target.mode === "fork") {
      const manager = SessionManager.forkFrom(
        input.resolvedSourcePath,
        input.spec.cwd,
        input.spec.target.sessionDir,
      );
      sessionFile = manager.getSessionFile();
    } else {
      const manager = SessionManager.create(input.spec.cwd, input.spec.target.sessionDir);
      sessionFile = manager.getSessionFile();
    }
    const now = "2026-07-18T12:00:00.000Z";
    const session = {
      sessionId: input.sessionId,
      name: input.spec.name,
      generation: input.generation,
      revision: 1,
      residency: "resident",
      state: "idle",
      createdAt: now,
      updatedAt: now,
      lastUsedAt: now,
      spec: input.spec,
      environment: { keys: [], persistence: "memory-only", provisioned: true },
      links: {
        self: `/v1/session/${input.sessionId}`,
        rpc: `/v1/session/${input.sessionId}/rpc`,
        apc: `/v1/session/${input.sessionId}/apc`,
      },
    };
    this.records.set(input.sessionId, session);
    return { session, sessionFile };
  }

  async close(sessionId, generation) {
    this.closes.push([sessionId, generation]);
  }
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "pi-daemon-ownership-"));
  const stateDir = join(root, "state");
  const daemonSessionsRoot = join(stateDir, "owned-sessions");
  const agentDir = join(root, "agent");
  const piSessionsRoot = join(agentDir, "sessions");
  const sourceRoot = join(root, "sources");
  const cwdRoot = join(root, "work");
  const cwd = join(cwdRoot, "project");
  await Promise.all([
    mkdir(daemonSessionsRoot, { recursive: true, mode: 0o700 }),
    mkdir(piSessionsRoot, { recursive: true, mode: 0o700 }),
    mkdir(sourceRoot, { recursive: true, mode: 0o700 }),
    mkdir(cwd, { recursive: true, mode: 0o700 }),
  ]);
  t.after(async () => rm(root, { recursive: true, force: true }));
  return { root, stateDir, daemonSessionsRoot, piSessionsRoot, sourceRoot, cwdRoot, cwd };
}

async function writeSession(path, id, cwd, text = "hello") {
  const header = {
    type: "session",
    version: 3,
    id,
    timestamp: "2026-07-18T12:00:00.000Z",
    cwd,
  };
  const entry = {
    type: "message",
    id: `${id}-user`,
    parentId: null,
    timestamp: "2026-07-18T12:00:01.000Z",
    message: { role: "user", content: text, timestamp: Date.parse("2026-07-18T12:00:01.000Z") },
  };
  await writeFile(path, `${JSON.stringify(header)}\n${JSON.stringify(entry)}\n`, { mode: 0o600 });
  return path;
}

async function createHarness(t, options = {}) {
  const dirs = await fixture(t);
  const inventory = new SessionInventory({
    stateDir: dirs.stateDir,
    catalog: new EmptyCatalog(),
    roots: [dirs.sourceRoot, dirs.piSessionsRoot],
  });
  const store = new FileSessionOwnershipStore({ stateDir: dirs.stateDir });
  const runtime = new FakeOwnershipRuntime();
  let writer = options.writer ?? "none";
  let controller = options.controller ?? false;
  const service = new SessionOwnershipService({
    stateDir: dirs.stateDir,
    inventory,
    store,
    runtime,
    piSessionsRoot: dirs.piSessionsRoot,
    daemonSessionsRoot: dirs.daemonSessionsRoot,
    sourceRoots: [dirs.sourceRoot, dirs.piSessionsRoot],
    allowedCwdRoots: [dirs.cwdRoot],
    storageMode: options.storageMode ?? "pi-session-root",
    runtimeSpec:
      options.runtimeSpec ??
      (({ info }) => ({
        cwd: info.cwd,
        target: { mode: "memory" },
        tools: { mode: "none" },
        isolation: { mode: "unisolated" },
      })),
    writerProbe: () => writer,
    hasController: () => controller,
  });
  return {
    ...dirs,
    inventory,
    store,
    runtime,
    service,
    setWriter(value) {
      writer = value;
    },
    setController(value) {
      controller = value;
    },
  };
}

async function inventoryRecord(inventory, piSessionId) {
  await inventory.reconcile();
  const page = await inventory.list({ search: piSessionId, limit: 100 });
  const record = page.sessions.find((candidate) => candidate.piSessionId === piSessionId);
  assert.ok(record, `missing inventory record ${piSessionId}`);
  return record;
}

const activation = (mode, fingerprint, overrides = {}) => ({
  requestId: `activate-${mode}`,
  idempotencyKey: `activate-${mode}-key`,
  mode,
  expectedFingerprint: fingerprint,
  policyRef: mode === "direct" ? DIRECT_COOPT_POLICY_REF : "trusted-runtime",
  ...overrides,
});

test("direct co-opt requires confirmation, revalidates fingerprint and joins duplicates", async (t) => {
  const harness = await createHarness(t);
  const source = await writeSession(
    join(harness.sourceRoot, "direct.jsonl"),
    "pi-direct",
    harness.cwd,
  );
  const record = await inventoryRecord(harness.inventory, "pi-direct");

  const refused = await harness.service.activateSession(
    record.inventoryId,
    activation("direct", record.piSessionId, { policyRef: undefined, expectedFingerprint: undefined }),
  );
  assert.equal(refused.state, "failed");
  assert.equal(refused.error.code, "direct_confirmation_required");

  const request = activation(
    "direct",
    (await harness.inventory.getInfo(record.inventoryId)).source.fingerprint.value,
    { requestId: "activate-direct-valid", idempotencyKey: "activate-direct-valid-key" },
  );
  const ticket = await harness.service.activateSession(record.inventoryId, request);
  assert.equal(ticket.state, "succeeded", JSON.stringify(ticket.error));
  assert.equal(harness.runtime.opens.length, 1);
  assert.equal(harness.runtime.opens[0].spec.target.path, await realpath(source));
  assert.deepEqual(await harness.service.activateSession(record.inventoryId, request), ticket);
  assert.equal(harness.runtime.opens.length, 1);
  const mapping = await harness.store.getByInventory(record.inventoryId);
  assert.equal(mapping.mode, "direct");
  assert.deepEqual(
    await harness.service.resolveInventoryOwnership({
      inventoryId: record.inventoryId,
      sourceKind: "external",
      canonicalPath: source,
      cwd: harness.cwd,
      piSessionId: "pi-direct",
    }),
    {
      sourceKind: "direct",
      ownership: {
        mode: "direct",
        leaseId: mapping.lease.leaseId,
        sourceInventoryId: record.inventoryId,
        exportedInventoryIds: [],
      },
      activation: { eligible: true, modes: ["reuse"] },
    },
  );
  assert.equal(mapping.managedPath, await realpath(source));
  const renewed = await harness.service.renewLease(
    mapping.managedSessionId,
    mapping.lease.leaseId,
  );
  assert.equal(Date.parse(renewed.lease.expiresAt) >= Date.parse(mapping.lease.expiresAt), true);
  await assert.rejects(harness.service.renewLease(mapping.managedSessionId, "stale-lease"));
});

test("activation inherits the active source model and thinking over configured fallback", async (t) => {
  const harness = await createHarness(t, {
    runtimeSpec: ({ info }) => ({
      cwd: info.cwd,
      target: { mode: "memory" },
      model: {
        provider: "configured-provider",
        id: "configured-model",
        thinkingLevel: "medium",
        scopedModels: ["configured-provider/configured-model"],
      },
      tools: { mode: "none" },
      isolation: { mode: "unisolated" },
    }),
  });
  const source = await writeSession(
    join(harness.sourceRoot, "source-model.jsonl"),
    "pi-source-model",
    harness.cwd,
  );
  const manager = SessionManager.open(source, dirname(source), harness.cwd);
  manager.appendModelChange("github-copilot", "gpt-5.6-sol");
  manager.appendThinkingLevelChange("high");
  const record = await inventoryRecord(harness.inventory, "pi-source-model");
  const info = await harness.inventory.getInfo(record.inventoryId);
  const ticket = await harness.service.activateSession(
    record.inventoryId,
    activation("fork", info.source.fingerprint.value),
  );
  assert.equal(ticket.state, "succeeded", JSON.stringify(ticket.error));
  assert.deepEqual(harness.runtime.opens[0].spec.model, {
    provider: "github-copilot",
    id: "gpt-5.6-sol",
    thinkingLevel: "high",
    scopedModels: ["configured-provider/configured-model"],
  });
});

test("activation rejects a group/world-writable source file", async (t) => {
  const harness = await createHarness(t);
  const source = await writeSession(
    join(harness.sourceRoot, "writable.jsonl"),
    "pi-writable",
    harness.cwd,
  );
  const record = await inventoryRecord(harness.inventory, "pi-writable");
  const info = await harness.inventory.getInfo(record.inventoryId);
  await chmod(source, 0o666);
  const ticket = await harness.service.activateSession(
    record.inventoryId,
    activation("direct", info.source.fingerprint.value),
  );
  assert.equal(ticket.state, "failed");
  assert.equal(ticket.error.code, "insecure_session_source");
  assert.equal(harness.runtime.opens.length, 0);
});

test("fork/import leaves the source untouched and uses normal Pi project storage", async (t) => {
  const harness = await createHarness(t);
  const source = await writeSession(
    join(harness.sourceRoot, "fork.jsonl"),
    "pi-fork",
    harness.cwd,
    "fork me",
  );
  const before = await readFile(source, "utf8");
  const record = await inventoryRecord(harness.inventory, "pi-fork");
  const info = await harness.inventory.getInfo(record.inventoryId);
  const missingFingerprint = await harness.service.activateSession(
    record.inventoryId,
    activation("fork", undefined, {
      requestId: "fork-missing-fingerprint",
      idempotencyKey: "fork-missing-fingerprint-key",
    }),
  );
  assert.equal(missingFingerprint.state, "failed");
  assert.equal(missingFingerprint.error.code, "source_fingerprint_required");
  const ticket = await harness.service.activateSession(
    record.inventoryId,
    activation("fork", info.source.fingerprint.value),
  );
  assert.equal(ticket.state, "succeeded", JSON.stringify(ticket.error));
  const mapping = await harness.store.getByInventory(record.inventoryId);
  assert.equal(mapping.mode, "imported");
  assert.notEqual(mapping.managedPath, source);
  assert.equal(mapping.managedPath.startsWith(await realpath(harness.piSessionsRoot)), true);
  assert.equal((await lstat(mapping.managedPath)).mode & 0o777, 0o600);
  assert.equal(await readFile(source, "utf8"), before);
  assert.equal((await readFile(mapping.managedPath, "utf8")).includes("fork me"), true);
});

test("direct write guard fails closed and marks external conflicts", async (t) => {
  const harness = await createHarness(t);
  const source = await writeSession(
    join(harness.sourceRoot, "conflict.jsonl"),
    "pi-conflict",
    harness.cwd,
  );
  const record = await inventoryRecord(harness.inventory, "pi-conflict");
  const info = await harness.inventory.getInfo(record.inventoryId);
  const ticket = await harness.service.activateSession(
    record.inventoryId,
    activation("direct", info.source.fingerprint.value),
  );
  assert.equal(ticket.state, "succeeded");
  await appendFile(
    source,
    `${JSON.stringify({
      type: "custom",
      id: "external-entry",
      parentId: "pi-conflict-user",
      timestamp: "2026-07-18T12:00:02.000Z",
      customType: "external",
      data: {},
    })}\n`,
  );
  assert.deepEqual(await harness.service.checkForExternalConflicts(), [
    ticket.managedSession.sessionId,
  ]);
  const mapping = await harness.store.getByInventory(record.inventoryId);
  assert.equal(mapping.status, "conflict");
  assert.equal(mapping.conflict.code, "external_write_conflict");
  assert.equal(harness.runtime.closes.length, 1);
});

test("imported sessions export as new and guarded append-back can release", async (t) => {
  const harness = await createHarness(t);
  const source = await writeSession(
    join(harness.sourceRoot, "export.jsonl"),
    "pi-export",
    harness.cwd,
  );
  const record = await inventoryRecord(harness.inventory, "pi-export");
  const info = await harness.inventory.getInfo(record.inventoryId);
  const activated = await harness.service.activateSession(
    record.inventoryId,
    activation("fork", info.source.fingerprint.value),
  );
  assert.equal(activated.state, "succeeded", JSON.stringify(activated.error));
  const mapping = await harness.store.getByInventory(record.inventoryId);
  const manager = SessionManager.open(mapping.managedPath, dirname(mapping.managedPath), harness.cwd);
  manager.appendCustomEntry("managed-delta", { ok: true });
  await harness.service.afterManagedWrite(activated.managedSession.sessionId);
  const refreshed = await harness.store.getByInventory(record.inventoryId);

  const exportNewRequest = {
    requestId: "export-new",
    idempotencyKey: "export-new-key",
    mode: "as-new",
    expectedSourceFingerprint: refreshed.managedFingerprint,
  };
  const exported = await harness.service.exportSession(
    activated.managedSession.sessionId,
    exportNewRequest,
  );
  assert.equal(exported.state, "succeeded");
  assert.deepEqual(
    await harness.service.exportSession(activated.managedSession.sessionId, exportNewRequest),
    exported,
  );
  assert.notEqual(exported.exportedInventoryId, record.inventoryId);
  const exportedInfo = await harness.inventory.getInfo(exported.exportedInventoryId);
  assert.equal((await lstat(exportedInfo.source.canonicalPath)).mode & 0o777, 0o600);
  const exportedHeader = JSON.parse((await readFile(exportedInfo.source.canonicalPath, "utf8")).split("\n")[0]);
  assert.equal(exportedHeader.parentSession, mapping.managedPath);

  const appended = await harness.service.exportSession(activated.managedSession.sessionId, {
    requestId: "export-append",
    idempotencyKey: "export-append-key",
    mode: "append-to-origin",
    expectedSourceFingerprint: refreshed.managedFingerprint,
    releaseAfterExport: true,
  });
  assert.equal(appended.state, "succeeded");
  assert.equal(appended.exportedInventoryId, record.inventoryId);
  assert.equal((await readFile(source, "utf8")).includes("managed-delta"), true);
  assert.equal(harness.runtime.closes.length, 1);
  assert.equal((await harness.store.getByInventory(record.inventoryId)).status, "released");
});

test("append-back refuses a changed origin and preserves both histories", async (t) => {
  const harness = await createHarness(t);
  const source = await writeSession(
    join(harness.sourceRoot, "diverged.jsonl"),
    "pi-diverged",
    harness.cwd,
  );
  const record = await inventoryRecord(harness.inventory, "pi-diverged");
  const info = await harness.inventory.getInfo(record.inventoryId);
  const activated = await harness.service.activateSession(
    record.inventoryId,
    activation("fork", info.source.fingerprint.value),
  );
  const mapping = await harness.store.getByInventory(record.inventoryId);
  await appendFile(source, `${JSON.stringify({
    type: "custom",
    id: "outside",
    parentId: "pi-diverged-user",
    timestamp: "2026-07-18T12:00:03.000Z",
    customType: "outside",
    data: {},
  })}\n`);
  const failed = await harness.service.exportSession(activated.managedSession.sessionId, {
    requestId: "append-diverged",
    idempotencyKey: "append-diverged-key",
    mode: "append-to-origin",
    expectedSourceFingerprint: mapping.managedFingerprint,
  });
  assert.equal(failed.state, "failed");
  assert.equal(failed.error.code, "external_write_conflict");
  assert.equal((await harness.store.getByInventory(record.inventoryId)).status, "conflict");
  assert.equal((await readFile(mapping.managedPath, "utf8")).includes("outside"), false);
});

test("daemon-owned storage stays under state while Pi storage uses project directories", async (t) => {
  const harness = await createHarness(t, { storageMode: "daemon-owned" });
  await writeSession(join(harness.sourceRoot, "daemon.jsonl"), "pi-daemon-owned", harness.cwd);
  const record = await inventoryRecord(harness.inventory, "pi-daemon-owned");
  const info = await harness.inventory.getInfo(record.inventoryId);
  const activated = await harness.service.activateSession(
    record.inventoryId,
    activation("fork", info.source.fingerprint.value),
  );
  assert.equal(activated.state, "succeeded", JSON.stringify(activated.error));
  const mapping = await harness.store.getByInventory(record.inventoryId);
  assert.equal(mapping.managedPath.startsWith(await realpath(harness.daemonSessionsRoot)), true);
  assert.equal(
    (await harness.service.sessionDirForNewSession(harness.cwd, "new-session")).startsWith(
      await realpath(harness.daemonSessionsRoot),
    ),
    true,
  );
});

test("Multiplexer ownership adapter preserves prepared fork source and catalog identity", async () => {
  const calls = { open: [], close: [] };
  const retained = {
    formatVersion: 1,
    sessionId: "managed-adapter",
    generation: 1,
    revision: 1,
    residency: "resident",
    state: "idle",
    createdAt: "2026-07-18T12:00:00.000Z",
    updatedAt: "2026-07-18T12:00:00.000Z",
    lastUsedAt: "2026-07-18T12:00:00.000Z",
    spec: {
      cwd: "/work/project",
      target: { mode: "fork", sourceSession: "inventory-source", sessionDir: "/sessions" },
      isolation: { mode: "unisolated" },
    },
    environment: { keys: [], persistence: "memory-only", provisioned: true },
    policyDigest: "digest",
    conversation: { sessionId: "pi-managed", sessionFile: "/sessions/managed.jsonl" },
  };
  const multiplexer = {
    async open(command, options) {
      calls.open.push({ command, options });
      return {
        created: true,
        session: { sessionId: command.sessionId, generation: command.generation, state: "idle" },
      };
    },
    async retainedSession() {
      return retained;
    },
    async close(command) {
      calls.close.push(command);
      return true;
    },
  };
  const runtime = new MultiplexerSessionOwnershipRuntime(multiplexer);
  const opened = await runtime.open({
    sessionId: "managed-adapter",
    generation: 1,
    requestId: "open-adapter",
    resolvedSourcePath: "/sources/original.jsonl",
    spec: retained.spec,
  });
  assert.equal(opened.sessionFile, "/sessions/managed.jsonl");
  assert.equal(
    calls.open[0].options.runtimeOptions.resolvedSourceSessionPath,
    "/sources/original.jsonl",
  );
  assert.equal(calls.open[0].command.payload.session.mode, "new");
  await runtime.close("managed-adapter", 1);
  assert.equal(calls.close[0].payload.retainSession, true);
});

test("ownership initialization rejects source/state overlap", async (t) => {
  const dirs = await fixture(t);
  const inventory = new SessionInventory({
    stateDir: dirs.stateDir,
    catalog: new EmptyCatalog(),
  });
  const service = new SessionOwnershipService({
    stateDir: dirs.stateDir,
    inventory,
    store: new FileSessionOwnershipStore({ stateDir: dirs.stateDir }),
    runtime: new FakeOwnershipRuntime(),
    runtimeSpec: ({ info }) => ({
      cwd: info.cwd,
      target: { mode: "memory" },
      tools: { mode: "none" },
    }),
    piSessionsRoot: dirs.piSessionsRoot,
    daemonSessionsRoot: dirs.daemonSessionsRoot,
    sourceRoots: [dirs.stateDir],
    allowedCwdRoots: [dirs.cwdRoot],
  });
  await assert.rejects(
    service.initialize(),
    (error) => error.code === "ownership_root_overlap",
  );
});

test("writer/controller observations and source roots fail closed", async (t) => {
  const harness = await createHarness(t, { writer: "other" });
  await writeSession(join(harness.sourceRoot, "writer.jsonl"), "pi-writer", harness.cwd);
  const record = await inventoryRecord(harness.inventory, "pi-writer");
  const info = await harness.inventory.getInfo(record.inventoryId);
  const blocked = await harness.service.activateSession(
    record.inventoryId,
    activation("direct", info.source.fingerprint.value),
  );
  assert.equal(blocked.state, "failed");
  assert.equal(blocked.error.code, "source_writer_active");
  assert.equal(harness.runtime.opens.length, 0);

  harness.setWriter("none");
  const forked = await harness.service.activateSession(
    record.inventoryId,
    activation("fork", info.source.fingerprint.value, {
      requestId: "fork-controller",
      idempotencyKey: "fork-controller-key",
    }),
  );
  harness.setController(true);
  const exported = await harness.service.exportSession(forked.managedSession.sessionId, {
    requestId: "export-controller",
    idempotencyKey: "export-controller-key",
    mode: "as-new",
  });
  assert.equal(exported.state, "failed");
  assert.equal(exported.error.code, "controller_active");
});
