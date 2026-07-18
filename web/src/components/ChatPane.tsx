import { lazy, Suspense, useEffect, useMemo, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  AlertCircle,
  Bot,
  Clock3,
  MoreHorizontal,
  Play,
  Zap,
} from "../icons";
import type { DemoState, SessionFixture, TranscriptRecord } from "../model";

const Composer = lazy(() => import("./Composer"));
const RichTranscriptRecord = lazy(() => import("./RichTranscriptRecord").then((module) => ({ default: module.RichTranscriptRecord })));

interface ChatPaneProps {
  session: SessionFixture;
  records: TranscriptRecord[];
  demoState: DemoState;
  streamText: string;
  vimEnabled: boolean;
  needsReconcile: boolean;
  droppedRecords: number;
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
  needsReconcile,
  droppedRecords,
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
    <div className="chat-pane">
      <header className="pane-header">
        <div className="pane-title">
          <span className={`presence-dot presence-dot--${session.presence.runtime}`} />
          <div><p className="eyebrow">{session.project} · Rich</p><h2>{session.title}</h2></div>
        </div>
        <div className="pane-actions">
          <div className="demo-states" role="group" aria-label="Preview state">
            {(["ready", "streaming", "skeleton", "empty", "error"] as const).map((state) => (
              <button key={state} type="button" className={demoState === state ? "is-active" : ""} onClick={() => onDemoStateChange(state)} aria-pressed={demoState === state}>{state}</button>
            ))}
          </div>
          <button type="button" className="icon-button" aria-label="Pane menu"><MoreHorizontal size={17} /></button>
        </div>
      </header>

      <div className="session-ribbon" role="status">
        <span><Zap size={13} /> Controller</span>
        <span><Clock3 size={13} /> {needsReconcile ? "Replay gap · reconciliation required" : "Preview ready · hydration not requested"}</span>
        {droppedRecords > 0 ? <span>{droppedRecords} bounded records omitted</span> : null}
        <span className="session-ribbon__cursor">gen {session.generation} · cursor 000013af</span>
      </div>

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
          <Composer vimEnabled={vimEnabled} disabled={demoState === "error"} onToggleVim={onToggleVim} onSubmit={onSubmit} />
        </Suspense>
        <div className="context-chips" aria-label="Session context">
          <span>{session.cwd}</span><span>{session.contextPercent}% context</span><span>{session.model}</span><span>{session.thinking} thinking</span><span>tools: trusted</span>
        </div>
      </footer>
    </div>
  );
}
