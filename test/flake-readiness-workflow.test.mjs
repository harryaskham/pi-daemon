import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parse } from "yaml";

const root = fileURLToPath(new URL("../", import.meta.url));

async function workflowSource() {
  return readFile(`${root}/.github/workflows/flake-readiness.yml`, "utf8");
}

test("Flake readiness covers PR recovery, main push, and exact-head manual fallback", async () => {
  const source = await workflowSource();
  const workflow = parse(source);
  const triggers = workflow.on;

  assert.deepEqual(triggers.push.branches, ["main"]);
  assert.deepEqual(triggers.pull_request.types, [
    "opened",
    "reopened",
    "synchronize",
    "ready_for_review",
  ]);
  assert.equal(triggers.pull_request.paths, undefined);
  assert.equal(triggers.check_suite, undefined);
  assert.equal(triggers.workflow_dispatch.inputs.expected_sha.required, true);
  assert.equal(triggers.workflow_dispatch.inputs.expected_sha.type, "string");

  assert.equal(workflow.permissions.contents, "read");
  assert.equal(workflow.permissions.checks, undefined);
  assert.equal(workflow.jobs.readiness.name, "Flake readiness");
  assert.match(
    workflow.concurrency.group,
    /github\.event\.pull_request\.number \|\| github\.ref/,
  );
  assert.match(
    workflow.jobs.readiness.if,
    /github\.event\.pull_request\.head\.repo\.id == github\.event\.repository\.id/,
  );

  assert.match(source, /if: github\.event_name == 'workflow_dispatch'/);
  assert.match(source, /EXPECTED_SHA: \$\{\{ inputs\.expected_sha \}\}/);
  assert.match(source, /\^\[0-9a-f\]\{40\}\$/);
  assert.match(source, /actual_sha="\$\(git rev-parse HEAD\)"/);
  assert.match(source, /"\$actual_sha" != "\$EXPECTED_SHA"/);
  assert.doesNotMatch(source, /continue-on-error|checks\.create|actions\/github-script/);
});
