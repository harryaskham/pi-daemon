import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  PiDaemonSelfUpdater,
  SelfUpdateError,
  compareVersions,
} from "../dist/self-update.js";

async function harness(t) {
  const root = await mkdtemp(join(tmpdir(), "pi-daemon-self-update-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const installRoot = join(root, "share", "pi-daemon");
  const binDir = join(root, "bin");
  const packageBytes = Buffer.from("verified package bytes");
  let version = "0.1.1";
  let checksum = createHash("sha256").update(packageBytes).digest("hex");
  const requests = [];
  const fetch = async (url) => {
    requests.push(String(url));
    if (String(url).includes("/releases/latest")) {
      const packageAsset = `harryaskham-pi-daemon-${version}.tgz`;
      return new Response(JSON.stringify({
        tag_name: `v${version}`,
        draft: false,
        prerelease: false,
        published_at: "2026-07-20T00:00:00.000Z",
        assets: [
          { name: packageAsset, browser_download_url: `https://github.com/harryaskham/pi-daemon/releases/download/v${version}/${packageAsset}` },
          { name: `${packageAsset}.sha256`, browser_download_url: `https://github.com/harryaskham/pi-daemon/releases/download/v${version}/${packageAsset}.sha256` },
        ],
      }), { headers: { "content-type": "application/json" } });
    }
    if (String(url).endsWith(".sha256")) {
      const filename = `harryaskham-pi-daemon-${version}.tgz`;
      return new Response(`${checksum}  ${filename}\n`);
    }
    return new Response(packageBytes);
  };
  const installs = [];
  const runNpmInstall = async ({ prefix, tarball }) => {
    installs.push({ prefix, tarball });
    const packageRoot = join(prefix, "node_modules", "@harryaskham", "pi-daemon");
    const binRoot = join(prefix, "node_modules", ".bin");
    await mkdir(join(packageRoot, "dist"), { recursive: true });
    await mkdir(binRoot, { recursive: true });
    await writeFile(join(packageRoot, "package.json"), `${JSON.stringify({ version })}\n`);
    await writeFile(join(packageRoot, "npm-shrinkwrap.json"), `${JSON.stringify({ lockfileVersion: 3, packages: { "": { version } } })}\n`);
    await writeFile(join(packageRoot, "dist", "cli.js"), "#!/usr/bin/env node\n", { mode: 0o755 });
    await symlink(join("..", "@harryaskham", "pi-daemon", "dist", "cli.js"), join(binRoot, "pi-daemon"));
  };
  const updater = new PiDaemonSelfUpdater(
    { installRoot, binDir },
    { fetch, runNpmInstall, now: () => new Date("2026-07-20T12:00:00.000Z"), randomId: (() => { let id = 0; return () => `id-${++id}`; })() },
  );
  return {
    root,
    installRoot,
    binDir,
    packageBytes,
    requests,
    installs,
    fetch,
    runNpmInstall,
    updater,
    setVersion(next) { version = next; },
    setChecksum(next) { checksum = next; },
  };
}

test("version comparison is strict semantic ordering", () => {
  assert.equal(compareVersions("0.1.1", "0.1.0"), 1);
  assert.equal(compareVersions("1.0.0", "1.0.0"), 0);
  assert.equal(compareVersions("1.2.3", "2.0.0"), -1);
  assert.throws(() => compareVersions("latest", "1.0.0"), SelfUpdateError);
});

test("status is offline and check discovers bounded exact release assets", async (t) => {
  const h = await harness(t);
  const status = await h.updater.status();
  assert.equal(status.currentVersion, "0.1.0");
  assert.equal(status.localInstallRequired, true);
  assert.equal(status.managedLink, false);
  assert.equal(h.requests.length, 0);

  const checked = await h.updater.check();
  assert.equal(checked.latest.version, "0.1.1");
  assert.equal(checked.updateAvailable, true);
  assert.equal(h.requests.length, 1);
});

test("run verifies checksum, installs exact package and atomically owns the local link", async (t) => {
  const h = await harness(t);
  const result = await h.updater.run();
  assert.equal(result.activeVersion, "0.1.1");
  assert.equal(result.managedLink, true);
  assert.equal(result.updateAvailable, false);
  assert.equal(h.installs.length, 1);
  const binPath = join(h.binDir, "pi-daemon");
  assert.equal((await lstat(binPath)).isSymbolicLink(), true);
  assert.match(await realpath(binPath), /versions\/0\.1\.1\/node_modules\/@harryaskham\/pi-daemon\/dist\/cli\.js$/);
  const state = JSON.parse(await readFile(join(h.installRoot, "state.json"), "utf8"));
  assert.equal(state.activeVersion, "0.1.1");
  assert.equal(state.packageSha256, createHash("sha256").update(h.packageBytes).digest("hex"));

  await h.updater.run();
  assert.equal(h.installs.length, 1, "active latest release must be a no-op");
});

test("checksum mismatch and local-bin collision fail without publishing an executable", async (t) => {
  const mismatch = await harness(t);
  mismatch.setChecksum("0".repeat(64));
  await assert.rejects(
    mismatch.updater.run(),
    (error) => error instanceof SelfUpdateError && error.code === "update_checksum_mismatch",
  );
  await assert.rejects(lstat(join(mismatch.binDir, "pi-daemon")), /ENOENT/);

  const collision = await harness(t);
  await mkdir(collision.binDir, { recursive: true, mode: 0o755 });
  await writeFile(join(collision.binDir, "pi-daemon"), "unrelated", { mode: 0o755 });
  await assert.rejects(
    collision.updater.run(),
    (error) => error instanceof SelfUpdateError && error.code === "update_bin_collision",
  );
  assert.equal(collision.installs.length, 0);
});

test("verified releases retain only the active and one rollback target", async (t) => {
  const h = await harness(t);
  await h.updater.run();
  h.setVersion("0.1.2");
  await h.updater.run();
  h.setVersion("0.1.3");
  await h.updater.run();
  let status = await h.updater.status();
  assert.equal(status.activeVersion, "0.1.3");
  assert.equal(status.previousVersion, "0.1.2");
  await assert.rejects(lstat(join(h.installRoot, "versions", "0.1.1")), /ENOENT/);

  status = await h.updater.rollback();
  assert.equal(status.activeVersion, "0.1.2");
  assert.equal(status.previousVersion, "0.1.3");
  assert.match(await realpath(join(h.binDir, "pi-daemon")), /versions\/0\.1\.2\//);
});

test("the owner-private update lock rejects concurrent installers", async (t) => {
  const h = await harness(t);
  let releaseInstall;
  const entered = new Promise((resolve) => { releaseInstall = resolve; });
  let continueInstall;
  const blocked = new Promise((resolve) => { continueInstall = resolve; });
  const updater = new PiDaemonSelfUpdater(
    { installRoot: h.installRoot, binDir: h.binDir },
    {
      fetch: h.fetch,
      randomId: (() => { let id = 100; return () => `concurrent-${++id}`; })(),
      runNpmInstall: async (input) => {
        releaseInstall();
        await blocked;
        await h.runNpmInstall(input);
      },
    },
  );
  const first = updater.run();
  await entered;
  await assert.rejects(
    updater.run(),
    (error) => error instanceof SelfUpdateError && error.code === "update_busy" && error.retryable,
  );
  continueInstall();
  await first;
});

test("group/world-writable bin directories are refused", async (t) => {
  const h = await harness(t);
  await mkdir(h.binDir, { recursive: true, mode: 0o755 });
  await chmod(h.binDir, 0o777);
  await assert.rejects(
    h.updater.run(),
    (error) => error instanceof SelfUpdateError && error.code === "update_bin_dir_insecure",
  );
});
