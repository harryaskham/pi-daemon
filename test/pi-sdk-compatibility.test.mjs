import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  AuthStorage,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
} from "@earendil-works/pi-coding-agent";

import {
  PI_SDK_COMPATIBILITY_VERSION,
  PI_SESSION_EVENT_TYPES,
} from "../dist/pi-sdk-contract.js";
import { PI_RPC_COMMAND_TYPES } from "../dist/session-api.js";

const root = new URL("../", import.meta.url);

const json = async (path) => JSON.parse(await readFile(new URL(path, root), "utf8"));

const modelHarness = () => {
  const seedRegistry = ModelRegistry.inMemory(AuthStorage.inMemory());
  const model = seedRegistry.getAll()[0];
  assert.ok(model, "Pi built-in model registry must not be empty");
  const authStorage = AuthStorage.inMemory({
    [model.provider]: { type: "api_key", key: "test-only-key" },
  });
  return { authStorage, modelRegistry: ModelRegistry.inMemory(authStorage), model };
};

test("pinned Pi SDK exposes the reviewed RPC and session-event contracts", async () => {
  const fixture = await json("fixtures/pi-rpc-command-types.json");
  assert.equal(PI_SDK_COMPATIBILITY_VERSION, "0.80.6");
  assert.equal(fixture.sdkVersion, PI_SDK_COMPATIBILITY_VERSION);
  assert.deepEqual(PI_RPC_COMMAND_TYPES, fixture.commandTypes);
  assert.equal(PI_RPC_COMMAND_TYPES.length, 31);
  assert.ok(PI_SESSION_EVENT_TYPES.includes("agent_settled"));
  assert.ok(PI_SESSION_EVENT_TYPES.includes("entry_appended"));
});

test("Pi AgentSessionRuntime replaces an in-memory session and rebinds the host", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "pi-daemon-sdk-contract-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cwd = join(directory, "work");
  const agentDir = join(directory, "agent");
  await Promise.all([mkdir(cwd), mkdir(agentDir)]);

  const { authStorage, modelRegistry, model } = modelHarness();
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false },
  });
  const createRuntime = async ({ cwd: runtimeCwd, sessionManager, sessionStartEvent }) => {
    const services = await createAgentSessionServices({
      cwd: runtimeCwd,
      agentDir,
      authStorage,
      modelRegistry,
      settingsManager,
      resourceLoaderOptions: {
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        systemPrompt: "Pi SDK compatibility probe.",
      },
    });
    return {
      ...(await createAgentSessionFromServices({
        services,
        sessionManager,
        sessionStartEvent,
        model,
        thinkingLevel: "off",
        noTools: "all",
        tools: [],
        customTools: [],
      })),
      services,
      diagnostics: services.diagnostics,
    };
  };

  const runtime = await createAgentSessionRuntime(createRuntime, {
    cwd,
    agentDir,
    sessionManager: SessionManager.inMemory(cwd),
  });
  t.after(() => runtime.dispose());

  const firstSession = runtime.session;
  const firstSessionId = firstSession.sessionId;
  const events = [];
  firstSession.subscribe((event) => events.push(event.type));
  firstSession.setSessionName("compatibility-probe");
  assert.ok(events.includes("session_info_changed"));
  assert.equal(firstSession.isIdle, true);
  await firstSession.waitForIdle();

  let reboundSession;
  runtime.setRebindSession(async (session) => {
    reboundSession = session;
  });
  assert.deepEqual(await runtime.newSession(), { cancelled: false });
  assert.notEqual(runtime.session, firstSession);
  assert.notEqual(runtime.session.sessionId, firstSessionId);
  assert.equal(reboundSession, runtime.session);
  assert.equal(runtime.session.isIdle, true);
});

test("Pi npm shrinkwrap dependencies retain integrity for Nix prefetch", async () => {
  const lock = await json("package-lock.json");
  assert.equal(
    lock.packages["node_modules/@earendil-works/pi-coding-agent"].version,
    PI_SDK_COMPATIBILITY_VERSION,
  );
  const missing = Object.entries(lock.packages)
    .filter(([, entry]) => typeof entry.resolved === "string" && /^https?:/.test(entry.resolved))
    .filter(([, entry]) => typeof entry.integrity !== "string")
    .map(([path]) => path);
  assert.deepEqual(missing, []);
});
