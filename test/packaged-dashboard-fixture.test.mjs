import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  assertPackagedDashboardBuilt,
  packagedDashboardIndex,
} from "./packaged-dashboard-fixture.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "pi-daemon-packaged-dash-fixture-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  return root;
}

test("packaged Dash precondition names the exact missing build and remediation", async (t) => {
  const root = await fixture(t);
  const absent = join(root, "dist", "dashboard", "index.html");

  await assert.rejects(
    assertPackagedDashboardBuilt(absent),
    (error) => {
      assert.match(error.message, /packaged Dash SPA missing/);
      assert.match(error.message, /npm run build/);
      assert.match(error.message, /dist\/dashboard/);
      assert.equal(error.message.includes(absent), false, "diagnostic does not need ambient paths");
      return true;
    },
  );
});

test("packaged Dash precondition rejects a directory masquerading as the index", async (t) => {
  const root = await fixture(t);
  const directory = join(root, "index.html");
  await mkdir(directory);

  await assert.rejects(
    assertPackagedDashboardBuilt(directory),
    /packaged Dash SPA missing.*npm run build/,
  );
});

test("packaged Dash precondition accepts a regular index file", async (t) => {
  const root = await fixture(t);
  const index = join(root, "index.html");
  await writeFile(index, "<!doctype html><div id=\"root\"></div>\n", { mode: 0o600 });

  await assert.doesNotReject(assertPackagedDashboardBuilt(index));
});

test("packaged Dash precondition points at the repository postbuild output", () => {
  assert.match(packagedDashboardIndex, /dist[/\\]dashboard[/\\]index\.html$/);
});
