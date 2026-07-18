import assert from "node:assert/strict";
import test from "node:test";
import { performance } from "node:perf_hooks";

import { asDashboardCursor } from "../dist/dashboard-contract.js";
import { ShadowTuiHost, ShadowTuiHostError } from "../dist/shadow-tui-host.js";

const identity = {
  hostInstanceId: "host-shadow-01",
  sessionId: "session-shadow-01",
  generation: 4,
};

const session = {
  sessionId: identity.sessionId,
  generation: identity.generation,
  revision: 1,
  residency: "resident",
  state: "idle",
  createdAt: "2026-07-18T12:00:00.000Z",
  updatedAt: "2026-07-18T12:00:00.000Z",
  lastUsedAt: "2026-07-18T12:00:00.000Z",
  spec: { cwd: "/work/shadow", target: { mode: "memory" } },
  environment: { keys: [], persistence: "memory-only", provisioned: true },
  links: { self: "/v1/session/session-shadow-01", rpc: "/rpc", apc: "/apc" },
};

class FakeView {
  constructor(terminal, tracker) {
    this.terminal = terminal;
    this.tracker = tracker;
    this.extensionUI = { kind: "fixture-extension-ui" };
    this.input = [];
    this.render = 0;
  }

  async init() {
    this.tracker.inits += 1;
    this.terminal.start(
      (data) => {
        this.input.push(data);
        this.terminal.write(`\r\ninput:${data.replaceAll("\u001b", "<esc>")}`);
      },
      () => this.requestRender(true),
    );
    this.terminal.setTitle("Shadow fixture");
    this.terminal.write("\u001b[38;5;33mPi\u001b[0m \u001b[38;2;163;190;140mready\u001b[0m");
  }

  requestRender(force = false) {
    this.render += 1;
    if (force) this.terminal.write("\r\nrender:full");
  }

  stop() {
    this.tracker.stops += 1;
  }
}

function harness(options = {}) {
  const tracker = { creates: 0, inits: 0, stops: 0, binds: 0, releases: 0, runtimes: 0, views: [] };
  const host = new ShadowTuiHost({
    async resolveRuntime(received) {
      assert.deepEqual(received, identity);
      tracker.runtimes += 1;
      return { runtime: "fixture" };
    },
    viewFactory: {
      create(_runtime, viewOptions) {
        tracker.creates += 1;
        assert.equal(viewOptions.extensionBinding, "external");
        assert.equal(typeof viewOptions.host.requestExit, "function");
        const view = new FakeView(viewOptions.host.terminal, tracker);
        tracker.views.push(view);
        return view;
      },
    },
    extensionBroker: {
      bind(received, extensionUI) {
        assert.deepEqual(received, identity);
        assert.deepEqual(extensionUI, { kind: "fixture-extension-ui" });
        tracker.binds += 1;
        return () => { tracker.releases += 1; };
      },
    },
    ...options,
  });
  return { host, tracker };
}

function context(role = "controller", cursor) {
  return {
    options: {
      sessionRef: identity.sessionId,
      generation: identity.generation,
      role,
      dimensions: { rows: 24, columns: 80 },
      ...(cursor === undefined ? {} : { cursor }),
    },
    identity,
    session,
    controller: {},
  };
}

const immediate = () => new Promise((resolve) => setImmediate(resolve));

test("one canonical view owns external UI while controller and observers share frames", async () => {
  const { host, tracker } = harness();
  const controller = await host.open(context("controller"));
  const observer = await host.open(context("observer"));
  assert.equal(tracker.creates, 1);
  assert.equal(tracker.runtimes, 1);
  assert.equal(tracker.binds, 1);
  assert.equal(controller.role, "controller");
  assert.equal(observer.role, "observer");
  assert.deepEqual(controller.identity, identity);
  assert.equal(controller.snapshot.title, "Shadow fixture");
  assert.match(controller.snapshot.rows.flatMap((row) => row.runs).map((run) => run.text).join(""), /Pi ready/);
  const blue = controller.snapshot.rows.flatMap((row) => row.runs).find((run) => run.text === "Pi");
  assert.equal(blue.style.foreground, "#0087ff");
  const green = controller.snapshot.rows.flatMap((row) => row.runs).find((run) => run.text === "ready");
  assert.equal(green.style.foreground, "#a3be8c");

  const controllerEvents = [];
  const observerEvents = [];
  controller.subscribe((event) => controllerEvents.push(event));
  observer.subscribe((event) => observerEvents.push(event));
  await controller.sendInput({ type: "text", text: "!" });
  await immediate();
  assert.equal(controllerEvents.at(-1).kind, "tui_delta");
  assert.equal(observerEvents.at(-1).kind, "tui_delta");
  assert.equal(controllerEvents.at(-1).sequence, 1);
  assert.deepEqual(controllerEvents.at(-1), observerEvents.at(-1));
  await assert.rejects(
    observer.sendInput({ type: "text", text: "denied" }),
    (error) => error instanceof ShadowTuiHostError && error.code === "controller_required",
  );

  assert.equal((await observer.requestControl("busy")).state, "rejected");
  assert.equal((await controller.releaseControl("release")).state, "completed");
  assert.equal((await observer.requestControl("grant")).state, "completed");
  await observer.resize({ rows: 30, columns: 100 });
  await immediate();
  assert.deepEqual(observer.snapshot.dimensions, { rows: 24, columns: 80 });
  assert.deepEqual(observerEvents.at(-1).dimensions, { rows: 30, columns: 100 });

  await controller.close();
  await observer.close();
  assert.equal(tracker.stops, 1);
  assert.equal(tracker.releases, 1);
});

test("replay cursors produce deltas or explicit gap plus authoritative snapshot", async () => {
  const { host } = harness({ limits: { maxReplayEvents: 1 } });
  const controller = await host.open(context("controller"));
  const base = controller.snapshot.highWaterCursor;
  await controller.sendInput({ type: "text", text: "one" });
  await immediate();
  const latest = [];
  controller.subscribe((event) => latest.push(event));
  await controller.sendInput({ type: "text", text: "two" });
  await immediate();
  const resumed = await host.open(context("observer", latest.at(-1).cursor));
  const resumedEvents = [];
  resumed.subscribe((event) => resumedEvents.push(event));
  assert.deepEqual(resumedEvents, []);

  const expired = await host.open(context("observer", base));
  const expiredEvents = [];
  expired.subscribe((event) => expiredEvents.push(event));
  assert.equal(expiredEvents[0].kind, "replay_gap");
  assert.equal(expiredEvents[0].snapshotFollows, true);
  assert.equal(expired.snapshot.highWaterCursor, latest.at(-1).cursor);

  const invalid = await host.open(context("observer", asDashboardCursor("tui:invalid")));
  const invalidEvents = [];
  invalid.subscribe((event) => invalidEvents.push(event));
  assert.equal(invalidEvents[0].reason, "cursor-expired");
  await controller.close();
  await resumed.close();
  await expired.close();
  await invalid.close();
});

test("semantic input is bounded, UTF-8 paste chunks safely and unsupported meta fails", async () => {
  const { host, tracker } = harness();
  const channel = await host.open(context("controller"));
  await channel.sendInput({ type: "key", key: "a", modifiers: ["ctrl"] });
  await channel.sendInput({ type: "key", key: "ArrowUp", modifiers: ["alt"] });
  const paste = "世界".repeat(4_000);
  await channel.sendInput({ type: "paste", text: paste });
  assert.equal(tracker.views[0].input[0], "\u0001");
  assert.equal(tracker.views[0].input[1], "\u001b\u001b[A");
  assert.equal(tracker.views[0].input.slice(2).join(""), paste);
  assert.ok(tracker.views[0].input.slice(2).every((part) => Buffer.byteLength(part, "utf8") <= 16 * 1024));
  await assert.rejects(
    channel.sendInput({ type: "key", key: "k", modifiers: ["meta"] }),
    (error) => error instanceof ShadowTuiHostError && error.code === "unsupported_tui_input",
  );
  await assert.rejects(
    channel.sendInput({ type: "text", text: "x".repeat(16 * 1024 + 1) }),
    (error) => error instanceof ShadowTuiHostError && error.code === "tui_input_too_large",
  );
  await channel.close();
});

test("generation invalidation tears down broker and peers before replacement", async () => {
  const { host, tracker } = harness();
  const channel = await host.open(context("controller"));
  host.invalidate(identity, "generation replaced");
  await immediate();
  assert.equal(tracker.stops, 1);
  assert.equal(tracker.releases, 1);
  await assert.rejects(
    channel.sendInput({ type: "text", text: "stale" }),
    (error) => error instanceof ShadowTuiHostError && error.code === "shadow_tui_channel_closed",
  );
});

test("rapid render and resize publication remains coalesced under 50ms", async (t) => {
  const { host, tracker } = harness();
  const channel = await host.open(context("controller"));
  const samples = [];
  const events = [];
  channel.subscribe((event) => {
    if (event.kind === "tui_delta") events.push(event);
  });
  for (let index = 0; index < 80; index += 1) {
    const startedAt = performance.now();
    tracker.views[0].terminal.write(`\rstream ${index}`);
    tracker.views[0].requestRender(index % 10 === 0);
    await immediate();
    samples.push(performance.now() - startedAt);
  }
  samples.sort((first, second) => first - second);
  const p95 = samples[Math.floor(samples.length * 0.95)] ?? Infinity;
  t.diagnostic(`shadow host p95=${p95.toFixed(2)}ms events=${events.length}`);
  assert.ok(p95 < 50, `shadow host p95 ${p95.toFixed(2)}ms`);
  assert.ok(events.length <= 80);
  assert.ok(events.every((event, index) => event.sequence === index + 1));
  await channel.close();
});
