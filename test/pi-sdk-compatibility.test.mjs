import assert from "node:assert/strict";
import { inMemoryCredentials, modelHarness } from "./model-harness.mjs";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import * as piSdk from "@earendil-works/pi-coding-agent";
import {
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

test("pinned Pi SDK exposes the reviewed RPC and session-event contracts", async () => {
  const fixture = await json("fixtures/pi-rpc-command-types.json");
  assert.equal(PI_SDK_COMPATIBILITY_VERSION, "0.82.1");
  assert.equal(fixture.sdkVersion, PI_SDK_COMPATIBILITY_VERSION);
  assert.deepEqual(PI_RPC_COMMAND_TYPES, fixture.commandTypes);
  assert.equal(PI_RPC_COMMAND_TYPES.length, 32);
  assert.ok(PI_SESSION_EVENT_TYPES.includes("agent_settled"));
  assert.ok(PI_SESSION_EVENT_TYPES.includes("entry_appended"));
});

test("Pi AgentSessionRuntime replaces an in-memory session and rebinds the host", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "pi-daemon-sdk-contract-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cwd = join(directory, "work");
  const agentDir = join(directory, "agent");
  await Promise.all([mkdir(cwd), mkdir(agentDir)]);

  const { credentials, modelRuntime, model } = await modelHarness();
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false },
  });
  const createRuntime = async ({ cwd: runtimeCwd, sessionManager, sessionStartEvent }) => {
    const services = await createAgentSessionServices({
      cwd: runtimeCwd,
      agentDir,
      credentials,
      modelRuntime,
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
    [
      "Pi's exported surface drifted: the package root now exports getDefaultSessionDir.",
      "Do not simply flip PI_SDK_EXPORTS_DEFAULT_SESSION_DIR — that turns this green and leaves the",
      "question unasked. Decide which helper upstream exports:",
      "  - if it still calls mkdirSync, keep the side-effect-free reproduction in src/pi-sdk-contract.ts",
      "    and use the export only as a conformance oracle here, because the daemon creates every",
      "    session directory owner-private with repair and cannot use a creating helper;",
      "  - if it is a path-only variant, consume it and delete the reproduction.",
      "Then set the constant to match what you decided.",
    ].join("\n"),
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

test("no root override pretends to replace a package the SDK's shrinkwrap owns", async () => {
  // A shipped npm-shrinkwrap.json is authoritative for its own subtree, so a
  // root `overrides` entry naming a package inside it does not change what
  // `npm ci` installs. What it does change is what `npm audit` reports: the
  // metadata goes green while the vulnerable nested copy is still installed.
  // That was attempted once for brace-expansion and reverted (bd-36428f,
  // bd-6b1900); this is the guard against a third attempt, because the failure
  // is invisible in exactly the direction that matters.
  const manifest = await json("package.json");
  const overrides = manifest.overrides ?? {};
  const shrinkwrapPath = new URL(
    "node_modules/@earendil-works/pi-coding-agent/npm-shrinkwrap.json",
    root,
  );
  const shrinkwrap = JSON.parse(await readFile(shrinkwrapPath, "utf8"));
  const owned = new Set(
    Object.keys(shrinkwrap.packages ?? {})
      .map((path) => path.split("node_modules/").pop())
      .filter((name) => name !== undefined && name !== ""),
  );
  const pretending = Object.keys(overrides).filter((name) => owned.has(name));
  assert.deepEqual(
    pretending,
    [],
    "these overrides cannot take effect and will make npm audit report green while npm ci still " +
      `installs the SDK's pinned copy: ${pretending.join(", ")}. The fix is upstream shrinkwrap ` +
      "regeneration, not a root override.",
  );
  // The guard is only meaningful if the shrinkwrap it reads is populated.
  assert.ok(owned.size > 50, `expected the SDK's shrinkwrap to name packages, found ${owned.size}`);
  assert.ok(owned.has("brace-expansion"), "brace-expansion is the case this guard exists for");
});

test("Pi npm shrinkwrap dependencies retain integrity for Nix prefetch", async () => {
  const lock = await json("package-lock.json");
  assert.equal(
    lock.packages["node_modules/@earendil-works/pi-coding-agent"].version,
    PI_SDK_COMPATIBILITY_VERSION,
  );
  // Select the population, then assert the fields. Selecting on `resolved` and
  // then asserting `integrity` would exempt exactly the entries missing both,
  // which is the shape a regenerated lock produced during the 0.82.1 migration:
  // workspace packages recorded with neither, passing this guard and failing
  // inside `nix build` as ENOTCACHED. A guard whose selector is derived from
  // the field it validates cannot see that field's absence.
  const installed = Object.entries(lock.packages).filter(
    ([path, entry]) =>
      // Installed packages live under a node_modules path; the project root and
      // workspace roots are local and legitimately carry neither field. This
      // selects on location and structural flags only, never on either field
      // being asserted below.
      (path.startsWith("node_modules/") || path.includes("/node_modules/")) &&
      entry.link !== true &&
      entry.inBundle !== true,
  );
  assert.ok(installed.length > 100, "lockfile inventory looks implausibly small");
  const unfetchable = installed
    .filter(
      ([, entry]) =>
        typeof entry.resolved !== "string" || typeof entry.integrity !== "string",
    )
    .map(([path, entry]) => ({
      path,
      resolved: typeof entry.resolved === "string",
      integrity: typeof entry.integrity === "string",
    }));
  assert.deepEqual(unfetchable, []);
  // Anything the prefetcher must fetch has to come from the public registry;
  // a mirror-rewritten URL is a separate failure with its own guard.
  const nonRegistry = installed
    .filter(([, entry]) => !entry.resolved.startsWith("https://registry.npmjs.org/"))
    .map(([path]) => path);
  assert.deepEqual(nonRegistry, []);
});

test("the prefetch guard rejects an entry missing both fields, not only integrity", async () => {
  // Negative control for the population selector. The predicate is inlined
  // rather than imported because the guard above reads a checked-in artifact;
  // this asserts the selector's behaviour on a mutated copy of that artifact,
  // so it fails if the selector is ever narrowed back onto `resolved`.
  const lock = await json("package-lock.json");
  const unfetchable = (packages) =>
    Object.entries(packages)
      .filter(
        ([path, entry]) =>
          (path.startsWith("node_modules/") || path.includes("/node_modules/")) &&
          entry.link !== true &&
          entry.inBundle !== true,
      )
      .filter(
        ([, entry]) =>
          typeof entry.resolved !== "string" || typeof entry.integrity !== "string",
      )
      .map(([path]) => path);

  const victim = Object.keys(lock.packages).find(
    (path) =>
      path.includes("/node_modules/") &&
      typeof lock.packages[path].resolved === "string" &&
      typeof lock.packages[path].integrity === "string",
  );
  assert.ok(victim, "the lock must contain a fetched package to mutate");

  const withoutIntegrity = structuredClone(lock.packages);
  delete withoutIntegrity[victim].integrity;
  assert.deepEqual(unfetchable(withoutIntegrity), [victim]);

  // The shape the previous selector exempted: filtering on `resolved` and then
  // asserting `integrity` cannot see an entry that carries neither.
  const withoutBoth = structuredClone(lock.packages);
  delete withoutBoth[victim].resolved;
  delete withoutBoth[victim].integrity;
  assert.deepEqual(unfetchable(withoutBoth), [victim]);
});
