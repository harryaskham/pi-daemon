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

function assertAcceptanceBoundaries({ manifest, flake, ci, macos, scheduled, closure }) {
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
  assert.match(closure, /group: pi-daemon-closure-\$\{\{ matrix\.system \}\}/);
  assert.match(closure, /cancel-in-progress: false/);
  assert.match(closure, /fail-fast: false/);
  for (const system of ["aarch64-linux", "x86_64-linux", "aarch64-darwin", "x86_64-darwin"]) {
    assert.match(closure, new RegExp(`system: ${system}`));
  }
  assert.match(closure, /runner: \[self-hosted, nix, x86_64-linux\]/);
  assert.match(closure, /runner: \[self-hosted, macos\]/);
  assert.match(closure, /TARGET_SYSTEM: \$\{\{ matrix\.system \}\}/);
  assert.match(closure, /XDG_CONFIG_HOME: \$\{\{ runner\.temp \}\}\/pi-daemon-closure-\$\{\{ matrix\.system \}\}-xdg/);
  assert.match(closure, /extra-platforms/);
  assert.match(closure, /TARGET_EXECUTION" == binfmt/);
  assert.match(closure, /\/proc\/sys\/fs\/binfmt_misc\/\*aarch64\*/);
  assert.match(closure, /vars\.PI_DAEMON_ATTIC_ENDPOINT/);
  assert.match(closure, /vars\.PI_DAEMON_ATTIC_CACHE/);
  assert.match(closure, /secrets\.PI_DAEMON_ATTIC_TOKEN/);
  assert.doesNotMatch(closure, /PI_DAEMON_FEEDBACK/);
  assert.match(flake, /closurePublisher = pkgs\.mkShell \{/);
  assert.match(flake, /packages = commonPackages \+\+ \[pkgs\.attic-client\]/);
  assert.doesNotMatch(closure, /nixpkgs#attic-client|command -v attic|ATTIC_BIN/);
  assert.doesNotMatch(closure, /\bmapfile\b/);
  assert.match(closure, /export CURRENT_SYSTEM="\$current_system"/);
  assert.match(closure, /nix develop \.#closurePublisher --command attic --version/);
  assert.match(closure, /nix develop \.#closurePublisher --command attic login --set-default pi-daemon-ci/);
  assert.match(closure, /nix develop \.#closurePublisher --command attic cache info "pi-daemon-ci:\$\{ATTIC_CACHE\}"/);
  assert.match(closure, /nix develop \.#closurePublisher --command attic use "pi-daemon-ci:\$\{ATTIC_CACHE\}"/);
  assert.match(closure, /"\.\#packages\.\$\{TARGET_SYSTEM\}\.pi-daemon"/);
  assert.match(closure, /--option require-sigs true/);
  assert.match(closure, /cache\.nixos\.org/);
  assert.match(closure, /expectedAttic/);
  assert.match(closure, /PACKAGE_OUT: \$\{\{ steps\.build\.outputs\.out \}\}/);
  assert.match(closure, /nix develop \.#closurePublisher --command attic push -j1 "pi-daemon-ci:\$\{ATTIC_CACHE\}" "\$PACKAGE_OUT"/);
  assert.match(closure, /closure-cache-\$\{\{ matrix\.system \}\}-\$\{\{ github\.run_id \}\}/);
  assert.match(closure, /Remove Attic credentials\n\s+if: always\(\)/);

  const login = closure.indexOf("nix develop .#closurePublisher --command attic login --set-default");
  const use = closure.indexOf('nix develop .#closurePublisher --command attic use "pi-daemon-ci:${ATTIC_CACHE}"');
  const build = closure.indexOf('".#packages.${TARGET_SYSTEM}.pi-daemon"');
  const push = closure.indexOf('nix develop .#closurePublisher --command attic push -j1 "pi-daemon-ci:${ATTIC_CACHE}" "$PACKAGE_OUT"');
  assert.ok(login < use && use < build && build < push, "Attic must be additive before each exact build and push");
}

const sources = async () => {
  const [manifest, flake, ci, macos, scheduled, closure] = await Promise.all([
    readFile(join(repositoryRoot, "package.json"), "utf8").then(JSON.parse),
    readFile(join(repositoryRoot, "flake.nix"), "utf8"),
    readFile(join(repositoryRoot, ".github/workflows/ci.yml"), "utf8"),
    readFile(join(repositoryRoot, ".github/workflows/ci-macos.yml"), "utf8"),
    readFile(join(repositoryRoot, ".github/workflows/consumer-acceptance.yml"), "utf8"),
    readFile(join(repositoryRoot, ".github/workflows/closure-cache.yml"), "utf8"),
  ]);
  return { manifest, flake, ci, macos, scheduled, closure };
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
        flake: actual.flake.replace("[pkgs.attic-client]", "[pkgs.hello]"),
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
      name: "publisher pushes something other than the captured exact output",
      value: {
        ...actual,
        closure: actual.closure.replace(
          'nix develop .#closurePublisher --command attic push -j1 "pi-daemon-ci:${ATTIC_CACHE}" "$PACKAGE_OUT"',
          'nix develop .#closurePublisher --command attic push -j1 "pi-daemon-ci:${ATTIC_CACHE}" ".#pi-daemon"',
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
