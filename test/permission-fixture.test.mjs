import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { assertFixtureMode, mkdirWithMode, writeFileWithMode } from "./permission-fixture.mjs";

const here = dirname(fileURLToPath(import.meta.url));

async function scratch(t, prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("a permissive fixture keeps its mode under a restrictive umask", async (t) => {
  const root = await scratch(t, "pi-daemon-permission-fixture-");
  const previous = process.umask(0o077);
  try {
    const file = await writeFileWithMode(join(root, "credential"), "token\n", 0o644);
    const directory = await mkdirWithMode(join(root, "state"), 0o755);
    assert.equal((await stat(file)).mode & 0o777, 0o644);
    assert.equal((await stat(directory)).mode & 0o777, 0o755);
  } finally {
    process.umask(previous);
  }
});

test("the mode check rejects the shapes that would make a fail-closed case vacuous", async (t) => {
  // The negative control for the helper itself: prove the check can fail, and
  // on exactly the mode a restrictive umask would have produced.
  const root = await scratch(t, "pi-daemon-permission-negative-");
  const ownerOnly = join(root, "owner-only");
  await writeFile(ownerOnly, "token\n", { mode: 0o600 });

  await assert.rejects(assertFixtureMode(ownerOnly, 0o644, "fixture file"), (error) => {
    assert.match(error.message, /should be mode 644 but is 600/);
    assert.match(error.message, /property under test/);
    assert.match(error.message, /umask/);
    return true;
  });

  // And it does not fire when the mode is the requested one.
  await assert.doesNotReject(assertFixtureMode(ownerOnly, 0o600));

  // A directory that already exists ignores `mkdir`'s mode entirely, which is
  // the second way this class hides; the helper chmods, so it still holds.
  const existing = await mkdirWithMode(join(root, "state"), 0o700);
  await mkdirWithMode(existing, 0o755);
  assert.equal((await stat(existing)).mode & 0o777, 0o755);
});

test("the fixtures whose assertions depend on a mode use the checked helper", async () => {
  const [identity, bootstrap] = await Promise.all([
    readFile(join(here, "dashboard-identity-config.test.mjs"), "utf8"),
    readFile(join(here, "bootstrap.test.mjs"), "utf8"),
  ]);
  // These two are the cases that were passing for the wrong reason on a
  // hardened runner; keep them on the helper so a future edit cannot silently
  // reintroduce a umask-dependent precondition.
  assert.match(identity, /writeFileWithMode\(insecure, [^)]*0o666\)/s);
  assert.match(identity, /writeFileWithMode\(secretPath, [^)]*0o644\)/s);
  assert.match(bootstrap, /mkdirWithMode\(paths\.stateDir, 0o755\)/);
});

test("the convention is written down where a contributor will find it", async () => {
  const contributing = await readFile(join(here, "..", "CONTRIBUTING.md"), "utf8");
  assert.match(contributing, /## Negative controls/);
  // The three forms, cheapest and most durable first.
  assert.match(contributing, /checked-in/i);
  assert.match(contributing, /precondition/i);
  assert.match(contributing, /commit message/i);
});
