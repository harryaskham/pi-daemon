import type {
  ActivationMode,
  ActivationTicket,
  DashboardBackend,
  DashboardChannel,
  DashboardChannelEvent,
  DashboardCommandOperation,
  DashboardCommandResult,
  DashboardControllerRole,
  DashboardExtensionUiEvent,
  DashboardSessionIdentity,
  DashboardTicketState,
  NormalizedTranscriptRecord,
  SessionExportTicket,
  SessionInfoResource,
  TranscriptPage,
  TranscriptContentBlock,
  TranscriptMessageRecord,
  TranscriptTimelineRecord,
  TranscriptToolRecord,
} from "@harryaskham/pi-daemon/dashboard-contract";
import type { JsonObject, JsonValue, SessionResource } from "@harryaskham/pi-daemon/session-api";
import {
  createTranscriptStore,
  transcriptStoreReducer,
  type TranscriptStoreState,
} from "./transcript-store";

export type LiveSessionPhase =
  | "preview-loading"
  | "preview"
  | "activation-choice"
  | "activating"
  | "hydrating"
  | "live"
  | "streaming"
  | "reconnecting"
  | "preview-only"
  | "indeterminate"
  | "error"
  | "closed";

export interface LiveExtensionRequest {
  requestId: string;
  method: string;
  payload: JsonObject;
}

export interface LiveExtensionNotification {
  requestId: string;
  message: string;
  type: "info" | "warning" | "error";
}

export interface LiveExtensionWidget {
  key: string;
  lines: string[];
  placement: "aboveEditor" | "belowEditor";
}

export interface DashboardLiveSessionState {
  inventoryId: string;
  phase: LiveSessionPhase;
  info?: SessionInfoResource;
  transcript?: TranscriptStoreState;
  managedSession?: SessionResource;
  identity?: DashboardSessionIdentity;
  role: DashboardControllerRole;
  rpcState: JsonObject;
  requestState: JsonObject;
  sessionStats?: JsonValue;
  availableCommands?: JsonValue;
  availableModels?: JsonValue;
  activationModes: ActivationMode[];
  selectedActivationMode?: ActivationMode;
  activationTicket?: ActivationTicket;
  exportTicket?: SessionExportTicket;
  extensionRequests: LiveExtensionRequest[];
  extensionNotifications: LiveExtensionNotification[];
  extensionStatuses: Record<string, string>;
  extensionWidgets: Record<string, LiveExtensionWidget>;
  extensionTitle?: string;
  extensionEditorText?: string;
  unread: boolean;
  error?: { code: string; message: string; retryable: boolean };
}

export interface DashboardLiveSessionOptions {
  role?: DashboardControllerRole;
  ticketPollMs?: number;
  maxTicketPolls?: number;
  onSeen?(cursor: import("@harryaskham/pi-daemon/dashboard-contract").DashboardCursor): void;
}

type Listener = (state: DashboardLiveSessionState) => void;
type StatePatch = Omit<
  Partial<DashboardLiveSessionState>,
  "error" | "selectedActivationMode"
> & {
  error?: DashboardLiveSessionState["error"] | undefined;
  selectedActivationMode?: ActivationMode | undefined;
};

export class DashboardLiveSessionController {
  readonly backend: DashboardBackend;
  readonly inventoryId: string;
  readonly options: Required<DashboardLiveSessionOptions>;
  #state: DashboardLiveSessionState;
  #channel: DashboardChannel | undefined;
  #unsubscribeChannel: (() => void) | undefined;
  #listeners = new Set<Listener>();
  #generation = 0;
  #commandSequence = 0;
  #liveRecordSequence = 0;
  #activeAssistantMessageId: string | undefined;
  #stopped = false;

  constructor(
    backend: DashboardBackend,
    inventoryId: string,
    options: DashboardLiveSessionOptions = {},
  ) {
    this.backend = backend;
    this.inventoryId = inventoryId;
    this.options = {
      role: options.role ?? "controller",
      ticketPollMs: options.ticketPollMs ?? 100,
      maxTicketPolls: options.maxTicketPolls ?? 100,
      onSeen: options.onSeen ?? (() => undefined),
    };
    this.#state = {
      inventoryId,
      phase: "preview-loading",
      role: "observer",
      rpcState: {},
      requestState: {},
      activationModes: [],
      extensionRequests: [],
      extensionNotifications: [],
      extensionStatuses: {},
      extensionWidgets: {},
      unread: false,
    };
  }

  get state(): DashboardLiveSessionState {
    return this.#state;
  }

  subscribe(listener: Listener): () => void {
    this.#listeners.add(listener);
    listener(this.#state);
    return () => this.#listeners.delete(listener);
  }

  async start(): Promise<void> {
    const generation = ++this.#generation;
    this.#stopped = false;
    this.#patch({
      phase: "preview-loading",
      selectedActivationMode: undefined,
      error: undefined,
    });
    const previewPromise = this.backend.getTranscript(this.inventoryId, { limit: 200 });
    const infoPromise = this.backend.getSessionInfo(this.inventoryId);
    try {
      const preview = await previewPromise;
      if (!this.#current(generation)) return;
      this.#acceptPreview(preview);
      const info = await infoPromise;
      if (!this.#current(generation)) return;
      const selectedActivationMode = preferredActivationMode(info);
      this.#patch({
        info,
        phase: "preview",
        activationModes: [...info.activation.modes],
        ...(selectedActivationMode === undefined ? {} : { selectedActivationMode }),
        unread: info.presence.unread,
      });
      if (info.managed?.residency === "resident") {
        await this.#connect(info.managed.sessionId, info.managed.generation, generation);
        return;
      }
      if (info.managed !== undefined) return;
      if (
        !info.activation.eligible ||
        info.activation.modes.every((mode) => mode === "preview-only")
      ) {
        this.#patch({ phase: "preview-only" });
        return;
      }
      this.#patch({ phase: "activation-choice" });
    } catch (error) {
      if (this.#current(generation)) this.#fail(error, "preview_failed");
    }
  }

  selectActivationMode(mode: ActivationMode): void {
    if (mode === "preview-only" || !this.#state.activationModes.includes(mode)) return;
    this.#patch({ selectedActivationMode: mode, error: undefined });
  }

  async activate(mode: ActivationMode): Promise<void> {
    if (this.#stopped) return;
    const generation = this.#generation;
    this.#patch({
      phase: "activating",
      selectedActivationMode: mode,
      error: undefined,
    });
    try {
      let ticket = await this.backend.activateSession(this.inventoryId, {
        requestId: `dash-activation-${crypto.randomUUID()}`,
        idempotencyKey: `dash-activation-${this.inventoryId}-${mode}`,
        mode,
      });
      this.#patch({ activationTicket: ticket });
      ticket = await this.#waitActivation(ticket, generation);
      if (!this.#current(generation)) return;
      this.#patch({ activationTicket: ticket });
      if (ticket.state === "indeterminate") {
        this.#patch({ phase: "indeterminate" });
        return;
      }
      if (ticket.state === "failed") {
        this.#patch({
          phase: "error",
          error: ticket.error ?? { code: "activation_failed", message: "Session activation failed", retryable: false },
        });
        return;
      }
      if (ticket.state !== "succeeded" || ticket.managedSession === undefined) {
        this.#patch({ phase: "error", error: { code: "activation_incomplete", message: "Activation did not produce a managed session", retryable: true } });
        return;
      }
      await this.#connect(ticket.managedSession.sessionId, ticket.managedSession.generation, generation);
    } catch (error) {
      if (this.#current(generation)) this.#fail(error, "activation_failed");
    }
  }

  async exportSession(mode: "as-new" | "append-to-origin", releaseAfterExport = false): Promise<void> {
    const sessionRef = this.#state.managedSession?.sessionId ?? this.#state.identity?.sessionId;
    if (sessionRef === undefined) throw new Error("Session is not managed");
    try {
      const operationId = crypto.randomUUID();
      let ticket = await this.backend.exportSession(sessionRef, {
        requestId: `dash-export-${operationId}`,
        idempotencyKey: `dash-export-${sessionRef}-${mode}-${operationId}`,
        mode,
        releaseAfterExport,
      });
      this.#patch({ exportTicket: ticket });
      for (let index = 0; index < this.options.maxTicketPolls && ["queued", "running"].includes(ticket.state); index += 1) {
        await delay(this.options.ticketPollMs);
        ticket = await this.backend.getExport(ticket.ticketId);
        this.#patch({ exportTicket: ticket });
      }
      if (ticket.state === "indeterminate") this.#patch({ phase: "indeterminate" });
      else if (ticket.state === "failed") {
        this.#patch({
          phase: "error",
          error: ticket.error ?? { code: "export_failed", message: "Session export failed", retryable: false },
        });
      }
    } catch (error) {
      this.#fail(error, "export_failed");
    }
  }

  async submit(
    operation: DashboardCommandOperation,
    payload: JsonObject = {},
    idempotencyKey?: string,
  ): Promise<DashboardCommandResult> {
    if (this.#channel !== undefined) {
      return this.command(operation, payload, idempotencyKey);
    }
    const correlationId = `command-${++this.#commandSequence}`;
    if (operation !== "prompt") {
      const result = rejected(
        correlationId,
        "activation_required",
        "Send a normal message to activate this preview before using session commands",
        false,
      );
      this.#patch({ error: result.error });
      return result;
    }
    if (["activating", "hydrating", "preview-loading", "reconnecting"].includes(this.#state.phase)) {
      return rejected(
        correlationId,
        "activation_in_progress",
        "Session activation is already in progress",
        true,
      );
    }
    if (this.#state.phase === "indeterminate") {
      return {
        correlationId,
        state: "indeterminate",
        error: {
          code: "activation_indeterminate",
          message: "Activation outcome is indeterminate; reconcile before sending again",
          retryable: false,
        },
      };
    }
    if (this.#state.phase === "preview-only" || !this.#state.info?.activation.eligible) {
      const result = rejected(
        correlationId,
        this.#state.info?.activation.reasonCode ?? "preview_only",
        "This preview cannot be activated under the current session policy",
        false,
      );
      this.#patch({ error: result.error });
      return result;
    }
    const generation = this.#generation;
    const managed = this.#state.info.managed;
    if (managed !== undefined) {
      try {
        await this.#connect(managed.sessionId, managed.generation, generation);
      } catch (error) {
        if (this.#current(generation)) this.#fail(error, "hydration_failed", true);
      }
    } else {
      const mode = this.#state.selectedActivationMode ?? preferredActivationMode(this.#state.info);
      if (mode === undefined) {
        const result = rejected(
          correlationId,
          "activation_mode_required",
          "Choose a safe activation mode before sending",
          false,
        );
        this.#patch({ error: result.error });
        return result;
      }
      await this.activate(mode);
    }
    const settledPhase = this.#state.phase as LiveSessionPhase;
    if (this.#channel === undefined || !["live", "streaming"].includes(settledPhase)) {
      if (settledPhase === "indeterminate") {
        return {
          correlationId,
          state: "indeterminate",
          error: {
            code: "activation_indeterminate",
            message: "Activation outcome is indeterminate; the prompt was not submitted",
            retryable: false,
          },
        };
      }
      return rejected(
        correlationId,
        this.#state.error?.code ?? "activation_failed",
        this.#state.error?.message ?? "Session activation did not reach a live channel",
        this.#state.error?.retryable ?? true,
      );
    }
    return this.command(operation, payload, idempotencyKey);
  }

  async command(
    operation: DashboardCommandOperation,
    payload: JsonObject = {},
    idempotencyKey?: string,
  ): Promise<DashboardCommandResult> {
    const channel = this.#channel;
    const identity = this.#state.identity;
    if (channel === undefined || identity === undefined) {
      return rejected(`command-${++this.#commandSequence}`, "channel_unavailable", "Live channel is unavailable", true);
    }
    const correlationId = `command-${++this.#commandSequence}`;
    try {
      const result = await channel.command({
        correlationId,
        identity,
        operation,
        payload,
        ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
      });
      if (result.state === "indeterminate") this.#patch({ phase: "indeterminate" });
      else if (result.state === "rejected" && result.error) this.#patch({ error: result.error });
      else if (operation === "prompt") this.#patch({ phase: "streaming" });
      else if (result.state === "completed" && isJsonObject(result.data)) {
        this.#patch({ rpcState: { ...this.#state.rpcState, ...result.data } });
      }
      return result;
    } catch (error) {
      this.#fail(error, "command_failed", true);
      return rejected(correlationId, "command_failed", error instanceof Error ? error.message : "Command failed", true);
    }
  }

  async requestControl(): Promise<DashboardCommandResult> {
    if (!this.#channel) return rejected("request-control", "channel_unavailable", "Live channel is unavailable", true);
    const result = await this.#channel.requestControl(`control-${++this.#commandSequence}`);
    this.#patch({ role: this.#channel.role });
    return result;
  }

  async releaseControl(): Promise<DashboardCommandResult> {
    if (!this.#channel) return rejected("release-control", "channel_unavailable", "Live channel is unavailable", true);
    const result = await this.#channel.releaseControl(`control-${++this.#commandSequence}`);
    this.#patch({ role: this.#channel.role });
    return result;
  }

  async answerExtensionUi(requestId: string, response: JsonObject): Promise<void> {
    if (!this.#channel) throw new Error("Live channel is unavailable");
    await this.#channel.answerExtensionUi(requestId, response);
    this.#patch({ extensionRequests: this.#state.extensionRequests.filter((request) => request.requestId !== requestId) });
  }

  markSeen(): void {
    const cursor = this.#state.transcript?.highWaterCursor;
    if (cursor !== undefined) this.options.onSeen(cursor);
    this.#patch({ unread: false });
  }

  async reconnect(): Promise<void> {
    const identity = this.#state.identity;
    if (!identity) return this.start();
    const generation = ++this.#generation;
    await this.#disconnect();
    this.#patch({ phase: "reconnecting", error: undefined });
    await this.#connect(identity.sessionId, identity.generation, generation, this.#state.transcript?.highWaterCursor);
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    this.#generation += 1;
    await this.#disconnect();
    this.#patch({ phase: "closed" });
    this.#listeners.clear();
  }

  async #connect(
    sessionRef: string,
    generation: number,
    operationGeneration: number,
    cursor?: import("@harryaskham/pi-daemon/dashboard-contract").DashboardCursor,
  ): Promise<void> {
    if (!this.#current(operationGeneration)) return;
    this.#patch({ phase: "hydrating" });
    const channel = await this.backend.openSessionChannel({
      sessionRef,
      generation,
      role: this.options.role,
      ...(cursor === undefined ? {} : { cursor }),
    });
    if (!this.#current(operationGeneration)) {
      await channel.close();
      return;
    }
    await this.#disconnect();
    this.#channel = channel;
    this.#unsubscribeChannel = channel.subscribe((event) => this.#onEvent(event));
    this.#acceptChannelSnapshot(channel);
    this.#patch({ phase: "live", role: channel.role });
    void this.#loadChannelMetadata(channel);
  }

  async #loadChannelMetadata(channel: DashboardChannel): Promise<void> {
    const operations: DashboardCommandOperation[] = [
      "get_session_stats",
      "get_commands",
      "get_available_models",
    ];
    const results = await Promise.all(operations.map((operation) => channel.command({
      correlationId: `metadata-${operation}-${++this.#commandSequence}`,
      identity: channel.identity,
      operation,
    }).catch(() => undefined)));
    if (channel !== this.#channel || this.#stopped) return;
    this.#patch({
      ...(results[0]?.state === "completed" ? { sessionStats: results[0].data } : {}),
      ...(results[1]?.state === "completed" ? { availableCommands: results[1].data } : {}),
      ...(results[2]?.state === "completed" ? { availableModels: results[2].data } : {}),
    });
  }

  #acceptPreview(preview: TranscriptPage): void {
    const identity: DashboardSessionIdentity = preview.managedSession
      ? { hostInstanceId: "preview", sessionId: preview.managedSession.sessionId, generation: preview.managedSession.generation }
      : { hostInstanceId: "preview", sessionId: preview.piSessionId ?? this.inventoryId, generation: 0 };
    this.#patch({
      phase: "preview",
      transcript: createTranscriptStore(identity, preview.records, undefined, preview.newerCursor ?? preview.olderCursor),
    });
  }

  #acceptChannelSnapshot(channel: DashboardChannel): void {
    const current = this.#state.transcript;
    const transcript = current
      ? transcriptStoreReducer(current, {
          type: "snapshot",
          identity: channel.identity,
          records: channel.snapshot.entries,
          cursor: channel.snapshot.highWaterCursor,
        })
      : createTranscriptStore(channel.identity, channel.snapshot.entries, undefined, channel.snapshot.highWaterCursor);
    this.#patch({
      transcript,
      identity: channel.identity,
      managedSession: channel.snapshot.session,
      rpcState: channel.snapshot.rpcState,
      requestState: channel.snapshot.requestState,
      role: channel.role,
    });
  }

  #onEvent(event: DashboardChannelEvent): void {
    if (event.kind === "control") {
      this.#patch({ role: event.action === "control_granted" ? "controller" : "observer" });
      return;
    }
    if (event.kind === "extension_ui") {
      this.#acceptExtensionUi(event);
      return;
    }
    if (event.kind === "replay_gap") {
      const transcript = this.#state.transcript;
      this.#patch({
        phase: "reconnecting",
        ...(transcript === undefined
          ? {}
          : {
              transcript: transcriptStoreReducer(transcript, {
                type: "replay_gap",
                identity: event.identity,
                reason: event.reason,
                highWaterCursor: event.highWaterCursor,
              }),
            }),
      });
      if (this.#channel) this.#acceptChannelSnapshot(this.#channel);
      this.#patch({ phase: "live" });
      return;
    }
    this.#onSessionEvent(event.event as unknown as Record<string, unknown>, event.identity, event.cursor);
  }

  #acceptExtensionUi(request: DashboardExtensionUiEvent): void {
    if (["select", "confirm", "input", "editor"].includes(request.method)) {
      this.#patch({
        extensionRequests: [
          ...this.#state.extensionRequests.filter((candidate) => candidate.requestId !== request.requestId),
          { requestId: request.requestId, method: request.method, payload: request.payload },
        ].slice(-16),
      });
      return;
    }
    if (request.method === "notify") {
      const type: LiveExtensionNotification["type"] = request.payload.notifyType === "warning" || request.payload.notifyType === "error" ? request.payload.notifyType : "info";
      this.#patch({
        extensionNotifications: [...this.#state.extensionNotifications, {
          requestId: request.requestId,
          message: typeof request.payload.message === "string" ? request.payload.message : "Extension notification",
          type,
        }].slice(-8),
      });
      return;
    }
    if (request.method === "setStatus" && typeof request.payload.statusKey === "string") {
      const statuses = { ...this.#state.extensionStatuses };
      if (typeof request.payload.statusText === "string") statuses[request.payload.statusKey] = request.payload.statusText;
      else delete statuses[request.payload.statusKey];
      this.#patch({ extensionStatuses: statuses });
      return;
    }
    if (request.method === "setWidget" && typeof request.payload.widgetKey === "string") {
      const widgets = { ...this.#state.extensionWidgets };
      const lines = Array.isArray(request.payload.widgetLines)
        ? request.payload.widgetLines.filter((line): line is string => typeof line === "string").slice(0, 32)
        : [];
      if (lines.length === 0) delete widgets[request.payload.widgetKey];
      else widgets[request.payload.widgetKey] = {
        key: request.payload.widgetKey,
        lines,
        placement: request.payload.widgetPlacement === "belowEditor" ? "belowEditor" : "aboveEditor",
      };
      this.#patch({ extensionWidgets: widgets });
      return;
    }
    if (request.method === "setTitle") {
      this.#patch({ extensionTitle: typeof request.payload.title === "string" ? request.payload.title : "" });
      return;
    }
    if (request.method === "set_editor_text" && typeof request.payload.text === "string") {
      this.#patch({ extensionEditorText: request.payload.text });
    }
  }

  #onSessionEvent(
    event: Record<string, unknown>,
    identity: DashboardSessionIdentity,
    cursor: import("@harryaskham/pi-daemon/dashboard-contract").DashboardCursor,
  ): void {
    const transcript = this.#state.transcript;
    const records = this.#recordsForEvent(event);
    if (records.length > 0 && transcript) {
      this.#patch({
        transcript: transcriptStoreReducer(transcript, {
          type: "upsert",
          identity,
          records,
          cursor,
        }),
      });
    }
    const type = typeof event.type === "string" ? event.type : "";
    if (["agent_start", "message_update", "tool_execution_start", "tool_execution_update"].includes(type)) {
      this.#patch({ phase: "streaming" });
    } else if (["agent_end", "agent_settled", "tool_execution_end"].includes(type)) {
      this.#patch({ phase: "live", unread: true });
    } else if (type === "retry_start" || type === "auto_retry_start" || type === "compaction_start") {
      this.#patch({ phase: "streaming" });
    } else if (type === "error") {
      this.#patch({ phase: "error", error: { code: "session_event_error", message: String(event.message ?? "Session error"), retryable: true } });
    }
  }

  #recordsForEvent(event: Record<string, unknown>): NormalizedTranscriptRecord[] {
    const direct = normalizedRecord(event.normalizedRecord ?? event.record);
    if (direct !== undefined) return [direct];
    const type = typeof event.type === "string" ? event.type : "";
    if (type === "message_start" || type === "message_update" || type === "message_end") {
      const message = jsonRecord(event.message);
      if (message === undefined) return [];
      const role = typeof message.role === "string" ? message.role : "assistant";
      if (role !== "assistant") {
        if (type !== "message_end") return [];
        return [liveMessageRecord(
          `live-message-${++this.#liveRecordSequence}`,
          role === "user" || role === "system" || role === "custom" ? role : "custom",
          message,
          "complete",
        )];
      }
      if (type === "message_start" || this.#activeAssistantMessageId === undefined) {
        this.#activeAssistantMessageId = typeof message.id === "string"
          ? message.id
          : `live-assistant-${++this.#liveRecordSequence}`;
      }
      const record = liveMessageRecord(
        this.#activeAssistantMessageId,
        "assistant",
        message,
        type === "message_end" ? "complete" : "streaming",
      );
      return [record];
    }
    if (type === "tool_execution_start" || type === "tool_execution_update" || type === "tool_execution_end") {
      const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : undefined;
      if (toolCallId === undefined) return [];
      const result = jsonRecord(type === "tool_execution_update" ? event.partialResult : event.result);
      return [{
        recordId: `tool:${toolCallId}`,
        key: { toolCallId },
        kind: "tool",
        toolName: typeof event.toolName === "string" ? event.toolName : "tool",
        state: type === "tool_execution_start" ? "running" : type === "tool_execution_end" ? event.isError === true ? "error" : "success" : "running",
        source: "live",
        timestamp: new Date().toISOString(),
        ...(jsonRecord(event.args) === undefined ? {} : { arguments: boundedObject(jsonRecord(event.args)!) }),
        content: toolContent(result),
        ...(result?.details === undefined ? {} : { details: boundedValue(result.details) }),
      }];
    }
    if (type === "entry_appended") {
      const entry = jsonRecord(event.entry);
      if (entry === undefined || typeof entry.id !== "string") return [];
      const records = persistedEntryRecords(entry, this.#activeAssistantMessageId);
      if (records.some((record) => record.kind === "message" && record.role === "assistant")) {
        this.#activeAssistantMessageId = undefined;
      }
      return records;
    }
    const timeline = liveTimelineRecord(event, ++this.#liveRecordSequence);
    return timeline === undefined ? [] : [timeline];
  }

  async #waitActivation(ticket: ActivationTicket, generation: number): Promise<ActivationTicket> {
    let current = ticket;
    for (
      let index = 0;
      index < this.options.maxTicketPolls && this.#current(generation) && isPending(current.state);
      index += 1
    ) {
      await delay(this.options.ticketPollMs);
      current = await this.backend.getActivation(current.ticketId);
      this.#patch({ activationTicket: current });
    }
    return current;
  }

  async #disconnect(): Promise<void> {
    this.#unsubscribeChannel?.();
    this.#unsubscribeChannel = undefined;
    const channel = this.#channel;
    this.#channel = undefined;
    if (channel) await channel.close();
  }

  #patch(patch: StatePatch): void {
    const next = { ...this.#state, ...patch } as DashboardLiveSessionState & {
      error?: DashboardLiveSessionState["error"] | undefined;
    };
    if (patch.error === undefined && "error" in patch) delete next.error;
    if (
      patch.selectedActivationMode === undefined &&
      "selectedActivationMode" in patch
    ) {
      delete next.selectedActivationMode;
    }
    this.#state = next as DashboardLiveSessionState;
    for (const listener of this.#listeners) listener(this.#state);
  }

  #fail(error: unknown, code: string, retryable = false): void {
    this.#patch({
      phase: "error",
      error: {
        code: errorCode(error, code),
        message: error instanceof Error ? error.message : "Dashboard operation failed",
        retryable: retryable || (typeof error === "object" && error !== null && "retryable" in error && error.retryable === true),
      },
    });
  }

  #current(generation: number): boolean {
    return !this.#stopped && generation === this.#generation;
  }
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizedRecord(value: unknown): NormalizedTranscriptRecord | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.recordId !== "string" || typeof record.kind !== "string" || typeof record.source !== "string") return undefined;
  if (!record.key || typeof record.key !== "object" || Array.isArray(record.key)) return undefined;
  return value as NormalizedTranscriptRecord;
}

function jsonRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function boundedText(value: string, limit = 262_144): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}\n… output truncated by Dash`;
}

function boundedValue(value: unknown): JsonValue {
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) return null;
    if (encoded.length > 131_072) return "[bounded output omitted]";
    return JSON.parse(encoded) as JsonValue;
  } catch {
    return "[unserializable output omitted]";
  }
}

function boundedObject(value: Record<string, unknown>): JsonObject {
  const bounded = boundedValue(value);
  return typeof bounded === "object" && bounded !== null && !Array.isArray(bounded) ? bounded : {};
}

function messageContent(message: Record<string, unknown>): TranscriptContentBlock[] {
  const content: TranscriptContentBlock[] = [];
  const source = message.content;
  if (typeof source === "string") content.push({ type: "text", text: boundedText(source) });
  if (Array.isArray(source)) {
    for (const candidate of source) {
      const block = jsonRecord(candidate);
      if (block === undefined) continue;
      if (block.type === "text" && typeof block.text === "string") {
        content.push({ type: message.role === "assistant" ? "markdown" : "text", text: boundedText(block.text) });
      } else if (block.type === "thinking" && typeof block.thinking === "string") {
        content.push({ type: "thinking", text: boundedText(block.thinking) });
      }
    }
  }
  if (typeof message.errorMessage === "string") content.push({ type: "error", text: boundedText(message.errorMessage) });
  const usage = jsonRecord(message.usage);
  if (usage !== undefined) {
    const cost = jsonRecord(usage.cost);
    const block: Extract<TranscriptContentBlock, { type: "usage" }> = { type: "usage" };
    if (typeof usage.input === "number") block.inputTokens = usage.input;
    if (typeof usage.output === "number") block.outputTokens = usage.output;
    if (typeof usage.cacheRead === "number") block.cacheReadTokens = usage.cacheRead;
    if (typeof usage.cacheWrite === "number") block.cacheWriteTokens = usage.cacheWrite;
    if (typeof cost?.total === "number") block.cost = cost.total;
    if (Object.keys(block).length > 1) content.push(block);
  }
  return content;
}

function liveMessageRecord(
  messageId: string,
  role: TranscriptMessageRecord["role"],
  message: Record<string, unknown>,
  state: TranscriptMessageRecord["state"],
): TranscriptMessageRecord {
  return {
    recordId: `message:${messageId}`,
    key: { messageId },
    kind: "message",
    role,
    state,
    source: "live",
    timestamp: typeof message.timestamp === "string" ? message.timestamp : new Date().toISOString(),
    content: messageContent(message),
  };
}

function toolContent(result: Record<string, unknown> | undefined): TranscriptContentBlock[] {
  if (result === undefined) return [];
  if (typeof result.content === "string") return [{ type: "text", text: boundedText(result.content) }];
  if (!Array.isArray(result.content)) return [];
  return result.content.flatMap((candidate): TranscriptContentBlock[] => {
    const block = jsonRecord(candidate);
    return block?.type === "text" && typeof block.text === "string"
      ? [{ type: "text", text: boundedText(block.text) }]
      : [];
  });
}

function persistedEntryRecords(entry: Record<string, unknown>, activeMessageId: string | undefined): NormalizedTranscriptRecord[] {
  const id = String(entry.id);
  const timestamp = typeof entry.timestamp === "string" ? entry.timestamp : new Date().toISOString();
  const parentEntryId = typeof entry.parentId === "string" ? entry.parentId : undefined;
  if (entry.type === "message") {
    const message = jsonRecord(entry.message);
    if (message === undefined) return [];
    const role = typeof message.role === "string" ? message.role : "custom";
    if (role === "toolResult" && typeof message.toolCallId === "string") {
      const record: TranscriptToolRecord = {
        recordId: `tool:${message.toolCallId}`,
        key: { entryId: id, toolCallId: message.toolCallId },
        kind: "tool",
        toolName: typeof message.toolName === "string" ? message.toolName : "tool",
        state: message.isError === true ? "error" : "success",
        source: "persisted",
        timestamp,
        ...(parentEntryId === undefined ? {} : { parentEntryId }),
        content: toolContent(message),
        ...(message.details === undefined ? {} : { details: boundedValue(message.details) }),
      };
      return [record];
    }
    if (role === "bashExecution") {
      return [{
        recordId: `timeline:${id}`,
        key: { entryId: id },
        kind: "timeline",
        event: "bash",
        label: typeof message.command === "string" ? boundedText(message.command, 4_096) : "Bash execution",
        source: "persisted",
        timestamp,
        ...(parentEntryId === undefined ? {} : { parentEntryId }),
        data: boundedObject(message),
      }];
    }
    const normalizedRole: TranscriptMessageRecord["role"] = role === "user" || role === "assistant" || role === "system" || role === "custom" ? role : "custom";
    const messageRecord: TranscriptMessageRecord = {
      recordId: `entry:${id}`,
      key: normalizedRole === "assistant" && activeMessageId !== undefined ? { entryId: id, messageId: activeMessageId } : { entryId: id },
      kind: "message",
      role: normalizedRole,
      state: message.stopReason === "error" ? "error" : "complete",
      source: "persisted",
      timestamp,
      ...(parentEntryId === undefined ? {} : { parentEntryId }),
      content: messageContent(message),
    };
    const tools: TranscriptToolRecord[] = [];
    if (Array.isArray(message.content)) {
      for (const candidate of message.content) {
        const block = jsonRecord(candidate);
        if (block?.type !== "toolCall" || typeof block.id !== "string") continue;
        tools.push({
          recordId: `tool:${block.id}`,
          key: { entryId: id, toolCallId: block.id },
          kind: "tool",
          toolName: typeof block.name === "string" ? block.name : "tool",
          state: "pending",
          source: "persisted",
          timestamp,
          ...(parentEntryId === undefined ? {} : { parentEntryId }),
          ...(jsonRecord(block.arguments) === undefined ? {} : { arguments: boundedObject(jsonRecord(block.arguments)!) }),
          content: [],
        });
      }
    }
    return [messageRecord, ...tools];
  }
  if (entry.type === "compaction" || entry.type === "branch_summary") {
    return [{
      recordId: `summary:${id}`,
      key: { entryId: id },
      kind: "summary",
      summaryKind: entry.type === "compaction" ? "compaction" : "branch",
      content: [{ type: "markdown", text: typeof entry.summary === "string" ? boundedText(entry.summary) : "Summary" }],
      source: "persisted",
      timestamp,
      ...(parentEntryId === undefined ? {} : { parentEntryId }),
    }];
  }
  const event: TranscriptTimelineRecord["event"] | undefined = entry.type === "model_change" ? "model"
    : entry.type === "thinking_level_change" ? "thinking"
      : entry.type === "session_info" ? "session-name"
        : entry.type === "label" ? "label"
          : undefined;
  return event === undefined ? [] : [{
    recordId: `timeline:${id}`,
    key: { entryId: id },
    kind: "timeline",
    event,
    source: "persisted",
    timestamp,
    ...(parentEntryId === undefined ? {} : { parentEntryId }),
    label: typeof entry.name === "string" ? entry.name : typeof entry.label === "string" ? entry.label : typeof entry.modelId === "string" ? entry.modelId : typeof entry.thinkingLevel === "string" ? entry.thinkingLevel : event,
    data: boundedObject(entry),
  }];
}

function liveTimelineRecord(event: Record<string, unknown>, sequence: number): TranscriptTimelineRecord | undefined {
  const type = typeof event.type === "string" ? event.type : "";
  const timelineEvent: TranscriptTimelineRecord["event"] | undefined = type === "queue_update" ? "queue"
    : type === "auto_retry_start" || type === "auto_retry_end" ? "retry"
      : type === "compaction_start" || type === "compaction_end" ? "compaction"
        : type === "thinking_level_changed" ? "thinking"
          : type === "session_info_changed" ? "session-name"
            : type === "extension_error" ? "extension-ui"
              : undefined;
  if (timelineEvent === undefined) return undefined;
  return {
    recordId: `live-timeline:${sequence}`,
    key: { messageId: `live-timeline:${sequence}` },
    kind: "timeline",
    event: timelineEvent,
    source: "live",
    timestamp: new Date().toISOString(),
    label: timelineLabel(type, event),
    data: boundedObject(event),
  };
}

function timelineLabel(type: string, event: Record<string, unknown>): string {
  if (type === "queue_update") {
    const steering = Array.isArray(event.steering) ? event.steering.length : 0;
    const followUp = Array.isArray(event.followUp) ? event.followUp.length : 0;
    return `Queue updated · ${steering} steering · ${followUp} follow-up`;
  }
  if (type === "auto_retry_start") return `Retry ${String(event.attempt ?? "?")} of ${String(event.maxAttempts ?? "?")}`;
  if (type === "auto_retry_end") return event.success === true ? "Retry succeeded" : "Retry stopped";
  if (type === "compaction_start") return `Compaction started · ${String(event.reason ?? "manual")}`;
  if (type === "compaction_end") return event.aborted === true ? "Compaction aborted" : "Compaction completed";
  if (type === "thinking_level_changed") return `Thinking · ${String(event.level ?? "changed")}`;
  if (type === "session_info_changed") return `Session name · ${String(event.name ?? "cleared")}`;
  return `Extension error · ${String(event.error ?? "unknown")}`;
}

function preferredActivationMode(
  info: Pick<SessionInfoResource, "managed" | "activation">,
): ActivationMode | undefined {
  const modes = info.activation.modes.filter((mode) => mode !== "preview-only");
  if (info.managed !== undefined && modes.includes("reuse")) return "reuse";
  if (modes.includes("reuse")) return "reuse";
  if (modes.includes("fork")) return "fork";
  return modes.includes("direct") ? "direct" : undefined;
}

function isPending(state: DashboardTicketState): boolean {
  return state === "queued" || state === "running";
}

function rejected(
  correlationId: string,
  code: string,
  message: string,
  retryable: boolean,
): DashboardCommandResult {
  return { correlationId, state: "rejected", error: { code, message, retryable } };
}

function errorCode(error: unknown, fallback: string): string {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : fallback;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, ms));
}
