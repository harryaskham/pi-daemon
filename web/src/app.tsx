import { startTransition, useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import { asDashboardCursor } from "@harryaskham/pi-daemon/dashboard-contract";
import type { DashboardSessionIdentity } from "@harryaskham/pi-daemon/dashboard-contract";
import { ChatPane } from "./components/ChatPane";
import { EmptyPane } from "./components/EmptyPane";
import { InfoPane } from "./components/InfoPane";
import { SettingsModal } from "./components/SettingsModal";
import { Sidebar, type SidebarStatus } from "./components/Sidebar";
import { Workspace } from "./components/Workspace";
import { fixtureBackend } from "./fixture-backend";
import { Menu } from "./icons";
import { createSessionFixtures, createTranscriptFixtures, createTranscriptShowcaseFixtures } from "./fixtures";
import { INITIAL_LAYOUT, updatePaneTarget } from "./layout";
import type { DemoState, InventoryId, LayoutNode, SessionFixture, TranscriptRecord } from "./model";
import { markFirstRows, recordFrameWork, setFixtureCount } from "./performance";
import { createTranscriptStore, transcriptStoreReducer } from "./transcript-store";

const FIXTURE_SESSION_COUNT = 10_000;
const BOOTSTRAP_SESSIONS = createSessionFixtures(100);
const INITIAL_TRANSCRIPT_RECORDS = [
  ...createTranscriptFixtures(232),
  ...createTranscriptShowcaseFixtures(),
];

function transcriptIdentity(session: SessionFixture): DashboardSessionIdentity {
  return {
    hostInstanceId: "fixture-host-01",
    sessionId: session.sessionId,
    generation: session.generation,
  };
}

const STREAM_WORDS = [
  " The", " live", " reducer", " keeps", " entry", " identity", ", generation", " fences", ", and", " cursor", " order", " intact", ".",
] as const;

function initialSession(): SessionFixture {
  const session = BOOTSTRAP_SESSIONS.find((item) => item.presence.runtime === "running") ?? BOOTSTRAP_SESSIONS[0];
  if (!session) throw new Error("Dash fixture requires at least one session");
  return session;
}

function initialDemoState(): DemoState {
  const state = new URLSearchParams(window.location.search).get("state");
  return state === "ready" || state === "streaming" || state === "skeleton" || state === "empty" || state === "error"
    ? state
    : "streaming";
}

function initialSidebarStatus(): SidebarStatus {
  const state = new URLSearchParams(window.location.search).get("sidebar");
  if (state === "loading" || state === "empty" || state === "error") return state;
  return "ready";
}

function DashWorkspace() {
  const [sessions, setSessions] = useState<SessionFixture[]>(BOOTSTRAP_SESSIONS);
  const firstSession = useMemo(initialSession, []);
  const [selectedInventoryId, setSelectedInventoryId] = useState<InventoryId>(firstSession.inventoryId);
  const [selectedPaneId, setSelectedPaneId] = useState("primary");
  const [layout, setLayout] = useState<LayoutNode>(() =>
    updatePaneTarget(
      updatePaneTarget(INITIAL_LAYOUT, "primary", { type: "chat", inventoryId: firstSession.inventoryId, presentation: "rich" }),
      "inspector",
      { type: "info", inventoryId: firstSession.inventoryId },
    ),
  );
  const [query, setQuery] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sidebarStatus, setSidebarStatus] = useState<SidebarStatus>(initialSidebarStatus);
  const [demoState, setDemoState] = useState<DemoState>(initialDemoState);
  const [streamIndex, setStreamIndex] = useState(0);
  const streamWorkStartedAt = useRef<number | undefined>(undefined);
  const [vimEnabled, setVimEnabled] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  const [density, setDensity] = useState<"comfortable" | "compact">("comfortable");
  const [transcriptState, dispatchTranscript] = useReducer(
    transcriptStoreReducer,
    undefined,
    () => createTranscriptStore(
      transcriptIdentity(firstSession),
      INITIAL_TRANSCRIPT_RECORDS,
      undefined,
      asDashboardCursor("fixture:transcript:0"),
    ),
  );
  const records: TranscriptRecord[] = transcriptState.records;
  const [notice, setNotice] = useState("Preview ready · runtime hydration remains separate");

  useEffect(() => {
    let expandTimer = 0;
    const frame = requestAnimationFrame(() => {
      expandTimer = window.setTimeout(() => {
        startTransition(() => setSessions(fixtureBackend.sessions));
      }, 0);
    });
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(expandTimer);
    };
  }, []);

  useEffect(() => {
    if (demoState !== "streaming" || reducedMotion) return;
    const interval = window.setInterval(() => {
      streamWorkStartedAt.current = performance.now();
      setStreamIndex((index) => (index + 1) % (STREAM_WORDS.length + 1));
    }, 440);
    return () => window.clearInterval(interval);
  }, [demoState, reducedMotion]);

  useLayoutEffect(() => {
    const startedAt = streamWorkStartedAt.current;
    if (startedAt === undefined) return;
    recordFrameWork(performance.now() - startedAt);
    streamWorkStartedAt.current = undefined;
  }, [streamIndex]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if ((event.metaKey || event.ctrlKey) && event.key === ",") {
        event.preventDefault();
        setSettingsOpen(true);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const streamText = STREAM_WORDS.slice(0, streamIndex).join("");
  const sessionById = useMemo(() => new Map(sessions.map((session) => [session.inventoryId, session])), [sessions]);

  useEffect(() => {
    const session = sessionById.get(selectedInventoryId);
    if (!session) return;
    const nextIdentity = transcriptIdentity(session);
    if (
      transcriptState.identity.hostInstanceId === nextIdentity.hostInstanceId
      && transcriptState.identity.sessionId === nextIdentity.sessionId
      && transcriptState.identity.generation === nextIdentity.generation
    ) return;
    dispatchTranscript({
      type: "snapshot",
      identity: nextIdentity,
      records: INITIAL_TRANSCRIPT_RECORDS,
      cursor: asDashboardCursor(`fixture:transcript:${session.generation}:0`),
    });
  }, [selectedInventoryId, sessionById, transcriptState.identity]);

  const openTarget = useCallback((session: SessionFixture, type: "chat" | "info") => {
    setSelectedInventoryId(session.inventoryId);
    setSidebarOpen(false);
    setLayout((current) => updatePaneTarget(
      current,
      selectedPaneId,
      type === "chat"
        ? { type, inventoryId: session.inventoryId, presentation: "rich" }
        : { type, inventoryId: session.inventoryId },
    ));
  }, [selectedPaneId]);

  const renderPane = useCallback((node: Extract<LayoutNode, { type: "leaf" }>) => {
    if (node.target.type === "empty") return <EmptyPane />;
    const session = sessionById.get(node.target.inventoryId);
    if (!session) return <EmptyPane />;
    if (node.target.type === "info") return <InfoPane session={session} />;
    return (
      <ChatPane
        session={session}
        records={records}
        demoState={demoState}
        streamText={streamText}
        vimEnabled={vimEnabled}
        needsReconcile={transcriptState.needsReconcile}
        droppedRecords={transcriptState.droppedRecords}
        onDemoStateChange={(state) => {
          setDemoState(state);
          if (state === "error") {
            dispatchTranscript({
              type: "replay_gap",
              identity: transcriptState.identity,
              reason: "cursor-expired",
              highWaterCursor: asDashboardCursor(`fixture:gap:${session.generation}`),
            });
          } else if (transcriptState.needsReconcile) {
            dispatchTranscript({
              type: "reconcile",
              identity: transcriptState.identity,
              records: INITIAL_TRANSCRIPT_RECORDS,
              cursor: asDashboardCursor(`fixture:reconciled:${session.generation}`),
            });
          }
        }}
        onToggleVim={() => setVimEnabled((enabled) => !enabled)}
        onSubmit={(value) => {
          const timestamp = new Date().toISOString();
          const suffix = Date.now().toString(36);
          const userRecord = {
            recordId: `optimistic:user:${suffix}`,
            key: { entryId: `optimistic_user_${suffix}`, messageId: `optimistic_message_user_${suffix}` },
            kind: "message",
            role: "user",
            state: "complete",
            source: "optimistic",
            timestamp,
            content: [{ type: "text", text: value }],
          } satisfies TranscriptRecord;
          const assistantRecord = {
            recordId: `optimistic:assistant:${suffix}`,
            key: { entryId: `optimistic_assistant_${suffix}`, messageId: `optimistic_message_assistant_${suffix}` },
            kind: "message",
            role: "assistant",
            state: "streaming",
            source: "optimistic",
            timestamp,
            content: [{ type: "markdown", text: "Fixture submission accepted. The production channel will correlate this optimistic entry with its durable Pi entry ID." }],
          } satisfies TranscriptRecord;
          const submissionIdentity = transcriptState.identity;
          dispatchTranscript({
            type: "upsert",
            identity: submissionIdentity,
            records: [userRecord, assistantRecord],
          });
          window.setTimeout(() => {
            dispatchTranscript({
              type: "entry_appended",
              identity: submissionIdentity,
              record: userRecord,
              cursor: asDashboardCursor(`fixture:entry-appended:user:${suffix}`),
            });
            dispatchTranscript({
              type: "entry_appended",
              identity: submissionIdentity,
              record: { ...assistantRecord, state: "complete" },
              cursor: asDashboardCursor(`fixture:entry-appended:assistant:${suffix}`),
            });
          }, 480);
          setDemoState("streaming");
          setStreamIndex(0);
          setNotice("Fixture command accepted · no provider request was sent");
        }}
      />
    );
  }, [demoState, records, sessionById, streamText, transcriptState.droppedRecords, transcriptState.identity, transcriptState.needsReconcile, vimEnabled]);

  return (
    <div className="dash-app" data-density={density} data-reduced-motion={reducedMotion ? "true" : "false"} data-sidebar-open={sidebarOpen ? "true" : "false"}>
      <a className="skip-link" href="#dash-workspace">Skip to workspace</a>
      <Sidebar
        sessions={sessions}
        query={query}
        selectedInventoryId={selectedInventoryId}
        status={sidebarStatus}
        reconciling={sessions.length < FIXTURE_SESSION_COUNT}
        onQueryChange={setQuery}
        onOpenChat={(session) => openTarget(session, "chat")}
        onOpenInfo={(session) => openTarget(session, "info")}
        onOpenSettings={() => setSettingsOpen(true)}
        onRequestClose={() => setSidebarOpen(false)}
        onRetry={() => {
          setSidebarStatus("loading");
          window.setTimeout(() => setSidebarStatus("ready"), 360);
        }}
      />
      <button type="button" className="sidebar-scrim" aria-label="Close session drawer" onClick={() => setSidebarOpen(false)} />
      <div id="dash-workspace" className="workspace-shell">
        <div className="workspace-notice" aria-live="polite">
          <button type="button" className="mobile-menu-button" aria-label="Open session drawer" onClick={() => setSidebarOpen(true)}><Menu size={15} /></button>
          <i />{notice}<span>Ctrl-hjkl focus · Ctrl-Shift-hjkl swap</span>
        </div>
        <Workspace
          layout={layout}
          selectedPaneId={selectedPaneId}
          onLayoutChange={setLayout}
          onSelectedPaneChange={setSelectedPaneId}
          renderPane={renderPane}
        />
      </div>
      <SettingsModal
        open={settingsOpen}
        vimEnabled={vimEnabled}
        reducedMotion={reducedMotion}
        density={density}
        onClose={() => setSettingsOpen(false)}
        onVimChange={setVimEnabled}
        onReducedMotionChange={setReducedMotion}
        onDensityChange={setDensity}
      />
    </div>
  );
}

function BootstrapShell() {
  return (
    <div className="dash-app dash-app--booting">
      <aside className="sidebar bootstrap-sidebar" aria-label="Sessions">
        <header className="sidebar__header">
          <div className="brand-mark" aria-hidden="true">π</div>
          <div><p className="eyebrow">Pi Daemon</p><h1>Dash</h1></div>
          <span className="fixture-badge">Fixture</span>
        </header>
        <div className="sidebar__summary" aria-label="Session summary"><strong>10,000</strong><span>indexed sessions</span></div>
        <div className="bootstrap-search" aria-hidden="true">Search title, project, path…</div>
        <div className="bootstrap-rows" role="listbox" aria-label="Session preview">
          {BOOTSTRAP_SESSIONS.slice(0, 8).map((session) => (
            <div key={session.inventoryId} className="bootstrap-row" data-session-row role="option" aria-selected="false">
              <span className={`presence-dot presence-dot--${session.presence.runtime}`} />
              <div><strong>{session.title}</strong><span>{session.project} · {session.cwd.split("/").at(-1)}</span></div>
            </div>
          ))}
        </div>
      </aside>
      <div className="workspace-shell">
        <div className="workspace-notice"><i />Preview ready · runtime hydration remains separate<span>Loading interactive workspace…</span></div>
        <main className="bootstrap-workspace" aria-label="Loading workspace">
          <section><i /><i /><i /><i /></section><aside><i /><i /><i /></aside>
        </main>
      </div>
    </div>
  );
}

export function App() {
  const [interactive, setInteractive] = useState(false);
  useLayoutEffect(() => {
    setFixtureCount(FIXTURE_SESSION_COUNT);
    markFirstRows();
    const frame = requestAnimationFrame(() => startTransition(() => setInteractive(true)));
    return () => cancelAnimationFrame(frame);
  }, []);
  return interactive ? <DashWorkspace /> : <BootstrapShell />;
}
