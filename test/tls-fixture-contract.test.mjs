import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { assertOpensslAvailable, generateTlsPair } from "./tls-fixture.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = join(here, "..");

test("a missing openssl names the dependency and the lane instead of a spawn ENOENT", async () => {
  // The bare failure was `spawn openssl ENOENT`, which reads like a product
  // fault rather than a missing test dependency.
  await assert.rejects(
    (async () => {
      const previous = process.env.OPENSSL_BIN;
      process.env.OPENSSL_BIN = join(here, "no-such-openssl-binary");
      try {
        const { assertOpensslAvailable: fresh } = await import(
          `./tls-fixture.mjs?missing-${Date.now()}`
        );
        await fresh();
      } finally {
        if (previous === undefined) delete process.env.OPENSSL_BIN;
        else process.env.OPENSSL_BIN = previous;
      }
    })(),
    (error) => {
      assert.match(error.message, /openssl/);
      assert.match(error.message, /OPENSSL_BIN/);
      assert.match(error.message, /must not be skipped/);
      assert.equal(error.cause?.code, "ENOENT");
      return true;
    },
  );
});

test("the openssl dependency is declared in every lane that runs the suite", async () => {
  const [flake, ci] = await Promise.all([
    readFile(join(repositoryRoot, "flake.nix"), "utf8"),
    readFile(join(repositoryRoot, ".github", "workflows", "ci.yml"), "utf8"),
  ]);
  // The package build and the dev shells.
  assert.match(flake, /nativeBuildInputs = \[pkgs\.makeWrapper pkgs\.openssl\]/);
  assert.match(flake, /commonPackages = \[[^\]]*pkgs\.openssl/s);
  // The plain Node lane, which has no Nix shell, from the same pinned nixpkgs.
  const provide = ci.indexOf("nixpkgs#openssl.bin");
  assert.notEqual(provide, -1, "the Node lane must provide openssl explicitly");
  assert.match(ci.slice(provide - 400, provide), /--inputs-from \./);
  assert.equal(provide < ci.indexOf("- run: npm test"), true, "provide it before the suite runs");
});

test("the fixture fails rather than degrading when openssl is absent", async (t) => {
  // These cases cover TLS material, native HTTPS authority, and credential
  // fail-closed behaviour, so an absent binary must be an error and never a
  // skip, a stub pair, or a silent pass.
  const root = await mkdtemp(join(tmpdir(), "pi-daemon-tls-absent-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const previous = process.env.OPENSSL_BIN;
  process.env.OPENSSL_BIN = join(here, "no-such-openssl-binary");
  try {
    const { generateTlsPair: fresh } = await import(`./tls-fixture.mjs?absent-${Date.now()}`);
    await assert.rejects(fresh(root, "absent"), /openssl/);
  } finally {
    if (previous === undefined) delete process.env.OPENSSL_BIN;
    else process.env.OPENSSL_BIN = previous;
  }
  assert.equal(typeof assertOpensslAvailable, "function");
});

test("generated material carries the modes the TLS cases assert, whatever the umask", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-daemon-tls-fixture-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { certFile, keyFile } = await generateTlsPair(root, "modes");
  const [cert, key] = await Promise.all([stat(certFile), stat(keyFile)]);
  assert.equal(cert.mode & 0o777, 0o644);
  assert.equal(key.mode & 0o777, 0o600);
});

test("permission fixtures state their mode rather than inheriting the umask", async (t) => {
  // A restrictive umask silently turns a deliberately permissive fixture into
  // an owner-only one, and a fail-closed assertion then has nothing to reject:
  // that is how these cases passed locally and failed on a CI runner. Every
  // deliberately permissive fixture must therefore chmod explicitly.
  const root = await mkdtemp(join(tmpdir(), "pi-daemon-umask-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "permissive");
  const previous = process.umask(0o077);
  try {
    await writeFile(path, "value\n", { mode: 0o644 });
    assert.equal((await stat(path)).mode & 0o077, 0, "writeFile alone is umask-dependent");
    await chmod(path, 0o644);
    assert.notEqual((await stat(path)).mode & 0o077, 0, "an explicit chmod is not");
  } finally {
    process.umask(previous);
  }

  // Which fixtures must state their mode, and that they do, is asserted by
  // test/permission-fixture.test.mjs; this case only fixes the reason why.
});
