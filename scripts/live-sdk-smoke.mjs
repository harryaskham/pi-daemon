#!/usr/bin/env node
import childProcess from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

const patchedNames = ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"];
const originals = new Map();
const calls = [];
for (const name of patchedNames) {
  const original = childProcess[name];
  if (typeof original !== "function") continue;
  originals.set(name, original);
  childProcess[name] = (...args) => {
    calls.push({ name, argc: args.length, at: new Date().toISOString() });
    throw new Error(`child process creation is forbidden in the live no-tools smoke: ${name}`);
  };
}
syncBuiltinESMExports();

const temporaryRoot = await mkdtemp(join(tmpdir(), "pi-daemon-live-"));
const cwd = join(temporaryRoot, "work");
const stateDir = join(temporaryRoot, "state");
let first;
let second;
try {
  const { mkdir } = await import("node:fs/promises");
  await mkdir(cwd, { mode: 0o700 });
  await mkdir(stateDir, { mode: 0o700 });
  const { AuthStorage, getAgentDir, ModelRegistry } = await import(
    "@earendil-works/pi-coding-agent"
  );
  const { PiSessionFactory } = await import("../dist/pi-adapter.js");

  const agentDir = getAgentDir();
  const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
  const modelRegistry = ModelRegistry.create(authStorage, join(agentDir, "models.json"));
  const requested = process.env.PI_DAEMON_LIVE_MODEL;
  let model;
  if (requested !== undefined) {
    const slash = requested.indexOf("/");
    if (slash <= 0 || slash === requested.length - 1) {
      throw new Error("PI_DAEMON_LIVE_MODEL must be provider/model-id");
    }
    model = modelRegistry.find(requested.slice(0, slash), requested.slice(slash + 1));
    if (model === undefined) throw new Error(`model not found: ${requested}`);
    if (!modelRegistry.hasConfiguredAuth(model)) {
      throw new Error(`model authentication is unavailable: ${requested}`);
    }
  } else {
    model = modelRegistry.getAvailable()[0];
    if (model === undefined) {
      throw new Error("no authenticated Pi model is available; set PI_DAEMON_LIVE_MODEL");
    }
  }

  const factory = new PiSessionFactory({
    stateDir,
    agentDir,
    allowedRoots: [cwd],
    authStorage,
    modelRegistry,
  });
  const resources = {
    extensions: "none",
    skills: "none",
    promptTemplates: "none",
    themes: "none",
    contextFiles: "none",
    tools: "none",
    systemPrompt: "Follow the user instruction exactly. Return no extra text.",
  };
  const open = (sessionId) =>
    factory.open({
      sessionId,
      generation: 1,
      cwd,
      session: { mode: "memory" },
      model: { provider: model.provider, id: model.id, thinkingLevel: "off" },
      resources,
    });

  const openedAt = performance.now();
  [first, second] = await Promise.all([open("live-a"), open("live-b")]);
  const openDurationMs = performance.now() - openedAt;
  const eventCounts = { a: 0, b: 0 };
  const prompt = (adapter, id, expected) =>
    adapter.prompt({
      requestId: `live-${id}`,
      idempotencyKey: `live-${id}`,
      prompt: `Reply with only ${expected}`,
      signal: new AbortController().signal,
      onEvent: () => {
        eventCounts[id] += 1;
      },
    });
  const turnsAt = performance.now();
  const [a, b] = await Promise.all([prompt(first, "a", "A"), prompt(second, "b", "B")]);
  const turnDurationMs = performance.now() - turnsAt;
  const aText = a?.text?.trim();
  const bText = b?.text?.trim();
  if (aText !== "A" || bText !== "B") {
    throw new Error(`isolation result mismatch: a=${JSON.stringify(aText)} b=${JSON.stringify(bText)}`);
  }
  if (calls.length !== 0) throw new Error(`observed ${calls.length} child-process calls`);

  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        model: `${model.provider}/${model.id}`,
        node: process.version,
        sessions: 2,
        results: { a: aText, b: bText },
        eventCounts,
        childProcessCalls: calls,
        openDurationMs,
        concurrentTurnDurationMs: turnDurationMs,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  first?.dispose();
  second?.dispose();
  for (const [name, original] of originals) childProcess[name] = original;
  syncBuiltinESMExports();
  await rm(temporaryRoot, { recursive: true, force: true });
}
