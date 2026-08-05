import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readlink, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";

const run = promisify(execFile);
const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const phaseRunner = join(repositoryRoot, "scripts", "run-nix-ci-phase.sh");
const packageRunner = join(repositoryRoot, "scripts", "run-nix-ci-package.sh");

async function runPhase(logDir, phase, command) {
  return run("bash", [phaseRunner, phase, "bash", "-c", command], {
    env: { ...process.env, PI_DAEMON_NIX_CI_LOG_DIR: logDir },
  });
}

test("the Nix CI phase runner records duration and preserves a failing test status", async () => {
  const logDir = await mkdtemp(join(tmpdir(), "pi-daemon-nix-ci-"));
  try {
    await runPhase(logDir, "successful-test", 'printf "healthy test\\n"');
    await assert.rejects(
      runPhase(logDir, "deliberately-failing-test", 'printf "deliberate failure\\n"; exit 23'),
      (error) => error.code === 23,
    );

    const telemetry = await readFile(join(logDir, "phases.log"), "utf8");
    assert.match(
      telemetry,
      /phase=successful-test event=finish .*duration_seconds=\d+ status=0 result=success/,
    );
    assert.match(
      telemetry,
      /phase=deliberately-failing-test event=finish .*duration_seconds=\d+ status=23 result=failure/,
    );
    assert.match(await readFile(join(logDir, "successful-test.log"), "utf8"), /healthy test/);
    assert.match(
      await readFile(join(logDir, "deliberately-failing-test.log"), "utf8"),
      /deliberate failure/,
    );
  } finally {
    await rm(logDir, { recursive: true, force: true });
  }
});

test("macOS CI forces a job-unique normal package build before the bounded full-flake verdict", async () => {
  const cacheReporterPath = join(repositoryRoot, "scripts", "report-nix-ci-cache-state.sh");
  const [workflow, cacheReporter, packageRunnerSource, flake] = await Promise.all([
    readFile(join(repositoryRoot, ".github", "workflows", "ci-macos.yml"), "utf8"),
    readFile(cacheReporterPath, "utf8"),
    readFile(packageRunner, "utf8"),
    readFile(join(repositoryRoot, "flake.nix"), "utf8"),
    run("bash", ["-n", phaseRunner]),
    run("bash", ["-n", cacheReporterPath]),
    run("bash", ["-n", packageRunner]),
  ]);

  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /runs-on: \[self-hosted, macos\]\n\s+timeout-minutes: 80/);
  assert.match(workflow, /PI_DAEMON_NIX_CI_BUILD_NONCE=github-%s-%s/);
  assert.match(workflow, /bash scripts\/report-nix-ci-cache-state\.sh/);
  assert.match(workflow, /package_store_state \}\}" != missing/);
  assert.match(workflow, /bash scripts\/run-nix-ci-package\.sh/);
  assert.match(workflow, /timeout-minutes: 75/);
  assert.doesNotMatch(workflow, /--rebuild/);
  assert.match(
    workflow,
    /run-nix-ci-phase\.sh flake-check[\s\\]+nix flake check --impure --print-build-logs/,
  );
  assert.match(workflow, /nix run --impure \.#pi-daemon -- version/);
  assert.match(workflow, /if: inputs\.deliberate_test_failure/);
  assert.match(workflow, /run-nix-ci-phase\.sh deliberately-failing-test/);
  assert.doesNotMatch(workflow, /continue-on-error/);
  assert.match(workflow, /if: always\(\)[\s\S]*actions\/upload-artifact@v4/);

  assert.match(cacheReporter, /nix eval --impure --raw "\$\{package_installable\}\.outPath"/);
  assert.match(cacheReporter, /print_url_config substituters/);
  assert.match(cacheReporter, /print_url_config trusted-substituters/);
  assert.match(cacheReporter, /nix config show trusted-public-keys/);
  assert.match(cacheReporter, /Nix signature verification must remain enabled/);
  assert.match(cacheReporter, /nix path-info --offline "\$package_path"/);
  assert.match(cacheReporter, /nix path-info --offline "\$npm_deps_path"/);
  assert.match(cacheReporter, /package_store_state=%s/);
  assert.match(cacheReporter, /nix build --impure --dry-run --no-link "\$package_installable"/);
  assert.doesNotMatch(cacheReporter, /access-tokens|github_access_token/);

  assert.match(packageRunnerSource, /expected_nonce="github-\$\{GITHUB_RUN_ID\}-\$\{GITHUB_RUN_ATTEMPT\}"/);
  assert.match(packageRunnerSource, /canonical_log_dir.*canonical_expected_log_dir/s);
  assert.match(packageRunnerSource, /result_link="\$package_root\/result"/);
  assert.match(packageRunnerSource, /refusing to reuse or delete it/);
  assert.match(packageRunnerSource, /nix build --impure --out-link "\$result_link" --print-build-logs/);
  assert.doesNotMatch(packageRunnerSource, /--rebuild|nix (?:store delete|store gc)|nix-store --delete|rm -rf/);

  assert.match(flake, /ciBuildNonce = builtins\.getEnv "PI_DAEMON_NIX_CI_BUILD_NONCE"/);
  assert.match(flake, /pkgs\.lib\.optionalAttrs \(ciBuildNonce != ""\)/);
  assert.match(flake, /PI_DAEMON_NIX_CI_BUILD_NONCE = ciBuildNonce/);
  assert.match(flake, /phaseStart = phase:/);
  assert.match(flake, /phaseFinish = phase:/);
  assert.match(flake, /pi-daemon-nix-phase phase=\$\{phase\} event=start/);
  assert.match(flake, /pi-daemon-nix-phase phase=\$\{phase\} event=finish/);
  for (const phase of ["build", "check", "install", "fixup", "install-check"]) {
    const attribute = phase === "install-check" ? "InstallCheck" : `${phase[0].toUpperCase()}${phase.slice(1)}`;
    assert.match(flake, new RegExp(`pre${attribute} = phaseStart "${phase}"`));
    assert.match(flake, new RegExp(`post${attribute} = phaseFinish "${phase}"`));
  }
  assert.match(flake, /runHook preInstallCheck/);
  assert.match(flake, /runHook postInstallCheck/);
});

test("the macOS package runner takes the absent-output path without rebuild or shared-store deletion", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-daemon-nix-cold-package-"));
  const runnerTemp = join(root, "runner-temp");
  const fakeBin = join(root, "bin");
  const fakeNix = join(fakeBin, "nix");
  const argsPath = join(root, "nix-args");
  const noncePath = join(root, "nix-nonce");
  const outputPath = join(root, "store", "cold-package-output");
  const logDir = join(runnerTemp, "pi-daemon-nix-macos-12345-2");

  try {
    await mkdir(fakeBin, { recursive: true });
    await mkdir(runnerTemp, { recursive: true });
    const canonicalRoot = await realpath(root);
    const resultLink = join(
      canonicalRoot,
      "runner-temp",
      "pi-daemon-nix-macos-12345-2",
      "package-build",
      "result",
    );
    const { stdout: bashOutput } = await run("bash", ["-c", "command -v bash"]);
    const bashPath = bashOutput.trim();
    assert.match(bashPath, /^\//, "the test lane must provide an absolute Bash interpreter");
    await writeFile(
      fakeNix,
      `#!${bashPath}
set -euo pipefail
printf '%s\\n' "$@" > "$FAKE_NIX_ARGS"
printf '%s\\n' "$PI_DAEMON_NIX_CI_BUILD_NONCE" > "$FAKE_NIX_NONCE"
out_link=""
while [[ "$#" -gt 0 ]]; do
  if [[ "$1" == --out-link ]]; then
    shift
    out_link="$1"
  fi
  shift
done
[[ -n "$out_link" ]]
[[ ! -e "$out_link" && ! -L "$out_link" ]]
mkdir -p "$FAKE_NIX_OUTPUT"
ln -s "$FAKE_NIX_OUTPUT" "$out_link"
printf 'cold normal package build\\n'
`,
      { mode: 0o755 },
    );
    await chmod(fakeNix, 0o755);

    await assert.rejects(readlink(resultLink), (error) => error.code === "ENOENT");
    const result = await run("bash", [packageRunner, "aarch64-darwin"], {
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH}`,
        RUNNER_TEMP: runnerTemp,
        GITHUB_RUN_ID: "12345",
        GITHUB_RUN_ATTEMPT: "2",
        PI_DAEMON_NIX_CI_LOG_DIR: logDir,
        PI_DAEMON_NIX_CI_BUILD_NONCE: "github-12345-2",
        FAKE_NIX_ARGS: argsPath,
        FAKE_NIX_NONCE: noncePath,
        FAKE_NIX_OUTPUT: outputPath,
      },
    });

    assert.match(result.stdout, /cold normal package build/);
    assert.deepEqual((await readFile(argsPath, "utf8")).trim().split("\n"), [
      "build",
      "--impure",
      "--out-link",
      resultLink,
      "--print-build-logs",
      ".#checks.aarch64-darwin.package",
    ]);
    assert.equal(await readFile(noncePath, "utf8"), "github-12345-2\n");
    assert.equal(await readlink(resultLink), outputPath);
    assert.match(
      await readFile(join(logDir, "phases.log"), "utf8"),
      /phase=package-build event=finish .*status=0 result=success/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
