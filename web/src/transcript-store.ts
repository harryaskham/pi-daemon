import type {
  DashboardCursor,
  DashboardSessionIdentity,
  NormalizedTranscriptRecord,
} from "@harryaskham/pi-daemon/dashboard-contract";

export interface TranscriptStoreLimits {
  maxRecords: number;
  maxBytes: number;
  maxRecordBytes: number;
}

export const DEFAULT_TRANSCRIPT_STORE_LIMITS: TranscriptStoreLimits = {
  maxRecords: 5_000,
  maxBytes: 32 * 1024 * 1024,
  maxRecordBytes: 512 * 1024,
};

export interface TranscriptReplayGapState {
  reason: "cursor-expired" | "generation-changed" | "host-restarted" | "overflow";
  highWaterCursor: DashboardCursor;
}

export interface TranscriptStoreState {
  identity: DashboardSessionIdentity;
  records: NormalizedTranscriptRecord[];
  highWaterCursor?: DashboardCursor;
  needsReconcile: boolean;
  replayGap?: TranscriptReplayGapState;
  droppedRecords: number;
  totalBytes: number;
  limits: TranscriptStoreLimits;
  index: ReadonlyMap<string, number>;
  sizes: ReadonlyMap<string, number>;
}

export type TranscriptStoreAction =
  | {
      type: "snapshot" | "reconcile";
      identity: DashboardSessionIdentity;
      records: NormalizedTranscriptRecord[];
      cursor: DashboardCursor;
    }
  | {
      type: "upsert";
      identity: DashboardSessionIdentity;
      records: NormalizedTranscriptRecord[];
      cursor?: DashboardCursor;
    }
  | {
      type: "entry_appended";
      identity: DashboardSessionIdentity;
      record: NormalizedTranscriptRecord;
      cursor: DashboardCursor;
    }
  | {
      type: "replay_gap";
      identity: DashboardSessionIdentity;
      reason: TranscriptReplayGapState["reason"];
      highWaterCursor: DashboardCursor;
    };

function identityMatches(first: DashboardSessionIdentity, second: DashboardSessionIdentity): boolean {
  return first.hostInstanceId === second.hostInstanceId
    && first.sessionId === second.sessionId
    && first.generation === second.generation;
}

/** Stable semantic identity. Rendered content and array position are deliberately absent. */
export function transcriptRecordIdentity(record: NormalizedTranscriptRecord): string {
  if (record.key.toolCallId) return `tool:${record.key.toolCallId}`;
  if (record.key.messageId) return `message:${record.key.messageId}`;
  if (record.key.entryId) return `${record.kind}:entry:${record.key.entryId}`;
  return `${record.kind}:record:${record.recordId}`;
}

function sourceRank(source: NormalizedTranscriptRecord["source"]): number {
  return source === "persisted" ? 3 : source === "live" ? 2 : 1;
}

function recordBytes(record: NormalizedTranscriptRecord): number {
  return new TextEncoder().encode(JSON.stringify(record)).byteLength;
}

function timestamp(record: NormalizedTranscriptRecord): number {
  if (!record.timestamp) return Number.MAX_SAFE_INTEGER;
  const parsed = Date.parse(record.timestamp);
  return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
}

function buildIndex(records: NormalizedTranscriptRecord[]): Map<string, number> {
  return new Map(records.map((record, index) => [transcriptRecordIdentity(record), index]));
}

function buildSizes(records: NormalizedTranscriptRecord[]): Map<string, number> {
  return new Map(records.map((record) => [transcriptRecordIdentity(record), recordBytes(record)]));
}

function normalizeSnapshot(
  identity: DashboardSessionIdentity,
  records: NormalizedTranscriptRecord[],
  limits: TranscriptStoreLimits,
  cursor?: DashboardCursor,
): TranscriptStoreState {
  const deduplicated = new Map<string, NormalizedTranscriptRecord>();
  let droppedRecords = 0;
  for (const record of records) {
    const size = recordBytes(record);
    if (size > limits.maxRecordBytes) {
      droppedRecords += 1;
      continue;
    }
    const key = transcriptRecordIdentity(record);
    const existing = deduplicated.get(key);
    if (!existing || sourceRank(record.source) >= sourceRank(existing.source)) deduplicated.set(key, record);
  }
  const ordered = [...deduplicated.values()].sort((first, second) => {
    const byTime = timestamp(first) - timestamp(second);
    return byTime || transcriptRecordIdentity(first).localeCompare(transcriptRecordIdentity(second));
  });
  const kept: NormalizedTranscriptRecord[] = [];
  let totalBytes = 0;
  droppedRecords += Math.max(0, ordered.length - limits.maxRecords);
  for (const record of ordered.slice(-limits.maxRecords)) {
    const size = recordBytes(record);
    while (kept.length > 0 && totalBytes + size > limits.maxBytes) {
      const removed = kept.shift();
      if (removed) totalBytes -= recordBytes(removed);
      droppedRecords += 1;
    }
    if (size <= limits.maxBytes) {
      kept.push(record);
      totalBytes += size;
    } else {
      droppedRecords += 1;
    }
  }
  return {
    identity,
    records: kept,
    ...(cursor ? { highWaterCursor: cursor } : {}),
    needsReconcile: false,
    droppedRecords,
    totalBytes,
    limits,
    index: buildIndex(kept),
    sizes: buildSizes(kept),
  };
}

export function createTranscriptStore(
  identity: DashboardSessionIdentity,
  records: NormalizedTranscriptRecord[] = [],
  limits: TranscriptStoreLimits = DEFAULT_TRANSCRIPT_STORE_LIMITS,
  cursor?: DashboardCursor,
): TranscriptStoreState {
  return normalizeSnapshot(identity, records, limits, cursor);
}

function upsertRecords(
  state: TranscriptStoreState,
  incoming: NormalizedTranscriptRecord[],
  cursor?: DashboardCursor,
): TranscriptStoreState {
  let records = [...state.records];
  let index = new Map(state.index);
  let sizes = new Map(state.sizes);
  let totalBytes = state.totalBytes;
  let droppedRecords = state.droppedRecords;
  let appended = false;

  for (const record of incoming) {
    const key = transcriptRecordIdentity(record);
    const size = recordBytes(record);
    if (size > state.limits.maxRecordBytes) {
      droppedRecords += 1;
      continue;
    }
    const existingIndex = index.get(key);
    if (existingIndex !== undefined) {
      const existing = records[existingIndex];
      if (!existing || sourceRank(record.source) < sourceRank(existing.source)) continue;
      totalBytes -= sizes.get(key) ?? 0;
      records[existingIndex] = record;
      sizes.set(key, size);
      totalBytes += size;
    } else {
      records.push(record);
      sizes.set(key, size);
      totalBytes += size;
      appended = true;
    }
  }

  if (appended) {
    records.sort((first, second) => {
      const byTime = timestamp(first) - timestamp(second);
      return byTime || transcriptRecordIdentity(first).localeCompare(transcriptRecordIdentity(second));
    });
    index = buildIndex(records);
  }

  while (records.length > state.limits.maxRecords || totalBytes > state.limits.maxBytes) {
    const removed = records.shift();
    if (!removed) break;
    const key = transcriptRecordIdentity(removed);
    totalBytes -= sizes.get(key) ?? 0;
    sizes.delete(key);
    droppedRecords += 1;
  }
  if (appended || droppedRecords !== state.droppedRecords) index = buildIndex(records);

  return {
    ...state,
    records,
    ...(cursor ? { highWaterCursor: cursor } : {}),
    droppedRecords,
    totalBytes,
    index,
    sizes,
  };
}

export function transcriptStoreReducer(
  state: TranscriptStoreState,
  action: TranscriptStoreAction,
): TranscriptStoreState {
  if (action.type === "snapshot") {
    return normalizeSnapshot(action.identity, action.records, state.limits, action.cursor);
  }
  if (!identityMatches(state.identity, action.identity)) return state;
  switch (action.type) {
    case "reconcile":
      return normalizeSnapshot(action.identity, action.records, state.limits, action.cursor);
    case "upsert":
      return upsertRecords(state, action.records, action.cursor);
    case "entry_appended":
      return upsertRecords(
        {
          identity: state.identity,
          records: state.records,
          ...(state.highWaterCursor ? { highWaterCursor: state.highWaterCursor } : {}),
          needsReconcile: false,
          droppedRecords: state.droppedRecords,
          totalBytes: state.totalBytes,
          limits: state.limits,
          index: state.index,
          sizes: state.sizes,
        },
        [{ ...action.record, source: "persisted" }],
        action.cursor,
      );
    case "replay_gap":
      return {
        ...state,
        needsReconcile: true,
        replayGap: { reason: action.reason, highWaterCursor: action.highWaterCursor },
        highWaterCursor: action.highWaterCursor,
      };
  }
}
