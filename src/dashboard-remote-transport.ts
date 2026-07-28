import type { RawData } from "ws";

import {
  DASH_DEFAULT_LIMITS,
  type DashboardCommandResult,
  type DashboardCursor,
  type DashboardReplayGap,
  type DashboardSessionIdentity,
  type TuiDimensions,
} from "./dashboard-contract.js";
import type { JsonObject, JsonValue } from "./session-api.js";
import { SessionApiClientError, type SessionApiClient } from "./session-client.js";

/**
 * Shared transport primitives for the remote Dashboard backend.
 *
 * `RemoteDashboardBackend` and both of its attachment hubs speak the same
 * authenticated neutral REST plus framed WebSocket dialect, so the error
 * taxonomy, client surface, resource limits, bounded frame decoding, and
 * command-result shaping live here rather than being duplicated per hub.
 */

export interface RemoteDashboardBackendClient extends Pick<
  SessionApiClient,
  | "dashboardCapabilities"
  | "dashboardDiagnostics"
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

export interface RetainedEvent<T> {
  cursor?: DashboardCursor;
  event: T;
  bytes: number;
}

export function resolveLimits(
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

export function reconnectDelay(
  attempt: number,
  limits: Pick<RemoteDashboardBackendLimits, "reconnectBaseDelayMs" | "reconnectMaxDelayMs">,
): number {
  return Math.min(
    limits.reconnectMaxDelayMs,
    limits.reconnectBaseDelayMs * 2 ** Math.max(0, attempt - 1),
  );
}

export function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
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

export function sameDimensions(first: TuiDimensions, second: TuiDimensions): boolean {
  return first.rows === second.rows && first.columns === second.columns;
}

export function hubKey(sessionId: string, generation: number): string {
  return `${sessionId}\u0000${generation}`;
}

export function byteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

export function errorCode(error: unknown): string {
  return error instanceof Error && "code" in error
    ? String(error.code)
    : "remote_unavailable";
}

export function remoteError(error: unknown): RemoteDashboardBackendError {
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

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function decodeFrame(raw: RawData, binary: boolean, maxBytes: number): unknown {
  if (binary) throw new RemoteDashboardBackendError("remote_protocol_error", "binary remote frame");
  const bytes = rawDataBuffer(raw);
  if (bytes.length > maxBytes) {
    throw new RemoteDashboardBackendError("remote_frame_too_large", "remote frame exceeds its bound");
  }
  return JSON.parse(bytes.toString("utf8")) as unknown;
}

export function rawDataBuffer(value: RawData): Buffer {
  if (Buffer.isBuffer(value)) return value;
  if (Array.isArray(value)) return Buffer.concat(value);
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  throw new RemoteDashboardBackendError("remote_protocol_error", "unsupported remote frame payload");
}

export function boundedObject(value: unknown, maxBytes: number): JsonObject {
  const bounded = boundedJsonValue(value, maxBytes);
  return isRecord(bounded) ? bounded : { value: bounded ?? null };
}

export function boundedJsonValue(
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

export function rejected(
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

export function indeterminate(
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

export function localGap(
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

export function assertIdentity(
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
