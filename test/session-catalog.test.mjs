import assert from "node:assert/strict";
import { chmod, lstat, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { FileDurabilityStore, encodedSessionId } from "../dist/durability.js";
import { Multiplexer } from "../dist/multiplexer.js";
import {
  FileSessionCatalog,
  SessionCatalogError,
  catalogRecordToSessionResource,
  sessionSpecDigest,
} from "../dist/session-catalog.js";

const temporaryState = () => mkdtemp(join(tmpdir(), "pi-daemon-catalog-"));
const spec = (cwd, overrides = {}) => ({
  cwd,
  target: { mode: "new" },
  isolation: { mode: "unisolated" },
  ...overrides,
});

test("catalog persists secret-free records with exact ID/name resolution and optimistic replace", async () => {
  const stateDir = await temporaryState();
  let now = Date.parse("2026-07-14T09:00:00.000Z");
  const catalog = new FileSessionCatalog({ stateDir, now: () => new Date(now) });
  assert.deepEqual(await catalog.recover(), []);

  const created = await catalog.create({
    sessionId: "session/α",
    name: "worker-a",
    generation: 1,
    spec: spec("/work/a"),
    environment: {
      keys: ["API_TOKEN"],
      digest: "sha256:test",
      persistence: "reference",
      provisioned: true,
    },
    conversation: { sessionId: "pi-a", sessionFile: "sessions/a.jsonl" },
  });
  assert.equal(created.revision, 1);
  assert.equal(created.residency, "resident");
  assert.equal((await catalog.get("worker-a")).sessionId, "session/α");
  assert.equal((await catalog.get("session/α")).name, "worker-a");
  assert.equal(created.policyDigest, sessionSpecDigest(spec("/work/a")));
  const resource = catalogRecordToSessionResource(created);
  assert.equal(resource.residency, "resident");
  assert.equal(resource.links.self, "/v1/session/session%2F%CE%B1");

  const path = join(stateDir, "catalog", `${encodedSessionId("session/α")}.json`);
  assert.equal((await lstat(path)).mode & 0o777, 0o600);
  const persisted = JSON.parse(await readFile(path, "utf8"));
  assert.equal(JSON.stringify(persisted).includes("API_TOKEN"), true);
  assert.equal(JSON.stringify(persisted).includes("secret-value"), false);

  await assert.rejects(
    catalog.create({
      sessionId: "unsafe",
      generation: 1,
      spec: { ...spec("/work/unsafe"), env: { API_TOKEN: "secret-value" } },
    }),
    (error) => error instanceof SessionCatalogError && error.code === "secret_persistence_refused",
  );

  now += 1_000;
  const replaced = await catalog.replace("worker-a", {
    expectedGeneration: 1,
    expectedRevision: 1,
    generation: 2,
    name: "worker-renamed",
    spec: spec("/work/b", { target: { mode: "continue" } }),
    environment: {
      keys: [],
      persistence: "memory-only",
      provisioned: false,
    },
    residency: "dormant",
    state: "idle",
    conversation: null,
  });
  assert.equal(replaced.generation, 2);
  assert.equal(replaced.revision, 2);
  assert.equal(replaced.name, "worker-renamed");
  assert.equal(replaced.conversation, undefined);
  assert.equal(await catalog.get("worker-a"), undefined);

  await assert.rejects(
    catalog.replace("worker-renamed", {
      expectedGeneration: 1,
      expectedRevision: 1,
      generation: 2,
      spec: replaced.spec,
      environment: replaced.environment,
      residency: "dormant",
      state: "idle",
    }),
    (error) =>
      error instanceof SessionCatalogError && error.code === "session_precondition_failed",
  );
});

test("catalog pagination is stable and restart makes resident sessions dormant", async () => {
  const stateDir = await temporaryState();
  const first = new FileSessionCatalog({ stateDir });
  await first.recover();
  for (const id of ["a", "b", "c"]) {
    await first.create({ sessionId: id, name: `name-${id}`, generation: 1, spec: spec(`/work/${id}`) });
  }
  await first.markState("b", 1, "running");

  const pageOne = await first.list({ limit: 2 });
  assert.deepEqual(pageOne.sessions.map((entry) => entry.sessionId), ["a", "b"]);
  assert.ok(pageOne.nextCursor);
  const pageTwo = await first.list({ limit: 2, cursor: pageOne.nextCursor });
  assert.deepEqual(pageTwo.sessions.map((entry) => entry.sessionId), ["c"]);
  assert.equal(pageTwo.nextCursor, undefined);
  await assert.rejects(
    first.list({ cursor: "not-a-cursor" }),
    (error) => error instanceof SessionCatalogError && error.code === "invalid_cursor",
  );

  const restarted = new FileSessionCatalog({ stateDir });
  const recovered = await restarted.recover();
  assert.deepEqual(recovered.map((entry) => entry.residency), ["dormant", "dormant", "dormant"]);
  assert.equal((await restarted.get("b")).state, "idle");
  const resident = await restarted.markResident("a", 1, {
    sessionId: "pi-a",
    sessionFile: "sessions/a.jsonl",
  });
  assert.equal(resident.residency, "resident");
  const deleted = await restarted.delete("name-c");
  assert.equal(deleted.sessionId, "c");
  assert.equal(await restarted.get("c"), undefined);
});

class CatalogAdapter {
  constructor(sessionId, generation) {
    this.sessionId = sessionId;
    this.generation = generation;
    this.disposed = 0;
  }

  identity() {
    return {
      sessionId: `pi-${this.sessionId}-${this.generation}`,
      sessionFile: `sessions/${this.sessionId}-${this.generation}.jsonl`,
    };
  }

  async prompt(request) {
    return { text: `answer:${request.prompt}` };
  }

  dispose() {
    this.disposed += 1;
  }
}

class CatalogFactory {
  adapters = [];

  async open(request) {
    const adapter = new CatalogAdapter(request.sessionId, request.generation);
    this.adapters.push(adapter);
    return adapter;
  }
}

const openCommand = (sessionId = "catalog-session", generation = 1) => ({
  protocolVersion: "1.0",
  requestId: `open-${sessionId}-${generation}`,
  operation: "open",
  sessionId,
  generation,
  payload: {
    cwd: `/work/${sessionId}`,
    session: { mode: "new" },
    resources: {
      extensions: "none",
      skills: "none",
      promptTemplates: "none",
      themes: "none",
      contextFiles: "none",
      tools: "none",
    },
  },
});

test("multiplexer catalogs open, terminal state, eviction, dormant reopen, update, and delete", async () => {
  const stateDir = await temporaryState();
  let now = 0;
  const catalog = new FileSessionCatalog({ stateDir, now: () => new Date(now) });
  const durability = new FileDurabilityStore({ stateDir, now: () => new Date(now) });
  const factory = new CatalogFactory();
  const mux = new Multiplexer({
    factory,
    durability,
    catalog,
    now: () => now,
    idleSessionTtlMs: 100,
  });
  const events = [];
  mux.subscribe((event) => events.push(event.event));
  await mux.recover();
  await mux.open(openCommand());

  let record = await mux.retainedSession("catalog-session");
  assert.equal(record.residency, "resident");
  assert.equal(record.conversation.sessionId, "pi-catalog-session-1");
  assert.equal(mux.status().retainedSessions, 1);
  assert.equal(mux.status().dormantSessions, 0);

  const wake = await mux.wake({
    protocolVersion: "1.0",
    requestId: "wake-catalog",
    operation: "wake",
    sessionId: "catalog-session",
    generation: 1,
    idempotencyKey: "catalog-key",
    payload: { prompt: "hello" },
  });
  assert.deepEqual(wake.result, { text: "answer:hello" });
  record = await mux.retainedSession("catalog-session");
  assert.equal(record.lastTerminal.state, "succeeded");
  assert.equal(record.lastTerminal.requestId, "wake-catalog");
  assert.equal(
    catalogRecordToSessionResource(record).lastTerminal.requestId,
    "wake-catalog",
  );

  now = 100;
  assert.deepEqual(await mux.sweepIdleSessions(), ["catalog-session"]);
  record = await mux.retainedSession("catalog-session");
  assert.equal(record.residency, "dormant");
  assert.ok(events.includes("sessionDormant"));
  assert.ok(events.includes("sessionEvicted"));
  assert.equal(mux.status().dormantSessions, 1);
  await assert.rejects(
    mux.open({
      ...openCommand(),
      requestId: "conflicting-reopen",
      payload: { ...openCommand().payload, cwd: "/work/different" },
    }),
    (error) => error?.code === "session_policy_conflict",
  );

  await mux.open({ ...openCommand(), requestId: "reopen-catalog" });
  assert.equal((await mux.retainedSession("catalog-session")).residency, "resident");
  assert.equal(factory.adapters.length, 2);
  await mux.close({
    protocolVersion: "1.0",
    requestId: "close-catalog",
    operation: "close",
    sessionId: "catalog-session",
    generation: 1,
    payload: { retainSession: true },
  });
  record = await mux.retainedSession("catalog-session");
  assert.equal(record.residency, "dormant");

  record = await mux.replaceDormantSession("catalog-session", {
    expectedGeneration: record.generation,
    expectedRevision: record.revision,
    generation: 2,
    name: "renamed-catalog",
    spec: { ...record.spec, cwd: "/work/replaced", target: { mode: "continue" } },
    environment: record.environment,
    residency: "dormant",
    state: "idle",
    conversation: null,
  });
  assert.equal((await mux.retainedSession("renamed-catalog")).generation, 2);
  assert.equal(
    await mux.deleteRetainedSession("renamed-catalog", {
      requestId: "delete-catalog",
      expectedGeneration: record.generation,
      expectedRevision: record.revision,
    }),
    true,
  );
  assert.equal(await mux.retainedSession("catalog-session"), undefined);
  assert.deepEqual((await mux.retainedSessions()).sessions, []);
  assert.ok(events.includes("sessionDeleted"));
});

test("multiplexer restart recovers catalog records and reopens durable manifests", async () => {
  const stateDir = await temporaryState();
  const firstCatalog = new FileSessionCatalog({ stateDir });
  const firstMux = new Multiplexer({
    factory: new CatalogFactory(),
    durability: new FileDurabilityStore({ stateDir }),
    catalog: firstCatalog,
  });
  await firstMux.recover();
  await firstMux.open(openCommand("restart-session"));
  assert.equal((await firstMux.retainedSession("restart-session")).residency, "resident");

  const restartedFactory = new CatalogFactory();
  const restarted = new Multiplexer({
    factory: restartedFactory,
    durability: new FileDurabilityStore({ stateDir }),
    catalog: new FileSessionCatalog({ stateDir }),
  });
  const report = await restarted.recover();
  assert.deepEqual(report.opened, ["restart-session"]);
  assert.equal(report.catalog[0].residency, "dormant");
  const record = await restarted.retainedSession("restart-session");
  assert.equal(record.residency, "resident");
  assert.equal(record.conversation.sessionId, "pi-restart-session-1");
  assert.equal(restartedFactory.adapters.length, 1);
});

test("catalog rejects name collisions, unsafe path segments, capacity overflow, and insecure state", async () => {
  const stateDir = await temporaryState();
  const catalog = new FileSessionCatalog({ stateDir, maxSessions: 2 });
  await catalog.recover();
  await catalog.create({ sessionId: "id-a", name: "alpha", generation: 1, spec: spec("/a") });
  await assert.rejects(
    catalog.create({ sessionId: "alpha", generation: 1, spec: spec("/collision") }),
    (error) => error instanceof SessionCatalogError && error.code === "session_name_conflict",
  );
  await assert.rejects(
    catalog.create({ sessionId: "id-b", name: "id-a", generation: 1, spec: spec("/b") }),
    (error) => error instanceof SessionCatalogError && error.code === "session_name_conflict",
  );
  await assert.rejects(
    catalog.create({ sessionId: "id-b", name: "alpha", generation: 1, spec: spec("/b") }),
    (error) => error instanceof SessionCatalogError && error.code === "session_name_conflict",
  );
  await catalog.create({ sessionId: "id-b", name: "beta", generation: 1, spec: spec("/b") });
  await assert.rejects(
    catalog.create({ sessionId: "id-c", generation: 1, spec: spec("/c") }),
    (error) => error instanceof SessionCatalogError && error.code === "catalog_capacity",
  );
  await assert.rejects(
    new FileSessionCatalog({ stateDir: await temporaryState() }).create({
      sessionId: "x".repeat(256),
      generation: 1,
      spec: spec("/long"),
    }),
    (error) => error instanceof SessionCatalogError && error.code === "invalid_session_id",
  );
  await assert.rejects(
    new FileSessionCatalog({
      stateDir: await temporaryState(),
      maxRecordBytes: 1024,
    }).create({
      sessionId: "large-record",
      generation: 1,
      spec: spec("/large", {
        resources: { systemPrompt: "x".repeat(2048) },
      }),
    }),
    (error) =>
      error instanceof SessionCatalogError && error.code === "catalog_record_too_large",
  );

  const permissive = await temporaryState();
  await chmod(permissive, 0o755);
  await assert.rejects(new FileSessionCatalog({ stateDir: permissive }).recover(), /owner-only/);

  const symlinkedState = await temporaryState();
  const symlinkCatalog = new FileSessionCatalog({ stateDir: symlinkedState });
  await symlinkCatalog.recover();
  const outside = join(await temporaryState(), "outside.json");
  await writeFile(outside, "{}\n", { mode: 0o600 });
  await symlink(outside, join(symlinkedState, "catalog", `${encodedSessionId("evil")}.json`));
  await assert.rejects(
    new FileSessionCatalog({ stateDir: symlinkedState }).recover(),
    /regular file/,
  );
});
