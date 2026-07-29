import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const FORMAT_TARGETS = "flake.nix nix/";

test("the flake declares a formatter and CI gates the tree on it", async () => {
  const [flake, ci] = await Promise.all([
    readFile(join(repositoryRoot, "flake.nix"), "utf8"),
    readFile(join(repositoryRoot, ".github", "workflows", "ci.yml"), "utf8"),
  ]);
  assert.match(flake, /formatter = forAllSystems \(system: \(import nixpkgs \{inherit system;\}\)\.alejandra\);/);

  const check = ci.indexOf(`nix fmt -- --check ${FORMAT_TARGETS}`);
  assert.notEqual(check, -1, "CI must verify Nix formatting");
  // Cheap and decisive, so it must not sit behind the long flake check.
  assert.equal(check < ci.indexOf("nix flake check"), true);
});

test("the formatter is reachable through the same Justfile surface as the other gates", async () => {
  const justfile = await readFile(join(repositoryRoot, "Justfile"), "utf8");
  assert.match(justfile, /^nix-fmt:\n\s+nix fmt -- flake\.nix nix\/$/m);
  assert.match(justfile, /^nix-fmt-check:\n\s+nix fmt -- --check flake\.nix nix\/$/m);
});

test("contributing documents the formatter alongside the other pre-landing checks", async () => {
  const contributing = await readFile(join(repositoryRoot, "CONTRIBUTING.md"), "utf8");
  assert.match(contributing, /## Nix formatting/);
  assert.match(contributing, /just nix-fmt-check/);
});

test("the committed Nix sources carry no formatting the gate would reject", async () => {
  // A cheap structural proxy for the formatter, so the standard suite notices
  // an unformatted tree without needing Nix on the runner. `nix fmt -- --check`
  // in CI remains authoritative.
  for (const relative of [
    "flake.nix",
    "nix/npm-deps.nix",
    "nix/home-manager-module.nix",
    "nix/home-manager-module-check.nix",
  ]) {
    const source = await readFile(join(repositoryRoot, relative), "utf8");
    const lines = source.split("\n");
    lines.forEach((line, index) => {
      const at = `${relative}:${index + 1}`;
      assert.equal(/[ \t]+$/.test(line), false, `${at} has trailing whitespace`);
      assert.equal(line.includes("\t"), false, `${at} uses a tab`);
    });
    assert.equal(source.endsWith("\n"), true, `${relative} must end with a newline`);
    assert.equal(source.includes("\n\n\n"), false, `${relative} has a blank-line run`);
  }
});
