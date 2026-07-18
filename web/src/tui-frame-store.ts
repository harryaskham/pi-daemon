import {
  DASH_DEFAULT_LIMITS,
  type DashboardControlEvent,
  type DashboardControllerRole,
  type DashboardReplayGap,
  type DashboardSessionIdentity,
  type DashboardTuiDelta,
  type DashboardTuiSnapshot,
  type TuiCursorState,
  type TuiDimensions,
  type TuiRow,
  type TuiStyle,
  type TuiStyledRun,
} from "@harryaskham/pi-daemon/dashboard-contract";

export type TuiFrameStatus = "ready" | "replay-gap" | "conflict";
export type TuiFrameConflictKind = "identity" | "sequence" | "invalid-frame";

export interface TuiFrameConflict {
  kind: TuiFrameConflictKind;
  message: string;
  expected?: number;
  received?: number;
}

export interface TuiFrameStoreState {
  identity: DashboardSessionIdentity;
  role: DashboardControllerRole;
  dimensions: TuiDimensions;
  rows: readonly TuiRow[];
  cursor: TuiCursorState;
  title?: string;
  highWaterCursor: DashboardTuiSnapshot["highWaterCursor"];
  sequence: number;
  revision: number;
  status: TuiFrameStatus;
  droppedDeltas: number;
  replayGap?: DashboardReplayGap;
  conflict?: TuiFrameConflict;
}

export interface TuiFrameCacheLimits {
  maxEntries: number;
  maxBytes: number;
  maxEntryBytes: number;
}

export const DEFAULT_TUI_FRAME_CACHE_LIMITS: TuiFrameCacheLimits = {
  maxEntries: 64,
  maxBytes: 32 * 1024 * 1024,
  maxEntryBytes: DASH_DEFAULT_LIMITS.maxWebSocketFrameBytes,
};

export class TuiFrameCache<Key> {
  readonly limits: TuiFrameCacheLimits;
  #entries = new Map<Key, { state: TuiFrameStoreState; bytes: number }>();
  #bytes = 0;

  constructor(limits: TuiFrameCacheLimits = DEFAULT_TUI_FRAME_CACHE_LIMITS) {
    if (!Number.isSafeInteger(limits.maxEntries) || limits.maxEntries < 1 || limits.maxEntries > 1_024) {
      throw new RangeError("TUI frame cache maxEntries is invalid");
    }
    if (!Number.isSafeInteger(limits.maxBytes) || limits.maxBytes < 1 || limits.maxBytes > 512 * 1024 * 1024) {
      throw new RangeError("TUI frame cache maxBytes is invalid");
    }
    if (!Number.isSafeInteger(limits.maxEntryBytes) || limits.maxEntryBytes < 1 || limits.maxEntryBytes > 4 * 1024 * 1024) {
      throw new RangeError("TUI frame cache maxEntryBytes is invalid");
    }
    this.limits = { ...limits };
  }

  get size(): number {
    return this.#entries.size;
  }

  get bytes(): number {
    return this.#bytes;
  }

  get(key: Key): TuiFrameStoreState | undefined {
    const entry = this.#entries.get(key);
    if (!entry) return undefined;
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    return entry.state;
  }

  set(key: Key, state: TuiFrameStoreState): void {
    const bytes = new TextEncoder().encode(JSON.stringify(state)).byteLength;
    if (bytes > this.limits.maxEntryBytes || bytes > this.limits.maxBytes) {
      throw new RangeError("TUI frame cache entry exceeds its byte bound");
    }
    const existing = this.#entries.get(key);
    if (existing) this.#bytes -= existing.bytes;
    this.#entries.delete(key);
    this.#entries.set(key, { state, bytes });
    this.#bytes += bytes;
    while (this.#entries.size > this.limits.maxEntries || this.#bytes > this.limits.maxBytes) {
      const oldest = this.#entries.entries().next().value as [Key, { state: TuiFrameStoreState; bytes: number }] | undefined;
      if (!oldest) break;
      this.#entries.delete(oldest[0]);
      this.#bytes -= oldest[1].bytes;
    }
  }
}

export type TuiFrameStoreAction =
  | { type: "snapshot"; snapshot: DashboardTuiSnapshot; role?: DashboardControllerRole }
  | { type: "delta"; delta: DashboardTuiDelta }
  | { type: "replay_gap"; gap: DashboardReplayGap }
  | { type: "control"; event: DashboardControlEvent };

const MAX_ROWS = DASH_DEFAULT_LIMITS.maxTuiRows;
const MAX_COLUMNS = DASH_DEFAULT_LIMITS.maxTuiColumns;
const MAX_DELTA_ROWS = DASH_DEFAULT_LIMITS.maxTuiDeltaRows;
const MAX_FRAME_BYTES = DASH_DEFAULT_LIMITS.maxTuiDeltaBytes;
const MAX_RUNS_PER_ROW = 320;
const MAX_RUN_TEXT = 4_096;
const MAX_TITLE = 256;
const unsafeText = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu;
const safeColor = /^#[0-9a-f]{6}$/iu;

function identityMatches(first: DashboardSessionIdentity, second: DashboardSessionIdentity): boolean {
  return first.hostInstanceId === second.hostInstanceId
    && first.sessionId === second.sessionId
    && first.generation === second.generation;
}

function checkedInteger(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function normalizeDimensions(dimensions: TuiDimensions): TuiDimensions {
  return {
    rows: checkedInteger(dimensions.rows, 1, MAX_ROWS, "TUI rows"),
    columns: checkedInteger(dimensions.columns, 1, MAX_COLUMNS, "TUI columns"),
  };
}

function normalizeCursor(cursor: TuiCursorState, dimensions: TuiDimensions): TuiCursorState {
  const row = checkedInteger(cursor.row, 0, dimensions.rows - 1, "TUI cursor row");
  const column = checkedInteger(cursor.column, 0, dimensions.columns - 1, "TUI cursor column");
  const shape = cursor.shape === "bar" || cursor.shape === "underline" || cursor.shape === "block"
    ? cursor.shape
    : undefined;
  return {
    row,
    column,
    visible: cursor.visible === true,
    ...(shape ? { shape } : {}),
  };
}

function normalizeStyle(style: TuiStyle | undefined): TuiStyle | undefined {
  if (!style) return undefined;
  const foreground = style.foreground?.toLowerCase();
  const background = style.background?.toLowerCase();
  const normalized: TuiStyle = {
    ...(foreground && safeColor.test(foreground) ? { foreground } : {}),
    ...(background && safeColor.test(background) ? { background } : {}),
    ...(style.bold === true ? { bold: true } : {}),
    ...(style.dim === true ? { dim: true } : {}),
    ...(style.italic === true ? { italic: true } : {}),
    ...(style.underline === true ? { underline: true } : {}),
    ...(style.inverse === true ? { inverse: true } : {}),
  };
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function styleKey(style: TuiStyle | undefined): string {
  return style ? JSON.stringify(style) : "";
}

function normalizeRun(run: TuiStyledRun): TuiStyledRun {
  if (typeof run.text !== "string" || run.text.length > MAX_RUN_TEXT) {
    throw new RangeError(`TUI run text must contain at most ${MAX_RUN_TEXT} UTF-16 code units`);
  }
  const text = run.text.replaceAll("\r", "").replaceAll("\n", " ").replace(unsafeText, "");
  const style = normalizeStyle(run.style);
  return { text, ...(style ? { style } : {}) };
}

function normalizeRow(row: TuiRow, dimensions: TuiDimensions): TuiRow {
  const index = checkedInteger(row.row, 0, dimensions.rows - 1, "TUI row index");
  if (!Array.isArray(row.runs) || row.runs.length > Math.min(MAX_RUNS_PER_ROW, dimensions.columns)) {
    throw new RangeError("TUI row contains too many styled runs");
  }
  const runs: TuiStyledRun[] = [];
  for (const raw of row.runs) {
    const run = normalizeRun(raw);
    if (run.text.length === 0) continue;
    const previous = runs.at(-1);
    if (previous && styleKey(previous.style) === styleKey(run.style)) {
      const joined = `${previous.text}${run.text}`;
      if (joined.length > MAX_RUN_TEXT) throw new RangeError("coalesced TUI run exceeds the text bound");
      runs[runs.length - 1] = { text: joined, ...(run.style ? { style: run.style } : {}) };
    } else {
      runs.push(run);
    }
  }
  return { row: index, runs };
}

function normalizeRows(rows: readonly TuiRow[], dimensions: TuiDimensions, maximum: number): TuiRow[] {
  if (!Array.isArray(rows) || rows.length > maximum) throw new RangeError("TUI frame contains too many changed rows");
  const seen = new Set<number>();
  const normalized = rows.map((row) => {
    const next = normalizeRow(row, dimensions);
    if (seen.has(next.row)) throw new RangeError(`TUI frame repeats row ${next.row}`);
    seen.add(next.row);
    return next;
  });
  return normalized.sort((first, second) => first.row - second.row);
}

function normalizeTitle(title: string | undefined): string | undefined {
  if (title === undefined) return undefined;
  if (typeof title !== "string" || title.length > MAX_TITLE) throw new RangeError("TUI title exceeds its bound");
  return title.replace(unsafeText, "").replaceAll("\r", " ").replaceAll("\n", " ");
}

function assertFrameBytes(value: unknown): void {
  const bytes = new TextEncoder().encode(JSON.stringify(value)).byteLength;
  if (bytes > MAX_FRAME_BYTES) throw new RangeError(`TUI frame exceeds ${MAX_FRAME_BYTES} bytes`);
}

function normalizeSnapshot(snapshot: DashboardTuiSnapshot): Omit<TuiFrameStoreState, "role" | "revision" | "status" | "droppedDeltas" | "sequence"> {
  assertFrameBytes(snapshot);
  const dimensions = normalizeDimensions(snapshot.dimensions);
  const rows = normalizeRows(snapshot.rows, dimensions, MAX_ROWS);
  const cursor = normalizeCursor(snapshot.cursor, dimensions);
  const title = normalizeTitle(snapshot.title);
  return {
    identity: { ...snapshot.identity },
    dimensions,
    rows,
    cursor,
    ...(title !== undefined ? { title } : {}),
    highWaterCursor: snapshot.highWaterCursor,
  };
}

export function createTuiFrameStore(
  snapshot: DashboardTuiSnapshot,
  role: DashboardControllerRole = "observer",
): TuiFrameStoreState {
  return {
    ...normalizeSnapshot(snapshot),
    role,
    sequence: 0,
    revision: 1,
    status: "ready",
    droppedDeltas: 0,
  };
}

function withConflict(state: TuiFrameStoreState, conflict: TuiFrameConflict): TuiFrameStoreState {
  return { ...state, status: "conflict", conflict, droppedDeltas: state.droppedDeltas + 1 };
}

function applyDelta(state: TuiFrameStoreState, delta: DashboardTuiDelta): TuiFrameStoreState {
  if (!identityMatches(state.identity, delta.identity)) {
    return withConflict(state, { kind: "identity", message: "TUI frame belongs to another host, session, or generation" });
  }
  if (!Number.isSafeInteger(delta.sequence) || delta.sequence < 1) {
    return withConflict(state, { kind: "sequence", message: "TUI frame sequence is invalid", received: delta.sequence });
  }
  if (delta.sequence <= state.sequence) return { ...state, droppedDeltas: state.droppedDeltas + 1 };
  if (state.sequence > 0 && delta.sequence !== state.sequence + 1) {
    return withConflict(state, {
      kind: "sequence",
      message: "TUI frame sequence has a gap; a fresh snapshot is required",
      expected: state.sequence + 1,
      received: delta.sequence,
    });
  }
  try {
    assertFrameBytes(delta);
    const dimensions = normalizeDimensions(delta.dimensions);
    const changedRows = normalizeRows(delta.changedRows, dimensions, MAX_DELTA_ROWS);
    const cursor = normalizeCursor(delta.cursorState, dimensions);
    const title = normalizeTitle(delta.title);
    const rowMap = new Map<number, TuiRow>();
    if (dimensions.rows === state.dimensions.rows && dimensions.columns === state.dimensions.columns) {
      for (const row of state.rows) rowMap.set(row.row, row);
    }
    for (const row of changedRows) rowMap.set(row.row, row);
    const rows = [...rowMap.values()].filter((row) => row.row < dimensions.rows).sort((first, second) => first.row - second.row);
    const { replayGap: _replayGap, conflict: _conflict, ...current } = state;
    return {
      ...current,
      dimensions,
      rows,
      cursor,
      ...(title !== undefined ? { title } : state.title !== undefined ? { title: state.title } : {}),
      highWaterCursor: delta.cursor,
      sequence: delta.sequence,
      revision: state.revision + 1,
      status: "ready",
    };
  } catch (error) {
    return withConflict(state, {
      kind: "invalid-frame",
      message: error instanceof Error ? error.message : "TUI frame is invalid",
    });
  }
}

export function tuiFrameStoreReducer(state: TuiFrameStoreState, action: TuiFrameStoreAction): TuiFrameStoreState {
  switch (action.type) {
    case "snapshot": {
      try {
        const next = createTuiFrameStore(action.snapshot, action.role ?? state.role);
        return { ...next, revision: state.revision + 1, droppedDeltas: state.droppedDeltas };
      } catch (error) {
        return withConflict(state, {
          kind: "invalid-frame",
          message: error instanceof Error ? error.message : "TUI snapshot is invalid",
        });
      }
    }
    case "delta":
      return applyDelta(state, action.delta);
    case "replay_gap":
      if (!identityMatches(state.identity, action.gap.identity)) {
        return withConflict(state, { kind: "identity", message: "Replay gap belongs to another session generation" });
      }
      return {
        ...state,
        status: "replay-gap",
        replayGap: action.gap,
        highWaterCursor: action.gap.highWaterCursor,
      };
    case "control":
      if (!identityMatches(state.identity, action.event.identity)) {
        return withConflict(state, { kind: "identity", message: "Control event belongs to another session generation" });
      }
      return {
        ...state,
        role: action.event.action === "control_granted" ? "controller" : "observer",
      };
  }
}

export function tuiRowText(row: TuiRow | undefined): string {
  return row?.runs.map((run) => run.text).join("") ?? "";
}

export function tuiAccessibleText(state: TuiFrameStoreState): string {
  const rows = new Map(state.rows.map((row) => [row.row, row]));
  return Array.from({ length: state.dimensions.rows }, (_, index) => tuiRowText(rows.get(index)).trimEnd()).join("\n").trimEnd();
}
