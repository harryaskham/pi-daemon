import { useEffect } from "react";
import type { DashboardBackend } from "@harryaskham/pi-daemon/dashboard-contract";
import type { DashboardLiveSessionState } from "../dashboard-live-session";
import type { DemoState, SessionFixture, TranscriptRecord } from "../model";
import { useDashboardLiveSession } from "../use-dashboard-live-session";
import { ChatPane } from "./ChatPane";

interface ConnectedChatPaneProps {
  backend: DashboardBackend;
  session: SessionFixture;
  fallbackRecords: TranscriptRecord[];
  demoState: DemoState;
  streamText: string;
  vimEnabled: boolean;
  composerHistory: string[];
  onStateChange?(state: DashboardLiveSessionState): void;
  onPresentationChange(presentation: "rich" | "tui"): void;
  onDemoStateChange(state: DemoState): void;
  onToggleVim(): void;
  onSubmitted(value: string): void;
}

export function ConnectedChatPane({
  backend,
  session,
  fallbackRecords,
  demoState,
  streamText,
  vimEnabled,
  composerHistory,
  onStateChange,
  onPresentationChange,
  onDemoStateChange,
  onToggleVim,
  onSubmitted,
}: ConnectedChatPaneProps) {
  const live = useDashboardLiveSession(backend, session.inventoryId);
  useEffect(() => onStateChange?.(live.state), [live.state, onStateChange]);
  return (
    <ChatPane
      session={session}
      records={live.state.transcript?.records ?? fallbackRecords}
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
      onSubmit={(value) => {
        onSubmitted(value);
        void live.controller.command(
          "prompt",
          { message: value },
          `prompt-${session.sessionId}-${Date.now().toString(36)}`,
        );
      }}
    />
  );
}
