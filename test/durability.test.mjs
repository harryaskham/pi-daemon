import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, symlink, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  DurabilityError,
  FileDurabilityStore,
  encodedSessionId,
  wakeTicketId,
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

const persistentOpenCommand = (sessionId = "agent/a", generation = 1) => {
  const command = openCommand(sessionId, generation);
  command.payload.session = { mode: "new" };
  return command;
};

const conversationIdentity = (sessionId = "agent/a", generation = 1) => ({
  sessionId: `pi-${sessionId}-${generation}`,
  sessionFile: `/state/pi/${encodeURIComponent(sessionId)}-${generation}.jsonl`,
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
  const command = persistentOpenCommand("../../agent/α");
  const identity = conversationIdentity(command.sessionId);
  const manifest = await store.saveManifest(command, identity);
  assert.equal(manifest.sessionId, "../../agent/α");

  const path = join(stateDir, "sessions", encodedSessionId(command.sessionId), "manifest.json");
  const persisted = JSON.parse(await readFile(path, "utf8"));
  assert.equal(persisted.payload.cwd, command.payload.cwd);
  assert.deepEqual(persisted.conversation, identity);
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
  assert.equal(
    (
      await store.beginRequest({
        ...command,
        requestId: "retry-request",
        payload: { ...command.payload, waitForTerminal: false },
      })
    ).state,
    "queued",
  );
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

test("recovery bounds manifest bytes, journal totals, and retained session counts", async () => {
  const manifestState = await temporaryState();
  const manifestStore = new FileDurabilityStore({
    stateDir: manifestState,
    maxManifestBytes: 256,
  });
  await manifestStore.recover();
  await assert.rejects(
    manifestStore.saveManifest({
      ...persistentOpenCommand("manifest-large"),
      payload: {
        ...persistentOpenCommand("manifest-large").payload,
        resources: {
          extensions: "none",
          skills: "none",
          promptTemplates: "none",
          themes: "none",
          contextFiles: "none",
          tools: "none",
          systemPrompt: "x".repeat(512),
        },
      },
    }),
    (error) => error instanceof DurabilityError && error.code === "manifest_too_large",
  );

  const journalState = await temporaryState();
  const journalStore = new FileDurabilityStore({
    stateDir: journalState,
    maxJournalFileBytes: 512,
  });
  await journalStore.recover();
  await assert.rejects(
    journalStore.beginRequest(wakeCommand("journal-total", "x".repeat(512))),
    (error) => error instanceof DurabilityError && error.code === "journal_too_large",
  );

  const countState = await temporaryState();
  const countStore = new FileDurabilityStore({ stateDir: countState });
  await countStore.recover();
  await countStore.saveManifest(persistentOpenCommand("count-a"), conversationIdentity("count-a"));
  await countStore.saveManifest(persistentOpenCommand("count-b"), conversationIdentity("count-b"));
  await assert.rejects(
    new FileDurabilityStore({ stateDir: countState, maxRecoveredSessions: 1 }).recover(),
    (error) =>
      error instanceof DurabilityError && error.code === "recovery_session_capacity",
  );
});

test("journal byte limit bounds prompts and retained terminal results", async () => {
  const stateDir = await temporaryState();
  const store = new FileDurabilityStore({ stateDir, maxJournalRecordBytes: 2_048 });
  await store.recover();
  const oversizedPrompt = wakeCommand("large-prompt", "x".repeat(4_096));
  await assert.rejects(
    store.beginRequest(oversizedPrompt),
    (error) => error instanceof DurabilityError && error.code === "journal_record_too_large",
  );

  const command = wakeCommand("large-result");
  await store.beginRequest(command);
  await store.markAccepted(command.sessionId, command.idempotencyKey);
  await assert.rejects(
    store.markCompleted(command.sessionId, command.idempotencyKey, { text: "x".repeat(4_096) }),
    (error) => error instanceof DurabilityError && error.code === "journal_record_too_large",
  );
  assert.equal((await store.beginRequest(command)).state, "accepted");
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

test("wake journal tickets support exact lookup and explicit indeterminate reconciliation", async () => {
  const stateDir = await temporaryState();
  const first = new FileDurabilityStore({ stateDir });
  await first.recover();
  const command = wakeCommand("reconcile");
  await first.beginRequest(command);
  await first.markAccepted(command.sessionId, command.idempotencyKey);

  const restarted = new FileDurabilityStore({ stateDir });
  await restarted.recover();
  const ticketId = wakeTicketId(command.sessionId, command.idempotencyKey);
  assert.equal((await restarted.getRequestByTicket(ticketId)).state, "indeterminate");
  assert.equal(
    (await restarted.getRequest(command.sessionId, command.idempotencyKey)).requestId,
    command.requestId,
  );
  const reconciled = await restarted.reconcileRequest(ticketId, {
    state: "completed",
    result: { text: "observed in Pi entry entry-7" },
  });
  assert.equal(reconciled.state, "completed");
  assert.deepEqual(reconciled.result, { text: "observed in Pi entry entry-7" });
  await assert.rejects(
    restarted.reconcileRequest(ticketId, { state: "completed", result: {} }),
    (error) => error instanceof DurabilityError && error.code === "ticket_not_indeterminate",
  );
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

  constructor(sessionId, generation) {
    this.conversation = conversationIdentity(sessionId, generation);
  }

  identity() {
    return this.conversation;
  }

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
  requests = [];

  async open(request) {
    this.requests.push(structuredClone(request));
    const adapter = new ImmediateAdapter(request.sessionId, request.generation);
    this.adapters.set(`${request.sessionId}:${request.generation}`, adapter);
    return adapter;
  }

  adapter(sessionId = "agent/a", generation = 1) {
    const adapter = this.adapters.get(`${sessionId}:${generation}`);
    assert.ok(adapter);
    return adapter;
  }
}

class BlockingReplayAdapter extends ImmediateAdapter {
  constructor(sessionId, generation) {
    super(sessionId, generation);
    this.releaseReplay = undefined;
    this.replayGate = new Promise((resolve) => (this.releaseReplay = resolve));
  }

  async prompt(request) {
    this.calls.push(request);
    await this.replayGate;
    return { text: `answer:${request.prompt}` };
  }
}

class BlockingReplayFactory extends ImmediateFactory {
  async open(request) {
    this.requests.push(structuredClone(request));
    const adapter = new BlockingReplayAdapter(request.sessionId, request.generation);
    this.adapters.set(`${request.sessionId}:${request.generation}`, adapter);
    return adapter;
  }
}

class HangingOpenFactory extends ImmediateFactory {
  async open(request) {
    this.requests.push(structuredClone(request));
    return new Promise(() => {});
  }
}

class MemoryFactory extends ImmediateFactory {
  async open(request) {
    const adapter = await super.open(request);
    adapter.conversation = { sessionId: `pi-memory-${request.sessionId}` };
    return adapter;
  }
}

test("memory sessions never persist manifests or wake journals for crash replay", async () => {
  const stateDir = await temporaryState();
  const mux = new Multiplexer({
    factory: new MemoryFactory(),
    durability: new FileDurabilityStore({ stateDir }),
  });
  await mux.recover();
  await mux.open(openCommand("memory-agent"));
  await mux.wake(wakeCommand("memory-key", "ephemeral", "memory-agent"));
  await assert.rejects(
    mux.submitWake(wakeCommand("memory-ticket", "ephemeral", "memory-agent")),
    (error) =>
      error instanceof MultiplexerError &&
      error.code === "durable_admission_unavailable",
  );

  const recovered = await new FileDurabilityStore({ stateDir }).recover();
  assert.deepEqual(recovered.manifests, []);
  assert.deepEqual(recovered.queued, []);
  assert.deepEqual(recovered.indeterminate, []);
});

test("multiplexer joins live duplicates and serves completed duplicates without a second turn", async () => {
  const stateDir = await temporaryState();
  const store = new FileDurabilityStore({ stateDir });
  const factory = new ImmediateFactory();
  const mux = new Multiplexer({ factory, durability: store });
  await mux.recover();
  await mux.open(persistentOpenCommand());

  const command = wakeCommand("same");
  const [first, duplicate] = await Promise.all([mux.wake(command), mux.wake(command)]);
  assert.deepEqual(first.result, duplicate.result);
  assert.equal(factory.adapter().calls.length, 1);

  const terminalDuplicate = await mux.wake({ ...command, requestId: "later-retry" });
  assert.deepEqual(terminalDuplicate.result, first.result);
  assert.equal(factory.adapter().calls.length, 1);
});

test("legacy new manifests without resolved identity never admit queued replay", async () => {
  const stateDir = await temporaryState();
  const first = new FileDurabilityStore({ stateDir });
  await first.recover();
  await first.saveManifest(persistentOpenCommand());
  await first.beginRequest(wakeCommand("legacy-queued"));

  const factory = new ImmediateFactory();
  const mux = new Multiplexer({
    factory,
    durability: new FileDurabilityStore({ stateDir }),
  });
  const report = await mux.recover();
  assert.deepEqual(report.opened, []);
  assert.deepEqual(report.replayed, []);
  assert.ok(
    report.failures.some(
      (failure) => failure.sessionId === "agent/a" && failure.code === "conversation_identity_missing",
    ),
  );
  assert.equal(factory.requests.length, 0);
});

test("session recovery open is deadline bounded and records degraded health", async () => {
  const stateDir = await temporaryState();
  const first = new FileDurabilityStore({ stateDir });
  await first.recover();
  await first.saveManifest(persistentOpenCommand(), conversationIdentity());
  const mux = new Multiplexer({
    factory: new HangingOpenFactory(),
    durability: new FileDurabilityStore({ stateDir }),
  });
  const started = Date.now();
  const report = await mux.recover({ openTimeoutMs: 10, totalOpenTimeoutMs: 20 });
  assert.ok(Date.now() - started < 500);
  assert.ok(
    report.failures.some((failure) => failure.code === "recovery_open_timeout"),
    JSON.stringify(report.failures),
  );
  assert.equal(mux.status().recovery.phase, "degraded");
  assert.equal(mux.status().ready, false);
  await assert.rejects(
    mux.open(persistentOpenCommand()),
    (error) =>
      error instanceof MultiplexerError && error.code === "recovery_open_timeout",
  );
});

test("background recovery listens without waiting for queued model completion and reports truthful health", async () => {
  const stateDir = await temporaryState();
  const first = new FileDurabilityStore({ stateDir });
  await first.recover();
  await first.saveManifest(persistentOpenCommand(), conversationIdentity());
  await first.beginRequest(wakeCommand("background"));

  const factory = new BlockingReplayFactory();
  const mux = new Multiplexer({
    factory,
    durability: new FileDurabilityStore({ stateDir }),
  });
  const report = await mux.recover({ queuedReplay: "background" });
  assert.deepEqual(report.opened, ["agent/a"], JSON.stringify(report.failures));
  assert.equal(report.pendingReplays, 1);
  assert.equal(mux.status().ready, false);
  assert.equal(mux.status().recovery.phase, "recovering");
  const adapter = factory.adapter();
  const replayStartDeadline = Date.now() + 2_000;
  while (adapter.calls.length === 0 && Date.now() < replayStartDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(adapter.calls.length, 1);

  adapter.releaseReplay();
  assert.equal(await mux.waitForBackgroundRecovery(1_000), true);
  assert.equal(mux.status().ready, true);
  assert.equal(mux.status().recovery.phase, "ready");
  assert.equal(mux.status().recovery.pendingReplays, 0);
  assert.equal(mux.status().recovery.replayedRequests, 1);
});

test("multiplexer restart reopens exact resolved identity, replays queued only, and refuses accepted replay", async () => {
  const stateDir = await temporaryState();
  const first = new FileDurabilityStore({ stateDir });
  await first.recover();
  await first.saveManifest(persistentOpenCommand(), conversationIdentity());
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
  assert.deepEqual(report.opened, ["agent/a"], JSON.stringify(report.failures));
  assert.deepEqual(report.replayed, ["queued"]);
  assert.equal(mux.status().ready, false);
  assert.equal(mux.status().recovery.phase, "degraded");
  assert.equal(mux.status().recovery.indeterminateRequests, 1);
  assert.equal(factory.adapter().calls.length, 1);
  assert.equal(factory.adapter().calls[0].idempotencyKey, "queued");
  assert.deepEqual(factory.requests[0].session, {
    mode: "open",
    path: conversationIdentity().sessionFile,
  });

  await assert.rejects(
    mux.wake(wakeCommand("accepted")),
    (error) => error instanceof MultiplexerError && error.code === "request_indeterminate",
  );
  assert.equal(factory.adapter().calls.length, 1);
});
