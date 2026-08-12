import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const rootDir = fileURLToPath(new URL("../", import.meta.url));

async function source(relativePath) {
  return readFile(path.join(rootDir, relativePath), "utf8");
}

test("just install builds a portable npm package inside the pinned dev shell", async (t) => {
  const [justfile, installer, manifest, readme] = await Promise.all([
    source("Justfile"),
    source("scripts/install-local.sh"),
    source("package.json"),
    source("README.md"),
  ]);

  assert.match(justfile, /\ninstall:\n\s+nix develop --command bash scripts\/install-local\.sh/);
  assert.match(installer, /IN_NIX_SHELL/);
  assert.match(installer, /PI_DAEMON_INSTALL_PREFIX:-\$\{HOME:\?HOME is required\}\/\.local/);
  assert.match(installer, /npm ci --ignore-scripts --no-audit --no-fund/);
  assert.match(installer, /npm pack --pack-destination "\$stage"/);
  assert.match(installer, /npm install \\\n\s+--global \\\n\s+--prefix "\$prefix"/);
  assert.match(installer, /--ignore-scripts/);
  assert.match(installer, /--omit=dev/);
  assert.match(installer, /"\$daemon_bin" version/);
  assert.match(installer, /"\$rpc_bin" --version/);
  assert.match(installer, /resolved.*== \/nix\/store\/\*/s);
  assert.match(installer, /No service was restarted/);
  assert.doesNotMatch(installer, /nix build|result\/bin|cp .*\/nix\/store/);

  const packageJson = JSON.parse(manifest);
  assert.equal(packageJson.bin["pi-daemon"], "dist/cli.js");
  assert.equal(packageJson.bin["pi-daemon-rpc"], "dist/rpc-stdio-cli.js");
  assert.match(readme, /\*\*Install current checkout:\*\* run `just install`/);
  assert.match(readme, /neither resolves into the Nix\s+store/);
  assert.match(readme, /does not\nrestart any service/);

  await t.test("direct execution outside the dev shell fails before npm", async () => {
    const child = spawn("bash", [path.join(rootDir, "scripts/install-local.sh")], {
      cwd: rootDir,
      env: { ...process.env, IN_NIX_SHELL: "" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    const status = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    assert.equal(status, 78);
    assert.equal(Buffer.concat(stdout).toString("utf8"), "");
    assert.match(Buffer.concat(stderr).toString("utf8"), /must run inside the Pi Daemon Nix dev shell/);
  });
});
