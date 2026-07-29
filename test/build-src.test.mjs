import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { promisify } from "node:util";

const run = promisify(execFile);
const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

async function manifest() {
  return JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8"));
}

/**
 * A throwaway tree shaped like the repository's build output, so the clean and
 * postbuild scripts can be exercised without disturbing the real dist/ that the
 * rest of this suite imports from.
 */
async function buildOutputFixture({ withWebDist }) {
  const root = await mkdtemp(join(tmpdir(), "pi-daemon-build-src-"));
  await mkdir(join(root, "dist", "dashboard", "assets"), { recursive: true });
  await writeFile(join(root, "dist", "server.js"), "// stale\n");
  await writeFile(join(root, "dist", "dashboard", "index.html"), "<!doctype html>");
  if (withWebDist) {
    await mkdir(join(root, "web", "dist", "assets"), { recursive: true });
    await writeFile(join(root, "web", "dist", "index.html"), "<!doctype html>spa");
  }
  return root;
}

async function runScript(name, root, args = []) {
  // The scripts resolve paths relative to their own location, so run a copy
  // that sits one directory below the fixture root, mirroring scripts/.
  const source = await readFile(join(repositoryRoot, "scripts", name), "utf8");
  await mkdir(join(root, "scripts"), { recursive: true });
  const copied = join(root, "scripts", name);
  await writeFile(copied, source);
  const { stdout } = await run(process.execPath, [copied, ...args]);
  return stdout;
}

async function exists(path) {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

test("the focused loop compiles src without rebuilding the Dash SPA", async () => {
  const scripts = (await manifest()).scripts;
  assert.equal(
    scripts["build:src"],
    "node scripts/clean.mjs --keep-web && tsc -p tsconfig.json && node scripts/postbuild.mjs",
  );
  assert.equal(scripts["test:src"], "npm run build:src && node --test --test-concurrency=1");
  assert.equal(scripts["build:src"].includes("web:build"), false);
});

test("the authoritative gates keep running the full build", async () => {
  const scripts = (await manifest()).scripts;
  // Nothing may ship without the SPA, so packaging and release paths are
  // deliberately untouched by the focused loop.
  for (const name of ["test", "prepack", "test:pi-sdk", "test:live"]) {
    assert.match(scripts[name], /npm run build\b/, `${name} must use the full build`);
  }
  assert.match(scripts.build, /npm run web:build/);
});

test("clean --keep-web drops the server output but preserves the compiled SPA", async () => {
  const root = await buildOutputFixture({ withWebDist: true });
  try {
    await runScript("clean.mjs", root, ["--keep-web"]);
    assert.equal(await exists(join(root, "dist", "server.js")), false);
    assert.equal(await exists(join(root, "web", "dist", "index.html")), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("clean without the flag still removes both trees", async () => {
  const root = await buildOutputFixture({ withWebDist: true });
  try {
    await runScript("clean.mjs", root);
    assert.equal(await exists(join(root, "dist", "server.js")), false);
    assert.equal(await exists(join(root, "web", "dist", "index.html")), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("postbuild reports an absent SPA instead of failing with a bare ENOENT", async () => {
  const root = await buildOutputFixture({ withWebDist: false });
  try {
    await rm(join(root, "dist"), { recursive: true, force: true });
    // The contract copies need the real files, so run against the repository's
    // own root for those and assert only the SPA branch here.
    const source = await readFile(join(repositoryRoot, "scripts", "postbuild.mjs"), "utf8");
    assert.match(source, /web\/dist is absent/);
    assert.match(source, /npm run build/);
    assert.match(source, /stat\(webDist\)/);
    // The copy must be conditional, never unconditional.
    assert.match(source, /if \(hasWebDist\) \{/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the focused loop is documented next to the authoritative gate", async () => {
  const [contributing, justfile] = await Promise.all([
    readFile(join(repositoryRoot, "CONTRIBUTING.md"), "utf8"),
    readFile(join(repositoryRoot, "Justfile"), "utf8"),
  ]);
  assert.match(contributing, /npm run test:src -- test\//);
  assert.match(contributing, /remains\s*\n?the authoritative gate/);
  assert.match(justfile, /^test-src \*ARGS:$/m);
});
