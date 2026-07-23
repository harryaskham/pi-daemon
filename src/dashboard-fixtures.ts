import {
  DASH_API_VERSION,
  DASH_DEFAULT_LIMITS,
  DASH_PERFORMANCE_BUDGETS,
  DASH_STREAM_SUBPROTOCOL,
  asDashboardCursor,
  asDashboardFingerprint,
} from "./dashboard-contract.js";
import type {
  ActivationRequest,
  ActivationTicket,
  DashSessionPresence,
  DashStreamExtensionUiResponseFrame,
  DashStreamReplayGapFrame,
  DashStreamSessionEventFrame,
  DashStreamSubscribeFrame,
  DashStreamSubscriptionReadyFrame,
  DashStreamTuiDeltaFrame,
  DashboardCapabilities,
  DashboardErrorEnvelope,
  DashboardLeaseResource,
  DashboardServiceCapabilities,
  DashboardSettingsResource,
  DashboardSuccessEnvelope,
  DashboardWorkspaceResource,
  SessionExportRequest,
  SessionExportTicket,
  SessionInfoResource,
  SessionInventoryPage,
  TranscriptPage,
} from "./dashboard-contract.js";
import {
  SESSION_API_VERSION,
  type ApiSuccessEnvelope,
  type SessionResource,
} from "./session-api.js";
import { EXTENSION_VIEW_CAPABILITY } from "./extension-view-contract.js";
import { createExtensionViewFixture } from "./extension-view-fixtures.js";

const FIXTURE_TIME = "2026-07-18T12:00:00.000Z";
const FIXTURE_CLIENT = "client-fixture-01";
const FIXTURE_WORKSPACE = "workspace-fixture-01";
const FIXTURE_SERVER = "dash-fixture-01";
const FIXTURE_HOST = "host-fixture-01";
const FIXTURE_SESSION = "session-fixture-01";
const FIXTURE_INVENTORY = "inventory-fixture-01";

export interface DashboardActivationTicketFixtures {
  reuseSucceeded: ActivationTicket;
  directQueued: ActivationTicket;
  forkRunning: ActivationTicket;
}

export interface DashboardExportTicketFixtures {
  asNewSucceeded: SessionExportTicket;
  appendIndeterminate: SessionExportTicket;
}

export interface DashboardReplayRecoveryFixture {
  gap: DashStreamReplayGapFrame;
  freshSnapshot: DashStreamSubscriptionReadyFrame;
}

export interface DashboardMultiplexFixture {
  subscriptions: [DashStreamSubscribeFrame, DashStreamSubscribeFrame];
  ready: [DashStreamSubscriptionReadyFrame, DashStreamSubscriptionReadyFrame];
}

export interface DashboardContractFixtures {
  capabilities: DashboardCapabilities;
  inventory: SessionInventoryPage;
  sessionInfo: SessionInfoResource;
  transcript: TranscriptPage;
  activationRequest: ActivationRequest;
  activationTicket: ActivationTicket;
  activationTickets: DashboardActivationTicketFixtures;
  exportRequest: SessionExportRequest;
  exportTicket: SessionExportTicket;
  exportTickets: DashboardExportTicketFixtures;
  presenceScenarios: DashSessionPresence[];
  workspace: DashboardWorkspaceResource;
  settings: DashboardSettingsResource;
  capabilitiesEnvelope: DashboardSuccessEnvelope<DashboardCapabilities>;
  inventoryEnvelope: DashboardSuccessEnvelope<SessionInventoryPage>;
  transcriptEnvelope: DashboardSuccessEnvelope<TranscriptPage>;
  errorEnvelope: DashboardErrorEnvelope;
  streamSubscribe: DashStreamSubscribeFrame;
  streamExtensionUiResponse: DashStreamExtensionUiResponseFrame;
  streamReady: DashStreamSubscriptionReadyFrame;
  streamEvent: DashStreamSessionEventFrame;
  streamExtensionView: DashStreamSessionEventFrame;
  streamTuiDelta: DashStreamTuiDeltaFrame;
  streamReplayGap: DashStreamReplayGapFrame;
  replayRecovery: DashboardReplayRecoveryFixture;
  multiplex: DashboardMultiplexFixture;
  serviceCapabilities: DashboardServiceCapabilities;
  lease: DashboardLeaseResource;
  serviceCapabilitiesEnvelope: ApiSuccessEnvelope<DashboardServiceCapabilities>;
  serviceInventoryEnvelope: ApiSuccessEnvelope<SessionInventoryPage>;
  serviceInfoEnvelope: ApiSuccessEnvelope<SessionInfoResource>;
  serviceTranscriptEnvelope: ApiSuccessEnvelope<TranscriptPage>;
  serviceActivationEnvelope: ApiSuccessEnvelope<ActivationTicket>;
  serviceExportEnvelope: ApiSuccessEnvelope<SessionExportTicket>;
  serviceLeaseEnvelope: ApiSuccessEnvelope<DashboardLeaseResource>;
}

function sessionDefaultsFixture(): NonNullable<DashboardCapabilities["sessionDefaults"]> {
  return {
    spec: {
      cwd: "/home/fixture",
      persistence: "persistent",
      model: { provider: "github-copilot", id: "gpt-5.6-sol", thinkingLevel: "high" },
      tools: { mode: "default" },
      resources: {
        noExtensions: false,
        noSkills: false,
        noPromptTemplates: false,
        noThemes: false,
        noContextFiles: false,
        projectTrust: "approve",
      },
      isolation: { mode: "unisolated" },
    },
    sources: { cwd: "configured", model: "pi-settings", authority: "runtime-policy" },
  };
}

export function createDashboardCapabilitiesFixture(): DashboardCapabilities {
  const commonCommands = [
    "get_state",
    "get_entries",
    "get_session_stats",
    "get_commands",
    "get_available_models",
    "prompt",
    "steer",
    "follow_up",
    "abort",
    "set_model",
    "set_thinking_level",
    "compact",
    "set_session_name",
    "get_tree",
    "navigate_tree",
    "fork",
    "clone",
  ] as const;
  return {
    apiVersion: DASH_API_VERSION,
    streamSubprotocol: DASH_STREAM_SUBPROTOCOL,
    sameBrowserProtocolAcrossDeployments: true,
    authentication: {
      browserSession: "http-only-cookie",
      csrf: "same-origin-header",
      daemonBearerExposed: false,
    },
    resources: {
      inventory: true,
      transcriptPreview: true,
      activation: true,
      export: true,
      workspaces: true,
      settings: true,
      schedules: false,
      sessionDrafts: false,
      treeNavigation: true,
    },
    presentations: {
      rich: {
        available: true,
        replay: true,
        controller: true,
        commands: [...commonCommands],
      },
      tui: {
        available: false,
        replay: true,
        controller: true,
        commands: [...commonCommands],
        unavailableReason: "interactive-view-seam-required",
      },
    },
    extensionViews: structuredClone(EXTENSION_VIEW_CAPABILITY),
    sessionDefaults: sessionDefaultsFixture(),
    limits: { ...DASH_DEFAULT_LIMITS },
    performanceBudgets: { ...DASH_PERFORMANCE_BUDGETS },
  };
}

function managedSessionFixture(): SessionResource {
  return {
    sessionId: FIXTURE_SESSION,
    name: "Contract fixture",
    generation: 3,
    revision: 7,
    residency: "resident",
    state: "idle",
    createdAt: "2026-07-18T11:00:00.000Z",
    updatedAt: FIXTURE_TIME,
    lastUsedAt: FIXTURE_TIME,
    spec: {
      cwd: "/srv/work/fixture",
      target: { mode: "open", path: "/srv/state/session-fixture.jsonl" },
      isolation: { mode: "unisolated" },
    },
    environment: { keys: [], persistence: "memory-only", provisioned: true },
    lastTerminal: { state: "succeeded", at: FIXTURE_TIME, requestId: "req-turn-01" },
    links: {
      self: `/v1/session/${FIXTURE_SESSION}`,
      rpc: `/v1/session/${FIXTURE_SESSION}/rpc`,
      apc: `/v1/session/${FIXTURE_SESSION}/apc`,
    },
  };
}

function successEnvelope<T>(requestId: string, data: T): DashboardSuccessEnvelope<T> {
  return {
    dashVersion: DASH_API_VERSION,
    requestId,
    serverInstanceId: FIXTURE_SERVER,
    clientId: FIXTURE_CLIENT,
    workspaceId: FIXTURE_WORKSPACE,
    ok: true,
    data,
  };
}

function serviceEnvelope<T>(requestId: string, data: T): ApiSuccessEnvelope<T> {
  return {
    apiVersion: SESSION_API_VERSION,
    requestId,
    hostInstanceId: FIXTURE_HOST,
    ok: true,
    data,
  };
}

/**
 * Deterministic, content-safe records shared by browser and backend conformance tests.
 * The fixture intentionally models preview before hydration and an unavailable TUI seam.
 */
export function createDashboardContractFixtures(): DashboardContractFixtures {
  const cursor0 = asDashboardCursor("dash:fixture:host-fixture-01:session-fixture-01:3:40");
  const cursor1 = asDashboardCursor("dash:fixture:host-fixture-01:session-fixture-01:3:41");
  const fingerprint = asDashboardFingerprint("sha256:fixture-source-fingerprint");
  const capabilities = createDashboardCapabilitiesFixture();
  const presence = {
    runtime: "resident-idle" as const,
    activation: "user-turn" as const,
    focusedPaneCount: 1,
    lastSettledCursor: cursor0,
    seenCursor: cursor0,
    unread: false,
  };
  const inventoryRecord = {
    inventoryId: FIXTURE_INVENTORY,
    sourceKind: "direct" as const,
    title: "Contract fixture",
    cwdBasename: "fixture",
    projectLabel: "fixture",
    piSessionId: "pi-session-fixture-01",
    createdAt: "2026-07-18T11:00:00.000Z",
    modifiedAt: FIXTURE_TIME,
    activityAt: FIXTURE_TIME,
    messageCount: 2,
    entryCount: 4,
    toolCallCount: 1,
    currentLeafId: "entry-assistant-01",
    managed: {
      sessionId: FIXTURE_SESSION,
      name: "Contract fixture",
      generation: 3,
      revision: 7,
      residency: "resident" as const,
      state: "idle" as const,
    },
    activation: { eligible: true, modes: ["reuse" as const, "fork" as const] },
    presence,
  };
  const inventory: SessionInventoryPage = {
    sessions: [inventoryRecord],
    index: {
      formatVersion: 1,
      loadedAt: FIXTURE_TIME,
      reconciledAt: FIXTURE_TIME,
      stale: false,
      reconciling: false,
    },
  };
  const sessionInfo: SessionInfoResource = {
    ...inventoryRecord,
    cwd: "/srv/work/fixture",
    source: {
      canonicalPath: "/srv/state/session-fixture.jsonl",
      fingerprint: {
        value: fingerprint,
        sizeBytes: 4096,
        modifiedAt: FIXTURE_TIME,
        device: "fixture-device",
        inode: "fixture-inode",
      },
      aliases: [],
    },
    ownership: {
      mode: "direct",
      leaseId: "lease-fixture-01",
      sourceInventoryId: FIXTURE_INVENTORY,
    },
    diagnostics: [],
    runtime: {
      model: { provider: "fixture", id: "fixture-model", thinkingLevel: "medium" },
      controllerConnectionId: "connection-fixture-01",
      readerCount: 2,
      warmLeaseCount: 1,
      isolation: "unisolated",
    },
  };
  const transcript: TranscriptPage = {
    inventoryId: FIXTURE_INVENTORY,
    piSessionId: "pi-session-fixture-01",
    managedSession: { sessionId: FIXTURE_SESSION, generation: 3 },
    currentLeafId: "entry-assistant-01",
    sourceFingerprint: fingerprint,
    records: [
      {
        recordId: "entry:entry-user-01",
        key: { entryId: "entry-user-01", messageId: "message-user-01" },
        kind: "message",
        role: "user",
        state: "complete",
        source: "persisted",
        timestamp: "2026-07-18T11:59:58.000Z",
        content: [{ type: "text", text: "Show the contract fixture." }],
      },
      {
        recordId: "tool:tool-call-01",
        key: {
          entryId: "entry-assistant-01",
          messageId: "message-assistant-01",
          toolCallId: "tool-call-01",
        },
        kind: "tool",
        toolName: "read",
        state: "success",
        source: "persisted",
        timestamp: "2026-07-18T11:59:59.000Z",
        arguments: { path: "fixture.txt" },
        content: [{ type: "text", text: "bounded fixture output" }],
      },
      {
        recordId: "entry:entry-assistant-01",
        key: { entryId: "entry-assistant-01", messageId: "message-assistant-01" },
        kind: "message",
        role: "assistant",
        state: "complete",
        source: "persisted",
        timestamp: FIXTURE_TIME,
        content: [{ type: "markdown", text: "The fixture is ready." }],
      },
    ],
    order: "chronological",
    projection: {
      formatVersion: 1,
      cached: true,
      truncated: false,
      builtAt: FIXTURE_TIME,
    },
    hydration: "not-requested",
  };
  const activationRequest: ActivationRequest = {
    requestId: "req-activation-01",
    idempotencyKey: "activation-fixture-01",
    mode: "reuse",
    expectedFingerprint: fingerprint,
  };
  const activationTicket: ActivationTicket = {
    ticketId: "activation-fixture-01",
    requestId: activationRequest.requestId,
    idempotencyKey: activationRequest.idempotencyKey,
    inventoryId: FIXTURE_INVENTORY,
    mode: activationRequest.mode,
    state: "succeeded",
    submittedAt: FIXTURE_TIME,
    updatedAt: FIXTURE_TIME,
    managedSession: { sessionId: FIXTURE_SESSION, generation: 3 },
  };
  const activationTickets: DashboardActivationTicketFixtures = {
    reuseSucceeded: activationTicket,
    directQueued: {
      ticketId: "activation-direct-fixture-01",
      requestId: "req-activation-direct-01",
      idempotencyKey: "activation-direct-fixture-01",
      inventoryId: FIXTURE_INVENTORY,
      mode: "direct",
      state: "queued",
      submittedAt: FIXTURE_TIME,
      updatedAt: FIXTURE_TIME,
    },
    forkRunning: {
      ticketId: "activation-fork-fixture-01",
      requestId: "req-activation-fork-01",
      idempotencyKey: "activation-fork-fixture-01",
      inventoryId: FIXTURE_INVENTORY,
      mode: "fork",
      state: "running",
      submittedAt: FIXTURE_TIME,
      updatedAt: FIXTURE_TIME,
    },
  };
  const exportRequest: SessionExportRequest = {
    requestId: "req-export-01",
    idempotencyKey: "export-fixture-01",
    mode: "as-new",
    expectedSourceFingerprint: fingerprint,
    releaseAfterExport: false,
  };
  const exportTicket: SessionExportTicket = {
    ticketId: "export-fixture-01",
    requestId: exportRequest.requestId,
    idempotencyKey: exportRequest.idempotencyKey,
    sessionRef: FIXTURE_SESSION,
    mode: exportRequest.mode,
    state: "succeeded",
    submittedAt: FIXTURE_TIME,
    updatedAt: FIXTURE_TIME,
    exportedInventoryId: "inventory-exported-fixture-01",
    sourceFingerprint: fingerprint,
  };
  const exportTickets: DashboardExportTicketFixtures = {
    asNewSucceeded: exportTicket,
    appendIndeterminate: {
      ticketId: "export-append-fixture-01",
      requestId: "req-export-append-01",
      idempotencyKey: "export-append-fixture-01",
      sessionRef: FIXTURE_SESSION,
      mode: "append-to-origin",
      state: "indeterminate",
      submittedAt: FIXTURE_TIME,
      updatedAt: FIXTURE_TIME,
      sourceFingerprint: fingerprint,
    },
  };
  const presenceScenarios: DashSessionPresence[] = [
    presence,
    {
      runtime: "dormant",
      activation: "scheduled-turn",
      scheduled: { nextWakeAt: "2026-07-18T13:00:00.000Z", source: "native-schedule" },
      focusedPaneCount: 0,
      lastSettledCursor: cursor1,
      seenCursor: cursor0,
      unread: true,
    },
    {
      runtime: "dormant",
      activation: "user-turn",
      focusedPaneCount: 0,
      lastSettledCursor: cursor1,
      seenCursor: cursor0,
      unread: true,
    },
    {
      runtime: "running",
      activation: "running-at-dash-start",
      focusedPaneCount: 1,
      seenCursor: cursor0,
      unread: false,
    },
  ];
  const workspace: DashboardWorkspaceResource = {
    workspaceId: FIXTURE_WORKSPACE,
    revision: 2,
    createdAt: "2026-07-18T11:00:00.000Z",
    updatedAt: FIXTURE_TIME,
    selectedPaneId: "pane-fixture-01",
    layout: {
      type: "leaf",
      paneId: "pane-fixture-01",
      content: { type: "chat", inventoryId: FIXTURE_INVENTORY, presentation: "rich" },
    },
    seenCursors: { [FIXTURE_INVENTORY]: cursor0 },
  };
  const settings: DashboardSettingsResource = {
    revision: 4,
    effective: {
      theme: { name: "nord-midnight", density: "comfortable" },
      editor: { mode: "vim", submitKey: "enter" },
      sidebar: { initialLimit: 100, showProject: true, groupBy: "none" },
      transcript: { expandTools: false, expandThinking: false },
      motion: { reduced: false },
      cache: {
        transcriptBytes: DASH_DEFAULT_LIMITS.browserTranscriptCacheBytes,
        transcriptEntries: DASH_DEFAULT_LIMITS.browserTranscriptCacheEntries,
      },
    },
    runtimeOverlay: {},
    sources: {
      "theme.name": "config",
      "editor.mode": "runtime",
      "editor.submitKey": "default",
      "sidebar.initialLimit": "default",
    },
  };
  const snapshot = {
    identity: { hostInstanceId: FIXTURE_HOST, sessionId: FIXTURE_SESSION, generation: 3 },
    session: managedSessionFixture(),
    rpcState: { isStreaming: false },
    requestState: { queued: 0 },
    entries: transcript.records,
    currentLeafId: "entry-assistant-01",
    highWaterCursor: cursor0,
  };
  const streamSubscribe: DashStreamSubscribeFrame = {
    dashVersion: DASH_API_VERSION,
    kind: "subscribe",
    clientId: FIXTURE_CLIENT,
    workspaceId: FIXTURE_WORKSPACE,
    correlationId: "correlation-subscribe-01",
    subscriptionId: "subscription-fixture-01",
    presentation: "rich",
    inventoryId: FIXTURE_INVENTORY,
    sessionRef: FIXTURE_SESSION,
    generation: 3,
    role: "observer",
    cursor: cursor0,
  };
  const streamExtensionUiResponse: DashStreamExtensionUiResponseFrame = {
    dashVersion: DASH_API_VERSION,
    kind: "extension_ui_response",
    clientId: FIXTURE_CLIENT,
    workspaceId: FIXTURE_WORKSPACE,
    correlationId: "correlation-extension-ui-01",
    subscriptionId: streamSubscribe.subscriptionId,
    requestId: "extension-request-fixture-01",
    response: { confirmed: true },
  };
  const streamContext = {
    dashVersion: DASH_API_VERSION,
    requestId: "req-stream-01",
    serverInstanceId: FIXTURE_SERVER,
    clientId: FIXTURE_CLIENT,
    workspaceId: FIXTURE_WORKSPACE,
  } as const;
  const streamReady: DashStreamSubscriptionReadyFrame = {
    ...streamContext,
    kind: "subscription_ready",
    correlationId: streamSubscribe.correlationId,
    subscriptionId: streamSubscribe.subscriptionId,
    presentation: "rich",
    role: "observer",
    identity: snapshot.identity,
    highWaterCursor: cursor0,
    snapshot,
  };
  const streamEvent: DashStreamSessionEventFrame = {
    ...streamContext,
    kind: "session_event",
    correlationId: "correlation-event-01",
    subscriptionId: streamSubscribe.subscriptionId,
    event: {
      kind: "session_event",
      identity: snapshot.identity,
      cursor: cursor1,
      sequence: 41,
      event: { type: "agent_settled" },
    },
  };
  const streamExtensionView: DashStreamSessionEventFrame = {
    ...streamContext,
    kind: "session_event",
    correlationId: "correlation-extension-view-01",
    subscriptionId: streamSubscribe.subscriptionId,
    event: {
      kind: "extension_view",
      identity: snapshot.identity,
      requestId: "extension-view-request-fixture-01",
      provenance: {
        transport: "pi-rpc",
        validator: "pi-daemon",
        validation: "validated",
        browserCodeExecution: false,
      },
      fallback: {
        text: "Review two changed files and choose whether to continue.",
        reason: "unsupported-renderer",
      },
      view: createExtensionViewFixture(),
    },
  };
  const streamTuiDelta: DashStreamTuiDeltaFrame = {
    ...streamContext,
    kind: "tui_delta",
    correlationId: "correlation-tui-01",
    subscriptionId: "subscription-tui-fixture-01",
    delta: {
      kind: "tui_delta",
      identity: snapshot.identity,
      cursor: cursor1,
      sequence: 41,
      dimensions: { rows: 24, columns: 80 },
      changedRows: [{ row: 0, runs: [{ text: "Pi fixture", style: { bold: true } }] }],
      cursorState: { row: 1, column: 0, visible: true, shape: "block" },
      title: "Pi fixture",
    },
  };
  const streamReplayGap: DashStreamReplayGapFrame = {
    ...streamContext,
    kind: "replay_gap",
    correlationId: "correlation-gap-01",
    subscriptionId: streamSubscribe.subscriptionId,
    gap: {
      kind: "replay_gap",
      identity: snapshot.identity,
      reason: "cursor-expired",
      requestedCursor: asDashboardCursor("dash:fixture:expired"),
      highWaterCursor: cursor1,
      oldestAvailableCursor: cursor0,
      snapshotFollows: true,
    },
  };
  const freshSnapshot: DashStreamSubscriptionReadyFrame = {
    ...streamContext,
    requestId: "req-stream-recovery-01",
    kind: "subscription_ready",
    correlationId: streamReplayGap.correlationId,
    subscriptionId: streamSubscribe.subscriptionId,
    presentation: "rich",
    role: "observer",
    identity: snapshot.identity,
    highWaterCursor: cursor1,
    snapshot: { ...snapshot, highWaterCursor: cursor1 },
  };
  const secondSubscribe: DashStreamSubscribeFrame = {
    ...streamSubscribe,
    correlationId: "correlation-subscribe-02",
    subscriptionId: "subscription-fixture-02",
  };
  const secondReady: DashStreamSubscriptionReadyFrame = {
    ...streamReady,
    requestId: "req-stream-02",
    correlationId: secondSubscribe.correlationId,
    subscriptionId: secondSubscribe.subscriptionId,
  };
  const serviceCapabilities: DashboardServiceCapabilities = {
    apiVersion: DASH_API_VERSION,
    authentication: "service-bearer",
    resources: {
      inventory: true,
      transcriptPreview: true,
      activation: true,
      ownership: true,
      export: true,
      leases: true,
      treeNavigation: true,
    },
    presentations: {
      rich: { available: true },
      tui: {
        available: false,
        subprotocol: "pi-daemon-tui.v1",
        unavailableReason: "interactive-view-seam-required",
      },
    },
    extensionViews: structuredClone(EXTENSION_VIEW_CAPABILITY),
    sessionDefaults: sessionDefaultsFixture(),
    limits: { ...DASH_DEFAULT_LIMITS },
  };
  const lease: DashboardLeaseResource = {
    sessionRef: FIXTURE_SESSION,
    leaseId: "lease-fixture-01",
    expiresAt: "2026-07-18T12:01:00.000Z",
    ownership: {
      mode: "direct",
      leaseId: "lease-fixture-01",
      sourceInventoryId: FIXTURE_INVENTORY,
      exportedInventoryIds: [],
    },
  };
  const errorEnvelope: DashboardErrorEnvelope = {
    dashVersion: DASH_API_VERSION,
    requestId: "req-error-01",
    serverInstanceId: FIXTURE_SERVER,
    clientId: FIXTURE_CLIENT,
    workspaceId: FIXTURE_WORKSPACE,
    ok: false,
    error: {
      code: "controller_required",
      message: "controller role is required",
      retryable: true,
    },
  };

  return {
    capabilities,
    inventory,
    sessionInfo,
    transcript,
    activationRequest,
    activationTicket,
    activationTickets,
    exportRequest,
    exportTicket,
    exportTickets,
    presenceScenarios,
    workspace,
    settings,
    capabilitiesEnvelope: successEnvelope("req-capabilities-01", capabilities),
    inventoryEnvelope: successEnvelope("req-inventory-01", inventory),
    transcriptEnvelope: successEnvelope("req-transcript-01", transcript),
    errorEnvelope,
    streamSubscribe,
    streamExtensionUiResponse,
    streamReady,
    streamEvent,
    streamExtensionView,
    streamTuiDelta,
    streamReplayGap,
    replayRecovery: { gap: streamReplayGap, freshSnapshot },
    multiplex: {
      subscriptions: [streamSubscribe, secondSubscribe],
      ready: [streamReady, secondReady],
    },
    serviceCapabilities,
    lease,
    serviceCapabilitiesEnvelope: serviceEnvelope(
      "req-service-capabilities-01",
      serviceCapabilities,
    ),
    serviceInventoryEnvelope: serviceEnvelope("req-service-inventory-01", inventory),
    serviceInfoEnvelope: serviceEnvelope("req-service-info-01", sessionInfo),
    serviceTranscriptEnvelope: serviceEnvelope("req-service-transcript-01", transcript),
    serviceActivationEnvelope: serviceEnvelope("req-service-activation-01", activationTicket),
    serviceExportEnvelope: serviceEnvelope("req-service-export-01", exportTicket),
    serviceLeaseEnvelope: serviceEnvelope("req-service-lease-01", lease),
  };
}
