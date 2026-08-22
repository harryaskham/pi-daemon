// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

import { TuiPane } from "../components/TuiPane";
import type { DashboardCursor } from "@harryaskham/pi-daemon/dashboard-contract";
import type { SessionFixture } from "../model";
import type { TuiFrameStoreState } from "../tui-frame-store";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const session: SessionFixture = {
  inventoryId: "inventory-tui-controls",
  sourceKind: "managed",
  title: "Managed TUI",
  sessionId: "session-tui-controls",
  generation: 3,
  cwd: "/work/project",
  project: "project",
  model: "fixture/model",
  thinking: "medium",
  contextPercent: 12,
  createdAt: "2026-08-22T00:00:00.000Z",
  modifiedAt: "2026-08-22T00:01:00.000Z",
  activityAt: "2026-08-22T00:01:00.000Z",
  messageCount: 2,
  toolCallCount: 1,
  activation: { eligible: true, modes: ["reuse"] },
  presence: {
    runtime: "resident-idle",
    activation: "user-turn",
    focusedPaneCount: 1,
    unread: false,
  },
};

function state(role: "controller" | "observer"): TuiFrameStoreState {
  return {
    identity: { hostInstanceId: "host-tui", sessionId: session.sessionId, generation: session.generation },
    role,
    dimensions: { rows: 24, columns: 80 },
    rows: [],
    cursor: { row: 0, column: 0, visible: false },
    highWaterCursor: "cursor-tui" as DashboardCursor,
    sequence: 1,
    revision: 1,
    status: "ready",
    droppedDeltas: 0,
  };
}

async function render(role: "controller" | "observer", onAbort = vi.fn()) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(
    <TuiPane
      session={session}
      state={state(role)}
      selected
      active={false}
      onPresentationChange={vi.fn()}
      onAbort={onAbort}
    />,
  ));
  return {
    container,
    onAbort,
    async unmount() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

describe("TUI pane lifecycle controls", () => {
  it("lets the controlling pane interrupt through the out-of-band TUI input path", async () => {
    const view = await render("controller");
    try {
      const button = view.container.querySelector<HTMLButtonElement>(
        '[aria-label="Interrupt active TUI interaction"]',
      );
      expect(button?.disabled).toBe(false);
      await act(async () => button?.click());
      expect(view.onAbort).toHaveBeenCalledTimes(1);
    } finally {
      await view.unmount();
    }
  });

  it("does not expose interrupt authority to observer panes", async () => {
    const view = await render("observer");
    try {
      const button = view.container.querySelector<HTMLButtonElement>(
        '[aria-label="Interrupt active TUI interaction"]',
      );
      expect(button?.disabled).toBe(true);
      await act(async () => button?.click());
      expect(view.onAbort).not.toHaveBeenCalled();
    } finally {
      await view.unmount();
    }
  });
});
