import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { captureChildOutput, waitForDaemonReady } from "./daemon-readiness.mjs";

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
  const output = captureChildOutput(child);
  t.after(() => {
    if (child.exitCode === null) child.kill("SIGKILL");
  });

  const client = await waitForDaemonReady({
    socketPath,
    child,
    handshakeRequestId: "bootstrap-cli-handshake",
    diagnostics: output.diagnostics,
  });
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
  // Repeated stop signals must not bypass cleanup (the 0.2.2 fix). Deliver the
  // second one in the same tick as the first, so both land while the handlers
  // are installed. Waiting first and re-signalling only if the child had not
  // exited yet raced the product's own guarantee: once bounded shutdown
  // completes the handlers are released, so a late second SIGTERM terminates
  // the process by default disposition and the assertion below saw
  // {code: null, signal: 'SIGTERM'} on a loaded runner even though shutdown
  // had run correctly.
  child.kill("SIGTERM");
  child.kill("SIGTERM");
  assert.deepEqual(await exit, { code: 0, signal: null });
  const bearer = (await readFile(tokenFile, "utf8")).trimEnd();
  const capturedOutput = output.text();
  const outputSnapshot = output.snapshot();
  assert.ok(bearer.length >= 16);
  assert.equal(outputSnapshot.stdout.droppedBytes, 0);
  assert.equal(outputSnapshot.stderr.droppedBytes, 0);
  assert.equal(capturedOutput.includes(bearer), false);
  assert.equal(capturedOutput.includes(authMarker), false);
  assert.match(capturedOutput, /"bootstrap":\{"bearerCreated":true,"auth":"seeded"\}/);
});
