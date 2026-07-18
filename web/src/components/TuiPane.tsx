import type { DashboardTuiInput, TuiDimensions } from "@harryaskham/pi-daemon/dashboard-contract";
import { Clock3, MessageSquareText, TerminalSquare, Zap } from "../icons";
import type { SessionFixture } from "../model";
import type { TuiFrameStoreState } from "../tui-frame-store";
import { TuiGrid, type TuiGridOverlay, type TuiGridSelection } from "./TuiGrid";

export interface TuiPaneProps {
  session: SessionFixture;
  state: TuiFrameStoreState;
  selected: boolean;
  active?: boolean;
  overlays?: readonly TuiGridOverlay[];
  selection?: TuiGridSelection;
  onPresentationChange(presentation: "rich" | "tui"): void;
  onInput?(input: DashboardTuiInput): void | Promise<void>;
  onResize?(dimensions: TuiDimensions): void | Promise<void>;
  onRequestSnapshot?(): void;
  onRequestControl?(): void;
}

export function TuiPane({
  session,
  state,
  selected,
  active = true,
  overlays,
  selection,
  onPresentationChange,
  onInput,
  onResize,
  onRequestSnapshot,
  onRequestControl,
}: TuiPaneProps) {
  return (
    <div className="tui-pane" data-tui-session-store={`${session.sessionId}:${session.generation}`}>
      <header className="pane-header">
        <div className="pane-title">
          <span className={`presence-dot presence-dot--${session.presence.runtime}`} />
          <div><p className="eyebrow">{session.project} · TUI</p><h2>{state.title ?? session.title}</h2></div>
        </div>
        <div className="tui-pane__presentation" role="group" aria-label="Pane presentation">
          <button type="button" aria-pressed="false" onClick={() => onPresentationChange("rich")}><MessageSquareText size={13} /> Rich</button>
          <button type="button" aria-pressed="true"><TerminalSquare size={13} /> TUI</button>
        </div>
      </header>
      <div className="session-ribbon" role="status">
        <span><Zap size={13} /> {state.role === "controller" ? "Controller" : "Observer"}</span>
        <span><Clock3 size={13} /> {state.status === "ready" ? "Canonical mirrored view" : "Fresh snapshot required"}</span>
        <span className="session-ribbon__cursor">gen {state.identity.generation} · {state.highWaterCursor}</span>
      </div>
      <TuiGrid
        state={state}
        autoFocus={selected}
        active={active}
        {...(overlays ? { overlays } : {})}
        {...(selection ? { selection } : {})}
        {...(onInput ? { onInput } : {})}
        {...(onResize ? { onResize } : {})}
        {...(onRequestSnapshot ? { onRequestSnapshot } : {})}
        {...(onRequestControl ? { onRequestControl } : {})}
      />
      <footer className="tui-pane__footer">
        <span>{session.cwd}</span><span>{state.dimensions.columns}×{state.dimensions.rows}</span><span>frame {state.sequence}</span><span>{state.role === "controller" ? "keyboard + paste active" : "read-only mirror"}</span>
      </footer>
    </div>
  );
}
