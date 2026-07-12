#!/usr/bin/env node
import childProcess from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
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
const socketPath = join(temporaryRoot, "pi-daemon.sock");
let server;
let multiplexer;
let firstClient;
let secondClient;
try {
  await mkdir(cwd, { mode: 0o700 });
  await mkdir(stateDir, { mode: 0o700 });
  const { AuthStorage, getAgentDir, ModelRegistry } = await import(
    "@earendil-works/pi-coding-agent"
  );
  const { PiDaemonClient } = await import("../dist/client.js");
  const { FileDurabilityStore } = await import("../dist/durability.js");
  const { Multiplexer } = await import("../dist/multiplexer.js");
  const { PiSessionFactory } = await import("../dist/pi-adapter.js");
  const { ProtocolServer } = await import("../dist/server.js");

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
  const durability = new FileDurabilityStore({ stateDir });
  multiplexer = new Multiplexer({
    factory,
    durability,
    limits: { maxConcurrentTurns: 2 },
  });
  await multiplexer.recover();
  server = new ProtocolServer({ socketPath, multiplexer });
  await server.start();
  [firstClient, secondClient] = await Promise.all([
    PiDaemonClient.connect({ socketPath }),
    PiDaemonClient.connect({ socketPath }),
  ]);

  const resources = {
    extensions: "none",
    skills: "none",
    promptTemplates: "none",
    themes: "none",
    contextFiles: "none",
    tools: "none",
    systemPrompt: "Follow the user instruction exactly. Return no extra text.",
  };
  const open = (client, sessionId) =>
    client.request({
      protocolVersion: "1.0",
      requestId: `open-${sessionId}`,
      operation: "open",
      sessionId,
      generation: 1,
      payload: {
        cwd,
        session: { mode: "memory" },
        model: { provider: model.provider, id: model.id, thinkingLevel: "off" },
        resources,
      },
    });

  const openedAt = performance.now();
  await Promise.all([open(firstClient, "live-a"), open(secondClient, "live-b")]);
  const openDurationMs = performance.now() - openedAt;
  const eventCounts = { a: 0, b: 0 };
  firstClient.subscribe(() => {
    eventCounts.a += 1;
  });
  secondClient.subscribe(() => {
    eventCounts.b += 1;
  });
  const prompt = (client, id, expected) =>
    client.request({
      protocolVersion: "1.0",
      requestId: `wake-${id}`,
      operation: "wake",
      sessionId: `live-${id}`,
      generation: 1,
      idempotencyKey: `live-${id}`,
      payload: { prompt: `Reply with only ${expected}`, source: "live-acceptance" },
    });
  const turnsAt = performance.now();
  const [a, b] = await Promise.all([
    prompt(firstClient, "a", "A"),
    prompt(secondClient, "b", "B"),
  ]);
  const turnDurationMs = performance.now() - turnsAt;
  const aText = a.data?.result?.text?.trim();
  const bText = b.data?.result?.text?.trim();
  if (aText !== "A" || bText !== "B") {
    throw new Error(`isolation result mismatch: a=${JSON.stringify(aText)} b=${JSON.stringify(bText)}`);
  }
  if (calls.length !== 0) throw new Error(`observed ${calls.length} child-process calls`);

  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        transport: "unix-ndjson",
        durableJournal: true,
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
  firstClient?.close();
  secondClient?.close();
  await server?.stop().catch(() => {});
  await multiplexer?.dispose(1_000).catch(() => {});
  for (const [name, original] of originals) childProcess[name] = original;
  syncBuiltinESMExports();
  await rm(temporaryRoot, { recursive: true, force: true });
}
