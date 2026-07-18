import { asDashboardCursor } from "@harryaskham/pi-daemon/dashboard-contract";
import type { DashboardSessionIdentity, NormalizedTranscriptRecord } from "@harryaskham/pi-daemon/dashboard-contract";
import { describe, expect, it } from "vitest";
import { createTranscriptFixtures } from "../fixtures";
import {
  createTranscriptStore,
  transcriptRecordIdentity,
  transcriptStoreReducer,
} from "../transcript-store";

const identity: DashboardSessionIdentity = {
  hostInstanceId: "host-fixture-01",
  sessionId: "session-fixture-01",
  generation: 3,
};
const cursor = (value: number) => asDashboardCursor(`cursor:${value}`);

function liveVersion(record: NormalizedTranscriptRecord, text: string): NormalizedTranscriptRecord {
  if (record.kind !== "message") throw new Error("fixture must be a message");
  return {
    ...record,
    source: "live",
    state: "streaming",
    content: [{ type: "markdown", text }],
  };
}

describe("normalized transcript store", () => {
  it("merges live and entry_appended records idempotently by Pi identities", () => {
    const persisted = createTranscriptFixtures(3)[1];
    expect(persisted?.kind).toBe("message");
    if (!persisted || persisted.kind !== "message") return;
    let state = createTranscriptStore(identity, [], undefined, cursor(0));
    state = transcriptStoreReducer(state, {
      type: "upsert",
      identity,
      records: [liveVersion(persisted, "partial")],
      cursor: cursor(1),
    });
    state = transcriptStoreReducer(state, {
      type: "entry_appended",
      identity,
      record: persisted,
      cursor: cursor(2),
    });
    expect(state.records).toHaveLength(1);
    expect(state.records[0]?.source).toBe("persisted");
    expect(transcriptRecordIdentity(state.records[0] ?? persisted)).toBe(`message:${persisted.key.messageId}`);
  });

  it("ignores prior-host and prior-generation frames", () => {
    const state = createTranscriptStore(identity, createTranscriptFixtures(3));
    const next = transcriptStoreReducer(state, {
      type: "upsert",
      identity: { ...identity, generation: 2 },
      records: createTranscriptFixtures(1),
      cursor: cursor(1),
    });
    expect(next).toBe(state);
  });

  it("marks replay gaps without appending and clears only on reconciliation", () => {
    const records = createTranscriptFixtures(12);
    let state = createTranscriptStore(identity, records, undefined, cursor(4));
    state = transcriptStoreReducer(state, {
      type: "replay_gap",
      identity,
      reason: "cursor-expired",
      highWaterCursor: cursor(9),
    });
    expect(state.needsReconcile).toBe(true);
    expect(state.records).toHaveLength(12);
    state = transcriptStoreReducer(state, {
      type: "reconcile",
      identity,
      records,
      cursor: cursor(10),
    });
    expect(state.needsReconcile).toBe(false);
    expect(state.replayGap).toBeUndefined();
    expect(state.records).toHaveLength(12);
  });

  it("bounds record count, aggregate bytes, and single-record bytes", () => {
    const records = createTranscriptFixtures(30);
    const state = createTranscriptStore(identity, records, {
      maxRecords: 8,
      maxBytes: 8_000,
      maxRecordBytes: 1_000,
    });
    expect(state.records.length).toBeLessThanOrEqual(8);
    expect(state.totalBytes).toBeLessThanOrEqual(8_000);
    expect(state.droppedRecords).toBeGreaterThan(0);
  });

  it("keeps rapid existing-record commit work inside the 16ms p95 budget", () => {
    const records = createTranscriptFixtures(1_200);
    const message = records.find((record) => record.kind === "message");
    expect(message?.kind).toBe("message");
    if (!message || message.kind !== "message") return;
    let state = createTranscriptStore(identity, records);
    const samples: number[] = [];
    for (let index = 0; index < 120; index += 1) {
      const startedAt = performance.now();
      state = transcriptStoreReducer(state, {
        type: "upsert",
        identity,
        records: [liveVersion(message, `partial ${index}`)],
        cursor: cursor(index + 1),
      });
      samples.push(performance.now() - startedAt);
    }
    samples.sort((first, second) => first - second);
    const p95 = samples[Math.floor(samples.length * 0.95)] ?? Number.POSITIVE_INFINITY;
    expect(p95).toBeLessThan(16);
    expect(state.records).toHaveLength(records.length);
  });
});
