import { startTransition, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  DASH_API_VERSION,
  DASH_DEFAULT_LIMITS,
  DASH_PERFORMANCE_BUDGETS,
  DASH_STREAM_SUBPROTOCOL,
  asDashboardCursor,
} from "@harryaskham/pi-daemon/dashboard-contract";
import type {
  DashboardBackend,
  DashboardBootstrapResource,
  DashboardCapabilities,
  DashboardSessionIdentity,
  DashboardSettingsResource,
  DashboardTuiInput,
  DashboardWorkspaceResource,
  SessionInventoryRecord,
  TuiDimensions,
} from "@harryaskham/pi-daemon/dashboard-contract";
import { BrowserDashboardClient, DashboardBrowserClientError } from "./browser-dashboard-client";
import { ConnectedChatPane } from "./components/ConnectedChatPane";
import { ConnectedInfoPane } from "./components/ConnectedInfoPane";
import { ConnectedTuiPane } from "./components/ConnectedTuiPane";
import { EmptyPane } from "./components/EmptyPane";
import { KeyboardHelp } from "./components/KeyboardHelp";
import { SettingsModal } from "./components/SettingsModal";
import { Sidebar, type SidebarStatus } from "./components/Sidebar";
import { TuiPane } from "./components/TuiPane";
import { Workspace } from "./components/Workspace";
import type { DashboardLiveSessionState } from "./dashboard-live-session";
import { liveFixtureBackend } from "./live-fixture-backend";
import { CircleHelp, Menu } from "./icons";
import { createSessionFixtures, createTranscriptFixtures, createTranscriptShowcaseFixtures } from "./fixtures";
import { createTuiInputRuns, createTuiSnapshot, TUI_FIXTURE_OVERLAYS, TUI_FIXTURE_SELECTION } from "./tui-fixtures";
import { closePane, collectPaneIds, INITIAL_LAYOUT, splitPane, toDashboardLayout, updatePaneTarget } from "./layout";
import type { DemoState, InventoryId, LayoutNode, SessionFixture } from "./model";
import type { DashboardPreferencesBackend } from "./preferences-backend";
import { markFirstRows, recordFrameWork, setFixtureCount } from "./performance";
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

function preferredSession(sessions: readonly SessionFixture[]): SessionFixture | undefined {
  return sessions.find((item) => item.presence.runtime === "running") ?? sessions[0];
}

function displaySession(record: SessionInventoryRecord): SessionFixture {
  const sessionId = record.managed?.sessionId ?? record.piSessionId ?? record.inventoryId;
  const project = record.projectLabel ?? "Pi session";
  return {
    ...record,
    sessionId,
    generation: record.managed?.generation ?? 0,
    cwd: record.cwdBasename ?? "Path available in session information",
    project,
    model: "not hydrated",
    thinking: "off",
    contextPercent: 0,
  };
}

function fixtureBootstrap(): {
  workspace: DashboardWorkspaceResource;
  settings: DashboardSettingsResource;
  preferences: DashboardPreferencesBackend;
} {
  const firstSession = preferredSession(BOOTSTRAP_SESSIONS);
  if (!firstSession) throw new Error("Dash fixture requires at least one session");
  const layout = updatePaneTarget(
    updatePaneTarget(INITIAL_LAYOUT, "primary", { type: "chat", inventoryId: firstSession.inventoryId, presentation: "rich" }),
    "inspector",
    { type: "info", inventoryId: firstSession.inventoryId },
  );
  const now = new Date().toISOString();
  const workspace: DashboardWorkspaceResource = {
    workspaceId: "workspace-fixture-01",
    revision: 1,
    createdAt: now,
    updatedAt: now,
    selectedPaneId: "primary",
    layout: toDashboardLayout(layout),
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
  const preferences = createLocalPreferencesBackend(workspace, settings);
  return { workspace: preferences.workspaceSnapshot(), settings: preferences.settingsSnapshot(), preferences };
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

interface DashWorkspaceProps {
  backend: DashboardBackend;
  preferencesBackend: DashboardPreferencesBackend;
  initialWorkspace: DashboardWorkspaceResource;
  initialSettings: DashboardSettingsResource;
  initialSessions: SessionFixture[];
  capabilities: DashboardCapabilities;
  fixtureMode: boolean;
  inventoryReconciling?: boolean;
}

function DashWorkspace({
  backend,
  preferencesBackend,
  initialWorkspace,
  initialSettings,
  initialSessions,
  capabilities,
  fixtureMode,
  inventoryReconciling = false,
}: DashWorkspaceProps) {
  const [sessions, setSessions] = useState<SessionFixture[]>(initialSessions);
  const firstSession = useMemo(() => preferredSession(initialSessions), [initialSessions]);
  const workspace = useDashboardWorkspace(preferencesBackend, initialWorkspace);
  const settings = useDashboardSettings(preferencesBackend, initialSettings);
  const { layout, setLayout, selectedPaneId, setSelectedPaneId } = workspace;
  const vimEnabled = settings.resource.effective.editor.mode === "vim";
  const reducedMotion = settings.resource.effective.motion.reduced;
  const density = settings.resource.effective.theme.density;
  const [selectedInventoryId, setSelectedInventoryId] = useState<InventoryId | undefined>(firstSession?.inventoryId);
  const paneSequence = useRef(2);
  const [query, setQuery] = useState("");
  const [composerHistory, setComposerHistory] = useState<string[]>([]);
  const [liveStates, setLiveStates] = useState<ReadonlyMap<InventoryId, DashboardLiveSessionState>>(() => new Map());
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sidebarStatus, setSidebarStatus] = useState<SidebarStatus>(() => fixtureMode ? initialSidebarStatus() : initialSessions.length === 0 ? "empty" : "ready");
  const [demoState, setDemoState] = useState<DemoState>(() => fixtureMode ? initialDemoState() : "ready");
  const [streamIndex, setStreamIndex] = useState(0);
  const streamWorkStartedAt = useRef<number | undefined>(undefined);
  const tuiWorkStartedAt = useRef<number | undefined>(undefined);
  const workspaceWorkStartedAt = useRef<number | undefined>(undefined);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [keyboardHelpOpen, setKeyboardHelpOpen] = useState(false);
  const [tuiStores] = useState(() => {
    const cache = new TuiFrameCache<InventoryId>();
    if (firstSession !== undefined && fixtureMode) {
      cache.set(firstSession.inventoryId, createTuiFrameStore(tuiSnapshotFor(firstSession), "controller"));
    }
    return cache;
  });
  const [tuiStoreRevision, setTuiStoreRevision] = useState(0);
  const [mountedTuiPanes, setMountedTuiPanes] = useState<ReadonlySet<string>>(() => new Set());
  const [notice, setNotice] = useState(fixtureMode ? "Preview ready · runtime hydration remains separate" : "Authenticated · persisted preview loads before runtime hydration");

  useEffect(() => {
    if (!fixtureMode) return;
    let expandTimer = 0;
    const frame = requestAnimationFrame(() => {
      expandTimer = window.setTimeout(() => {
        startTransition(() => setSessions(liveFixtureBackend.sessions));
      }, 0);
    });
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(expandTimer);
    };
  }, [fixtureMode]);

  useEffect(() => {
    if (fixtureMode) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setSidebarStatus("loading");
      void backend.listSessions({
        limit: capabilities.limits.maxInventoryPageItems,
        ...(query.trim().length === 0 ? {} : { search: query.trim() }),
      }).then((page) => {
        if (controller.signal.aborted) return;
        startTransition(() => setSessions(page.sessions.map(displaySession)));
        setSidebarStatus(page.sessions.length === 0 ? "empty" : "ready");
      }).catch(() => {
        if (!controller.signal.aborted) setSidebarStatus("error");
      });
    }, query.trim().length === 0 ? 0 : 180);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [backend, capabilities.limits.maxInventoryPageItems, fixtureMode, query]);

  useEffect(() => {
    if (!fixtureMode || demoState !== "streaming" || reducedMotion) return;
    const interval = window.setInterval(() => {
      streamWorkStartedAt.current = performance.now();
      setStreamIndex((index) => (index + 1) % (STREAM_WORDS.length + 1));
    }, 440);
    return () => window.clearInterval(interval);
  }, [demoState, fixtureMode, reducedMotion]);

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
  const displaySessions = useMemo(() => sessions.map((session) => {
    const liveState = liveStates.get(session.inventoryId);
    if (!liveState) return session;
    const running = liveState.phase === "streaming" || liveState.phase === "activating" || liveState.phase === "hydrating";
    return {
      ...session,
      ...(liveState.managedSession === undefined
        ? {}
        : {
            sessionId: liveState.managedSession.sessionId,
            generation: liveState.managedSession.generation,
            managed: {
              sessionId: liveState.managedSession.sessionId,
              ...(liveState.managedSession.name === undefined ? {} : { name: liveState.managedSession.name }),
              generation: liveState.managedSession.generation,
              revision: liveState.managedSession.revision,
              residency: liveState.managedSession.residency,
              state: liveState.managedSession.state,
            },
          }),
      cwd: liveState.info?.cwd ?? session.cwd,
      project: liveState.info?.projectLabel ?? session.project,
      model: liveState.info?.runtime?.model?.id ?? String(liveState.rpcState.model ?? session.model),
      thinking: thinkingLevel(liveState.info?.runtime?.model?.thinkingLevel ?? liveState.rpcState.thinkingLevel, session.thinking),
      presence: {
        ...session.presence,
        runtime: liveState.phase === "error" ? "failed" : running ? "running" : "resident-idle",
        activation: liveState.phase === "preview-loading" || liveState.phase === "preview" ? "selected" : "user-turn",
        focusedPaneCount: 1,
        unread: liveState.unread,
      },
    } satisfies SessionFixture;
  }), [liveStates, sessions]);
  const sessionById = useMemo(() => new Map(displaySessions.map((session) => [session.inventoryId, session])), [displaySessions]);

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
    if (node.target.type === "info") return <ConnectedInfoPane backend={backend} session={session} fixtureMode={fixtureMode} />;
    const presentation = node.target.presentation;
    const canonicalTui = fixtureMode ? getTuiState(session) : undefined;
    const tuiState: TuiFrameStoreState | undefined = canonicalTui === undefined ? undefined : {
      ...canonicalTui,
      role: presentation === "tui" && selectedPaneId === node.paneId ? "controller" : "observer",
    };
    return (
      <div className="pane-presentations" data-presentation={presentation}>
        <div className="pane-presentation-layer" hidden={presentation !== "rich"}>
      <ConnectedChatPane
        backend={backend}
        session={session}
        fallbackRecords={fixtureMode ? INITIAL_TRANSCRIPT_RECORDS : []}
        active={selectedPaneId === node.paneId && presentation === "rich"}
        fixtureMode={fixtureMode}
        tuiAvailable={fixtureMode || capabilities.presentations.tui.available}
        demoState={demoState}
        streamText={streamText}
        vimEnabled={vimEnabled}
        composerHistory={composerHistory}
        onSeen={workspace.markSeen}
        onStateChange={(state) => {
          setLiveStates((current) => {
            const prior = current.get(session.inventoryId);
            if (
              prior?.phase === state.phase &&
              prior.role === state.role &&
              prior.unread === state.unread
            ) return current;
            const next = new Map(current);
            next.set(session.inventoryId, state);
            return next;
          });
        }}
        onPresentationChange={(next) => setPanePresentation(node, next)}
        onDemoStateChange={setDemoState}
        onToggleVim={() => settings.patch({ editor: { mode: vimEnabled ? "multiline" : "vim" } })}
        onSubmitted={(value) => {
          setComposerHistory((current) => [...current.slice(-49), value]);
          setDemoState("streaming");
          setStreamIndex(0);
          setNotice("Live command accepted · durable entry will reconcile by Pi identity");
        }}
      />
        </div>
        {presentation === "tui" || mountedTuiPanes.has(node.paneId) ? <div className="pane-presentation-layer" hidden={presentation !== "tui"}>
          {fixtureMode && tuiState !== undefined ? (
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
          ) : (
            <ConnectedTuiPane
              backend={backend}
              session={session}
              selected={selectedPaneId === node.paneId}
              active={presentation === "tui"}
              onPresentationChange={(next) => setPanePresentation(node, next)}
            />
          )}
        </div> : null}
      </div>
    );
  }, [backend, capabilities.presentations.tui.available, composerHistory, demoState, fixtureMode, getTuiState, mountedTuiPanes, replaceTuiState, resizeTui, selectedPaneId, sendTuiInput, sessionById, setPanePresentation, settings, streamText, tuiStoreRevision, vimEnabled]);

  return (
    <div className="dash-app" data-theme={settings.resource.effective.theme.name} data-density={density} data-reduced-motion={reducedMotion ? "true" : "false"} data-sidebar-open={sidebarOpen ? "true" : "false"}>
      <a className="skip-link" href="#dash-workspace">Skip to workspace</a>
      <Sidebar
        sessions={displaySessions}
        query={query}
        {...(selectedInventoryId === undefined ? {} : { selectedInventoryId })}
        status={sidebarStatus}
        reconciling={fixtureMode ? sessions.length < FIXTURE_SESSION_COUNT : inventoryReconciling}
        fixtureMode={fixtureMode}
        connectionLabel={fixtureMode ? "Local fixture · 4 ms" : "Same-origin authenticated stream"}
        summaryLabel={fixtureMode ? "indexed sessions" : "loaded sessions"}
        onQueryChange={setQuery}
        onOpenChat={(session) => openTarget(session, "chat")}
        onOpenInfo={(session) => openTarget(session, "info")}
        onOpenSettings={() => setSettingsOpen(true)}
        onRequestClose={() => setSidebarOpen(false)}
        onRetry={() => {
          setSidebarStatus("loading");
          if (fixtureMode) window.setTimeout(() => setSidebarStatus("ready"), 360);
          else void backend.listSessions({ limit: capabilities.limits.maxInventoryPageItems, ...(query.trim() ? { search: query.trim() } : {}) })
            .then((page) => {
              setSessions(page.sessions.map(displaySession));
              setSidebarStatus(page.sessions.length === 0 ? "empty" : "ready");
            })
            .catch(() => setSidebarStatus("error"));
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

function BootstrapShell({ fixtureMode }: { fixtureMode: boolean }) {
  return (
    <div className="dash-app dash-app--booting">
      <aside className="sidebar bootstrap-sidebar" aria-label="Sessions">
        <header className="sidebar__header">
          <div className="brand-mark" aria-hidden="true">π</div>
          <div><p className="eyebrow">Pi Daemon</p><h1>Dash</h1></div>
          {fixtureMode ? <span className="fixture-badge">Fixture</span> : null}
        </header>
        {fixtureMode ? <>
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
        </> : <div className="sidebar-list-state sidebar-list-state--loading" aria-label="Loading authenticated sessions" aria-busy="true"><i /><i /><i /><i /><i /></div>}
      </aside>
      <div className="workspace-shell">
        <div className="workspace-notice"><i />{fixtureMode ? "Preview ready · runtime hydration remains separate" : "Connecting to the same-origin Dash service…"}<span>Loading interactive workspace…</span></div>
        <main className="bootstrap-workspace" aria-label="Loading workspace">
          <section><i /><i /><i /><i /></section><aside><i /><i /><i /></aside>
        </main>
      </div>
    </div>
  );
}

function FixtureApp() {
  const [interactive, setInteractive] = useState(false);
  const bootstrap = useMemo(fixtureBootstrap, []);
  useLayoutEffect(() => {
    setFixtureCount(FIXTURE_SESSION_COUNT);
    markFirstRows();
    const frame = requestAnimationFrame(() => startTransition(() => setInteractive(true)));
    return () => cancelAnimationFrame(frame);
  }, []);
  return interactive ? (
    <DashWorkspace
      backend={liveFixtureBackend}
      preferencesBackend={bootstrap.preferences}
      initialWorkspace={bootstrap.workspace}
      initialSettings={bootstrap.settings}
      initialSessions={BOOTSTRAP_SESSIONS}
      capabilities={liveFixtureCapabilities()}
      fixtureMode
    />
  ) : <BootstrapShell fixtureMode />;
}

type ProductionPhase = "loading" | "login" | "ready" | "error";

function ProductionApp() {
  const client = useMemo(() => new BrowserDashboardClient(), []);
  const [phase, setPhase] = useState<ProductionPhase>("loading");
  const [bootstrap, setBootstrap] = useState<DashboardBootstrapResource>();
  const [credential, setCredential] = useState("");
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    setPhase("loading");
    setError(undefined);
    try {
      const resource = await client.bootstrap();
      setBootstrap(resource);
      setPhase(client.authenticatedForMutations ? "ready" : "login");
    } catch (reason) {
      if (reason instanceof DashboardBrowserClientError && (reason.status === 401 || reason.code === "unauthorized" || reason.code === "login_failed")) {
        setPhase("login");
      } else {
        setError(reason instanceof Error ? reason.message : "Dash bootstrap failed");
        setPhase("error");
      }
    }
  }, [client]);

  useEffect(() => {
    void load();
    return () => { void client.close(); };
  }, [client, load]);

  async function submitLogin(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (submitting || credential.length === 0) return;
    setSubmitting(true);
    setError(undefined);
    try {
      await client.login(credential);
      setCredential("");
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Dash login failed");
      setPhase("login");
    } finally {
      setSubmitting(false);
    }
  }

  if (phase === "loading") return <BootstrapShell fixtureMode={false} />;
  if (phase === "login") {
    return (
      <main className="dash-login" aria-labelledby="dash-login-title">
        <section className="dash-login__card">
          <div className="brand-mark" aria-hidden="true">π</div>
          <p className="eyebrow">Pi Daemon</p>
          <h1 id="dash-login-title">Sign in to Dash</h1>
          <p>Exchange the owner-private web credential for an HttpOnly browser session. The credential stays input-only and is never stored by the SPA.</p>
          <form onSubmit={(event) => void submitLogin(event)}>
            <label><span>Web credential</span><input type="password" value={credential} onChange={(event) => setCredential(event.target.value)} autoComplete="off" autoFocus /></label>
            {error ? <div className="dash-login__error" role="alert">{error}</div> : null}
            <button type="submit" className="primary-button" disabled={submitting || credential.length === 0}>{submitting ? "Signing in…" : "Sign in"}</button>
          </form>
        </section>
      </main>
    );
  }
  if (phase === "error" || bootstrap === undefined) {
    return <main className="dash-login"><section className="dash-login__card"><h1>Dash is unavailable</h1><p role="alert">{error ?? "Bootstrap did not return a workspace."}</p><button type="button" className="primary-button" onClick={() => void load()}>Retry</button></section></main>;
  }
  return (
    <DashWorkspace
      backend={client}
      preferencesBackend={client}
      initialWorkspace={bootstrap.workspace}
      initialSettings={bootstrap.settings}
      initialSessions={bootstrap.inventory.sessions.map(displaySession)}
      capabilities={bootstrap.capabilities}
      fixtureMode={false}
      inventoryReconciling={bootstrap.inventory.index.reconciling}
    />
  );
}

function liveFixtureCapabilities(): DashboardCapabilities {
  return {
    apiVersion: DASH_API_VERSION,
    streamSubprotocol: DASH_STREAM_SUBPROTOCOL,
    sameBrowserProtocolAcrossDeployments: true,
    authentication: { browserSession: "http-only-cookie", csrf: "same-origin-header", daemonBearerExposed: false },
    resources: { inventory: true, transcriptPreview: true, activation: true, export: true, workspaces: true, settings: true, schedules: false },
    presentations: {
      rich: { available: true, replay: true, controller: true, commands: [] },
      tui: { available: true, replay: true, controller: true, commands: [] },
    },
    limits: { ...DASH_DEFAULT_LIMITS },
    performanceBudgets: { ...DASH_PERFORMANCE_BUDGETS },
  };
}

function thinkingLevel(value: unknown, fallback: SessionFixture["thinking"]): SessionFixture["thinking"] {
  return value === "off" || value === "minimal" || value === "low" || value === "medium" || value === "high" ? value : fallback;
}

export function App() {
  const fixtureMode = new URLSearchParams(window.location.search).get("fixture") === "1";
  return fixtureMode ? <FixtureApp /> : <ProductionApp />;
}
