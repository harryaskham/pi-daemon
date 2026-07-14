import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  PI_RPC_HOST_CAPABILITIES,
  PiRpcController,
} from "../dist/pi-rpc-controller.js";
import { PI_RPC_COMMAND_TYPES } from "../dist/session-api.js";

const entryOne = {
  type: "message",
  id: "entry-1",
  parentId: null,
  timestamp: "2026-07-14T00:00:00.000Z",
  message: { role: "user", content: "hello", timestamp: 1 },
};
const entryTwo = {
  type: "message",
  id: "entry-2",
  parentId: "entry-1",
  timestamp: "2026-07-14T00:00:01.000Z",
  message: {
    role: "assistant",
    content: [{ type: "text", text: "answer" }],
    api: "test",
    provider: "test-provider",
    model: "test-model",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 2,
  },
};

class FakeRpcSession {
  model = { provider: "test-provider", id: "test-model", name: "Test Model" };
  thinkingLevel = "off";
  isStreaming = false;
  isCompacting = false;
  steeringMode = "one-at-a-time";
  followUpMode = "one-at-a-time";
  sessionFile = "/state/session.jsonl";
  sessionId = "pi-session";
  sessionName = undefined;
  autoCompactionEnabled = true;
  pendingMessageCount = 0;
  messages = [entryOne.message, entryTwo.message];
  promptTemplates = [
    {
      name: "fix",
      description: "Fix it",
      sourceInfo: { source: "path", path: "/prompts/fix.md" },
    },
  ];
  calls = [];
  promptCompletion;
  #finishPrompt;

  constructor() {
    this.promptCompletion = new Promise((resolve) => {
      this.#finishPrompt = resolve;
    });
    this.modelRegistry = {
      getAvailable: async () => [
        this.model,
        { provider: "other", id: "other-model", name: "Other" },
      ],
    };
    this.sessionManager = {
      getLeafId: () => "entry-2",
      getEntries: () => [entryOne, entryTwo],
      getTree: () => [{ entry: entryOne, children: [{ entry: entryTwo, children: [] }] }],
    };
    this.extensionRunner = {
      getRegisteredCommands: () => [
        {
          invocationName: "extension-command",
          description: "From extension",
          sourceInfo: { source: "path", path: "/extensions/test.ts" },
        },
      ],
    };
    this.resourceLoader = {
      getSkills: () => ({
        skills: [
          {
            name: "review",
            description: "Review",
            sourceInfo: { source: "path", path: "/skills/review/SKILL.md" },
          },
        ],
      }),
    };
  }

  finishPrompt() {
    this.#finishPrompt();
  }

  async prompt(message, options) {
    this.calls.push(["prompt", message, options]);
    options.preflightResult?.(true);
    await this.promptCompletion;
  }

  async steer(message, images) {
    this.calls.push(["steer", message, images]);
  }
  async followUp(message, images) {
    this.calls.push(["follow_up", message, images]);
  }
  async abort() {
    this.calls.push(["abort"]);
  }
  async setModel(model) {
    this.model = model;
  }
  async cycleModel() {
    return { model: this.model, thinkingLevel: this.thinkingLevel, isScoped: false };
  }
  setThinkingLevel(level) {
    this.thinkingLevel = level;
  }
  cycleThinkingLevel() {
    this.thinkingLevel = "max";
    return "max";
  }
  setSteeringMode(mode) {
    this.steeringMode = mode;
  }
  setFollowUpMode(mode) {
    this.followUpMode = mode;
  }
  async compact(customInstructions) {
    return {
      summary: customInstructions ?? "summary",
      firstKeptEntryId: "entry-1",
      tokensBefore: 10,
      estimatedTokensAfter: 5,
    };
  }
  setAutoCompactionEnabled(enabled) {
    this.autoCompactionEnabled = enabled;
  }
  setAutoRetryEnabled(enabled) {
    this.autoRetryEnabled = enabled;
  }
  abortRetry() {
    this.retryAborted = true;
  }
  abortBash() {
    this.bashAborted = true;
  }
  getSessionStats() {
    return { sessionId: this.sessionId, sessionFile: this.sessionFile, totalMessages: 2 };
  }
  getUserMessagesForForking() {
    return [{ entryId: "entry-1", text: "hello" }];
  }
  getLastAssistantText() {
    return "answer";
  }
  setSessionName(name) {
    this.sessionName = name;
  }
  async waitForIdle() {}
  async navigateTree() {
    return { cancelled: false };
  }
  async reload() {}
}

class FakeRpcHost {
  eventListeners = new Set();
  replacements = [];

  constructor(session = new FakeRpcSession()) {
    this.session = session;
  }

  rpcSession() {
    return this.session;
  }
  subscribeRpcEvents(listener) {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }
  async setRpcExtensionBindingsFactory(factory) {
    this.bindingsFactory = factory;
    this.bindings = factory();
  }
  emit(event) {
    for (const listener of this.eventListeners) listener(event);
  }
  async newSession(parentSession) {
    this.replacements.push(["new_session", parentSession]);
    this.bindings = this.bindingsFactory();
    return { cancelled: false };
  }
  async switchSession(sessionPath) {
    this.replacements.push(["switch_session", sessionPath]);
    this.bindings = this.bindingsFactory();
    return { cancelled: false };
  }
  async fork(entryId, position) {
    this.replacements.push(["fork", entryId, position]);
    this.bindings = this.bindingsFactory();
    return { cancelled: false, selectedText: position === "before" ? "hello" : undefined };
  }
  async setRpcSessionName(name) {
    this.session.setSessionName(name);
  }
}

const commandFixtures = [
  { type: "prompt", message: "hello", images: [{ type: "image", data: "AA==", mimeType: "image/png" }] },
  { type: "steer", message: "steer" },
  { type: "follow_up", message: "follow" },
  { type: "abort" },
  { type: "new_session", parentSession: "/state/session.jsonl" },
  { type: "get_state" },
  { type: "set_model", provider: "other", modelId: "other-model" },
  { type: "cycle_model" },
  { type: "get_available_models" },
  { type: "set_thinking_level", level: "max" },
  { type: "cycle_thinking_level" },
  { type: "set_steering_mode", mode: "all" },
  { type: "set_follow_up_mode", mode: "all" },
  { type: "compact", customInstructions: "compact" },
  { type: "set_auto_compaction", enabled: false },
  { type: "set_auto_retry", enabled: false },
  { type: "abort_retry" },
  { type: "bash", command: "printf safe", excludeFromContext: true },
  { type: "abort_bash" },
  { type: "get_session_stats" },
  { type: "export_html", outputPath: "/state/export.html" },
  { type: "switch_session", sessionPath: "/state/session.jsonl" },
  { type: "fork", entryId: "entry-1" },
  { type: "clone" },
  { type: "get_fork_messages" },
  { type: "get_entries", since: "entry-1" },
  { type: "get_tree" },
  { type: "get_last_assistant_text" },
  { type: "set_session_name", name: "named" },
  { type: "get_messages" },
  { type: "get_commands" },
];

test("controller conforms to every pinned Pi RPC command without owning a process transport", async () => {
  const fixture = JSON.parse(
    await readFile(new URL("../fixtures/pi-rpc-conformance.json", import.meta.url), "utf8"),
  );
  assert.equal(fixture.sdkVersion, PI_RPC_HOST_CAPABILITIES.sdkVersion);
  assert.deepEqual(fixture.commands, commandFixtures);
  assert.deepEqual(fixture.policyGatedCommands, PI_RPC_HOST_CAPABILITIES.policyGatedCommands);
  assert.deepEqual(commandFixtures.map((command) => command.type), PI_RPC_COMMAND_TYPES);
  const host = new FakeRpcHost();
  const controller = await PiRpcController.create(host, {
    executeBash: async (_session, command, exclude) => ({
      output: command,
      exitCode: 0,
      cancelled: false,
      truncated: false,
      exclude,
    }),
    exportHtml: async (_session, outputPath) => outputPath ?? "/state/default.html",
  });

  assert.deepEqual(PI_RPC_HOST_CAPABILITIES.commandTypes, PI_RPC_COMMAND_TYPES);
  assert.deepEqual(controller.capabilities.policy, { bash: true, exportHtml: true });
  assert.equal(controller.snapshot().leafId, "entry-2");
  assert.equal(controller.snapshot().rpcState.sessionId, "pi-session");
  assert.equal(controller.capabilities.contract.processTransportOwned, false);
  for (let index = 0; index < commandFixtures.length; index += 1) {
    const command = { id: `rpc-${index}`, ...commandFixtures[index] };
    const response = await controller.handle(command);
    assert.equal(response.id, `rpc-${index}`);
    assert.equal(response.command, command.type);
    assert.equal(response.success, true, `${command.type}: ${response.error ?? ""}`);
  }
  host.session.finishPrompt();

  assert.deepEqual(host.replacements, [
    ["new_session", "/state/session.jsonl"],
    ["switch_session", "/state/session.jsonl"],
    ["fork", "entry-1", "before"],
    ["fork", "entry-2", "at"],
  ]);
  assert.equal(host.session.thinkingLevel, "max");
  assert.equal(host.session.sessionName, "named");
  assert.deepEqual(
    (await controller.handle({ type: "get_entries", since: "entry-1" })).data.entries,
    [entryTwo],
  );
  const commands = (await controller.handle({ type: "get_commands" })).data.commands;
  assert.deepEqual(commands.map((command) => command.source), ["extension", "prompt", "skill"]);
  controller.dispose();
});

test("prompt responds at preflight and raw session events remain transport neutral", async () => {
  const host = new FakeRpcHost();
  const controller = await PiRpcController.create(host, { maxOutputListeners: 2 });
  const outputs = [];
  controller.subscribe(() => {
    throw new Error("broken reader");
  });
  controller.subscribe((output) => outputs.push(output));
  assert.throws(() => controller.subscribe(() => {}), /listener capacity/);

  const response = await controller.handle({ id: "prompt-1", type: "prompt", message: "hello" });
  assert.equal(response.success, true);
  assert.equal(host.session.calls[0][0], "prompt");
  host.emit({ type: "agent_settled" });
  assert.deepEqual(outputs, [{ type: "agent_settled" }]);
  host.session.finishPrompt();
  controller.dispose();
});

test("extension UI requests are bounded, correlated, cancellable, and event-routed", async () => {
  const host = new FakeRpcHost();
  const controller = await PiRpcController.create(host, { maxPendingUiRequests: 1 });
  const outputs = [];
  controller.subscribe((output) => outputs.push(output));

  const selected = host.bindings.uiContext.select("Choose", ["a", "b"]);
  const request = outputs.at(-1);
  assert.equal(request.type, "extension_ui_request");
  assert.equal(request.method, "select");
  assert.equal(await host.bindings.uiContext.input("At capacity"), undefined);
  assert.equal(outputs.length, 1);
  assert.equal(controller.respondToExtensionUi({
    type: "extension_ui_response",
    id: request.id,
    value: "b",
  }), true);
  assert.equal(await selected, "b");
  assert.equal(controller.respondToExtensionUi({
    type: "extension_ui_response",
    id: request.id,
    cancelled: true,
  }), false);

  const confirmed = host.bindings.uiContext.confirm("Confirm", "Proceed?");
  const confirmRequest = outputs.at(-1);
  controller.respondToExtensionUi({
    type: "extension_ui_response",
    id: confirmRequest.id,
    confirmed: true,
  });
  assert.equal(await confirmed, true);

  const input = host.bindings.uiContext.input("Input", "value");
  const inputRequest = outputs.at(-1);
  controller.respondToExtensionUi({
    type: "extension_ui_response",
    id: inputRequest.id,
    value: "typed",
  });
  assert.equal(await input, "typed");

  const edited = host.bindings.uiContext.editor("Edit", "before");
  const editorRequest = outputs.at(-1);
  controller.respondToExtensionUi({
    type: "extension_ui_response",
    id: editorRequest.id,
    value: "after",
  });
  assert.equal(await edited, "after");

  host.bindings.uiContext.notify("notice", "info");
  host.bindings.uiContext.setStatus("status", "ready");
  host.bindings.uiContext.setWidget("widget", ["line"], { placement: "aboveEditor" });
  host.bindings.uiContext.setTitle("title");
  host.bindings.uiContext.setEditorText("text");
  assert.deepEqual(
    outputs.filter((output) => output.type === "extension_ui_request").map((output) => output.method),
    [
      "select",
      "confirm",
      "input",
      "editor",
      "notify",
      "setStatus",
      "setWidget",
      "setTitle",
      "set_editor_text",
    ],
  );
  host.bindings.onError({ extensionPath: "/extension.ts", event: "input", error: "failed" });
  assert.equal(outputs.at(-1).type, "extension_error");
  const cancelled = host.bindings.uiContext.input("Disconnect cancels", "value");
  controller.cancelPendingUi();
  assert.equal(await cancelled, undefined);
  controller.dispose();
});

test("malformed and unknown RPC commands fail as correlated responses before dispatch", async () => {
  const host = new FakeRpcHost();
  const controller = await PiRpcController.create(host);
  for (const command of [
    null,
    { id: "bad-1", type: "unknown" },
    { id: "bad-2", type: "prompt" },
    { id: "bad-3", type: "set_auto_retry", enabled: "yes" },
    { id: "bad-4", type: "set_thinking_level", level: "ultra" },
    { id: "bad-5", type: "prompt", message: "x", images: new Array(33).fill({}) },
  ]) {
    const response = await controller.handle(command);
    assert.equal(response.success, false);
  }
  assert.equal(host.session.calls.length, 0);
  controller.dispose();
});

test("bash/export are policy-gated and errors redact bearer-like secrets", async () => {
  const host = new FakeRpcHost();
  const controller = await PiRpcController.create(host);
  assert.equal((await controller.handle({ type: "bash", command: "pwd" })).success, false);
  assert.equal((await controller.handle({ type: "abort_bash" })).success, false);
  assert.equal((await controller.handle({ type: "export_html" })).success, false);
  assert.equal(
    (await controller.handle({ type: "set_model", provider: "missing", modelId: "missing" })).success,
    false,
  );
  assert.equal((await controller.handle({ type: "set_session_name", name: "  " })).success, false);
  assert.equal((await controller.handle({ type: "get_entries", since: "missing" })).success, false);

  host.session.compact = async () => {
    throw new Error('Bearer secret-token {"apiKey":"private","token":"ghp_abcdefghijk"}');
  };
  const failed = await controller.handle({ type: "compact" });
  assert.equal(failed.success, false);
  assert.equal(failed.error.includes("secret-token"), false);
  assert.equal(failed.error.includes("private"), false);
  controller.dispose();
});
