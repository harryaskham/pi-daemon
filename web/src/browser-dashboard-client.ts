import {
  DASH_API_BASE_PATH,
  DASH_API_VERSION,
  DASH_STREAM_SUBPROTOCOL,
} from "@harryaskham/pi-daemon/dashboard-contract";
import type {
  ActivationRequest,
  ActivationTicket,
  DashStreamClientFrame,
  DashStreamServerFrame,
  DashboardBackend,
  DashboardBootstrapResource,
  DashboardBrowserSessionResource,
  DashboardCapabilities,
  DashboardChannel,
  DashboardChannelEvent,
  DashboardChannelListener,
  DashboardChannelSnapshot,
  DashboardCommand,
  DashboardCommandResult,
  DashboardControllerRole,
  DashboardCursor,
  DashboardErrorEnvelope,
  DashboardScheduleDeleteRequest,
  DashboardScheduleMutationRequest,
  DashboardScheduleResource,
  DashboardScheduleStatus,
  DashboardSessionIdentity,
  DashboardSettingsPatchRequest,
  DashboardSettingsResource,
  DashboardSuccessEnvelope,
  DashboardTuiChannel,
  DashboardTuiChannelEvent,
  DashboardTuiInput,
  DashboardTuiSnapshot,
  DashboardWorkspaceResource,
  DashboardWorkspaceUpdateRequest,
  SessionChannelOptions,
  SessionExportRequest,
  SessionExportTicket,
  SessionInfoResource,
  SessionInventoryPage,
  SessionInventoryQuery,
  TranscriptPage,
  TranscriptQuery,
  TuiChannelOptions,
  TuiDimensions,
} from "@harryaskham/pi-daemon/dashboard-contract";
import {
  dashboardSessionDraftEtag,
  type DashboardSessionDraftCancelRequest,
  type DashboardSessionDraftCreateRequest,
  type DashboardSessionDraftResource,
  type DashboardSessionDraftSendRequest,
  type DashboardSessionDraftSendTicket,
} from "@harryaskham/pi-daemon/dashboard-session-draft-contract";
import type { ScheduleCapabilities } from "@harryaskham/pi-daemon/schedule-contract";
import type { JsonObject, JsonValue, SessionResource } from "@harryaskham/pi-daemon/session-api";
import {
  DashboardRevisionConflict,
  type DashboardPreferencesBackend,
} from "./preferences-backend";

const CSRF_HEADER = "x-pi-daemon-csrf";
const REQUEST_TIMEOUT_MS = 30_000;
const RECONNECT_DELAYS_MS = [200, 400, 800, 1_600, 3_200, 5_000] as const;

type FetchLike = typeof globalThis.fetch;
type WebSocketFactory = (url: string, protocol: string) => WebSocket;
type RichListener = DashboardChannelListener<DashboardChannelEvent>;
type TuiListener = DashboardChannelListener<DashboardTuiChannelEvent>;

export interface BrowserDashboardClientOptions {
  basePath?: string;
  fetch?: FetchLike;
  webSocket?: WebSocketFactory;
  requestTimeoutMs?: number;
}

export class DashboardBrowserClientError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
    readonly status?: number,
  ) {
    super(message);
    this.name = "DashboardBrowserClientError";
  }
}

interface PendingCommand {
  kind: "command";
  resolve(result: DashboardCommandResult): void;
  reject(error: Error): void;
}

interface PendingFrame {
  kind: "frame";
  resolve(frame: DashStreamServerFrame): void;
  reject(error: Error): void;
}

type Pending = PendingCommand | PendingFrame;

/**
 * Browser-only implementation of the deployment-neutral DashboardBackend.
 * HTTP always stays same-origin and the stream is the BFF's multiplexed
 * pi-daemon-dash.v1 protocol; daemon service credentials never enter this
 * object or the compiled bundle.
 */
export class BrowserDashboardClient implements DashboardBackend, DashboardPreferencesBackend {
  readonly #basePath: string;
  readonly #fetch: FetchLike;
  readonly #webSocketFactory: WebSocketFactory;
  readonly #requestTimeoutMs: number;
  #clientId: string | undefined;
  #workspaceId: string | undefined;
  #csrfToken: string | undefined;
  #capabilities: DashboardCapabilities | undefined;
  #socket: WebSocket | undefined;
  #socketReady: Promise<void> | undefined;
  #socketReadyResolve: (() => void) | undefined;
  #socketReadyReject: ((error: Error) => void) | undefined;
  #helloCorrelation: string | undefined;
  #correlationSequence = 0;
  #subscriptionSequence = 0;
  #closed = false;
  #reconnectTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
  #reconnectAttempt = 0;
  readonly #pending = new Map<string, Pending>();
  readonly #richChannels = new Map<string, BrowserRichChannel>();
  readonly #tuiChannels = new Map<string, BrowserTuiChannel>();
  readonly #replayGaps = new Map<string, DashboardChannelEvent | DashboardTuiChannelEvent>();
  readonly #managedSessions = new Map<string, SessionResource>();

  constructor(options: BrowserDashboardClientOptions = {}) {
    this.#basePath = normalizeBasePath(options.basePath ?? DASH_API_BASE_PATH);
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#webSocketFactory = options.webSocket ?? ((url, protocol) => new WebSocket(url, protocol));
    this.#requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  }

  get clientId(): string | undefined { return this.#clientId; }
  get workspaceId(): string | undefined { return this.#workspaceId; }
  get authenticatedForMutations(): boolean { return this.#csrfToken !== undefined; }

  async login(credential: string, workspaceId?: string): Promise<DashboardBrowserSessionResource> {
    if (credential.length === 0) throw new DashboardBrowserClientError("login_required", "Enter the Dash web credential");
    const data = await this.#request<DashboardBrowserSessionResource>("POST", "/login", {
      requestId: this.#nextCorrelation("login"),
      clientId: this.#clientId ?? browserClientId(),
      ...(workspaceId === undefined ? {} : { workspaceId }),
      credential,
    }, false);
    this.#clientId = data.clientId;
    this.#workspaceId = data.workspaceId;
    this.#csrfToken = data.csrfToken;
    return data;
  }

  async logout(): Promise<void> {
    if (this.#clientId === undefined) return;
    await this.#request<JsonValue>("POST", "/logout", {}, true);
    this.#csrfToken = undefined;
    this.#capabilities = undefined;
    this.#clientId = undefined;
    this.#workspaceId = undefined;
    this.#dropSocket(new DashboardBrowserClientError("logged_out", "Dash browser session was revoked"), false);
  }

  async bootstrap(): Promise<DashboardBootstrapResource> {
    const { data, envelope } = await this.#requestEnvelope<DashboardBootstrapResource>("GET", "/bootstrap");
    this.#adoptEnvelope(envelope);
    this.#capabilities = data.capabilities;
    return data;
  }

  async capabilities(): Promise<DashboardCapabilities> {
    if (this.#capabilities !== undefined) return this.#capabilities;
    return (await this.bootstrap()).capabilities;
  }

  async listSessions(query: SessionInventoryQuery): Promise<SessionInventoryPage> {
    const search = new URLSearchParams();
    if (query.cursor !== undefined) search.set("cursor", query.cursor);
    if (query.limit !== undefined) search.set("limit", String(query.limit));
    if (query.search !== undefined) search.set("search", query.search);
    if (query.sourceKinds !== undefined) search.set("sourceKind", query.sourceKinds.join(","));
    if (query.runtime !== undefined) search.set("runtime", query.runtime.join(","));
    if (query.unread !== undefined) search.set("unread", String(query.unread));
    if (query.modifiedAfter !== undefined) search.set("modifiedAfter", query.modifiedAfter);
    return this.#request("GET", `/sessions${search.size === 0 ? "" : `?${search}`}`);
  }

  async getSessionInfo(inventoryId: string): Promise<SessionInfoResource> {
    const info = await this.#request<SessionInfoResource>("GET", `/sessions/${pathPart(inventoryId)}`);
    if (info.managed !== undefined) {
      const prior = this.#managedSessions.get(info.managed.sessionId);
      if (prior !== undefined) {
        this.#managedSessions.set(info.managed.sessionId, {
          ...prior,
          ...(info.managed.name === undefined ? {} : { name: info.managed.name }),
        });
      }
    }
    return info;
  }

  async getTranscript(inventoryId: string, query: TranscriptQuery): Promise<TranscriptPage> {
    const search = new URLSearchParams();
    if (query.cursor !== undefined) search.set("cursor", query.cursor);
    if (query.limit !== undefined) search.set("limit", String(query.limit));
    if (query.direction !== undefined) search.set("direction", query.direction);
    if (query.leafId !== undefined) search.set("leafId", query.leafId);
    return this.#request("GET", `/sessions/${pathPart(inventoryId)}/transcript${search.size === 0 ? "" : `?${search}`}`);
  }

  activateSession(inventoryId: string, request: ActivationRequest): Promise<ActivationTicket> {
    return this.#request("POST", `/sessions/${pathPart(inventoryId)}/activate`, request, true);
  }

  getActivation(ticketId: string): Promise<ActivationTicket> {
    return this.#request("GET", `/activation/${pathPart(ticketId)}`);
  }

  exportSession(sessionRef: string, request: SessionExportRequest): Promise<SessionExportTicket> {
    return this.#request("POST", `/sessions/${pathPart(sessionRef)}/export`, request, true);
  }

  getExport(ticketId: string): Promise<SessionExportTicket> {
    return this.#request("GET", `/export/${pathPart(ticketId)}`);
  }

  createSessionDraft(
    request: DashboardSessionDraftCreateRequest,
  ): Promise<DashboardSessionDraftResource> {
    return this.#request(
      "POST",
      "/session-drafts",
      request,
      true,
      draftMutationHeaders(request),
    );
  }

  getSessionDraft(draftId: string): Promise<DashboardSessionDraftResource> {
    return this.#request("GET", `/session-drafts/${pathPart(draftId)}`);
  }

  cancelSessionDraft(
    draftId: string,
    request: DashboardSessionDraftCancelRequest,
  ): Promise<DashboardSessionDraftResource> {
    return this.#request(
      "DELETE",
      `/session-drafts/${pathPart(draftId)}`,
      request,
      true,
      {
        ...draftMutationHeaders(request),
        "If-Match": dashboardSessionDraftEtag(draftId, request.expectedRevision),
      },
    );
  }

  sendSessionDraft(
    draftId: string,
    request: DashboardSessionDraftSendRequest,
  ): Promise<DashboardSessionDraftSendTicket> {
    return this.#request(
      "POST",
      `/session-drafts/${pathPart(draftId)}/send`,
      request,
      true,
      {
        ...draftMutationHeaders(request),
        "If-Match": dashboardSessionDraftEtag(draftId, request.expectedRevision),
      },
    );
  }

  getSessionDraftSend(ticketId: string): Promise<DashboardSessionDraftSendTicket> {
    return this.#request("GET", `/session-draft-send/${pathPart(ticketId)}`);
  }

  scheduleCapabilities(): Promise<ScheduleCapabilities> {
    return this.#request("GET", "/schedules/capabilities");
  }

  async listSchedules(sessionRef?: string): Promise<DashboardScheduleResource[]> {
    const query = sessionRef === undefined ? "" : `?session=${encodeURIComponent(sessionRef)}`;
    const result = await this.#request<{ schedules: DashboardScheduleResource[] }>("GET", `/schedules${query}`);
    return result.schedules;
  }

  getSchedule(scheduleId: string): Promise<DashboardScheduleResource> {
    return this.#request("GET", `/schedules/${pathPart(scheduleId)}`);
  }

  createSchedule(request: DashboardScheduleMutationRequest): Promise<DashboardScheduleResource> {
    return this.#request("POST", "/schedules", request, true, scheduleMutationHeaders(request));
  }

  updateSchedule(scheduleId: string, request: DashboardScheduleMutationRequest): Promise<DashboardScheduleResource> {
    if (request.expectedRevision === undefined) {
      return Promise.reject(new DashboardBrowserClientError("invalid_schedule_request", "expectedRevision is required"));
    }
    return this.#request("PUT", `/schedules/${pathPart(scheduleId)}`, request, true, {
      ...scheduleMutationHeaders(request),
      "If-Match": scheduleEtag(scheduleId, request.expectedRevision),
    });
  }

  deleteSchedule(scheduleId: string, request: DashboardScheduleDeleteRequest): Promise<void> {
    return this.#request<{ deleted: true }>("DELETE", `/schedules/${pathPart(scheduleId)}`, request, true, {
      ...scheduleMutationHeaders(request),
      "If-Match": scheduleEtag(scheduleId, request.expectedRevision),
    }).then(() => undefined);
  }

  scheduleStatus(): Promise<DashboardScheduleStatus> {
    return this.#request("GET", "/schedules/status");
  }

  async getManagedSession(sessionRef: string): Promise<SessionResource> {
    const session = this.#managedSessions.get(sessionRef);
    if (session === undefined) {
      throw new DashboardBrowserClientError(
        "session_not_attached",
        "Managed session details become available after a live subscription is ready",
        true,
      );
    }
    return structuredClone(session);
  }

  async openSessionChannel(options: SessionChannelOptions): Promise<DashboardChannel> {
    this.#requireIdentity();
    const channel = new BrowserRichChannel(this, this.#nextSubscriptionId("rich"), options);
    this.#richChannels.set(channel.subscriptionId, channel);
    try {
      await this.#subscribe(channel);
      return channel;
    } catch (error) {
      this.#richChannels.delete(channel.subscriptionId);
      throw error;
    }
  }

  async openTuiChannel(options: TuiChannelOptions): Promise<DashboardTuiChannel> {
    this.#requireIdentity();
    const channel = new BrowserTuiChannel(this, this.#nextSubscriptionId("tui"), options);
    this.#tuiChannels.set(channel.subscriptionId, channel);
    try {
      await this.#subscribe(channel);
      return channel;
    } catch (error) {
      this.#tuiChannels.delete(channel.subscriptionId);
      throw error;
    }
  }

  getWorkspace(workspaceId: string): Promise<DashboardWorkspaceResource> {
    return this.#request("GET", `/workspaces/${pathPart(workspaceId)}`);
  }

  updateWorkspace(request: DashboardWorkspaceUpdateRequest): Promise<DashboardWorkspaceResource> {
    const workspaceId = this.#requireIdentity().workspaceId;
    return this.#request<DashboardWorkspaceResource>("PUT", `/workspaces/${pathPart(workspaceId)}`, request, true, {
      "If-Match": workspaceEtag(workspaceId, request.expectedRevision),
    }).catch((error: unknown) => {
      if (error instanceof DashboardBrowserClientError && error.code === "revision_conflict") {
        throw new DashboardRevisionConflict("workspace", request.expectedRevision);
      }
      throw error;
    });
  }

  getSettings(): Promise<DashboardSettingsResource> {
    return this.#request("GET", "/settings");
  }

  patchSettings(request: DashboardSettingsPatchRequest): Promise<DashboardSettingsResource> {
    return this.#request<DashboardSettingsResource>("PATCH", "/settings", request, true, {
      "If-Match": settingsEtag(request.expectedRevision),
    }).catch((error: unknown) => {
      if (error instanceof DashboardBrowserClientError && error.code === "revision_conflict") {
        throw new DashboardRevisionConflict("settings", request.expectedRevision);
      }
      throw error;
    });
  }

  resetSettings(expectedRevision: number): Promise<DashboardSettingsResource> {
    return this.#request<DashboardSettingsResource>("DELETE", "/settings", undefined, true, {
      "If-Match": settingsEtag(expectedRevision),
      "X-Expected-Revision": String(expectedRevision),
      "Idempotency-Key": this.#nextCorrelation("settings-reset"),
    }).catch((error: unknown) => {
      if (error instanceof DashboardBrowserClientError && error.code === "revision_conflict") {
        throw new DashboardRevisionConflict("settings", expectedRevision);
      }
      throw error;
    });
  }

  async close(): Promise<void> {
    this.#closed = true;
    if (this.#reconnectTimer !== undefined) globalThis.clearTimeout(this.#reconnectTimer);
    const channels = [...this.#richChannels.values(), ...this.#tuiChannels.values()];
    this.#richChannels.clear();
    this.#tuiChannels.clear();
    for (const channel of channels) channel.markClosed();
    this.#dropSocket(new DashboardBrowserClientError("backend_closed", "Dashboard browser client closed"), false);
  }

  command(channel: BrowserRichChannel, command: DashboardCommand): Promise<DashboardCommandResult> {
    return this.#sendCommand({
      ...this.#baseFrame("command", command.correlationId),
      subscriptionId: channel.subscriptionId,
      operation: command.operation,
      ...(command.idempotencyKey === undefined ? {} : { idempotencyKey: command.idempotencyKey }),
      ...(command.payload === undefined ? {} : { payload: command.payload }),
    });
  }

  control(channel: BrowserRichChannel | BrowserTuiChannel, action: "request" | "release", correlationId: string): Promise<DashboardCommandResult> {
    return this.#sendCommand({
      ...this.#baseFrame("control", correlationId),
      subscriptionId: channel.subscriptionId,
      action,
    });
  }

  extensionResponse(channel: BrowserRichChannel, requestId: string, response: JsonObject): Promise<void> {
    const correlationId = this.#nextCorrelation("extension");
    return this.#sendCommand({
      ...this.#baseFrame("extension_ui_response", correlationId),
      subscriptionId: channel.subscriptionId,
      requestId,
      response,
    }).then(() => undefined);
  }

  tuiResize(channel: BrowserTuiChannel, dimensions: TuiDimensions): Promise<void> {
    const correlationId = this.#nextCorrelation("tui-resize");
    return this.#sendCommand({
      ...this.#baseFrame("tui_resize", correlationId),
      subscriptionId: channel.subscriptionId,
      dimensions,
    }).then(() => undefined);
  }

  tuiInput(channel: BrowserTuiChannel, input: DashboardTuiInput): Promise<void> {
    const correlationId = this.#nextCorrelation("tui-input");
    return this.#sendCommand({
      ...this.#baseFrame("tui_input", correlationId),
      subscriptionId: channel.subscriptionId,
      input,
    }).then(() => undefined);
  }

  async removeChannel(channel: BrowserRichChannel | BrowserTuiChannel): Promise<void> {
    const map = channel.presentation === "rich" ? this.#richChannels : this.#tuiChannels;
    map.delete(channel.subscriptionId);
    this.#replayGaps.delete(channel.subscriptionId);
    if (this.#socket?.readyState === WebSocket.OPEN && this.#socketReady !== undefined) {
      const correlationId = this.#nextCorrelation("unsubscribe");
      this.#send({
        ...this.#baseFrame("unsubscribe", correlationId),
        subscriptionId: channel.subscriptionId,
      });
    }
  }

  async #subscribe(channel: BrowserRichChannel | BrowserTuiChannel): Promise<void> {
    await this.#ensureSocket();
    const correlationId = this.#nextCorrelation("subscribe");
    const ready = new Promise<DashStreamServerFrame>((resolve, reject) => {
      this.#pending.set(correlationId, { kind: "frame", resolve, reject });
    });
    const common = {
      ...this.#baseFrame("subscribe", correlationId),
      subscriptionId: channel.subscriptionId,
      presentation: channel.presentation,
      sessionRef: channel.sessionRef,
      ...(channel.generation === undefined ? {} : { generation: channel.generation }),
      role: channel.requestedRole,
      ...(channel.cursor === undefined ? {} : { cursor: channel.cursor }),
    } as const;
    this.#send(channel.presentation === "rich"
      ? common
      : { ...common, tuiDimensions: channel.dimensions });
    let frame: DashStreamServerFrame;
    try {
      frame = await ready;
    } finally {
      this.#pending.delete(correlationId);
    }
    if (frame.kind !== "subscription_ready" || frame.subscriptionId !== channel.subscriptionId) {
      throw new DashboardBrowserClientError("stream_protocol_error", "Expected a matching subscription snapshot");
    }
    channel.acceptReady(frame);
    if (channel.presentation === "rich") this.#managedSessions.set(channel.snapshot.session.sessionId, structuredClone(channel.snapshot.session));
    const gap = this.#replayGaps.get(channel.subscriptionId);
    if (gap !== undefined) {
      this.#replayGaps.delete(channel.subscriptionId);
      channel.deliver(gap as never);
    }
  }

  async #resubscribeAll(): Promise<void> {
    const channels = [
      ...[...this.#richChannels.values()].filter((channel) => !channel.closed),
      ...[...this.#tuiChannels.values()].filter((channel) => !channel.closed),
    ];
    for (const channel of channels) {
      try {
        await this.#subscribe(channel);
      } catch (error) {
        channel.connectionFailed(asClientError(error));
      }
    }
  }

  async #sendCommand(frame: DashStreamClientFrame): Promise<DashboardCommandResult> {
    await this.#ensureSocket();
    const correlationId = frame.correlationId;
    const result = new Promise<DashboardCommandResult>((resolve, reject) => {
      this.#pending.set(correlationId, { kind: "command", resolve, reject });
    });
    try {
      this.#send(frame);
      return await result;
    } finally {
      this.#pending.delete(correlationId);
    }
  }

  async #ensureSocket(): Promise<void> {
    if (this.#closed) throw new DashboardBrowserClientError("backend_closed", "Dashboard browser client is closed");
    this.#requireIdentity();
    if (this.#socket?.readyState === WebSocket.OPEN && this.#socketReady !== undefined) return this.#socketReady;
    if (this.#socketReady !== undefined) return this.#socketReady;

    const protocol = globalThis.location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${protocol}//${globalThis.location.host}${this.#basePath}/stream`;
    const socket = this.#webSocketFactory(url, DASH_STREAM_SUBPROTOCOL);
    this.#socket = socket;
    this.#socketReady = new Promise<void>((resolve, reject) => {
      this.#socketReadyResolve = resolve;
      this.#socketReadyReject = reject;
    });
    socket.addEventListener("open", () => {
      if (socket !== this.#socket) return;
      const correlationId = this.#nextCorrelation("hello");
      this.#helloCorrelation = correlationId;
      this.#send({
        ...this.#baseFrame("hello", correlationId),
        requestedVersion: DASH_API_VERSION,
      });
    }, { once: true });
    socket.addEventListener("message", (event) => this.#onSocketMessage(socket, event.data));
    socket.addEventListener("error", () => undefined);
    socket.addEventListener("close", () => this.#onSocketClose(socket), { once: true });
    return this.#socketReady;
  }

  #onSocketMessage(socket: WebSocket, data: unknown): void {
    if (socket !== this.#socket || typeof data !== "string") return;
    let frame: DashStreamServerFrame;
    try {
      frame = JSON.parse(data) as DashStreamServerFrame;
      this.#assertServerFrame(frame);
    } catch {
      this.#dropSocket(new DashboardBrowserClientError("stream_protocol_error", "Dashboard stream returned an invalid frame"), true);
      return;
    }
    if (frame.kind === "ready" && frame.correlationId === this.#helloCorrelation) {
      this.#capabilities = frame.capabilities;
      this.#helloCorrelation = undefined;
      this.#reconnectAttempt = 0;
      this.#socketReadyResolve?.();
      this.#socketReadyResolve = undefined;
      this.#socketReadyReject = undefined;
      return;
    }
    if (frame.kind === "error") {
      const error = new DashboardBrowserClientError(frame.error.code, frame.error.message, frame.error.retryable);
      const pending = this.#pending.get(frame.correlationId);
      pending?.reject(error);
      return;
    }
    if (frame.kind === "subscription_ready") {
      this.#pending.get(frame.correlationId)?.kind === "frame"
        ? (this.#pending.get(frame.correlationId) as PendingFrame).resolve(frame)
        : undefined;
      return;
    }
    if (frame.kind === "command_result") {
      const pending = this.#pending.get(frame.correlationId);
      if (pending?.kind === "command") pending.resolve(frame.result);
      return;
    }
    if (frame.kind === "replay_gap") {
      const channel = this.#channel(frame.subscriptionId);
      if (channel !== undefined) this.#replayGaps.set(frame.subscriptionId, frame.gap);
      return;
    }
    if (frame.kind === "session_event") {
      const rich = this.#richChannels.get(frame.subscriptionId);
      if (rich !== undefined) rich.deliver(frame.event);
      else if (frame.event.kind === "control") this.#tuiChannels.get(frame.subscriptionId)?.deliver(frame.event);
      return;
    }
    if (frame.kind === "tui_delta") {
      const channel = this.#tuiChannels.get(frame.subscriptionId);
      channel?.deliver(frame.delta);
    }
  }

  #onSocketClose(socket: WebSocket): void {
    if (socket !== this.#socket) return;
    const error = new DashboardBrowserClientError("stream_disconnected", "Dashboard stream disconnected", true);
    this.#socket = undefined;
    this.#socketReadyReject?.(error);
    this.#socketReady = undefined;
    this.#socketReadyResolve = undefined;
    this.#socketReadyReject = undefined;
    this.#helloCorrelation = undefined;
    for (const [id, pending] of this.#pending) {
      if (pending.kind === "command") {
        pending.resolve({ correlationId: id, state: "indeterminate", error: { code: error.code, message: error.message, retryable: true } });
      } else {
        pending.reject(error);
      }
    }
    this.#pending.clear();
    if (!this.#closed && (this.#richChannels.size > 0 || this.#tuiChannels.size > 0)) this.#scheduleReconnect();
  }

  #scheduleReconnect(): void {
    if (this.#reconnectTimer !== undefined || this.#closed || (this.#richChannels.size === 0 && this.#tuiChannels.size === 0)) return;
    const delay = RECONNECT_DELAYS_MS[Math.min(this.#reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)] ?? 5_000;
    this.#reconnectAttempt += 1;
    this.#reconnectTimer = globalThis.setTimeout(() => {
      this.#reconnectTimer = undefined;
      if (this.#closed || (this.#richChannels.size === 0 && this.#tuiChannels.size === 0)) return;
      void this.#ensureSocket()
        .then(() => this.#resubscribeAll())
        .catch(() => this.#scheduleReconnect());
    }, delay);
  }

  #dropSocket(error: Error, reconnect: boolean): void {
    const socket = this.#socket;
    this.#socket = undefined;
    this.#socketReadyReject?.(error);
    this.#socketReady = undefined;
    this.#socketReadyResolve = undefined;
    this.#socketReadyReject = undefined;
    this.#helloCorrelation = undefined;
    if (socket !== undefined && socket.readyState < WebSocket.CLOSING) socket.close(1000, "dashboard client reset");
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
    if (reconnect) this.#scheduleReconnect();
  }

  #send(frame: DashStreamClientFrame): void {
    const socket = this.#socket;
    if (socket?.readyState !== WebSocket.OPEN) throw new DashboardBrowserClientError("stream_unavailable", "Dashboard stream is unavailable", true);
    socket.send(JSON.stringify(frame));
  }

  #channel(subscriptionId: string): BrowserRichChannel | BrowserTuiChannel | undefined {
    return this.#richChannels.get(subscriptionId) ?? this.#tuiChannels.get(subscriptionId);
  }

  #assertServerFrame(frame: DashStreamServerFrame): void {
    const identity = this.#requireIdentity();
    if (
      typeof frame !== "object" || frame === null ||
      frame.dashVersion !== DASH_API_VERSION ||
      frame.clientId !== identity.clientId ||
      frame.workspaceId !== identity.workspaceId ||
      typeof frame.correlationId !== "string" ||
      typeof frame.kind !== "string"
    ) throw new Error("invalid frame");
  }

  #baseFrame<K extends DashStreamClientFrame["kind"]>(kind: K, correlationId: string) {
    const identity = this.#requireIdentity();
    return {
      dashVersion: DASH_API_VERSION,
      kind,
      clientId: identity.clientId,
      workspaceId: identity.workspaceId,
      correlationId,
    } as const;
  }

  #requireIdentity(): { clientId: string; workspaceId: string } {
    if (this.#clientId === undefined || this.#workspaceId === undefined) {
      throw new DashboardBrowserClientError("login_required", "Dash browser session is not authenticated");
    }
    return { clientId: this.#clientId, workspaceId: this.#workspaceId };
  }

  #adoptEnvelope(envelope: DashboardSuccessEnvelope<unknown>): void {
    if (envelope.clientId === "unauthenticated" || envelope.workspaceId === "unauthenticated") return;
    if (this.#clientId !== undefined && this.#clientId !== envelope.clientId) {
      this.#dropSocket(new DashboardBrowserClientError("identity_changed", "Dash browser identity changed"), false);
    }
    this.#clientId = envelope.clientId;
    this.#workspaceId = envelope.workspaceId;
  }

  #nextCorrelation(prefix: string): string {
    this.#correlationSequence += 1;
    return `${prefix}-${Date.now().toString(36)}-${this.#correlationSequence.toString(36)}`;
  }

  #nextSubscriptionId(prefix: string): string {
    this.#subscriptionSequence += 1;
    return `${prefix}-${this.#subscriptionSequence.toString(36)}-${crypto.randomUUID()}`;
  }

  async #request<T>(
    method: string,
    path: string,
    body?: unknown,
    mutation = false,
    headers: Record<string, string> = {},
  ): Promise<T> {
    return (await this.#requestEnvelope<T>(method, path, body, mutation, headers)).data;
  }

  async #requestEnvelope<T>(
    method: string,
    path: string,
    body?: unknown,
    mutation = false,
    headers: Record<string, string> = {},
  ): Promise<{ data: T; envelope: DashboardSuccessEnvelope<T> }> {
    if (mutation && this.#csrfToken === undefined) {
      throw new DashboardBrowserClientError("login_required", "Re-authenticate before changing Dash state");
    }
    const controller = new AbortController();
    const timer = globalThis.setTimeout(() => controller.abort(), this.#requestTimeoutMs);
    try {
      const response = await this.#fetch(`${this.#basePath}${path}`, {
        method,
        credentials: "same-origin",
        cache: "no-store",
        signal: controller.signal,
        headers: {
          Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          ...(mutation && this.#csrfToken !== undefined ? { [CSRF_HEADER]: this.#csrfToken } : {}),
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      let envelope: DashboardSuccessEnvelope<T> | DashboardErrorEnvelope;
      try {
        envelope = await response.json() as DashboardSuccessEnvelope<T> | DashboardErrorEnvelope;
      } catch {
        throw new DashboardBrowserClientError("invalid_response", "Dashboard returned a non-JSON response", response.status >= 500, response.status);
      }
      if (envelope.dashVersion !== DASH_API_VERSION) {
        throw new DashboardBrowserClientError("version_mismatch", "Dashboard protocol version is incompatible", false, response.status);
      }
      if (!response.ok || envelope.ok !== true) {
        const error = envelope.ok === false
          ? envelope.error
          : { code: "http_error", message: `Dashboard request failed (${response.status})`, retryable: response.status >= 500 };
        throw new DashboardBrowserClientError(error.code, error.message, error.retryable, response.status);
      }
      this.#adoptEnvelope(envelope);
      return { data: envelope.data, envelope };
    } catch (error) {
      if (error instanceof DashboardBrowserClientError) throw error;
      if (error instanceof DOMException && error.name === "AbortError") {
        throw new DashboardBrowserClientError("request_timeout", "Dashboard request timed out", true);
      }
      throw new DashboardBrowserClientError("network_error", error instanceof Error ? error.message : "Dashboard request failed", true);
    } finally {
      globalThis.clearTimeout(timer);
    }
  }
}

abstract class BrowserChannelBase {
  #role: DashboardControllerRole;
  #identity: DashboardSessionIdentity | undefined;
  #cursor: DashboardCursor | undefined;
  #closed = false;

  constructor(
    readonly client: BrowserDashboardClient,
    readonly subscriptionId: string,
    readonly sessionRef: string,
    readonly generation: number | undefined,
    readonly requestedRole: DashboardControllerRole,
  ) {
    this.#role = "observer";
  }

  get role(): DashboardControllerRole { return this.#role; }
  get identity(): DashboardSessionIdentity {
    if (this.#identity === undefined) throw new DashboardBrowserClientError("channel_not_ready", "Dashboard channel is not ready", true);
    return this.#identity;
  }
  get cursor(): DashboardCursor | undefined { return this.#cursor; }
  get closed(): boolean { return this.#closed; }

  acceptBase(identity: DashboardSessionIdentity, role: DashboardControllerRole, cursor: DashboardCursor): void {
    this.#identity = identity;
    this.#role = role;
    this.#cursor = cursor;
  }

  acceptEvent(event: DashboardChannelEvent | DashboardTuiChannelEvent): void {
    if (event.kind === "control") this.#role = event.action === "control_granted" ? "controller" : "observer";
    if (event.kind === "session_event" || event.kind === "tui_delta") this.#cursor = event.cursor;
    if (event.kind === "replay_gap") this.#cursor = event.highWaterCursor;
  }

  markClosed(): void { this.#closed = true; }

  connectionFailed(error: DashboardBrowserClientError): void {
    if (!this.#closed) this.onConnectionFailed(error);
  }

  protected abstract onConnectionFailed(error: DashboardBrowserClientError): void;
}

class BrowserRichChannel extends BrowserChannelBase implements DashboardChannel {
  readonly presentation = "rich" as const;
  readonly #listeners = new Set<RichListener>();
  readonly #queued: DashboardChannelEvent[] = [];
  #snapshot: DashboardChannelSnapshot | undefined;

  constructor(client: BrowserDashboardClient, subscriptionId: string, options: SessionChannelOptions) {
    super(client, subscriptionId, options.sessionRef, options.generation, options.role);
  }

  get snapshot(): DashboardChannelSnapshot {
    if (this.#snapshot === undefined) throw new DashboardBrowserClientError("channel_not_ready", "Dashboard channel is not ready", true);
    return this.#snapshot;
  }

  acceptReady(frame: Extract<DashStreamServerFrame, { kind: "subscription_ready" }>): void {
    if (frame.presentation !== "rich" || !isRichSnapshot(frame.snapshot)) throw new DashboardBrowserClientError("stream_protocol_error", "Rich subscription snapshot is invalid");
    this.#snapshot = structuredClone(frame.snapshot);
    this.acceptBase(frame.identity, frame.role, frame.highWaterCursor);
  }

  command(command: DashboardCommand): Promise<DashboardCommandResult> { return this.client.command(this, command); }
  requestControl(correlationId: string): Promise<DashboardCommandResult> { return this.client.control(this, "request", correlationId); }
  releaseControl(correlationId: string): Promise<DashboardCommandResult> { return this.client.control(this, "release", correlationId); }
  answerExtensionUi(requestId: string, response: JsonObject): Promise<void> { return this.client.extensionResponse(this, requestId, response); }

  subscribe(listener: RichListener): () => void {
    this.#listeners.add(listener);
    for (const event of this.#queued.splice(0)) listener(structuredClone(event));
    return () => this.#listeners.delete(listener);
  }

  deliver(event: DashboardChannelEvent): void {
    if (this.closed || !sameIdentity(event.identity, this.identity)) return;
    this.acceptEvent(event);
    if (this.#listeners.size === 0) this.#queued.push(structuredClone(event));
    else for (const listener of this.#listeners) listener(structuredClone(event));
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.markClosed();
    this.#listeners.clear();
    this.#queued.length = 0;
    await this.client.removeChannel(this);
  }

  protected onConnectionFailed(error: DashboardBrowserClientError): void {
    const cursor = this.cursor;
    if (cursor === undefined) return;
    this.deliver({
      kind: "replay_gap",
      identity: this.identity,
      reason: "host-restarted",
      requestedCursor: cursor,
      highWaterCursor: cursor,
      snapshotFollows: true,
    });
    void error;
  }
}

class BrowserTuiChannel extends BrowserChannelBase implements DashboardTuiChannel {
  readonly presentation = "tui" as const;
  readonly dimensions: TuiDimensions;
  readonly #listeners = new Set<TuiListener>();
  readonly #queued: DashboardTuiChannelEvent[] = [];
  #snapshot: DashboardTuiSnapshot | undefined;

  constructor(client: BrowserDashboardClient, subscriptionId: string, options: TuiChannelOptions) {
    super(client, subscriptionId, options.sessionRef, options.generation, options.role);
    this.dimensions = { ...options.dimensions };
  }

  get snapshot(): DashboardTuiSnapshot {
    if (this.#snapshot === undefined) throw new DashboardBrowserClientError("channel_not_ready", "Dashboard TUI channel is not ready", true);
    return this.#snapshot;
  }

  acceptReady(frame: Extract<DashStreamServerFrame, { kind: "subscription_ready" }>): void {
    if (frame.presentation !== "tui" || !isTuiSnapshot(frame.snapshot)) throw new DashboardBrowserClientError("stream_protocol_error", "TUI subscription snapshot is invalid");
    this.#snapshot = structuredClone(frame.snapshot);
    this.acceptBase(frame.identity, frame.role, frame.highWaterCursor);
  }

  resize(dimensions: TuiDimensions): Promise<void> { return this.client.tuiResize(this, dimensions); }
  sendInput(input: DashboardTuiInput): Promise<void> { return this.client.tuiInput(this, input); }
  requestControl(correlationId: string): Promise<DashboardCommandResult> { return this.client.control(this, "request", correlationId); }
  releaseControl(correlationId: string): Promise<DashboardCommandResult> { return this.client.control(this, "release", correlationId); }

  subscribe(listener: TuiListener): () => void {
    this.#listeners.add(listener);
    for (const event of this.#queued.splice(0)) listener(structuredClone(event));
    return () => this.#listeners.delete(listener);
  }

  deliver(event: DashboardTuiChannelEvent): void {
    if (this.closed || !sameIdentity(event.identity, this.identity)) return;
    this.acceptEvent(event);
    if (event.kind === "tui_delta" && this.#snapshot !== undefined) {
      this.#snapshot = applyTuiDelta(this.#snapshot, event);
    }
    if (this.#listeners.size === 0) this.#queued.push(structuredClone(event));
    else for (const listener of this.#listeners) listener(structuredClone(event));
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.markClosed();
    this.#listeners.clear();
    this.#queued.length = 0;
    await this.client.removeChannel(this);
  }

  protected onConnectionFailed(error: DashboardBrowserClientError): void {
    const cursor = this.cursor;
    if (cursor === undefined) return;
    this.deliver({
      kind: "replay_gap",
      identity: this.identity,
      reason: "host-restarted",
      requestedCursor: cursor,
      highWaterCursor: cursor,
      snapshotFollows: true,
    });
    void error;
  }
}

function applyTuiDelta(snapshot: DashboardTuiSnapshot, delta: Extract<DashboardTuiChannelEvent, { kind: "tui_delta" }>): DashboardTuiSnapshot {
  const rows = new Map(snapshot.rows.map((row) => [row.row, row]));
  for (const row of delta.changedRows) rows.set(row.row, row);
  return {
    ...snapshot,
    dimensions: delta.dimensions,
    rows: [...rows.values()].sort((left, right) => left.row - right.row),
    cursor: delta.cursorState,
    ...(delta.title === undefined ? {} : { title: delta.title }),
    highWaterCursor: delta.cursor,
  };
}

function isRichSnapshot(value: DashboardChannelSnapshot | DashboardTuiSnapshot): value is DashboardChannelSnapshot {
  return "session" in value && "entries" in value;
}

function isTuiSnapshot(value: DashboardChannelSnapshot | DashboardTuiSnapshot): value is DashboardTuiSnapshot {
  return "dimensions" in value && "rows" in value;
}

function sameIdentity(left: DashboardSessionIdentity, right: DashboardSessionIdentity): boolean {
  return left.hostInstanceId === right.hostInstanceId && left.sessionId === right.sessionId && left.generation === right.generation;
}

function normalizeBasePath(path: string): string {
  const trimmed = path.endsWith("/") ? path.slice(0, -1) : path;
  if (!trimmed.startsWith("/") || trimmed.includes("..")) throw new Error("dashboard basePath must be an absolute same-origin path");
  return trimmed;
}

function pathPart(value: string): string {
  if (value.length === 0) throw new DashboardBrowserClientError("invalid_request", "Dashboard resource identifier is empty");
  return encodeURIComponent(value);
}

function browserClientId(): string {
  return `browser-${crypto.randomUUID()}`;
}

function workspaceEtag(workspaceId: string, revision: number): string {
  return `"workspace:${workspaceId}:${revision}"`;
}

function settingsEtag(revision: number): string {
  return `"settings:${revision}"`;
}

function draftMutationHeaders(request: { requestId: string; idempotencyKey: string }): Record<string, string> {
  return {
    "X-Request-ID": request.requestId,
    "Idempotency-Key": request.idempotencyKey,
  };
}

function scheduleMutationHeaders(request: { requestId: string; idempotencyKey: string }): Record<string, string> {
  return {
    "X-Request-ID": request.requestId,
    "Idempotency-Key": request.idempotencyKey,
  };
}

function scheduleEtag(scheduleId: string, revision: number): string {
  const bytes = new TextEncoder().encode(scheduleId);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `"${btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/gu, "")}:${revision}"`;
}

function asClientError(error: unknown): DashboardBrowserClientError {
  return error instanceof DashboardBrowserClientError
    ? error
    : new DashboardBrowserClientError("dashboard_error", error instanceof Error ? error.message : "Dashboard operation failed", true);
}
