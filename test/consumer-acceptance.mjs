// Consumer acceptance harness: run a Pi Daemon executable as a service and
// drive the neutral protocol through it the way a client deployment does.
//
// Existing coverage runs the daemon out of `dist/` in the source tree. That
// answers a question about the working tree, not about the artifact a node
// actually deploys — a distinction the 0.82.1 migration made concrete when an
// untracked test helper passed every local check and failed only inside the Nix
// package build, which sees a source-only tree. This harness is written against
// an executable path so the same acceptance can be pointed at either.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

// A generous hang bound rather than a performance budget: a correct daemon on a
// loaded builder can be descheduled for many seconds. A crashed one still fails
// fast through the exit-code check.
const SOCKET_HANG_BOUND_MS = 120_000;

/** Environment variable naming a packaged executable to accept instead of dist. */
export const PACKAGED_BIN_ENV = "PI_DAEMON_PACKAGED_BIN";

/**
 * Resolve how to launch the daemon under test.
 *
 * With no override the caller drives `dist/cli.js` through the current Node,
 * which is what the credential-free Node lane has available. The Nix lane sets
 * the override to the installed wrapper so the same acceptance runs against the
 * artifact, including its pinned Node and its pruned production tree.
 */
export function resolveDaemonCommand(env = process.env, repositoryRoot) {
  const packaged = typeof env[PACKAGED_BIN_ENV] === "string" ? env[PACKAGED_BIN_ENV].trim() : "";
  if (packaged !== "") {
    return { command: packaged, leadingArgs: [], cwd: repositoryRoot, packaged: true };
  }
  return {
    command: process.execPath,
    leadingArgs: ["dist/cli.js"],
    cwd: repositoryRoot,
    packaged: false,
  };
}

async function waitForSocket(path, child) {
  const deadline = Date.now() + SOCKET_HANG_BOUND_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`daemon exited before listening: ${child.exitCode}`);
    try {
      if ((await stat(path)).isSocket()) return;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    await delay(20);
  }
  throw new Error(`daemon did not create its socket within ${SOCKET_HANG_BOUND_MS / 1_000}s`);
}

/**
 * Count processes in the daemon's own tree.
 *
 * The architectural claim under test is that logical sessions do not each cost
 * a process, so the measurement has to be scoped to descendants of the launched
 * daemon rather than to anything system-wide, which would be neither stable nor
 * attributable on a shared host.
 */
export async function countDescendants(pid) {
  const { readdir, readFile } = await import("node:fs/promises");
  const entries = await readdir("/proc").catch(() => null);
  if (entries === null) return null; // Not Linux; caller treats null as "not measurable".
  const parents = new Map();
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const status = await readFile(`/proc/${entry}/stat`, "utf8").catch(() => null);
    if (status === null) continue;
    // Field 4 is PPID, after a comm field that may itself contain spaces.
    const afterComm = status.slice(status.lastIndexOf(")") + 2).split(" ");
    const ppid = Number(afterComm[1]);
    if (Number.isFinite(ppid)) parents.set(Number(entry), ppid);
  }
  let count = 0;
  for (const [child] of parents) {
    let cursor = child;
    for (let hops = 0; hops < 64 && cursor !== undefined && cursor !== 1; hops += 1) {
      if (cursor === pid) {
        count += 1;
        break;
      }
      cursor = parents.get(cursor);
    }
  }
  return count;
}

/** Provider named by the documented consumer example in docs/integration.md. */
export const ACCEPTANCE_PROVIDER = "github-copilot";

/**
 * Launch the daemon and return handles plus a bound cleanup.
 */
export async function startDaemon(t, { repositoryRoot, env = process.env } = {}) {
  const root = await mkdtemp(join(tmpdir(), "pi-daemon-consumer-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const work = join(root, "work");
  const seed = join(root, "seed");
  await Promise.all([mkdir(work, { mode: 0o700 }), mkdir(seed, { mode: 0o700 })]);
  // Opening a session validates that credentials exist for the named provider,
  // without contacting it. Seeding a local fixture key keeps this acceptance in
  // the credential-free gate while still exercising the documented request
  // shape, which names a provider; a real turn stays opt-in in the live smoke.
  await writeFile(
    join(seed, "auth.json"),
    `${JSON.stringify({
      [ACCEPTANCE_PROVIDER]: { type: "api_key", key: "consumer-acceptance-never-log" },
    })}\n`,
    { mode: 0o600 },
  );

  const socketPath = join(root, "run", "pi-daemon.sock");
  const launch = resolveDaemonCommand(env, repositoryRoot);
  const child = spawn(
    launch.command,
    [
      ...launch.leadingArgs,
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
      cwd: launch.cwd,
      env: { ...env, PI_CODING_AGENT_DIR: seed, PI_DAEMON_BEARER_TOKEN: undefined },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  t.after(() => {
    if (child.exitCode === null) child.kill("SIGKILL");
  });

  await waitForSocket(socketPath, child);
  return { child, socketPath, work, root, packaged: launch.packaged, readOutput: () => output };
}

/**
 * Stop the daemon and assert it shut down under its own control.
 */
export async function stopDaemon(child) {
  const exit = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  child.kill("SIGTERM");
  const result = await exit;
  assert.equal(result.signal, null, "daemon must exit under its own shutdown path, not by signal");
  return result;
}
