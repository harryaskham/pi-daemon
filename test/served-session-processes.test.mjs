import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { PiDaemonClient } from "../dist/client.js";

const execFileAsync = promisify(execFile);
const repositoryRoot = new URL("..", import.meta.url);

/**
 * Descendant pids of `root`, from the OS process table.
 *
 * The in-process acceptance instruments `child_process` and forbids spawning,
 * which proves the code path does not spawn. It cannot prove anything about the
 * artefact a supervisor runs, because the daemon under test is constructed in
 * the test process. This reads the table instead, so a process created by any
 * route — a library, a shell-out, a re-exec — is counted.
 */
async function descendantPids(root) {
  const { stdout } = await execFileAsync("ps", ["-eo", "pid=,ppid="], { maxBuffer: 4 * 1024 * 1024 });
  const children = new Map();
  for (const line of stdout.split("\n")) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
    const siblings = children.get(ppid) ?? [];
    siblings.push(pid);
    children.set(ppid, siblings);
  }
  const found = [];
  const queue = [root];
  while (queue.length > 0) {
    for (const child of children.get(queue.shift()) ?? []) {
      found.push(child);
      queue.push(child);
    }
  }
  return found.sort((first, second) => first - second);
}

async function waitForSocket(socketPath, deadlineMs) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < deadlineMs) {
    try {
      return await PiDaemonClient.connect({ socketPath });
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(`daemon socket never accepted a connection: ${lastError?.message ?? "unknown"}`);
}

const openCommand = (sessionId, cwd) => ({
  protocolVersion: "1.0",
  requestId: `open-${sessionId}`,
  operation: "open",
  sessionId,
  generation: 1,
  payload: { cwd, session: { mode: "memory" } },
});

test(
  "a served daemon opens many logical sessions without creating a process",
  { timeout: 120_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "pi-daemon-served-sessions-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const work = join(root, "work");
    const seed = join(root, "seed");
    await Promise.all([mkdir(work, { mode: 0o700 }), mkdir(seed, { mode: 0o700 })]);
    await writeFile(
      join(seed, "auth.json"),
      `${JSON.stringify({ fixture: { type: "api_key", key: "served-session-fixture-key" } })}\n`,
      { mode: 0o600 },
    );

    const socketPath = join(root, "run", "pi-daemon.sock");
    const child = spawn(
      process.execPath,
      [
        "dist/cli.js",
        "serve",
        "--socket",
        socketPath,
        "--state-dir",
        join(root, "state"),
        "--agent-dir",
        join(root, "agent"),
        "--allow-root",
        work,
        "--api-port",
        "0",
      ],
      {
        cwd: repositoryRoot,
        env: { ...process.env, PI_CODING_AGENT_DIR: seed, PI_DAEMON_BEARER_TOKEN: undefined },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let diagnostics = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (diagnostics += chunk));
    child.stderr.on("data", (chunk) => (diagnostics += chunk));
    t.after(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    });

    const client = await waitForSocket(socketPath, 60_000);
    t.after(() => client.close());
    await client.handshake("served-session-process-acceptance");

    const before = await descendantPids(child.pid);

    const sessions = ["alpha", "beta", "gamma", "delta"];
    for (const sessionId of sessions) {
      const cwd = join(work, sessionId);
      await mkdir(cwd, { recursive: true, mode: 0o700 });
      const response = await client.request(openCommand(sessionId, cwd));
      // The envelope reports success as `ok`, not a status string. Asserting
      // the wrong field passed nothing and failed on a successful open, which
      // the diagnostic below is why I noticed rather than adjusted.
      assert.equal(response.ok, true, `opening ${sessionId} failed: ${JSON.stringify(response)}`);
      assert.equal(response.data?.session?.state, "idle");
    }

    const after = await descendantPids(child.pid);
    assert.deepEqual(
      after,
      before,
      `opening ${sessions.length} logical sessions created ${after.length - before.length} process(es). ` +
        "This is the guarantee a Cacophony deployment replaces per-session `pico --resume` for, so a " +
        "regression here is the product's reason to exist rather than a performance detail. " +
        `Daemon diagnostics: ${diagnostics.slice(0, 400)}`,
    );

    // The sample is only meaningful if the daemon was actually serving: a
    // crashed process has no descendants either.
    assert.equal(child.exitCode, null, `daemon exited early: ${diagnostics.slice(0, 400)}`);
  },
);

test("the process-table walk actually finds descendants", { timeout: 30_000 }, async (t) => {
  // Without this, the acceptance above is vacuous in the most likely direction:
  // if `ps` parsing broke, `descendantPids` would return [] for every input and
  // "the daemon created no process" would hold no matter what the daemon did.
  // A first attempt at a negative control spawned a child from the *test*
  // process and expected the daemon assertion to fire, which proved only that
  // the child was not a daemon descendant — the instrument was wrong, not the
  // guard.
  // Not an empty baseline: `descendantPids` shells out to `ps`, so the sampler
  // is itself a child of whoever samples. The acceptance above is unaffected
  // because it samples the daemon's descendants rather than the test's, but
  // here the honest measure is the delta.
  const baseline = await descendantPids(process.pid);

  const parent = spawn(
    process.execPath,
    ["-e", "const { spawn } = require('node:child_process'); spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { stdio: 'ignore' }); setTimeout(() => {}, 5000);"],
    { stdio: "ignore" },
  );
  t.after(() => {
    if (parent.exitCode === null && parent.signalCode === null) parent.kill("SIGKILL");
  });
  await new Promise((resolve) => setTimeout(resolve, 500));

  const descendants = await descendantPids(process.pid);
  const gained = descendants.filter((pid) => !baseline.includes(pid));
  assert.ok(gained.includes(parent.pid), `the direct child was not found: ${gained.join(", ")}`);
  assert.ok(
    gained.length >= 2,
    `expected the grandchild too, gained ${gained.length}: the walk must be transitive, ` +
      "or a process spawned by something the daemon spawned would escape the acceptance",
  );
});
