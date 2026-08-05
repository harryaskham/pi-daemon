import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const run = promisify(execFile);
const retryScript = new URL("../scripts/prefetch-npm-deps-retry.sh", import.meta.url).pathname;
const npmDepsNix = new URL("../nix/npm-deps.nix", import.meta.url).pathname;
const flakeNix = new URL("../flake.nix", import.meta.url).pathname;

async function resolveBash() {
  if (process.env.BASH?.startsWith("/")) return process.env.BASH;
  const result = await run("bash", ["-c", 'printf %s "$BASH"']);
  const bash = result.stdout.trim();
  assert.match(bash, /^\//, "resolved Bash must be an absolute path for a shebang");
  return bash;
}

async function fixture(t, mode) {
  const root = await mkdtemp(join(tmpdir(), "pi-daemon-npm-retry-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const countFile = join(root, "count");
  const lockfile = join(root, "package-lock.json");
  const output = join(root, "output");
  const fake = join(root, "prefetch-npm-deps");
  const bash = await resolveBash();
  await writeFile(lockfile, "{}\n");
  await writeFile(fake, `#!${bash}
set -euo pipefail
count=0
if [[ -f "$FAKE_COUNT_FILE" ]]; then count="$(<"$FAKE_COUNT_FILE")"; fi
count=$((count + 1))
printf '%s' "$count" > "$FAKE_COUNT_FILE"
mkdir -p "$2"
printf 'partial-%s\n' "$count" > "$2/partial"
case "$FAKE_MODE" in
  transient-success)
    if [[ "$count" -eq 1 ]]; then
      echo 'curl error [92]: HTTP/2 framing layer while fetching lightningcss-linux-arm64-gnu-1.32.0.tgz' >&2
      exit 92
    fi
    printf 'complete\n' > "$2/complete"
    exit 0
    ;;
  transient-failure)
    echo 'curl error [92]: HTTP/2 framing layer while fetching lightningcss-linux-arm64-gnu-1.32.0.tgz' >&2
    exit 92
    ;;
  integrity-failure)
    echo 'integrity checksum mismatch for lightningcss-linux-arm64-gnu-1.32.0.tgz' >&2
    exit 1
    ;;
  http2-client-error)
    echo 'HTTP/2 404 package identity not found for lightningcss-linux-arm64-gnu-1.32.0.tgz' >&2
    exit 1
    ;;
  *)
    echo 'unknown fixture mode' >&2
    exit 2
    ;;
esac
`);
  await chmod(fake, 0o755);
  const env = {
    ...process.env,
    FAKE_COUNT_FILE: countFile,
    FAKE_MODE: mode,
    PREFETCH_NPM_DEPS_BIN: fake,
    PI_DAEMON_NPM_FETCH_MAX_ATTEMPTS: "3",
    PI_DAEMON_NPM_FETCH_INITIAL_BACKOFF_SECS: "0",
  };
  return { root, countFile, lockfile, output, env };
}

async function invoke(fixture) {
  try {
    // bd-833b3e: `/bin/bash` does not exist in NixOS or in the Nix test
    // sandbox. Use the shell the execution environment actually provides; Nix
    // exports BASH as an exact store path, and ordinary hosts resolve `bash`
    // from PATH. The production Nix call site separately pins `${pkgs.bash}`.
    const bash = process.env.BASH || "bash";
    const result = await run(bash, [retryScript, fixture.lockfile, fixture.output], {
      env: fixture.env,
    });
    return { code: 0, output: `${result.stdout}${result.stderr}` };
  } catch (error) {
    return {
      code: error.code ?? 1,
      output: `${error.stdout ?? ""}${error.stderr ?? ""}`,
    };
  }
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

test("retry fixture uses pinned Nix Bash instead of /bin/bash", async () => {
  const [source, flake] = await Promise.all([
    readFile(new URL(import.meta.url), "utf8"),
    readFile(flakeNix, "utf8"),
  ]);
  assert.doesNotMatch(source, /run\("\/bin\/bash"/);
  assert.doesNotMatch(source, /#!\/usr\/bin\/env bash/);
  assert.match(source, /const bash = await resolveBash\(\)/);
  assert.match(source, /`#!\$\{bash\}\n/);
  assert.match(source, /process\.env\.BASH \|\| "bash"/);
  assert.match(
    flake,
    /nativeBuildInputs = \[[^\]]*pkgs\.makeWrapper[^\]]*pkgs\.openssl[^\]]*pkgs\.bash[^\]]*\]/,
    "Nix package checks must put pinned Bash on PATH",
  );
});

test("Nix build invokes the retry script through pinned bash, not its env shebang", async () => {
  const source = await readFile(npmDepsNix, "utf8");
  assert.match(
    source,
    /\$\{pkgs\.bash\}\/bin\/bash \$\{\.\.\/scripts\/prefetch-npm-deps-retry\.sh\}/,
  );
  assert.doesNotMatch(
    source,
    /^\s*\$\{\.\.\/scripts\/prefetch-npm-deps-retry\.sh\}/m,
  );
});

test("recognized HTTP/2 transport failure retries and reuses the bounded output cache", async (t) => {
  const h = await fixture(t, "transient-success");
  const result = await invoke(h);
  assert.equal(result.code, 0, result.output);
  assert.equal(await readFile(h.countFile, "utf8"), "2");
  assert.equal(await readFile(join(h.output, "complete"), "utf8"), "complete\n");
  assert.match(result.output, /"state":"retrying"/);
  assert.match(result.output, /"transportClass":"http2_framing"/);
  assert.match(result.output, /"dependency":"lightningcss-linux-arm64-gnu-1\.32\.0\.tgz"/);
  assert.match(result.output, /"cleanup":"partial_cache_retained"/);
  assert.match(result.output, /"state":"completed","attempt":2/);
});

test("persistent transient failure stops at the exact bound and removes partial output", async (t) => {
  const h = await fixture(t, "transient-failure");
  const result = await invoke(h);
  assert.notEqual(result.code, 0);
  assert.equal(await readFile(h.countFile, "utf8"), "3");
  assert.equal(await exists(h.output), false);
  assert.match(result.output, /"state":"failed"/);
  assert.match(result.output, /"attempt":3,"maxAttempts":3/);
  assert.match(result.output, /"cleanup":"output_removed"/);
});

test("integrity failure is immediate and never normalized into transport retry", async (t) => {
  const h = await fixture(t, "integrity-failure");
  const result = await invoke(h);
  assert.notEqual(result.code, 0);
  assert.equal(await readFile(h.countFile, "utf8"), "1");
  assert.equal(await exists(h.output), false);
  assert.doesNotMatch(result.output, /"state":"retrying"/);
  assert.match(result.output, /"transportClass":"non_transient"/);
  assert.match(result.output, /integrity checksum mismatch/);
});

test("an HTTP/2 client or identity error without framing evidence is not retried", async (t) => {
  const h = await fixture(t, "http2-client-error");
  const result = await invoke(h);
  assert.notEqual(result.code, 0);
  assert.equal(await readFile(h.countFile, "utf8"), "1");
  assert.equal(await exists(h.output), false);
  assert.doesNotMatch(result.output, /"state":"retrying"/);
  assert.match(result.output, /"transportClass":"non_transient"/);
});
