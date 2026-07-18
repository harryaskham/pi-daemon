import type { DashboardLayoutNode } from "@harryaskham/pi-daemon/dashboard-contract";
import type { LayoutNode, PaneTarget } from "./model";

export interface PaneRect {
  paneId: string;
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export type Direction = "left" | "right" | "up" | "down";

export const INITIAL_LAYOUT: LayoutNode = {
  type: "split",
  splitId: "root-split",
  direction: "horizontal",
  ratio: 0.68,
  first: {
    type: "leaf",
    paneId: "primary",
    target: { type: "empty" },
  },
  second: {
    type: "leaf",
    paneId: "inspector",
    target: { type: "empty" },
  },
};

export function clampRatio(ratio: number): number {
  return Math.min(0.82, Math.max(0.18, ratio));
}

export function updateSplitRatio(node: LayoutNode, splitId: string, ratio: number): LayoutNode {
  if (node.type === "leaf") return node;
  if (node.splitId === splitId) return { ...node, ratio: clampRatio(ratio) };
  return {
    ...node,
    first: updateSplitRatio(node.first, splitId, ratio),
    second: updateSplitRatio(node.second, splitId, ratio),
  };
}

export function updatePaneTarget(node: LayoutNode, paneId: string, target: PaneTarget): LayoutNode {
  if (node.type === "leaf") return node.paneId === paneId ? { ...node, target } : node;
  return {
    ...node,
    first: updatePaneTarget(node.first, paneId, target),
    second: updatePaneTarget(node.second, paneId, target),
  };
}

export function findPaneTarget(node: LayoutNode, paneId: string): PaneTarget | undefined {
  if (node.type === "leaf") return node.paneId === paneId ? node.target : undefined;
  return findPaneTarget(node.first, paneId) ?? findPaneTarget(node.second, paneId);
}

export function swapPaneTargets(node: LayoutNode, firstPaneId: string, secondPaneId: string): LayoutNode {
  const firstTarget = findPaneTarget(node, firstPaneId);
  const secondTarget = findPaneTarget(node, secondPaneId);
  if (!firstTarget || !secondTarget || firstPaneId === secondPaneId) return node;
  return updatePaneTarget(updatePaneTarget(node, firstPaneId, secondTarget), secondPaneId, firstTarget);
}

export function collectPaneIds(node: LayoutNode): string[] {
  if (node.type === "leaf") return [node.paneId];
  return [...collectPaneIds(node.first), ...collectPaneIds(node.second)];
}

export function splitPane(
  node: LayoutNode,
  paneId: string,
  direction: "horizontal" | "vertical",
  newPaneId: string,
): LayoutNode {
  if (node.type === "leaf") {
    if (node.paneId !== paneId) return node;
    return {
      type: "split",
      splitId: `split-${paneId}-${newPaneId}`,
      direction,
      ratio: 0.5,
      first: node,
      second: { type: "leaf", paneId: newPaneId, target: { type: "empty" } },
    };
  }
  return {
    ...node,
    first: splitPane(node.first, paneId, direction, newPaneId),
    second: splitPane(node.second, paneId, direction, newPaneId),
  };
}

function removePane(node: LayoutNode, paneId: string): LayoutNode | undefined {
  if (node.type === "leaf") return node.paneId === paneId ? undefined : node;
  const first = removePane(node.first, paneId);
  const second = removePane(node.second, paneId);
  if (!first) return second;
  if (!second) return first;
  return { ...node, first, second };
}

export function closePane(node: LayoutNode, paneId: string): LayoutNode {
  if (node.type === "leaf") return node;
  return removePane(node, paneId) ?? node;
}

export function toDashboardLayout(node: LayoutNode): DashboardLayoutNode {
  if (node.type === "leaf") {
    return {
      type: "leaf",
      paneId: node.paneId,
      ...(node.target.type === "empty" ? {} : { content: node.target }),
    };
  }
  return {
    type: "split",
    direction: node.direction,
    ratio: node.ratio,
    first: toDashboardLayout(node.first),
    second: toDashboardLayout(node.second),
  };
}

export function fromDashboardLayout(node: DashboardLayoutNode, path = "root"): LayoutNode {
  if (node.type === "leaf") {
    return { type: "leaf", paneId: node.paneId, target: node.content ?? { type: "empty" } };
  }
  return {
    type: "split",
    splitId: `split-${path}`,
    direction: node.direction,
    ratio: clampRatio(node.ratio),
    first: fromDashboardLayout(node.first, `${path}-first`),
    second: fromDashboardLayout(node.second, `${path}-second`),
  };
}

function center(rect: PaneRect): { x: number; y: number } {
  return { x: (rect.left + rect.right) / 2, y: (rect.top + rect.bottom) / 2 };
}

export function findDirectionalNeighbor(
  rects: PaneRect[],
  paneId: string,
  direction: Direction,
): string | undefined {
  const source = rects.find((rect) => rect.paneId === paneId);
  if (!source) return undefined;
  const origin = center(source);
  const candidates = rects
    .filter((rect) => rect.paneId !== paneId)
    .map((rect) => {
      const candidate = center(rect);
      const primary = direction === "left" || direction === "right" ? candidate.x - origin.x : candidate.y - origin.y;
      const secondary = direction === "left" || direction === "right" ? candidate.y - origin.y : candidate.x - origin.x;
      const valid = direction === "left" || direction === "up" ? primary < -1 : primary > 1;
      return { paneId: rect.paneId, valid, score: Math.abs(primary) + Math.abs(secondary) * 1.75 };
    })
    .filter((candidate) => candidate.valid)
    .sort((a, b) => a.score - b.score);
  return candidates[0]?.paneId;
}
