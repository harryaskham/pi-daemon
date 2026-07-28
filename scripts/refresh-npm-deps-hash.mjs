#!/usr/bin/env node
// Refresh (or verify) the pinned npm dependency hash in flake.nix.
//
// `buildNpmPackage` pins `npmDepsHash`, a fixed-output hash over the npm
// dependency cache built from package-lock.json. Any lock change invalidates
// it, and an automated dependency bump cannot refresh it, so the Nix jobs would
// otherwise fail with a bare fixed-output mismatch and no supported way to fix
// it. This script is that supported way.
//
// Modes:
//   (default)  compute the exact hash with Nix and rewrite flake.nix
//   --check    compute the exact hash with Nix and fail on drift
//   --fast     compare only the recorded lock marker; no Nix, no network
//   --root D   operate on the checkout at D instead of this one (testing)
//
// `--fast` is what CI runs on the plain Node runners: it cannot compute the
// real hash, but it proves whether package-lock.json moved since the pin was
// last refreshed, which is exactly the failure an automated bump introduces.

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const REFRESH_COMMAND = "npm run nix:deps-hash";
const MARKER = /^(\s*# npm-deps-lock: )(sha256-[A-Za-z0-9+/=]+)\s*$/m;
const PINNED = /^(\s*npmDepsHash = ")(sha256-[A-Za-z0-9+/=]+)(";)\s*$/m;
const PLACEHOLDER_HASH = "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

/** Content fingerprint of the lock file, in the SRI shape Nix hashes use. */
async function lockFingerprint(root) {
  const lock = await readFile(join(root, "package-lock.json"));
  return `sha256-${createHash("sha256").update(lock).digest("base64")}`;
}

function readPins(flake) {
  const marker = MARKER.exec(flake);
  const pinned = PINNED.exec(flake);
  if (marker === null || pinned === null) {
    throw new Error(
      "flake.nix no longer carries a recognizable npmDepsHash pin and npm-deps-lock marker",
    );
  }
  return { marker: marker[2], pinned: pinned[2] };
}

function run(command, args, cwd) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => resolve({ code: -1, stdout, stderr: String(error) }));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

/**
 * Compute the exact hash by building the dependency cache with a deliberately
 * wrong fixed output hash and reading the `got:` line Nix reports. This uses
 * the same `fetchNpmDeps` call and pinned nixpkgs as the package itself, and it
 * reads the working-tree lock file, so it does not require the change to be
 * committed first.
 */
async function computeWithNix(root) {
  const expression = `
let
  flake = builtins.getFlake ("git+file://" + toString ./. + "?shallow=1");
  pkgs = import flake.inputs.nixpkgs.outPath {};
in
  import ./nix/npm-deps.nix {
    inherit pkgs;
    lockfile = ./package-lock.json;
    hash = "${PLACEHOLDER_HASH}";
  }
`;
  const result = await run(
    "nix",
    ["build", "--impure", "--no-link", "--expr", expression],
    root,
  );
  const output = `${result.stdout}\n${result.stderr}`;
  const got = /got:\s+(sha256-[A-Za-z0-9+/=]+)/.exec(output);
  if (got !== null) return got[1];
  if (result.code === 0) {
    throw new Error(
      "the placeholder hash unexpectedly matched; refusing to guess the real hash",
    );
  }
  throw new Error(`could not compute the npm dependency hash with Nix:\n${output.trim()}`);
}

async function main() {
  const argv = process.argv.slice(2);
  const args = new Set(argv);
  const fast = args.has("--fast");
  const check = args.has("--check") || fast;
  const rootIndex = argv.indexOf("--root");
  const root = rootIndex === -1 ? repositoryRoot : argv[rootIndex + 1];
  if (root === undefined || root.length === 0) throw new Error("--root needs a directory");
  const flakePath = join(root, "flake.nix");

  const flake = await readFile(flakePath, "utf8");
  const pins = readPins(flake);
  const fingerprint = await lockFingerprint(root);

  if (fast) {
    if (pins.marker === fingerprint) {
      process.stdout.write(`npmDepsHash pin is current for this package-lock.json\n`);
      return;
    }
    fail(
      [
        "package-lock.json changed since the pinned Nix npmDepsHash was refreshed.",
        `  recorded lock: ${pins.marker}`,
        `  current lock:  ${fingerprint}`,
        "",
        `Run \`${REFRESH_COMMAND}\` on a machine with Nix and commit flake.nix.`,
        "Without it every Nix job fails with a fixed-output hash mismatch.",
      ].join("\n"),
    );
    return;
  }

  const computed = await computeWithNix(root);

  if (check) {
    if (computed === pins.pinned && fingerprint === pins.marker) {
      process.stdout.write(`npmDepsHash is exact: ${computed}\n`);
      return;
    }
    fail(
      [
        "flake.nix does not pin the current npm dependency cache.",
        `  pinned npmDepsHash: ${pins.pinned}`,
        `  exact npmDepsHash:  ${computed}`,
        `  recorded lock:      ${pins.marker}`,
        `  current lock:       ${fingerprint}`,
        "",
        `Run \`${REFRESH_COMMAND}\` and commit flake.nix.`,
      ].join("\n"),
    );
    return;
  }

  if (computed === pins.pinned && fingerprint === pins.marker) {
    process.stdout.write(`npmDepsHash already exact: ${computed}\n`);
    return;
  }

  const updated = flake
    .replace(MARKER, (_match, prefix) => `${prefix}${fingerprint}`)
    .replace(PINNED, (_match, prefix, _old, suffix) => `${prefix}${computed}${suffix}`);
  if (updated === flake) throw new Error("failed to rewrite flake.nix");
  await writeFile(flakePath, updated);
  process.stdout.write(
    [
      "updated flake.nix",
      `  npmDepsHash: ${pins.pinned} -> ${computed}`,
      `  lock marker: ${pins.marker} -> ${fingerprint}`,
    ].join("\n") + "\n",
  );
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
