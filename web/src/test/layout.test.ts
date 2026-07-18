import { describe, expect, it } from "vitest";
import { clampRatio, findDirectionalNeighbor, INITIAL_LAYOUT, swapPaneTargets, updatePaneTarget, updateSplitRatio } from "../layout";
import type { InventoryId } from "../model";

const alpha = "inv_alpha" as InventoryId;
const beta = "inv_beta" as InventoryId;

describe("split-tree workspace", () => {
  it("clamps pointer and keyboard resize ratios to usable pane bounds", () => {
    expect(clampRatio(-1)).toBe(0.18);
    expect(clampRatio(0.5)).toBe(0.5);
    expect(clampRatio(2)).toBe(0.82);
    const resized = updateSplitRatio(INITIAL_LAYOUT, "root-split", 0.91);
    expect(resized.type).toBe("split");
    if (resized.type === "split") expect(resized.ratio).toBe(0.82);
  });

  it("swaps pane content without changing tree identity", () => {
    const populated = updatePaneTarget(
      updatePaneTarget(INITIAL_LAYOUT, "primary", { type: "chat", inventoryId: alpha, presentation: "rich" }),
      "inspector",
      { type: "info", inventoryId: beta },
    );
    const swapped = swapPaneTargets(populated, "primary", "inspector");
    expect(swapped).toMatchObject({
      type: "split",
      splitId: "root-split",
      first: { type: "leaf", paneId: "primary", target: { type: "info", inventoryId: beta } },
      second: { type: "leaf", paneId: "inspector", target: { type: "chat", inventoryId: alpha, presentation: "rich" } },
    });
  });

  it("chooses the nearest spatial pane in the requested direction", () => {
    const rects = [
      { paneId: "left", left: 0, top: 0, right: 400, bottom: 500 },
      { paneId: "right-top", left: 410, top: 0, right: 800, bottom: 240 },
      { paneId: "right-bottom", left: 410, top: 270, right: 800, bottom: 500 },
    ];
    expect(findDirectionalNeighbor(rects, "left", "right")).toBe("right-top");
    expect(findDirectionalNeighbor(rects, "right-top", "down")).toBe("right-bottom");
    expect(findDirectionalNeighbor(rects, "right-bottom", "left")).toBe("left");
    expect(findDirectionalNeighbor(rects, "left", "left")).toBeUndefined();
  });
});
