import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import { liveComposerPresentation } from "../components/ChatPane";
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
    extensionNotifications: [],
    extensionStatuses: {},
    extensionWidgets: {},
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

  it("does not render the former transcript-blocking preview action card", async () => {
    const source = await readFile(
      new URL("../components/LiveSessionControls.tsx", import.meta.url),
      "utf8",
    );
    expect(source).not.toContain("live-state-card");
    expect(source).not.toContain('aria-label="Session action required"');
  });
});
