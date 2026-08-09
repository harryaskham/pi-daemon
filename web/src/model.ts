import type {
  DashSessionPresence,
  NormalizedTranscriptRecord,
  PaneTarget as DashboardPaneTarget,
  SessionInventoryRecord,
} from "@harryaskham/pi-daemon/dashboard-contract";

export type InventoryId = SessionInventoryRecord["inventoryId"];
export type SessionPresence = DashSessionPresence;
export type TranscriptRecord = NormalizedTranscriptRecord;
export type PaneTarget = DashboardPaneTarget;

export interface SessionFixture extends SessionInventoryRecord {
  sessionId: string;
  generation: number;
  cwd: string;
  project: string;
  model: string;
  thinking: "off" | "minimal" | "low" | "medium" | "high";
  /** Null means live context usage has not been hydrated or Pi reports it unknown. */
  contextPercent: number | null;
}

export type DemoState = "ready" | "streaming" | "skeleton" | "empty" | "error";

export type LayoutNode =
  | { type: "leaf"; paneId: string; target: PaneTarget }
  | {
      type: "split";
      splitId: string;
      direction: "horizontal" | "vertical";
      ratio: number;
      first: LayoutNode;
      second: LayoutNode;
    };
