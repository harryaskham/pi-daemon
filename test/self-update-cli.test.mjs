import assert from "node:assert/strict";
import test from "node:test";

import { runCli } from "../dist/cli.js";
import { SelfUpdateError } from "../dist/self-update.js";

function io() {
  const stdout = [];
  const stderr = [];
  return {
    stdout,
    stderr,
    value: {
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
    },
  };
}

function fakeUpdater() {
  const calls = [];
  return {
    calls,
    async status() { calls.push(["status"]); return { currentVersion: "0.1.0", localInstallRequired: true }; },
    async check() { calls.push(["check"]); return { currentVersion: "0.1.0", latest: { version: "0.1.1" }, updateAvailable: true }; },
    async run() { calls.push(["run"]); return { currentVersion: "0.1.0", activeVersion: "0.1.1", updateAvailable: false }; },
    async rollback() { calls.push(["rollback"]); return { currentVersion: "0.1.0", activeVersion: "0.1.0" }; },
  };
}

test("self-update actions and update shorthand emit bounded JSON", async () => {
  const updater = fakeUpdater();
  for (const [argv, action] of [
    [["self-update", "status"], "status"],
    [["self-update", "check"], "check"],
    [["self-update", "rollback"], "rollback"],
  ]) {
    const output = io();
    assert.equal(await runCli(argv, output.value, { selfUpdater: updater }), 0);
    assert.equal(updater.calls.at(-1)[0], action);
    assert.doesNotThrow(() => JSON.parse(output.stdout.join("")));
    assert.equal(output.stderr.length, 0);
  }

  const output = io();
  assert.equal(await runCli(["update"], output.value, { selfUpdater: updater }), 0);
  assert.deepEqual(updater.calls.at(-1), ["run"]);
});

test("self-update failures are typed and help documents mutable install behavior", async () => {
  const updater = fakeUpdater();
  updater.check = async () => { throw new SelfUpdateError("release_check_failed", "GitHub release check failed", true); };
  const output = io();
  assert.equal(await runCli(["self-update", "check"], output.value, { selfUpdater: updater }), 75);
  assert.deepEqual(JSON.parse(output.stderr.join("")), {
    error: { code: "release_check_failed", message: "GitHub release check failed", retryable: true },
  });

  const help = io();
  assert.equal(await runCli(["help"], help.value), 0);
  assert.match(help.stdout.join(""), /pi-daemon self-update status\|check\|run\|rollback/);
  assert.match(help.stdout.join(""), /~\/.local\/share\/pi-daemon/);
});
