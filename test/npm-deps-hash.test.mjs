import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { promisify } from "node:util";

const run = promisify(execFile);
const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(repositoryRoot, "scripts", "refresh-npm-deps-hash.mjs");

async function runFast(root, options = {}) {
  try {
    const { stdout } = await run(process.execPath, [script, "--fast", "--root", root], options);
    return { code: 0, output: stdout };
  } catch (error) {
    return {
      code: error.code ?? 1,
      output: `${error.stdout ?? ""}${error.stderr ?? ""}`,
    };
  }
}

/**
 * A copy of the repository's pin inputs, so drift can be simulated without
 * mutating the working tree that other tests and the build read.
 */
async function fixtureRoot() {
  const root = await mkdtemp(join(tmpdir(), "pi-daemon-npm-deps-"));
  const [flake, lock] = await Promise.all([
    readFile(join(repositoryRoot, "flake.nix"), "utf8"),
    readFile(join(repositoryRoot, "package-lock.json"), "utf8"),
  ]);
  await Promise.all([
    writeFile(join(root, "flake.nix"), flake),
    writeFile(join(root, "package-lock.json"), lock),
  ]);
  return root;
}

test("the pinned npm dependency hash is a single source of truth with a lock marker", async () => {
  const flake = await readFile(join(repositoryRoot, "flake.nix"), "utf8");
  const pins = flake.match(/npmDepsHash = "sha256-[A-Za-z0-9+/=]+";/g) ?? [];
  assert.equal(pins.length, 1, "npmDepsHash must be defined exactly once");
  assert.match(flake, /^\s*# npm-deps-lock: sha256-[A-Za-z0-9+/=]+$/m);
  assert.match(flake, /^\s*inherit npmDepsHash;$/m);
  assert.match(flake, /npm-deps-hash = import \.\/nix\/npm-deps\.nix \{/);
  assert.match(flake, /npmDepsFetcherVersion = 2;/);
});

test("the flake check reuses the pinned hash rather than repeating the literal", async () => {
  const [flake, oracle] = await Promise.all([
    readFile(join(repositoryRoot, "flake.nix"), "utf8"),
    readFile(join(repositoryRoot, "nix", "npm-deps.nix"), "utf8"),
  ]);
  assert.match(flake, /npm-deps-hash = import \.\/nix\/npm-deps\.nix \{\s*\n\s*inherit pkgs;\s*\n\s*hash = npmDepsHash;/);
  assert.match(oracle, /fetchNpmDeps/);
  assert.match(oracle, /inherit fetcherVersion hash;/);
});

test("the refresh script is wired into npm scripts, the Justfile, and Node CI", async () => {
  const [manifest, justfile, ci] = await Promise.all([
    readFile(join(repositoryRoot, "package.json"), "utf8").then(JSON.parse),
    readFile(join(repositoryRoot, "Justfile"), "utf8"),
    readFile(join(repositoryRoot, ".github", "workflows", "ci.yml"), "utf8"),
  ]);
  assert.equal(manifest.scripts["nix:deps-hash"], "node scripts/refresh-npm-deps-hash.mjs");
  assert.equal(
    manifest.scripts["nix:deps-hash:check"],
    "node scripts/refresh-npm-deps-hash.mjs --check",
  );
  assert.equal(
    manifest.scripts["nix:deps-hash:fast"],
    "node scripts/refresh-npm-deps-hash.mjs --fast",
  );
  assert.match(justfile, /^npm-deps-hash:$/m);
  assert.match(justfile, /^npm-deps-hash-check:$/m);
  // The fast check must run on the plain Node runners, where a dependency bump
  // lands, and before the expensive steps it is meant to pre-empt.
  const fast = ci.indexOf("npm run nix:deps-hash:fast");
  assert.notEqual(fast, -1);
  assert.equal(fast < ci.indexOf("- run: npm test"), true);
});

test("the fast check accepts the pin that matches this package-lock.json", async () => {
  const result = await runFast(repositoryRoot);
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /pin is current/);
});

test("the fast check rejects a lock change that left the pin behind, and names the fix", async () => {
  const root = await fixtureRoot();
  try {
    const lock = await readFile(join(root, "package-lock.json"), "utf8");
    // Any lock byte change invalidates the fixed-output dependency hash.
    await writeFile(join(root, "package-lock.json"), `${lock}\n`);
    const result = await runFast(root);
    assert.equal(result.code, 1);
    assert.match(result.output, /package-lock\.json changed/);
    assert.match(result.output, /npm run nix:deps-hash/);
    assert.match(result.output, /recorded lock: sha256-/);
    assert.match(result.output, /current lock:  sha256-/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the refresh script fails loudly when the pin shape is gone", async () => {
  const root = await fixtureRoot();
  try {
    const flake = await readFile(join(root, "flake.nix"), "utf8");
    await writeFile(join(root, "flake.nix"), flake.replace(/# npm-deps-lock: sha256-[A-Za-z0-9+/=]+/, ""));
    const result = await runFast(root);
    assert.equal(result.code, 1);
    assert.match(result.output, /no longer carries a recognizable npmDepsHash pin/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the fast check needs no Nix on PATH, which is the point of running it in the Node jobs", async () => {
  // An empty PATH also proves it shells out to nothing at all.
  const result = await runFast(repositoryRoot, { env: { PATH: "" } });
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /pin is current/);
});
