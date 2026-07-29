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

test("the convention is written down, in the order review settled on", async () => {
  const contributing = await readFile(join(here, "..", "CONTRIBUTING.md"), "utf8");
  const section = contributing.slice(
    contributing.indexOf("## Negative controls"),
    contributing.indexOf("## Nix formatting"),
  );
  assert.notEqual(section.length, 0, "the convention must be documented");

  // The ordering is the substance: the precondition form goes first because it
  // catches vacuity from an environment the author was never in, and the manual
  // mutation goes last because it is exercised in the benign one.
  const precondition = section.indexOf("Assert the precondition");
  const negativeCase = section.indexOf("negative case against an extracted predicate");
  const manual = section.indexOf("Record a manual mutation");
  for (const [name, at] of [
    ["precondition", precondition],
    ["negative case", negativeCase],
    ["manual mutation", manual],
  ]) {
    assert.notEqual(at, -1, `the ${name} form must be documented`);
  }
  assert.equal(precondition < negativeCase, true, "the precondition form comes first");
  assert.equal(negativeCase < manual, true, "the manual mutation comes last");

  // And the two costs of preferring direct observation, which are not obvious.
  assert.match(section, /build inputs|closure/);
  assert.match(section, /lane/);

  // The measurement form of the same error, and the hazard in performing the
  // manual mutation — both learned by committing them.
  assert.match(section, /capable of happening/);
  assert.match(section, /HEAD/);
});

test("every repository path the convention cites is really there", async () => {
  // A worked example that does not exist is worse than none, since the reader
  // cannot tell the advice from the illustration. This cannot check the thing
  // that actually went wrong — form 2 once cited an example that was really an
  // instance of form 3 — because whether a citation is of the right kind is not
  // mechanically decidable. It catches the cheaper mistake only.
  const repositoryRoot = join(here, "..");
  const contributing = await readFile(join(repositoryRoot, "CONTRIBUTING.md"), "utf8");
  const section = contributing.slice(
    contributing.indexOf("## Negative controls"),
    contributing.indexOf("## Nix formatting"),
  );
  const cited = [...section.matchAll(/`((?:test|nix|src|web|scripts)\/[\w./-]+)`/g)].map(
    (match) => match[1],
  );
  assert.notEqual(cited.length, 0, "the convention should cite its instances");
  for (const path of new Set(cited)) {
    await assert.doesNotReject(
      stat(join(repositoryRoot, path)),
      `the convention cites ${path}, which does not exist`,
    );
  }
});
