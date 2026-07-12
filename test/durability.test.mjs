import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, symlink, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  DurabilityError,
  FileDurabilityStore,
  encodedSessionId,
} from "../dist/durability.js";
import { Multiplexer, MultiplexerError } from "../dist/multiplexer.js";

const temporaryState = () => mkdtemp(join(tmpdir(), "pi-daemon-state-"));

const openCommand = (sessionId = "agent/a", generation = 1) => ({
  protocolVersion: "1.0",
  requestId: `open-${generation}`,
  operation: "open",
  sessionId,
  generation,
  payload: {
    cwd: `/work/${sessionId}`,
    session: { mode: "memory" },
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

const wakeCommand = (idempotencyKey, prompt = `prompt-${idempotencyKey}`, sessionId = "agent/a") => ({
  protocolVersion: "1.0",
  requestId: `request-${idempotencyKey}`,
  operation: "wake",
  sessionId,
  generation: 1,
  idempotencyKey,
  payload: { prompt },
});

test("state storage refuses permissive directories and symlinked files", async () => {
  const permissive = await temporaryState();
  await chmod(permissive, 0o755);
  await assert.rejects(
    new FileDurabilityStore({ stateDir: permissive }).recover(),
    (error) => error instanceof DurabilityError && error.code === "insecure_state_path",
  );

  const stateDir = await temporaryState();
  const store = new FileDurabilityStore({ stateDir });
  await store.recover();
  const outside = join(await temporaryState(), "outside.jsonl");
  await writeFile(outside, "{}\n", { mode: 0o600 });
  await symlink(
    outside,
    join(stateDir, "journal", `${encodedSessionId("agent/a")}.jsonl`),
  );
  await assert.rejects(
    store.beginRequest(wakeCommand("symlink")),
    (error) => error instanceof DurabilityError && error.code === "insecure_state_path",
  );
});

test("manifests use traversal-safe paths and owner-only atomic files", async () => {
  const stateDir = await temporaryState();
  const store = new FileDurabilityStore({ stateDir });
  await store.recover();
  const command = openCommand("../../agent/α");
  const manifest = await store.saveManifest(command);
  assert.equal(manifest.sessionId, "../../agent/α");

  const path = join(stateDir, "sessions", encodedSessionId(command.sessionId), "manifest.json");
  const persisted = JSON.parse(await readFile(path, "utf8"));
  assert.equal(persisted.payload.cwd, command.payload.cwd);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal((await stat(stateDir)).mode & 0o777, 0o700);
  assert.equal(encodedSessionId(command.sessionId).includes("/"), false);
});

test("journal transitions are append-only and terminal duplicates are cached", async () => {
  const stateDir = await temporaryState();
  const store = new FileDurabilityStore({ stateDir });
  await store.recover();
  const command = wakeCommand("key-1");

  assert.equal((await store.beginRequest(command)).state, "queued");
  assert.equal((await store.beginRequest({ ...command, requestId: "retry-request" })).state, "queued");
  assert.equal((await store.markAccepted(command.sessionId, command.idempotencyKey)).state, "accepted");
  const completed = await store.markCompleted(command.sessionId, command.idempotencyKey, {
    text: "answer",
  });
  assert.equal(completed.state, "completed");
  assert.deepEqual(completed.result, { text: "answer" });
  assert.equal((await store.beginRequest(command)).state, "completed");

  await assert.rejects(
    store.beginRequest(wakeCommand("key-1", "different prompt")),
    (error) => error instanceof DurabilityError && error.code === "idempotency_conflict",
  );

  const journal = await readFile(
    join(stateDir, "journal", `${encodedSessionId(command.sessionId)}.jsonl`),
    "utf8",
  );
  assert.deepEqual(
    journal
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line).state),
    ["queued", "accepted", "completed"],
  );
});

test("recovery leaves queued requests replayable and makes accepted requests indeterminate", async () => {
  const stateDir = await temporaryState();
  const first = new FileDurabilityStore({ stateDir });
  await first.recover();
  await first.saveManifest(openCommand());
  await first.beginRequest(wakeCommand("queued"));
  await first.beginRequest(wakeCommand("accepted"));
  await first.markAccepted("agent/a", "accepted");

  const restarted = new FileDurabilityStore({ stateDir });
  const recovery = await restarted.recover();
  assert.deepEqual(recovery.manifests.map((entry) => entry.sessionId), ["agent/a"]);
  assert.deepEqual(recovery.queued.map((entry) => entry.idempotencyKey), ["queued"]);
  assert.deepEqual(recovery.indeterminate.map((entry) => entry.idempotencyKey), ["accepted"]);
  assert.equal((await restarted.beginRequest(wakeCommand("accepted"))).state, "indeterminate");
});

test("terminal journal compaction automatically enforces count retention", async () => {
  const stateDir = await temporaryState();
  let now = Date.parse("2026-01-01T00:00:00.000Z");
  const store = new FileDurabilityStore({
    stateDir,
    maxTerminalEntriesPerSession: 2,
    terminalRetentionMs: 60_000,
    now: () => new Date(now),
  });
  await store.recover();
  for (const key of ["one", "two", "three"]) {
    const command = wakeCommand(key);
    await store.beginRequest(command);
    await store.markFailed(command.sessionId, key, {
      code: "test",
      message: "failed",
      retryable: false,
    });
    now += 1_000;
  }
  assert.equal(await store.pruneSession("agent/a"), 0);

  const restarted = new FileDurabilityStore({
    stateDir,
    maxTerminalEntriesPerSession: 2,
    terminalRetentionMs: 60_000,
    now: () => new Date(now),
  });
  await restarted.recover();
  assert.equal((await restarted.beginRequest(wakeCommand("two"))).state, "failed");
  assert.equal((await restarted.beginRequest(wakeCommand("three"))).state, "failed");
  assert.equal((await restarted.beginRequest(wakeCommand("one"))).state, "queued");
});

class ImmediateAdapter {
  calls = [];
  disposed = 0;

  async prompt(request) {
    this.calls.push(request);
    return { text: `answer:${request.prompt}` };
  }

  dispose() {
    this.disposed += 1;
  }
}

class ImmediateFactory {
  adapters = new Map();

  async open(request) {
    const adapter = new ImmediateAdapter();
    this.adapters.set(`${request.sessionId}:${request.generation}`, adapter);
    return adapter;
  }

  adapter(sessionId = "agent/a", generation = 1) {
    const adapter = this.adapters.get(`${sessionId}:${generation}`);
    assert.ok(adapter);
    return adapter;
  }
}

test("multiplexer joins live duplicates and serves completed duplicates without a second turn", async () => {
  const stateDir = await temporaryState();
  const store = new FileDurabilityStore({ stateDir });
  const factory = new ImmediateFactory();
  const mux = new Multiplexer({ factory, durability: store });
  await mux.recover();
  await mux.open(openCommand());

  const command = wakeCommand("same");
  const [first, duplicate] = await Promise.all([mux.wake(command), mux.wake(command)]);
  assert.deepEqual(first.result, duplicate.result);
  assert.equal(factory.adapter().calls.length, 1);

  const terminalDuplicate = await mux.wake({ ...command, requestId: "later-retry" });
  assert.deepEqual(terminalDuplicate.result, first.result);
  assert.equal(factory.adapter().calls.length, 1);
});

test("multiplexer restart reopens manifests, replays queued only, and refuses accepted replay", async () => {
  const stateDir = await temporaryState();
  const first = new FileDurabilityStore({ stateDir });
  await first.recover();
  await first.saveManifest(openCommand());
  await first.beginRequest(wakeCommand("queued"));
  await first.beginRequest(wakeCommand("accepted"));
  await first.markAccepted("agent/a", "accepted");

  const factory = new ImmediateFactory();
  const mux = new Multiplexer({
    factory,
    durability: new FileDurabilityStore({ stateDir }),
  });
  assert.throws(
    () => mux.wake(wakeCommand("queued")),
    (error) => error instanceof MultiplexerError && error.code === "host_not_ready",
  );
  const report = await mux.recover();
  assert.deepEqual(report.opened, ["agent/a"]);
  assert.deepEqual(report.replayed, ["queued"]);
  assert.equal(factory.adapter().calls.length, 1);
  assert.equal(factory.adapter().calls[0].idempotencyKey, "queued");

  await assert.rejects(
    mux.wake(wakeCommand("accepted")),
    (error) => error instanceof MultiplexerError && error.code === "request_indeterminate",
  );
  assert.equal(factory.adapter().calls.length, 1);
});
