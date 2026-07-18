import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type UIEvent,
} from "react";
import type { DashboardTuiInput, TuiDimensions, TuiRow, TuiStyle } from "@harryaskham/pi-daemon/dashboard-contract";
import { deriveTuiDimensions, keyboardEventToTuiInput, pasteToTuiInput, visibleTuiRowRange } from "../tui-grid-model";
import { tuiAccessibleText, type TuiFrameStoreState } from "../tui-frame-store";
import "./tui-grid.css";

export interface TuiGridSelection {
  start: { row: number; column: number };
  end: { row: number; column: number };
}

export interface TuiGridOverlay {
  id: string;
  kind: "dialog" | "status" | "image-placeholder";
  row: number;
  column: number;
  rows: number;
  columns: number;
  label: string;
}

export interface TuiGridProps {
  state: TuiFrameStoreState;
  className?: string;
  selection?: TuiGridSelection;
  overlays?: readonly TuiGridOverlay[];
  autoFocus?: boolean;
  active?: boolean;
  onInput?(input: DashboardTuiInput): void | Promise<void>;
  onResize?(dimensions: TuiDimensions): void | Promise<void>;
  onRequestSnapshot?(): void;
  onRequestControl?(): void;
}

const DEFAULT_CELL_WIDTH = 8.4;
const DEFAULT_ROW_HEIGHT = 17;
const MAX_OVERLAYS = 32;
const safeColor = /^#[0-9a-f]{6}$/iu;

type GridStyle = CSSProperties & { "--tui-cell-width": string; "--tui-row-height": string };

function runStyle(style: TuiStyle | undefined): CSSProperties | undefined {
  if (!style) return undefined;
  const foreground = style.foreground && safeColor.test(style.foreground) ? style.foreground : undefined;
  const background = style.background && safeColor.test(style.background) ? style.background : undefined;
  return {
    ...(style.inverse
      ? { color: background ?? "var(--dash-bg-canvas)", backgroundColor: foreground ?? "var(--dash-fg-primary)" }
      : {
          ...(foreground ? { color: foreground } : {}),
          ...(background ? { backgroundColor: background } : {}),
        }),
    ...(style.bold ? { fontWeight: 700 } : {}),
    ...(style.dim ? { opacity: 0.62 } : {}),
    ...(style.italic ? { fontStyle: "italic" } : {}),
    ...(style.underline ? { textDecoration: "underline" } : {}),
  };
}

const TuiGridRow = memo(function TuiGridRow({ row, rowHeight }: { row: TuiRow | undefined; rowHeight: number }) {
  if (!row) return null;
  return (
    <div className="tui-grid__row" style={{ top: row.row * rowHeight, height: rowHeight }} data-row={row.row}>
      {row.runs.map((run, index) => <span key={`${index}:${run.text.length}`} style={runStyle(run.style)}>{run.text}</span>)}
    </div>
  );
});

function overlayRect(overlay: TuiGridOverlay, dimensions: TuiDimensions) {
  const rows = Math.max(1, Math.min(dimensions.rows, overlay.rows));
  const columns = Math.max(1, Math.min(dimensions.columns, overlay.columns));
  return {
    row: Math.max(0, Math.min(dimensions.rows - rows, overlay.row)),
    column: Math.max(0, Math.min(dimensions.columns - columns, overlay.column)),
    rows,
    columns,
  };
}

function selectionRects(selection: TuiGridSelection | undefined, dimensions: TuiDimensions): Array<{ row: number; column: number; columns: number }> {
  if (!selection) return [];
  const firstIndex = selection.start.row * dimensions.columns + selection.start.column;
  const secondIndex = selection.end.row * dimensions.columns + selection.end.column;
  const start = Math.max(0, Math.min(firstIndex, secondIndex));
  const end = Math.min(dimensions.rows * dimensions.columns - 1, Math.max(firstIndex, secondIndex));
  const rectangles = [];
  for (let row = Math.floor(start / dimensions.columns); row <= Math.floor(end / dimensions.columns); row += 1) {
    const column = row === Math.floor(start / dimensions.columns) ? start % dimensions.columns : 0;
    const lastColumn = row === Math.floor(end / dimensions.columns) ? end % dimensions.columns : dimensions.columns - 1;
    rectangles.push({ row, column, columns: lastColumn - column + 1 });
  }
  return rectangles.slice(0, dimensions.rows);
}

export function TuiGrid({
  state,
  className,
  selection,
  overlays = [],
  autoFocus = false,
  active = true,
  onInput,
  onResize,
  onRequestSnapshot,
  onRequestControl,
}: TuiGridProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const probeRef = useRef<HTMLSpanElement>(null);
  const resizeFrameRef = useRef<number | undefined>(undefined);
  const lastDimensionsRef = useRef<TuiDimensions | undefined>(undefined);
  const [cellWidth, setCellWidth] = useState(DEFAULT_CELL_WIDTH);
  const [rowHeight, setRowHeight] = useState(DEFAULT_ROW_HEIGHT);
  const [viewport, setViewport] = useState({ width: 0, height: 0, scrollTop: 0 });
  const [inputError, setInputError] = useState<string>();
  const rowMap = useMemo(() => new Map(state.rows.map((row) => [row.row, row])), [state.rows]);
  const accessibleText = useMemo(() => tuiAccessibleText(state), [state.revision, state.rows, state.dimensions]);
  const visible = visibleTuiRowRange(viewport.scrollTop, viewport.height, rowHeight, state.dimensions.rows);
  const selected = useMemo(() => selectionRects(selection, state.dimensions), [selection, state.dimensions]);
  const isController = state.role === "controller";

  useEffect(() => {
    const root = rootRef.current;
    const probe = probeRef.current;
    if (!active || !root || !probe || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const bounds = root.getBoundingClientRect();
      const probeBounds = probe.getBoundingClientRect();
      const measuredCellWidth = probeBounds.width > 0 ? probeBounds.width / 10 : DEFAULT_CELL_WIDTH;
      const measuredRowHeight = probeBounds.height > 0 ? probeBounds.height : DEFAULT_ROW_HEIGHT;
      setCellWidth(measuredCellWidth);
      setRowHeight(measuredRowHeight);
      setViewport((current) => ({ width: bounds.width, height: bounds.height, scrollTop: current.scrollTop }));
      if (!isController || !onResize) return;
      const dimensions = deriveTuiDimensions(bounds.width, bounds.height, { width: measuredCellWidth, height: measuredRowHeight });
      const previous = lastDimensionsRef.current;
      if (previous?.rows === dimensions.rows && previous.columns === dimensions.columns) return;
      lastDimensionsRef.current = dimensions;
      void Promise.resolve(onResize(dimensions)).catch(() => setInputError("Resize was rejected; the canonical view was preserved."));
    };
    const observer = new ResizeObserver(() => {
      if (resizeFrameRef.current !== undefined) cancelAnimationFrame(resizeFrameRef.current);
      resizeFrameRef.current = requestAnimationFrame(measure);
    });
    observer.observe(root);
    measure();
    return () => {
      observer.disconnect();
      if (resizeFrameRef.current !== undefined) cancelAnimationFrame(resizeFrameRef.current);
    };
  }, [active, isController, onResize]);

  useEffect(() => {
    if (active && autoFocus && isController) rootRef.current?.focus({ preventScroll: true });
  }, [active, autoFocus, isController]);

  const submitInput = useCallback((input: DashboardTuiInput | undefined) => {
    if (!input || !isController || !onInput) return false;
    setInputError(undefined);
    void Promise.resolve(onInput(input)).catch(() => setInputError("Input was not accepted. Request control or reconnect the view."));
    return true;
  }, [isController, onInput]);

  const onKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (submitInput(keyboardEventToTuiInput(event))) event.preventDefault();
  }, [submitInput]);

  const onPaste = useCallback((event: React.ClipboardEvent<HTMLDivElement>) => {
    const text = event.clipboardData.getData("text/plain");
    const input = pasteToTuiInput(text);
    if (submitInput(input)) event.preventDefault();
    else if (text.length > 262_144) setInputError("Paste exceeds the 256 KiB terminal input limit.");
  }, [submitInput]);

  const onScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
    const target = event.currentTarget;
    setViewport((current) => ({ ...current, scrollTop: target.scrollTop }));
  }, []);

  const gridStyle: GridStyle = {
    "--tui-cell-width": `${cellWidth}px`,
    "--tui-row-height": `${rowHeight}px`,
  };
  const contentStyle: CSSProperties = {
    width: state.dimensions.columns * cellWidth,
    height: state.dimensions.rows * rowHeight,
  };

  return (
    <section
      ref={rootRef}
      className={`tui-grid${className ? ` ${className}` : ""}`}
      style={gridStyle}
      tabIndex={0}
      role="region"
      aria-label={`${state.title ?? "Terminal"} · ${isController ? "controller" : "read-only observer"}`}
      aria-readonly={!isController}
      data-role={state.role}
      data-status={state.status}
      onKeyDown={onKeyDown}
      onPaste={onPaste}
      onScroll={onScroll}
    >
      <span ref={probeRef} className="tui-grid__probe" aria-hidden="true">MMMMMMMMMM</span>
      <div className="tui-grid__viewport" style={contentStyle} aria-hidden="true">
        {Array.from({ length: visible.end - visible.start }, (_, offset) => {
          const row = visible.start + offset;
          return <TuiGridRow key={row} row={rowMap.get(row)} rowHeight={rowHeight} />;
        })}
        {selected.map((rect) => (
          <i
            key={`${rect.row}:${rect.column}`}
            className="tui-grid__selection"
            style={{
              left: rect.column * cellWidth,
              top: rect.row * rowHeight,
              width: rect.columns * cellWidth,
              height: rowHeight,
            }}
          />
        ))}
        {state.cursor.visible ? (
          <i
            className={`tui-grid__cursor tui-grid__cursor--${state.cursor.shape ?? "block"}`}
            style={{ left: state.cursor.column * cellWidth, top: state.cursor.row * rowHeight, width: cellWidth, height: rowHeight }}
          />
        ) : null}
        {overlays.slice(0, MAX_OVERLAYS).map((overlay) => {
          const rect = overlayRect(overlay, state.dimensions);
          return (
            <aside
              key={overlay.id}
              className={`tui-grid__overlay tui-grid__overlay--${overlay.kind}`}
              style={{
                left: rect.column * cellWidth,
                top: rect.row * rowHeight,
                width: rect.columns * cellWidth,
                height: rect.rows * rowHeight,
              }}
              aria-label={overlay.label}
            >
              {overlay.kind === "image-placeholder" ? <i aria-hidden="true" /> : null}
              <span>{overlay.label.slice(0, 256)}</span>
            </aside>
          );
        })}
      </div>
      <pre className="sr-only" aria-label="Accessible terminal text">{accessibleText}</pre>
      <div className="tui-grid__status" aria-live="polite">
        <span className={`tui-grid__role tui-grid__role--${state.role}`}>{isController ? "Controller" : "Observer · read only"}</span>
        <span>{state.dimensions.columns}×{state.dimensions.rows}</span>
        <span>frame {state.sequence}</span>
      </div>
      {state.status !== "ready" ? (
        <div className={`tui-grid__fault tui-grid__fault--${state.status}`} role="alert">
          <strong>{state.status === "replay-gap" ? "Terminal replay paused" : "Terminal view conflict"}</strong>
          <span>{state.replayGap?.reason ?? state.conflict?.message ?? "A fresh bounded snapshot is required."}</span>
          {onRequestSnapshot ? <button type="button" onClick={onRequestSnapshot}>Load fresh snapshot</button> : null}
        </div>
      ) : !isController && onRequestControl ? (
        <button className="tui-grid__control" type="button" onClick={onRequestControl}>Request control</button>
      ) : null}
      {inputError ? <div className="tui-grid__input-error" role="status">{inputError}</div> : null}
      <span className="sr-only">Viewport {Math.round(viewport.width)} by {Math.round(viewport.height)} pixels.</span>
    </section>
  );
}
