// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

import { SteeringQueue } from "../components/SteeringQueue";
import type { PendingSteeringMessage } from "../dashboard-live-session";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function message(
  queueId: string,
  state: PendingSteeringMessage["state"],
  preview: string,
): PendingSteeringMessage {
  return {
    queueId,
    state,
    preview,
    truncated: false,
    queuedAt: "2026-08-11T00:00:00.000Z",
  };
}

describe("steering queue", () => {
  it("shows FIFO state and cancels only browser-held messages", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const onCancel = vi.fn();
    await act(async () => root.render(
      <SteeringQueue
        messages={[
          message("pending", "pending", "inspect the next tool result"),
          message("delivered", "delivered", "then summarize"),
          message("unknown", "indeterminate", "do not replay this"),
        ]}
        onCancel={onCancel}
      />,
    ));
    try {
      expect(container.querySelector("header")?.textContent).toContain("3 pending · FIFO");
      expect(container.textContent).toContain("Waiting for the next steering point");
      expect(container.textContent).toContain("Accepted by Pi · waiting to be consumed");
      expect(container.textContent).toContain("Delivery outcome unknown · do not resend");
      const buttons = container.querySelectorAll<HTMLButtonElement>("button");
      expect(buttons).toHaveLength(1);
      await act(async () => buttons[0]?.click());
      expect(onCancel).toHaveBeenCalledWith("pending");
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  it("renders nothing for an empty queue", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    await act(async () => root.render(<SteeringQueue messages={[]} onCancel={() => undefined} />));
    expect(container.innerHTML).toBe("");
    await act(async () => root.unmount());
  });
});
