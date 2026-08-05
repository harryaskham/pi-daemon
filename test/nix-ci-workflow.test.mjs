import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";

const run = promisify(execFile);
const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const phaseRunner = join(repositoryRoot, "scripts", "run-nix-ci-phase.sh");

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

test("macOS CI forces an exact package rebuild before the bounded full-flake verdict", async () => {
  const cacheReporterPath = join(repositoryRoot, "scripts", "report-nix-ci-cache-state.sh");
  const [workflow, cacheReporter, flake] = await Promise.all([
    readFile(join(repositoryRoot, ".github", "workflows", "ci-macos.yml"), "utf8"),
    readFile(cacheReporterPath, "utf8"),
    readFile(join(repositoryRoot, "flake.nix"), "utf8"),
    run("bash", ["-n", phaseRunner]),
    run("bash", ["-n", cacheReporterPath]),
  ]);

  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /timeout-minutes: 150/);
  assert.match(workflow, /bash scripts\/report-nix-ci-cache-state\.sh/);
  assert.match(workflow, /case "\$\{\{ steps\.nix-state\.outputs\.package_store_state \}\}" in/);
  assert.match(workflow, /present\) package_mode\+=\(--rebuild\)/);
  assert.match(workflow, /missing\) ;;/);
  assert.match(
    workflow,
    /run-nix-ci-phase\.sh package-build[\s\\]+nix build "\$\{package_mode\[@\]\}" --no-link --print-build-logs/,
  );
  assert.match(workflow, /timeout-minutes: 90/);
  assert.match(
    workflow,
    /run-nix-ci-phase\.sh flake-check[\s\\]+nix flake check --print-build-logs/,
  );
  assert.match(workflow, /if: inputs\.deliberate_test_failure/);
  assert.match(workflow, /run-nix-ci-phase\.sh deliberately-failing-test/);
  assert.doesNotMatch(workflow, /continue-on-error/);
  assert.match(workflow, /if: always\(\)[\s\S]*actions\/upload-artifact@v4/);

  assert.match(cacheReporter, /print_url_config substituters/);
  assert.match(cacheReporter, /print_url_config trusted-substituters/);
  assert.match(cacheReporter, /nix config show trusted-public-keys/);
  assert.match(cacheReporter, /Nix signature verification must remain enabled/);
  assert.match(cacheReporter, /nix path-info --offline "\$package_path"/);
  assert.match(cacheReporter, /nix path-info --offline "\$npm_deps_path"/);
  assert.match(cacheReporter, /package_store_state=%s/);
  assert.match(cacheReporter, /nix build --dry-run --no-link "\$package_installable"/);
  assert.doesNotMatch(cacheReporter, /access-tokens|github_access_token/);

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
