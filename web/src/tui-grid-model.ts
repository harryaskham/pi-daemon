import { DASH_DEFAULT_LIMITS, type DashboardTuiInput, type TuiDimensions } from "@harryaskham/pi-daemon/dashboard-contract";

export interface TuiCellMetrics {
  width: number;
  height: number;
}

export interface TuiKeyboardLike {
  key: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
  isComposing?: boolean;
}

export interface TuiVisibleRange {
  start: number;
  end: number;
}

const semanticKeys: Readonly<Record<string, string>> = {
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
  Enter: "enter",
  Escape: "escape",
  Backspace: "backspace",
  Delete: "delete",
  Tab: "tab",
  Home: "home",
  End: "end",
  PageUp: "pageup",
  PageDown: "pagedown",
  Insert: "insert",
};
const modifierKeys = new Set(["Alt", "AltGraph", "Control", "Meta", "Shift", "CapsLock", "NumLock", "ScrollLock"]);
const paneNavigationKeys = new Set(["h", "j", "k", "l"]);

export function deriveTuiDimensions(
  availableWidth: number,
  availableHeight: number,
  metrics: TuiCellMetrics,
): TuiDimensions {
  const cellWidth = Number.isFinite(metrics.width) && metrics.width > 0 ? metrics.width : 8;
  const cellHeight = Number.isFinite(metrics.height) && metrics.height > 0 ? metrics.height : 16;
  const columns = Math.max(1, Math.min(DASH_DEFAULT_LIMITS.maxTuiColumns, Math.floor(Math.max(0, availableWidth) / cellWidth)));
  const rows = Math.max(1, Math.min(DASH_DEFAULT_LIMITS.maxTuiRows, Math.floor(Math.max(0, availableHeight) / cellHeight)));
  return { rows, columns };
}

export function visibleTuiRowRange(
  scrollTop: number,
  viewportHeight: number,
  rowHeight: number,
  rowCount: number,
  overscan = 3,
): TuiVisibleRange {
  if (rowCount <= 0) return { start: 0, end: 0 };
  const safeHeight = Number.isFinite(rowHeight) && rowHeight > 0 ? rowHeight : 16;
  const start = Math.max(0, Math.floor(Math.max(0, scrollTop) / safeHeight) - Math.max(0, overscan));
  const visible = Math.max(1, Math.ceil(Math.max(0, viewportHeight) / safeHeight));
  return { start, end: Math.min(rowCount, start + visible + Math.max(0, overscan) * 2) };
}

export function keyboardEventToTuiInput(event: TuiKeyboardLike): DashboardTuiInput | undefined {
  if (event.isComposing || !event.key || event.key.length > 128 || modifierKeys.has(event.key)) return undefined;
  const lowered = event.key.toLowerCase();
  if (event.ctrlKey && !event.altKey && !event.metaKey && paneNavigationKeys.has(lowered)) return undefined;
  const key = semanticKeys[event.key] ?? (event.key.startsWith("F") && /^F(?:[1-9]|1[0-2])$/u.test(event.key) ? lowered : event.key);
  if (key.length > 128 || key === "Dead" || key === "Process" || key === "Unidentified") return undefined;
  const modifiers: Array<"ctrl" | "alt" | "shift" | "meta"> = [];
  if (event.ctrlKey) modifiers.push("ctrl");
  if (event.altKey) modifiers.push("alt");
  if (event.shiftKey) modifiers.push("shift");
  if (event.metaKey) modifiers.push("meta");
  return { type: "key", key, ...(modifiers.length > 0 ? { modifiers } : {}) };
}

export function pasteToTuiInput(text: string): DashboardTuiInput | undefined {
  if (typeof text !== "string" || text.length === 0 || text.length > 262_144) return undefined;
  return { type: "paste", text };
}
