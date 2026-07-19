import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { PiDaemonClient } from "../dist/client.js";

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitForSocket(path, child) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`daemon exited before listening: ${child.exitCode}`);
    try {
      if ((await stat(path)).isSocket()) return;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    await delay(20);
  }
  throw new Error("daemon did not create its socket within 10 seconds");
}

test("serve bootstraps an empty standalone instance before constructing the Pi factory", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-daemon-first-serve-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const work = join(root, "work");
  const seedDirectory = join(root, "seed");
  await Promise.all([
    mkdir(work, { mode: 0o700 }),
    mkdir(seedDirectory, { mode: 0o700 }),
  ]);
  const authMarker = "bootstrap-auth-marker-never-log";
  const authSeed = join(seedDirectory, "auth.json");
  await writeFile(authSeed, `${JSON.stringify({ fixture: { type: "api_key", key: authMarker } })}\n`, {
    mode: 0o600,
  });

  const stateDir = join(root, "missing", "state");
  const agentDir = join(root, "missing", "agent");
  const socketPath = join(root, "missing", "run", "pi-daemon.sock");
  const child = spawn(
    process.execPath,
    [
      "dist/cli.js",
      "serve",
      "--socket",
      socketPath,
      "--state-dir",
      stateDir,
      "--agent-dir",
      agentDir,
      "--allow-root",
      work,
      "--api-port",
      "0",
    ],
    {
      cwd: new URL("..", import.meta.url),
      env: {
        ...process.env,
        PI_CODING_AGENT_DIR: seedDirectory,
        PI_DAEMON_BEARER_TOKEN: undefined,
      },
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
  const client = await PiDaemonClient.connect({ socketPath });
  await client.handshake("bootstrap-cli-handshake");
  client.close();

  const tokenFile = join(stateDir, "api-token");
  assert.equal((await stat(stateDir)).mode & 0o777, 0o700);
  assert.equal((await stat(agentDir)).mode & 0o777, 0o700);
  assert.equal((await stat(tokenFile)).mode & 0o777, 0o600);
  assert.equal(await readFile(join(agentDir, "auth.json"), "utf8"), await readFile(authSeed, "utf8"));

  const exit = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  child.kill("SIGTERM");
  await delay(10);
  if (child.exitCode === null) child.kill("SIGTERM");
  assert.deepEqual(await exit, { code: 0, signal: null });
  const bearer = (await readFile(tokenFile, "utf8")).trimEnd();
  assert.ok(bearer.length >= 16);
  assert.equal(output.includes(bearer), false);
  assert.equal(output.includes(authMarker), false);
  assert.match(output, /"bootstrap":\{"bearerCreated":true,"auth":"seeded"\}/);
});
