import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

import type {
  DashboardBackend,
  DashboardCommandResult,
  DashboardCursor,
  DashboardTuiChannel,
  DashboardTuiChannelEvent,
  DashboardTuiInput,
  TuiDimensions,
} from "./dashboard-contract.js";
import {
  DashboardTuiAttachmentError,
  type DashboardTuiAttachmentManager,
} from "./dashboard-tui-attachments.js";
import { DASHBOARD_TUI_SUBPROTOCOL } from "./session-api.js";
import {
  acceptWebSocket,
  validateWebSocketHandshake,
  WebSocketPeer,
} from "./websocket.js";

export interface ShadowTuiAttachmentLimits {
  maxMessageBytes: number;
  maxOutboundBytes: number;
  keepAliveMs: number;
}

export const DEFAULT_SHADOW_TUI_ATTACHMENT_LIMITS: Readonly<ShadowTuiAttachmentLimits> = {
  maxMessageBytes: 1024 * 1024,
  maxOutboundBytes: 4 * 1024 * 1024,
  keepAliveMs: 30_000,
};

/** Authenticated API WebSocket adapter over the same canonical DashboardTuiChannel. */
export class ShadowTuiAttachmentManager implements DashboardTuiAttachmentManager {
  readonly available = true;
  readonly #backend: Pick<DashboardBackend, "openTuiChannel">;
  readonly #limits: ShadowTuiAttachmentLimits;

  constructor(
    backend: Pick<DashboardBackend, "openTuiChannel">,
    limits: Partial<ShadowTuiAttachmentLimits> = {},
  ) {
    this.#backend = backend;
    this.#limits = resolveLimits(limits);
  }

  async attach(
    request: IncomingMessage,
    socket: Duplex,
    sessionRef: string,
    url: URL,
  ): Promise<void> {
    socket.pause();
    let channel: DashboardTuiChannel | undefined;
    try {
      const key = validateWebSocketHandshake(request);
      if (request.headers["sec-websocket-protocol"] !== DASHBOARD_TUI_SUBPROTOCOL) {
        throw new DashboardTuiAttachmentError(400, "tui_subprotocol_required", "TUI subprotocol is required");
      }
      const requestedGeneration = generation(url.searchParams.get("generation"));
      const requestedCursor = url.searchParams.get("cursor");
      channel = await this.#backend.openTuiChannel({
        sessionRef,
        role: role(url.searchParams.get("role")),
        dimensions: dimensions(url.searchParams),
        ...(requestedGeneration === undefined ? {} : { generation: requestedGeneration }),
        ...(requestedCursor === null ? {} : { cursor: requestedCursor as DashboardCursor }),
      });
      const peer = acceptWebSocket(socket, key, {
        protocol: DASHBOARD_TUI_SUBPROTOCOL,
        limits: this.#limits,
      });
      const pendingEvents: DashboardTuiChannelEvent[] = [];
      let live = false;
      const unsubscribe = channel.subscribe((event) => {
        if (live) sendEvent(peer, channel!, event);
        else pendingEvents.push(event);
      });
      let closed = false;
      const close = (): void => {
        if (closed) return;
        closed = true;
        unsubscribe();
        void channel?.close();
      };
      peer.setHandlers({
        onMessage: (text) => void this.#onMessage(peer, channel!, text),
        onClose: close,
      });
      const firstIsGap = pendingEvents[0]?.kind === "replay_gap";
      if (!firstIsGap && peer.sendJson({ kind: "snapshot", role: channel.role, snapshot: channel.snapshot }) !== undefined) {
        close();
        peer.close(1009, "TUI snapshot exceeds output bound");
        return;
      }
      for (const event of pendingEvents) sendEvent(peer, channel, event);
      live = true;
      socket.resume();
    } catch (error) {
      await channel?.close().catch(() => undefined);
      socket.resume();
      throw normalizeError(error);
    }
  }

  async #onMessage(peer: WebSocketPeer, channel: DashboardTuiChannel, text: string): Promise<void> {
    let frame: Record<string, unknown>;
    try {
      const value: unknown = JSON.parse(text);
      if (!isRecord(value)) throw new Error("TUI frame must be an object");
      frame = value;
    } catch {
      peer.close(1007, "invalid TUI frame");
      return;
    }
    const correlationId = string(frame.correlationId, "correlationId", 128);
    try {
      let result: DashboardCommandResult | undefined;
      switch (frame.kind) {
        case "resize":
          await channel.resize(dimensionsRecord(frame.dimensions));
          break;
        case "input":
          await channel.sendInput(input(frame.input));
          break;
        case "control":
          if (frame.action === "request") result = await channel.requestControl(correlationId);
          else if (frame.action === "release") result = await channel.releaseControl(correlationId);
          else throw new Error("unknown TUI control action");
          break;
        default:
          throw new Error("unknown TUI frame kind");
      }
      const output = result === undefined
        ? { kind: "ack", correlationId, role: channel.role }
        : { kind: "command_result", correlationId, role: channel.role, result };
      if (peer.sendJson(output) !== undefined) peer.close(1009, "TUI response exceeds output bound");
    } catch (error) {
      const output = {
        kind: "error",
        correlationId,
        error: {
          code: error instanceof Error && "code" in error ? String(error.code) : "tui_command_failed",
          message: error instanceof Error ? error.message : "TUI command failed",
        },
      };
      if (peer.sendJson(output) !== undefined) peer.close(1009, "TUI error exceeds output bound");
    }
  }
}

function sendEvent(
  peer: WebSocketPeer,
  channel: DashboardTuiChannel,
  event: DashboardTuiChannelEvent,
): void {
  if (event.kind === "replay_gap") {
    if (peer.sendJson({ kind: "replay_gap", gap: event }) !== undefined) {
      peer.close(1009, "TUI replay gap exceeds output bound");
      return;
    }
    if (peer.sendJson({ kind: "snapshot", role: channel.role, snapshot: channel.snapshot }) !== undefined) {
      peer.close(1009, "TUI snapshot exceeds output bound");
    }
    return;
  }
  const value = event.kind === "tui_delta"
    ? { kind: "delta", delta: event }
    : { kind: "control", event, role: channel.role };
  if (peer.sendJson(value) !== undefined) peer.close(1009, "TUI event exceeds output bound");
}

function role(value: string | null): "controller" | "observer" {
  if (value === null || value === "observer") return "observer";
  if (value === "controller") return "controller";
  throw new DashboardTuiAttachmentError(400, "invalid_tui_role", "TUI role is invalid");
}

function generation(value: string | null): number | undefined {
  if (value === null) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new DashboardTuiAttachmentError(400, "invalid_tui_generation", "TUI generation is invalid");
  }
  return parsed;
}

function dimensions(params: URLSearchParams): TuiDimensions {
  return {
    rows: dimension(params.get("rows"), 24, "rows", 200),
    columns: dimension(params.get("columns"), 80, "columns", 320),
  };
}

function dimensionsRecord(value: unknown): TuiDimensions {
  if (!isRecord(value)) throw new Error("TUI dimensions must be an object");
  return {
    rows: dimensionValue(value.rows, "rows", 200),
    columns: dimensionValue(value.columns, "columns", 320),
  };
}

function dimension(value: string | null, fallback: number, name: string, maximum: number): number {
  return value === null ? fallback : dimensionValue(Number(value), name, maximum);
}

function dimensionValue(value: unknown, name: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) {
    throw new DashboardTuiAttachmentError(400, "invalid_tui_dimensions", `TUI ${name} is invalid`);
  }
  return value as number;
}

function input(value: unknown): DashboardTuiInput {
  if (!isRecord(value) || typeof value.type !== "string") throw new Error("TUI input is invalid");
  if (value.type === "text" || value.type === "paste") {
    return { type: value.type, text: string(value.text, "input.text", 256 * 1024) };
  }
  if (value.type === "key") {
    const modifiers = value.modifiers;
    if (
      modifiers !== undefined &&
      (!Array.isArray(modifiers) || modifiers.some((entry) => !["ctrl", "alt", "shift", "meta"].includes(String(entry))))
    ) throw new Error("TUI key modifiers are invalid");
    return {
      type: "key",
      key: string(value.key, "input.key", 64),
      ...(modifiers === undefined ? {} : { modifiers: modifiers as Array<"ctrl" | "alt" | "shift" | "meta"> }),
    };
  }
  throw new Error("unknown TUI input type");
}

function string(value: unknown, name: string, maximum: number): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

function resolveLimits(overrides: Partial<ShadowTuiAttachmentLimits>): ShadowTuiAttachmentLimits {
  const limits = { ...DEFAULT_SHADOW_TUI_ATTACHMENT_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be a positive integer`);
  }
  return limits;
}

function normalizeError(error: unknown): DashboardTuiAttachmentError {
  if (error instanceof DashboardTuiAttachmentError) return error;
  if (error instanceof Error && "code" in error) {
    return new DashboardTuiAttachmentError(409, String(error.code), error.message, "retryable" in error && error.retryable === true);
  }
  return new DashboardTuiAttachmentError(500, "tui_attach_failed", error instanceof Error ? error.message : "TUI attach failed");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
