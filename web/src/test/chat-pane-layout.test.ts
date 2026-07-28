import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import {
  liveComposerPresentation,
  measuredRecordHeight,
  restoredTranscriptScrollTop,
  transcriptDistanceFromBottom,
} from "../components/ChatPane";
import type { DashboardLiveSessionState } from "../dashboard-live-session";

function previewState(
  overrides: Partial<DashboardLiveSessionState> = {},
): DashboardLiveSessionState {
  return {
    inventoryId: "preview-layout",
    phase: "activation-choice",
    role: "observer",
    rpcState: {},
    requestState: {},
    activationModes: ["direct", "fork", "preview-only"],
    selectedActivationMode: "fork",
    extensionRequests: [],
    extensionViews: [],
    extensionNotifications: [],
    extensionStatuses: {},
    extensionWidgets: {},
    treePhase: "idle",
    unread: false,
    info: {
      inventoryId: "preview-layout",
      sourceKind: "external",
      title: "Preview layout",
      createdAt: "2026-07-19T00:00:00.000Z",
      modifiedAt: "2026-07-19T00:00:00.000Z",
      messageCount: 1,
      activation: { eligible: true, modes: ["direct", "fork", "preview-only"] },
      presence: {
        runtime: "unmanaged",
        activation: "selected",
        focusedPaneCount: 1,
        unread: false,
      },
      cwd: "/work/preview",
      source: { aliases: [] },
      ownership: { mode: "none" },
      diagnostics: [],
    },
    ...overrides,
  };
}

describe("preview composer layout", () => {
  it("describes wake-on-first-send without requiring live controller authority", () => {
    expect(liveComposerPresentation(previewState())).toEqual({
      disabled: false,
      submitLabel: "Activate & send",
      hint: "First send will safe fork, hydrate, and wake this session",
      status: "First send will safe fork, hydrate, and wake this session",
      tone: "normal",
    });
  });

  it("keeps transcript as the only flexible scroll row and footer as a fixed grid row", async () => {
    const css = await readFile(new URL("../app.css", import.meta.url), "utf8");
    expect(css).toMatch(
      /\.chat-pane \{[^}]*grid-template-rows: var\(--dash-header-height\) 31px auto minmax\(0, 1fr\) auto;/,
    );
    expect(css).toMatch(/\.transcript \{[^}]*overflow: auto;/);
    expect(css).toMatch(/\.chat-pane__footer \{[^}]*position: relative;[^}]*z-index: 8;/);
  });

  it("keeps new-session configuration scrollable with a fixed composer footer", async () => {
    const css = await readFile(new URL("../app.css", import.meta.url), "utf8");
    expect(css).toMatch(
      /\.new-session-pane \{[^}]*grid-template-rows: var\(--dash-header-height\) minmax\(0, 1fr\) auto;/,
    );
    expect(css).toMatch(/\.new-session-body \{[^}]*overflow: auto;/);
    expect(css).toMatch(/@media \(max-width: 720px\)[\s\S]*\.new-session-form, \.new-session-resource-grid \{ grid-template-columns: 1fr; \}/);
  });

  it("keeps declarative extension rendering inert and free of extension-controlled browser execution or fetches", async () => {
    const source = await readFile(
      new URL("../components/DeclarativeExtensionView.tsx", import.meta.url),
      "utf8",
    );
    expect(source).not.toContain("dangerouslySetInnerHTML");
    expect(source).not.toMatch(/\beval\s*\(|new Function|\bfetch\s*\(|<iframe|<script|<style|src=\{/);
    expect(source).toContain("createExtensionViewResponse");
    expect(source).toContain("authorized blob");
  });

  it("keeps branch navigation virtualized, keyboard-addressable, and explicit about active leaf truth", async () => {
    const source = await readFile(
      new URL("../components/SessionTreeNavigator.tsx", import.meta.url),
      "utf8",
    );
    expect(source).toContain("useVirtualizer");
    expect(source).toContain('role="tree"');
    expect(source).toContain('role="treeitem"');
    expect(source).toContain("aria-current");
    expect(source).toContain('event.key === "ArrowLeft"');
    expect(source).toContain('event.key === "ArrowRight"');
    expect(source).not.toContain("dangerouslySetInnerHTML");
  });

  it("keeps configurable composer submission explicit and composition-safe", async () => {
    const source = await readFile(
      new URL("../components/Composer.tsx", import.meta.url),
      "utf8",
    );
    expect(source).toContain('submitKey === "enter" ? "Enter" : "Mod-Enter"');
    expect(source).toContain('key: "Shift-Enter"');
    expect(source).toContain("view.composing");
    expect(source).toContain("Prec.highest");
  });

  it("does not render the former transcript-blocking preview action card", async () => {
    const source = await readFile(
      new URL("../components/LiveSessionControls.tsx", import.meta.url),
      "utf8",
    );
    expect(source).not.toContain("live-state-card");
    expect(source).not.toContain('aria-label="Session action required"');
  });
});

describe("transcript reading anchor across a presentation switch", () => {
  it("measures the anchor as distance from the bottom, never negative", () => {
    expect(transcriptDistanceFromBottom(24_329, 21_000, 800)).toBe(2_529);
    expect(transcriptDistanceFromBottom(24_329, 23_529, 800)).toBe(0);
    // Overscrolled or mid-relayout values must not produce a negative anchor.
    expect(transcriptDistanceFromBottom(1_000, 900, 200)).toBe(0);
    expect(transcriptDistanceFromBottom(Number.NaN, 0, 800)).toBe(0);
  });

  it("restores the same reading anchor after the total size is remeasured", () => {
    // Same "111px from the bottom" reading position, two different total sizes.
    expect(restoredTranscriptScrollTop(24_329, 800, 111)).toBe(23_418);
    expect(restoredTranscriptScrollTop(22_658, 800, 111)).toBe(21_747);
    expect(
      transcriptDistanceFromBottom(22_658, restoredTranscriptScrollTop(22_658, 800, 111), 800),
    ).toBe(111);
  });

  it("clamps a restored anchor into the current scroll range", () => {
    // Anchor deeper than the transcript is now tall: land on the latest record.
    expect(restoredTranscriptScrollTop(1_200, 800, 5_000)).toBe(0);
    // Nothing to scroll at all.
    expect(restoredTranscriptScrollTop(800, 800, 111)).toBe(0);
    expect(restoredTranscriptScrollTop(600, 800, 111)).toBe(0);
    // Pinned to the bottom stays pinned to the bottom.
    expect(restoredTranscriptScrollTop(24_329, 800, 0)).toBe(23_529);
  });

  it("never caches the zero heights a hidden Rich layer reports", () => {
    // Laid out: trust the live measurement.
    expect(measuredRecordHeight(148, 132, 132)).toBe(148);
    // Hidden by the presentation switch: keep the last known size.
    expect(measuredRecordHeight(0, 148, 132)).toBe(148);
    // Hidden before it was ever measured: fall back to the estimate.
    expect(measuredRecordHeight(0, undefined, 126)).toBe(126);
    expect(measuredRecordHeight(0, 0, 126)).toBe(126);
    expect(measuredRecordHeight(Number.NaN, undefined, 132)).toBe(132);
    expect(measuredRecordHeight(-4, 132, 126)).toBe(132);
  });
});
