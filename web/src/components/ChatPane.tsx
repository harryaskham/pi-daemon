import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  AlertCircle,
  Bot,
  Clock3,
  GitBranch,
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
const SessionTreeNavigator = lazy(() => import("./SessionTreeNavigator").then((module) => ({ default: module.SessionTreeNavigator })));

interface ChatPaneProps {
  session: SessionFixture;
  records: TranscriptRecord[];
  fixtureMode: boolean;
  tuiAvailable: boolean;
  treeNavigationAvailable: boolean;
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
  onSubmit(value: string): void | boolean | Promise<void | boolean>;
}

function SkeletonTranscript() {
  return <div className="transcript-skeleton" aria-label="Loading transcript"><i /><i /><i /><i /><i /></div>;
}

export interface LiveComposerPresentation {
  disabled: boolean;
  submitLabel: string;
  hint: string;
  status?: string;
  tone: "normal" | "waiting" | "warning" | "error";
}

export function liveComposerPresentation(
  state: DashboardLiveSessionState,
  fixtureError = false,
): LiveComposerPresentation {
  if (fixtureError) {
    return {
      disabled: true,
      submitLabel: "Send",
      hint: "Reconcile the fixture channel before sending",
      status: "Replay gap · reconciliation required",
      tone: "error",
    };
  }
  if (state.phase === "live" || state.phase === "streaming") {
    const controller = state.role === "controller";
    return {
      disabled: !controller,
      submitLabel: "Send",
      hint: controller ? "⌘↵ send · Shift↵ newline" : "Request control to send",
      ...(controller ? {} : { status: "Observer mode · request control to send" }),
      tone: controller ? "normal" : "warning",
    };
  }
  if (state.phase === "preview" || state.phase === "activation-choice") {
    const mode = state.selectedActivationMode;
    if (
      state.info?.activation.eligible &&
      (state.info.managed !== undefined || mode !== undefined)
    ) {
      const action = mode === "direct"
        ? "direct co-opt"
        : mode === "fork"
          ? "safe fork"
          : "reuse managed session";
      const status = `First send will ${action}, hydrate, and wake this session`;
      return {
        disabled: false,
        submitLabel: "Activate & send",
        hint: status,
        status,
        tone: "normal",
      };
    }
    return {
      disabled: true,
      submitLabel: "Send",
      hint: "Loading activation policy…",
      status: "Preview is readable; activation policy is still loading",
      tone: "waiting",
    };
  }
  if (["preview-loading", "activating", "hydrating", "reconnecting"].includes(state.phase)) {
    return {
      disabled: true,
      submitLabel: state.phase === "preview-loading" ? "Loading…" : "Starting…",
      hint: `${state.phase.replaceAll("-", " ")}…`,
      status: state.phase === "preview-loading"
        ? "Loading the persisted preview without starting Pi"
        : "Activating and hydrating; the prompt has not been replayed",
      tone: "waiting",
    };
  }
  if (state.phase === "indeterminate") {
    const exportIndeterminate = state.exportTicket?.state === "indeterminate";
    const status = exportIndeterminate
      ? `Export outcome is indeterminate; inspect ticket ${state.exportTicket?.ticketId ?? "unknown"}`
      : "Activation outcome is indeterminate; reconcile before sending";
    return {
      disabled: true,
      submitLabel: "Reconcile first",
      hint: exportIndeterminate
        ? "Never repeat an indeterminate export blindly"
        : "Never replay an indeterminate activation blindly",
      status: state.error?.message ?? status,
      tone: "warning",
    };
  }
  if (state.phase === "error") {
    return {
      disabled: true,
      submitLabel: "Unavailable",
      hint: state.error?.message ?? "Session activation failed",
      status: state.error?.message ?? "Session activation failed",
      tone: "error",
    };
  }
  return {
    disabled: true,
    submitLabel: "Preview only",
    hint: state.info?.activation.reasonCode ?? "This session cannot be activated",
    status: state.error?.message ?? "This session is preview-only under the current policy",
    tone: "warning",
  };
}

export function commandNames(value: DashboardLiveSessionState["availableCommands"]): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
  const commands = (value as Record<string, unknown>).commands;
  if (!Array.isArray(commands)) return [];
  const names: string[] = [];
  for (const command of commands) {
    const raw =
      typeof command === "string"
        ? command
        : typeof command === "object" &&
            command !== null &&
            !Array.isArray(command) &&
            typeof (command as Record<string, unknown>).name === "string"
          ? ((command as Record<string, unknown>).name as string)
          : undefined;
    if (raw === undefined || raw.length === 0) continue;
    names.push(raw.startsWith("/") ? raw : `/${raw}`);
    if (names.length >= 128) break;
  }
  return [...new Set(names)];
}

export function modelLabel(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "unknown";
  const model = value as Record<string, unknown>;
  const provider = typeof model.provider === "string" ? model.provider : undefined;
  const id = typeof model.id === "string" ? model.id : undefined;
  if (provider !== undefined && id !== undefined) return `${provider}/${id}`;
  return id ?? provider ?? "unknown";
}

export function ChatPane({
  session,
  records,
  fixtureMode,
  tuiAvailable,
  treeNavigationAvailable,
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
  const paneRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [treeOpen, setTreeOpen] = useState(false);
  const composer = liveComposerPresentation(
    liveState,
    fixtureMode && demoState === "error",
  );
  const activationModes = liveState.activationModes.filter(
    (mode) =>
      mode !== "preview-only" &&
      (liveState.info?.managed === undefined || mode === "reuse"),
  );
  const shownRecords = useMemo(() => fixtureMode && demoState === "empty" ? [] : records, [demoState, fixtureMode, records]);
  const virtualizer = useVirtualizer({
    count: shownRecords.length,
    getScrollElement: () => scrollerRef.current,
    estimateSize: (index) => shownRecords[index]?.kind === "tool" ? 126 : shownRecords[index]?.kind === "timeline" ? 56 : 132,
    measureElement: (element) => element.getBoundingClientRect().height,
    overscan: 7,
  });

  async function submitComposer(value: string): Promise<void | boolean> {
    const accepted = await onSubmit(value);
    if (accepted !== false) liveController.clearTreeEditorText();
    return accepted;
  }

  useEffect(() => {
    if (shownRecords.length === 0) return;
    requestAnimationFrame(() => virtualizer.scrollToIndex(shownRecords.length - 1, { align: "end" }));
  }, [session.inventoryId, shownRecords.length]);

  useEffect(() => {
    const pane = paneRef.current;
    if (!pane || typeof ResizeObserver === "undefined") return;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      const bounds = pane.getBoundingClientRect();
      if (bounds.width === 0 || bounds.height === 0 || pane.hidden) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => virtualizer.measure());
    });
    observer.observe(pane);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [virtualizer]);

  return (
    <div ref={paneRef} className="chat-pane" data-session-store={`${session.sessionId}:${session.generation}`}>
      <header className="pane-header">
        <div className="pane-title">
          <span className={`presence-dot presence-dot--${session.presence.runtime}`} />
          <div><p className="eyebrow">{session.project} · Rich</p><h2>{liveState.extensionTitle || session.title}</h2></div>
        </div>
        <div className="pane-actions">
          <button type="button" className="tui-presentation-button" aria-label="Open session branch tree" aria-pressed={treeOpen} onClick={() => setTreeOpen((value) => !value)}><GitBranch size={13} /> Tree</button>
          <button type="button" className="tui-presentation-button" aria-label="Compact session" onClick={() => void liveController.command("compact")} disabled={liveState.role !== "controller"}>Compact</button>
          <button type="button" className="tui-presentation-button" aria-label="Abort active turn" onClick={() => void liveController.command("abort")} disabled={liveState.role !== "controller"}>Abort</button>
          {tuiAvailable ? <button type="button" className="tui-presentation-button" aria-label="Switch to TUI presentation" onClick={() => onPresentationChange("tui")}><TerminalSquare size={13} /> TUI</button> : null}
          {fixtureMode ? <div className="demo-states" role="group" aria-label="Preview state">
            {(["ready", "streaming", "skeleton", "empty", "error"] as const).map((state) => (
              <button key={state} type="button" className={demoState === state ? "is-active" : ""} onClick={() => onDemoStateChange(state)} aria-pressed={demoState === state}>{state}</button>
            ))}
          </div> : null}
          <button type="button" className="icon-button" aria-label="Pane menu"><MoreHorizontal size={17} /></button>
        </div>
      </header>

      <div className="session-ribbon" role="status">
        <span><Zap size={13} /> {liveState.role}</span>
        <span><Clock3 size={13} /> {needsReconcile || (fixtureMode && demoState === "error") ? "Replay gap · reconciliation required" : fixtureMode ? "Preview ready · hydration not requested" : `${liveState.phase.replaceAll("-", " ")} · preview painted first`}</span>
        {droppedRecords > 0 ? <span>{droppedRecords} bounded records omitted</span> : null}
        <span className="session-ribbon__cursor">gen {liveState.identity?.generation ?? session.generation} · {liveState.transcript?.highWaterCursor ?? "preview"}</span>
      </div>

      <LiveSessionControls state={liveState} controller={liveController} />

      {treeOpen ? (
        <Suspense fallback={<div className="session-tree session-tree__state" role="status">Loading tree navigator…</div>}>
          <SessionTreeNavigator
            state={liveState}
            controller={liveController}
            tuiAvailable={tuiAvailable}
            navigationAvailable={treeNavigationAvailable}
            onClose={() => setTreeOpen(false)}
            onPresentationChange={onPresentationChange}
          />
        </Suspense>
      ) : null}

      {fixtureMode && demoState === "error" ? (
        <div className="state-panel state-panel--error" role="alert">
          <AlertCircle size={24} />
          <h3>Live channel paused</h3>
          <p>Generation changed while this pane was reconnecting. Persisted preview is safe; refresh the bounded live state before sending.</p>
          <button type="button"><Play size={14} /> Reconcile channel</button>
        </div>
      ) : fixtureMode && demoState === "skeleton" ? (
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
                    <RichTranscriptRecord record={record} {...(fixtureMode && isLastAssistant && demoState === "streaming" ? { streaming: streamText } : {})} />
                  </Suspense>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <footer className="chat-pane__footer">
        {Object.values(liveState.extensionWidgets).filter((widget) => widget.placement === "aboveEditor").map((widget) => (
          <section className="extension-widget" key={widget.key} aria-label={`Extension widget ${widget.key}`}>{widget.lines.map((line, index) => <p key={`${widget.key}-${index}`}>{line}</p>)}</section>
        ))}
        {composer.status ? (
          <div
            className={`composer-status composer-status--${composer.tone}`}
            role={composer.tone === "error" ? "alert" : "status"}
          >
            <span>{composer.status}</span>
            {(liveState.phase === "preview" || liveState.phase === "activation-choice") && activationModes.length > 1 ? (
              <div className="composer-activation-modes" role="group" aria-label="Activation mode">
                {activationModes.map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    aria-pressed={liveState.selectedActivationMode === mode}
                    onClick={() => liveController.selectActivationMode(mode)}
                  >{mode === "direct" ? "Direct co-opt" : mode === "fork" ? "Safe fork" : "Reuse"}</button>
                ))}
              </div>
            ) : null}
            {liveState.phase === "error" && liveState.error?.retryable ? (
              <button type="button" onClick={() => void liveController.reconnect()}>Reconnect safely</button>
            ) : null}
          </div>
        ) : null}
        <Suspense fallback={<div className="composer composer--loading"><i /><span>Loading the editor chunk…</span></div>}>
          <Composer
            vimEnabled={vimEnabled}
            history={composerHistory}
            commands={commandNames(liveState.availableCommands)}
            {...(liveState.treeEditorText !== undefined
              ? { externalValue: liveState.treeEditorText }
              : liveState.extensionEditorText === undefined
                ? {}
                : { externalValue: liveState.extensionEditorText })}
            disabled={composer.disabled}
            submitLabel={composer.submitLabel}
            hint={composer.hint}
            onToggleVim={onToggleVim}
            onSubmit={submitComposer}
          />
        </Suspense>
        {Object.values(liveState.extensionWidgets).filter((widget) => widget.placement === "belowEditor").map((widget) => (
          <section className="extension-widget" key={widget.key} aria-label={`Extension widget ${widget.key}`}>{widget.lines.map((line, index) => <p key={`${widget.key}-${index}`}>{line}</p>)}</section>
        ))}
        <div className="context-chips" aria-label="Session context">
          <span>{session.cwd}</span><span>{String((liveState.sessionStats as Record<string, unknown> | undefined)?.contextPercent ?? session.contextPercent)}% context</span><span>{modelLabel(liveState.rpcState.model ?? session.model)}</span><span>{String(liveState.rpcState.thinkingLevel ?? session.thinking)} thinking</span><span>{liveState.availableCommands ? "commands ready" : "commands loading"}</span>
        </div>
      </footer>
    </div>
  );
}
