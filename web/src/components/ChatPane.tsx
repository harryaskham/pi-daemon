import { lazy, Suspense, useEffect, useMemo, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  AlertCircle,
  Bot,
  Clock3,
  MoreHorizontal,
  Play,
  TerminalSquare,
  Zap,
} from "../icons";
import type { DashboardLiveSessionController, DashboardLiveSessionState } from "../dashboard-live-session";
import type { DemoState, SessionFixture, TranscriptRecord } from "../model";
import { LiveSessionControls } from "./LiveSessionControls";

const Composer = lazy(() => import("./Composer"));
const RichTranscriptRecord = lazy(() => import("./RichTranscriptRecord").then((module) => ({ default: module.RichTranscriptRecord })));

interface ChatPaneProps {
  session: SessionFixture;
  records: TranscriptRecord[];
  demoState: DemoState;
  streamText: string;
  vimEnabled: boolean;
  composerHistory: string[];
  needsReconcile: boolean;
  droppedRecords: number;
  liveState: DashboardLiveSessionState;
  liveController: DashboardLiveSessionController;
  onPresentationChange(presentation: "rich" | "tui"): void;
  onDemoStateChange(state: DemoState): void;
  onToggleVim(): void;
  onSubmit(value: string): void;
}

function SkeletonTranscript() {
  return <div className="transcript-skeleton" aria-label="Loading transcript"><i /><i /><i /><i /><i /></div>;
}

export function ChatPane({
  session,
  records,
  demoState,
  streamText,
  vimEnabled,
  composerHistory,
  needsReconcile,
  droppedRecords,
  liveState,
  liveController,
  onPresentationChange,
  onDemoStateChange,
  onToggleVim,
  onSubmit,
}: ChatPaneProps) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const shownRecords = useMemo(() => demoState === "empty" ? [] : records, [demoState, records]);
  const virtualizer = useVirtualizer({
    count: shownRecords.length,
    getScrollElement: () => scrollerRef.current,
    estimateSize: (index) => shownRecords[index]?.kind === "tool" ? 126 : shownRecords[index]?.kind === "timeline" ? 56 : 132,
    measureElement: (element) => element.getBoundingClientRect().height,
    overscan: 7,
  });

  useEffect(() => {
    if (shownRecords.length === 0) return;
    requestAnimationFrame(() => virtualizer.scrollToIndex(shownRecords.length - 1, { align: "end" }));
  }, [session.inventoryId, shownRecords.length]);

  return (
    <div className="chat-pane" data-session-store={`${session.sessionId}:${session.generation}`}>
      <header className="pane-header">
        <div className="pane-title">
          <span className={`presence-dot presence-dot--${session.presence.runtime}`} />
          <div><p className="eyebrow">{session.project} · Rich</p><h2>{session.title}</h2></div>
        </div>
        <div className="pane-actions">
          <button type="button" className="tui-presentation-button" aria-label="Compact session" onClick={() => void liveController.command("compact")} disabled={liveState.role !== "controller"}>Compact</button>
          <button type="button" className="tui-presentation-button" aria-label="Abort active turn" onClick={() => void liveController.command("abort")} disabled={liveState.role !== "controller"}>Abort</button>
          <button type="button" className="tui-presentation-button" aria-label="Switch to TUI presentation" onClick={() => onPresentationChange("tui")}><TerminalSquare size={13} /> TUI</button>
          <div className="demo-states" role="group" aria-label="Preview state">
            {(["ready", "streaming", "skeleton", "empty", "error"] as const).map((state) => (
              <button key={state} type="button" className={demoState === state ? "is-active" : ""} onClick={() => onDemoStateChange(state)} aria-pressed={demoState === state}>{state}</button>
            ))}
          </div>
          <button type="button" className="icon-button" aria-label="Pane menu"><MoreHorizontal size={17} /></button>
        </div>
      </header>

      <div className="session-ribbon" role="status">
        <span><Zap size={13} /> {liveState.role}</span>
        <span><Clock3 size={13} /> {needsReconcile ? "Replay gap · reconciliation required" : `${liveState.phase.replaceAll("-", " ")} · preview painted first`}</span>
        {droppedRecords > 0 ? <span>{droppedRecords} bounded records omitted</span> : null}
        <span className="session-ribbon__cursor">gen {session.generation} · cursor 000013af</span>
      </div>

      <LiveSessionControls state={liveState} controller={liveController} />

      {demoState === "error" ? (
        <div className="state-panel state-panel--error" role="alert">
          <AlertCircle size={24} />
          <h3>Live channel paused</h3>
          <p>Generation changed while this pane was reconnecting. Persisted preview is safe; refresh the bounded live state before sending.</p>
          <button type="button"><Play size={14} /> Reconcile channel</button>
        </div>
      ) : demoState === "skeleton" ? (
        <SkeletonTranscript />
      ) : shownRecords.length === 0 ? (
        <div className="state-panel state-panel--empty">
          <div className="empty-symbol"><Bot size={22} /></div>
          <h3>A quiet session</h3>
          <p>This session has no visible records on its active branch. Sending starts one normal Pi run.</p>
        </div>
      ) : (
        <div ref={scrollerRef} className="transcript" aria-label="Conversation transcript" aria-live="polite">
          <div className="transcript__sizer" style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((row) => {
              const record = shownRecords[row.index];
              if (!record) return null;
              const isLastAssistant = record.kind === "message" && record.role === "assistant" && row.index === shownRecords.length - 1;
              return (
                <div
                  key={record.recordId}
                  ref={virtualizer.measureElement}
                  data-index={row.index}
                  data-transcript-row
                  className="transcript-row"
                  style={{ transform: `translateY(${row.start}px)` }}
                >
                  <Suspense fallback={<div className="record-loading" aria-label="Loading rich transcript record" />}>
                    <RichTranscriptRecord record={record} {...(isLastAssistant && demoState === "streaming" ? { streaming: streamText } : {})} />
                  </Suspense>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <footer className="chat-pane__footer">
        <Suspense fallback={<div className="composer composer--loading"><i /><span>Loading the editor chunk…</span></div>}>
          <Composer vimEnabled={vimEnabled} history={composerHistory} disabled={demoState === "error" || liveState.role !== "controller" || !["live", "streaming"].includes(liveState.phase)} onToggleVim={onToggleVim} onSubmit={onSubmit} />
        </Suspense>
        <div className="context-chips" aria-label="Session context">
          <span>{session.cwd}</span><span>{String((liveState.sessionStats as Record<string, unknown> | undefined)?.contextPercent ?? session.contextPercent)}% context</span><span>{String(liveState.rpcState.model ?? session.model)}</span><span>{String(liveState.rpcState.thinkingLevel ?? session.thinking)} thinking</span><span>{liveState.availableCommands ? "commands ready" : "commands loading"}</span>
        </div>
      </footer>
    </div>
  );
}
