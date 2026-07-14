import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

import type { RpcExtensionUIResponse, RpcResponse } from "@earendil-works/pi-coding-agent";

import { Multiplexer, MultiplexerError } from "./multiplexer.js";
import {
  PI_RPC_HOST_CAPABILITIES,
  type PiRpcController,
  type PiRpcControllerOutput,
} from "./pi-rpc-controller.js";
import {
  ProtocolSerializationError,
  encodeBoundedLine,
  type EventEnvelope,
} from "./protocol.js";
import {
  SESSION_RPC_SUBPROTOCOLS,
  type PiRpcCommand,
  type RpcAttachReadyFrame,
  type RpcEventFrame,
  type RpcReplayGapFrame,
  type SessionRpcSubprotocol,
} from "./session-api.js";
import { catalogRecordToSessionResource } from "./session-catalog.js";
import {
  WebSocketHandshakeError,
  WebSocketPeer,
  acceptWebSocket,
  validateWebSocketHandshake,
} from "./websocket.js";

export interface RpcAttachmentLimits {
  maxHubs: number;
  maxReplayEvents: number;
  maxReplayBytes: number;
  maxTotalReplayBytes: number;
  maxMessageBytes: number;
  maxOutboundBytesPerConnection: number;
  maxInFlightCommandsPerConnection: number;
  keepAliveMs: number;
}

export const DEFAULT_RPC_ATTACHMENT_LIMITS: Readonly<RpcAttachmentLimits> = {
  maxHubs: 32,
  maxReplayEvents: 512,
  maxReplayBytes: 2 * 1024 * 1024,
  maxTotalReplayBytes: 64 * 1024 * 1024,
  maxMessageBytes: 1024 * 1024,
  maxOutboundBytesPerConnection: 4 * 1024 * 1024,
  maxInFlightCommandsPerConnection: 8,
  keepAliveMs: 30_000,
};

export class RpcAttachmentError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;

  constructor(status: number, code: string, message: string, retryable = false) {
    super(message);
    this.name = "RpcAttachmentError";
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

export interface RpcAttachmentCapabilities {
  subprotocols: typeof SESSION_RPC_SUBPROTOCOLS;
  host: typeof PI_RPC_HOST_CAPABILITIES;
  limits: RpcAttachmentLimits;
  roles: readonly ["controller", "observer"];
  replay: true;
}

interface RetainedRpcEvent {
  sequence: number;
  cursor: string;
  event: PiRpcControllerOutput;
  bytes: number;
}

interface RpcConnection {
  id: string;
  peer: WebSocketPeer;
  protocol: SessionRpcSubprotocol;
  role: "controller" | "observer";
  ready: boolean;
  inFlight: number;
}

interface ParsedCursor {
  hostInstanceId: string;
  sessionId: string;
  generation: number;
  sequence: number;
}

const READ_ONLY_COMMANDS = new Set([
  "get_state",
  "get_available_models",
  "get_session_stats",
  "get_fork_messages",
  "get_entries",
  "get_tree",
  "get_last_assistant_text",
  "get_messages",
  "get_commands",
]);

export class RpcAttachmentManager {
  readonly limits: RpcAttachmentLimits;
  readonly #multiplexer: Multiplexer;
  readonly #hubs = new Map<string, RpcAttachmentHub>();
  readonly #unsubscribeMultiplexer: () => void;
  #disposed = false;

  constructor(multiplexer: Multiplexer, limits: Partial<RpcAttachmentLimits> = {}) {
    this.#multiplexer = multiplexer;
    this.limits = resolveLimits(limits);
    this.#unsubscribeMultiplexer = multiplexer.subscribe((event) => this.#onMultiplexerEvent(event));
  }

  get capabilities(): RpcAttachmentCapabilities {
    return {
      subprotocols: SESSION_RPC_SUBPROTOCOLS,
      host: PI_RPC_HOST_CAPABILITIES,
      limits: { ...this.limits },
      roles: ["controller", "observer"],
      replay: true,
    };
  }

  async attach(
    request: IncomingMessage,
    socket: Duplex,
    sessionRef: string,
    url: URL,
  ): Promise<void> {
    if (this.#disposed) throw new RpcAttachmentError(503, "server_stopping", "RPC attachment server is stopping", true);
    socket.pause();
    const key = validateWebSocketHandshake(request);
    const protocol = selectSubprotocol(request.headers["sec-websocket-protocol"]);
    const requestedRole = parseRole(url.searchParams.get("role"));
    const requestedGeneration = parseGeneration(url.searchParams.get("generation"));
    const requestedCursor = parseRequestedCursor(url.searchParams.get("cursor"));
    if (protocol === "pi-rpc.v1" && requestedCursor !== undefined) {
      throw new RpcAttachmentError(400, "cursor_not_supported", "raw Pi RPC attachments do not support cursors");
    }

    const record = await this.#multiplexer.retainedSession(sessionRef);
    if (record === undefined) {
      throw new RpcAttachmentError(404, "session_not_found", "session not found");
    }
    const generation = requestedGeneration ?? record.generation;
    if (generation !== record.generation) {
      throw new RpcAttachmentError(409, "stale_generation", "session generation changed");
    }
    let controller: PiRpcController;
    try {
      controller = await this.#multiplexer.rpcController(record.sessionId, generation);
    } catch (error) {
      throw attachmentError(error);
    }
    const hub = this.#hub(record.sessionId, generation, controller);
    if (protocol === "pi-rpc.v1" && requestedRole === "controller" && hub.hasController) {
      throw new RpcAttachmentError(409, "controller_busy", "session already has a controller attachment", true);
    }

    const peer = acceptWebSocket(socket, key, {
      protocol,
      limits: {
        maxMessageBytes: this.limits.maxMessageBytes,
        maxOutboundBytes: this.limits.maxOutboundBytesPerConnection,
        keepAliveMs: this.limits.keepAliveMs,
      },
    });
    const initialization = hub.add(peer, protocol, requestedRole, requestedCursor);
    socket.resume();
    await initialization;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#unsubscribeMultiplexer();
    for (const hub of this.#hubs.values()) hub.dispose(1001, "server stopping");
    this.#hubs.clear();
  }

  #hub(sessionId: string, generation: number, controller: PiRpcController): RpcAttachmentHub {
    const key = hubKey(sessionId, generation);
    const existing = this.#hubs.get(key);
    if (existing !== undefined) return existing;
    if (this.#hubs.size >= this.limits.maxHubs) {
      const idle = [...this.#hubs.entries()].find(([, hub]) => hub.connectionCount === 0);
      if (idle === undefined) {
        throw new RpcAttachmentError(503, "attachment_capacity", "RPC attachment capacity reached", true);
      }
      idle[1].dispose(1001, "attachment hub evicted");
      this.#hubs.delete(idle[0]);
    }
    const hub = new RpcAttachmentHub(
      this.#multiplexer,
      this.#multiplexer.hostInstanceId,
      sessionId,
      generation,
      controller,
      this.limits,
    );
    this.#hubs.set(key, hub);
    return hub;
  }

  #onMultiplexerEvent(event: EventEnvelope): void {
    for (const [key, hub] of this.#hubs) {
      if (hub.sessionId !== event.sessionId) continue;
      if (
        hub.generation !== event.generation ||
        ["sessionClosed", "sessionDormant", "sessionDeleted"].includes(event.event)
      ) {
        hub.dispose(1012, "session generation or residency changed");
        this.#hubs.delete(key);
      }
    }
  }
}

class RpcAttachmentHub {
  readonly sessionId: string;
  readonly generation: number;
  readonly #multiplexer: Multiplexer;
  readonly #hostInstanceId: string;
  readonly #controller: PiRpcController;
  readonly #limits: RpcAttachmentLimits;
  readonly #connections = new Map<string, RpcConnection>();
  readonly #events: RetainedRpcEvent[] = [];
  readonly #unsubscribeController: () => void;
  #controllerConnectionId: string | undefined;
  #sequence = 0;
  #replayBytes = 0;
  #disposed = false;

  constructor(
    multiplexer: Multiplexer,
    hostInstanceId: string,
    sessionId: string,
    generation: number,
    controller: PiRpcController,
    limits: RpcAttachmentLimits,
  ) {
    this.#multiplexer = multiplexer;
    this.#hostInstanceId = hostInstanceId;
    this.sessionId = sessionId;
    this.generation = generation;
    this.#controller = controller;
    this.#limits = limits;
    this.#unsubscribeController = controller.subscribe((output) => this.#publish(output));
  }

  get hasController(): boolean {
    return this.#controllerConnectionId !== undefined;
  }

  get connectionCount(): number {
    return this.#connections.size;
  }

  async add(
    peer: WebSocketPeer,
    protocol: SessionRpcSubprotocol,
    requestedRole: "controller" | "observer",
    requestedCursor: ParsedCursor | undefined,
  ): Promise<void> {
    if (this.#disposed) {
      peer.close(1012, "session attachment closed");
      return;
    }
    const id = randomUUID();
    const controllerGranted = requestedRole === "controller" && !this.hasController;
    const connection: RpcConnection = {
      id,
      peer,
      protocol,
      role: controllerGranted ? "controller" : "observer",
      ready: protocol === "pi-rpc.v1",
      inFlight: 0,
    };
    if (controllerGranted) this.#controllerConnectionId = id;
    this.#connections.set(id, connection);
    peer.setHandlers({
      onMessage: (text) => this.#onMessage(connection, text),
      onClose: () => this.#remove(connection),
    });

    if (protocol === "pi-rpc.v1") return;
    try {
      await this.#initializeFramed(connection, requestedCursor);
      if (requestedRole === "controller" && !controllerGranted) {
        this.#send(connection, {
          kind: "control",
          action: "control_denied",
          connectionId: id,
          reason: "controller_busy",
        });
      }
    } catch {
      peer.close(1011, "failed to capture RPC snapshot");
    }
  }

  dispose(code: number, reason: string): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#unsubscribeController();
    if (this.#controllerConnectionId !== undefined) cancelPendingUi(this.#controller);
    this.#controllerConnectionId = undefined;
    for (const connection of this.#connections.values()) connection.peer.close(code, reason);
    this.#connections.clear();
    this.#events.length = 0;
    this.#replayBytes = 0;
  }

  async #initializeFramed(
    connection: RpcConnection,
    requestedCursor: ParsedCursor | undefined,
  ): Promise<void> {
    const captured = await this.#snapshot();
    const { boundary, snapshot } = captured;
    if (connection.peer.closed || !this.#connections.has(connection.id)) return;
    const replay = this.#replayDecision(requestedCursor, boundary);
    if (replay.gap !== undefined) this.#send(connection, replay.gap);
    const oldestAvailableCursor = this.#oldestCursor();
    const ready: RpcAttachReadyFrame = {
      kind: "attach_ready",
      connectionId: connection.id,
      role: connection.role,
      hostInstanceId: this.#hostInstanceId,
      sessionId: this.sessionId,
      generation: this.generation,
      highWaterCursor: this.#cursor(boundary),
      ...(oldestAvailableCursor === undefined ? {} : { oldestAvailableCursor }),
      snapshot,
    };
    this.#send(connection, ready);
    for (const event of this.#events) {
      if (event.sequence > replay.afterSequence) this.#sendEvent(connection, event);
    }
    connection.ready = true;
  }

  async #snapshot(): Promise<{
    boundary: number;
    snapshot: RpcAttachReadyFrame["snapshot"];
  }> {
    const record = await this.#multiplexer.retainedSession(this.sessionId);
    if (record === undefined || record.generation !== this.generation) {
      throw new Error("session changed while attaching");
    }
    // These reads and the sequence boundary are synchronous in one event-loop
    // turn. Events before the boundary are represented by the snapshot; events
    // after it enter the retained/live stream.
    const requestState = this.#multiplexer.status(this.sessionId);
    const rpc = this.#controller.snapshot();
    const boundary = this.#sequence;
    return {
      boundary,
      snapshot: {
        session: catalogRecordToSessionResource(record),
        requestState: requestState as unknown as RpcAttachReadyFrame["snapshot"]["requestState"],
        rpcState: rpc.rpcState as RpcAttachReadyFrame["snapshot"]["rpcState"],
        ...(rpc.leafId === null ? { leafId: null } : { leafId: rpc.leafId }),
      },
    };
  }

  #replayDecision(
    requested: ParsedCursor | undefined,
    boundary: number,
  ): { afterSequence: number; gap?: RpcReplayGapFrame } {
    if (requested === undefined) return { afterSequence: boundary };
    let reason: RpcReplayGapFrame["reason"] | undefined;
    if (requested.hostInstanceId !== this.#hostInstanceId) reason = "host_restarted";
    else if (requested.sessionId !== this.sessionId || requested.generation !== this.generation) {
      reason = "generation_changed";
    } else {
      const oldest = this.#events[0]?.sequence;
      if (requested.sequence > this.#sequence || (oldest !== undefined && requested.sequence < oldest - 1)) {
        reason = "cursor_expired";
      }
    }
    if (reason === undefined) return { afterSequence: requested.sequence };
    const oldestAvailableCursor = this.#oldestCursor();
    return {
      afterSequence: boundary,
      gap: {
        kind: "replay_gap",
        reason,
        requestedCursor: encodeCursor(requested),
        ...(oldestAvailableCursor === undefined ? {} : { oldestAvailableCursor }),
        highWaterCursor: this.#cursor(boundary),
        snapshotFollows: true,
      },
    };
  }

  #onMessage(connection: RpcConnection, text: string): void {
    let value: unknown;
    try {
      value = JSON.parse(text) as unknown;
    } catch {
      connection.peer.close(1007, "invalid JSON");
      return;
    }
    if (connection.inFlight >= this.#limits.maxInFlightCommandsPerConnection) {
      this.#sendResponse(connection, overloadedResponse(value));
      return;
    }
    if (connection.protocol === "pi-daemon-rpc.v1" && isControlFrame(value)) {
      this.#handleControl(connection, value.action);
      return;
    }
    if (connection.protocol === "pi-daemon-rpc.v1" && isExtensionUiResponseFrame(value)) {
      this.#handleExtensionUiResponse(connection, value.response);
      return;
    }
    const command =
      connection.protocol === "pi-daemon-rpc.v1" && isCommandFrame(value)
        ? value.command
        : connection.protocol === "pi-rpc.v1"
          ? value
          : undefined;
    if (command === undefined) {
      connection.peer.close(1008, "invalid RPC frame");
      return;
    }
    if (isExtensionUiResponse(command)) {
      this.#handleExtensionUiResponse(connection, command);
      return;
    }
    const type = rpcType(command);
    if (connection.role !== "controller" && !READ_ONLY_COMMANDS.has(type)) {
      this.#sendResponse(connection, deniedResponse(command, "controller_required"));
      return;
    }
    connection.inFlight += 1;
    void this.#controller
      .handle(command)
      .then((response) => this.#sendResponse(connection, response))
      .catch(() => this.#sendResponse(connection, deniedResponse(command, "rpc_dispatch_failed")))
      .finally(() => {
        connection.inFlight -= 1;
      });
  }

  #handleControl(connection: RpcConnection, action: string): void {
    if (action === "request_control") {
      if (this.#controllerConnectionId === undefined || this.#controllerConnectionId === connection.id) {
        this.#controllerConnectionId = connection.id;
        connection.role = "controller";
        this.#send(connection, {
          kind: "control",
          action: "control_granted",
          connectionId: connection.id,
        });
      } else {
        this.#send(connection, {
          kind: "control",
          action: "control_denied",
          connectionId: connection.id,
          reason: "controller_busy",
        });
      }
      return;
    }
    if (action === "release_control" && this.#controllerConnectionId === connection.id) {
      this.#controllerConnectionId = undefined;
      connection.role = "observer";
      cancelPendingUi(this.#controller);
      this.#send(connection, {
        kind: "control",
        action: "release_control",
        connectionId: connection.id,
        reason: "released",
      });
    }
  }

  #handleExtensionUiResponse(
    connection: RpcConnection,
    response: RpcExtensionUIResponse,
  ): void {
    const accepted =
      connection.role === "controller" && this.#controller.respondToExtensionUi(response);
    this.#sendResponse(connection, {
      type: "response",
      command: "extension_ui_response",
      success: accepted,
      ...(accepted ? {} : { error: connection.role === "controller" ? "unknown_ui_request" : "controller_required" }),
    } as RpcResponse);
  }

  #publish(output: PiRpcControllerOutput): void {
    if (this.#disposed) return;
    const event = safeOutput(output, this.#limits.maxMessageBytes);
    this.#sequence += 1;
    const retained: RetainedRpcEvent = {
      sequence: this.#sequence,
      cursor: this.#cursor(this.#sequence),
      event,
      bytes: encodedBytes(event, this.#limits.maxMessageBytes),
    };
    this.#events.push(retained);
    this.#replayBytes += retained.bytes;
    while (
      this.#events.length > this.#limits.maxReplayEvents ||
      this.#replayBytes > this.#limits.maxReplayBytes
    ) {
      const removed = this.#events.shift();
      if (removed === undefined) break;
      this.#replayBytes -= removed.bytes;
    }
    for (const connection of this.#connections.values()) {
      if (connection.ready) this.#sendEvent(connection, retained);
    }
    if (isExtensionUiRequest(event) && this.#controllerConnectionId === undefined) {
      cancelPendingUi(this.#controller);
    }
  }

  #sendEvent(connection: RpcConnection, event: RetainedRpcEvent): void {
    if (connection.protocol === "pi-rpc.v1") {
      this.#send(connection, event.event);
      return;
    }
    const frame: RpcEventFrame = {
      kind: "event",
      cursor: event.cursor,
      sequence: event.sequence,
      event: event.event as RpcEventFrame["event"],
    };
    this.#send(connection, frame);
  }

  #sendResponse(connection: RpcConnection, response: RpcResponse): void {
    this.#send(
      connection,
      connection.protocol === "pi-rpc.v1" ? response : { kind: "response", response },
      response,
    );
  }

  #send(connection: RpcConnection, value: unknown, responseFallback?: RpcResponse): void {
    const failure = connection.peer.sendJson(value);
    if (failure === undefined) return;
    if (responseFallback !== undefined) {
      const fallback = {
        type: "response",
        command: responseFallback.command,
        success: false,
        ...(responseFallback.id === undefined ? {} : { id: responseFallback.id }),
        error: failure.code,
      } as RpcResponse;
      const retry = connection.peer.sendJson(
        connection.protocol === "pi-rpc.v1"
          ? fallback
          : { kind: "response", response: fallback },
      );
      if (retry === undefined) return;
    }
    connection.peer.close(1009, "outbound RPC message exceeds limit");
  }

  #remove(connection: RpcConnection): void {
    if (!this.#connections.delete(connection.id)) return;
    if (this.#controllerConnectionId === connection.id) {
      this.#controllerConnectionId = undefined;
      cancelPendingUi(this.#controller);
    }
  }

  #cursor(sequence: number): string {
    return encodeCursor({
      hostInstanceId: this.#hostInstanceId,
      sessionId: this.sessionId,
      generation: this.generation,
      sequence,
    });
  }

  #oldestCursor(): string | undefined {
    return this.#events[0]?.cursor;
  }
}

function safeOutput(output: PiRpcControllerOutput, maxBytes: number): PiRpcControllerOutput {
  try {
    const encoded = encodeBoundedLine(output, Math.max(1, maxBytes - 2048));
    return JSON.parse(encoded.toString("utf8")) as PiRpcControllerOutput;
  } catch (error) {
    const code = error instanceof ProtocolSerializationError ? error.code : "outbound_not_serializable";
    return {
      type: "rpc_event_dropped",
      originalType: rpcType(output),
      error: { code },
    } as unknown as PiRpcControllerOutput;
  }
}

function encodedBytes(value: unknown, maxBytes: number): number {
  try {
    return encodeBoundedLine(value, maxBytes).length;
  } catch {
    return 0;
  }
}

function deniedResponse(value: unknown, error: string): RpcResponse {
  const record = isRecord(value) && isRecord(value.response) ? value.response : value;
  return {
    type: "response",
    command: rpcType(record),
    success: false,
    ...(isRecord(record) && typeof record.id === "string" ? { id: record.id } : {}),
    error,
  } as RpcResponse;
}

function overloadedResponse(value: unknown): RpcResponse {
  return deniedResponse(value, "rpc_in_flight_capacity");
}

function isCommandFrame(value: unknown): value is { kind: "command"; command: PiRpcCommand } {
  return isRecord(value) && value.kind === "command" && isRecord(value.command);
}

function isExtensionUiResponseFrame(
  value: unknown,
): value is { kind: "extension_ui_response"; response: RpcExtensionUIResponse } {
  return isRecord(value) && value.kind === "extension_ui_response" && isExtensionUiResponse(value.response);
}

function isControlFrame(value: unknown): value is { kind: "control"; action: string } {
  return (
    isRecord(value) &&
    value.kind === "control" &&
    (value.action === "request_control" || value.action === "release_control")
  );
}

function isExtensionUiResponse(value: unknown): value is RpcExtensionUIResponse {
  return isRecord(value) && value.type === "extension_ui_response" && typeof value.id === "string";
}

function isExtensionUiRequest(value: unknown): boolean {
  return isRecord(value) && value.type === "extension_ui_request";
}

function rpcType(value: unknown): string {
  return isRecord(value) && typeof value.type === "string" ? value.type : "unknown";
}

function parseRole(value: string | null): "controller" | "observer" {
  if (value === null) return "observer";
  if (value === "controller" || value === "observer") return value;
  throw new RpcAttachmentError(400, "invalid_attachment_role", "attachment role is invalid");
}

function parseGeneration(value: string | null): number | undefined {
  if (value === null) return undefined;
  if (!/^\d+$/.test(value)) {
    throw new RpcAttachmentError(400, "invalid_generation", "attachment generation is invalid");
  }
  const generation = Number(value);
  if (!Number.isSafeInteger(generation) || generation < 0) {
    throw new RpcAttachmentError(400, "invalid_generation", "attachment generation is invalid");
  }
  return generation;
}

function parseRequestedCursor(value: string | null): ParsedCursor | undefined {
  if (value === null) return undefined;
  if (value.length < 1 || value.length > 1024) {
    throw new RpcAttachmentError(400, "invalid_cursor", "attachment cursor is invalid");
  }
  try {
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    if (
      !isRecord(decoded) ||
      decoded.v !== 1 ||
      typeof decoded.h !== "string" ||
      typeof decoded.s !== "string" ||
      !Number.isSafeInteger(decoded.g) ||
      !Number.isSafeInteger(decoded.q) ||
      (decoded.g as number) < 0 ||
      (decoded.q as number) < 0
    ) {
      throw new Error("invalid cursor");
    }
    return {
      hostInstanceId: decoded.h,
      sessionId: decoded.s,
      generation: decoded.g as number,
      sequence: decoded.q as number,
    };
  } catch {
    throw new RpcAttachmentError(400, "invalid_cursor", "attachment cursor is invalid");
  }
}

function encodeCursor(cursor: ParsedCursor): string {
  return Buffer.from(
    JSON.stringify({
      v: 1,
      h: cursor.hostInstanceId,
      s: cursor.sessionId,
      g: cursor.generation,
      q: cursor.sequence,
    }),
    "utf8",
  ).toString("base64url");
}

function selectSubprotocol(value: string | string[] | undefined): SessionRpcSubprotocol {
  const offered = (Array.isArray(value) ? value.join(",") : (value ?? ""))
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  for (const protocol of offered) {
    if ((SESSION_RPC_SUBPROTOCOLS as readonly string[]).includes(protocol)) {
      return protocol as SessionRpcSubprotocol;
    }
  }
  throw new RpcAttachmentError(
    426,
    "rpc_subprotocol_required",
    `one supported RPC subprotocol is required: ${SESSION_RPC_SUBPROTOCOLS.join(", ")}`,
  );
}

function attachmentError(error: unknown): RpcAttachmentError {
  if (error instanceof RpcAttachmentError) return error;
  if (error instanceof WebSocketHandshakeError) {
    return new RpcAttachmentError(error.status, error.code, error.message);
  }
  if (error instanceof MultiplexerError) {
    const status =
      error.code === "session_not_found"
        ? 404
        : ["stale_generation", "session_not_resident"].includes(error.code)
          ? 409
          : 422;
    return new RpcAttachmentError(status, error.code, error.message, error.retryable);
  }
  return new RpcAttachmentError(500, "rpc_attach_failed", "RPC attachment failed");
}

function resolveLimits(overrides: Partial<RpcAttachmentLimits>): RpcAttachmentLimits {
  const result = { ...DEFAULT_RPC_ATTACHMENT_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(result)) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  }
  if (result.maxMessageBytes < 4096) throw new Error("maxMessageBytes must be at least 4096");
  if (
    !Number.isSafeInteger(result.maxReplayBytes * result.maxHubs) ||
    result.maxReplayBytes * result.maxHubs > result.maxTotalReplayBytes
  ) {
    throw new Error("maxReplayBytes multiplied by maxHubs must not exceed maxTotalReplayBytes");
  }
  if (result.maxMessageBytes > result.maxOutboundBytesPerConnection) {
    throw new Error("maxMessageBytes must not exceed maxOutboundBytesPerConnection");
  }
  return result;
}

function cancelPendingUi(controller: PiRpcController): void {
  try {
    controller.cancelPendingUi();
  } catch {
    // Session replacement may dispose the controller before the transport event.
  }
}

function hubKey(sessionId: string, generation: number): string {
  return `${sessionId}\u0000${generation}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
