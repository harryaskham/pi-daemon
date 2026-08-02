// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

import { LiveSessionControls } from "../components/LiveSessionControls";
import type {
  DashboardLiveSessionController,
  DashboardLiveSessionState,
} from "../dashboard-live-session";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

async function renderLiveControls(
  state: DashboardLiveSessionState,
  overrides: Partial<DashboardLiveSessionController> = {},
) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const controller = {
    requestControl: vi.fn(),
    releaseControl: vi.fn(),
    markSeen: vi.fn(),
    exportSession: vi.fn(),
    answerExtensionUi: vi.fn(),
    ...overrides,
  } as unknown as DashboardLiveSessionController;
  await act(async () => root.render(<LiveSessionControls state={state} controller={controller} />));
  return {
    container,
    async unmount() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

describe("live session controls in a DOM environment", () => {
  it("provides the layout primitives component regressions need", () => {
    expect(document.createElement("div")).toBeInstanceOf(HTMLElement);
    expect(getComputedStyle(document.body)).toBeDefined();
    expect(ResizeObserver).toBeTypeOf("function");
  });

  it("renders preview status without the former transcript-blocking action card", async () => {
    const { container, unmount } = await renderLiveControls(previewState());
    try {
      expect(container.querySelector('[role="status"]')?.textContent).toContain("activation choice");
      expect(container.querySelector('[role="status"]')?.textContent).toContain("observer");
      expect(container.querySelector(".live-state-card")).toBeNull();
      expect(container.querySelector('[aria-label="Session action required"]')).toBeNull();
    } finally {
      await unmount();
    }
  });

  it("wires observer control requests through the mounted component", async () => {
    const requestControl = vi.fn().mockResolvedValue({ state: "completed" });
    const { container, unmount } = await renderLiveControls(
      previewState({ phase: "live", role: "observer" }),
      { requestControl },
    );
    try {
      const button = [...container.querySelectorAll("button")].find(
        (candidate) => candidate.textContent === "Request control",
      );
      expect(button).toBeDefined();
      await act(async () => button?.click());
      expect(requestControl).toHaveBeenCalledTimes(1);
    } finally {
      await unmount();
    }
  });
});
