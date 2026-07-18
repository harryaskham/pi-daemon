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

function findTarget(node: LayoutNode, paneId: string): PaneTarget | undefined {
  if (node.type === "leaf") return node.paneId === paneId ? node.target : undefined;
  return findTarget(node.first, paneId) ?? findTarget(node.second, paneId);
}

export function swapPaneTargets(node: LayoutNode, firstPaneId: string, secondPaneId: string): LayoutNode {
  const firstTarget = findTarget(node, firstPaneId);
  const secondTarget = findTarget(node, secondPaneId);
  if (!firstTarget || !secondTarget || firstPaneId === secondPaneId) return node;
  return updatePaneTarget(updatePaneTarget(node, firstPaneId, secondTarget), secondPaneId, firstTarget);
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
