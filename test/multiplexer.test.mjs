import assert from "node:assert/strict";
import test from "node:test";

import { Multiplexer, MultiplexerError } from "../dist/multiplexer.js";

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const openCommand = (sessionId, generation = 1, overrides = {}) => ({
  protocolVersion: "1.0",
  requestId: `open-${sessionId}-${generation}`,
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
    ...overrides,
  },
});

const wakeCommand = (sessionId, requestId, generation = 1) => ({
  protocolVersion: "1.0",
  requestId,
  operation: "wake",
  sessionId,
  generation,
  idempotencyKey: `key-${requestId}`,
  payload: { prompt: `prompt-${requestId}` },
});

const abortCommand = (sessionId, requestId, generation = 1) => ({
  protocolVersion: "1.0",
  requestId,
  operation: "abort",
  sessionId,
  generation,
  payload: {},
});

const closeCommand = (sessionId, generation = 1) => ({
  protocolVersion: "1.0",
  requestId: `close-${sessionId}`,
  operation: "close",
  sessionId,
  generation,
  payload: {},
});

class ControlledAdapter {
  calls = [];
  active = 0;
  maxActive = 0;
  disposed = 0;
  aborted = 0;

  prompt(request) {
    const completion = deferred();
    const call = { request, completion };
    this.calls.push(call);
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    request.signal.addEventListener(
      "abort",
      () => completion.reject(new DOMException("aborted", "AbortError")),
      { once: true },
    );
    return completion.promise.finally(() => {
      this.active -= 1;
    });
  }

  abort() {
    this.aborted += 1;
  }

  dispose() {
    this.disposed += 1;
  }
}

class ControlledFactory {
  adapters = new Map();
  opens = [];

  async open(request) {
    this.opens.push(request);
    const adapter = new ControlledAdapter();
    this.adapters.set(`${request.sessionId}:${request.generation}`, adapter);
    return adapter;
  }

  adapter(sessionId, generation = 1) {
    const adapter = this.adapters.get(`${sessionId}:${generation}`);
    assert.ok(adapter, `missing adapter for ${sessionId}:${generation}`);
    return adapter;
  }
}

const waitFor = async (predicate, message = "condition") => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.fail(`timed out waiting for ${message}`);
};

test("open is generation-aware idempotent and replaces only idle sessions", async () => {
  const factory = new ControlledFactory();
  const mux = new Multiplexer({ factory, hostInstanceId: "host-test" });

  const first = await mux.open(openCommand("a"));
  assert.equal(first.created, true);
  const duplicate = await mux.open(openCommand("a"));
  assert.equal(duplicate.created, false);
  assert.equal(factory.opens.length, 1);

  await assert.rejects(
    mux.open(openCommand("a", 1, { cwd: "/different" })),
    (error) => error instanceof MultiplexerError && error.code === "session_policy_conflict",
  );
  await assert.rejects(
    mux.open(openCommand("a", 0)),
    (error) => error instanceof MultiplexerError && error.code === "stale_generation",
  );

  const oldAdapter = factory.adapter("a");
  const replacement = await mux.open(openCommand("a", 2));
  assert.equal(replacement.created, true);
  assert.equal(replacement.session.generation, 2);
  assert.equal(oldAdapter.disposed, 1);
});

test("concurrent duplicate opens create only one adapter", async () => {
  const release = deferred();
  let opens = 0;
  const adapter = new ControlledAdapter();
  const mux = new Multiplexer({
    factory: {
      async open() {
        opens += 1;
        await release.promise;
        return adapter;
      },
    },
  });

  const first = mux.open(openCommand("a"));
  const second = mux.open(openCommand("a"));
  await waitFor(() => opens === 1, "first open");
  release.resolve();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(opens, 1);
  assert.equal(a.created, true);
  assert.equal(b.created, false);
});

test("maxSessions is bounded and closing releases capacity", async () => {
  const factory = new ControlledFactory();
  const mux = new Multiplexer({ factory, limits: { maxSessions: 1 } });
  await mux.open(openCommand("a"));
  await assert.rejects(
    mux.open(openCommand("b")),
    (error) => error instanceof MultiplexerError && error.code === "session_capacity",
  );
  assert.equal(await mux.close(closeCommand("a")), true);
  assert.equal(await mux.open(openCommand("b")).then((result) => result.created), true);
});

test("turns serialize per session and preserve monotonic event sequence", async () => {
  const factory = new ControlledFactory();
  const mux = new Multiplexer({ factory });
  const events = [];
  mux.subscribe((event) => events.push(event));
  mux.subscribe(() => {
    throw new Error("broken transport listener");
  });
  await mux.open(openCommand("a"));
  const adapter = factory.adapter("a");

  const first = mux.wake(wakeCommand("a", "one"));
  const second = mux.wake(wakeCommand("a", "two"));
  await waitFor(() => adapter.calls.length === 1, "first serialized prompt");
  assert.equal(adapter.maxActive, 1);
  adapter.calls[0].request.onEvent({ event: "messageUpdate", data: { delta: "1" } });
  adapter.calls[0].completion.resolve("result-one");
  assert.equal((await first).result, "result-one");

  await waitFor(() => adapter.calls.length === 2, "second serialized prompt");
  assert.equal(adapter.maxActive, 1);
  adapter.calls[1].completion.resolve("result-two");
  assert.equal((await second).result, "result-two");

  const sequences = events.filter((event) => event.sessionId === "a").map((event) => event.sequence);
  assert.deepEqual(sequences, sequences.map((_, index) => index + 1));
  assert.equal(mux.status("a").state, "idle");
});

test("global semaphore caps turns across independent sessions", async () => {
  const factory = new ControlledFactory();
  const mux = new Multiplexer({ factory, limits: { maxConcurrentTurns: 2 } });
  await Promise.all([mux.open(openCommand("a")), mux.open(openCommand("b")), mux.open(openCommand("c"))]);

  const wakes = [
    mux.wake(wakeCommand("a", "a1")),
    mux.wake(wakeCommand("b", "b1")),
    mux.wake(wakeCommand("c", "c1")),
  ];
  const adapters = [factory.adapter("a"), factory.adapter("b"), factory.adapter("c")];
  await waitFor(() => adapters.reduce((count, adapter) => count + adapter.calls.length, 0) === 2);
  assert.equal(mux.status().activeTurns, 2);
  assert.equal(mux.status().queuedTurns, 1);

  const firstRunning = adapters.find((adapter) => adapter.calls.length === 1);
  firstRunning.calls[0].completion.resolve("released");
  await waitFor(() => adapters.reduce((count, adapter) => count + adapter.calls.length, 0) === 3);
  for (const adapter of adapters) {
    for (const call of adapter.calls) call.completion.resolve("done");
  }
  await Promise.all(wakes);
  assert.equal(mux.status().activeTurns, 0);
});

test("queue depth rejects excess turns without starting them", async () => {
  const factory = new ControlledFactory();
  const mux = new Multiplexer({ factory, limits: { maxSessionQueueDepth: 0 } });
  await mux.open(openCommand("a"));
  const first = mux.wake(wakeCommand("a", "one"));
  assert.throws(
    () => mux.wake(wakeCommand("a", "two")),
    (error) => error instanceof MultiplexerError && error.code === "session_queue_full",
  );
  await waitFor(() => factory.adapter("a").calls.length === 1);
  factory.adapter("a").calls[0].completion.resolve("done");
  await first;
});

test("abort bypasses the turn queue and returns the session to idle", async () => {
  const factory = new ControlledFactory();
  const mux = new Multiplexer({ factory });
  await mux.open(openCommand("a"));
  const wake = mux.wake(wakeCommand("a", "one"));
  await waitFor(() => factory.adapter("a").calls.length === 1);
  assert.equal(await mux.abort(abortCommand("a", "abort-one")), true);
  await assert.rejects(
    wake,
    (error) => error instanceof MultiplexerError && error.code === "aborted",
  );
  assert.equal(factory.adapter("a").aborted, 1);
  assert.equal(mux.status("a").state, "idle");
});

test("an immediate abort cancels a wake before adapter submission", async () => {
  const factory = new ControlledFactory();
  const mux = new Multiplexer({ factory });
  await mux.open(openCommand("a"));
  const wake = mux.wake(wakeCommand("a", "one"));
  assert.equal(await mux.abort(abortCommand("a", "abort-one")), true);
  await assert.rejects(
    wake,
    (error) => error instanceof MultiplexerError && error.code === "aborted",
  );
  assert.equal(factory.adapter("a").calls.length, 0);
  assert.equal(mux.status("a").state, "idle");
});

test("one session failure is contained from another session", async () => {
  const factory = new ControlledFactory();
  const mux = new Multiplexer({ factory, limits: { maxConcurrentTurns: 2 } });
  await Promise.all([mux.open(openCommand("a")), mux.open(openCommand("b"))]);
  const failed = mux.wake(wakeCommand("a", "a1"));
  const healthy = mux.wake(wakeCommand("b", "b1"));
  await waitFor(() => factory.adapter("a").calls.length + factory.adapter("b").calls.length === 2);
  factory.adapter("a").calls[0].completion.reject(new Error("provider exploded"));
  factory.adapter("b").calls[0].completion.resolve("healthy");

  await assert.rejects(
    failed,
    (error) => error instanceof MultiplexerError && error.code === "turn_failed",
  );
  assert.equal((await healthy).result, "healthy");
  assert.equal(mux.status("a").state, "failed");
  assert.equal(mux.status("b").state, "idle");
});

test("draining rejects admission without hiding existing status", async () => {
  const factory = new ControlledFactory();
  const mux = new Multiplexer({ factory });
  await mux.open(openCommand("a"));
  mux.beginDrain();
  assert.equal(mux.status().draining, true);
  await assert.rejects(
    mux.open(openCommand("b")),
    (error) => error instanceof MultiplexerError && error.code === "host_draining",
  );
  assert.throws(
    () => mux.wake(wakeCommand("a", "one")),
    (error) => error instanceof MultiplexerError && error.code === "host_draining",
  );
});
