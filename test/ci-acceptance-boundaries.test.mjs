import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function installCheckPhase(flake) {
  const match = flake.match(/installCheckPhase = ''([\s\S]*?)'';/);
  assert.ok(match, "flake must retain an explicit installCheckPhase");
  return match[1];
}

function triggerBlock(workflow) {
  const start = workflow.indexOf("on:\n");
  const end = workflow.indexOf("\npermissions:", start);
  assert.notEqual(start, -1, "workflow must declare triggers");
  assert.notEqual(end, -1, "workflow triggers must end before permissions");
  return workflow.slice(start, end);
}

function closureJobEnv(workflow) {
  const match = workflow.match(/\n    env:\n([\s\S]*?)\n    steps:/);
  assert.ok(match, "closure publisher must declare a bounded job environment");
  return match[1];
}

function assertAcceptanceBoundaries({ manifest, flake, ci, macos, scheduled, closure, actionlintConfig }) {
  assert.match(manifest.scripts.test, /test\/\*\.test\.mjs/);
  assert.doesNotMatch(manifest.scripts.test, /consumer-acceptance/);
  assert.doesNotMatch(manifest.scripts["test:unit"], /consumer-acceptance/);
  assert.equal(
    manifest.scripts["test:consumer-acceptance:built"],
    "node --test --test-concurrency=1 test/acceptance/consumer-acceptance.test.mjs",
  );

  const installCheck = installCheckPhase(flake);
  assert.match(installCheck, /pi-daemon" version \| grep -Fx 0\.3\.0/);
  assert.match(installCheck, /pi-daemon-rpc" --version \| grep -Fx 0\.3\.0/);
  assert.doesNotMatch(installCheck, /consumer-acceptance|node --test/);
  assert.doesNotMatch(`${ci}\n${macos}`, /consumer-acceptance/);

  const scheduledTriggers = triggerBlock(scheduled);
  assert.match(scheduledTriggers, /schedule:/);
  assert.match(scheduledTriggers, /workflow_dispatch:/);
  assert.doesNotMatch(scheduledTriggers, /\bpush:|pull_request:/);
  assert.match(scheduled, /PI_DAEMON_PACKAGED_BIN: \$\{\{ steps\.package\.outputs\.out \}\}\/bin\/pi-daemon/);
  assert.match(scheduled, /npm run test:consumer-acceptance:built/);
  assert.match(scheduled, /if: steps\.acceptance\.outcome == 'failure'/);
  assert.match(scheduled, /secrets\.PI_DAEMON_FEEDBACK_WEBHOOK_URL/);
  assert.match(scheduled, /secrets\.PI_DAEMON_FEEDBACK_WEBHOOK_TOKEN/);
  assert.match(scheduled, /\["test-failure", "broken-on-main", "ci", "consumer-acceptance"\]/);
  assert.match(scheduled, /actions\/upload-artifact@v4/);
  assert.match(scheduled, /if: always\(\)/);

  assert.match(closure, /runs-on: \$\{\{ matrix\.runner \}\}/);
  assert.match(closure, /environment: pi-daemon-aarch64-cache/);
  assert.match(closure, /cachix\/install-nix-action@v31[\s\S]*?set_as_trusted_user: false/);
  assert.match(closure, /group: pi-daemon-closure-\$\{\{ matrix\.system \}\}/);
  assert.match(closure, /cancel-in-progress: false/);
  assert.match(closure, /fail-fast: false/);
  for (const system of ["aarch64-linux", "x86_64-linux", "aarch64-darwin", "x86_64-darwin"]) {
    assert.match(closure, new RegExp(`system: ${system}`));
  }
  assert.match(closure, /runner: \[self-hosted, nix, x86_64-linux\]/);
  assert.match(closure, /runner: \[self-hosted, macos\]/);
  assert.match(closure, /TARGET_SYSTEM: \$\{\{ matrix\.system \}\}/);
  assert.doesNotMatch(closureJobEnv(closure), /\$\{\{ runner\./);
  assert.match(closure, /echo "XDG_CONFIG_HOME=\$RUNNER_TEMP\/pi-daemon-closure-\$TARGET_SYSTEM-xdg" >> "\$GITHUB_ENV"/);
  assert.match(closure, /extra-platforms/);
  assert.match(closure, /TARGET_EXECUTION" == binfmt/);
  assert.match(closure, /\/proc\/sys\/fs\/binfmt_misc\/\*aarch64\*/);
  assert.match(closure, /vars\.PI_DAEMON_ATTIC_ENDPOINT/);
  assert.match(closure, /vars\.PI_DAEMON_ATTIC_CACHE/);
  assert.doesNotMatch(closureJobEnv(closure), /PI_DAEMON_ATTIC_TOKEN/);
  assert.equal((closure.match(/secrets\.PI_DAEMON_ATTIC_TOKEN/g) ?? []).length, 1);
  assert.match(closure, /ATTIC_TOKEN: \$\{\{ secrets\.PI_DAEMON_ATTIC_TOKEN \}\}/);
  assert.doesNotMatch(closure, /PI_DAEMON_FEEDBACK/);
  assert.match(flake, /closurePublisher = pkgs\.mkShell \{/);
  assert.match(flake, /packages = commonPackages \+\+ \[pkgs\.actionlint pkgs\.attic-client\]/);
  assert.match(flake, /workflow-syntax =\s+pkgs\.runCommand/);
  assert.match(flake, /nativeBuildInputs = \[pkgs\.actionlint\]/);
  assert.match(flake, /actionlint -config-file \$\{\.\/\.github\/actionlint\.yaml\}/);
  assert.match(actionlintConfig, /self-hosted-runner:/);
  assert.match(actionlintConfig, /- nix/);
  assert.match(actionlintConfig, /- x86_64-linux/);
  assert.doesNotMatch(closure, /nixpkgs#attic-client|command -v attic|ATTIC_BIN/);
  assert.doesNotMatch(closure, /\b(?:awk|cat|mapfile)\b/);
  assert.match(closure, /nix store ping --json/);
  assert.match(closure, /process\.env\.RUNNER_OS === "Linux"/);
  assert.match(closure, /store\.trusted === 1 \|\| store\.trusted === true/);
  assert.match(closure, /shared github-runner principal is unexpectedly a trusted Nix client/);
  assert.match(closure, /export CURRENT_SYSTEM="\$current_system"/);
  assert.match(closure, /nix develop \.#closurePublisher --command attic --version/);
  assert.match(closure, /nix develop \.#closurePublisher --command attic login --set-default pi-daemon-ci/);
  assert.match(closure, /nix develop \.#closurePublisher --command attic cache info "pi-daemon-ci:\$\{ATTIC_CACHE\}"/);
  assert.doesNotMatch(closure, /nix develop \.#closurePublisher --command attic use/);
  assert.match(closure, /ATTIC_SUBSTITUTER=\$attic_substituter/);
  assert.match(closure, /"\.\#packages\.\$\{TARGET_SYSTEM\}\.pi-daemon"/);
  assert.match(closure, /--option require-sigs true/);
  assert.match(closure, /cache\.nixos\.org/);
  assert.match(closure, /expectedAttic/);
  assert.match(closure, /exact Attic cache .* is not declared by the host Nix configuration/);
  assert.match(closure, /collective cache signing key/);
  assert.match(closure, /PACKAGE_OUT: \$\{\{ steps\.build\.outputs\.out \}\}/);
  assert.match(closure, /nix develop \.#closurePublisher --command attic push -j1 --ignore-upstream-cache-filter "pi-daemon-ci:\$\{ATTIC_CACHE\}" "\$PACKAGE_OUT"/);
  assert.match(closure, /nix copy --option require-sigs true/);
  assert.doesNotMatch(closure, /nix copy --no-recursive/);
  assert.match(closure, /--from "\$ATTIC_SUBSTITUTER"/);
  assert.match(closure, /--to "\$hydration_store"/);
  assert.match(closure, /canonical_runner_temp="\$\(cd "\$RUNNER_TEMP" && pwd -P\)"/);
  assert.match(closure, /nix path-info --store "\$hydration_store" "\$PACKAGE_OUT"/);
  assert.match(closure, /attic-hydrated-output/);
  assert.match(closure, /closure-cache-\$\{\{ matrix\.system \}\}-\$\{\{ github\.run_id \}\}/);
  assert.match(closure, /Remove Attic credentials\n\s+if: always\(\)/);

  const trustBoundary = closure.indexOf("shared github-runner principal is unexpectedly a trusted Nix client");
  const build = closure.indexOf('".#packages.${TARGET_SYSTEM}.pi-daemon"');
  const login = closure.indexOf("nix develop .#closurePublisher --command attic login --set-default");
  const push = closure.indexOf('nix develop .#closurePublisher --command attic push -j1 --ignore-upstream-cache-filter "pi-daemon-ci:${ATTIC_CACHE}" "$PACKAGE_OUT"');
  const credentialRemoval = closure.indexOf('rm -rf "$XDG_CONFIG_HOME"', push);
  const hydrate = closure.indexOf("nix copy --option require-sigs true");
  assert.ok(trustBoundary < build && build < login && login < push && push < credentialRemoval && credentialRemoval < hydrate, "untrusted-client proof and exact build must precede push-only credentials, cleanup, and signed hydration");
}

const sources = async () => {
  const [manifest, flake, ci, macos, scheduled, closure, actionlintConfig] = await Promise.all([
    readFile(join(repositoryRoot, "package.json"), "utf8").then(JSON.parse),
    readFile(join(repositoryRoot, "flake.nix"), "utf8"),
    readFile(join(repositoryRoot, ".github/workflows/ci.yml"), "utf8"),
    readFile(join(repositoryRoot, ".github/workflows/ci-macos.yml"), "utf8"),
    readFile(join(repositoryRoot, ".github/workflows/consumer-acceptance.yml"), "utf8"),
    readFile(join(repositoryRoot, ".github/workflows/closure-cache.yml"), "utf8"),
    readFile(join(repositoryRoot, ".github/actionlint.yaml"), "utf8"),
  ]);
  return { manifest, flake, ci, macos, scheduled, closure, actionlintConfig };
};

test("consumer acceptance is scheduled rather than a continuous build or install gate", async () => {
  assertAcceptanceBoundaries(await sources());
});

test("CI boundary checks reject regressions in every asserted direction", async () => {
  const actual = await sources();
  const mutations = [
    {
      name: "consumer acceptance restored to npm test",
      value: {
        ...actual,
        manifest: {
          ...actual.manifest,
          scripts: {
            ...actual.manifest.scripts,
            test: `${actual.manifest.scripts.test} test/acceptance/consumer-acceptance.test.mjs`,
          },
        },
      },
    },
    {
      name: "consumer acceptance restored to installCheck",
      value: {
        ...actual,
        flake: actual.flake.replace(
          '"$out/bin/pi-daemon-rpc" --version | grep -Fx 0.3.0',
          '"$out/bin/pi-daemon-rpc" --version | grep -Fx 0.3.0\n          node --test test/acceptance/consumer-acceptance.test.mjs',
        ),
      },
    },
    {
      name: "scheduled workflow no longer runs consumer acceptance",
      value: {
        ...actual,
        scheduled: actual.scheduled.replace("npm run test:consumer-acceptance:built", "npm run check"),
      },
    },
    {
      name: "publisher drops Darwin x86 from the supported matrix",
      value: {
        ...actual,
        closure: actual.closure.replace("system: x86_64-darwin", "system: omitted-darwin"),
      },
    },
    {
      name: "publisher shell stops supplying the pinned Attic client",
      value: {
        ...actual,
        flake: actual.flake.replace("[pkgs.actionlint pkgs.attic-client]", "[pkgs.actionlint pkgs.hello]"),
      },
    },
    {
      name: "Nix setup restores root-equivalent trust for the shared runner",
      value: {
        ...actual,
        closure: actual.closure.replace("set_as_trusted_user: false", "set_as_trusted_user: true"),
      },
    },
    {
      name: "publisher restores forbidden runner context at job scope",
      value: {
        ...actual,
        closure: actual.closure.replace(
          "      ATTIC_ENDPOINT: ${{ vars.PI_DAEMON_ATTIC_ENDPOINT }}",
          "      XDG_CONFIG_HOME: ${{ runner.temp }}/bad\n      ATTIC_ENDPOINT: ${{ vars.PI_DAEMON_ATTIC_ENDPOINT }}",
        ),
      },
    },
    {
      name: "publisher stops proving the shared Linux runner remains untrusted",
      value: {
        ...actual,
        closure: actual.closure.replace("store.trusted === 1 || store.trusted === true", "store.trusted !== 1 && store.trusted !== true"),
      },
    },
    {
      name: "publisher restores the Attic secret to job scope",
      value: {
        ...actual,
        closure: actual.closure.replace(
          "      ATTIC_ENDPOINT: ${{ vars.PI_DAEMON_ATTIC_ENDPOINT }}",
          "      ATTIC_TOKEN: ${{ secrets.PI_DAEMON_ATTIC_TOKEN }}\n      ATTIC_ENDPOINT: ${{ vars.PI_DAEMON_ATTIC_ENDPOINT }}",
        ),
      },
    },
    {
      name: "publisher dynamically restores attic use",
      value: {
        ...actual,
        closure: actual.closure.replace(
          "          attic_substituter=",
          "          nix develop .#closurePublisher --command attic use \"pi-daemon-ci:${ATTIC_CACHE}\"\n          attic_substituter=",
        ),
      },
    },
    {
      name: "publisher builds the host package instead of the matrix target",
      value: {
        ...actual,
        closure: actual.closure.replace(
          '".#packages.${TARGET_SYSTEM}.pi-daemon"',
          '".#packages.x86_64-linux.pi-daemon"',
        ),
      },
    },
    {
      name: "publisher restores Attic upstream filtering and loses the self-contained closure",
      value: {
        ...actual,
        closure: actual.closure.replace("attic push -j1 --ignore-upstream-cache-filter", "attic push -j1"),
      },
    },
    {
      name: "publisher hydrates from the local store instead of Attic",
      value: {
        ...actual,
        closure: actual.closure.replace('--from "$ATTIC_SUBSTITUTER"', '--from local'),
      },
    },
    {
      name: "publisher pushes something other than the captured exact output",
      value: {
        ...actual,
        closure: actual.closure.replace(
          'nix develop .#closurePublisher --command attic push -j1 --ignore-upstream-cache-filter "pi-daemon-ci:${ATTIC_CACHE}" "$PACKAGE_OUT"',
          'nix develop .#closurePublisher --command attic push -j1 --ignore-upstream-cache-filter "pi-daemon-ci:${ATTIC_CACHE}" ".#pi-daemon"',
        ),
      },
    },
  ];

  for (const mutation of mutations) {
    assert.throws(
      () => assertAcceptanceBoundaries(mutation.value),
      undefined,
      `${mutation.name} must make the boundary check fail`,
    );
  }
});
