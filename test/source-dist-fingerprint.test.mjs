import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  checkSourceDistFingerprint,
  computeSourceFingerprint,
  warnIfSourceDistStale,
  writeSourceDistFingerprint,
} from "../scripts/source-dist-fingerprint.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "pi-daemon-source-dist-fingerprint-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  await Promise.all([
    mkdir(join(root, "src", "nested"), { recursive: true }),
    mkdir(join(root, "dist"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(root, "src", "alpha.ts"), "export const alpha = 1;\n"),
    writeFile(join(root, "src", "nested", "beta.ts"), "export const beta = 2;\n"),
  ]);
  return root;
}

test("build writes and build-free unit tests check the source/dist marker", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const postbuild = await readFile(new URL("../scripts/postbuild.mjs", import.meta.url), "utf8");
  assert.match(packageJson.scripts["test:unit"], /^node scripts\/source-dist-fingerprint\.mjs && node --test/);
  assert.match(postbuild, /writeSourceDistFingerprint\(\)/);
});

test("source/dist fingerprint is deterministic and current immediately after write", async (t) => {
  const root = await fixture(t);
  const first = await computeSourceFingerprint(root);
  const second = await computeSourceFingerprint(root);
  assert.deepEqual(second, first);
  assert.equal(first.fileCount, 2);
  assert.equal(first.algorithm, "sha256");

  const written = await writeSourceDistFingerprint(root);
  assert.deepEqual(written, first);
  const checked = await checkSourceDistFingerprint(root);
  assert.equal(checked.status, "current");
  assert.deepEqual(checked.built, first);
  const marker = JSON.parse(await readFile(join(root, "dist", ".source-build-fingerprint.json"), "utf8"));
  assert.deepEqual(marker, first);
});

test("source change produces a warning but never blocks the unit runner", async (t) => {
  const root = await fixture(t);
  await writeSourceDistFingerprint(root);
  await writeFile(join(root, "src", "alpha.ts"), "export const alpha = 3;\n");
  const lines = [];

  const result = await warnIfSourceDistStale(root, (line) => lines.push(line));

  assert.equal(result.status, "stale");
  assert.equal(lines.length, 1);
  assert.match(lines[0], /test:unit warning: dist is stale relative to src\/\*\*/);
  assert.match(lines[0], /npm run test:src/);
  assert.match(lines[0], /Tests will still run/);
  assert.equal(lines[0].includes(root), false, "warning stays independent of ambient paths");
});

test("missing and invalid markers are distinguishable warnings", async (t) => {
  const root = await fixture(t);
  const lines = [];
  assert.equal((await warnIfSourceDistStale(root, (line) => lines.push(line))).status, "missing");
  assert.match(lines.pop(), /dist source fingerprint is missing/);

  await writeFile(join(root, "dist", ".source-build-fingerprint.json"), "not-json\n");
  assert.equal((await warnIfSourceDistStale(root, (line) => lines.push(line))).status, "invalid");
  assert.match(lines.pop(), /dist source fingerprint is invalid/);
});

test("source fingerprint refuses symlinks instead of hashing ambient files", async (t) => {
  const root = await fixture(t);
  await symlink(join(root, "src", "alpha.ts"), join(root, "src", "link.ts"));
  await assert.rejects(computeSourceFingerprint(root), /source fingerprint refuses symlinks/);
});
