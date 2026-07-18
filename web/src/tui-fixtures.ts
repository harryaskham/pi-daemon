import type {
  DashboardCursor,
  DashboardReplayGap,
  DashboardSessionIdentity,
  DashboardTuiDelta,
  DashboardTuiSnapshot,
  TuiRow,
  TuiStyle,
} from "@harryaskham/pi-daemon/dashboard-contract";
import type { TuiGridOverlay, TuiGridSelection } from "./components/TuiGrid";

export const TUI_FIXTURE_IDENTITY: DashboardSessionIdentity = {
  hostInstanceId: "fixture-host",
  sessionId: "fixture-tui-session",
  generation: 3,
};

function cursor(value: string): DashboardCursor {
  return value as DashboardCursor;
}

const palette = {
  blue: "#88c0d0",
  green: "#a3be8c",
  violet: "#b48ead",
  yellow: "#ebcb8b",
  muted: "#7f8da3",
  foreground: "#d8dee9",
  raised: "#3b4252",
} as const;

function run(text: string, style?: TuiStyle) {
  return { text, ...(style ? { style } : {}) };
}

function fixtureRows(rows: number): TuiRow[] {
  const content: TuiRow[] = [
    { row: 0, runs: [run(" Pi Daemon Dash ", { foreground: palette.blue, background: palette.raised, bold: true }), run(" one runtime · one writer", { foreground: palette.muted })] },
    { row: 2, runs: [run("❯ ", { foreground: palette.green, bold: true }), run("Inspect the active generation and preserve browser isolation.", { foreground: palette.foreground })] },
    { row: 4, runs: [run("assistant", { foreground: palette.violet, bold: true }), run("  The canonical virtual view is streaming bounded styled rows.", { foreground: palette.foreground })] },
    { row: 6, runs: [run("read", { foreground: palette.blue, bold: true }), run("  src/virtual-terminal.ts", { foreground: palette.muted })] },
    { row: 7, runs: [run("✓ 320×200 hard cell ceiling", { foreground: palette.green })] },
    { row: 8, runs: [run("✓ OSC 52 and image channels stripped", { foreground: palette.green })] },
    { row: 10, runs: [run("warning", { foreground: palette.yellow, bold: true }), run("  observer panes remain read only", { foreground: palette.muted })] },
    { row: rows - 2, runs: [run("NORMAL", { foreground: palette.raised, background: palette.green, bold: true }), run("  gen 3 · cursor 0000002a", { foreground: palette.muted })] },
  ];
  return [...new Map(content.filter((row) => row.row >= 0 && row.row < rows).map((row) => [row.row, row])).values()];
}

export function createTuiSnapshot(rows = 24, columns = 80): DashboardTuiSnapshot {
  return {
    identity: { ...TUI_FIXTURE_IDENTITY },
    dimensions: { rows, columns },
    rows: fixtureRows(rows),
    cursor: { row: Math.min(4, rows - 1), column: Math.min(68, columns - 1), visible: true, shape: "block" },
    title: "Pi Daemon · bounded shadow TUI",
    highWaterCursor: cursor("0000002a"),
  };
}

export function createTuiInputRuns(text: string) {
  return [
    run("terminal input", { foreground: palette.blue, bold: true }),
    run(` · ${text}`, { foreground: palette.foreground }),
  ];
}

export function createTuiDeltas(): DashboardTuiDelta[] {
  return [
    {
      kind: "tui_delta",
      identity: { ...TUI_FIXTURE_IDENTITY },
      cursor: cursor("0000002b"),
      sequence: 1,
      dimensions: { rows: 24, columns: 80 },
      changedRows: [
        { row: 4, runs: [run("assistant", { foreground: palette.violet, bold: true }), run("  Applying a styled row delta in under one frame.", { foreground: palette.foreground })] },
        { row: 11, runs: [run("stream", { foreground: palette.blue }), run("  ▌", { foreground: palette.green, bold: true })] },
      ],
      cursorState: { row: 11, column: 9, visible: true, shape: "bar" },
      title: "Pi Daemon · streaming",
    },
    {
      kind: "tui_delta",
      identity: { ...TUI_FIXTURE_IDENTITY },
      cursor: cursor("0000002c"),
      sequence: 2,
      dimensions: { rows: 24, columns: 80 },
      changedRows: [
        { row: 11, runs: [run("stream", { foreground: palette.blue }), run("  settled", { foreground: palette.green })] },
      ],
      cursorState: { row: 12, column: 0, visible: true, shape: "block" },
    },
  ];
}

export function createTuiReplayGap(): DashboardReplayGap {
  return {
    kind: "replay_gap",
    identity: { ...TUI_FIXTURE_IDENTITY },
    reason: "cursor-expired",
    requestedCursor: cursor("00000010"),
    highWaterCursor: cursor("0000002c"),
    oldestAvailableCursor: cursor("00000020"),
    snapshotFollows: true,
  };
}

export const TUI_FIXTURE_SELECTION: TuiGridSelection = {
  start: { row: 4, column: 11 },
  end: { row: 4, column: 39 },
};

export const TUI_FIXTURE_OVERLAYS: readonly TuiGridOverlay[] = [
  { id: "fixture-dialog", kind: "dialog", row: 11, column: 14, rows: 5, columns: 40, label: "Extension confirmation · read-only fixture" },
  { id: "fixture-image", kind: "image-placeholder", row: 11, column: 56, rows: 4, columns: 16, label: "Terminal image withheld safely" },
];
