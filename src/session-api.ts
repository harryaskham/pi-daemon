export const SESSION_API_VERSION = "1.0" as const;
export const SESSION_API_BASE_PATH = "/v1" as const;

export const SESSION_API_PATHS = {
  capabilities: "/v1/capabilities",
  sessions: "/v1/session",
  session: "/v1/session/{sessionRef}",
  rpc: "/v1/session/{sessionRef}/rpc",
  apc: "/v1/session/{sessionRef}/apc",
  tickets: "/v1/ticket",
  ticket: "/v1/ticket/{ticketId}",
  reconcileTicket: "/v1/ticket/{ticketId}/reconcile",
  schedules: "/v1/schedule",
  scheduleStatus: "/v1/schedule/status",
  schedule: "/v1/schedule/{scheduleId}",
  scheduleEnable: "/v1/schedule/{scheduleId}/enable",
  scheduleDisable: "/v1/schedule/{scheduleId}/disable",
  dashboardCapabilities: "/v1/dashboard/capabilities",
  dashboardInventory: "/v1/dashboard/inventory",
  dashboardInventoryItem: "/v1/dashboard/inventory/{inventoryId}",
  dashboardTranscript: "/v1/dashboard/inventory/{inventoryId}/transcript",
  dashboardActivate: "/v1/dashboard/inventory/{inventoryId}/activate",
  dashboardActivation: "/v1/dashboard/activation/{ticketId}",
  dashboardSessionDrafts: "/v1/dashboard/session-drafts",
  dashboardSessionDraft: "/v1/dashboard/session-drafts/{draftId}",
  dashboardSessionDraftSend: "/v1/dashboard/session-drafts/{draftId}/send",
  dashboardSessionDraftSendTicket: "/v1/dashboard/session-draft-send/{ticketId}",
  dashboardExport: "/v1/dashboard/session/{sessionRef}/export",
  dashboardExportTicket: "/v1/dashboard/export/{ticketId}",
  dashboardLease: "/v1/dashboard/session/{sessionRef}/lease",
  dashboardTui: "/v1/dashboard/session/{sessionRef}/tui",
} as const;

export const DASHBOARD_TUI_SUBPROTOCOL = "pi-daemon-tui.v1" as const;

/**
 * `pi-rpc.v1` preserves Pi's JSONL RPC message shapes. `pi-daemon-rpc.v1`
 * wraps the same messages with host, generation, cursor, and replay metadata.
 */
export const SESSION_RPC_SUBPROTOCOLS = ["pi-rpc.v1", "pi-daemon-rpc.v1"] as const;
export type SessionRpcSubprotocol = (typeof SESSION_RPC_SUBPROTOCOLS)[number];

/** Pi 0.80.6 RPC command names. Additions require compatibility fixtures. */
export const PI_RPC_COMMAND_TYPES = [
  "prompt",
  "steer",
  "follow_up",
  "abort",
  "new_session",
  "get_state",
  "set_model",
  "cycle_model",
  "get_available_models",
  "set_thinking_level",
  "cycle_thinking_level",
  "set_steering_mode",
  "set_follow_up_mode",
  "compact",
  "set_auto_compaction",
  "set_auto_retry",
  "abort_retry",
  "bash",
  "abort_bash",
  "get_session_stats",
  "export_html",
  "switch_session",
  "fork",
  "clone",
  "get_fork_messages",
  "get_entries",
  "get_tree",
  "get_last_assistant_text",
  "set_session_name",
  "get_messages",
  "get_commands",
] as const;
export type PiRpcCommandType = (typeof PI_RPC_COMMAND_TYPES)[number];

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type SessionThinkingLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";
export type SessionApiState = "opening" | "idle" | "running" | "failed" | "closing";
export type IsolationMode = "unisolated";
export type ProjectTrustMode = "default" | "approve" | "deny";

export interface SessionTargetSpec {
  mode: "new" | "continue" | "open" | "fork" | "memory";
  path?: string;
  sourceSession?: string;
  entryId?: string;
  sessionDir?: string;
}

export interface SessionModelSpec {
  provider?: string;
  id?: string;
  thinkingLevel?: SessionThinkingLevel;
  scopedModels?: string[];
}

export interface SessionToolSpec {
  mode?: "default" | "none" | "no-builtin" | "allowlist";
  include?: string[];
  exclude?: string[];
}

export interface SessionResourceSpec {
  extensions?: string[];
  skills?: string[];
  promptTemplates?: string[];
  themes?: string[];
  noExtensions?: boolean;
  noSkills?: boolean;
  noPromptTemplates?: boolean;
  noThemes?: boolean;
  noContextFiles?: boolean;
  systemPrompt?: string;
  appendSystemPrompt?: string[];
  projectTrust?: ProjectTrustMode;
  extensionFlags?: Record<string, string | boolean>;
}

/**
 * Input-only environment values. Implementations must never return, log, or
 * persist these raw values in a session manifest or request journal.
 */
export type SessionEnvironment = Record<string, string>;

export interface SessionSpec {
  cwd: string;
  name?: string;
  agentDir?: string;
  target: SessionTargetSpec;
  model?: SessionModelSpec;
  tools?: SessionToolSpec;
  resources?: SessionResourceSpec;
  settings?: JsonObject;
  env?: SessionEnvironment;
  isolation?: { mode: IsolationMode };
}

export interface SessionCreateRequest {
  requestId: string;
  sessionId?: string;
  spec: SessionSpec;
}

export interface SessionUpdateRequest {
  requestId: string;
  expectedGeneration: number;
  expectedRevision: number;
  spec: SessionSpec;
}

export interface SessionTerminalSummary {
  state: "succeeded" | "failed" | "indeterminate";
  at: string;
  requestId?: string;
  errorCode?: string;
}

export interface SessionEnvironmentSummary {
  keys: string[];
  digest?: string;
  persistence: "memory-only" | "reference";
  provisioned: boolean;
}

export interface SessionResource {
  sessionId: string;
  name?: string;
  generation: number;
  revision: number;
  residency: "resident" | "dormant";
  state: SessionApiState;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string;
  spec: Omit<SessionSpec, "env">;
  environment: SessionEnvironmentSummary;
  lastTerminal?: SessionTerminalSummary;
  links: {
    self: string;
    rpc: string;
    apc: string;
  };
}

export interface ApiErrorBody {
  code: string;
  message: string;
  retryable: boolean;
  details?: JsonObject;
}

export interface ApiSuccessEnvelope<T = JsonValue> {
  apiVersion: typeof SESSION_API_VERSION;
  requestId: string;
  hostInstanceId: string;
  ok: true;
  data: T;
}

export interface ApiErrorEnvelope {
  apiVersion: typeof SESSION_API_VERSION;
  requestId: string;
  hostInstanceId: string;
  ok: false;
  error: ApiErrorBody;
}

export type TicketState = "queued" | "running" | "succeeded" | "failed" | "indeterminate";

export interface TicketResource {
  ticketId: string;
  requestId: string;
  idempotencyKey: string;
  operation: "create" | "update" | "delete" | "prompt";
  state: TicketState;
  submittedAt: string;
  updatedAt: string;
  sessionId?: string;
  generation?: number;
  result?: JsonValue;
  error?: ApiErrorBody;
  links: { self: string; session?: string };
}

export interface SessionListPage {
  sessions: SessionResource[];
  nextCursor?: string;
}

export interface PiRpcCommand extends JsonObject {
  type: PiRpcCommandType;
  id?: string;
}

export interface PiRpcResponse extends JsonObject {
  type: "response";
  command: string;
  success: boolean;
  id?: string;
}

export interface PiRpcEvent extends JsonObject {
  type: string;
}

export interface SessionAttachSnapshot {
  session: SessionResource;
  requestState: JsonObject;
  rpcState: JsonObject;
  leafId?: string | null;
}

export interface RpcCommandFrame {
  kind: "command";
  command: PiRpcCommand;
}

export interface RpcResponseFrame {
  kind: "response";
  response: PiRpcResponse;
}

export interface RpcExtensionUiResponseFrame {
  kind: "extension_ui_response";
  response: JsonObject & { type: "extension_ui_response"; id: string };
}

export interface RpcEventFrame {
  kind: "event";
  cursor: string;
  sequence: number;
  event: PiRpcEvent;
}

export interface RpcAttachReadyFrame {
  kind: "attach_ready";
  connectionId: string;
  role: "controller" | "observer";
  hostInstanceId: string;
  sessionId: string;
  generation: number;
  highWaterCursor: string;
  oldestAvailableCursor?: string;
  snapshot: SessionAttachSnapshot;
}

export interface RpcReplayGapFrame {
  kind: "replay_gap";
  reason: "cursor_expired" | "host_restarted" | "generation_changed";
  requestedCursor: string;
  oldestAvailableCursor?: string;
  highWaterCursor: string;
  snapshotFollows: true;
}

export interface RpcControlFrame {
  kind: "control";
  action: "request_control" | "release_control" | "control_granted" | "control_denied";
  connectionId?: string;
  reason?: string;
}

export type SessionRpcFrame =
  | RpcCommandFrame
  | RpcResponseFrame
  | RpcExtensionUiResponseFrame
  | RpcEventFrame
  | RpcAttachReadyFrame
  | RpcReplayGapFrame
  | RpcControlFrame;

export interface JsonRpcMessage extends JsonObject {
  jsonrpc: "2.0";
  id?: string | number | null;
  method?: string;
}

/**
 * Normative equivalence map. Transport adapters may differ in response timing,
 * but every entry resolves through one logical session/runtime transition.
 */
export const CONTROL_MODE_EQUIVALENCE = {
  create: { ndjson: "open", rest: "POST /v1/session", rpc: "new_session" },
  inspect: { ndjson: "status", rest: "GET /v1/session/{sessionRef}", rpc: "get_state" },
  prompt: { ndjson: "wake", rest: undefined, rpc: "prompt" },
  steer: { ndjson: "steer", rest: undefined, rpc: "steer" },
  followUp: { ndjson: "followUp", rest: undefined, rpc: "follow_up" },
  abort: { ndjson: "abort", rest: undefined, rpc: "abort" },
  attach: { ndjson: "attach", rest: "GET /v1/session/{sessionRef}/rpc", rpc: "transport attach" },
  detach: { ndjson: "detach", rest: "WebSocket close", rpc: "transport detach" },
  replace: { ndjson: "open with next generation", rest: "PUT /v1/session/{sessionRef}", rpc: "switch_session" },
  close: { ndjson: "close", rest: "DELETE /v1/session/{sessionRef}", rpc: undefined },
} as const;
