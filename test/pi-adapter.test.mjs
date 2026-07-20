import assert from "node:assert/strict";
import { chmod, copyFile, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  AuthStorage,
  ModelRegistry,
  createAgentSession,
} from "@earendil-works/pi-coding-agent";

import { PiAdapterError, PiSessionAdapter, PiSessionFactory } from "../dist/pi-adapter.js";
import { parseSessionConfiguration } from "../dist/session-config.js";

const temporaryDirectory = async () =>
  realpath(await mkdtemp(join(tmpdir(), "pi-daemon-adapter-")));

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
  extensionRunner = { hasHandlers: () => false, emit: async () => undefined };
  sessionId;
  sessionFile;
  sessionManager;
  model;
  thinkingLevel = "off";
  isIdle = true;
  disposed = 0;
  aborted = 0;
  bindings = 0;
  waits = 0;
  steering = [];
  followUps = [];
  lastText = undefined;
  preflight = true;
  activeToolNames = [];

  constructor(id, model, sessionManager) {
    this.sessionId = id;
    this.model = model;
    this.sessionManager = sessionManager;
    this.sessionFile = sessionManager?.getSessionFile();
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getActiveToolNames() {
    return [...this.activeToolNames];
  }

  async bindExtensions() {
    this.bindings += 1;
  }

  async waitForIdle() {
    this.waits += 1;
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
    this.emit({
      type: "entry_appended",
      entry: { type: "custom", id: "entry-1", parentId: null, customType: "compat" },
    });
    this.emit({ type: "agent_settled" });
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

class FakePiRuntime {
  session;
  nextSession;
  #rebind;
  #beforeInvalidate;

  constructor(session, nextSession) {
    this.session = session;
    this.nextSession = nextSession;
  }

  setRebindSession(handler) {
    this.#rebind = handler;
  }

  setBeforeSessionInvalidate(handler) {
    this.#beforeInvalidate = handler;
  }

  async newSession() {
    this.#beforeInvalidate?.();
    this.session.dispose();
    this.session = this.nextSession;
    await this.#rebind?.(this.session);
    return { cancelled: false };
  }

  async dispose() {
    this.#beforeInvalidate?.();
    this.session.dispose();
  }
}

const adapterForFakeRuntime = async (runtime, sessionRoot) => {
  const adapter = await PiSessionAdapter.create(runtime, {
    sessionRoot,
    validateCwd: async (cwd) => cwd,
  });
  await adapter.rpcController();
  return adapter;
};

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
    allowedRoots: [cwd],
    authStorage,
    modelRegistry,
    async createSession(options) {
      captures.push(options);
      const session = new FakePiSession(
        `sdk-${captures.length}`,
        options.model,
        options.sessionManager,
      );
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
  assert.equal(sessions[0].bindings, 1);
  assert.equal(sessions[1].bindings, 1);
  assert.throws(
    () => captures[0].resourceLoader.extendResources({ skillPaths: [{}] }),
    (error) => error instanceof PiAdapterError && error.code === "resource_extension_refused",
  );

  await first.dispose();
  await second.dispose();
  assert.equal(sessions[0].disposed, 1);
  assert.equal(sessions[1].disposed, 1);
});

test("factory injects only descriptor-granted host tools and revokes them with the session", async () => {
  const stateDir = await temporaryDirectory();
  const agentDir = await temporaryDirectory();
  const cwd = await temporaryDirectory();
  const { authStorage, modelRegistry, model } = modelHarness();
  const captures = [];
  const registryCalls = [];
  const invocations = [];
  let disposed = 0;
  const hostSession = {
    operations: ["fs.read", "fs.stat"],
    limits: {
      maxRequestBytes: 4096,
      maxResponseBytes: 4096,
      maxConcurrentRequests: 2,
      maxQueuedRequests: 2,
      requestTimeoutMs: 1000,
      maxIdempotencyKeys: 32,
      idempotencyTtlMs: 10_000,
    },
    async normalizePath(path) {
      return path;
    },
    async invoke(operation, payload, options) {
      invocations.push({ operation, payload, options });
      return operation === "fs.read"
        ? { content: "adapter content", bytesRead: 15, eof: true }
        : { type: "file", size: 15 };
    },
    async dispose() {
      disposed += 1;
    },
  };
  const hostToolAdapters = {
    async open(descriptor, options) {
      registryCalls.push({ descriptor, options });
      return hostSession;
    },
  };
  const factory = new PiSessionFactory({
    stateDir,
    agentDir,
    allowedRoots: [cwd],
    authStorage,
    modelRegistry,
    hostToolAdapters,
    async createSession(options) {
      captures.push(options);
      const session = new FakePiSession("host-tools", options.model, options.sessionManager);
      session.activeToolNames = options.customTools.map((tool) => tool.name);
      return {
        session,
        extensionsResult: options.resourceLoader.getExtensions(),
      };
    },
  });
  const descriptor = {
    protocolVersion: "1.0",
    adapterId: "fixture-adapter",
    adapterVersion: "1.0.0",
    endpoint: { transport: "unix", path: join(stateDir, "adapter.sock") },
    binding: {
      hostInstanceId: "host-runtime",
      sessionId: "host-session",
      generation: 4,
      capabilityHandle: "A".repeat(43),
    },
    operations: ["fs.read", "fs.stat"],
    limits: { ...hostSession.limits },
  };
  const request = openRequest(cwd, model, "host-session");
  request.generation = 4;
  request.hostInstanceId = "host-runtime";
  request.hostToolAdapter = descriptor;
  const adapter = await factory.open(request);
  assert.equal(registryCalls.length, 1);
  assert.deepEqual(registryCalls[0], { descriptor, options: { cwd } });
  assert.equal(captures[0].noTools, "builtin");
  assert.deepEqual(captures[0].tools, ["fs_read", "fs_stat"]);
  assert.deepEqual(captures[0].customTools.map((tool) => tool.name), ["fs_read", "fs_stat"]);
  assert.deepEqual(captures[0].resourceLoader.getExtensions().extensions, []);
  const read = captures[0].customTools[0];
  const readResult = await read.execute(
    "host-tool-call",
    { path: "file.txt" },
    new AbortController().signal,
    undefined,
    { cwd },
  );
  assert.equal(readResult.content[0].text, "adapter content");
  assert.deepEqual(invocations[0].operation, "fs.read");
  assert.deepEqual(invocations[0].payload, { path: "file.txt" });
  assert.match(invocations[0].options.idempotencyKey, /^tool-[a-f0-9]{64}$/);
  await adapter.dispose();
  assert.equal(disposed, 1);

  const missingHost = openRequest(cwd, model, "host-session");
  missingHost.generation = 4;
  missingHost.hostToolAdapter = descriptor;
  await assert.rejects(
    factory.open(missingHost),
    (error) => error instanceof PiAdapterError && error.code === "tool_adapter_binding_mismatch",
  );
  assert.equal(registryCalls.length, 1);
});

test("configured factory applies scoped model auth, settings, resources, and tool environment", async () => {
  const stateDir = await temporaryDirectory();
  const agentDir = await temporaryDirectory();
  const scopedAgentDir = await temporaryDirectory();
  const cwd = await temporaryDirectory();
  const extensionPath = join(cwd, "safe-extension.ts");
  await writeFile(extensionPath, "export default function () {}\n");

  const seedRegistry = ModelRegistry.inMemory(AuthStorage.inMemory());
  const model = seedRegistry.getAll().find((candidate) => candidate.provider === "openai");
  assert.ok(model, "Pi built-in registry must expose an OpenAI model");
  const authStorage = AuthStorage.inMemory({
    [model.provider]: { type: "api_key", key: "shared-key" },
  });
  const modelRegistry = ModelRegistry.inMemory(authStorage);
  const previous = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  const captures = [];
  const factory = new PiSessionFactory({
    stateDir,
    agentDir,
    allowedRoots: [cwd],
    authStorage,
    modelRegistry,
    async createSession(options) {
      captures.push(options);
      return {
        session: new FakePiSession("configured-sdk", options.model, options.sessionManager),
        extensionsResult: options.resourceLoader.getExtensions(),
      };
    },
  });
  const prepared = parseSessionConfiguration({
    cwd,
    agentDir: scopedAgentDir,
    target: { mode: "memory" },
    model: { provider: model.provider, id: model.id, thinkingLevel: "high" },
    tools: { mode: "allowlist", include: ["read", "bash"], exclude: ["write"] },
    resources: {
      extensions: [extensionPath],
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      projectTrust: "approve",
      systemPrompt: "Configured system prompt.",
      appendSystemPrompt: ["Configured appendix."],
      extensionFlags: { fixture: true },
    },
    settings: { retry: { enabled: false, maxRetries: 1 } },
    env: { OPENAI_API_KEY: "session-key", SESSION_MARKER: "configured" },
    isolation: { mode: "unisolated" },
  });

  const adapter = await factory.open({
    sessionId: "configured",
    generation: 1,
    ...prepared.openRequest,
  });
  try {
    assert.equal(captures.length, 1);
    const options = captures[0];
    assert.equal(options.agentDir, scopedAgentDir);
    assert.notEqual(options.authStorage, authStorage);
    assert.equal(await options.authStorage.getApiKey(model.provider), "session-key");
    assert.equal(await authStorage.getApiKey(model.provider), "shared-key");
    assert.equal(options.model.provider, model.provider);
    assert.equal(options.model.id, model.id);
    assert.equal(options.thinkingLevel, "high");
    assert.deepEqual(options.tools, ["read", "bash"]);
    assert.deepEqual(options.excludeTools, ["write"]);
    const bashTool = options.customTools.find((tool) => tool.name === "bash");
    assert.ok(bashTool);
    const bashResult = await bashTool.execute(
      "configured-bash",
      { command: 'printf %s "$SESSION_MARKER"' },
      new AbortController().signal,
      undefined,
      { cwd },
    );
    assert.equal(bashResult.content[0].text, "configured");
    assert.equal(options.settingsManager.getGlobalSettings().retry.enabled, false);
    assert.equal(options.resourceLoader.getSystemPrompt(), "Configured system prompt.");
    assert.deepEqual(options.resourceLoader.getAppendSystemPrompt(), ["Configured appendix."]);
    assert.deepEqual(options.resourceLoader.getExtensions().errors, []);
    assert.equal(options.resourceLoader.getExtensions().extensions.length, 1);
    assert.equal(process.env.OPENAI_API_KEY, undefined);
    assert.equal((await adapter.rpcController()).capabilities.policy.bash, true);

    const autoExtensions = join(cwd, ".pi", "extensions");
    await mkdir(autoExtensions, { recursive: true });
    await writeFile(join(autoExtensions, "ambient.ts"), "export default function () {}\n");
    await writeFile(join(cwd, "AGENTS.md"), "ambient context must not load\n");
    const denied = parseSessionConfiguration({
      cwd,
      agentDir: scopedAgentDir,
      target: { mode: "memory" },
      model: { provider: model.provider, id: model.id },
      tools: { mode: "none" },
      env: {
        OPENAI_API_KEY: "session-key",
        SESSION_MARKER: "must-not-enable-bash",
      },
    });
    const deniedAdapter = await factory.open({
      sessionId: "configured-denied-discovery",
      generation: 1,
      ...denied.openRequest,
    });
    try {
      const deniedOptions = captures[1];
      assert.deepEqual(deniedOptions.resourceLoader.getExtensions().extensions, []);
      assert.deepEqual(deniedOptions.resourceLoader.getAgentsFiles(), { agentsFiles: [] });
      assert.equal(deniedOptions.noTools, "all");
      assert.deepEqual(deniedOptions.customTools, []);
      assert.equal((await deniedAdapter.rpcController()).capabilities.policy.bash, false);
    } finally {
      await deniedAdapter.dispose();
    }
  } finally {
    await adapter.dispose();
    if (previous === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previous;
  }
});

test("adapter maps Pi events, prompt result, queue controls, abort, and preflight rejection", async () => {
  const { model } = modelHarness();
  const sessionRoot = await temporaryDirectory();
  const session = new FakePiSession("sdk-a", model);
  const adapter = await adapterForFakeRuntime(new FakePiRuntime(session), sessionRoot);
  const events = [];
  const result = await adapter.prompt({
    requestId: "request-1",
    idempotencyKey: "key-1",
    prompt: "hello",
    signal: new AbortController().signal,
    onEvent: (event) => events.push(event),
  });
  assert.equal(result.text, "answer:hello");
  assert.equal(session.bindings, 1);
  assert.equal(session.waits, 1);
  assert.deepEqual(
    events.map((event) => event.event),
    ["turnStart", "messageUpdate", "turnEnd", "entryAppended", "agentSettled"],
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
  await adapter.dispose();
});

test("factory permits only the canonical Pi sessions data subtree inside agentDir", async () => {
  const stateDir = await temporaryDirectory();
  const agentDir = await temporaryDirectory();
  const cwd = await temporaryDirectory();
  const sessionDir = join(agentDir, "sessions", "project");
  await mkdir(sessionDir, { recursive: true, mode: 0o700 });
  const { authStorage, modelRegistry, model } = modelHarness();
  const captures = [];
  const factory = new PiSessionFactory({
    stateDir,
    agentDir,
    allowedRoots: [cwd],
    authStorage,
    modelRegistry,
    async createSession(options) {
      captures.push(options);
      return {
        session: new FakePiSession("agent-sessions-root", options.model, options.sessionManager),
        extensionsResult: options.resourceLoader.getExtensions(),
      };
    },
  });
  const prepared = parseSessionConfiguration({
    cwd,
    target: { mode: "new", sessionDir },
    model: { provider: model.provider, id: model.id },
    tools: { mode: "none" },
  });
  const adapter = await factory.open({
    sessionId: "agent-sessions-root",
    generation: 1,
    ...prepared.openRequest,
  });
  try {
    assert.equal(captures[0].sessionManager.getSessionDir(), await realpath(sessionDir));
  } finally {
    await adapter.dispose();
  }

  const forbiddenDir = join(agentDir, "extensions", "sessions");
  const forbidden = parseSessionConfiguration({
    cwd,
    target: { mode: "new", sessionDir: forbiddenDir },
    model: { provider: model.provider, id: model.id },
    tools: { mode: "none" },
  });
  await assert.rejects(
    factory.open({
      sessionId: "forbidden-agent-subtree",
      generation: 1,
      ...forbidden.openRequest,
    }),
    (error) => error instanceof PiAdapterError && error.code === "authority_root_overlap",
  );
});

test("runtime replacement rebinds subscriptions and persists changed identity before returning", async () => {
  const sessionRoot = await temporaryDirectory();
  const { model } = modelHarness();
  const first = new FakePiSession("sdk-first", model);
  const second = new FakePiSession("sdk-second", model);
  const runtime = new FakePiRuntime(first, second);
  const adapter = await adapterForFakeRuntime(runtime, sessionRoot);
  const changed = [];
  adapter.setIdentityChangeHandler(async (identity) => changed.push(identity));

  assert.deepEqual(await adapter.newSession(), { cancelled: false });
  assert.equal(first.listeners.size, 0);
  assert.equal(second.listeners.size, 1);
  assert.equal(second.bindings, 1);
  assert.deepEqual(adapter.identity(), { sessionId: "sdk-second" });
  assert.deepEqual(changed, [{ sessionId: "sdk-second" }]);
  await adapter.dispose();
});

test("runtime replacement fails closed when durable identity persistence fails", async () => {
  const sessionRoot = await temporaryDirectory();
  const { model } = modelHarness();
  const runtime = new FakePiRuntime(
    new FakePiSession("sdk-first", model),
    new FakePiSession("sdk-second", model),
  );
  const adapter = await adapterForFakeRuntime(runtime, sessionRoot);
  adapter.setIdentityChangeHandler(async () => {
    throw new Error("identity store unavailable");
  });

  await assert.rejects(adapter.newSession(), /identity store unavailable/);
  assert.throws(
    () => adapter.identity(),
    (error) => error instanceof PiAdapterError && error.code === "session_invalidated",
  );
  await adapter.dispose();
});

test("factory refuses permissive default auth storage", async () => {
  const stateDir = await temporaryDirectory();
  const agentDir = await temporaryDirectory();
  const cwd = await temporaryDirectory();
  const authPath = join(agentDir, "auth.json");
  await writeFile(authPath, "{}\n");
  await chmod(authPath, 0o644);
  assert.throws(
    () => new PiSessionFactory({ stateDir, agentDir, allowedRoots: [cwd] }),
    (error) => error instanceof PiAdapterError && error.code === "insecure_auth_path",
  );
});

test("factory refuses cwd authority overlap, out-of-root cwd, and external session paths", async () => {
  const allowedRoot = await temporaryDirectory();
  const outsideCwd = await temporaryDirectory();
  const agentDir = await temporaryDirectory();
  const { authStorage, modelRegistry, model } = modelHarness();

  const stateDir = join(allowedRoot, "state");
  await mkdir(stateDir, { mode: 0o700 });
  const overlapping = new PiSessionFactory({
    stateDir,
    agentDir,
    allowedRoots: [allowedRoot],
    authStorage,
    modelRegistry,
  });
  await assert.rejects(
    overlapping.open(openRequest(allowedRoot, model)),
    (error) => error instanceof PiAdapterError && error.code === "authority_root_overlap",
  );
  await assert.rejects(
    overlapping.open(openRequest(outsideCwd, model)),
    (error) => error instanceof PiAdapterError && error.code === "cwd_not_allowed",
  );

  const explicitlyOverlapping = new PiSessionFactory({
    stateDir,
    agentDir,
    allowedRoots: [allowedRoot],
    allowAuthorityRootOverlap: true,
    authStorage,
    modelRegistry,
  });
  const overlappingAdapter = await explicitlyOverlapping.open(
    openRequest(allowedRoot, model, "explicit-overlap-session"),
  );
  await overlappingAdapter.dispose();
  const persistedOverlapRequest = openRequest(allowedRoot, model, "persisted-overlap-source");
  persistedOverlapRequest.session = { mode: "new" };
  const persistedOverlap = await explicitlyOverlapping.open(persistedOverlapRequest);
  assert.equal(typeof persistedOverlap.identity().sessionFile, "string");
  await persistedOverlap.dispose();

  const safeState = await temporaryDirectory();
  const factory = new PiSessionFactory({
    stateDir: safeState,
    agentDir,
    allowedRoots: [allowedRoot],
    authStorage,
    modelRegistry,
  });
  const sourceRequest = openRequest(allowedRoot, model, "source-session");
  sourceRequest.session = { mode: "new" };
  const source = await factory.open(sourceRequest);
  const sourceIdentity = source.identity();
  const invalidImport = join(dirname(sourceIdentity.sessionFile), "invalid-cwd.jsonl");
  const invalidEntries = (await readFile(sourceIdentity.sessionFile, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  invalidEntries[0].cwd = outsideCwd;
  await writeFile(
    invalidImport,
    `${invalidEntries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    { mode: 0o600 },
  );
  await assert.rejects(
    source.importFromJsonl(invalidImport),
    (error) => error instanceof PiAdapterError && error.code === "cwd_not_allowed",
  );
  assert.deepEqual(source.identity(), sourceIdentity);

  const siblingRequest = openRequest(allowedRoot, model, "sibling-session");
  siblingRequest.session = { mode: "open", path: source.identity().sessionFile };
  await assert.rejects(
    factory.open(siblingRequest),
    (error) => error instanceof PiAdapterError && error.code === "session_path_outside_state",
  );
  await source.dispose();

  const outsideSession = join(outsideCwd, "session.jsonl");
  await writeFile(outsideSession, "{}\n");
  const request = openRequest(allowedRoot, model);
  request.session = { mode: "open", path: outsideSession };
  await assert.rejects(
    factory.open(request),
    (error) => error instanceof PiAdapterError && error.code === "session_path_outside_state",
  );
});

test("real Pi runtime new, switch, fork, and import preserve resolved conversation identity", async () => {
  const stateDir = await temporaryDirectory();
  const agentDir = await temporaryDirectory();
  const cwd = await temporaryDirectory();
  const { authStorage, modelRegistry, model } = modelHarness();
  const factory = new PiSessionFactory({
    stateDir,
    agentDir,
    allowedRoots: [cwd],
    authStorage,
    modelRegistry,
  });
  const request = openRequest(cwd, model);
  request.session = { mode: "new" };
  const adapter = await factory.open(request);
  const first = adapter.identity();
  assert.ok(first.sessionFile);
  assert.match(await readFile(first.sessionFile, "utf8"), new RegExp(first.sessionId));
  const changed = [];
  adapter.setIdentityChangeHandler(async (identity) => changed.push(identity));

  assert.deepEqual(await adapter.newSession(), { cancelled: false });
  const second = adapter.identity();
  assert.notEqual(second.sessionId, first.sessionId);
  assert.notEqual(second.sessionFile, first.sessionFile);
  assert.deepEqual(changed.at(-1), second);

  assert.deepEqual(await adapter.switchSession(first.sessionFile), { cancelled: false });
  assert.deepEqual(adapter.identity(), first);
  assert.deepEqual(changed.at(-1), first);

  const entries = (await readFile(first.sessionFile, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const forkEntry = entries.findLast((entry) => entry.type !== "session");
  assert.ok(forkEntry);
  assert.equal((await adapter.fork(forkEntry.id, "at")).cancelled, false);
  const forked = adapter.identity();
  assert.notEqual(forked.sessionId, first.sessionId);
  assert.notEqual(forked.sessionFile, first.sessionFile);
  assert.deepEqual(changed.at(-1), forked);

  const importedFile = join(dirname(first.sessionFile), "imported-session.jsonl");
  await copyFile(first.sessionFile, importedFile);
  await chmod(importedFile, 0o600);
  assert.deepEqual(await adapter.importFromJsonl(importedFile), { cancelled: false });
  assert.deepEqual(adapter.identity(), {
    sessionId: first.sessionId,
    sessionFile: importedFile,
  });
  assert.deepEqual(changed.at(-1), adapter.identity());
  await adapter.dispose();
});

test("real Pi SDK accepts the configured bash override without a model turn", async () => {
  const stateDir = await temporaryDirectory();
  const agentDir = await temporaryDirectory();
  const cwd = await temporaryDirectory();
  const { authStorage, modelRegistry, model } = modelHarness();
  const sessions = [];
  const factory = new PiSessionFactory({
    stateDir,
    agentDir,
    allowedRoots: [cwd],
    authStorage,
    modelRegistry,
    async createSession(options) {
      const result = await createAgentSession(options);
      sessions.push(result.session);
      return result;
    },
  });
  const prepared = parseSessionConfiguration({
    cwd,
    target: { mode: "memory" },
    model: { provider: model.provider, id: model.id },
    tools: { mode: "allowlist", include: ["bash"] },
    resources: {
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPrompt: "Configured tool registration probe.",
    },
    env: { SESSION_MARKER: "real-sdk" },
  });
  const adapter = await factory.open({
    sessionId: "configured-real-sdk",
    generation: 1,
    ...prepared.openRequest,
  });
  assert.deepEqual(sessions[0].getActiveToolNames(), ["bash"]);
  const rpc = await adapter.rpcController();
  assert.equal(rpc.capabilities.policy.bash, true);
  const bash = await rpc.handle({
    type: "bash",
    command: 'printf %s "$SESSION_MARKER"',
  });
  assert.equal(bash.success, true);
  assert.equal(bash.data.output, "real-sdk");
  await adapter.dispose();
});

test("real Pi SDK activates only host-adapter custom tools without a model turn", async () => {
  const stateDir = await temporaryDirectory();
  const agentDir = await temporaryDirectory();
  const cwd = await temporaryDirectory();
  const { authStorage, modelRegistry, model } = modelHarness();
  let disposed = 0;
  const hostSession = {
    operations: ["fs.read", "fs.write"],
    limits: {
      maxRequestBytes: 4096,
      maxResponseBytes: 4096,
      maxConcurrentRequests: 2,
      maxQueuedRequests: 2,
      requestTimeoutMs: 1000,
      maxIdempotencyKeys: 32,
      idempotencyTtlMs: 10_000,
    },
    async normalizePath(path) { return path; },
    async invoke(operation) {
      return operation === "fs.read"
        ? { content: "fixture", bytesRead: 7, eof: true }
        : { created: true, bytesWritten: 7, digest: "a".repeat(64) };
    },
    async dispose() { disposed += 1; },
  };
  const factory = new PiSessionFactory({
    stateDir,
    agentDir,
    allowedRoots: [cwd],
    authStorage,
    modelRegistry,
    hostToolAdapters: { async open() { return hostSession; } },
  });
  const request = openRequest(cwd, model, "real-host-tools");
  request.generation = 2;
  request.hostInstanceId = "host-real";
  request.hostToolAdapter = {
    protocolVersion: "1.0",
    adapterId: "fixture-adapter",
    adapterVersion: "1.0.0",
    endpoint: { transport: "unix", path: join(stateDir, "adapter.sock") },
    binding: {
      hostInstanceId: "host-real",
      sessionId: "real-host-tools",
      generation: 2,
      capabilityHandle: "A".repeat(43),
    },
    operations: ["fs.read", "fs.write"],
    limits: { ...hostSession.limits },
  };
  const adapter = await factory.open(request);
  assert.deepEqual(adapter.rpcSession().getActiveToolNames(), ["fs_read", "fs_write"]);
  assert.equal((await adapter.rpcController()).capabilities.policy.bash, false);
  await adapter.dispose();
  assert.equal(disposed, 1);
});

test("readiness caches redacted auth errors without exposing private paths", async () => {
  const stateDir = await temporaryDirectory();
  const agentDir = await temporaryDirectory();
  const cwd = await temporaryDirectory();
  const { authStorage, modelRegistry } = modelHarness();
  let firstDrain = true;
  authStorage.drainErrors = () => {
    if (!firstDrain) return [];
    firstDrain = false;
    const error = new Error(`${agentDir}/auth.json failed with secret-value`);
    error.code = "auth_load_failed";
    return [error];
  };
  const factory = new PiSessionFactory({
    stateDir,
    agentDir,
    allowedRoots: [cwd],
    authStorage,
    modelRegistry,
  });
  const first = factory.readiness();
  const second = factory.readiness();
  assert.deepEqual(first.authErrorCodes, ["auth_load_failed"]);
  assert.deepEqual(second.authErrorCodes, ["auth_load_failed"]);
  assert.equal(second.authErrorCount, 1);
  assert.equal(JSON.stringify(second).includes(agentDir), false);
  assert.equal(JSON.stringify(second).includes("secret-value"), false);
});

test("real Pi SDK opens an isolated no-tools in-memory session without a model turn", async () => {
  const stateDir = await temporaryDirectory();
  const agentDir = await temporaryDirectory();
  const cwd = await temporaryDirectory();
  const { authStorage, modelRegistry, model } = modelHarness();
  const factory = new PiSessionFactory({
    stateDir,
    agentDir,
    allowedRoots: [cwd],
    authStorage,
    modelRegistry,
  });
  const adapter = await factory.open(openRequest(cwd, model));
  const controller = await adapter.rpcController();
  assert.equal(await adapter.rpcController(), controller);
  const state = await controller.handle({ type: "get_state" });
  assert.equal(state.success, true);
  assert.equal(state.data.sessionId, adapter.identity().sessionId);
  await adapter.dispose();
  const readiness = factory.readiness();
  assert.equal(readiness.ready, true);
  assert.ok(readiness.availableModels > 0);
  assert.ok(readiness.authenticatedModels > 0);
  assert.equal(readiness.authErrorCount, 0);
  assert.deepEqual(readiness.authErrorCodes, []);
  assert.equal("agentDir" in readiness, false);
});
