import { startTransition, useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import { asDashboardCursor } from "@harryaskham/pi-daemon/dashboard-contract";
import type {
  DashboardSessionIdentity,
  DashboardSettingsResource,
  DashboardTuiInput,
  DashboardWorkspaceResource,
  TuiDimensions,
} from "@harryaskham/pi-daemon/dashboard-contract";
import { ChatPane } from "./components/ChatPane";
import { EmptyPane } from "./components/EmptyPane";
import { InfoPane } from "./components/InfoPane";
import { KeyboardHelp } from "./components/KeyboardHelp";
import { SettingsModal } from "./components/SettingsModal";
import { Sidebar, type SidebarStatus } from "./components/Sidebar";
import { TuiPane } from "./components/TuiPane";
import { Workspace } from "./components/Workspace";
import { fixtureBackend } from "./fixture-backend";
import { CircleHelp, Menu } from "./icons";
import { createSessionFixtures, createTranscriptFixtures, createTranscriptShowcaseFixtures } from "./fixtures";
import { createTuiInputRuns, createTuiSnapshot, TUI_FIXTURE_OVERLAYS, TUI_FIXTURE_SELECTION } from "./tui-fixtures";
import { closePane, collectPaneIds, INITIAL_LAYOUT, splitPane, toDashboardLayout, updatePaneTarget } from "./layout";
import type { DemoState, InventoryId, LayoutNode, SessionFixture, TranscriptRecord } from "./model";
import { markFirstRows, recordFrameWork, setFixtureCount } from "./performance";
import { createTranscriptStore, transcriptStoreReducer } from "./transcript-store";
import { createTuiFrameStore, TuiFrameCache, tuiFrameStoreReducer, type TuiFrameStoreState } from "./tui-frame-store";
import { createLocalPreferencesBackend, useDashboardSettings, useDashboardWorkspace } from "./use-dashboard-preferences";

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

function tuiSnapshotFor(session: SessionFixture, dimensions: TuiDimensions = { rows: 24, columns: 80 }) {
  const snapshot = createTuiSnapshot(dimensions.rows, dimensions.columns);
  return {
    ...snapshot,
    identity: transcriptIdentity(session),
    title: `${session.project} · ${session.title}`,
    highWaterCursor: asDashboardCursor(`fixture:tui:${session.generation}:snapshot`),
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
  const initialLayout = useMemo(() => updatePaneTarget(
    updatePaneTarget(INITIAL_LAYOUT, "primary", { type: "chat", inventoryId: firstSession.inventoryId, presentation: "rich" }),
    "inspector",
    { type: "info", inventoryId: firstSession.inventoryId },
  ), [firstSession.inventoryId]);
  const preferencesBackend = useMemo(() => {
    const now = new Date().toISOString();
    const workspace: DashboardWorkspaceResource = {
      workspaceId: "workspace-fixture-01",
      revision: 1,
      createdAt: now,
      updatedAt: now,
      selectedPaneId: "primary",
      layout: toDashboardLayout(initialLayout),
      seenCursors: {},
    };
    const settings: DashboardSettingsResource = {
      revision: 1,
      effective: {
        theme: { name: "nord-midnight", density: "comfortable" },
        editor: { mode: "vim" },
        sidebar: { initialLimit: 100, showProject: true, groupBy: "none" },
        transcript: { expandTools: false, expandThinking: false },
        motion: { reduced: window.matchMedia("(prefers-reduced-motion: reduce)").matches },
        cache: { transcriptBytes: 32 * 1024 * 1024, transcriptEntries: 64 },
      },
      runtimeOverlay: {},
      sources: {
        "theme.name": "config",
        "theme.density": "config",
        "editor.mode": "config",
        "motion.reduced": "default",
      },
    };
    return createLocalPreferencesBackend(workspace, settings);
  }, [initialLayout]);
  const workspace = useDashboardWorkspace(preferencesBackend, preferencesBackend.workspaceSnapshot());
  const settings = useDashboardSettings(preferencesBackend, preferencesBackend.settingsSnapshot());
  const { layout, setLayout, selectedPaneId, setSelectedPaneId } = workspace;
  const vimEnabled = settings.resource.effective.editor.mode === "vim";
  const reducedMotion = settings.resource.effective.motion.reduced;
  const density = settings.resource.effective.theme.density;
  const [selectedInventoryId, setSelectedInventoryId] = useState<InventoryId>(firstSession.inventoryId);
  const paneSequence = useRef(2);
  const [query, setQuery] = useState("");
  const [composerHistory, setComposerHistory] = useState<string[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sidebarStatus, setSidebarStatus] = useState<SidebarStatus>(initialSidebarStatus);
  const [demoState, setDemoState] = useState<DemoState>(initialDemoState);
  const [streamIndex, setStreamIndex] = useState(0);
  const streamWorkStartedAt = useRef<number | undefined>(undefined);
  const tuiWorkStartedAt = useRef<number | undefined>(undefined);
  const workspaceWorkStartedAt = useRef<number | undefined>(undefined);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [keyboardHelpOpen, setKeyboardHelpOpen] = useState(false);
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
  const [tuiStores] = useState(() => {
    const cache = new TuiFrameCache<InventoryId>();
    cache.set(firstSession.inventoryId, createTuiFrameStore(tuiSnapshotFor(firstSession), "controller"));
    return cache;
  });
  const [tuiStoreRevision, setTuiStoreRevision] = useState(0);
  const [mountedTuiPanes, setMountedTuiPanes] = useState<ReadonlySet<string>>(() => new Set());
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
    const startedAt = workspaceWorkStartedAt.current;
    if (startedAt === undefined) return;
    recordFrameWork(performance.now() - startedAt);
    workspaceWorkStartedAt.current = undefined;
  }, [layout]);

  useLayoutEffect(() => {
    const startedAt = streamWorkStartedAt.current;
    if (startedAt === undefined) return;
    recordFrameWork(performance.now() - startedAt);
    streamWorkStartedAt.current = undefined;
  }, [streamIndex]);

  useLayoutEffect(() => {
    const startedAt = tuiWorkStartedAt.current;
    if (startedAt === undefined) return;
    recordFrameWork(performance.now() - startedAt);
    tuiWorkStartedAt.current = undefined;
  }, [tuiStoreRevision]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if ((event.metaKey || event.ctrlKey) && event.key === ",") {
        event.preventDefault();
        setSettingsOpen(true);
      } else if (event.key === "?" && !(event.target instanceof Element && event.target.closest("[data-editor-root]"))) {
        event.preventDefault();
        setKeyboardHelpOpen(true);
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

  const commitLayout = useCallback((next: LayoutNode) => {
    workspaceWorkStartedAt.current = performance.now();
    setLayout(next);
  }, [setLayout]);

  const getTuiState = useCallback((session: SessionFixture): TuiFrameStoreState => {
    const existing = tuiStores.get(session.inventoryId);
    if (existing) return existing;
    const created = createTuiFrameStore(tuiSnapshotFor(session));
    tuiStores.set(session.inventoryId, created);
    return created;
  }, []);

  const replaceTuiState = useCallback((session: SessionFixture, state: TuiFrameStoreState) => {
    tuiStores.set(session.inventoryId, state);
    setTuiStoreRevision((revision) => revision + 1);
  }, []);

  const resizeTui = useCallback((session: SessionFixture, dimensions: TuiDimensions) => {
    tuiWorkStartedAt.current = performance.now();
    replaceTuiState(session, createTuiFrameStore(tuiSnapshotFor(session, dimensions), "controller"));
    setNotice(`Canonical TUI resized · ${dimensions.columns}×${dimensions.rows}`);
  }, [replaceTuiState]);

  const sendTuiInput = useCallback((session: SessionFixture, input: DashboardTuiInput) => {
    tuiWorkStartedAt.current = performance.now();
    const current = getTuiState(session);
    const sequence = current.sequence + 1;
    const text = input.type === "key"
      ? `key ${[...(input.modifiers ?? []), input.key].join("+")}`
      : `${input.type} ${input.text.replaceAll("\n", "↵").slice(0, 96)}`;
    const row = Math.max(0, current.dimensions.rows - 3);
    const next = tuiFrameStoreReducer(current, {
      type: "delta",
      delta: {
        kind: "tui_delta",
        identity: current.identity,
        cursor: asDashboardCursor(`fixture:tui:${session.generation}:${sequence}`),
        sequence,
        dimensions: current.dimensions,
        changedRows: [{ row, runs: createTuiInputRuns(text) }],
        cursorState: { row, column: Math.min(current.dimensions.columns - 1, 17 + text.length), visible: true, shape: "bar" },
        ...(current.title ? { title: current.title } : {}),
      },
    });
    replaceTuiState(session, next);
    setNotice("Fixture TUI input projected locally · no provider request was sent");
  }, [getTuiState, replaceTuiState]);

  const setPanePresentation = useCallback((node: Extract<LayoutNode, { type: "leaf" }>, presentation: "rich" | "tui") => {
    if (node.target.type !== "chat") return;
    if (presentation === "tui") {
      setMountedTuiPanes((current) => current.has(node.paneId) ? current : new Set([...current, node.paneId]));
    }
    commitLayout(updatePaneTarget(layout, node.paneId, { ...node.target, presentation }));
    setNotice(`${presentation === "tui" ? "Terminal" : "Rich"} presentation selected · session state preserved`);
  }, [commitLayout, layout]);

  const openTarget = useCallback((session: SessionFixture, type: "chat" | "info") => {
    setSelectedInventoryId(session.inventoryId);
    setSidebarOpen(false);
    commitLayout(updatePaneTarget(
      layout,
      selectedPaneId,
      type === "chat"
        ? { type, inventoryId: session.inventoryId, presentation: "rich" }
        : { type, inventoryId: session.inventoryId },
    ));
  }, [commitLayout, layout, selectedPaneId]);

  const renderPane = useCallback((node: Extract<LayoutNode, { type: "leaf" }>) => {
    if (node.target.type === "empty") return <EmptyPane />;
    const session = sessionById.get(node.target.inventoryId);
    if (!session) return <EmptyPane />;
    if (node.target.type === "info") return <InfoPane session={session} />;
    const presentation = node.target.presentation;
    const canonicalTui = getTuiState(session);
    const tuiState: TuiFrameStoreState = {
      ...canonicalTui,
      role: presentation === "tui" && selectedPaneId === node.paneId ? "controller" : "observer",
    };
    return (
      <div className="pane-presentations" data-presentation={presentation}>
        <div className="pane-presentation-layer" hidden={presentation !== "rich"}>
      <ChatPane
        session={session}
        records={records}
        demoState={demoState}
        streamText={streamText}
        vimEnabled={vimEnabled}
        composerHistory={composerHistory}
        onPresentationChange={(next) => setPanePresentation(node, next)}
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
        onToggleVim={() => settings.patch({ editor: { mode: vimEnabled ? "multiline" : "vim" } })}
        onSubmit={(value) => {
          setComposerHistory((current) => [...current.slice(-49), value]);
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
        </div>
        {presentation === "tui" || mountedTuiPanes.has(node.paneId) ? <div className="pane-presentation-layer" hidden={presentation !== "tui"}>
          <TuiPane
            session={session}
            state={tuiState}
            selected={selectedPaneId === node.paneId}
            active={presentation === "tui"}
            overlays={TUI_FIXTURE_OVERLAYS}
            selection={TUI_FIXTURE_SELECTION}
            onPresentationChange={(next) => setPanePresentation(node, next)}
            onResize={(dimensions) => resizeTui(session, dimensions)}
            onInput={(input) => sendTuiInput(session, input)}
            onRequestSnapshot={() => replaceTuiState(session, createTuiFrameStore(tuiSnapshotFor(session), tuiState.role))}
            onRequestControl={() => setSelectedPaneId(node.paneId)}
          />
        </div> : null}
      </div>
    );
  }, [composerHistory, demoState, getTuiState, mountedTuiPanes, records, replaceTuiState, resizeTui, selectedPaneId, sendTuiInput, sessionById, setPanePresentation, settings, streamText, transcriptState.droppedRecords, transcriptState.identity, transcriptState.needsReconcile, tuiStoreRevision, vimEnabled]);

  return (
    <div className="dash-app" data-theme={settings.resource.effective.theme.name} data-density={density} data-reduced-motion={reducedMotion ? "true" : "false"} data-sidebar-open={sidebarOpen ? "true" : "false"}>
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
          <i />{notice}
          <button type="button" className="keyboard-help-button" aria-label="Open keyboard guide" onClick={() => setKeyboardHelpOpen(true)}><CircleHelp size={13} /> Keys</button>
          <span>{workspace.syncState === "synced" ? `workspace r${workspace.resource.revision}` : `workspace ${workspace.syncState}`} · Ctrl-hjkl focus · Ctrl-Shift-hjkl swap</span>
        </div>
        <Workspace
          layout={layout}
          selectedPaneId={selectedPaneId}
          onLayoutChange={commitLayout}
          onSelectedPaneChange={setSelectedPaneId}
          paneCount={collectPaneIds(layout).length}
          onSplitPane={(paneId, direction) => {
            const newPaneId = `pane-${++paneSequence.current}`;
            commitLayout(splitPane(layout, paneId, direction, newPaneId));
            setSelectedPaneId(newPaneId);
          }}
          onClosePane={(paneId) => {
            const next = closePane(layout, paneId);
            const panes = collectPaneIds(next);
            commitLayout(next);
            if (paneId === selectedPaneId) setSelectedPaneId(panes[0] ?? selectedPaneId);
          }}
          renderPane={renderPane}
        />
      </div>
      <KeyboardHelp open={keyboardHelpOpen} onClose={() => setKeyboardHelpOpen(false)} />
      <SettingsModal
        open={settingsOpen}
        vimEnabled={vimEnabled}
        reducedMotion={reducedMotion}
        density={density}
        themeName={settings.resource.effective.theme.name}
        revision={settings.resource.revision}
        sources={settings.resource.sources}
        syncState={settings.syncState}
        onClose={() => setSettingsOpen(false)}
        onVimChange={(enabled) => settings.patch({ editor: { mode: enabled ? "vim" : "multiline" } })}
        onReducedMotionChange={(enabled) => settings.patch({ motion: { reduced: enabled } })}
        onDensityChange={(nextDensity) => settings.patch({ theme: { density: nextDensity } })}
        onThemeChange={(theme) => settings.patch({ theme: { name: theme } })}
        onReset={settings.reset}
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
