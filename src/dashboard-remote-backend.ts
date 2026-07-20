import { randomUUID } from "node:crypto";

import WebSocket, { type RawData } from "ws";

import {
  DASH_API_VERSION,
  DASH_DEFAULT_LIMITS,
  DASH_PERFORMANCE_BUDGETS,
  DASH_STREAM_SUBPROTOCOL,
  asDashboardCursor,
  type ActivationRequest,
  type ActivationTicket,
  type DashboardBackend,
  type DashboardCapabilities,
  type DashboardChannel,
  type DashboardChannelEvent,
  type DashboardChannelListener,
  type DashboardCommand,
  type DashboardCommandOperation,
  type DashboardCommandResult,
  type DashboardControlEvent,
  type DashboardCursor,
  type DashboardExtensionUiEvent,
  type DashboardFingerprint,
  type DashboardReplayGap,
  type DashboardScheduleDeleteRequest,
  type DashboardScheduleMutationRequest,
  type DashboardScheduleResource,
  type DashboardScheduleStatus,
  type DashboardServiceCapabilities,
  type DashboardSessionEvent,
  type DashboardSessionIdentity,
  type DashboardTuiChannel,
  type DashboardTuiChannelEvent,
  type DashboardTuiInput,
  type DashboardTuiSnapshot,
  type NormalizedTranscriptRecord,
  type SessionChannelOptions,
  type SessionExportRequest,
  type SessionExportTicket,
  type SessionInfoResource,
  type SessionInventoryPage,
  type SessionInventoryQuery,
  type TranscriptPage,
  type TranscriptQuery,
  type TuiChannelOptions,
  type TuiDimensions,
} from "./dashboard-contract.js";
import { DEFAULT_SCHEDULE_LIMITS, type ScheduleCapabilities } from "./schedule-contract.js";
import type {
  DashboardSessionDraftCancelRequest,
  DashboardSessionDraftCreateRequest,
  DashboardSessionDraftResource,
  DashboardSessionDraftSendRequest,
  DashboardSessionDraftSendTicket,
} from "./dashboard-session-drafts.js";
import { browserScheduleResource, scheduleEtag } from "./dashboard-schedule-resources.js";
import type {
  JsonObject,
  JsonValue,
  PiRpcEvent,
  PiRpcResponse,
  RpcAttachReadyFrame,
  RpcControlFrame,
  RpcEventFrame,
  RpcReplayGapFrame,
  SessionResource,
} from "./session-api.js";
import {
  SessionApiClientError,
  type SessionApiClient,
} from "./session-client.js";

const READ_ONLY_COMMANDS = new Set<DashboardCommandOperation>([
  "get_state",
  "get_entries",
  "get_session_stats",
  "get_commands",
  "get_available_models",
  "get_tree",
]);

const DASHBOARD_COMMANDS: readonly DashboardCommandOperation[] = [
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
  "set_steering_mode",
  "set_follow_up_mode",
  "compact",
  "set_auto_compaction",
  "set_auto_retry",
  "abort_retry",
  "set_session_name",
  "get_tree",
  "fork",
  "clone",
];

export interface RemoteDashboardBackendClient extends Pick<
  SessionApiClient,
  | "dashboardCapabilities"
  | "listDashboardSessions"
  | "getDashboardSession"
  | "getDashboardTranscript"
  | "activateDashboardSession"
  | "getDashboardActivation"
  | "exportDashboardSession"
  | "getDashboardExport"
  | "createDashboardSessionDraft"
  | "getDashboardSessionDraft"
  | "cancelDashboardSessionDraft"
  | "sendDashboardSessionDraft"
  | "getDashboardSessionDraftSend"
  | "scheduleCapabilities"
  | "listSchedules"
  | "getSchedule"
  | "createSchedule"
  | "updateSchedule"
  | "deleteSchedule"
  | "scheduleStatus"
  | "getSession"
  | "createDashboardRpcSocket"
  | "createDashboardTuiSocket"
> {}

export interface RemoteDashboardBackendLimits {
  maxRichHubs: number;
  maxTuiHubs: number;
  maxChannelsPerHub: number;
  maxReplayEvents: number;
  maxReplayBytes: number;
  maxEventBytes: number;
  maxCommandResults: number;
  maxInFlightCommands: number;
  reconnectAttempts: number;
  reconnectBaseDelayMs: number;
  reconnectMaxDelayMs: number;
  operationTimeoutMs: number;
}

export const DEFAULT_REMOTE_DASHBOARD_LIMITS: Readonly<RemoteDashboardBackendLimits> = {
  maxRichHubs: 64,
  maxTuiHubs: 32,
  maxChannelsPerHub: DASH_DEFAULT_LIMITS.maxSubscriptionsPerConnection,
  maxReplayEvents: DASH_DEFAULT_LIMITS.maxReplayEvents,
  maxReplayBytes: DASH_DEFAULT_LIMITS.maxReplayBytesPerSession,
  maxEventBytes: DASH_DEFAULT_LIMITS.maxReplayEventBytes,
  maxCommandResults: 128,
  maxInFlightCommands: DASH_DEFAULT_LIMITS.maxInFlightCommandsPerConnection,
  reconnectAttempts: 8,
  reconnectBaseDelayMs: 100,
  reconnectMaxDelayMs: 5_000,
  operationTimeoutMs: 30_000,
};

export interface RemoteDashboardBackendOptions {
  client: RemoteDashboardBackendClient;
  limits?: Partial<RemoteDashboardBackendLimits>;
}

export class RemoteDashboardBackendError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, message: string, retryable = false) {
    super(message);
    this.name = "RemoteDashboardBackendError";
    this.code = code;
    this.retryable = retryable;
  }
}

interface RetainedEvent<T> {
  cursor?: DashboardCursor;
  event: T;
  bytes: number;
}

/**
 * Dedicated DashboardBackend over the authenticated neutral REST API and the
 * daemon's framed RPC/TUI attachment protocols. One upstream attachment is
 * shared per session generation and presentation; browser pane identity and
 * controller arbitration remain local to the DashboardServer process.
 */
export class RemoteDashboardBackend implements DashboardBackend {
  readonly #client: RemoteDashboardBackendClient;
  readonly #limits: RemoteDashboardBackendLimits;
  readonly #richHubs = new Map<string, Promise<RemoteRichHub>>();
  readonly #tuiHubs = new Map<string, Promise<RemoteTuiHub>>();
  #capabilities: Promise<DashboardCapabilities> | undefined;
  #disposed = false;

  constructor(options: RemoteDashboardBackendOptions) {
    this.#client = options.client;
    this.#limits = resolveLimits(options.limits);
  }

  capabilities(): Promise<DashboardCapabilities> {
    this.#assertOpen();
    this.#capabilities ??= this.#client.dashboardCapabilities()
      .then((result) => dashboardCapabilities(result.data, this.#limits))
      .catch((error: unknown) => {
        this.#capabilities = undefined;
        throw remoteError(error);
      });
    return this.#capabilities.then((value) => structuredClone(value));
  }

  async listSessions(query: SessionInventoryQuery): Promise<SessionInventoryPage> {
    this.#assertOpen();
    return this.#call(() => this.#client.listDashboardSessions(query));
  }

  async getSessionInfo(inventoryId: string): Promise<SessionInfoResource> {
    this.#assertOpen();
    return this.#call(() => this.#client.getDashboardSession(inventoryId));
  }

  async getTranscript(inventoryId: string, query: TranscriptQuery): Promise<TranscriptPage> {
    this.#assertOpen();
    const info = await this.getSessionInfo(inventoryId);
    return this.#pagedTranscript(
      inventoryId,
      query,
      info.source.fingerprint?.value,
    );
  }

  async activateSession(
    inventoryId: string,
    request: ActivationRequest,
  ): Promise<ActivationTicket> {
    this.#assertOpen();
    return this.#call(() => this.#client.activateDashboardSession(inventoryId, request));
  }

  async getActivation(ticketId: string): Promise<ActivationTicket> {
    this.#assertOpen();
    return this.#call(() => this.#client.getDashboardActivation(ticketId));
  }

  async exportSession(
    sessionRef: string,
    request: SessionExportRequest,
  ): Promise<SessionExportTicket> {
    this.#assertOpen();
    return this.#call(() => this.#client.exportDashboardSession(sessionRef, request));
  }

  async getExport(ticketId: string): Promise<SessionExportTicket> {
    this.#assertOpen();
    return this.#call(() => this.#client.getDashboardExport(ticketId));
  }

  async createSessionDraft(
    request: DashboardSessionDraftCreateRequest,
  ): Promise<DashboardSessionDraftResource> {
    this.#assertOpen();
    await this.#assertDrafts();
    return this.#call(() => this.#client.createDashboardSessionDraft(request));
  }

  async getSessionDraft(draftId: string): Promise<DashboardSessionDraftResource> {
    this.#assertOpen();
    await this.#assertDrafts();
    return this.#call(() => this.#client.getDashboardSessionDraft(draftId));
  }

  async cancelSessionDraft(
    draftId: string,
    request: DashboardSessionDraftCancelRequest,
  ): Promise<DashboardSessionDraftResource> {
    this.#assertOpen();
    await this.#assertDrafts();
    return this.#call(() => this.#client.cancelDashboardSessionDraft(draftId, request));
  }

  async sendSessionDraft(
    draftId: string,
    request: DashboardSessionDraftSendRequest,
  ): Promise<DashboardSessionDraftSendTicket> {
    this.#assertOpen();
    await this.#assertDrafts();
    return this.#call(() => this.#client.sendDashboardSessionDraft(draftId, request));
  }

  async getSessionDraftSend(ticketId: string): Promise<DashboardSessionDraftSendTicket> {
    this.#assertOpen();
    await this.#assertDrafts();
    return this.#call(() => this.#client.getDashboardSessionDraftSend(ticketId));
  }

  async scheduleCapabilities(): Promise<ScheduleCapabilities> {
    this.#assertOpen();
    await this.#assertSchedules();
    return this.#call(() => this.#client.scheduleCapabilities());
  }

  async listSchedules(sessionRef?: string): Promise<DashboardScheduleResource[]> {
    this.#assertOpen();
    await this.#assertSchedules();
    const result = await this.#call(() => this.#client.listSchedules(sessionRef));
    if (result.schedules.length > DEFAULT_SCHEDULE_LIMITS.maxSchedules) {
      throw new RemoteDashboardBackendError("remote_schedule_capacity", "remote schedule count exceeds its bound");
    }
    return result.schedules.map(browserScheduleResource);
  }

  async getSchedule(scheduleId: string): Promise<DashboardScheduleResource> {
    this.#assertOpen();
    await this.#assertSchedules();
    return browserScheduleResource(await this.#call(() => this.#client.getSchedule(scheduleId)));
  }

  async createSchedule(request: DashboardScheduleMutationRequest): Promise<DashboardScheduleResource> {
    this.#assertOpen();
    await this.#assertSchedules();
    if (request.expectedRevision !== undefined || request.schedule.prompt === undefined) {
      throw new RemoteDashboardBackendError("invalid_schedule_request", "create requires prompt and no expectedRevision");
    }
    return browserScheduleResource(await this.#call(() => this.#client.createSchedule(
      request.schedule.scheduleId,
      request.schedule,
      request.idempotencyKey,
    )));
  }

  async updateSchedule(scheduleId: string, request: DashboardScheduleMutationRequest): Promise<DashboardScheduleResource> {
    this.#assertOpen();
    await this.#assertSchedules();
    if (request.schedule.scheduleId !== scheduleId || request.expectedRevision === undefined) {
      throw new RemoteDashboardBackendError("invalid_schedule_request", "schedule identity and expectedRevision are required");
    }
    const expectedRevision = request.expectedRevision;
    const current = request.schedule.prompt === undefined
      ? await this.#call(() => this.#client.getSchedule(scheduleId))
      : undefined;
    return browserScheduleResource(await this.#call(() => this.#client.updateSchedule(
      scheduleId,
      {
        ...request.schedule,
        prompt: request.schedule.prompt ?? current!.prompt,
        expectedRevision,
      },
      scheduleEtag(scheduleId, expectedRevision),
      request.idempotencyKey,
    )));
  }

  async deleteSchedule(scheduleId: string, request: DashboardScheduleDeleteRequest): Promise<void> {
    this.#assertOpen();
    await this.#assertSchedules();
    await this.#call(() => this.#client.deleteSchedule(
      scheduleId,
      scheduleEtag(scheduleId, request.expectedRevision),
      request.idempotencyKey,
    ));
  }

  async scheduleStatus(): Promise<DashboardScheduleStatus> {
    this.#assertOpen();
    await this.#assertSchedules();
    return this.#call(() => this.#client.scheduleStatus());
  }

  async getManagedSession(sessionRef: string): Promise<SessionResource> {
    this.#assertOpen();
    return this.#call(() => this.#client.getSession(sessionRef));
  }

  async openSessionChannel(options: SessionChannelOptions): Promise<DashboardChannel> {
    this.#assertOpen();
    await this.capabilities();
    const session = await this.getManagedSession(options.sessionRef);
    const generation = options.generation ?? session.generation;
    if (generation !== session.generation) {
      throw new RemoteDashboardBackendError("stale_generation", "session generation changed");
    }
    const key = hubKey(session.sessionId, generation);
    let pending = this.#richHubs.get(key);
    if (pending === undefined) {
      if (this.#richHubs.size >= this.#limits.maxRichHubs) {
        throw new RemoteDashboardBackendError(
          "remote_channel_capacity",
          "remote Rich channel capacity reached",
          true,
        );
      }
      pending = RemoteRichHub.create({
        client: this.#client,
        sessionRef: session.sessionId,
        generation,
        initialRole: options.role,
        ...(options.cursor === undefined ? {} : { initialCursor: options.cursor }),
        loadPreview: () => this.#loadPreview(session.sessionId),
        limits: this.#limits,
        onIdle: () => this.#richHubs.delete(key),
      });
      this.#richHubs.set(key, pending);
      void pending.catch(() => {
        if (this.#richHubs.get(key) === pending) this.#richHubs.delete(key);
      });
    }
    return (await pending).open(options);
  }

  async openTuiChannel(options: TuiChannelOptions): Promise<DashboardTuiChannel> {
    this.#assertOpen();
    const capabilities = await this.capabilities();
    if (!capabilities.presentations.tui.available) {
      throw new RemoteDashboardBackendError(
        "tui_unavailable",
        capabilities.presentations.tui.unavailableReason ?? "TUI presentation is unavailable",
      );
    }
    const session = await this.getManagedSession(options.sessionRef);
    const generation = options.generation ?? session.generation;
    if (generation !== session.generation) {
      throw new RemoteDashboardBackendError("stale_generation", "session generation changed");
    }
    const key = hubKey(session.sessionId, generation);
    let pending = this.#tuiHubs.get(key);
    if (pending === undefined) {
      if (this.#tuiHubs.size >= this.#limits.maxTuiHubs) {
        throw new RemoteDashboardBackendError(
          "remote_tui_capacity",
          "remote TUI channel capacity reached",
          true,
        );
      }
      pending = RemoteTuiHub.create({
        client: this.#client,
        sessionRef: session.sessionId,
        generation,
        initialOptions: options,
        limits: this.#limits,
        onIdle: () => this.#tuiHubs.delete(key),
      });
      this.#tuiHubs.set(key, pending);
      void pending.catch(() => {
        if (this.#tuiHubs.get(key) === pending) this.#tuiHubs.delete(key);
      });
    }
    return (await pending).open(options);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const pending of this.#richHubs.values()) {
      void pending.then((hub) => hub.dispose("remote backend disposed")).catch(() => undefined);
    }
    for (const pending of this.#tuiHubs.values()) {
      void pending.then((hub) => hub.dispose("remote backend disposed")).catch(() => undefined);
    }
    this.#richHubs.clear();
    this.#tuiHubs.clear();
  }

  async #loadPreview(sessionId: string): Promise<NormalizedTranscriptRecord[]> {
    const page = await this.#call(() => this.#client.listDashboardSessions({
      search: sessionId,
      limit: DASH_DEFAULT_LIMITS.maxInventoryPageItems,
    }));
    const match = page.sessions.find((candidate) => candidate.managed?.sessionId === sessionId);
    if (match === undefined) return [];
    const info = await this.#call(() => this.#client.getDashboardSession(match.inventoryId));
    const transcript = await this.#pagedTranscript(
      match.inventoryId,
      { limit: DASH_DEFAULT_LIMITS.maxTranscriptPageRecords },
      info.source.fingerprint?.value,
    );
    return transcript.records;
  }

  async #pagedTranscript(
    inventoryId: string,
    query: TranscriptQuery,
    expectedFingerprint: DashboardFingerprint | undefined,
  ): Promise<TranscriptPage> {
    const requestedLimit = query.limit ?? DASH_DEFAULT_LIMITS.maxTranscriptPageRecords;
    const direction = query.cursor === undefined ? "older" : (query.direction ?? "older");
    const pages: TranscriptPage[] = [];
    const records: NormalizedTranscriptRecord[] = [];
    let cursor = query.cursor;
    let remaining = requestedLimit;
    const seenCursors = new Set<DashboardCursor>();
    while (remaining > 0) {
      const page = await this.#call(() => this.#client.getDashboardTranscript(
        inventoryId,
        {
          ...query,
          limit: Math.min(3, remaining),
          ...(cursor === undefined ? {} : { cursor }),
        },
        expectedFingerprint,
      ));
      pages.push(page);
      if (direction === "older") records.unshift(...page.records);
      else records.push(...page.records);
      remaining -= page.records.length;
      const nextCursor = direction === "older" ? page.olderCursor : page.newerCursor;
      if (
        page.records.length === 0 ||
        nextCursor === undefined ||
        seenCursors.has(nextCursor)
      ) break;
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }
    const first = pages[0];
    const last = pages.at(-1);
    if (first === undefined || last === undefined) {
      throw new RemoteDashboardBackendError(
        "remote_protocol_error",
        "remote transcript paging returned no page",
      );
    }
    const { olderCursor: _older, newerCursor: _newer, records: _records, ...base } = first;
    const olderCursor = direction === "older" ? last.olderCursor : first.olderCursor;
    const newerCursor = direction === "older" ? first.newerCursor : last.newerCursor;
    return {
      ...base,
      records,
      ...(olderCursor === undefined ? {} : { olderCursor }),
      ...(newerCursor === undefined ? {} : { newerCursor }),
    };
  }

  async #assertDrafts(): Promise<void> {
    if (!(await this.capabilities()).resources.sessionDrafts) {
      throw new RemoteDashboardBackendError(
        "drafts_unavailable",
        "remote daemon does not advertise Dashboard session draft resources",
      );
    }
  }

  async #assertSchedules(): Promise<void> {
    if (!(await this.capabilities()).resources.schedules) {
      throw new RemoteDashboardBackendError(
        "schedules_unavailable",
        "remote daemon does not advertise Dashboard schedule resources",
      );
    }
  }

  async #call<T>(operation: () => Promise<{ data: T }>): Promise<T> {
    try {
      return (await operation()).data;
    } catch (error) {
      throw remoteError(error);
    }
  }

  #assertOpen(): void {
    if (this.#disposed) {
      throw new RemoteDashboardBackendError("backend_closed", "remote dashboard backend is closed");
    }
  }
}

interface RemoteRichHubOptions {
  client: RemoteDashboardBackendClient;
  sessionRef: string;
  generation: number;
  initialRole: "controller" | "observer";
  initialCursor?: DashboardCursor;
  loadPreview: () => Promise<NormalizedTranscriptRecord[]>;
  limits: RemoteDashboardBackendLimits;
  onIdle: () => void;
}

interface PendingRpcCommand {
  operation: DashboardCommandOperation;
  correlationId: string;
  resolve: (result: DashboardCommandResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

class RemoteRichHub {
  readonly #client: RemoteDashboardBackendClient;
  readonly #sessionRef: string;
  readonly #generation: number;
  readonly #loadPreview: () => Promise<NormalizedTranscriptRecord[]>;
  readonly #limits: RemoteDashboardBackendLimits;
  readonly #onIdle: () => void;
  readonly #channels = new Map<string, RemoteRichChannel>();
  readonly #events: Array<RetainedEvent<DashboardChannelEvent>> = [];
  readonly #initialPending: DashboardChannelEvent[] = [];
  readonly #commands = new Map<string, PendingRpcCommand>();
  readonly #commandResults = new Map<string, { fingerprint: string; promise: Promise<DashboardCommandResult> }>();
  readonly #anonymousResponses: Array<{
    resolve: (response: PiRpcResponse) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];
  #socket: WebSocket | undefined;
  #socketEpoch = 0;
  #snapshotValue: DashboardChannel["snapshot"] | undefined;
  #remoteRole: "controller" | "observer" = "observer";
  #controllerChannelId: string | undefined;
  #lastCursor: DashboardCursor | undefined;
  #replayBaseCursor: DashboardCursor | undefined;
  #replayBytes = 0;
  #pendingGap: RpcReplayGapFrame | undefined;
  #beforeReady: unknown[] = [];
  #connectionReady = false;
  #reconnecting = false;
  #reconnectFailures = 0;
  #reconnectAbort: AbortController | undefined;
  #controlWaiter: {
    resolve: (frame: RpcControlFrame) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  } | undefined;
  #controlTail: Promise<void> = Promise.resolve();
  #extensionTail: Promise<void> = Promise.resolve();
  #disposed = false;

  private constructor(options: RemoteRichHubOptions) {
    this.#client = options.client;
    this.#sessionRef = options.sessionRef;
    this.#generation = options.generation;
    this.#loadPreview = options.loadPreview;
    this.#limits = options.limits;
    this.#onIdle = options.onIdle;
  }

  static async create(options: RemoteRichHubOptions): Promise<RemoteRichHub> {
    const hub = new RemoteRichHub(options);
    await hub.#connect(options.initialRole, options.initialCursor);
    return hub;
  }

  get identity(): DashboardSessionIdentity {
    const snapshot = this.#snapshot();
    return snapshot.identity;
  }

  get snapshot(): DashboardChannel["snapshot"] {
    return structuredClone(this.#snapshot());
  }

  async open(options: SessionChannelOptions): Promise<DashboardChannel> {
    this.#assertOpen();
    if (this.#channels.size >= this.#limits.maxChannelsPerHub) {
      throw new RemoteDashboardBackendError(
        "remote_channel_capacity",
        "remote session channel capacity reached",
        true,
      );
    }
    let granted = false;
    if (options.role === "controller" && this.#controllerChannelId === undefined) {
      granted = this.#remoteRole === "controller" || await this.#serializeControl(
        () => this.#requestRemoteControl(),
      );
    }
    const id = randomUUID();
    if (granted) this.#controllerChannelId = id;
    const pending = this.#channels.size === 0
      ? this.#initialPending.splice(0)
      : this.#replay(options.cursor);
    if (options.role === "controller" && !granted) {
      pending.push({
        kind: "control",
        identity: this.identity,
        action: "control_denied",
        reason: "controller already held",
      });
    }
    const channel = new RemoteRichChannel(
      id,
      granted ? "controller" : "observer",
      pending,
      this,
    );
    this.#channels.set(id, channel);
    return channel;
  }

  subscribe(
    channelId: string,
    listener: DashboardChannelListener<DashboardChannelEvent>,
  ): () => void {
    return this.#requireChannel(channelId).attach(listener);
  }

  command(channelId: string, command: DashboardCommand): Promise<DashboardCommandResult> {
    this.#assertOpen();
    const channel = this.#requireChannel(channelId);
    assertIdentity(command.identity, this.identity);
    if (channel.role !== "controller" && !READ_ONLY_COMMANDS.has(command.operation)) {
      return Promise.resolve(rejected(
        command.correlationId,
        "controller_required",
        "controller role is required",
        true,
      ));
    }
    const fingerprint = JSON.stringify({
      operation: command.operation,
      payload: command.payload ?? null,
    });
    if (command.idempotencyKey !== undefined) {
      const existing = this.#commandResults.get(command.idempotencyKey);
      if (existing !== undefined) {
        if (existing.fingerprint !== fingerprint) {
          return Promise.resolve(rejected(
            command.correlationId,
            "idempotency_conflict",
            "idempotency key was reused with different command content",
          ));
        }
        return existing.promise.then((result) => ({
          ...structuredClone(result),
          correlationId: command.correlationId,
        }));
      }
    }
    const promise = this.#sendCommand(command);
    if (command.idempotencyKey !== undefined) {
      if (this.#commandResults.size >= this.#limits.maxCommandResults) {
        const first = this.#commandResults.keys().next().value;
        if (first !== undefined) this.#commandResults.delete(first);
      }
      this.#commandResults.set(command.idempotencyKey, { fingerprint, promise });
    }
    return promise;
  }

  requestControl(channelId: string, correlationId: string): Promise<DashboardCommandResult> {
    return this.#serializeControl(async () => {
      const channel = this.#requireChannel(channelId);
      if (
        this.#controllerChannelId !== undefined &&
        this.#controllerChannelId !== channelId
      ) {
        return rejected(correlationId, "controller_busy", "another pane holds controller role", true);
      }
      if (!await this.#requestRemoteControl()) {
        return rejected(correlationId, "controller_busy", "remote controller is busy", true);
      }
      this.#controllerChannelId = channelId;
      channel.setRole("controller");
      this.#broadcast({
        kind: "control",
        identity: this.identity,
        action: "control_granted",
        connectionId: channelId,
      });
      return { correlationId, state: "completed", data: { role: "controller" } };
    });
  }

  releaseControl(channelId: string, correlationId: string): Promise<DashboardCommandResult> {
    return this.#serializeControl(async () => {
      const channel = this.#requireChannel(channelId);
      if (this.#controllerChannelId !== channelId) {
        return rejected(correlationId, "controller_required", "pane does not hold controller role");
      }
      const frame = await this.#sendControl("release_control");
      if (frame.action !== "release_control") {
        return indeterminate(correlationId, "remote control release was not acknowledged");
      }
      this.#controllerChannelId = undefined;
      this.#remoteRole = "observer";
      channel.setRole("observer");
      this.#broadcast({
        kind: "control",
        identity: this.identity,
        action: "control_released",
        connectionId: channelId,
      });
      return { correlationId, state: "completed", data: { role: "observer" } };
    });
  }

  answerExtensionUi(
    channelId: string,
    requestId: string,
    response: JsonObject,
  ): Promise<void> {
    const operation = async (): Promise<void> => {
      const channel = this.#requireChannel(channelId);
      if (channel.role !== "controller") {
        throw new RemoteDashboardBackendError(
          "controller_required",
          "controller role is required",
        );
      }
      this.#assertConnected();
      const rpcResponse = await new Promise<PiRpcResponse>((resolve, reject) => {
        const pending = {
          resolve,
          reject,
          timer: setTimeout(() => {
            const index = this.#anonymousResponses.indexOf(pending);
            if (index >= 0) this.#anonymousResponses.splice(index, 1);
            this.#socket?.terminate();
            reject(new RemoteDashboardBackendError(
              "remote_operation_timeout",
              "extension UI response acknowledgement exceeded its deadline",
            ));
          }, this.#limits.operationTimeoutMs),
        };
        this.#anonymousResponses.push(pending);
        try {
          this.#send({
            kind: "extension_ui_response",
            response: { ...response, type: "extension_ui_response", id: requestId },
          });
        } catch (error) {
          this.#anonymousResponses.pop();
          clearTimeout(pending.timer);
          reject(error instanceof Error ? error : new Error("extension response failed"));
        }
      });
      if (!rpcResponse.success) {
        throw new RemoteDashboardBackendError(
          String(rpcResponse.error ?? "extension_request_not_found"),
          "extension UI response was rejected",
        );
      }
    };
    const result = this.#extensionTail.then(operation);
    this.#extensionTail = result.catch(() => undefined);
    return result;
  }

  remove(channelId: string): void {
    const channel = this.#channels.get(channelId);
    if (channel === undefined) return;
    this.#channels.delete(channelId);
    if (this.#controllerChannelId === channelId) {
      this.#controllerChannelId = undefined;
      if (this.#connectionReady && this.#remoteRole === "controller") {
        void this.#serializeControl(() => this.#sendControl("release_control"))
          .catch(() => undefined);
      }
    }
    if (this.#channels.size === 0) {
      this.dispose("last remote Rich channel closed");
      this.#onIdle();
    }
  }

  dispose(reason: string): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#connectionReady = false;
    this.#reconnectAbort?.abort();
    this.#reconnectAbort = undefined;
    this.#failInFlight("backend_closed", reason, false);
    this.#socket?.close(1000, reason);
    this.#socket = undefined;
    for (const channel of [...this.#channels.values()]) channel.forceClose();
    this.#channels.clear();
    this.#events.length = 0;
    this.#initialPending.length = 0;
    this.#commandResults.clear();
  }

  async #connect(
    role: "controller" | "observer",
    cursor: DashboardCursor | undefined,
  ): Promise<void> {
    this.#assertOpen();
    const epoch = ++this.#socketEpoch;
    const socket = this.#client.createDashboardRpcSocket(this.#sessionRef, {
      role,
      generation: this.#generation,
      hydrate: true,
      ...(cursor === undefined ? {} : { cursor }),
    });
    this.#socket = socket;
    this.#connectionReady = false;
    this.#beforeReady = [];
    this.#pendingGap = undefined;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        socket.terminate();
        fail(new RemoteDashboardBackendError(
          "remote_attach_timeout",
          "remote RPC attachment did not produce a snapshot before its deadline",
          true,
        ));
      }, this.#limits.operationTimeoutMs);
      const succeed = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const fail = (error: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      };
      socket.on("message", (raw: RawData, binary: boolean) => {
        if (epoch !== this.#socketEpoch || this.#disposed) return;
        let frame: unknown;
        try {
          frame = decodeFrame(raw, binary, this.#limits.maxEventBytes);
        } catch (error) {
          socket.close(1007, "invalid framed RPC message");
          fail(error instanceof Error ? error : new Error("invalid framed RPC message"));
          return;
        }
        void this.#onFrame(frame, succeed).catch((error: unknown) => {
          socket.close(1011, "failed to initialize remote dashboard channel");
          fail(remoteError(error));
        });
      });
      socket.once("unexpected-response", (_request, response) => {
        const status = response.statusCode ?? 0;
        response.resume();
        socket.terminate();
        fail(new RemoteDashboardBackendError(
          "remote_attachment_rejected",
          "remote RPC attachment was rejected",
          status >= 500 || [408, 429].includes(status),
        ));
      });
      socket.once("error", () => {
        if (!this.#connectionReady) {
          fail(new RemoteDashboardBackendError(
            "remote_unavailable",
            "remote RPC attachment failed",
            true,
          ));
        }
      });
      socket.once("close", () => {
        if (epoch !== this.#socketEpoch) return;
        this.#onDisconnect();
        if (!settled) {
          fail(new RemoteDashboardBackendError(
            "remote_unavailable",
            "remote RPC attachment closed before its snapshot",
            true,
          ));
        }
      });
    });
  }

  async #onFrame(frame: unknown, ready: () => void): Promise<void> {
    if (!isRecord(frame) || typeof frame.kind !== "string") {
      throw new RemoteDashboardBackendError("remote_protocol_error", "remote RPC frame is invalid");
    }
    if (frame.kind === "replay_gap") {
      this.#pendingGap = frame as unknown as RpcReplayGapFrame;
      return;
    }
    if (frame.kind === "attach_ready") {
      const value = frame as unknown as RpcAttachReadyFrame;
      const identity = rpcIdentity(value);
      if (identity.sessionId !== this.#sessionRef || identity.generation !== this.#generation) {
        throw new RemoteDashboardBackendError("stale_generation", "remote RPC identity changed");
      }
      const entries = await this.#loadPreview();
      this.#remoteRole = value.role;
      this.#lastCursor = asDashboardCursor(value.highWaterCursor);
      if (this.#snapshotValue === undefined) this.#replayBaseCursor = this.#lastCursor;
      this.#snapshotValue = {
        identity,
        session: value.snapshot.session,
        rpcState: boundedObject(value.snapshot.rpcState, this.#limits.maxEventBytes),
        requestState: boundedObject(value.snapshot.requestState, this.#limits.maxEventBytes),
        entries: structuredClone(entries),
        ...(value.snapshot.leafId === undefined ? {} : { currentLeafId: value.snapshot.leafId }),
        highWaterCursor: this.#lastCursor,
      };
      this.#connectionReady = true;
      this.#reconnectFailures = 0;
      if (this.#pendingGap !== undefined) {
        this.#publish(mapRpcGap(this.#pendingGap, identity));
        this.#pendingGap = undefined;
      }
      const buffered = this.#beforeReady.splice(0);
      for (const pending of buffered) await this.#onFrame(pending, () => undefined);
      ready();
      return;
    }
    if (!this.#connectionReady) {
      if (this.#beforeReady.length >= this.#limits.maxReplayEvents) {
        throw new RemoteDashboardBackendError(
          "remote_protocol_error",
          "remote RPC pre-snapshot queue exceeded its bound",
        );
      }
      this.#beforeReady.push(frame);
      return;
    }
    if (frame.kind === "event") {
      const value = frame as unknown as RpcEventFrame;
      const cursor = asDashboardCursor(value.cursor);
      this.#lastCursor = cursor;
      this.#snapshotValue = {
        ...this.#snapshot(),
        highWaterCursor: cursor,
      };
      this.#publish(mapRpcEvent(value, this.identity));
      return;
    }
    if (frame.kind === "response") {
      this.#onResponse(frame.response);
      return;
    }
    if (frame.kind === "control") {
      this.#onControl(frame as unknown as RpcControlFrame);
      return;
    }
    throw new RemoteDashboardBackendError(
      "remote_protocol_error",
      `unknown remote RPC frame kind ${frame.kind}`,
    );
  }

  #onResponse(value: unknown): void {
    if (!isRecord(value) || value.type !== "response") {
      throw new RemoteDashboardBackendError("remote_protocol_error", "remote RPC response is invalid");
    }
    const response = value as PiRpcResponse;
    if (typeof response.id === "string") {
      const pending = this.#commands.get(response.id);
      if (pending === undefined) return;
      this.#commands.delete(response.id);
      clearTimeout(pending.timer);
      pending.resolve(commandResult(response, pending.operation, pending.correlationId));
      return;
    }
    const pending = this.#anonymousResponses.shift();
    if (pending !== undefined) {
      clearTimeout(pending.timer);
      pending.resolve(response);
    }
  }

  #onControl(frame: RpcControlFrame): void {
    if (frame.action === "control_granted") this.#remoteRole = "controller";
    if (frame.action === "control_denied" || frame.action === "release_control") {
      this.#remoteRole = "observer";
    }
    const waiter = this.#controlWaiter;
    if (waiter !== undefined) {
      this.#controlWaiter = undefined;
      clearTimeout(waiter.timer);
      waiter.resolve(frame);
      return;
    }
    if (frame.action === "control_denied" && this.#controllerChannelId !== undefined) {
      const channel = this.#channels.get(this.#controllerChannelId);
      this.#controllerChannelId = undefined;
      channel?.setRole("observer");
      channel?.deliver(mapRpcControl(frame, this.identity));
      return;
    }
    this.#broadcast(mapRpcControl(frame, this.identity));
  }

  #onDisconnect(): void {
    if (this.#disposed) return;
    this.#connectionReady = false;
    this.#socket = undefined;
    this.#failInFlight(
      "connection_lost_indeterminate",
      "remote connection closed after command submission",
      false,
    );
    if (this.#channels.size > 0 && !this.#reconnecting) void this.#reconnect();
  }

  async #reconnect(): Promise<void> {
    this.#reconnecting = true;
    const abort = new AbortController();
    this.#reconnectAbort = abort;
    try {
      while (!this.#disposed && this.#channels.size > 0) {
        this.#reconnectFailures += 1;
        if (this.#reconnectFailures > this.#limits.reconnectAttempts) {
          this.dispose("remote reconnect attempts exhausted");
          return;
        }
        await delay(
          reconnectDelay(this.#reconnectFailures, this.#limits),
          abort.signal,
        );
        if (abort.signal.aborted) return;
        try {
          await this.#connect(
            this.#controllerChannelId === undefined ? "observer" : "controller",
            this.#lastCursor,
          );
          if (this.#controllerChannelId !== undefined && this.#remoteRole !== "controller") {
            const channel = this.#channels.get(this.#controllerChannelId);
            this.#controllerChannelId = undefined;
            channel?.setRole("observer");
            channel?.deliver({
              kind: "control",
              identity: this.identity,
              action: "control_denied",
              reason: "controller was not restored after reconnect",
            });
          }
          return;
        } catch (error) {
          const normalized = remoteError(error);
          if (!normalized.retryable) {
            this.dispose(`terminal remote reconnect failure: ${normalized.code}`);
            return;
          }
          // Bounded exponential reconnect continues; accepted commands were
          // already completed as indeterminate and are never replayed.
        }
      }
    } finally {
      if (this.#reconnectAbort === abort) this.#reconnectAbort = undefined;
      this.#reconnecting = false;
    }
  }

  #sendCommand(command: DashboardCommand): Promise<DashboardCommandResult> {
    if (this.#commands.size >= this.#limits.maxInFlightCommands) {
      return Promise.resolve(rejected(
        command.correlationId,
        "remote_in_flight_capacity",
        "remote command capacity reached",
        true,
      ));
    }
    try {
      this.#assertConnected();
    } catch (error) {
      return Promise.resolve(rejected(
        command.correlationId,
        errorCode(error),
        error instanceof Error ? error.message : "remote channel is unavailable",
        true,
      ));
    }
    const id = `dash-${randomUUID()}`;
    const promise = new Promise<DashboardCommandResult>((resolve) => {
      const timer = setTimeout(() => {
        if (!this.#commands.delete(id)) return;
        resolve({
          correlationId: command.correlationId,
          state: "indeterminate",
          error: {
            code: "remote_command_timeout",
            message: "remote command response exceeded its deadline",
            retryable: false,
          },
        });
      }, this.#limits.operationTimeoutMs);
      // A pending public operation must keep Node alive until it settles. An
      // unref'ed deadline can strand its Promise when a transport is synthetic
      // or is the final active handle (notably Node 22 release runners).
      this.#commands.set(id, {
        operation: command.operation,
        correlationId: command.correlationId,
        resolve,
        timer,
      });
    });
    try {
      this.#send({
        kind: "command",
        command: {
          ...(command.payload ?? {}),
          type: command.operation,
          id,
        },
      });
    } catch (error) {
      const pending = this.#commands.get(id);
      if (pending !== undefined) clearTimeout(pending.timer);
      this.#commands.delete(id);
      if (
        error instanceof RemoteDashboardBackendError &&
        error.code === "remote_frame_too_large"
      ) {
        return Promise.resolve(rejected(
          command.correlationId,
          error.code,
          error.message,
        ));
      }
      return Promise.resolve(indeterminate(
        command.correlationId,
        error instanceof Error ? error.message : "remote command send failed",
      ));
    }
    return promise;
  }

  async #requestRemoteControl(): Promise<boolean> {
    if (this.#remoteRole === "controller") return true;
    const frame = await this.#sendControl("request_control");
    return frame.action === "control_granted";
  }

  #sendControl(action: "request_control" | "release_control"): Promise<RpcControlFrame> {
    this.#assertConnected();
    if (this.#controlWaiter !== undefined) {
      throw new RemoteDashboardBackendError(
        "remote_control_busy",
        "another remote control transition is in flight",
        true,
      );
    }
    return new Promise<RpcControlFrame>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#controlWaiter = undefined;
        this.#socket?.terminate();
        reject(new RemoteDashboardBackendError(
          "remote_operation_timeout",
          "remote control transition exceeded its deadline",
          true,
        ));
      }, this.#limits.operationTimeoutMs);
      this.#controlWaiter = { resolve, reject, timer };
      try {
        this.#send({ kind: "control", action });
      } catch (error) {
        this.#controlWaiter = undefined;
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error("remote control send failed"));
      }
    });
  }

  #serializeControl<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#controlTail.then(operation);
    this.#controlTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  #send(value: unknown): void {
    this.#assertConnected();
    const encoded = JSON.stringify(value);
    if (Buffer.byteLength(encoded, "utf8") > this.#limits.maxEventBytes) {
      throw new RemoteDashboardBackendError("remote_frame_too_large", "remote RPC frame exceeds its bound");
    }
    this.#socket!.send(encoded);
  }

  #publish(event: DashboardChannelEvent): void {
    const bytes = byteLength(event);
    if (bytes > this.#limits.maxEventBytes) return;
    const cursor = "cursor" in event ? event.cursor : undefined;
    this.#events.push({ event: structuredClone(event), bytes, ...(cursor === undefined ? {} : { cursor }) });
    if (this.#channels.size === 0) this.#initialPending.push(structuredClone(event));
    this.#replayBytes += bytes;
    while (
      this.#events.length > this.#limits.maxReplayEvents ||
      this.#replayBytes > this.#limits.maxReplayBytes
    ) {
      const removed = this.#events.shift();
      if (removed !== undefined) {
        this.#replayBytes -= removed.bytes;
        if (removed.cursor !== undefined) this.#replayBaseCursor = removed.cursor;
      }
      if (this.#channels.size === 0) this.#initialPending.shift();
    }
    this.#broadcast(event);
  }

  #replay(cursor: DashboardCursor | undefined): DashboardChannelEvent[] {
    if (cursor === undefined) return [];
    if (cursor === this.#snapshot().highWaterCursor) return [];
    if (cursor === this.#replayBaseCursor) {
      return this.#events.map((entry) => structuredClone(entry.event));
    }
    const gap = this.#events.find((entry) =>
      entry.event.kind === "replay_gap" && entry.event.requestedCursor === cursor
    );
    if (gap !== undefined) return [structuredClone(gap.event)];
    const index = this.#events.findIndex((entry) => entry.cursor === cursor);
    if (index >= 0) {
      return this.#events.slice(index + 1).map((entry) => structuredClone(entry.event));
    }
    return [localGap(this.identity, cursor, this.#snapshot().highWaterCursor)];
  }

  #broadcast(event: DashboardChannelEvent): void {
    for (const channel of this.#channels.values()) channel.deliver(event);
  }

  #failInFlight(code: string, message: string, retryable: boolean): void {
    for (const pending of this.#commands.values()) {
      clearTimeout(pending.timer);
      pending.resolve({
        correlationId: pending.correlationId,
        state: "indeterminate",
        error: { code, message, retryable },
      });
    }
    this.#commands.clear();
    const error = new RemoteDashboardBackendError(code, message, retryable);
    for (const pending of this.#anonymousResponses.splice(0)) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    if (this.#controlWaiter !== undefined) {
      clearTimeout(this.#controlWaiter.timer);
      this.#controlWaiter.reject(error);
      this.#controlWaiter = undefined;
    }
  }

  #snapshot(): DashboardChannel["snapshot"] {
    if (this.#snapshotValue === undefined) {
      throw new RemoteDashboardBackendError("remote_not_ready", "remote channel has no snapshot", true);
    }
    return this.#snapshotValue;
  }

  #requireChannel(id: string): RemoteRichChannel {
    const channel = this.#channels.get(id);
    if (channel === undefined) {
      throw new RemoteDashboardBackendError("channel_closed", "remote Rich channel is closed");
    }
    return channel;
  }

  #assertConnected(): void {
    this.#assertOpen();
    if (!this.#connectionReady || this.#socket?.readyState !== WebSocket.OPEN) {
      throw new RemoteDashboardBackendError(
        "remote_unavailable",
        "remote channel is reconnecting",
        true,
      );
    }
  }

  #assertOpen(): void {
    if (this.#disposed) {
      throw new RemoteDashboardBackendError("channel_closed", "remote Rich channel is closed");
    }
  }
}

class RemoteRichChannel implements DashboardChannel {
  readonly presentation = "rich" as const;
  readonly #id: string;
  readonly #pending: DashboardChannelEvent[];
  readonly #hub: RemoteRichHub;
  readonly #listeners = new Set<DashboardChannelListener<DashboardChannelEvent>>();
  #role: "controller" | "observer";
  #closed = false;

  constructor(
    id: string,
    role: "controller" | "observer",
    pending: DashboardChannelEvent[],
    hub: RemoteRichHub,
  ) {
    this.#id = id;
    this.#role = role;
    this.#pending = pending;
    this.#hub = hub;
  }

  get identity(): DashboardSessionIdentity {
    return this.#hub.identity;
  }

  get snapshot(): DashboardChannel["snapshot"] {
    return this.#hub.snapshot;
  }

  get role(): "controller" | "observer" {
    return this.#role;
  }

  setRole(role: "controller" | "observer"): void {
    this.#role = role;
  }

  command(command: DashboardCommand): Promise<DashboardCommandResult> {
    this.#assertOpen();
    return this.#hub.command(this.#id, command);
  }

  requestControl(correlationId: string): Promise<DashboardCommandResult> {
    this.#assertOpen();
    return this.#hub.requestControl(this.#id, correlationId);
  }

  releaseControl(correlationId: string): Promise<DashboardCommandResult> {
    this.#assertOpen();
    return this.#hub.releaseControl(this.#id, correlationId);
  }

  answerExtensionUi(requestId: string, response: JsonObject): Promise<void> {
    this.#assertOpen();
    return this.#hub.answerExtensionUi(this.#id, requestId, response);
  }

  subscribe(listener: DashboardChannelListener<DashboardChannelEvent>): () => void {
    this.#assertOpen();
    this.#listeners.add(listener);
    for (const event of this.#pending.splice(0)) listener(structuredClone(event));
    return () => this.#listeners.delete(listener);
  }

  attach(listener: DashboardChannelListener<DashboardChannelEvent>): () => void {
    return this.subscribe(listener);
  }

  deliver(event: DashboardChannelEvent): void {
    if (this.#closed) return;
    for (const listener of this.#listeners) listener(structuredClone(event));
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#listeners.clear();
    this.#hub.remove(this.#id);
  }

  forceClose(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#listeners.clear();
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new RemoteDashboardBackendError("channel_closed", "remote Rich channel is closed");
    }
  }
}

interface RemoteTuiHubOptions {
  client: RemoteDashboardBackendClient;
  sessionRef: string;
  generation: number;
  initialOptions: TuiChannelOptions;
  limits: RemoteDashboardBackendLimits;
  onIdle: () => void;
}

interface PendingTuiAction {
  kind: "void" | "control";
  resolve: (value: void | DashboardCommandResult) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

class RemoteTuiHub {
  readonly #client: RemoteDashboardBackendClient;
  readonly #sessionRef: string;
  readonly #generation: number;
  readonly #limits: RemoteDashboardBackendLimits;
  readonly #onIdle: () => void;
  readonly #channels = new Map<string, RemoteTuiChannel>();
  readonly #events: Array<RetainedEvent<DashboardTuiChannelEvent>> = [];
  readonly #initialPending: DashboardTuiChannelEvent[] = [];
  readonly #actions = new Map<string, PendingTuiAction>();
  #socket: WebSocket | undefined;
  #socketEpoch = 0;
  #snapshotValue: DashboardTuiSnapshot | undefined;
  #remoteRole: "controller" | "observer" = "observer";
  #controllerChannelId: string | undefined;
  #dimensions: TuiDimensions;
  #lastCursor: DashboardCursor | undefined;
  #replayBaseCursor: DashboardCursor | undefined;
  #replayBytes = 0;
  #pendingGap: DashboardReplayGap | undefined;
  #beforeReady: unknown[] = [];
  #connectionReady = false;
  #reconnecting = false;
  #reconnectFailures = 0;
  #reconnectAbort: AbortController | undefined;
  #controlTail: Promise<void> = Promise.resolve();
  #disposed = false;

  private constructor(options: RemoteTuiHubOptions) {
    this.#client = options.client;
    this.#sessionRef = options.sessionRef;
    this.#generation = options.generation;
    this.#limits = options.limits;
    this.#onIdle = options.onIdle;
    this.#dimensions = options.initialOptions.dimensions;
  }

  static async create(options: RemoteTuiHubOptions): Promise<RemoteTuiHub> {
    const hub = new RemoteTuiHub(options);
    await hub.#connect(
      options.initialOptions.role,
      options.initialOptions.cursor,
      options.initialOptions.dimensions,
    );
    return hub;
  }

  get identity(): DashboardSessionIdentity {
    return this.#snapshot().identity;
  }

  get snapshot(): DashboardTuiSnapshot {
    return structuredClone(this.#snapshot());
  }

  async open(options: TuiChannelOptions): Promise<DashboardTuiChannel> {
    this.#assertOpen();
    if (this.#channels.size >= this.#limits.maxChannelsPerHub) {
      throw new RemoteDashboardBackendError(
        "remote_tui_capacity",
        "remote TUI channel capacity reached",
        true,
      );
    }
    let granted = false;
    if (options.role === "controller" && this.#controllerChannelId === undefined) {
      granted = this.#remoteRole === "controller" || await this.#serializeControl(
        () => this.#requestRemoteControl(),
      );
    }
    const id = randomUUID();
    if (granted) {
      this.#controllerChannelId = id;
      if (!sameDimensions(this.#dimensions, options.dimensions)) {
        await this.#sendVoid("resize", { dimensions: options.dimensions });
        this.#dimensions = options.dimensions;
      }
    }
    const pending = this.#channels.size === 0
      ? this.#initialPending.splice(0)
      : this.#replay(options.cursor);
    if (options.role === "controller" && !granted) {
      pending.push({
        kind: "control",
        identity: this.identity,
        action: "control_denied",
        reason: "controller already held",
      });
    }
    const channel = new RemoteTuiChannel(
      id,
      granted ? "controller" : "observer",
      pending,
      this,
    );
    this.#channels.set(id, channel);
    return channel;
  }

  resize(channelId: string, dimensions: TuiDimensions): Promise<void> {
    this.#assertController(channelId);
    return this.#sendVoid("resize", { dimensions }).then(() => {
      this.#dimensions = dimensions;
    });
  }

  sendInput(channelId: string, input: DashboardTuiInput): Promise<void> {
    this.#assertController(channelId);
    return this.#sendVoid("input", { input });
  }

  requestControl(channelId: string, correlationId: string): Promise<DashboardCommandResult> {
    return this.#serializeControl(async () => {
      const channel = this.#requireChannel(channelId);
      if (
        this.#controllerChannelId !== undefined &&
        this.#controllerChannelId !== channelId
      ) {
        return rejected(correlationId, "controller_busy", "another pane holds controller role", true);
      }
      const result = await this.#sendControl("request", correlationId);
      if (result.state === "completed") {
        this.#controllerChannelId = channelId;
        this.#remoteRole = "controller";
        channel.setRole("controller");
      }
      return result;
    });
  }

  releaseControl(channelId: string, correlationId: string): Promise<DashboardCommandResult> {
    return this.#serializeControl(async () => {
      const channel = this.#requireChannel(channelId);
      if (this.#controllerChannelId !== channelId) {
        return rejected(correlationId, "controller_required", "pane does not hold controller role");
      }
      const result = await this.#sendControl("release", correlationId);
      if (result.state === "completed") {
        this.#controllerChannelId = undefined;
        this.#remoteRole = "observer";
        channel.setRole("observer");
      }
      return result;
    });
  }

  subscribe(
    channelId: string,
    listener: DashboardChannelListener<DashboardTuiChannelEvent>,
  ): () => void {
    return this.#requireChannel(channelId).attach(listener);
  }

  remove(channelId: string): void {
    if (!this.#channels.delete(channelId)) return;
    if (this.#controllerChannelId === channelId) {
      this.#controllerChannelId = undefined;
      if (this.#connectionReady && this.#remoteRole === "controller") {
        void this.#serializeControl(
          () => this.#sendControl("release", `release-${randomUUID()}`),
        ).catch(() => undefined);
      }
    }
    if (this.#channels.size === 0) {
      this.dispose("last remote TUI channel closed");
      this.#onIdle();
    }
  }

  dispose(reason: string): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#connectionReady = false;
    this.#reconnectAbort?.abort();
    this.#reconnectAbort = undefined;
    const error = new RemoteDashboardBackendError("backend_closed", reason);
    for (const pending of this.#actions.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#actions.clear();
    this.#socket?.close(1000, reason);
    this.#socket = undefined;
    for (const channel of [...this.#channels.values()]) channel.forceClose();
    this.#channels.clear();
    this.#events.length = 0;
    this.#initialPending.length = 0;
  }

  async #connect(
    role: "controller" | "observer",
    cursor: DashboardCursor | undefined,
    dimensions: TuiDimensions,
  ): Promise<void> {
    this.#assertOpen();
    const epoch = ++this.#socketEpoch;
    const socket = this.#client.createDashboardTuiSocket(this.#sessionRef, {
      role,
      generation: this.#generation,
      dimensions,
      ...(cursor === undefined ? {} : { cursor }),
    });
    this.#socket = socket;
    this.#connectionReady = false;
    this.#beforeReady = [];
    this.#pendingGap = undefined;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        socket.terminate();
        fail(new RemoteDashboardBackendError(
          "remote_attach_timeout",
          "remote TUI attachment did not produce a snapshot before its deadline",
          true,
        ));
      }, this.#limits.operationTimeoutMs);
      const succeed = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const fail = (error: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      };
      socket.on("message", (raw: RawData, binary: boolean) => {
        if (epoch !== this.#socketEpoch || this.#disposed) return;
        let frame: unknown;
        try {
          frame = decodeFrame(raw, binary, this.#limits.maxEventBytes);
        } catch (error) {
          socket.close(1007, "invalid TUI frame");
          fail(error instanceof Error ? error : new Error("invalid TUI frame"));
          return;
        }
        try {
          this.#onFrame(frame);
          if (this.#connectionReady) succeed();
        } catch (error) {
          socket.close(1011, "failed to initialize remote TUI channel");
          fail(remoteError(error));
        }
      });
      socket.once("unexpected-response", (_request, response) => {
        const status = response.statusCode ?? 0;
        response.resume();
        socket.terminate();
        fail(new RemoteDashboardBackendError(
          "remote_tui_rejected",
          "remote TUI attachment was rejected",
          status >= 500 || [408, 429].includes(status),
        ));
      });
      socket.once("error", () => {
        if (!this.#connectionReady) {
          fail(new RemoteDashboardBackendError(
            "remote_unavailable",
            "remote TUI attachment failed",
            true,
          ));
        }
      });
      socket.once("close", () => {
        if (epoch !== this.#socketEpoch) return;
        this.#onDisconnect();
        if (!settled) {
          fail(new RemoteDashboardBackendError(
            "remote_unavailable",
            "remote TUI attachment closed before its snapshot",
            true,
          ));
        }
      });
    });
  }

  #onFrame(frame: unknown): void {
    if (!isRecord(frame) || typeof frame.kind !== "string") {
      throw new RemoteDashboardBackendError("remote_protocol_error", "remote TUI frame is invalid");
    }
    if (frame.kind === "replay_gap") {
      if (!isRecord(frame.gap)) throw new RemoteDashboardBackendError("remote_protocol_error", "remote TUI gap is invalid");
      this.#pendingGap = frame.gap as unknown as DashboardReplayGap;
      return;
    }
    if (frame.kind === "snapshot") {
      if (!isRecord(frame.snapshot)) throw new RemoteDashboardBackendError("remote_protocol_error", "remote TUI snapshot is invalid");
      const snapshot = frame.snapshot as unknown as DashboardTuiSnapshot;
      if (
        snapshot.identity.sessionId !== this.#sessionRef ||
        snapshot.identity.generation !== this.#generation
      ) {
        throw new RemoteDashboardBackendError("stale_generation", "remote TUI identity changed");
      }
      if (this.#snapshotValue === undefined) this.#replayBaseCursor = snapshot.highWaterCursor;
      this.#snapshotValue = structuredClone(snapshot);
      this.#lastCursor = snapshot.highWaterCursor;
      this.#remoteRole = frame.role === "controller" ? "controller" : "observer";
      this.#connectionReady = true;
      this.#reconnectFailures = 0;
      if (this.#pendingGap !== undefined) {
        this.#publish(this.#pendingGap);
        this.#pendingGap = undefined;
      }
      const buffered = this.#beforeReady.splice(0);
      for (const pending of buffered) this.#onFrame(pending);
      return;
    }
    if (!this.#connectionReady) {
      if (this.#beforeReady.length >= this.#limits.maxReplayEvents) {
        throw new RemoteDashboardBackendError(
          "remote_protocol_error",
          "remote TUI pre-snapshot queue exceeded its bound",
        );
      }
      this.#beforeReady.push(frame);
      return;
    }
    if (frame.kind === "delta") {
      if (!isRecord(frame.delta)) throw new RemoteDashboardBackendError("remote_protocol_error", "remote TUI delta is invalid");
      const delta = frame.delta as unknown as Extract<DashboardTuiChannelEvent, { kind: "tui_delta" }>;
      this.#lastCursor = delta.cursor;
      this.#snapshotValue = { ...this.#snapshot(), highWaterCursor: delta.cursor };
      this.#publish(delta);
      return;
    }
    if (frame.kind === "control") {
      if (!isRecord(frame.event)) throw new RemoteDashboardBackendError("remote_protocol_error", "remote TUI control is invalid");
      const event = frame.event as unknown as DashboardControlEvent;
      this.#remoteRole = frame.role === "controller" ? "controller" : "observer";
      this.#publish(event);
      return;
    }
    if (frame.kind === "ack") {
      this.#settleAction(frame.correlationId, undefined, frame.role);
      return;
    }
    if (frame.kind === "command_result") {
      this.#settleAction(frame.correlationId, frame.result, frame.role);
      return;
    }
    if (frame.kind === "error") {
      const pending = typeof frame.correlationId === "string"
        ? this.#actions.get(frame.correlationId)
        : undefined;
      if (pending !== undefined) {
        this.#actions.delete(frame.correlationId as string);
        clearTimeout(pending.timer);
        pending.reject(new RemoteDashboardBackendError(
          isRecord(frame.error) && typeof frame.error.code === "string"
            ? frame.error.code
            : "remote_tui_command_failed",
          isRecord(frame.error) && typeof frame.error.message === "string"
            ? frame.error.message
            : "remote TUI command failed",
        ));
      }
      return;
    }
    throw new RemoteDashboardBackendError(
      "remote_protocol_error",
      `unknown remote TUI frame kind ${frame.kind}`,
    );
  }

  #settleAction(correlation: unknown, result: unknown, role: unknown): void {
    if (typeof correlation !== "string") return;
    const pending = this.#actions.get(correlation);
    if (pending === undefined) return;
    this.#actions.delete(correlation);
    clearTimeout(pending.timer);
    this.#remoteRole = role === "controller" ? "controller" : "observer";
    if (pending.kind === "void") {
      pending.resolve(undefined);
      return;
    }
    if (!isRecord(result)) {
      pending.reject(new RemoteDashboardBackendError(
        "remote_protocol_error",
        "remote TUI control result is invalid",
      ));
      return;
    }
    pending.resolve(result as unknown as DashboardCommandResult);
  }

  #onDisconnect(): void {
    if (this.#disposed) return;
    this.#connectionReady = false;
    this.#socket = undefined;
    const error = new RemoteDashboardBackendError(
      "connection_lost_indeterminate",
      "remote TUI connection closed after action submission",
    );
    for (const pending of this.#actions.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#actions.clear();
    if (this.#channels.size > 0 && !this.#reconnecting) void this.#reconnect();
  }

  async #reconnect(): Promise<void> {
    this.#reconnecting = true;
    const abort = new AbortController();
    this.#reconnectAbort = abort;
    try {
      while (!this.#disposed && this.#channels.size > 0) {
        this.#reconnectFailures += 1;
        if (this.#reconnectFailures > this.#limits.reconnectAttempts) {
          this.dispose("remote TUI reconnect attempts exhausted");
          return;
        }
        await delay(
          reconnectDelay(this.#reconnectFailures, this.#limits),
          abort.signal,
        );
        if (abort.signal.aborted) return;
        try {
          await this.#connect(
            this.#controllerChannelId === undefined ? "observer" : "controller",
            this.#lastCursor,
            this.#dimensions,
          );
          if (this.#controllerChannelId !== undefined && this.#remoteRole !== "controller") {
            const channel = this.#channels.get(this.#controllerChannelId);
            this.#controllerChannelId = undefined;
            channel?.setRole("observer");
            channel?.deliver({
              kind: "control",
              identity: this.identity,
              action: "control_denied",
              reason: "controller was not restored after reconnect",
            });
          }
          return;
        } catch (error) {
          const normalized = remoteError(error);
          if (!normalized.retryable) {
            this.dispose(`terminal remote TUI reconnect failure: ${normalized.code}`);
            return;
          }
          // Bounded retry. In-flight input/control was already made indeterminate.
        }
      }
    } finally {
      if (this.#reconnectAbort === abort) this.#reconnectAbort = undefined;
      this.#reconnecting = false;
    }
  }

  async #requestRemoteControl(): Promise<boolean> {
    if (this.#remoteRole === "controller") return true;
    const result = await this.#sendControl("request", `control-${randomUUID()}`);
    return result.state === "completed";
  }

  #serializeControl<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#controlTail.then(operation);
    this.#controlTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  #sendControl(
    action: "request" | "release",
    correlationId: string,
  ): Promise<DashboardCommandResult> {
    return this.#sendAction(
      "control",
      { kind: "control", action, correlationId },
    ) as Promise<DashboardCommandResult>;
  }

  #sendVoid(kind: "resize" | "input", payload: Record<string, unknown>): Promise<void> {
    return this.#sendAction(
      "void",
      { kind, correlationId: `${kind}-${randomUUID()}`, ...payload },
    ) as Promise<void>;
  }

  #sendAction(
    kind: PendingTuiAction["kind"],
    frame: Record<string, unknown>,
  ): Promise<void | DashboardCommandResult> {
    this.#assertConnected();
    if (this.#actions.size >= this.#limits.maxInFlightCommands) {
      return Promise.reject(new RemoteDashboardBackendError(
        "remote_in_flight_capacity",
        "remote TUI action capacity reached",
        true,
      ));
    }
    const correlationId = String(frame.correlationId);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.#actions.delete(correlationId)) return;
        if (kind === "control") {
          resolve({
            correlationId,
            state: "indeterminate",
            error: {
              code: "remote_operation_timeout",
              message: "remote TUI control acknowledgement exceeded its deadline",
              retryable: false,
            },
          });
        } else {
          reject(new RemoteDashboardBackendError(
            "remote_operation_timeout",
            "remote TUI action acknowledgement exceeded its deadline",
          ));
        }
      }, this.#limits.operationTimeoutMs);
      this.#actions.set(correlationId, { kind, resolve, reject, timer });
      try {
        this.#send(frame);
      } catch (error) {
        this.#actions.delete(correlationId);
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error("remote TUI send failed"));
      }
    });
  }

  #send(value: unknown): void {
    this.#assertConnected();
    const encoded = JSON.stringify(value);
    if (Buffer.byteLength(encoded, "utf8") > this.#limits.maxEventBytes) {
      throw new RemoteDashboardBackendError("remote_frame_too_large", "remote TUI frame exceeds its bound");
    }
    this.#socket!.send(encoded);
  }

  #publish(event: DashboardTuiChannelEvent): void {
    const bytes = byteLength(event);
    if (bytes > this.#limits.maxEventBytes) return;
    const cursor = "cursor" in event ? event.cursor : undefined;
    this.#events.push({ event: structuredClone(event), bytes, ...(cursor === undefined ? {} : { cursor }) });
    if (this.#channels.size === 0) this.#initialPending.push(structuredClone(event));
    this.#replayBytes += bytes;
    while (
      this.#events.length > this.#limits.maxReplayEvents ||
      this.#replayBytes > this.#limits.maxReplayBytes
    ) {
      const removed = this.#events.shift();
      if (removed !== undefined) {
        this.#replayBytes -= removed.bytes;
        if (removed.cursor !== undefined) this.#replayBaseCursor = removed.cursor;
      }
      if (this.#channels.size === 0) this.#initialPending.shift();
    }
    for (const channel of this.#channels.values()) channel.deliver(event);
  }

  #replay(cursor: DashboardCursor | undefined): DashboardTuiChannelEvent[] {
    if (cursor === undefined) return [];
    if (cursor === this.#snapshot().highWaterCursor) return [];
    if (cursor === this.#replayBaseCursor) {
      return this.#events.map((entry) => structuredClone(entry.event));
    }
    const gap = this.#events.find((entry) =>
      entry.event.kind === "replay_gap" && entry.event.requestedCursor === cursor
    );
    if (gap !== undefined) return [structuredClone(gap.event)];
    const index = this.#events.findIndex((entry) => entry.cursor === cursor);
    if (index >= 0) {
      return this.#events.slice(index + 1).map((entry) => structuredClone(entry.event));
    }
    return [localGap(this.identity, cursor, this.#snapshot().highWaterCursor)];
  }

  #assertController(channelId: string): void {
    const channel = this.#requireChannel(channelId);
    if (channel.role !== "controller" || this.#controllerChannelId !== channelId) {
      throw new RemoteDashboardBackendError("controller_required", "controller role is required");
    }
  }

  #requireChannel(id: string): RemoteTuiChannel {
    const channel = this.#channels.get(id);
    if (channel === undefined) {
      throw new RemoteDashboardBackendError("channel_closed", "remote TUI channel is closed");
    }
    return channel;
  }

  #snapshot(): DashboardTuiSnapshot {
    if (this.#snapshotValue === undefined) {
      throw new RemoteDashboardBackendError("remote_not_ready", "remote TUI channel has no snapshot", true);
    }
    return this.#snapshotValue;
  }

  #assertConnected(): void {
    this.#assertOpen();
    if (!this.#connectionReady || this.#socket?.readyState !== WebSocket.OPEN) {
      throw new RemoteDashboardBackendError(
        "remote_unavailable",
        "remote TUI channel is reconnecting",
        true,
      );
    }
  }

  #assertOpen(): void {
    if (this.#disposed) {
      throw new RemoteDashboardBackendError("channel_closed", "remote TUI channel is closed");
    }
  }
}

class RemoteTuiChannel implements DashboardTuiChannel {
  readonly presentation = "tui" as const;
  readonly #id: string;
  readonly #pending: DashboardTuiChannelEvent[];
  readonly #hub: RemoteTuiHub;
  readonly #listeners = new Set<DashboardChannelListener<DashboardTuiChannelEvent>>();
  #role: "controller" | "observer";
  #closed = false;

  constructor(
    id: string,
    role: "controller" | "observer",
    pending: DashboardTuiChannelEvent[],
    hub: RemoteTuiHub,
  ) {
    this.#id = id;
    this.#role = role;
    this.#pending = pending;
    this.#hub = hub;
  }

  get identity(): DashboardSessionIdentity {
    return this.#hub.identity;
  }

  get snapshot(): DashboardTuiSnapshot {
    return this.#hub.snapshot;
  }

  get role(): "controller" | "observer" {
    return this.#role;
  }

  setRole(role: "controller" | "observer"): void {
    this.#role = role;
  }

  resize(dimensions: TuiDimensions): Promise<void> {
    this.#assertOpen();
    return this.#hub.resize(this.#id, dimensions);
  }

  sendInput(input: DashboardTuiInput): Promise<void> {
    this.#assertOpen();
    return this.#hub.sendInput(this.#id, input);
  }

  requestControl(correlationId: string): Promise<DashboardCommandResult> {
    this.#assertOpen();
    return this.#hub.requestControl(this.#id, correlationId);
  }

  releaseControl(correlationId: string): Promise<DashboardCommandResult> {
    this.#assertOpen();
    return this.#hub.releaseControl(this.#id, correlationId);
  }

  subscribe(listener: DashboardChannelListener<DashboardTuiChannelEvent>): () => void {
    this.#assertOpen();
    this.#listeners.add(listener);
    for (const event of this.#pending.splice(0)) listener(structuredClone(event));
    return () => this.#listeners.delete(listener);
  }

  attach(listener: DashboardChannelListener<DashboardTuiChannelEvent>): () => void {
    return this.subscribe(listener);
  }

  deliver(event: DashboardTuiChannelEvent): void {
    if (this.#closed) return;
    for (const listener of this.#listeners) listener(structuredClone(event));
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#listeners.clear();
    this.#hub.remove(this.#id);
  }

  forceClose(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#listeners.clear();
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new RemoteDashboardBackendError("channel_closed", "remote TUI channel is closed");
    }
  }
}

function dashboardCapabilities(
  service: DashboardServiceCapabilities,
  localLimits: RemoteDashboardBackendLimits,
): DashboardCapabilities {
  if (
    service.apiVersion !== DASH_API_VERSION ||
    service.authentication !== "service-bearer" ||
    !service.presentations.rich.available ||
    service.presentations.tui.subprotocol !== "pi-daemon-tui.v1"
  ) {
    throw new RemoteDashboardBackendError(
      "remote_capability_mismatch",
      "remote Dashboard service is not compatible with this backend",
    );
  }
  const commands = [...DASHBOARD_COMMANDS];
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
      export: service.resources.export,
      workspaces: true,
      settings: true,
      schedules: service.resources.schedules === true,
      sessionDrafts: service.resources.sessionDrafts === true,
    },
    presentations: {
      rich: { available: true, replay: true, controller: true, commands },
      tui: service.presentations.tui.available
        ? { available: true, replay: true, controller: true, commands }
        : {
            available: false,
            replay: true,
            controller: true,
            commands,
            unavailableReason: service.presentations.tui.unavailableReason ?? "remote-tui-unavailable",
          },
    },
    limits: {
      ...service.limits,
      maxSubscriptionsPerConnection: Math.min(
        service.limits.maxSubscriptionsPerConnection,
        localLimits.maxChannelsPerHub,
      ),
      maxReplayEvents: Math.min(service.limits.maxReplayEvents, localLimits.maxReplayEvents),
      maxReplayEventBytes: Math.min(service.limits.maxReplayEventBytes, localLimits.maxEventBytes),
      maxReplayBytesPerSession: Math.min(
        service.limits.maxReplayBytesPerSession,
        localLimits.maxReplayBytes,
      ),
      maxInFlightCommandsPerConnection: Math.min(
        service.limits.maxInFlightCommandsPerConnection,
        localLimits.maxInFlightCommands,
      ),
    },
    performanceBudgets: { ...DASH_PERFORMANCE_BUDGETS },
  };
}

function mapRpcEvent(
  frame: RpcEventFrame,
  identity: DashboardSessionIdentity,
): DashboardChannelEvent {
  if (
    isRecord(frame.event) &&
    frame.event.type === "extension_ui_request" &&
    typeof frame.event.id === "string"
  ) {
    const { type: _type, id: _id, method, ...payload } = frame.event;
    return {
      kind: "extension_ui",
      identity,
      requestId: frame.event.id,
      method: typeof method === "string" ? method : "unknown",
      payload: boundedObject(payload, DASH_DEFAULT_LIMITS.maxReplayEventBytes),
    } satisfies DashboardExtensionUiEvent;
  }
  return {
    kind: "session_event",
    identity,
    cursor: asDashboardCursor(frame.cursor),
    sequence: frame.sequence,
    event: structuredClone(frame.event) as PiRpcEvent,
  } satisfies DashboardSessionEvent;
}

function mapRpcGap(
  frame: RpcReplayGapFrame,
  identity: DashboardSessionIdentity,
): DashboardReplayGap {
  const reasons = {
    cursor_expired: "cursor-expired",
    host_restarted: "host-restarted",
    generation_changed: "generation-changed",
  } as const;
  return {
    kind: "replay_gap",
    identity,
    reason: reasons[frame.reason],
    requestedCursor: asDashboardCursor(frame.requestedCursor),
    highWaterCursor: asDashboardCursor(frame.highWaterCursor),
    ...(frame.oldestAvailableCursor === undefined
      ? {}
      : { oldestAvailableCursor: asDashboardCursor(frame.oldestAvailableCursor) }),
    snapshotFollows: true,
  };
}

function mapRpcControl(
  frame: RpcControlFrame,
  identity: DashboardSessionIdentity,
): DashboardControlEvent {
  const action = frame.action === "release_control"
    ? "control_released"
    : frame.action;
  if (![
    "control_granted",
    "control_denied",
    "control_released",
  ].includes(action)) {
    throw new RemoteDashboardBackendError("remote_protocol_error", "remote control frame is invalid");
  }
  return {
    kind: "control",
    identity,
    action: action as DashboardControlEvent["action"],
    ...(frame.connectionId === undefined ? {} : { connectionId: frame.connectionId }),
    ...(frame.reason === undefined ? {} : { reason: frame.reason }),
  };
}

function rpcIdentity(frame: RpcAttachReadyFrame): DashboardSessionIdentity {
  if (
    typeof frame.hostInstanceId !== "string" ||
    frame.hostInstanceId.length === 0 ||
    typeof frame.sessionId !== "string" ||
    frame.sessionId.length === 0 ||
    !Number.isSafeInteger(frame.generation) ||
    frame.generation < 0 ||
    typeof frame.highWaterCursor !== "string" ||
    !isRecord(frame.snapshot)
  ) {
    throw new RemoteDashboardBackendError("remote_protocol_error", "remote attach snapshot is invalid");
  }
  return {
    hostInstanceId: frame.hostInstanceId,
    sessionId: frame.sessionId,
    generation: frame.generation,
  };
}

function commandResult(
  response: PiRpcResponse,
  operation: DashboardCommandOperation,
  correlationId: string,
): DashboardCommandResult {
  if (!response.success) {
    const code = typeof response.error === "string"
      ? response.error
      : "rpc_command_failed";
    return rejected(correlationId, code, "remote RPC command was rejected");
  }
  const data = "data" in response ? boundedJsonValue(response.data) : undefined;
  return {
    correlationId,
    state: operation === "prompt" ? "streaming" : "completed",
    ...(data === undefined ? {} : { data }),
  };
}

function rejected(
  correlationId: string,
  code: string,
  message: string,
  retryable = false,
): DashboardCommandResult {
  return {
    correlationId,
    state: "rejected",
    error: { code, message, retryable },
  };
}

function indeterminate(
  correlationId: string,
  message: string,
): DashboardCommandResult {
  return {
    correlationId,
    state: "indeterminate",
    error: {
      code: "connection_lost_indeterminate",
      message,
      retryable: false,
    },
  };
}

function localGap(
  identity: DashboardSessionIdentity,
  requestedCursor: DashboardCursor,
  highWaterCursor: DashboardCursor,
): DashboardReplayGap {
  return {
    kind: "replay_gap",
    identity,
    reason: "cursor-expired",
    requestedCursor,
    highWaterCursor,
    snapshotFollows: true,
  };
}

function assertIdentity(
  received: DashboardSessionIdentity,
  expected: DashboardSessionIdentity,
): void {
  if (
    received.hostInstanceId !== expected.hostInstanceId ||
    received.sessionId !== expected.sessionId ||
    received.generation !== expected.generation
  ) {
    throw new RemoteDashboardBackendError(
      "stale_generation",
      "dashboard command identity is stale",
    );
  }
}

function decodeFrame(raw: RawData, binary: boolean, maxBytes: number): unknown {
  if (binary) throw new RemoteDashboardBackendError("remote_protocol_error", "binary remote frame");
  const bytes = rawDataBuffer(raw);
  if (bytes.length > maxBytes) {
    throw new RemoteDashboardBackendError("remote_frame_too_large", "remote frame exceeds its bound");
  }
  return JSON.parse(bytes.toString("utf8")) as unknown;
}

function rawDataBuffer(value: RawData): Buffer {
  if (Buffer.isBuffer(value)) return value;
  if (Array.isArray(value)) return Buffer.concat(value);
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  throw new RemoteDashboardBackendError("remote_protocol_error", "unsupported remote frame payload");
}

function boundedObject(value: unknown, maxBytes: number): JsonObject {
  const bounded = boundedJsonValue(value, maxBytes);
  return isRecord(bounded) ? bounded : { value: bounded ?? null };
}

function boundedJsonValue(
  value: unknown,
  maxBytes: number = DASH_DEFAULT_LIMITS.maxReplayEventBytes,
): JsonValue | undefined {
  if (value === undefined) return undefined;
  const encoded = JSON.stringify(value);
  if (encoded === undefined) return undefined;
  if (Buffer.byteLength(encoded, "utf8") > maxBytes) {
    return { type: "bounded_output", truncated: true };
  }
  return JSON.parse(encoded) as JsonValue;
}

function resolveLimits(
  overrides: Partial<RemoteDashboardBackendLimits> | undefined,
): RemoteDashboardBackendLimits {
  const result = { ...DEFAULT_REMOTE_DASHBOARD_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(result)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new RangeError(`${name} must be a positive safe integer`);
    }
  }
  if (result.reconnectBaseDelayMs > result.reconnectMaxDelayMs) {
    throw new RangeError("reconnectBaseDelayMs cannot exceed reconnectMaxDelayMs");
  }
  return result;
}

function reconnectDelay(
  attempt: number,
  limits: Pick<RemoteDashboardBackendLimits, "reconnectBaseDelayMs" | "reconnectMaxDelayMs">,
): number {
  return Math.min(
    limits.reconnectMaxDelayMs,
    limits.reconnectBaseDelayMs * 2 ** Math.max(0, attempt - 1),
  );
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    timer.unref?.();
    signal?.addEventListener("abort", finish, { once: true });
  });
}

function sameDimensions(first: TuiDimensions, second: TuiDimensions): boolean {
  return first.rows === second.rows && first.columns === second.columns;
}

function hubKey(sessionId: string, generation: number): string {
  return `${sessionId}\u0000${generation}`;
}

function byteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function errorCode(error: unknown): string {
  return error instanceof Error && "code" in error
    ? String(error.code)
    : "remote_unavailable";
}

function remoteError(error: unknown): RemoteDashboardBackendError {
  if (error instanceof RemoteDashboardBackendError) return error;
  if (error instanceof SessionApiClientError) {
    return new RemoteDashboardBackendError(error.code, error.message, error.retryable);
  }
  return new RemoteDashboardBackendError(
    "remote_unavailable",
    error instanceof Error ? error.message : "remote Dashboard service failed",
    true,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
