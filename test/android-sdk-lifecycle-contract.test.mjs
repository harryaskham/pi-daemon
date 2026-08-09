import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const repositoryRoot = resolve(import.meta.dirname, "..");

async function waitForReady(path, child, stderr, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`disposable daemon exited before readiness: ${stderr.value.slice(-2_000)}`);
    }
    try {
      return JSON.parse(await readFile(path, "utf8"));
    } catch (error) {
      if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  throw new Error(`disposable daemon readiness timed out: ${stderr.value.slice(-2_000)}`);
}

async function stopChild(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolveExit) => child.once("exit", resolveExit)),
    new Promise((_, reject) => setTimeout(() => reject(new Error("disposable daemon did not stop")), 5_000)),
  ]);
}

test("Pi Droid SDK lifecycle proof uses a disposable real API server", async (t) => {
  const privateRoot = await mkdtemp(join(tmpdir(), "pi-droid-sdk-lifecycle-"));
  await chmod(privateRoot, 0o700);
  t.after(async () => rm(privateRoot, { recursive: true, force: true }));
  const token = "pidroid-disposable-contract-token";
  const tokenFile = join(privateRoot, "token");
  const readyFile = join(privateRoot, "ready.json");
  const stateDir = join(privateRoot, "state");
  await mkdir(stateDir, { mode: 0o700 });
  await writeFile(tokenFile, `${token}\n`, { mode: 0o600 });
  const stderr = { value: "" };
  const child = spawn(
    process.execPath,
    [
      "scripts/pi-droid-disposable-daemon.mjs",
      "--port", "0",
      "--token-file", tokenFile,
      "--ready-file", readyFile,
      "--state-dir", stateDir,
      "--interactive",
    ],
    { cwd: repositoryRoot, env: process.env, stdio: ["ignore", "ignore", "pipe"] },
  );
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr.value = `${stderr.value}${chunk}`.slice(-8_192);
  });
  t.after(async () => stopChild(child));

  const receipt = await waitForReady(readyFile, child, stderr);

  assert.equal(receipt.schemaVersion, 1);
  assert.ok(receipt.port >= 1024 && receipt.port <= 65535);
  assert.equal(receipt.sessionId, "session-fixture-01");
  assert.deepEqual(receipt.selfProbe, {
    capabilities: true,
    configuredDefaults: true,
    sessionList: true,
    sessionInformation: true,
    configuredCreate: true,
    ticketReconciliationIdentity: true,
    inventory: true,
    information: true,
    transcript: true,
    observerAttach: true,
    controlGrant: true,
  });
  assert.equal(JSON.stringify(receipt).includes(token), false);
  assert.equal(stderr.value.includes(token), false);

  await stopChild(child);
  assert.equal(child.exitCode, 0);
});
