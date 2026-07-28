import { randomUUID } from "node:crypto";

import WebSocket, { type RawData } from "ws";

import type {
  DashboardChannelListener,
  DashboardCommandResult,
  DashboardControlEvent,
  DashboardCursor,
  DashboardReplayGap,
  DashboardSessionIdentity,
  DashboardTuiChannel,
  DashboardTuiChannelEvent,
  DashboardTuiInput,
  DashboardTuiSnapshot,
  TuiChannelOptions,
  TuiDimensions,
} from "./dashboard-contract.js";
import {
  RemoteDashboardBackendError,
  byteLength,
  decodeFrame,
  delay,
  isRecord,
  localGap,
  reconnectDelay,
  rejected,
  remoteError,
  sameDimensions,
  type RemoteDashboardBackendClient,
  type RemoteDashboardBackendLimits,
  type RetainedEvent,
} from "./dashboard-remote-transport.js";

/**
 * TUI-presentation transport for the remote Dashboard backend.
 *
 * One `RemoteTuiHub` owns a single upstream shadow-TUI attachment per session
 * generation and fans its snapshots, diffs, and control frames out to local
 * `RemoteTuiChannel` subscribers. Resize arbitration, input gating, reconnect
 * policy, and retained-frame bounds stay local to this module.
 */

export interface RemoteTuiHubOptions {
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

export class RemoteTuiHub {
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
