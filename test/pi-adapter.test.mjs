import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";

import { PiSessionAdapter, PiSessionFactory } from "../dist/pi-adapter.js";

const temporaryDirectory = () => mkdtemp(join(tmpdir(), "pi-daemon-adapter-"));

const modelHarness = () => {
  const seedRegistry = ModelRegistry.inMemory(AuthStorage.inMemory());
  const model = seedRegistry.getAll()[0];
  assert.ok(model, "Pi built-in model registry must not be empty");
  const authStorage = AuthStorage.inMemory({
    [model.provider]: { type: "api_key", key: "test-only-key" },
  });
  const modelRegistry = ModelRegistry.inMemory(authStorage);
  return { authStorage, modelRegistry, model };
};

const openRequest = (cwd, model, sessionId = "agent-a") => ({
  sessionId,
  generation: 1,
  cwd,
  session: { mode: "memory" },
  model: { provider: model.provider, id: model.id, thinkingLevel: "off" },
  resources: {
    extensions: "none",
    skills: "none",
    promptTemplates: "none",
    themes: "none",
    contextFiles: "none",
    tools: "none",
    systemPrompt: "Reply tersely.",
  },
});

class FakePiSession {
  listeners = new Set();
  sessionId;
  sessionFile = undefined;
  model;
  thinkingLevel = "off";
  disposed = 0;
  aborted = 0;
  steering = [];
  followUps = [];
  lastText = undefined;
  preflight = true;

  constructor(id, model) {
    this.sessionId = id;
    this.model = model;
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getActiveToolNames() {
    return [];
  }

  async prompt(text, options) {
    options.preflightResult?.(this.preflight);
    if (!this.preflight) throw new Error("preflight rejected");
    this.emit({ type: "turn_start" });
    this.emit({
      type: "message_update",
      message: { role: "assistant", content: [] },
      assistantMessageEvent: { type: "text_delta", delta: `answer:${text}` },
    });
    this.lastText = `answer:${text}`;
    this.emit({
      type: "turn_end",
      message: { role: "assistant", content: [] },
      toolResults: [],
    });
  }

  emit(event) {
    for (const listener of this.listeners) listener(event);
  }

  getLastAssistantText() {
    return this.lastText;
  }

  async steer(message) {
    this.steering.push(message);
  }

  async followUp(message) {
    this.followUps.push(message);
  }

  async abort() {
    this.aborted += 1;
  }

  dispose() {
    this.disposed += 1;
  }
}

test("factory shares auth/models while isolating session, settings, and locked resources", async () => {
  const stateDir = await temporaryDirectory();
  const agentDir = await temporaryDirectory();
  const cwd = await temporaryDirectory();
  const { authStorage, modelRegistry, model } = modelHarness();
  const captures = [];
  const sessions = [];
  const factory = new PiSessionFactory({
    stateDir,
    agentDir,
    authStorage,
    modelRegistry,
    async createSession(options) {
      captures.push(options);
      const session = new FakePiSession(`sdk-${captures.length}`, options.model);
      sessions.push(session);
      return {
        session,
        extensionsResult: options.resourceLoader.getExtensions(),
      };
    },
  });

  const first = await factory.open(openRequest(cwd, model, "a"));
  const second = await factory.open(openRequest(cwd, model, "b"));
  assert.equal(captures.length, 2);
  assert.equal(captures[0].authStorage, authStorage);
  assert.equal(captures[1].modelRegistry, modelRegistry);
  assert.notEqual(captures[0].sessionManager, captures[1].sessionManager);
  assert.notEqual(captures[0].settingsManager, captures[1].settingsManager);
  assert.notEqual(captures[0].resourceLoader, captures[1].resourceLoader);
  assert.equal(captures[0].noTools, "all");
  assert.deepEqual(captures[0].tools, []);
  assert.deepEqual(captures[0].customTools, []);
  assert.deepEqual(captures[0].resourceLoader.getSkills(), { skills: [], diagnostics: [] });
  assert.deepEqual(captures[0].resourceLoader.getAgentsFiles(), { agentsFiles: [] });
  assert.equal(captures[0].resourceLoader.getSystemPrompt(), "Reply tersely.");
  assert.deepEqual(captures[0].resourceLoader.getAppendSystemPrompt(), []);

  first.dispose();
  second.dispose();
  assert.equal(sessions[0].disposed, 1);
  assert.equal(sessions[1].disposed, 1);
});

test("adapter maps Pi events, prompt result, queue controls, abort, and preflight rejection", async () => {
  const { model } = modelHarness();
  const session = new FakePiSession("sdk-a", model);
  const adapter = new PiSessionAdapter(session);
  const events = [];
  const result = await adapter.prompt({
    requestId: "request-1",
    idempotencyKey: "key-1",
    prompt: "hello",
    signal: new AbortController().signal,
    onEvent: (event) => events.push(event),
  });
  assert.equal(result.text, "answer:hello");
  assert.deepEqual(
    events.map((event) => event.event),
    ["turnStart", "messageUpdate", "turnEnd"],
  );

  await adapter.steer("steer");
  await adapter.followUp("follow");
  await adapter.abort();
  assert.deepEqual(session.steering, ["steer"]);
  assert.deepEqual(session.followUps, ["follow"]);
  assert.equal(session.aborted, 1);

  session.preflight = false;
  const rejected = [];
  await assert.rejects(
    adapter.prompt({
      requestId: "request-2",
      idempotencyKey: "key-2",
      prompt: "rejected",
      signal: new AbortController().signal,
      onEvent: (event) => rejected.push(event),
    }),
    /preflight rejected/,
  );
  assert.deepEqual(rejected.map((event) => event.event), ["preflightRejected"]);
  adapter.dispose();
});

test("real Pi SDK opens an isolated no-tools in-memory session without a model turn", async () => {
  const stateDir = await temporaryDirectory();
  const agentDir = await temporaryDirectory();
  const cwd = await temporaryDirectory();
  const { authStorage, modelRegistry, model } = modelHarness();
  const factory = new PiSessionFactory({
    stateDir,
    agentDir,
    authStorage,
    modelRegistry,
  });
  const adapter = await factory.open(openRequest(cwd, model));
  adapter.dispose();
  const readiness = factory.readiness();
  assert.ok(readiness.availableModels > 0);
  assert.deepEqual(readiness.authErrors, []);
});
