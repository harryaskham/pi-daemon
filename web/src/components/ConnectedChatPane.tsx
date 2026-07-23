import { useCallback, useEffect } from "react";
import type { DashboardBackend, DashboardCommandOperation, DashboardCursor } from "@harryaskham/pi-daemon/dashboard-contract";
import type { JsonObject } from "@harryaskham/pi-daemon/session-api";
import type { DashboardLiveSessionState } from "../dashboard-live-session";
import type { DemoState, SessionFixture, TranscriptRecord } from "../model";
import { useDashboardLiveSession } from "../use-dashboard-live-session";
import { ChatPane } from "./ChatPane";

interface ConnectedChatPaneProps {
  backend: DashboardBackend;
  session: SessionFixture;
  fallbackRecords: TranscriptRecord[];
  active: boolean;
  fixtureMode: boolean;
  tuiAvailable: boolean;
  treeNavigationAvailable: boolean;
  demoState: DemoState;
  streamText: string;
  vimEnabled: boolean;
  composerHistory: string[];
  initialManaged?: { sessionId: string; generation: number };
  onStateChange?(state: DashboardLiveSessionState): void;
  onSeen?(inventoryId: string, cursor: DashboardCursor): void;
  onPresentationChange(presentation: "rich" | "tui"): void;
  onDemoStateChange(state: DemoState): void;
  onToggleVim(): void;
  onSubmitted(value: string): void;
}

export function ConnectedChatPane({
  backend,
  session,
  fallbackRecords,
  active,
  fixtureMode,
  tuiAvailable,
  treeNavigationAvailable,
  demoState,
  streamText,
  vimEnabled,
  composerHistory,
  initialManaged,
  onStateChange,
  onSeen,
  onPresentationChange,
  onDemoStateChange,
  onToggleVim,
  onSubmitted,
}: ConnectedChatPaneProps) {
  const markSeen = useCallback((cursor: DashboardCursor) => onSeen?.(session.inventoryId, cursor), [onSeen, session.inventoryId]);
  const live = useDashboardLiveSession(
    backend,
    session.inventoryId,
    "controller",
    markSeen,
    initialManaged,
  );
  useEffect(() => onStateChange?.(live.state), [live.state, onStateChange]);
  useEffect(() => {
    if (active && live.state.unread && document.visibilityState === "visible") live.controller.markSeen();
  }, [active, live.controller, live.state.unread]);
  return (
    <ChatPane
      session={session}
      records={live.state.transcript?.records ?? fallbackRecords}
      fixtureMode={fixtureMode}
      tuiAvailable={tuiAvailable}
      treeNavigationAvailable={treeNavigationAvailable}
      demoState={demoState}
      streamText={streamText}
      vimEnabled={vimEnabled}
      composerHistory={composerHistory}
      needsReconcile={live.state.transcript?.needsReconcile ?? false}
      droppedRecords={live.state.transcript?.droppedRecords ?? 0}
      liveState={live.state}
      liveController={live.controller}
      onPresentationChange={onPresentationChange}
      onDemoStateChange={onDemoStateChange}
      onToggleVim={onToggleVim}
      onSubmit={async (value) => {
        const parsed = parseComposerCommand(value);
        const result = await live.controller.submit(
          parsed.operation,
          parsed.payload,
          `${parsed.operation}-${session.sessionId}-${crypto.randomUUID()}`,
        );
        const accepted = result.state === "completed" || result.state === "streaming";
        if (accepted) onSubmitted(value);
        return accepted;
      }}
    />
  );
}

export function parseComposerCommand(value: string): { operation: DashboardCommandOperation; payload: JsonObject } {
  const [head = "", ...rest] = value.trim().split(/\s+/u);
  const argument = rest.join(" ");
  switch (head.toLocaleLowerCase()) {
    case "/model": return { operation: "set_model", payload: modelReferencePayload(argument) };
    case "/thinking": return { operation: "set_thinking_level", payload: { level: argument || "medium" } };
    case "/compact": return { operation: "compact", payload: {} };
    case "/auto-compaction": return { operation: "set_auto_compaction", payload: { enabled: parseToggle(argument) } };
    case "/auto-retry": return { operation: "set_auto_retry", payload: { enabled: parseToggle(argument) } };
    case "/abort-retry": return { operation: "abort_retry", payload: {} };
    case "/steering-mode": return { operation: "set_steering_mode", payload: { mode: argument } };
    case "/follow-up-mode": return { operation: "set_follow_up_mode", payload: { mode: argument } };
    case "/name": return { operation: "set_session_name", payload: { name: argument } };
    case "/abort": return { operation: "abort", payload: {} };
    case "/steer": return { operation: "steer", payload: { message: argument } };
    case "/follow-up": return { operation: "follow_up", payload: { message: argument } };
    case "/tree": return { operation: "get_tree", payload: {} };
    case "/fork": return { operation: "fork", payload: argument ? { entryId: argument } : {} };
    case "/clone": return { operation: "clone", payload: argument ? { entryId: argument } : {} };
    default: return { operation: "prompt", payload: { message: value } };
  }
}

function modelReferencePayload(value: string): JsonObject {
  const reference = value.trim();
  const separator = reference.indexOf("/");
  if (separator <= 0 || separator === reference.length - 1) {
    return { provider: "", modelId: reference };
  }
  return {
    provider: reference.slice(0, separator),
    modelId: reference.slice(separator + 1),
  };
}

function parseToggle(value: string): boolean {
  return !["off", "false", "0", "no"].includes(value.toLocaleLowerCase());
}
