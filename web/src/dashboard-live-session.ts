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
  activationTicket?: ActivationTicket;
  exportTicket?: SessionExportTicket;
  extensionRequests: LiveExtensionRequest[];
  unread: boolean;
  error?: { code: string; message: string; retryable: boolean };
}

export interface DashboardLiveSessionOptions {
  role?: DashboardControllerRole;
  ticketPollMs?: number;
  maxTicketPolls?: number;
}

type Listener = (state: DashboardLiveSessionState) => void;
type StatePatch = Omit<Partial<DashboardLiveSessionState>, "error"> & {
  error?: DashboardLiveSessionState["error"] | undefined;
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
    };
    this.#state = {
      inventoryId,
      phase: "preview-loading",
      role: "observer",
      rpcState: {},
      requestState: {},
      activationModes: [],
      extensionRequests: [],
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
    this.#patch({ phase: "preview-loading", error: undefined });
    const previewPromise = this.backend.getTranscript(this.inventoryId, { limit: 200 });
    const infoPromise = this.backend.getSessionInfo(this.inventoryId);
    try {
      const preview = await previewPromise;
      if (!this.#current(generation)) return;
      this.#acceptPreview(preview);
      const info = await infoPromise;
      if (!this.#current(generation)) return;
      this.#patch({
        info,
        phase: "preview",
        activationModes: [...info.activation.modes],
        unread: info.presence.unread,
      });
      if (info.managed !== undefined) {
        await this.#connect(info.managed.sessionId, info.managed.generation, generation);
        return;
      }
      if (info.activation.eligible && info.activation.modes.includes("reuse")) {
        await this.activate("reuse");
        return;
      }
      if (!info.activation.eligible || info.activation.modes.every((mode) => mode === "preview-only")) {
        this.#patch({ phase: "preview-only" });
        return;
      }
      this.#patch({ phase: "activation-choice" });
    } catch (error) {
      if (this.#current(generation)) this.#fail(error, "preview_failed");
    }
  }

  async activate(mode: ActivationMode): Promise<void> {
    if (this.#stopped) return;
    const generation = this.#generation;
    this.#patch({ phase: "activating", error: undefined });
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
      let ticket = await this.backend.exportSession(sessionRef, {
        requestId: `dash-export-${crypto.randomUUID()}`,
        idempotencyKey: `dash-export-${sessionRef}-${mode}`,
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
      const request: DashboardExtensionUiEvent = event;
      this.#patch({
        extensionRequests: [
          ...this.#state.extensionRequests.filter((candidate) => candidate.requestId !== request.requestId),
          { requestId: request.requestId, method: request.method, payload: request.payload },
        ],
      });
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

  #onSessionEvent(
    event: Record<string, unknown>,
    identity: DashboardSessionIdentity,
    cursor: import("@harryaskham/pi-daemon/dashboard-contract").DashboardCursor,
  ): void {
    const transcript = this.#state.transcript;
    const record = normalizedRecord(event.normalizedRecord ?? event.record);
    if (record && transcript) {
      this.#patch({
        transcript: transcriptStoreReducer(transcript, {
          type: event.type === "entry_appended" ? "entry_appended" : "upsert",
          identity,
          ...(event.type === "entry_appended" ? { record } : { records: [record] }),
          cursor,
        } as import("./transcript-store").TranscriptStoreAction),
      });
    }
    const type = typeof event.type === "string" ? event.type : "";
    if (["agent_start", "message_update", "tool_execution_start", "tool_execution_update"].includes(type)) {
      this.#patch({ phase: "streaming" });
    } else if (["agent_end", "agent_settled", "tool_execution_end"].includes(type)) {
      this.#patch({ phase: "live", unread: true });
    } else if (type === "retry_start") {
      this.#patch({ phase: "streaming" });
    } else if (type === "error") {
      this.#patch({ phase: "error", error: { code: "session_event_error", message: String(event.message ?? "Session error"), retryable: true } });
    }
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
