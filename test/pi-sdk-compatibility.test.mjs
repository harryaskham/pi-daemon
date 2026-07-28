import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import * as piSdk from "@earendil-works/pi-coding-agent";
import {
  AuthStorage,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";

import {
  PI_SDK_COMPATIBILITY_VERSION,
  PI_SDK_EXPORTS_DEFAULT_SESSION_DIR,
  PI_SESSION_EVENT_TYPES,
  PI_SESSIONS_DIRECTORY_NAME,
  piDefaultSessionDirectory,
  piDefaultSessionDirectoryName,
  piSdkDefaultSessionDirHelper,
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

test("pinned Pi SDK derives the daemon's reproduced default session directory", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "pi-daemon-session-dir-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const agentDir = join(directory, "agent");
  await mkdir(agentDir, { recursive: true });

  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  });
  assert.equal(
    getAgentDir(),
    agentDir,
    "pinned Pi must keep resolving its agent directory from PI_CODING_AGENT_DIR",
  );

  const workingDirectories = [
    join(directory, "work"),
    join(directory, "work", "nested project"),
    join(directory, "dash-work.d"),
  ];
  for (const cwd of workingDirectories) {
    await mkdir(cwd, { recursive: true });
    // Stock Pi creates <agentDir>/sessions/--<encoded cwd>-- through its own
    // internal helper; the public constructor is the only supported probe.
    SessionManager.create(cwd);
    const derived = piDefaultSessionDirectory(cwd, agentDir);
    assert.equal(
      derived,
      join(agentDir, PI_SESSIONS_DIRECTORY_NAME, piDefaultSessionDirectoryName(cwd)),
      "the exported helpers must agree on one encoding",
    );
    assert.ok(existsSync(derived), `pinned Pi did not create ${derived}`);
  }

  const created = (await readdir(join(agentDir, PI_SESSIONS_DIRECTORY_NAME))).sort();
  assert.deepEqual(
    created,
    workingDirectories.map((cwd) => piDefaultSessionDirectoryName(cwd)).sort(),
    "pinned Pi created session directories the daemon reproduction does not name",
  );
  assert.ok(created.every((name) => name.startsWith("--") && name.endsWith("--")));
});

test("default session directory adoption tracks the pinned Pi export surface", async (t) => {
  const helper = piSdkDefaultSessionDirHelper(piSdk);
  assert.equal(
    helper !== undefined,
    PI_SDK_EXPORTS_DEFAULT_SESSION_DIR,
    "Pi's exported surface drifted: update PI_SDK_EXPORTS_DEFAULT_SESSION_DIR and consume the upstream helper in src/pi-sdk-contract.ts",
  );
  assert.equal(
    piSdkDefaultSessionDirHelper({ getDefaultSessionDir: (cwd) => `probe:${cwd}` })?.("/tmp/x"),
    "probe:/tmp/x",
    "the adoption seam must recognize an exported helper",
  );
  assert.equal(piSdkDefaultSessionDirHelper(undefined), undefined);
  assert.equal(piSdkDefaultSessionDirHelper({ getDefaultSessionDir: "not-callable" }), undefined);
  if (helper === undefined) return;

  const directory = await mkdtemp(join(tmpdir(), "pi-daemon-session-dir-export-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const agentDir = join(directory, "agent");
  const cwd = join(directory, "work");
  await Promise.all([mkdir(agentDir), mkdir(cwd)]);
  assert.equal(
    helper(cwd, agentDir),
    piDefaultSessionDirectory(cwd, agentDir),
    "the upstream helper disagrees with the daemon reproduction",
  );
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
