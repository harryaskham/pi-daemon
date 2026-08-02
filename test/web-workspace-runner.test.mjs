import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  WEB_WORKSPACE,
  WEB_WORKSPACE_SCRIPTS,
  webWorkspaceRunArguments,
} from "../scripts/run-web-workspace.mjs";

test("web workspace wrapper inserts the inner argument boundary", () => {
  assert.deepEqual(webWorkspaceRunArguments("e2e", ["--grep", "dormant preview"]), [
    "run",
    "e2e",
    "--workspace",
    WEB_WORKSPACE,
    "--",
    "--grep",
    "dormant preview",
  ]);
  assert.deepEqual(webWorkspaceRunArguments("test", ["--reporter=verbose"]), [
    "run",
    "test",
    "--workspace",
    WEB_WORKSPACE,
    "--",
    "--reporter=verbose",
  ]);
  assert.deepEqual(webWorkspaceRunArguments("build"), [
    "run",
    "build",
    "--workspace",
    WEB_WORKSPACE,
  ]);
});

test("every root web wrapper delegates through the bounded forwarder", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const expected = {
    "web:dev": "dev",
    "web:build": "build",
    "web:test": "test",
    "web:e2e": "e2e",
    "web:e2e:nix": "e2e:nix",
    "web:e2e:smoke": "e2e:smoke",
    "web:bundle-report": "bundle:report",
  };
  for (const [rootScript, workspaceScript] of Object.entries(expected)) {
    assert.equal(
      packageJson.scripts[rootScript],
      `node scripts/run-web-workspace.mjs ${workspaceScript}`,
      rootScript,
    );
  }
  assert.equal(
    packageJson.scripts["web:test:performance"],
    "PI_DAEMON_PERFORMANCE_BUDGETS=1 node scripts/run-web-workspace.mjs test",
  );
  assert.deepEqual([...WEB_WORKSPACE_SCRIPTS].sort(), [...new Set(Object.values(expected))].sort());
});

test("web workspace wrapper rejects unknown, unbounded and unsafe input", () => {
  assert.throws(() => webWorkspaceRunArguments("publish", []), /unsupported web workspace script/);
  assert.throws(() => webWorkspaceRunArguments("test", Array(65).fill("x")), /exceed 64 entries/);
  assert.throws(() => webWorkspaceRunArguments("test", ["x".repeat(4_097)]), /exceeds 4096 characters/);
  assert.throws(() => webWorkspaceRunArguments("test", ["unsafe\u0000value"]), /is invalid/);
  assert.throws(
    () => webWorkspaceRunArguments("test", Array(9).fill("x".repeat(4_000))),
    /exceed 32768 aggregate characters/,
  );
});
