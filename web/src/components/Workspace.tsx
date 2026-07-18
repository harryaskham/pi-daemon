import { useCallback, useEffect, useRef } from "react";
import { findDirectionalNeighbor, swapPaneTargets, updateSplitRatio, type Direction, type PaneRect } from "../layout";
import type { LayoutNode } from "../model";

interface WorkspaceProps {
  layout: LayoutNode;
  selectedPaneId: string;
  onLayoutChange(layout: LayoutNode): void;
  onSelectedPaneChange(paneId: string): void;
  renderPane(node: Extract<LayoutNode, { type: "leaf" }>): React.ReactNode;
}

const KEY_DIRECTION: Readonly<Record<string, Direction>> = {
  h: "left",
  j: "down",
  k: "up",
  l: "right",
};

function collectRects(root: HTMLElement): PaneRect[] {
  return [...root.querySelectorAll<HTMLElement>("[data-pane-id]")].map((element) => {
    const rect = element.getBoundingClientRect();
    return {
      paneId: element.dataset.paneId ?? "",
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
    };
  });
}

function focusPane(root: HTMLElement, paneId: string): void {
  root.querySelector<HTMLElement>(`[data-pane-id="${paneId}"]`)?.focus({ preventScroll: true });
}

export function Workspace({
  layout,
  selectedPaneId,
  onLayoutChange,
  onSelectedPaneChange,
  renderPane,
}: WorkspaceProps) {
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (!event.ctrlKey || event.altKey || event.metaKey) return;
      if (event.target instanceof Element && event.target.closest("[data-editor-root]")) return;
      const direction = KEY_DIRECTION[event.key.toLocaleLowerCase()];
      if (!direction) return;
      const root = rootRef.current;
      if (!root) return;
      const neighbor = findDirectionalNeighbor(collectRects(root), selectedPaneId, direction);
      if (!neighbor) return;
      event.preventDefault();
      if (event.shiftKey) onLayoutChange(swapPaneTargets(layout, selectedPaneId, neighbor));
      onSelectedPaneChange(neighbor);
      requestAnimationFrame(() => focusPane(root, neighbor));
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [layout, onLayoutChange, onSelectedPaneChange, selectedPaneId]);

  const renderNode = useCallback((node: LayoutNode): React.ReactNode => {
    if (node.type === "leaf") {
      return (
        <section
          key={node.paneId}
          className={`workspace-pane${selectedPaneId === node.paneId ? " workspace-pane--selected" : ""}`}
          data-pane-id={node.paneId}
          data-pane-content={node.target.type === "empty" ? "empty" : `${node.target.type}:${node.target.inventoryId}`}
          tabIndex={-1}
          onPointerDown={() => onSelectedPaneChange(node.paneId)}
          aria-label={`Workspace pane ${node.paneId}`}
        >{renderPane(node)}</section>
      );
    }

    const splitNode = node;
    const isHorizontal = splitNode.direction === "horizontal";
    function updateRatioFromPointer(event: React.PointerEvent<HTMLDivElement>): void {
      const container = event.currentTarget.parentElement;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const ratio = isHorizontal
        ? (event.clientX - rect.left) / rect.width
        : (event.clientY - rect.top) / rect.height;
      onLayoutChange(updateSplitRatio(layout, splitNode.splitId, ratio));
    }
    function onPointerDown(event: React.PointerEvent<HTMLDivElement>): void {
      event.currentTarget.setPointerCapture(event.pointerId);
      updateRatioFromPointer(event);
    }
    function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void {
      const delta = event.key === "ArrowLeft" || event.key === "ArrowUp" ? -0.03 : event.key === "ArrowRight" || event.key === "ArrowDown" ? 0.03 : 0;
      if (delta === 0) return;
      event.preventDefault();
      onLayoutChange(updateSplitRatio(layout, splitNode.splitId, splitNode.ratio + delta));
    }

    return (
      <div
        key={splitNode.splitId}
        className={`split split--${splitNode.direction}`}
        style={{ gridTemplateColumns: isHorizontal ? `${splitNode.ratio}fr 6px ${1 - splitNode.ratio}fr` : undefined, gridTemplateRows: !isHorizontal ? `${splitNode.ratio}fr 6px ${1 - splitNode.ratio}fr` : undefined }}
      >
        {renderNode(splitNode.first)}
        <div
          className="split-handle"
          role="separator"
          aria-label={`Resize ${splitNode.direction} split`}
          aria-orientation={isHorizontal ? "vertical" : "horizontal"}
          aria-valuemin={18}
          aria-valuemax={82}
          aria-valuenow={Math.round(splitNode.ratio * 100)}
          tabIndex={0}
          onPointerDown={onPointerDown}
          onPointerMove={(event) => {
            if (event.currentTarget.hasPointerCapture(event.pointerId)) updateRatioFromPointer(event);
          }}
          onKeyDown={onKeyDown}
        ><i /></div>
        {renderNode(splitNode.second)}
      </div>
    );
  }, [layout, onLayoutChange, onSelectedPaneChange, renderPane, selectedPaneId]);

  return <main ref={rootRef} className="workspace" data-testid="workspace">{renderNode(layout)}</main>;
}
