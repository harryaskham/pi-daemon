import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));

test("Android fast exposes flake-pinned Java before setup-gradle", async () => {
  const workflow = await readFile(`${root}/.github/workflows/android-fast.yml`, "utf8");
  const nix = workflow.indexOf("cachix/install-nix-action@v31");
  const java = workflow.indexOf("name: Expose pinned Java to Gradle action");
  const gradle = workflow.indexOf("gradle/actions/setup-gradle@v5");

  assert.ok(nix >= 0 && nix < java && java < gradle);
  assert.match(workflow, /shell: nix develop \.#android --command bash -euo pipefail \{0\}/);
  assert.doesNotMatch(workflow, /--command bash -euo pipefail -c\s*'/);
  assert.match(workflow, /gradle_user_home="\$RUNNER_TEMP\/gradle-user-home"/);
  assert.match(workflow, /mkdir -p "\$gradle_user_home"/);
  assert.match(workflow, /printf "JAVA_HOME=%s\\n" "\$JAVA_HOME" >> "\$GITHUB_ENV"/);
  assert.match(workflow, /printf "GRADLE_USER_HOME=%s\\n" "\$gradle_user_home" >> "\$GITHUB_ENV"/);
  assert.match(workflow, /printf "TMPDIR=%s\\n" "\$RUNNER_TEMP" >> "\$GITHUB_ENV"/);
  assert.match(workflow, /dirname "\$\(command -v java\)" >> "\$GITHUB_PATH"/);
  assert.ok(workflow.indexOf('mkdir -p "$gradle_user_home"') < gradle);
  assert.doesNotMatch(workflow, /actions\/setup-java/);
  assert.match(workflow, /runs-on: \[self-hosted, nix, x86_64-linux\]/);
  assert.match(
    workflow,
    /nix develop \.#android --command \\\n\s+env -u DISPLAY \\\n\s+android\/build-logic\/run-with-xvfb\.sh/,
  );
});

test("Android fast shell expressions execute in the pinned shell rather than single-quoted text", async () => {
  const workflow = await readFile(`${root}/.github/workflows/android-fast.yml`, "utf8");
  const java = workflow.indexOf("name: Expose pinned Java to Gradle action");
  const gradle = workflow.indexOf("gradle/actions/setup-gradle@v5", java);
  assert.ok(java >= 0 && gradle > java);

  const exposeJava = workflow.slice(java, gradle);
  assert.match(exposeJava, /shell: nix develop \.#android --command bash -euo pipefail \{0\}/);
  assert.doesNotMatch(exposeJava, /(?:-c|<<)\s*'/);
  for (const expression of ["$RUNNER_TEMP", "$JAVA_HOME", "$GITHUB_ENV", "$GITHUB_PATH"]) {
    assert.match(exposeJava, new RegExp(`\\${expression}`));
  }
});
