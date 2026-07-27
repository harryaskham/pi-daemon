import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { promisify } from "node:util";

import { DASH_PERFORMANCE_BUDGETS } from "../../dist/dashboard-contract.js";
import { SessionInventory } from "../../dist/session-inventory.js";

const execFileAsync = promisify(execFile);
const inventoryModuleUrl = new URL("../../dist/session-inventory.js", import.meta.url).href;

class FakeCatalog {
  constructor(records = []) {
    this.records = records;
  }

  async recover() {
    return structuredClone(this.records);
  }
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "pi-daemon-inventory-performance-"));
  const stateDir = join(root, "state");
  await mkdir(stateDir, { mode: 0o700 });
  t.after(async () => rm(root, { recursive: true, force: true }));
  return { stateDir };
}

function catalogRecord(sessionId, index) {
  const suffix = String(index).padStart(4, "0");
  const updatedAt = new Date(
    Date.parse("2026-07-18T12:00:00.000Z") + index,
  ).toISOString();
  return {
    formatVersion: 1,
    sessionId,
    name: `Project ${suffix}`,
    generation: 1,
    revision: 1,
    residency: "dormant",
    state: "idle",
    createdAt: "2026-07-18T11:00:00.000Z",
    updatedAt,
    lastUsedAt: updatedAt,
    spec: {
      cwd: `/work/project-${suffix}`,
      target: { mode: "memory" },
      isolation: { mode: "unisolated" },
    },
    environment: { keys: [], persistence: "memory-only", provisioned: true },
    policyDigest: `digest-${sessionId}`,
  };
}

function percentile95(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)];
}

test(
  "manual 10k persisted bootstrap and indexed request paths meet the contract budgets",
  { timeout: 120_000 },
  async (t) => {
    const { stateDir } = await fixture(t);
    const records = Array.from({ length: 10_000 }, (_, index) =>
      catalogRecord(`session-${String(index).padStart(4, "0")}`, index),
    );
    const inventory = new SessionInventory({ stateDir, catalog: new FakeCatalog(records) });
    const reconcile = await inventory.reconcile();
    assert.equal(reconcile.records, 10_000);
    assert.equal(
      (await lstat(join(stateDir, "web", "inventory-v1.json"))).size < 64 * 1024 * 1024,
      true,
    );

    const bootstrapSamples = [];
    const bootstrapScript = `
      import { performance } from "node:perf_hooks";
      import { SessionInventory } from ${JSON.stringify(inventoryModuleUrl)};
      const started = performance.now();
      const inventory = new SessionInventory({
        stateDir: process.argv[1],
        catalog: { recover: async () => [] },
      });
      await inventory.initialize();
      const page = await inventory.list({ limit: 100 });
      process.stdout.write(JSON.stringify({ elapsedMs: performance.now() - started, rows: page.sessions.length, reconciling: page.index.reconciling }));
      process.exit(0);
    `;
    for (let iteration = 0; iteration < 100; iteration += 1) {
      const measured = await execFileAsync(
        process.execPath,
        ["--input-type=module", "--eval", bootstrapScript, stateDir],
        { timeout: 30_000, maxBuffer: 1024 * 1024 },
      );
      const sample = JSON.parse(measured.stdout);
      bootstrapSamples.push(sample.elapsedMs);
      assert.equal(sample.rows, 100);
      assert.equal(sample.reconciling, true);
    }
    const bootstrapP95 = percentile95(bootstrapSamples);
    assert.equal(
      bootstrapP95 < DASH_PERFORMANCE_BUDGETS.persistedIndexBootstrapP95Ms,
      true,
      `bootstrap p95 ${bootstrapP95.toFixed(2)}ms`,
    );

    const loaded = new SessionInventory({ stateDir, catalog: new FakeCatalog() });
    await loaded.initialize();
    const firstRows = [];
    for (let iteration = 0; iteration < 20; iteration += 1) {
      const started = performance.now();
      const page = await loaded.list({ limit: 100 });
      firstRows.push(performance.now() - started);
      assert.equal(page.sessions.length, 100);
    }
    const firstRowsP95 = percentile95(firstRows);
    assert.equal(
      firstRowsP95 < DASH_PERFORMANCE_BUDGETS.firstSidebarRowsP95Ms,
      true,
      `first rows p95 ${firstRowsP95.toFixed(2)}ms`,
    );

    await loaded.waitForFullIndex();
    const searchSamples = [];
    for (let iteration = 0; iteration < 5; iteration += 1) {
      const started = performance.now();
      const page = await loaded.list({ search: "Project 0000", limit: 10 });
      searchSamples.push(performance.now() - started);
      assert.equal(page.sessions[0].title, "Project 0000");
    }
    const searchP95 = percentile95(searchSamples);
    assert.equal(
      searchP95 < DASH_PERFORMANCE_BUDGETS.serverSearchPageP95Ms,
      true,
      `search p95 ${searchP95.toFixed(2)}ms`,
    );
    t.diagnostic(
      `10k inventory p95: bootstrap+first-page=${bootstrapP95.toFixed(2)}ms, hot-first-page=${firstRowsP95.toFixed(2)}ms, search=${searchP95.toFixed(2)}ms`,
    );
  },
);
