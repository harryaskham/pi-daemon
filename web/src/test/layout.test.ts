import { describe, expect, it } from "vitest";
import {
  clampRatio,
  closePane,
  collectPaneIds,
  findDirectionalNeighbor,
  fromDashboardLayout,
  INITIAL_LAYOUT,
  splitPane,
  swapPaneTargets,
  toDashboardLayout,
  updatePaneTarget,
  updateSplitRatio,
} from "../layout";
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

  it("splits a populated leaf and closes by promoting its sibling", () => {
    const populated = updatePaneTarget(INITIAL_LAYOUT, "primary", { type: "chat", inventoryId: alpha, presentation: "rich" });
    const split = splitPane(populated, "primary", "vertical", "third");
    expect(collectPaneIds(split)).toEqual(["primary", "third", "inspector"]);
    expect(split).toMatchObject({
      type: "split",
      first: {
        type: "split",
        direction: "vertical",
        first: { type: "leaf", paneId: "primary", target: { type: "chat", inventoryId: alpha } },
        second: { type: "leaf", paneId: "third", target: { type: "empty" } },
      },
    });
    expect(collectPaneIds(closePane(split, "primary"))).toEqual(["third", "inspector"]);
    expect(collectPaneIds(closePane(INITIAL_LAYOUT, "primary"))).toEqual(["inspector"]);
  });

  it("round-trips through the public revisioned workspace layout shape", () => {
    const populated = updatePaneTarget(INITIAL_LAYOUT, "primary", { type: "chat", inventoryId: alpha, presentation: "rich" });
    const wire = toDashboardLayout(populated);
    expect(wire).not.toHaveProperty("splitId");
    const restored = fromDashboardLayout(wire);
    expect(collectPaneIds(restored)).toEqual(["primary", "inspector"]);
    expect(restored).toMatchObject({ type: "split", direction: "horizontal", ratio: 0.68 });
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
