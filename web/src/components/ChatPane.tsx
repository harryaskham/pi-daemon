import { lazy, Suspense, useEffect, useMemo, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  AlertCircle,
  Bot,
  BrainCircuit,
  Check,
  Clock3,
  Code2,
  MoreHorizontal,
  Play,
  TerminalSquare,
  UserRound,
  Zap,
} from "../icons";
import type { DemoState, SessionFixture, TranscriptRecord } from "../model";
import { relativeTime } from "../time";

const Composer = lazy(() => import("./Composer"));

interface ChatPaneProps {
  session: SessionFixture;
  records: TranscriptRecord[];
  demoState: DemoState;
  streamText: string;
  vimEnabled: boolean;
  onDemoStateChange(state: DemoState): void;
  onToggleVim(): void;
  onSubmit(value: string): void;
}

function contentText(record: Extract<TranscriptRecord, { kind: "message" | "tool" }>): string {
  return record.content.map((block) => {
    if (block.type === "image") return block.alt ?? "Image attachment";
    if (block.type === "usage") return "";
    return block.text;
  }).filter(Boolean).join("\n");
}

function MessageRecord({ record, streaming }: { record: Extract<TranscriptRecord, { kind: "message" }>; streaming?: string }) {
  const assistant = record.role !== "user";
  const thinking = record.content.some((block) => block.type === "thinking");
  const visualRole = thinking ? "thinking" : assistant ? "assistant" : "user";
  const usage = record.content.find((block) => block.type === "usage");
  return (
    <article className={`message message--${visualRole}`}>
      <div className="message__avatar" aria-hidden="true">
        {thinking ? <BrainCircuit size={15} /> : assistant ? <Bot size={15} /> : <UserRound size={15} />}
      </div>
      <div className="message__body">
        <header>
          <strong>{thinking ? "Reasoning" : record.role === "user" ? "You" : record.role === "system" ? "System" : "Pi"}</strong>
          {record.timestamp ? <time dateTime={record.timestamp}>{relativeTime(record.timestamp)}</time> : null}
        </header>
        <p>{contentText(record)}{streaming}<span className={streaming ? "stream-caret" : ""} /></p>
        {usage?.type === "usage" ? <footer>{(usage.inputTokens ?? 0).toLocaleString()} in · {(usage.outputTokens ?? 0).toLocaleString()} out</footer> : null}
      </div>
    </article>
  );
}

function ToolRecord({ record }: { record: Extract<TranscriptRecord, { kind: "tool" }> }) {
  const title = typeof record.arguments?.title === "string" ? record.arguments.title : `${record.toolName} call`;
  const details = record.details;
  const durationMs = details && typeof details === "object" && !Array.isArray(details) && typeof details.durationMs === "number" ? details.durationMs : undefined;
  return (
    <article className={`tool-card tool-card--${record.state}`}>
      <div className="tool-card__icon">{record.toolName === "bash" ? <TerminalSquare size={15} /> : <Code2 size={15} />}</div>
      <div className="tool-card__copy">
        <header><strong>{title}</strong><span>{record.toolName}</span></header>
        <p>{contentText(record)}</p>
        <footer>{record.state === "pending" || record.state === "running" ? <><i /> running</> : record.state === "error" ? <><AlertCircle size={12} /> attention</> : <><Check size={12} /> complete</>} {durationMs ? <time>{durationMs} ms</time> : null}</footer>
      </div>
      <button type="button" aria-label={`More details for ${title}`}><MoreHorizontal size={15} /></button>
    </article>
  );
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
        <span><Clock3 size={13} /> Preview ready · hydration not requested</span>
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
                  {record.kind === "message" ? <MessageRecord record={record} {...(isLastAssistant && demoState === "streaming" ? { streaming: streamText } : {})} /> : null}
                  {record.kind === "tool" ? <ToolRecord record={record} /> : null}
                  {record.kind === "timeline" ? <div className="timeline-record"><i /><strong>{record.label ?? record.event}</strong><span>{typeof record.data?.detail === "string" ? record.data.detail : record.event}</span></div> : null}
                  {record.kind === "summary" ? <div className="timeline-record"><i /><strong>{record.summaryKind} summary</strong><span>{record.content.map((block) => block.type === "image" || block.type === "usage" ? "" : block.text).join(" ")}</span></div> : null}
                  {record.kind === "custom" ? <div className="timeline-record"><i /><strong>{record.customType}</strong><span>{record.fallbackText ?? (record.hidden ? "Hidden custom record" : "Custom record")}</span></div> : null}
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
