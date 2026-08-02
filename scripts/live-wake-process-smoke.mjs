#!/usr/bin/env node
// Opt-in acceptance for the last piece of PLAN.md "End-to-end consumer": wake a
// logical session on a daemon running as a separate process, and prove no new
// process appears, measured from the process table rather than by instrumenting
// the module.
//
// scripts/live-sdk-smoke.mjs already proves zero child-process calls, but it
// does so in-process by patching node:child_process, which cannot see a process
// the daemon's own runtime creates by another route. The consumer acceptance in
// test/acceptance/consumer-acceptance.test.mjs measures the real process tree, but stops
// at open because a wake needs credentials. This joins the two halves.
//
// Requires a provider credential and is therefore never part of the
// credential-free gate. Run it deliberately:
//
//   npm run test:live:wake
//
// It performs one minimal real turn.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { PiDaemonClient } from "../dist/client.js";
import { countDescendants } from "../test/consumer-acceptance.mjs";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(process.env.HOME ?? "", ".pi", "agent");
const provider = process.env.PI_DAEMON_LIVE_PROVIDER ?? "github-copilot";
const model = process.env.PI_DAEMON_LIVE_MODEL ?? "gpt-5-mini";
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForSocket(path, child) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`daemon exited before listening: ${child.exitCode}`);
    try {
      if ((await stat(path)).isSocket()) return;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    await delay(20);
  }
  throw new Error("daemon did not create its socket in time");
}

const root = await mkdtemp(join(tmpdir(), "pi-daemon-live-wake-"));
const work = join(root, "work");
await mkdir(work, { mode: 0o700 });
const socketPath = join(root, "run", "pi-daemon.sock");

let child;
let client;
try {
  child = spawn(
    process.execPath,
    [
      "dist/cli.js",
      "serve",
      "--socket",
      socketPath,
      "--state-dir",
      join(root, "state"),
      "--agent-dir",
      agentDir,
      "--allow-root",
      work,
      "--api-port",
      "0",
    ],
    {
      cwd: repositoryRoot,
      env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  // Deliberately not accumulated or printed: daemon output can carry prompt and
  // model material, and this script exists to report a process count.
  child.stdout.resume();
  child.stderr.resume();

  await waitForSocket(socketPath, child);
  client = await PiDaemonClient.connect({ socketPath });
  const events = [];
  client.subscribe((event) => events.push(event?.event ?? "unknown"));
  await client.handshake("live-wake-process-smoke");

  const openSession = async (sessionId) => {
    const opened = await client.request({
      protocolVersion: "1.0",
      requestId: `open-${sessionId}`,
      operation: "open",
      sessionId,
      generation: 1,
      payload: {
        cwd: work,
        session: { mode: "new" },
        model: { provider, id: model },
        resources: {
          extensions: "none",
          skills: "none",
          promptTemplates: "none",
          themes: "none",
          contextFiles: "none",
          tools: "none",
        },
      },
    });
    assert.equal(opened.ok, true, `open ${sessionId}: ${JSON.stringify(opened.error ?? {})}`);
  };

  const wake = async (sessionId, turn) => {
    const woke = await client.request({
      protocolVersion: "1.0",
      requestId: `wake-${sessionId}-${turn}`,
      operation: "wake",
      sessionId,
      generation: 1,
      idempotencyKey: `live-wake-process-smoke-${sessionId}-${turn}`,
      payload: { prompt: "Reply with only: pong", source: "acceptance" },
    });
    assert.equal(woke.ok, true, `wake ${sessionId} #${turn}: ${JSON.stringify(woke.error ?? {})}`);
  };

  // Event delivery is explicit: subscribing registers a local listener and
  // nothing else, so a consumer that opens and wakes without attaching is
  // silent, and that silence is indistinguishable from a model that produced
  // no output (bd-c4314e). Attach, then assert events actually arrive during
  // the real turns below — the credential-free acceptance can exercise the
  // attach call but cannot produce the traffic.
  const attach = async (sessionId) => {
    const attached = await client.request({
      protocolVersion: "1.0",
      requestId: `attach-${sessionId}`,
      operation: "attach",
      sessionId,
      generation: 1,
      payload: {},
    });
    assert.equal(attached.ok, true, `attach ${sessionId}: ${JSON.stringify(attached.error ?? {})}`);
  };

  await openSession("live-wake-a");
  await attach("live-wake-a");

  const beforeWake = await countDescendants(child.pid);
  assert.notEqual(beforeWake, null, "this acceptance needs /proc to measure the daemon's process tree");

  // Several turns, then a second session. One turn cannot tell "no process per
  // wake" from "no process after the first wake": lazy provider initialisation,
  // a connection pool, or a worker started on first use would each show an
  // unchanged count across a single turn and never grow again. PLAN.md claims
  // the per-wake property, so the measurement has to be able to fail that way.
  // The launch is the expensive part, so the extra turns cost little.
  const observations = [{ label: "after open", count: beforeWake }];
  for (const turn of [1, 2, 3]) {
    await wake("live-wake-a", turn);
    observations.push({ label: `after turn ${turn}`, count: await countDescendants(child.pid) });
  }
  await openSession("live-wake-b");
  await attach("live-wake-b");
  await wake("live-wake-b", 1);
  observations.push({ label: "after a turn on a second session", count: await countDescendants(child.pid) });

  assert.ok(
    events.length > 0,
    "no events arrived across four real turns on two attached sessions: a consumer " +
      "following this sequence would be silent, and silence looks identical to a model " +
      "that produced no output",
  );

  for (const observation of observations) {
    assert.equal(
      observation.count,
      beforeWake,
      `${observation.label}: the daemon's process tree moved from ${beforeWake} to ${observation.count}. ` +
        "Measured from the process table rather than by patching child_process, so this catches a " +
        "process created by any route inside the runtime.",
    );
  }
  const afterWake = observations[observations.length - 1].count;

  for (const sessionId of ["live-wake-a", "live-wake-b"]) {
    const closed = await client.request({
      protocolVersion: "1.0",
      requestId: `close-${sessionId}`,
      operation: "close",
      sessionId,
      generation: 1,
      payload: {},
    });
    assert.equal(closed.ok, true, `close ${sessionId}: ${JSON.stringify(closed.error ?? {})}`);
  }

  // The count is legitimately non-zero: the packaged wrapper execs node, so a
  // served daemon has a descendant. Unchanged is the invariant, not empty; a
  // future reader tempted to assert zero would be asserting something false
  // about a healthy deployment.
  process.stdout.write(
    `live wake smoke: descendants steady at ${beforeWake} across ` +
      `${observations.length - 1} real ${provider} turns over two sessions, ` +
      `${events.length} events delivered\n`,
  );
} finally {
  client?.close();
  if (child !== undefined && child.exitCode === null) {
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGTERM");
    await Promise.race([exited, delay(15_000)]);
    if (child.exitCode === null) child.kill("SIGKILL");
  }
  await rm(root, { recursive: true, force: true });
}
