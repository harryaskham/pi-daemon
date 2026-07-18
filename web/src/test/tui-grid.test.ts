import { performance } from "node:perf_hooks";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type {
  DashboardCursor,
  DashboardSessionIdentity,
  DashboardTuiDelta,
  DashboardTuiSnapshot,
} from "@harryaskham/pi-daemon/dashboard-contract";
import { TuiGrid } from "../components/TuiGrid";
import { createTuiDeltas, createTuiReplayGap, createTuiSnapshot, TUI_FIXTURE_IDENTITY, TUI_FIXTURE_OVERLAYS } from "../tui-fixtures";
import { deriveTuiDimensions, keyboardEventToTuiInput, pasteToTuiInput, visibleTuiRowRange } from "../tui-grid-model";
import { createTuiFrameStore, TuiFrameCache, tuiAccessibleText, tuiFrameStoreReducer, tuiRowText } from "../tui-frame-store";

function percentile(values: number[], fraction: number): number {
  return [...values].sort((first, second) => first - second)[Math.min(values.length - 1, Math.ceil(values.length * fraction) - 1)] ?? 0;
}

function cursor(value: string): DashboardCursor {
  return value as DashboardCursor;
}

function identity(overrides: Partial<DashboardSessionIdentity> = {}): DashboardSessionIdentity {
  return { ...TUI_FIXTURE_IDENTITY, ...overrides };
}

describe("TUI frame store", () => {
  it("applies styled row deltas without mutating the canonical snapshot", () => {
    const snapshot = createTuiSnapshot();
    const initial = createTuiFrameStore(snapshot, "controller");
    const [first, second] = createTuiDeltas();
    if (!first || !second) throw new Error("missing fixture deltas");

    const streamed = tuiFrameStoreReducer(initial, { type: "delta", delta: first });
    const settled = tuiFrameStoreReducer(streamed, { type: "delta", delta: second });

    expect(initial.sequence).toBe(0);
    expect(tuiRowText(initial.rows.find((row) => row.row === 4))).toContain("canonical virtual view");
    expect(tuiRowText(streamed.rows.find((row) => row.row === 4))).toContain("under one frame");
    expect(tuiRowText(settled.rows.find((row) => row.row === 11))).toContain("settled");
    expect(settled).toMatchObject({ status: "ready", sequence: 2, revision: 3, role: "controller" });
  });

  it("ignores stale frames and fails closed on gaps and foreign generations", () => {
    const initial = createTuiFrameStore(createTuiSnapshot(), "observer");
    const first = createTuiDeltas()[0];
    if (!first) throw new Error("missing fixture delta");
    const current = tuiFrameStoreReducer(initial, { type: "delta", delta: first });
    const stale = tuiFrameStoreReducer(current, { type: "delta", delta: first });
    expect(stale.sequence).toBe(1);
    expect(stale.droppedDeltas).toBe(1);

    const gap = tuiFrameStoreReducer(current, { type: "delta", delta: { ...first, sequence: 3 } });
    expect(gap.status).toBe("conflict");
    expect(gap.conflict).toMatchObject({ kind: "sequence", expected: 2, received: 3 });

    const foreign = tuiFrameStoreReducer(initial, {
      type: "delta",
      delta: { ...first, identity: identity({ generation: 4 }) },
    });
    expect(foreign.status).toBe("conflict");
    expect(foreign.conflict?.kind).toBe("identity");
  });

  it("surfaces replay gaps, controller transitions, and authoritative snapshot recovery", () => {
    const initial = createTuiFrameStore(createTuiSnapshot(), "controller");
    const paused = tuiFrameStoreReducer(initial, { type: "replay_gap", gap: createTuiReplayGap() });
    expect(paused.status).toBe("replay-gap");
    expect(paused.replayGap?.reason).toBe("cursor-expired");

    const released = tuiFrameStoreReducer(paused, {
      type: "control",
      event: { kind: "control", identity: identity(), action: "control_released" },
    });
    expect(released.role).toBe("observer");

    const recovered = tuiFrameStoreReducer(released, { type: "snapshot", snapshot: createTuiSnapshot(), role: "observer" });
    expect(recovered.status).toBe("ready");
    expect(recovered.replayGap).toBeUndefined();
    expect(recovered.revision).toBe(initial.revision + 1);
  });

  it("sanitizes terminal text and CSS colors while bounding frame structure", () => {
    const snapshot: DashboardTuiSnapshot = {
      ...createTuiSnapshot(2, 8),
      rows: [{
        row: 0,
        runs: [
          { text: "safe\u0000\u202etext", style: { foreground: "url(javascript:bad)", bold: true } },
          { text: "!", style: { bold: true } },
        ],
      }],
      cursor: { row: 0, column: 7, visible: true },
    };
    const state = createTuiFrameStore(snapshot);
    expect(tuiRowText(state.rows[0])).toBe("safetext!");
    expect(state.rows[0]?.runs).toEqual([{ text: "safetext!", style: { bold: true } }]);
    expect(tuiAccessibleText(state)).not.toMatch(/[\u0000\u202e]/u);

    expect(() => createTuiFrameStore({
      ...snapshot,
      dimensions: { rows: 201, columns: 8 },
    })).toThrow(/TUI rows/);
    expect(() => createTuiFrameStore({
      ...snapshot,
      rows: [{ row: 0, runs: Array.from({ length: 9 }, () => ({ text: "x" })) }],
    })).toThrow(/too many styled runs/);
  });

  it("renders terminal text as escaped accessible content and images only as placeholders", () => {
    const snapshot = createTuiSnapshot();
    snapshot.rows = [{ row: 0, runs: [{ text: "<script>unsafe()</script> safe" }] }];
    const state = createTuiFrameStore(snapshot, "observer");
    const markup = renderToStaticMarkup(createElement(TuiGrid, { state, overlays: TUI_FIXTURE_OVERLAYS }));
    expect(markup).toContain("&lt;script&gt;unsafe()&lt;/script&gt; safe");
    expect(markup).not.toContain("<script>");
    expect(markup).not.toContain("<img");
    expect(markup).toContain("Terminal image withheld safely");
    expect(markup).toContain("read-only observer");
    expect(markup).toContain("Accessible terminal text");
  });

  it("renders replay-gap and conflict recovery without discarding the last safe frame", () => {
    const initial = createTuiFrameStore(createTuiSnapshot());
    const paused = tuiFrameStoreReducer(initial, { type: "replay_gap", gap: createTuiReplayGap() });
    const gapMarkup = renderToStaticMarkup(createElement(TuiGrid, { state: paused, onRequestSnapshot() {} }));
    expect(gapMarkup).toContain("Terminal replay paused");
    expect(gapMarkup).toContain("cursor-expired");
    expect(gapMarkup).toContain("Load fresh snapshot");
    expect(gapMarkup).toContain("Pi Daemon Dash");

    const first = createTuiDeltas()[0];
    if (!first) throw new Error("missing fixture delta");
    const conflicted = tuiFrameStoreReducer(initial, { type: "delta", delta: { ...first, identity: identity({ generation: 99 }) } });
    const conflictMarkup = renderToStaticMarkup(createElement(TuiGrid, { state: conflicted }));
    expect(conflictMarkup).toContain("Terminal view conflict");
    expect(conflictMarkup).toContain("another host, session, or generation");
  });

  it("virtualizes styled row DOM while retaining one bounded accessibility mirror", () => {
    const snapshot = createTuiSnapshot();
    snapshot.rows = Array.from({ length: 24 }, (_, row) => ({
      row,
      runs: Array.from({ length: 80 }, (_, column) => ({
        text: String((row + column) % 10),
        style: { foreground: column % 2 === 0 ? "#88c0d0" : "#d8dee9" },
      })),
    }));
    const markup = renderToStaticMarkup(createElement(TuiGrid, { state: createTuiFrameStore(snapshot) }));
    expect(markup.match(/class="tui-grid__row"/gu)?.length).toBeLessThanOrEqual(7);
    expect(markup.match(/data-row=/gu)?.length).toBeLessThanOrEqual(7);
    expect(markup.match(/Accessible terminal text/gu)?.length).toBe(1);
  });

  it("bounds canonical per-session frame retention by LRU count and bytes", () => {
    const cache = new TuiFrameCache<string>({ maxEntries: 2, maxBytes: 128 * 1024, maxEntryBytes: 64 * 1024 });
    const first = createTuiFrameStore(createTuiSnapshot());
    const second = createTuiFrameStore({ ...createTuiSnapshot(), identity: identity({ sessionId: "second" }) });
    const third = createTuiFrameStore({ ...createTuiSnapshot(), identity: identity({ sessionId: "third" }) });
    cache.set("first", first);
    cache.set("second", second);
    expect(cache.get("first")).toBe(first);
    cache.set("third", third);
    expect(cache.get("second")).toBeUndefined();
    expect(cache.size).toBe(2);
    expect(cache.bytes).toBeGreaterThan(0);
    expect(() => new TuiFrameCache<string>({ maxEntries: 2, maxBytes: 256, maxEntryBytes: 64 }).set("large", first)).toThrow(/byte bound/);
  });

  it("keeps representative delta reduction within one 60fps frame", () => {
    let state = createTuiFrameStore(createTuiSnapshot(), "controller");
    const samples: number[] = [];
    for (let sequence = 1; sequence <= 240; sequence += 1) {
      const delta: DashboardTuiDelta = {
        kind: "tui_delta",
        identity: identity(),
        cursor: cursor(sequence.toString(16).padStart(8, "0")),
        sequence,
        dimensions: { rows: 24, columns: 80 },
        changedRows: [{ row: sequence % 24, runs: [{ text: `frame ${sequence}`, style: { foreground: "#88c0d0" } }] }],
        cursorState: { row: sequence % 24, column: sequence % 80, visible: true },
      };
      const started = performance.now();
      state = tuiFrameStoreReducer(state, { type: "delta", delta });
      samples.push(performance.now() - started);
    }
    expect(state.sequence).toBe(240);
    expect(percentile(samples, 0.95)).toBeLessThan(16);
  });
});

describe("TUI grid browser model", () => {
  it("derives bounded terminal dimensions and virtual row ranges", () => {
    expect(deriveTuiDimensions(840, 408, { width: 8.4, height: 17 })).toEqual({ rows: 24, columns: 100 });
    expect(deriveTuiDimensions(99_999, 99_999, { width: 1, height: 1 })).toEqual({ rows: 200, columns: 320 });
    expect(deriveTuiDimensions(0, 0, { width: 0, height: 0 })).toEqual({ rows: 1, columns: 1 });
    expect(visibleTuiRowRange(340, 340, 17, 200)).toEqual({ start: 17, end: 43 });
  });

  it("maps terminal keys while preserving workspace navigation and bounded paste", () => {
    const base = { ctrlKey: false, altKey: false, shiftKey: false, metaKey: false };
    expect(keyboardEventToTuiInput({ ...base, key: "ArrowUp" })).toEqual({ type: "key", key: "up" });
    expect(keyboardEventToTuiInput({ ...base, key: "c", ctrlKey: true })).toEqual({ type: "key", key: "c", modifiers: ["ctrl"] });
    expect(keyboardEventToTuiInput({ ...base, key: "h", ctrlKey: true })).toBeUndefined();
    expect(keyboardEventToTuiInput({ ...base, key: "Shift" })).toBeUndefined();
    expect(pasteToTuiInput("hello")).toEqual({ type: "paste", text: "hello" });
    expect(pasteToTuiInput("x".repeat(262_145))).toBeUndefined();
  });
});
