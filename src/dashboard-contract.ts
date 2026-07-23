import type {
  DashboardSessionDraftCancelRequest,
  DashboardSessionDraftCreateRequest,
  DashboardSessionDraftResource,
  DashboardSessionDraftSendRequest,
  DashboardSessionDraftSendTicket,
  DashboardSessionDraftSpec,
} from "./dashboard-session-drafts.js";
import type {
  ApiErrorBody,
  JsonObject,
  JsonValue,
  PiRpcEvent,
  SessionResource,
} from "./session-api.js";
import type {
  ScheduleCapabilities,
  ScheduleExecutionOverride,
  ScheduleMissedWakePolicy,
  ScheduleOverlapPolicy,
  ScheduleResource,
} from "./schedule-contract.js";
import type {
  ExtensionViewCapability,
  ExtensionViewDocument,
} from "./extension-view-contract.js";

export const DASH_API_VERSION = "1.0" as const;
export const DASH_API_MAJOR = 1;
export const DASH_API_BASE_PATH = "/dash/v1" as const;
export const DASH_STREAM_SUBPROTOCOL = "pi-daemon-dash.v1" as const;

export const DASH_API_PATHS = {
  login: "/dash/v1/login",
  logout: "/dash/v1/logout",
  bootstrap: "/dash/v1/bootstrap",
  sessions: "/dash/v1/sessions",
  session: "/dash/v1/sessions/{inventoryId}",
  transcript: "/dash/v1/sessions/{inventoryId}/transcript",
  activate: "/dash/v1/sessions/{inventoryId}/activate",
  sessionDrafts: "/dash/v1/session-drafts",
  sessionDraft: "/dash/v1/session-drafts/{draftId}",
  sessionDraftSend: "/dash/v1/session-drafts/{draftId}/send",
  sessionDraftSendTicket: "/dash/v1/session-draft-send/{ticketId}",
  activation: "/dash/v1/activation/{ticketId}",
  export: "/dash/v1/sessions/{sessionRef}/export",
  exportTicket: "/dash/v1/export/{ticketId}",
  workspaces: "/dash/v1/workspaces",
  workspace: "/dash/v1/workspaces/{workspaceId}",
  workspaceSelect: "/dash/v1/workspaces/select",
  authorization: "/dash/v1/authorization/{kind}/{resourceId}",
  authorizationGrant: "/dash/v1/authorization/{kind}/{resourceId}/grants/{identityId}",
  authorizationTransfer: "/dash/v1/authorization/{kind}/{resourceId}/transfer",
  authorizationAudit: "/dash/v1/authorization/{kind}/{resourceId}/audit",
  authorizationController: "/dash/v1/authorization/{kind}/{resourceId}/controller",
  settings: "/dash/v1/settings",
  schedules: "/dash/v1/schedules",
  schedule: "/dash/v1/schedules/{scheduleId}",
  scheduleStatus: "/dash/v1/schedules/status",
  scheduleCapabilities: "/dash/v1/schedules/capabilities",
  stream: "/dash/v1/stream",
} as const;

export interface DashboardPerformanceBudgets {
  benchmarkSessionCount: number;
  persistedIndexBootstrapP95Ms: number;
  firstSidebarRowsP95Ms: number;
  serverSearchPageP95Ms: number;
  cachedTranscriptViewportP95Ms: number;
  coldTranscriptViewportP95Ms: number;
  streamDeltaP95Ms: number;
  tuiDeltaP95Ms: number;
  frameWorkP95Ms: number;
  initialSpaGzipBytes: number;
}

/** Normative local acceptance budgets; implementations report measurements separately. */
export const DASH_PERFORMANCE_BUDGETS = {
  benchmarkSessionCount: 10_000,
  persistedIndexBootstrapP95Ms: 50,
  firstSidebarRowsP95Ms: 150,
  serverSearchPageP95Ms: 100,
  cachedTranscriptViewportP95Ms: 150,
  coldTranscriptViewportP95Ms: 500,
  streamDeltaP95Ms: 50,
  tuiDeltaP95Ms: 50,
  frameWorkP95Ms: 16,
  initialSpaGzipBytes: 1_572_864,
} as const satisfies DashboardPerformanceBudgets;

export interface DashboardLimits {
  maxHttpBodyBytes: number;
  maxWebSocketFrameBytes: number;
  maxOutboundBytesPerConnection: number;
  maxConnections: number;
  maxSubscriptionsPerConnection: number;
  maxInFlightCommandsPerConnection: number;
  maxInventoryPageItems: number;
  maxInventoryRoots: number;
  maxIndexedSessions: number;
  maxInventoryIndexBytes: number;
  maxInventoryRecordBytes: number;
  inventoryIndexMaxAgeMs: number;
  inventoryReconcileIntervalMs: number;
  maxSearchQueryChars: number;
  maxTranscriptPageRecords: number;
  maxTranscriptRecordBytes: number;
  maxTreeNodes: number;
  maxTreeDepth: number;
  maxTreeTextBytes: number;
  maxTreeSnippetBytes: number;
  maxProjectionSourceBytes: number;
  maxProjectionLineBytes: number;
  maxProjectionEntries: number;
  maxProjectionOutputBytes: number;
  maxProjectionCacheEntries: number;
  maxProjectionCacheBytes: number;
  maxProjectionCacheEntryBytes: number;
  projectionCacheMaxAgeMs: number;
  maxImagePreviewBytes: number;
  maxBlobResponseBytes: number;
  maxReplayEvents: number;
  maxReplayEventBytes: number;
  maxReplayBytesPerSession: number;
  replayRetentionMs: number;
  maxWorkspaces: number;
  maxWorkspaceBytes: number;
  maxWorkspacePanes: number;
  maxLayoutDepth: number;
  maxPinnedSessionsPerWorkspace: number;
  maxTuiRows: number;
  maxTuiColumns: number;
  maxTuiDeltaRows: number;
  maxTuiDeltaBytes: number;
  maxSettingsBytes: number;
  visibleLeaseHeartbeatMs: number;
  visibleLeaseExpiryMs: number;
  browserTranscriptCacheBytes: number;
  browserTranscriptCacheEntries: number;
  browserTranscriptCacheEntryBytes: number;
  browserTranscriptCacheMaxAgeMs: number;
  browserSessionTtlMs: number;
}

/** Safe initial limits. Servers negotiate the effective values in capabilities. */
export const DASH_DEFAULT_LIMITS = {
  maxHttpBodyBytes: 1_048_576,
  maxWebSocketFrameBytes: 1_048_576,
  maxOutboundBytesPerConnection: 4_194_304,
  maxConnections: 64,
  maxSubscriptionsPerConnection: 32,
  maxInFlightCommandsPerConnection: 8,
  maxInventoryPageItems: 100,
  maxInventoryRoots: 32,
  maxIndexedSessions: 10_000,
  maxInventoryIndexBytes: 67_108_864,
  maxInventoryRecordBytes: 16_384,
  inventoryIndexMaxAgeMs: 60_000,
  inventoryReconcileIntervalMs: 30_000,
  maxSearchQueryChars: 1_024,
  maxTranscriptPageRecords: 200,
  maxTranscriptRecordBytes: 524_288,
  maxTreeNodes: 10_000,
  maxTreeDepth: 256,
  maxTreeTextBytes: 2_097_152,
  maxTreeSnippetBytes: 512,
  maxProjectionSourceBytes: 268_435_456,
  maxProjectionLineBytes: 1_048_576,
  maxProjectionEntries: 100_000,
  maxProjectionOutputBytes: 67_108_864,
  maxProjectionCacheEntries: 1_024,
  maxProjectionCacheBytes: 268_435_456,
  maxProjectionCacheEntryBytes: 67_108_864,
  projectionCacheMaxAgeMs: 604_800_000,
  maxImagePreviewBytes: 262_144,
  maxBlobResponseBytes: 8_388_608,
  maxReplayEvents: 512,
  maxReplayEventBytes: 524_288,
  maxReplayBytesPerSession: 2_097_152,
  replayRetentionMs: 300_000,
  maxWorkspaces: 64,
  maxWorkspaceBytes: 1_048_576,
  maxWorkspacePanes: 32,
  maxLayoutDepth: 16,
  maxPinnedSessionsPerWorkspace: 8,
  maxTuiRows: 200,
  maxTuiColumns: 320,
  maxTuiDeltaRows: 200,
  maxTuiDeltaBytes: 524_288,
  maxSettingsBytes: 262_144,
  visibleLeaseHeartbeatMs: 20_000,
  visibleLeaseExpiryMs: 60_000,
  browserTranscriptCacheBytes: 67_108_864,
  browserTranscriptCacheEntries: 64,
  browserTranscriptCacheEntryBytes: 8_388_608,
  browserTranscriptCacheMaxAgeMs: 86_400_000,
  browserSessionTtlMs: 43_200_000,
} as const satisfies DashboardLimits;

const dashboardCursorBrand: unique symbol = Symbol("DashboardCursor");
const dashboardFingerprintBrand: unique symbol = Symbol("DashboardFingerprint");

/** Opaque server cursor. Clients compare or return it; they never parse it. */
export type DashboardCursor = string & { readonly [dashboardCursorBrand]: true };
/** Opaque source fingerprint. Clients return it only as an optimistic precondition. */
export type DashboardFingerprint = string & { readonly [dashboardFingerprintBrand]: true };

export function asDashboardCursor(value: string): DashboardCursor {
  if (value.length < 1 || value.length > 1024) {
    throw new RangeError("dashboard cursor length must be between 1 and 1024");
  }
  return value as DashboardCursor;
}

export function asDashboardFingerprint(value: string): DashboardFingerprint {
  if (value.length < 1 || value.length > 512) {
    throw new RangeError("dashboard fingerprint length must be between 1 and 512");
  }
  return value as DashboardFingerprint;
}

export type DashboardPresentation = "rich" | "tui";
export type DashboardControllerRole = "observer" | "controller";
export type DashboardSourceKind =
  | "managed"
  | "external"
  | "direct"
  | "imported"
  | "exported"
  | "memory";

export type DashboardCommandOperation =
  | "get_state"
  | "get_entries"
  | "get_session_stats"
  | "get_commands"
  | "get_available_models"
  | "prompt"
  | "steer"
  | "follow_up"
  | "abort"
  | "set_model"
  | "set_thinking_level"
  | "set_steering_mode"
  | "set_follow_up_mode"
  | "compact"
  | "set_auto_compaction"
  | "set_auto_retry"
  | "abort_retry"
  | "set_session_name"
  | "get_tree"
  | "navigate_tree"
  | "fork"
  | "clone";

export interface DashboardPresentationCapability {
  available: boolean;
  replay: boolean;
  controller: boolean;
  commands: DashboardCommandOperation[];
  unavailableReason?: string;
}

export interface DashboardSessionDefaultsResource {
  spec: DashboardSessionDraftSpec;
  sources: {
    cwd: "configured";
    model: "pi-settings" | "runtime-policy" | "none";
    authority: "runtime-policy" | "restricted";
  };
}

export interface DashboardServiceCapabilities {
  apiVersion: typeof DASH_API_VERSION;
  authentication: "service-bearer";
  resources: {
    inventory: true;
    transcriptPreview: true;
    activation: true;
    ownership: true;
    export: true;
    leases: true;
    /** Absent on older compatible daemons. */
    schedules?: true;
    /** Absent on older compatible daemons. */
    sessionDrafts?: true;
    /** Absent on older compatible daemons that lack framed in-place navigation. */
    treeNavigation?: true;
  };
  presentations: {
    rich: { available: true };
    tui: {
      available: boolean;
      subprotocol: "pi-daemon-tui.v1";
      unavailableReason?: string;
    };
  };
  /** Additive renderer negotiation; absent services never emit extension_view. */
  extensionViews?: ExtensionViewCapability;
  /** Browser-safe effective lazy-session defaults; source paths never leave the service. */
  sessionDefaults?: DashboardSessionDefaultsResource;
  limits: DashboardLimits;
}

export interface DashboardLeaseRequest {
  requestId: string;
  leaseId: string;
}

export interface DashboardLeaseResource {
  sessionRef: string;
  leaseId: string;
  expiresAt?: string;
  ownership: SessionOwnershipInfo;
}

export interface DashboardCapabilities {
  apiVersion: typeof DASH_API_VERSION;
  streamSubprotocol: typeof DASH_STREAM_SUBPROTOCOL;
  sameBrowserProtocolAcrossDeployments: true;
  authentication: {
    browserSession: "http-only-cookie";
    csrf: "same-origin-header";
    daemonBearerExposed: false;
  };
  resources: {
    inventory: true;
    transcriptPreview: true;
    activation: true;
    export: boolean;
    workspaces: true;
    settings: true;
    schedules: boolean;
    sessionDrafts: boolean;
    treeNavigation: boolean;
  };
  presentations: {
    rich: DashboardPresentationCapability;
    tui: DashboardPresentationCapability;
  };
  /** Additive renderer negotiation; absent daemons never emit extension_view. */
  extensionViews?: ExtensionViewCapability;
  /** Browser-safe effective lazy-session defaults; source paths never leave the BFF. */
  sessionDefaults?: DashboardSessionDefaultsResource;
  limits: DashboardLimits;
  performanceBudgets: DashboardPerformanceBudgets;
}

/** Schedule metadata safe to return to browser JavaScript. Prompt content is input-only. */
export type DashboardScheduleResource = Omit<ScheduleResource, "prompt"> & {
  promptConfigured: true;
};

export interface DashboardScheduleWrite {
  scheduleId: string;
  sessionRef: string;
  enabled: boolean;
  cron: string;
  timezone: string;
  /** Required on create; omitted on update to retain the existing private prompt. */
  prompt?: string;
  execution?: ScheduleExecutionOverride;
  overlapPolicy: ScheduleOverlapPolicy;
  missedWakePolicy: ScheduleMissedWakePolicy;
  jitterMs: number;
  maxAdmissionDelayMs: number;
}

export interface DashboardScheduleMutationRequest {
  requestId: string;
  idempotencyKey: string;
  expectedRevision?: number;
  schedule: DashboardScheduleWrite;
}

export interface DashboardScheduleDeleteRequest {
  requestId: string;
  idempotencyKey: string;
  expectedRevision: number;
}

export interface DashboardScheduleStatus {
  timerRuntime: boolean;
  externalTimersSupported: boolean;
  scheduleCount: number;
  enabledCount: number;
  nextWakeAt?: string;
}

export interface DashboardSchedulePresence {
  nextWakeAt: string;
  source: string;
}

/** Orthogonal liveness, provenance, focus, and unread facts. */
export interface DashSessionPresence {
  runtime: "unmanaged" | "dormant" | "resident-idle" | "running" | "failed";
  activation:
    | "untouched"
    | "selected"
    | "user-turn"
    | "external-turn"
    | "scheduled-turn"
    | "running-at-dash-start";
  scheduled?: DashboardSchedulePresence;
  focusedPaneCount: number;
  lastSettledCursor?: DashboardCursor;
  seenCursor?: DashboardCursor;
  unread: boolean;
}

export interface ManagedSessionSummary {
  sessionId: string;
  name?: string;
  generation: number;
  revision: number;
  residency: "resident" | "dormant";
  state: "opening" | "idle" | "running" | "failed" | "closing";
}

export interface SessionInventoryActivation {
  eligible: boolean;
  modes: ActivationMode[];
  reasonCode?: string;
}

export interface SessionInventoryRecord {
  inventoryId: string;
  sourceKind: DashboardSourceKind;
  title: string;
  cwdBasename?: string;
  projectLabel?: string;
  piSessionId?: string;
  parentPiSessionId?: string;
  createdAt: string;
  /** Source/catalog modification truth; activation must not rewrite it. */
  modifiedAt: string;
  /** User-visible recency used for default ordering; defaults to modifiedAt on older indexes. */
  activityAt?: string;
  messageCount: number;
  entryCount?: number;
  toolCallCount?: number;
  currentLeafId?: string;
  managed?: ManagedSessionSummary;
  activation: SessionInventoryActivation;
  presence: DashSessionPresence;
}

export interface SessionInventoryQuery {
  cursor?: DashboardCursor;
  limit?: number;
  search?: string;
  sourceKinds?: DashboardSourceKind[];
  runtime?: DashSessionPresence["runtime"][];
  unread?: boolean;
  modifiedAfter?: string;
}

export interface SessionInventoryPage {
  sessions: SessionInventoryRecord[];
  nextCursor?: DashboardCursor;
  index: {
    formatVersion: 1;
    loadedAt: string;
    reconciledAt?: string;
    stale: boolean;
    reconciling: boolean;
  };
}

export interface SessionSourceFingerprint {
  value: DashboardFingerprint;
  sizeBytes: number;
  modifiedAt: string;
  device?: string;
  inode?: string;
}

export interface SessionOwnershipInfo {
  mode: "none" | "direct" | "imported" | "exported";
  leaseId?: string;
  sourceInventoryId?: string;
  exportedInventoryIds?: string[];
  conflict?: { code: string; detectedAt: string };
}

export interface SessionInfoResource extends SessionInventoryRecord {
  cwd: string;
  source: {
    canonicalPath?: string;
    fingerprint?: SessionSourceFingerprint;
    aliases: Array<{ inventoryId: string; canonicalPath?: string }>;
  };
  ownership: SessionOwnershipInfo;
  diagnostics: Array<{ code: string; message: string; retryable: boolean }>;
  runtime?: {
    model?: { provider?: string; id?: string; thinkingLevel?: string };
    controllerConnectionId?: string;
    readerCount: number;
    warmLeaseCount: number;
    isolation?: "unisolated";
  };
}

export type TranscriptRecordKey =
  | { entryId: string; messageId?: string; toolCallId?: string }
  | { entryId?: string; messageId: string; toolCallId?: string }
  | { entryId?: string; messageId?: string; toolCallId: string };

export interface TranscriptTextBlock {
  type: "text" | "markdown" | "thinking" | "error";
  text: string;
}

export interface TranscriptImageBlock {
  type: "image";
  mediaType: string;
  blobRef: string;
  alt?: string;
  width?: number;
  height?: number;
}

export interface TranscriptUsageBlock {
  type: "usage";
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  cost?: number;
}

export type TranscriptContentBlock =
  | TranscriptTextBlock
  | TranscriptImageBlock
  | TranscriptUsageBlock;

interface NormalizedTranscriptRecordBase {
  /** Stable projection key. Never derived from array position or rendered text. */
  recordId: string;
  key: TranscriptRecordKey;
  timestamp?: string;
  parentEntryId?: string;
  source: "persisted" | "live" | "optimistic";
}

export interface TranscriptMessageRecord extends NormalizedTranscriptRecordBase {
  kind: "message";
  role: "user" | "assistant" | "system" | "custom";
  state: "complete" | "streaming" | "error";
  content: TranscriptContentBlock[];
}

export interface TranscriptToolRecord extends NormalizedTranscriptRecordBase {
  kind: "tool";
  key: TranscriptRecordKey & { toolCallId: string };
  toolName: string;
  state: "pending" | "running" | "success" | "error";
  arguments?: JsonObject;
  content: TranscriptContentBlock[];
  details?: JsonValue;
}

export interface TranscriptSummaryRecord extends NormalizedTranscriptRecordBase {
  kind: "summary";
  summaryKind: "compaction" | "branch";
  content: TranscriptContentBlock[];
}

export interface TranscriptTimelineRecord extends NormalizedTranscriptRecordBase {
  kind: "timeline";
  event:
    | "model"
    | "thinking"
    | "label"
    | "session-name"
    | "queue"
    | "retry"
    | "compaction"
    | "permission"
    | "extension-ui"
    | "bash";
  label?: string;
  data?: JsonObject;
}

export interface TranscriptCustomRecord extends NormalizedTranscriptRecordBase {
  kind: "custom";
  customType: string;
  hidden: boolean;
  data?: JsonValue;
  fallbackText?: string;
}

export type NormalizedTranscriptRecord =
  | TranscriptMessageRecord
  | TranscriptToolRecord
  | TranscriptSummaryRecord
  | TranscriptTimelineRecord
  | TranscriptCustomRecord;

export interface TranscriptQuery {
  cursor?: DashboardCursor;
  limit?: number;
  direction?: "older" | "newer";
  leafId?: string;
}

export interface TranscriptPage {
  inventoryId: string;
  piSessionId?: string;
  managedSession?: { sessionId: string; generation: number };
  currentLeafId?: string;
  sourceFingerprint?: DashboardFingerprint;
  records: NormalizedTranscriptRecord[];
  order: "chronological";
  olderCursor?: DashboardCursor;
  newerCursor?: DashboardCursor;
  projection: {
    formatVersion: 1;
    cached: boolean;
    truncated: boolean;
    builtAt: string;
  };
  /** Preview is deliberately independent of SDK/runtime hydration. */
  hydration: "not-requested";
}

export type ActivationMode = "reuse" | "direct" | "fork" | "preview-only";
export const DASH_DIRECT_COOPT_POLICY_REF = "direct-co-opt-confirmed-v1" as const;
export type DashboardTicketState =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "indeterminate";

export interface ActivationRequest {
  requestId: string;
  idempotencyKey: string;
  mode: ActivationMode;
  expectedFingerprint?: DashboardFingerprint;
  desiredSessionName?: string;
  policyRef?: string;
}

export interface ActivationTicket {
  ticketId: string;
  requestId: string;
  idempotencyKey: string;
  inventoryId: string;
  mode: ActivationMode;
  state: DashboardTicketState;
  submittedAt: string;
  updatedAt: string;
  managedSession?: { sessionId: string; generation: number };
  error?: ApiErrorBody;
}

export type SessionExportMode = "as-new" | "append-to-origin";

export interface SessionExportRequest {
  requestId: string;
  idempotencyKey: string;
  mode: SessionExportMode;
  expectedSourceFingerprint?: DashboardFingerprint;
  releaseAfterExport?: boolean;
}

export interface SessionExportTicket {
  ticketId: string;
  requestId: string;
  idempotencyKey: string;
  sessionRef: string;
  mode: SessionExportMode;
  state: DashboardTicketState;
  submittedAt: string;
  updatedAt: string;
  exportedInventoryId?: string;
  sourceFingerprint?: DashboardFingerprint;
  error?: ApiErrorBody;
}

export type PaneTarget =
  | { type: "empty" }
  | { type: "chat"; inventoryId: string; presentation: DashboardPresentation }
  | { type: "info"; inventoryId: string };

export type DashboardLayoutNode =
  | { type: "leaf"; paneId: string; content?: PaneTarget }
  | {
      type: "split";
      direction: "horizontal" | "vertical";
      ratio: number;
      first: DashboardLayoutNode;
      second: DashboardLayoutNode;
    };

export interface DashboardWorkspaceResource {
  workspaceId: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  selectedPaneId: string;
  layout: DashboardLayoutNode;
  seenCursors: Record<string, DashboardCursor>;
}

export interface DashboardWorkspaceUpdateRequest {
  requestId: string;
  idempotencyKey: string;
  expectedRevision: number;
  selectedPaneId: string;
  layout: DashboardLayoutNode;
  seenCursors: Record<string, DashboardCursor>;
}

export interface DashboardUiSettings {
  theme: { name: string; density: "compact" | "comfortable" };
  editor: {
    mode: "multiline" | "vim";
    /** enter: Enter sends and Shift-Enter newlines; mod-enter preserves multiline Enter. */
    submitKey: "enter" | "mod-enter";
  };
  sidebar: { initialLimit: number; showProject: boolean; groupBy: "none" | "source" | "age" };
  transcript: { expandTools: boolean; expandThinking: boolean };
  motion: { reduced: boolean };
  cache: { transcriptBytes: number; transcriptEntries: number };
}

export interface DashboardUiSettingsPatch {
  theme?: Partial<DashboardUiSettings["theme"]>;
  editor?: Partial<DashboardUiSettings["editor"]>;
  sidebar?: Partial<DashboardUiSettings["sidebar"]>;
  transcript?: Partial<DashboardUiSettings["transcript"]>;
  motion?: Partial<DashboardUiSettings["motion"]>;
  cache?: Partial<DashboardUiSettings["cache"]>;
}

export interface DashboardSettingsResource {
  revision: number;
  effective: DashboardUiSettings;
  runtimeOverlay: DashboardUiSettingsPatch;
  sources: Record<string, "default" | "config" | "runtime">;
}

export interface DashboardSettingsPatchRequest {
  requestId: string;
  idempotencyKey: string;
  expectedRevision: number;
  patch: DashboardUiSettingsPatch;
}

export interface DashboardBootstrapResource {
  capabilities: DashboardCapabilities;
  settings: DashboardSettingsResource;
  workspace: DashboardWorkspaceResource;
  inventory: SessionInventoryPage;
}

/** Input-only web login credential; never include it in responses, logs, or durable state. */
export interface DashboardLoginRequest {
  requestId: string;
  clientId: string;
  workspaceId?: string;
  credential: string;
}

export interface DashboardBrowserSessionResource {
  clientId: string;
  workspaceId: string;
  expiresAt: string;
  csrfToken: string;
}

export interface DashboardSessionIdentity {
  hostInstanceId: string;
  sessionId: string;
  generation: number;
}

export interface DashboardChannelSnapshot {
  identity: DashboardSessionIdentity;
  session: SessionResource;
  rpcState: JsonObject;
  requestState: JsonObject;
  entries: NormalizedTranscriptRecord[];
  currentLeafId?: string | null;
  highWaterCursor: DashboardCursor;
}

export interface DashboardCommand {
  correlationId: string;
  idempotencyKey?: string;
  identity: DashboardSessionIdentity;
  operation: DashboardCommandOperation;
  payload?: JsonObject;
}

export interface DashboardCommandResult {
  correlationId: string;
  state: "completed" | "streaming" | "rejected" | "indeterminate";
  data?: JsonValue;
  error?: ApiErrorBody;
}

export interface DashboardSessionEvent {
  kind: "session_event";
  identity: DashboardSessionIdentity;
  cursor: DashboardCursor;
  sequence: number;
  event: PiRpcEvent;
}

export interface DashboardControlEvent {
  kind: "control";
  identity: DashboardSessionIdentity;
  action: "control_granted" | "control_denied" | "control_released";
  connectionId?: string;
  reason?: string;
}

export interface DashboardReplayGap {
  kind: "replay_gap";
  identity: DashboardSessionIdentity;
  reason: "cursor-expired" | "host-restarted" | "generation-changed";
  requestedCursor: DashboardCursor;
  highWaterCursor: DashboardCursor;
  oldestAvailableCursor?: DashboardCursor;
  snapshotFollows: true;
}

export interface DashboardExtensionUiEvent {
  kind: "extension_ui";
  identity: DashboardSessionIdentity;
  requestId: string;
  method: string;
  payload: JsonObject;
}

export interface DashboardExtensionViewEvent {
  kind: "extension_view";
  identity: DashboardSessionIdentity;
  requestId: string;
  provenance: {
    transport: "pi-rpc";
    validator: "pi-daemon";
    validation: "validated" | "rejected";
    browserCodeExecution: false;
  };
  fallback: {
    text: string;
    reason: "unsupported-renderer" | "invalid-view" | "unsupported-version" | "view-capacity";
  };
  /** Omitted when validation fails; browser renderers show only fallback text. */
  view?: ExtensionViewDocument;
}

export type DashboardChannelEvent =
  | DashboardSessionEvent
  | DashboardControlEvent
  | DashboardReplayGap
  | DashboardExtensionUiEvent
  | DashboardExtensionViewEvent;

export type DashboardChannelListener<T> = (event: T) => void;
export type DashboardUnsubscribe = () => void;

export interface SessionChannelOptions {
  sessionRef: string;
  generation?: number;
  role: DashboardControllerRole;
  cursor?: DashboardCursor;
}

export interface DashboardChannel {
  readonly presentation: "rich";
  readonly identity: DashboardSessionIdentity;
  readonly role: DashboardControllerRole;
  readonly snapshot: DashboardChannelSnapshot;
  command(command: DashboardCommand): Promise<DashboardCommandResult>;
  requestControl(correlationId: string): Promise<DashboardCommandResult>;
  releaseControl(correlationId: string): Promise<DashboardCommandResult>;
  answerExtensionUi(requestId: string, response: JsonObject): Promise<void>;
  subscribe(listener: DashboardChannelListener<DashboardChannelEvent>): DashboardUnsubscribe;
  close(): Promise<void>;
}

export interface TuiDimensions {
  rows: number;
  columns: number;
}

export interface TuiStyle {
  foreground?: string;
  background?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  inverse?: boolean;
}

export interface TuiStyledRun {
  text: string;
  style?: TuiStyle;
}

export interface TuiRow {
  row: number;
  runs: TuiStyledRun[];
}

export interface TuiCursorState {
  row: number;
  column: number;
  visible: boolean;
  shape?: "block" | "bar" | "underline";
}

export interface DashboardTuiSnapshot {
  identity: DashboardSessionIdentity;
  dimensions: TuiDimensions;
  rows: TuiRow[];
  cursor: TuiCursorState;
  title?: string;
  highWaterCursor: DashboardCursor;
}

export interface DashboardTuiDelta {
  kind: "tui_delta";
  identity: DashboardSessionIdentity;
  cursor: DashboardCursor;
  sequence: number;
  dimensions: TuiDimensions;
  changedRows: TuiRow[];
  cursorState: TuiCursorState;
  title?: string;
}

export type DashboardTuiInput =
  | { type: "key"; key: string; modifiers?: Array<"ctrl" | "alt" | "shift" | "meta"> }
  | { type: "text"; text: string }
  | { type: "paste"; text: string };

export type DashboardTuiChannelEvent = DashboardTuiDelta | DashboardControlEvent | DashboardReplayGap;

export interface TuiChannelOptions extends SessionChannelOptions {
  dimensions: TuiDimensions;
}

export interface DashboardTuiChannel {
  readonly presentation: "tui";
  readonly identity: DashboardSessionIdentity;
  readonly role: DashboardControllerRole;
  readonly snapshot: DashboardTuiSnapshot;
  resize(dimensions: TuiDimensions): Promise<void>;
  sendInput(input: DashboardTuiInput): Promise<void>;
  requestControl(correlationId: string): Promise<DashboardCommandResult>;
  releaseControl(correlationId: string): Promise<DashboardCommandResult>;
  subscribe(listener: DashboardChannelListener<DashboardTuiChannelEvent>): DashboardUnsubscribe;
  close(): Promise<void>;
}

/** Embedded and dedicated adapters implement this exact behaviorally-complete seam. */
export interface DashboardBackend {
  capabilities(): Promise<DashboardCapabilities>;
  listSessions(query: SessionInventoryQuery): Promise<SessionInventoryPage>;
  getSessionInfo(inventoryId: string): Promise<SessionInfoResource>;
  getTranscript(inventoryId: string, query: TranscriptQuery): Promise<TranscriptPage>;
  activateSession(inventoryId: string, request: ActivationRequest): Promise<ActivationTicket>;
  getActivation(ticketId: string): Promise<ActivationTicket>;
  exportSession(sessionRef: string, request: SessionExportRequest): Promise<SessionExportTicket>;
  getExport(ticketId: string): Promise<SessionExportTicket>;
  createSessionDraft(request: DashboardSessionDraftCreateRequest): Promise<DashboardSessionDraftResource>;
  getSessionDraft(draftId: string): Promise<DashboardSessionDraftResource>;
  cancelSessionDraft(draftId: string, request: DashboardSessionDraftCancelRequest): Promise<DashboardSessionDraftResource>;
  sendSessionDraft(draftId: string, request: DashboardSessionDraftSendRequest): Promise<DashboardSessionDraftSendTicket>;
  getSessionDraftSend(ticketId: string): Promise<DashboardSessionDraftSendTicket>;
  scheduleCapabilities(): Promise<ScheduleCapabilities>;
  listSchedules(sessionRef?: string): Promise<DashboardScheduleResource[]>;
  getSchedule(scheduleId: string): Promise<DashboardScheduleResource>;
  createSchedule(request: DashboardScheduleMutationRequest): Promise<DashboardScheduleResource>;
  updateSchedule(scheduleId: string, request: DashboardScheduleMutationRequest): Promise<DashboardScheduleResource>;
  deleteSchedule(scheduleId: string, request: DashboardScheduleDeleteRequest): Promise<void>;
  scheduleStatus(): Promise<DashboardScheduleStatus>;
  getManagedSession(sessionRef: string): Promise<SessionResource>;
  openSessionChannel(options: SessionChannelOptions): Promise<DashboardChannel>;
  openTuiChannel(options: TuiChannelOptions): Promise<DashboardTuiChannel>;
}

export interface DashboardEnvelopeContext {
  requestId: string;
  serverInstanceId: string;
  clientId: string;
  workspaceId: string;
}

export interface DashboardSuccessEnvelope<T> extends DashboardEnvelopeContext {
  dashVersion: typeof DASH_API_VERSION;
  ok: true;
  data: T;
}

export interface DashboardErrorEnvelope extends DashboardEnvelopeContext {
  dashVersion: typeof DASH_API_VERSION;
  ok: false;
  error: ApiErrorBody;
}

interface DashStreamClientFrameBase {
  dashVersion: typeof DASH_API_VERSION;
  kind: string;
  clientId: string;
  workspaceId: string;
  correlationId: string;
}

export interface DashStreamHelloFrame extends DashStreamClientFrameBase {
  kind: "hello";
  requestedVersion: string;
}

export interface DashStreamSubscribeFrame extends DashStreamClientFrameBase {
  kind: "subscribe";
  subscriptionId: string;
  presentation: DashboardPresentation;
  inventoryId?: string;
  sessionRef?: string;
  generation?: number;
  role: DashboardControllerRole;
  cursor?: DashboardCursor;
  tuiDimensions?: TuiDimensions;
}

export interface DashStreamUnsubscribeFrame extends DashStreamClientFrameBase {
  kind: "unsubscribe";
  subscriptionId: string;
}

export interface DashStreamCommandFrame extends DashStreamClientFrameBase {
  kind: "command";
  subscriptionId: string;
  idempotencyKey?: string;
  operation: DashboardCommandOperation;
  payload?: JsonObject;
}

export interface DashStreamControlFrame extends DashStreamClientFrameBase {
  kind: "control";
  subscriptionId: string;
  action: "request" | "release";
}

export interface DashStreamExtensionUiResponseFrame extends DashStreamClientFrameBase {
  kind: "extension_ui_response";
  subscriptionId: string;
  requestId: string;
  response: JsonObject;
}

export interface DashStreamTuiResizeFrame extends DashStreamClientFrameBase {
  kind: "tui_resize";
  subscriptionId: string;
  dimensions: TuiDimensions;
}

export interface DashStreamTuiInputFrame extends DashStreamClientFrameBase {
  kind: "tui_input";
  subscriptionId: string;
  input: DashboardTuiInput;
}

export interface DashStreamSeenFrame extends DashStreamClientFrameBase {
  kind: "seen";
  inventoryId: string;
  cursor: DashboardCursor;
}

export type DashStreamClientFrame =
  | DashStreamHelloFrame
  | DashStreamSubscribeFrame
  | DashStreamUnsubscribeFrame
  | DashStreamCommandFrame
  | DashStreamControlFrame
  | DashStreamExtensionUiResponseFrame
  | DashStreamTuiResizeFrame
  | DashStreamTuiInputFrame
  | DashStreamSeenFrame;

interface DashStreamServerFrameBase extends DashboardEnvelopeContext {
  dashVersion: typeof DASH_API_VERSION;
  kind: string;
  correlationId: string;
}

export interface DashStreamReadyFrame extends DashStreamServerFrameBase {
  kind: "ready";
  capabilities: DashboardCapabilities;
}

export interface DashStreamSubscriptionReadyFrame extends DashStreamServerFrameBase {
  kind: "subscription_ready";
  subscriptionId: string;
  presentation: DashboardPresentation;
  role: DashboardControllerRole;
  identity: DashboardSessionIdentity;
  highWaterCursor: DashboardCursor;
  snapshot: DashboardChannelSnapshot | DashboardTuiSnapshot;
}

export interface DashStreamCommandResultFrame extends DashStreamServerFrameBase {
  kind: "command_result";
  subscriptionId: string;
  result: DashboardCommandResult;
}

export interface DashStreamSessionEventFrame extends DashStreamServerFrameBase {
  kind: "session_event";
  subscriptionId: string;
  event:
    | DashboardSessionEvent
    | DashboardControlEvent
    | DashboardExtensionUiEvent
    | DashboardExtensionViewEvent;
}

export interface DashStreamTuiDeltaFrame extends DashStreamServerFrameBase {
  kind: "tui_delta";
  subscriptionId: string;
  delta: DashboardTuiDelta;
}

export interface DashStreamReplayGapFrame extends DashStreamServerFrameBase {
  kind: "replay_gap";
  subscriptionId: string;
  gap: DashboardReplayGap;
}

export interface DashStreamInventoryDeltaFrame extends DashStreamServerFrameBase {
  kind: "inventory_delta";
  cursor: DashboardCursor;
  upserts: SessionInventoryRecord[];
  removedInventoryIds: string[];
}

export interface DashStreamPresenceFrame extends DashStreamServerFrameBase {
  kind: "presence";
  inventoryId: string;
  presence: DashSessionPresence;
}

export interface DashStreamSettingsFrame extends DashStreamServerFrameBase {
  kind: "settings";
  settings: DashboardSettingsResource;
}

export interface DashStreamErrorFrame extends DashStreamServerFrameBase {
  kind: "error";
  error: ApiErrorBody;
}

export type DashStreamServerFrame =
  | DashStreamReadyFrame
  | DashStreamSubscriptionReadyFrame
  | DashStreamCommandResultFrame
  | DashStreamSessionEventFrame
  | DashStreamTuiDeltaFrame
  | DashStreamReplayGapFrame
  | DashStreamInventoryDeltaFrame
  | DashStreamPresenceFrame
  | DashStreamSettingsFrame
  | DashStreamErrorFrame;
