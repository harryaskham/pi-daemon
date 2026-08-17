import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
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

function assertAcceptanceBoundaries({ manifest, flake, ci, macos, scheduled, workflowNames, actionlintConfig }) {
  assert.match(manifest.scripts.test, /test\/\*\.test\.mjs/);
  assert.doesNotMatch(manifest.scripts.test, /consumer-acceptance/);
  assert.doesNotMatch(manifest.scripts["test:unit"], /consumer-acceptance/);
  assert.equal(
    manifest.scripts["test:consumer-acceptance:built"],
    "node --test --test-concurrency=1 test/acceptance/consumer-acceptance.test.mjs",
  );

  const installCheck = installCheckPhase(flake);
  assert.match(installCheck, /pi-daemon" version \| grep -Fx 0\.3\.1/);
  assert.match(installCheck, /pi-daemon-rpc" --version \| grep -Fx 0\.3\.1/);
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
  assert.match(scheduled, /actions\/upload-artifact@v7/);
  assert.match(scheduled, /if: always\(\)/);

  // The prebuilt-closure publisher was removed: any system that builds
  // pi-daemon already populates the shared signed cache, so a dedicated
  // publisher only added credentialed CI surface and stale cache pins.
  assert.ok(
    !workflowNames.includes("closure-cache.yml"),
    "the closure-cache publisher workflow must stay removed",
  );
  assert.match(flake, /packages = commonPackages \+\+ \[pkgs\.actionlint\]/);
  assert.match(actionlintConfig, /self-hosted-runner:/);
}

const sources = async () => {
  const [manifest, flake, ci, macos, scheduled, workflowNames, actionlintConfig] = await Promise.all([
    readFile(join(repositoryRoot, "package.json"), "utf8").then(JSON.parse),
    readFile(join(repositoryRoot, "flake.nix"), "utf8"),
    readFile(join(repositoryRoot, ".github/workflows/ci.yml"), "utf8"),
    readFile(join(repositoryRoot, ".github/workflows/ci-macos.yml"), "utf8"),
    readFile(join(repositoryRoot, ".github/workflows/consumer-acceptance.yml"), "utf8"),
    readdir(join(repositoryRoot, ".github/workflows")),
    readFile(join(repositoryRoot, ".github/actionlint.yaml"), "utf8"),
  ]);
  return { manifest, flake, ci, macos, scheduled, workflowNames, actionlintConfig };
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
          '"$out/bin/pi-daemon-rpc" --version | grep -Fx 0.3.1',
          '"$out/bin/pi-daemon-rpc" --version | grep -Fx 0.3.1\n          node --test test/acceptance/consumer-acceptance.test.mjs',
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
      name: "closure publisher workflow returns",
      value: { ...actual, workflowNames: [...actual.workflowNames, "closure-cache.yml"] },
    },
    {
      name: "publisher shell dependency returns to the flake",
      value: {
        ...actual,
        flake: actual.flake.replace(
          "packages = commonPackages ++ [pkgs.actionlint]",
          "packages = commonPackages ++ [pkgs.actionlint pkgs.attic-client]",
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
