import { randomUUID } from "node:crypto";

import WebSocket, { type RawData } from "ws";

import {
  DASH_DEFAULT_LIMITS,
  asDashboardCursor,
  type DashboardChannel,
  type DashboardChannelEvent,
  type DashboardChannelListener,
  type DashboardCommand,
  type DashboardCommandOperation,
  type DashboardCommandResult,
  type DashboardControlEvent,
  type DashboardCursor,
  type DashboardExtensionUiEvent,
  type DashboardExtensionViewEvent,
  type DashboardReplayGap,
  type DashboardSessionEvent,
  type DashboardSessionIdentity,
  type NormalizedTranscriptRecord,
  type SessionChannelOptions,
} from "./dashboard-contract.js";
import {
  EXTENSION_VIEW_DEFAULT_LIMITS,
  EXTENSION_VIEW_PROTOCOL,
  EXTENSION_VIEW_RPC_METHOD,
  ExtensionViewValidationError,
  parseExtensionViewDocument,
  type ExtensionViewDocument,
  parseExtensionViewResponse,
} from "./extension-view-contract.js";
import type {
  JsonObject,
  PiRpcEvent,
  PiRpcResponse,
  RpcAttachReadyFrame,
  RpcControlFrame,
  RpcEventFrame,
  RpcReplayGapFrame,
  RpcTreeNavigateResultFrame,
} from "./session-api.js";
import {
  RemoteDashboardBackendError,
  assertIdentity,
  boundedJsonValue,
  boundedObject,
  byteLength,
  decodeFrame,
  delay,
  errorCode,
  indeterminate,
  isRecord,
  localGap,
  reconnectDelay,
  rejected,
  remoteError,
  type RemoteDashboardBackendClient,
  type RemoteDashboardBackendLimits,
  type RetainedEvent,
} from "./dashboard-remote-transport.js";

/**
 * Rich-presentation transport for the remote Dashboard backend.
 *
 * One `RemoteRichHub` owns a single upstream framed-RPC attachment per session
 * generation, multiplexes it across local `RemoteRichChannel` subscribers, and
 * maps Pi RPC frames onto neutral Dashboard channel events. Reconnect policy,
 * cursor replay, controller arbitration, and in-flight command bookkeeping stay
 * local to this module.
 */

const READ_ONLY_COMMANDS = new Set<DashboardCommandOperation>([
  "get_state",
  "get_entries",
  "get_session_stats",
  "get_commands",
  "get_available_models",
  "get_tree",
]);

export interface RemoteRichHubOptions {
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

export class RemoteRichHub {
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
  readonly #extensionViews = new Map<string, ExtensionViewDocument>();
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
      this.#extensionViews.clear();
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
      const extensionView = this.#extensionViews.get(requestId);
      if (response.protocol === EXTENSION_VIEW_PROTOCOL && extensionView === undefined) {
        throw new RemoteDashboardBackendError("extension_request_not_found", "declarative extension view does not exist");
      }
      const normalized = extensionView === undefined
        ? response
        : response.cancelled === true && Object.keys(response).length === 1
          ? response
          : parseExtensionViewResponse(response, extensionView) as unknown as JsonObject;
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
            response: { ...normalized, type: "extension_ui_response", id: requestId },
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
      this.#extensionViews.delete(requestId);
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
      this.#extensionViews.clear();
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
    this.#extensionViews.clear();
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
    if (frame.kind === "tree_navigate_result") {
      this.#onTreeNavigateResult(frame as unknown as RpcTreeNavigateResultFrame);
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

  #onTreeNavigateResult(frame: RpcTreeNavigateResultFrame): void {
    const pending = this.#commands.get(frame.correlationId);
    if (pending === undefined || pending.operation !== "navigate_tree") return;
    this.#commands.delete(frame.correlationId);
    clearTimeout(pending.timer);
    if (frame.error !== undefined) {
      pending.resolve({
        correlationId: pending.correlationId,
        state: "rejected",
        error: frame.error,
      });
      return;
    }
    if (frame.result === undefined) {
      pending.resolve(rejected(pending.correlationId, "remote_protocol_error", "remote tree navigation result is missing"));
      return;
    }
    const data = boundedJsonValue(frame.result);
    pending.resolve({
      correlationId: pending.correlationId,
      state: "completed",
      ...(data === undefined ? {} : { data }),
    });
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
      this.#send(command.operation === "navigate_tree"
        ? {
            kind: "tree_navigate",
            correlationId: id,
            request: command.payload ?? {},
          }
        : {
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
    if (event.kind === "extension_view") {
      if (event.view === undefined) this.#extensionViews.delete(event.requestId);
      else {
        if (this.#extensionViews.size >= this.#limits.maxReplayEvents) {
          const oldest = this.#extensionViews.keys().next().value;
          if (oldest !== undefined) this.#extensionViews.delete(oldest);
        }
        this.#extensionViews.set(event.requestId, event.view);
      }
    }
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
    if (method === EXTENSION_VIEW_RPC_METHOD) {
      return extensionViewEvent(frame.event.id, payload.view, identity, DASH_DEFAULT_LIMITS.maxReplayEventBytes);
    }
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

function extensionViewEvent(
  requestId: string,
  rawView: unknown,
  identity: DashboardSessionIdentity,
  maxBytes: number,
): DashboardExtensionViewEvent {
  const provenance = {
    transport: "pi-rpc",
    validator: "pi-daemon",
    browserCodeExecution: false,
  } as const;
  try {
    const view = parseExtensionViewDocument(rawView, {
      maxViewBytes: Math.min(EXTENSION_VIEW_DEFAULT_LIMITS.maxViewBytes, maxBytes),
    });
    return {
      kind: "extension_view",
      identity,
      requestId,
      provenance: { ...provenance, validation: "validated" },
      fallback: { text: view.fallbackText, reason: "unsupported-renderer" },
      view,
    };
  } catch (error) {
    const reason = error instanceof ExtensionViewValidationError ? error.code : "invalid-view";
    return {
      kind: "extension_view",
      identity,
      requestId,
      provenance: { ...provenance, validation: "rejected" },
      fallback: { text: safeExtensionFallback(rawView), reason },
    };
  }
}

function safeExtensionFallback(rawView: unknown): string {
  if (isRecord(rawView) && typeof rawView.fallbackText === "string") {
    const value = rawView.fallbackText;
    if (
      value.length > 0 &&
      Buffer.byteLength(value, "utf8") <= 4_096 &&
      !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)
    ) return value;
  }
  return "This extension view is unavailable; use the compatible TUI fallback.";
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
