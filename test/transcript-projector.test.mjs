import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";

import { DASH_PERFORMANCE_BUDGETS } from "../dist/dashboard-contract.js";
import {
  TranscriptProjectionError,
  TranscriptProjector,
} from "../dist/transcript-projector.js";

const TIME = "2026-07-18T12:00:00.000Z";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "pi-daemon-projector-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const stateDir = join(root, "state");
  await mkdir(stateDir, { mode: 0o700 });
  return { root, stateDir };
}

async function writeSession(path, entries, mode = 0o600) {
  await writeFile(path, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, {
    mode,
  });
}

function header(id = "pi-projector-01", version = 3) {
  return { type: "session", version, id, timestamp: TIME, cwd: "/srv/work" };
}

function user(id, parentId, text) {
  return {
    type: "message",
    id,
    parentId,
    timestamp: TIME,
    message: { role: "user", content: text, timestamp: Date.parse(TIME) },
  };
}

test("projects an active Pi branch with semantic messages, merged tools, summaries and custom state", async (t) => {
  const { root, stateDir } = await fixture(t);
  const path = join(root, "session.jsonl");
  const image = Buffer.from("tiny-image").toString("base64");
  await writeSession(path, [
    header(),
    {
      ...user("u1", null, "show the projector"),
      message: {
        role: "user",
        timestamp: Date.parse(TIME),
        content: [
          { type: "text", text: "show the projector" },
          { type: "image", source: { type: "base64", mediaType: "image/png", data: image } },
        ],
      },
    },
    {
      type: "message",
      id: "a1",
      parentId: "u1",
      timestamp: TIME,
      message: {
        role: "assistant",
        api: "fixture",
        provider: "fixture",
        model: "fixture-model",
        timestamp: Date.parse(TIME),
        stopReason: "toolUse",
        usage: {
          input: 10,
          output: 5,
          cacheRead: 2,
          cacheWrite: 1,
          totalTokens: 18,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 },
        },
        content: [
          { type: "thinking", thinking: "bounded thought" },
          { type: "text", text: "Reading **now**." },
          { type: "toolCall", id: "call-1", name: "read", arguments: { path: "a.ts" } },
        ],
      },
    },
    {
      type: "message",
      id: "r1",
      parentId: "a1",
      timestamp: TIME,
      message: {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "read",
        content: [{ type: "text", text: "file output" }],
        details: { lines: 1 },
        isError: false,
        timestamp: Date.parse(TIME),
      },
    },
    {
      type: "model_change",
      id: "m1",
      parentId: "r1",
      timestamp: TIME,
      provider: "openai",
      modelId: "gpt-test",
    },
    {
      type: "thinking_level_change",
      id: "t1",
      parentId: "m1",
      timestamp: TIME,
      thinkingLevel: "high",
    },
    {
      type: "compaction",
      id: "c1",
      parentId: "t1",
      timestamp: TIME,
      summary: "Compacted history",
      firstKeptEntryId: "r1",
      tokensBefore: 1200,
    },
    {
      type: "branch_summary",
      id: "b1",
      parentId: "c1",
      timestamp: TIME,
      summary: "Other branch work",
      fromId: "t1",
    },
    {
      type: "custom_message",
      id: "cm1",
      parentId: "b1",
      timestamp: TIME,
      customType: "fixture",
      content: "Visible extension context",
      display: true,
      details: { status: "ok" },
    },
    {
      type: "custom_message",
      id: "cm2",
      parentId: "cm1",
      timestamp: TIME,
      customType: "hidden-fixture",
      content: "must not become fallback text",
      display: false,
    },
    {
      type: "custom",
      id: "custom1",
      parentId: "cm2",
      timestamp: TIME,
      customType: "state-fixture",
      data: { count: 2 },
    },
    {
      type: "label",
      id: "l1",
      parentId: "custom1",
      timestamp: TIME,
      targetId: "u1",
      label: "checkpoint",
    },
    {
      type: "session_info",
      id: "s1",
      parentId: "l1",
      timestamp: TIME,
      name: "Projector fixture",
    },
  ]);

  const projector = new TranscriptProjector({
    stateDir,
    now: () => new Date("2026-07-18T13:00:00.000Z"),
  });
  const page = await projector.project({ inventoryId: "inventory-projector-01", path });
  assert.equal(page.hydration, "not-requested");
  assert.equal(page.piSessionId, "pi-projector-01");
  assert.equal(page.currentLeafId, "s1");
  assert.equal(page.projection.cached, false);
  assert.equal(page.projection.truncated, false);
  assert.equal(page.records.some((record) => record.kind === "message" && record.role === "user"), true);
  assert.equal(page.records.some((record) => record.kind === "message" && record.role === "assistant"), true);
  const tool = page.records.find((record) => record.kind === "tool");
  assert.ok(tool && tool.kind === "tool");
  assert.equal(tool.toolName, "read");
  assert.equal(tool.state, "success");
  assert.deepEqual(tool.content, [{ type: "text", text: "file output" }]);
  assert.equal(page.records.filter((record) => record.kind === "tool").length, 1);
  assert.equal(page.records.filter((record) => record.kind === "summary").length, 2);
  assert.equal(page.records.filter((record) => record.kind === "timeline").length, 4);
  const hidden = page.records.find(
    (record) => record.kind === "custom" && record.customType === "hidden-fixture",
  );
  assert.ok(hidden && hidden.kind === "custom");
  assert.equal(hidden.hidden, true);
  assert.equal("fallbackText" in hidden, false);
  const serialized = JSON.stringify(page);
  assert.equal(serialized.includes(image), false);
  assert.match(serialized, /dash-blob:/);

  const cached = await projector.project({
    inventoryId: "inventory-projector-01",
    path,
    expectedFingerprint: page.sourceFingerprint,
  });
  assert.equal(cached.projection.cached, true);
  assert.deepEqual(cached.records, page.records);
  await assert.rejects(
    projector.project({
      inventoryId: "inventory-projector-01",
      path,
      expectedFingerprint: "sha256:stale-inventory-fingerprint",
    }),
    (error) =>
      error instanceof TranscriptProjectionError && error.code === "source_fingerprint_changed",
  );
});

test("follows only the current leaf branch and marks an orphaned active path truncated", async (t) => {
  const { root, stateDir } = await fixture(t);
  const path = join(root, "branches.jsonl");
  await writeSession(path, [
    header("pi-branches"),
    user("root", null, "root"),
    user("left", "root", "left branch must be absent"),
    user("right", "root", "right branch"),
    user("leaf", "right", "active leaf"),
  ]);
  const projector = new TranscriptProjector({ stateDir });
  const page = await projector.project({ inventoryId: "inventory-branches", path });
  const text = JSON.stringify(page.records);
  assert.equal(text.includes("left branch must be absent"), false);
  assert.equal(text.includes("right branch"), true);
  assert.equal(text.includes("active leaf"), true);
  assert.equal(page.projection.truncated, false);

  await writeSession(path, [header("pi-orphan"), user("root", null, "old root"), user("leaf", "missing", "orphan")]);
  const orphan = await projector.project({ inventoryId: "inventory-orphan", path });
  assert.equal(orphan.projection.truncated, true);
  assert.equal(JSON.stringify(orphan.records).includes("orphan"), true);
  assert.equal(JSON.stringify(orphan.records).includes("old root"), false);
});

test("uses deterministic legacy v1 identities across cache rebuilds", async (t) => {
  const { root, stateDir } = await fixture(t);
  const path = join(root, "legacy.jsonl");
  await writeSession(path, [
    { type: "session", id: "legacy-session", timestamp: TIME, cwd: "/srv/work" },
    { type: "message", timestamp: TIME, message: { role: "user", content: "legacy one" } },
    { type: "message", timestamp: TIME, message: { role: "hookMessage", content: "legacy custom" } },
    {
      type: "compaction",
      timestamp: TIME,
      summary: "legacy summary",
      firstKeptEntryIndex: 1,
      tokensBefore: 100,
    },
  ]);
  const projector = new TranscriptProjector({ stateDir });
  const first = await projector.project({ inventoryId: "inventory-legacy", path });
  await projector.clear("inventory-legacy");
  const second = await projector.project({ inventoryId: "inventory-legacy", path });
  assert.deepEqual(
    second.records.map((record) => record.recordId),
    first.records.map((record) => record.recordId),
  );
  assert.equal(first.records.every((record) => record.key.entryId?.startsWith("legacy-")), true);
  assert.equal(first.records.some((record) => record.kind === "message" && record.role === "custom"), true);
});

test("pages newest-first while preserving chronological record order and rejects stale cursors", async (t) => {
  const { root, stateDir } = await fixture(t);
  const path = join(root, "paging.jsonl");
  const entries = [header("pi-paging")];
  let parentId = null;
  for (let index = 0; index < 12; index += 1) {
    const id = `u${index}`;
    entries.push(user(id, parentId, `message ${index}`));
    parentId = id;
  }
  await writeSession(path, entries);
  const projector = new TranscriptProjector({ stateDir });
  const newest = await projector.project({
    inventoryId: "inventory-paging",
    path,
    query: { limit: 4 },
  });
  assert.deepEqual(
    newest.records.map((record) => record.recordId),
    ["entry:u8", "entry:u9", "entry:u10", "entry:u11"],
  );
  assert.ok(newest.olderCursor);
  const older = await projector.project({
    inventoryId: "inventory-paging",
    path,
    expectedFingerprint: newest.sourceFingerprint,
    query: { limit: 4, direction: "older", cursor: newest.olderCursor },
  });
  assert.deepEqual(
    older.records.map((record) => record.recordId),
    ["entry:u4", "entry:u5", "entry:u6", "entry:u7"],
  );
  assert.ok(older.newerCursor);
  await assert.rejects(
    projector.project({
      inventoryId: "other-inventory",
      path,
      query: { limit: 4, cursor: newest.olderCursor },
    }),
    (error) => error instanceof TranscriptProjectionError && error.code === "stale_cursor",
  );
});

test("expired cache entries rebuild even when source metadata is unchanged", async (t) => {
  const { root, stateDir } = await fixture(t);
  const path = join(root, "expiring.jsonl");
  await writeSession(path, [header("pi-expiring"), user("u1", null, "cache me")]);
  let now = new Date("2026-07-18T12:00:00.000Z");
  const projector = new TranscriptProjector({ stateDir, now: () => now });
  const first = await projector.project({ inventoryId: "inventory-expiring", path });
  const hit = await projector.project({
    inventoryId: "inventory-expiring",
    path,
    expectedFingerprint: first.sourceFingerprint,
  });
  assert.equal(hit.projection.cached, true);
  now = new Date("2026-07-26T12:00:00.000Z");
  const rebuilt = await projector.project({
    inventoryId: "inventory-expiring",
    path,
    expectedFingerprint: first.sourceFingerprint,
  });
  assert.equal(rebuilt.projection.cached, false);
  assert.equal(rebuilt.projection.builtAt, now.toISOString());
});

test("bounds records/output and recovers from corrupt private projection cache", async (t) => {
  const { root, stateDir } = await fixture(t);
  const path = join(root, "bounded.jsonl");
  await writeSession(path, [
    header("pi-bounded"),
    user("u1", null, "x".repeat(20_000)),
    user("u2", "u1", "newest survives"),
  ]);
  const projector = new TranscriptProjector({
    stateDir,
    limits: {
      maxRecordBytes: 2048,
      maxOutputBytes: 2500,
      maxCacheEntryBytes: 8192,
      maxCacheBytes: 16_384,
      maxPageRecords: 10,
    },
  });
  const first = await projector.project({ inventoryId: "inventory-bounded", path });
  assert.equal(first.projection.truncated, true);
  assert.equal(JSON.stringify(first.records).includes("newest survives"), true);
  assert.ok(Buffer.byteLength(JSON.stringify(first.records)) <= 2500);

  const cacheName = `${createHash("sha256").update("inventory-bounded").digest("hex")}.json`;
  const cachePath = join(projector.cacheDir, cacheName);
  await writeFile(cachePath, "{broken", { mode: 0o600 });
  const rebuilt = await projector.project({
    inventoryId: "inventory-bounded",
    path,
    expectedFingerprint: first.sourceFingerprint,
  });
  assert.equal(rebuilt.projection.cached, false);
  const repairedCache = await readFile(cachePath, "utf8");
  assert.doesNotThrow(() => JSON.parse(repairedCache));
});

test("rejects unsafe, malformed, oversized and excessive session sources before unbounded work", async (t) => {
  const { root, stateDir } = await fixture(t);
  const validPath = join(root, "valid.jsonl");
  await writeSession(validPath, [header(), user("u1", null, "ok")]);
  const link = join(root, "link.jsonl");
  await symlink(validPath, link);
  const projector = new TranscriptProjector({ stateDir });
  await assert.rejects(
    projector.project({ inventoryId: "inventory-link", path: link }),
    (error) => error instanceof TranscriptProjectionError && error.code === "source_not_regular",
  );

  const insecure = join(root, "insecure.jsonl");
  await writeSession(insecure, [header(), user("u1", null, "ok")], 0o666);
  await chmod(insecure, 0o666);
  await assert.rejects(
    projector.project({ inventoryId: "inventory-insecure", path: insecure }),
    (error) => error instanceof TranscriptProjectionError && error.code === "source_insecure_mode",
  );

  const malformed = join(root, "malformed.jsonl");
  await writeFile(malformed, `${JSON.stringify(header())}\n{bad\n`, { mode: 0o600 });
  await assert.rejects(
    projector.project({ inventoryId: "inventory-malformed", path: malformed }),
    (error) => error instanceof TranscriptProjectionError && error.code === "invalid_json",
  );

  const invalidUtf8 = join(root, "invalid-utf8.jsonl");
  await writeFile(
    invalidUtf8,
    Buffer.concat([Buffer.from(`${JSON.stringify(header())}\n`), Buffer.from([0xff, 0x0a])]),
    { mode: 0o600 },
  );
  await assert.rejects(
    projector.project({ inventoryId: "inventory-utf8", path: invalidUtf8 }),
    (error) => error instanceof TranscriptProjectionError && error.code === "invalid_utf8",
  );

  const duplicate = join(root, "duplicate.jsonl");
  await writeSession(duplicate, [header(), user("same", null, "one"), user("same", "same", "two")]);
  await assert.rejects(
    projector.project({ inventoryId: "inventory-duplicate", path: duplicate }),
    (error) => error instanceof TranscriptProjectionError && error.code === "duplicate_entry",
  );

  const duplicateTool = join(root, "duplicate-tool.jsonl");
  await writeSession(duplicateTool, [
    header("pi-duplicate-tool"),
    user("u1", null, "tools"),
    {
      type: "message",
      id: "a1",
      parentId: "u1",
      timestamp: TIME,
      message: {
        role: "assistant",
        content: [
          { type: "toolCall", id: "same-call", name: "read", arguments: {} },
          { type: "toolCall", id: "same-call", name: "read", arguments: {} },
        ],
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } },
        stopReason: "toolUse",
        timestamp: Date.parse(TIME),
      },
    },
  ]);
  await assert.rejects(
    projector.project({ inventoryId: "inventory-duplicate-tool", path: duplicateTool }),
    (error) => error instanceof TranscriptProjectionError && error.code === "duplicate_tool_call",
  );

  const bounded = new TranscriptProjector({
    stateDir: join(root, "bounded-state"),
    limits: {
      maxSourceBytes: 512,
      maxLineBytes: 128,
      maxEntries: 2,
      maxOutputBytes: 4096,
      maxRecordBytes: 2048,
      maxCacheEntryBytes: 8192,
      maxCacheBytes: 16_384,
      maxPageRecords: 2,
    },
  });
  const hugeLine = join(root, "huge-line.jsonl");
  await writeSession(hugeLine, [header(), user("u1", null, "x".repeat(300))]);
  await assert.rejects(
    bounded.project({ inventoryId: "inventory-line", path: hugeLine }),
    (error) => error instanceof TranscriptProjectionError && ["source_too_large", "line_too_large"].includes(error.code),
  );
  const tooMany = join(root, "many.jsonl");
  await writeSession(tooMany, [header(), user("u1", null, "1"), user("u2", "u1", "2"), user("u3", "u2", "3")]);
  const entryBounded = new TranscriptProjector({
    stateDir: join(root, "entry-bounded-state"),
    limits: { maxSourceBytes: 4096, maxLineBytes: 1024, maxEntries: 2 },
  });
  await assert.rejects(
    entryBounded.project({ inventoryId: "inventory-many", path: tooMany }),
    (error) => error instanceof TranscriptProjectionError && error.code === "too_many_entries",
  );
});

test("cold and cached 10k-entry useful viewports remain within contract budgets", async (t) => {
  const { root, stateDir } = await fixture(t);
  const path = join(root, "ten-thousand.jsonl");
  const entries = [header("pi-10k")];
  let parentId = null;
  for (let index = 0; index < 10_000; index += 1) {
    const id = `m${String(index).padStart(5, "0")}`;
    entries.push(user(id, parentId, `message ${index}`));
    parentId = id;
  }
  await writeSession(path, entries);
  const projector = new TranscriptProjector({ stateDir });
  const coldStarted = performance.now();
  const cold = await projector.project({ inventoryId: "inventory-10k", path });
  const coldMs = performance.now() - coldStarted;
  assert.equal(cold.records.length, 200);
  assert.ok(coldMs < DASH_PERFORMANCE_BUDGETS.coldTranscriptViewportP95Ms, `cold=${coldMs.toFixed(1)}ms`);

  const cachedStarted = performance.now();
  const cached = await projector.project({
    inventoryId: "inventory-10k",
    path,
    expectedFingerprint: cold.sourceFingerprint,
  });
  const cachedMs = performance.now() - cachedStarted;
  assert.equal(cached.projection.cached, true);
  assert.ok(cachedMs < DASH_PERFORMANCE_BUDGETS.cachedTranscriptViewportP95Ms, `cached=${cachedMs.toFixed(1)}ms`);
});
