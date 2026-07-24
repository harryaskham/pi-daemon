import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";

import WebSocket, { type RawData } from "ws";

import type {
  ActivationRequest,
  ActivationTicket,
  DashboardFingerprint,
  DashboardLeaseResource,
  DashboardServiceCapabilities,
  SessionExportRequest,
  SessionExportTicket,
  SessionInfoResource,
  SessionInventoryPage,
  SessionInventoryQuery,
  TranscriptPage,
  TranscriptQuery,
} from "./dashboard-contract.js";
import type { DashboardDiagnosticsSnapshot } from "./dashboard-diagnostics.js";
import { dashboardSessionDraftEtag } from "./dashboard-session-draft-contract.js";
import {
  type DashboardSessionDraftCancelRequest,
  type DashboardSessionDraftCreateRequest,
  type DashboardSessionDraftResource,
  type DashboardSessionDraftSendRequest,
  type DashboardSessionDraftSendTicket,
} from "./dashboard-session-drafts.js";
import {
  DEFAULT_SCHEDULE_LIMITS,
  validateScheduleResource,
  type ScheduleCapabilities,
  type ScheduleResource,
} from "./schedule-contract.js";
import {
  DASHBOARD_TUI_SUBPROTOCOL,
  type ApiErrorBody,
  type PiRpcResponse,
  type SessionResource,
  type TicketResource,
} from "./session-api.js";

export const DEFAULT_SESSION_CLIENT_TIMEOUT_MS = 30_000;
export const DEFAULT_SESSION_CLIENT_RESPONSE_BYTES = 2 * 1024 * 1024;

export interface SessionApiClientOptions {
  baseUrl: string;
  bearerToken: string;
  allowInsecureRemote?: boolean;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

export interface SessionApiResult<T = unknown> {
  data: T;
  requestId: string;
  hostInstanceId: string;
  headers: IncomingHttpHeaders;
  status: number;
}

export class SessionApiClientError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;
  readonly details: Record<string, unknown> | undefined;

  constructor(status: number, body: ApiErrorBody) {
    super(body.message);
    this.name = "SessionApiClientError";
    this.status = status;
    this.code = body.code;
    this.retryable = body.retryable;
    this.details = body.details;
  }
}

export class SessionApiClient {
  readonly baseUrl: URL;
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
  readonly #bearerToken: string;

  constructor(options: SessionApiClientOptions) {
    this.baseUrl = parseBaseUrl(options.baseUrl, options.allowInsecureRemote === true);
    this.#bearerToken = bearer(options.bearerToken);
    this.timeoutMs = positiveInteger(
      options.timeoutMs ?? DEFAULT_SESSION_CLIENT_TIMEOUT_MS,
      "timeoutMs",
    );
    this.maxResponseBytes = positiveInteger(
      options.maxResponseBytes ?? DEFAULT_SESSION_CLIENT_RESPONSE_BYTES,
      "maxResponseBytes",
    );
  }

  async request<T = unknown>(
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    options: {
      body?: unknown;
      headers?: Record<string, string>;
      timeoutMs?: number;
    } = {},
  ): Promise<SessionApiResult<T>> {
    const url = new URL(path, this.baseUrl);
    if (url.origin !== this.baseUrl.origin) throw new Error("session API path escaped base URL");
    const body = options.body === undefined ? undefined : Buffer.from(JSON.stringify(options.body), "utf8");
    const timeoutMs = positiveInteger(options.timeoutMs ?? this.timeoutMs, "timeoutMs");
    const transport = url.protocol === "https:" ? httpsRequest : httpRequest;
    return new Promise<SessionApiResult<T>>((resolve, reject) => {
      const request = transport(
        url,
        {
          method,
          headers: {
            Authorization: `Bearer ${this.#bearerToken}`,
            Accept: "application/json",
            ...(body === undefined
              ? {}
              : {
                  "Content-Type": "application/json",
                  "Content-Length": String(body.length),
                }),
            ...(options.headers ?? {}),
          },
          signal: AbortSignal.timeout(timeoutMs),
        },
        (response) => {
          const chunks: Buffer[] = [];
          let bytes = 0;
          response.on("data", (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > this.maxResponseBytes) {
              request.destroy(new Error("session API response exceeds byte limit"));
              return;
            }
            chunks.push(chunk);
          });
          response.on("end", () => {
            let envelope: unknown;
            try {
              envelope = JSON.parse(Buffer.concat(chunks, bytes).toString("utf8")) as unknown;
            } catch {
              reject(new Error("session API returned invalid JSON"));
              return;
            }
            if (!isRecord(envelope) || typeof envelope.ok !== "boolean") {
              reject(new Error("session API returned an invalid envelope"));
              return;
            }
            if (!envelope.ok) {
              reject(new SessionApiClientError(response.statusCode ?? 500, apiError(envelope.error)));
              return;
            }
            resolve({
              data: envelope.data as T,
              requestId: String(envelope.requestId ?? ""),
              hostInstanceId: String(envelope.hostInstanceId ?? ""),
              headers: response.headers,
              status: response.statusCode ?? 200,
            });
          });
        },
      );
      request.once("error", reject);
      if (body !== undefined) request.write(body);
      request.end();
    });
  }

  list(limit = 50, cursor?: string): Promise<SessionApiResult<{ sessions: SessionResource[]; nextCursor?: string }>> {
    const query = new URLSearchParams({ limit: String(limit) });
    if (cursor !== undefined) query.set("cursor", cursor);
    return this.request("GET", `/v1/session?${query}`);
  }

  getSession(sessionRef: string): Promise<SessionApiResult<SessionResource>> {
    return this.request("GET", `/v1/session/${encodeURIComponent(sessionReference(sessionRef))}`);
  }

  getTicket(ticketId: string): Promise<SessionApiResult<TicketResource>> {
    return this.request("GET", `/v1/ticket/${encodeURIComponent(ticketReference(ticketId))}`);
  }

  async listSchedules(sessionRef?: string): Promise<SessionApiResult<{ schedules: ScheduleResource[] }>> {
    const query = sessionRef === undefined ? "" : `?session=${encodeURIComponent(sessionReference(sessionRef))}`;
    const result = await this.request<{ schedules: ScheduleResource[] }>("GET", `/v1/schedule${query}`);
    if (!Array.isArray(result.data.schedules) || result.data.schedules.length > DEFAULT_SCHEDULE_LIMITS.maxSchedules) {
      throw new Error("session API schedule count exceeds limit");
    }
    return {
      ...result,
      data: { schedules: result.data.schedules.map((value) => validateScheduleResource(value)) },
    };
  }

  async getSchedule(scheduleId: string): Promise<SessionApiResult<ScheduleResource>> {
    const result = await this.request<ScheduleResource>("GET", `/v1/schedule/${encodeURIComponent(scheduleReference(scheduleId))}`);
    return { ...result, data: validateScheduleResource(result.data) };
  }

  async scheduleCapabilities(): Promise<SessionApiResult<ScheduleCapabilities>> {
    const result = await this.request<{ schedules?: ScheduleCapabilities | { available: false } }>("GET", "/v1/capabilities");
    const schedules = result.data.schedules;
    if (schedules === undefined || "available" in schedules) {
      throw new SessionApiClientError(501, {
        code: "schedules_unavailable",
        message: "remote daemon does not advertise schedule resources",
        retryable: false,
      });
    }
    return { ...result, data: schedules };
  }

  scheduleStatus(): Promise<SessionApiResult<{ timerRuntime: boolean; externalTimersSupported: boolean; scheduleCount: number; enabledCount: number; nextWakeAt?: string }>> {
    return this.request("GET", "/v1/schedule/status");
  }

  createSchedule(scheduleId: string, definition: unknown, idempotencyKey: string): Promise<SessionApiResult<ScheduleResource>> {
    assertBoundedScheduleBody(definition);
    return this.request("POST", `/v1/schedule/${encodeURIComponent(scheduleReference(scheduleId))}`, { body: definition, headers: { "Idempotency-Key": idempotencyKey } });
  }

  updateSchedule(scheduleId: string, definition: unknown, etag: string, idempotencyKey: string): Promise<SessionApiResult<ScheduleResource>> {
    assertBoundedScheduleBody(definition);
    return this.request("PUT", `/v1/schedule/${encodeURIComponent(scheduleReference(scheduleId))}`, { body: definition, headers: { "If-Match": etag, "Idempotency-Key": idempotencyKey } });
  }

  deleteSchedule(scheduleId: string, etag: string, idempotencyKey: string): Promise<SessionApiResult<{ deleted: true }>> {
    return this.request("DELETE", `/v1/schedule/${encodeURIComponent(scheduleReference(scheduleId))}`, { headers: { "If-Match": etag, "Idempotency-Key": idempotencyKey } });
  }

  setScheduleEnabled(scheduleId: string, enabled: boolean, etag: string, idempotencyKey: string): Promise<SessionApiResult<ScheduleResource>> {
    return this.request("POST", `/v1/schedule/${encodeURIComponent(scheduleReference(scheduleId))}/${enabled ? "enable" : "disable"}`, { headers: { "If-Match": etag, "Idempotency-Key": idempotencyKey } });
  }

  async waitTicket(
    ticketId: string,
    options: { timeoutMs?: number; pollMs?: number } = {},
  ): Promise<SessionApiResult<TicketResource>> {
    const timeoutMs = positiveInteger(options.timeoutMs ?? this.timeoutMs, "timeoutMs");
    const pollMs = positiveInteger(options.pollMs ?? 100, "pollMs");
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const result = await this.getTicket(ticketId);
      if (["succeeded", "failed", "indeterminate"].includes(result.data.state)) return result;
      if (Date.now() >= deadline) throw new Error("timed out waiting for session ticket");
      await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, deadline - Date.now())));
    }
  }

  dashboardCapabilities(): Promise<SessionApiResult<DashboardServiceCapabilities>> {
    return this.request("GET", "/v1/dashboard/capabilities");
  }

  dashboardDiagnostics(): Promise<SessionApiResult<DashboardDiagnosticsSnapshot>> {
    return this.request("GET", "/v1/dashboard/diagnostics");
  }

  listDashboardSessions(
    query: SessionInventoryQuery = {},
  ): Promise<SessionApiResult<SessionInventoryPage>> {
    const parameters = new URLSearchParams();
    if (query.limit !== undefined) parameters.set("limit", String(query.limit));
    if (query.cursor !== undefined) parameters.set("cursor", query.cursor);
    if (query.search !== undefined) parameters.set("search", query.search);
    if (query.sourceKinds !== undefined) parameters.set("sourceKind", query.sourceKinds.join(","));
    if (query.runtime !== undefined) parameters.set("runtime", query.runtime.join(","));
    if (query.unread !== undefined) parameters.set("unread", String(query.unread));
    if (query.modifiedAfter !== undefined) parameters.set("modifiedAfter", query.modifiedAfter);
    const suffix = parameters.size === 0 ? "" : `?${parameters}`;
    return this.request("GET", `/v1/dashboard/inventory${suffix}`);
  }

  getDashboardSession(inventoryId: string): Promise<SessionApiResult<SessionInfoResource>> {
    return this.request(
      "GET",
      `/v1/dashboard/inventory/${encodeURIComponent(sessionReference(inventoryId))}`,
    );
  }

  getDashboardTranscript(
    inventoryId: string,
    query: TranscriptQuery = {},
    expectedFingerprint?: DashboardFingerprint,
  ): Promise<SessionApiResult<TranscriptPage>> {
    const parameters = new URLSearchParams();
    if (query.limit !== undefined) parameters.set("limit", String(query.limit));
    if (query.cursor !== undefined) parameters.set("cursor", query.cursor);
    if (query.direction !== undefined) parameters.set("direction", query.direction);
    if (query.leafId !== undefined) parameters.set("leafId", query.leafId);
    if (expectedFingerprint !== undefined) parameters.set("fingerprint", expectedFingerprint);
    const suffix = parameters.size === 0 ? "" : `?${parameters}`;
    return this.request(
      "GET",
      `/v1/dashboard/inventory/${encodeURIComponent(sessionReference(inventoryId))}/transcript${suffix}`,
    );
  }

  activateDashboardSession(
    inventoryId: string,
    request: ActivationRequest,
  ): Promise<SessionApiResult<ActivationTicket>> {
    return this.request(
      "POST",
      `/v1/dashboard/inventory/${encodeURIComponent(sessionReference(inventoryId))}/activate`,
      {
        body: request,
        headers: {
          "Idempotency-Key": request.idempotencyKey,
          "X-Request-Id": request.requestId,
        },
      },
    );
  }

  getDashboardActivation(ticketId: string): Promise<SessionApiResult<ActivationTicket>> {
    return this.request(
      "GET",
      `/v1/dashboard/activation/${encodeURIComponent(ticketReference(ticketId))}`,
    );
  }

  exportDashboardSession(
    sessionRef: string,
    request: SessionExportRequest,
  ): Promise<SessionApiResult<SessionExportTicket>> {
    return this.request(
      "POST",
      `/v1/dashboard/session/${encodeURIComponent(sessionReference(sessionRef))}/export`,
      {
        body: request,
        headers: {
          "Idempotency-Key": request.idempotencyKey,
          "X-Request-Id": request.requestId,
        },
      },
    );
  }

  getDashboardExport(ticketId: string): Promise<SessionApiResult<SessionExportTicket>> {
    return this.request(
      "GET",
      `/v1/dashboard/export/${encodeURIComponent(ticketReference(ticketId))}`,
    );
  }

  createDashboardSessionDraft(
    request: DashboardSessionDraftCreateRequest,
  ): Promise<SessionApiResult<DashboardSessionDraftResource>> {
    return this.request("POST", "/v1/dashboard/session-drafts", {
      body: request,
      headers: {
        "Idempotency-Key": request.idempotencyKey,
        "X-Request-Id": request.requestId,
      },
    });
  }

  getDashboardSessionDraft(
    draftId: string,
  ): Promise<SessionApiResult<DashboardSessionDraftResource>> {
    return this.request(
      "GET",
      `/v1/dashboard/session-drafts/${encodeURIComponent(sessionReference(draftId))}`,
    );
  }

  cancelDashboardSessionDraft(
    draftId: string,
    request: DashboardSessionDraftCancelRequest,
  ): Promise<SessionApiResult<DashboardSessionDraftResource>> {
    return this.request(
      "DELETE",
      `/v1/dashboard/session-drafts/${encodeURIComponent(sessionReference(draftId))}`,
      {
        body: request,
        headers: {
          "Idempotency-Key": request.idempotencyKey,
          "X-Request-Id": request.requestId,
          "If-Match": dashboardSessionDraftEtag(draftId, request.expectedRevision),
        },
      },
    );
  }

  sendDashboardSessionDraft(
    draftId: string,
    request: DashboardSessionDraftSendRequest,
  ): Promise<SessionApiResult<DashboardSessionDraftSendTicket>> {
    return this.request(
      "POST",
      `/v1/dashboard/session-drafts/${encodeURIComponent(sessionReference(draftId))}/send`,
      {
        body: request,
        headers: {
          "Idempotency-Key": request.idempotencyKey,
          "X-Request-Id": request.requestId,
          "If-Match": dashboardSessionDraftEtag(draftId, request.expectedRevision),
        },
      },
    );
  }

  getDashboardSessionDraftSend(
    ticketId: string,
  ): Promise<SessionApiResult<DashboardSessionDraftSendTicket>> {
    return this.request(
      "GET",
      `/v1/dashboard/session-draft-send/${encodeURIComponent(ticketReference(ticketId))}`,
    );
  }

  renewDashboardLease(
    sessionRef: string,
    request: { requestId: string; leaseId: string },
  ): Promise<SessionApiResult<DashboardLeaseResource>> {
    return this.request(
      "POST",
      `/v1/dashboard/session/${encodeURIComponent(sessionReference(sessionRef))}/lease`,
      { body: request, headers: { "X-Request-Id": request.requestId } },
    );
  }

  createDashboardRpcSocket(
    sessionRef: string,
    options: {
      timeoutMs?: number;
      role?: "controller" | "observer";
      generation?: number;
      cursor?: string;
      hydrate?: boolean;
    } = {},
  ): WebSocket {
    const timeoutMs = positiveInteger(options.timeoutMs ?? this.timeoutMs, "timeoutMs");
    const url = dashboardRpcUrl(this.baseUrl, sessionRef, options);
    return this.#createWebSocket(url, "pi-daemon-rpc.v1", timeoutMs);
  }

  connectDashboardRpc(
    sessionRef: string,
    options: Parameters<SessionApiClient["createDashboardRpcSocket"]>[1] = {},
  ): Promise<WebSocket> {
    return waitForWebSocketOpen(this.createDashboardRpcSocket(sessionRef, options));
  }

  createDashboardTuiSocket(
    sessionRef: string,
    options: {
      timeoutMs?: number;
      role?: "controller" | "observer";
      generation?: number;
      cursor?: string;
      dimensions?: { rows: number; columns: number };
    } = {},
  ): WebSocket {
    const timeoutMs = positiveInteger(options.timeoutMs ?? this.timeoutMs, "timeoutMs");
    const url = dashboardTuiUrl(this.baseUrl, sessionRef, options);
    return this.#createWebSocket(url, DASHBOARD_TUI_SUBPROTOCOL, timeoutMs);
  }

  connectDashboardTui(
    sessionRef: string,
    options: Parameters<SessionApiClient["createDashboardTuiSocket"]>[1] = {},
  ): Promise<WebSocket> {
    return waitForWebSocketOpen(this.createDashboardTuiSocket(sessionRef, options));
  }

  #createWebSocket(
    url: string,
    subprotocol: "pi-daemon-rpc.v1" | typeof DASHBOARD_TUI_SUBPROTOCOL,
    timeoutMs: number,
  ): WebSocket {
    return new WebSocket(url, subprotocol, {
      headers: { Authorization: `Bearer ${this.#bearerToken}` },
      handshakeTimeout: timeoutMs,
      maxPayload: this.maxResponseBytes,
      perMessageDeflate: false,
    });
  }

  async rpcCommand(
    sessionRef: string,
    command: Record<string, unknown>,
    options: { timeoutMs?: number; waitForSettled?: boolean; generation?: number } = {},
  ): Promise<{ response: PiRpcResponse; events: unknown[] }> {
    const timeoutMs = positiveInteger(options.timeoutMs ?? this.timeoutMs, "timeoutMs");
    const url = websocketUrl(this.baseUrl, sessionRef, options.generation);
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url, "pi-daemon-rpc.v1", {
        headers: { Authorization: `Bearer ${this.#bearerToken}` },
        handshakeTimeout: timeoutMs,
        maxPayload: this.maxResponseBytes,
        perMessageDeflate: false,
      });
      const events: unknown[] = [];
      let response: PiRpcResponse | undefined;
      let settled = options.waitForSettled !== true;
      let receivedBytes = 0;
      let finished = false;
      const fail = (error: Error): void => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        socket.terminate();
        reject(error);
      };
      const timer = setTimeout(() => {
        fail(new Error("timed out waiting for Pi RPC command"));
      }, timeoutMs);
      const finish = (): void => {
        if (finished || response === undefined || !settled) return;
        finished = true;
        clearTimeout(timer);
        socket.close(1000, "command complete");
        resolve({ response, events });
      };
      socket.once("error", (error) => fail(error));
      socket.once("close", () => {
        if (!finished) fail(new Error("Pi RPC attachment closed before command completion"));
      });
      socket.on("message", (raw: RawData, isBinary: boolean) => {
        if (isBinary) {
          fail(new Error("daemon returned binary RPC data"));
          return;
        }
        let frame: unknown;
        try {
          const bytes = rawDataBuffer(raw);
          receivedBytes += bytes.length;
          if (receivedBytes > this.maxResponseBytes) {
            throw new Error("Pi RPC output exceeds aggregate byte limit");
          }
          frame = JSON.parse(bytes.toString("utf8")) as unknown;
        } catch (error) {
          fail(error instanceof Error ? error : new Error("daemon returned invalid RPC JSON"));
          return;
        }
        if (!isRecord(frame)) return;
        if (frame.kind === "attach_ready") {
          socket.send(JSON.stringify({ kind: "command", command }));
          return;
        }
        if (frame.kind === "response" && isRecord(frame.response)) {
          response = frame.response as PiRpcResponse;
          if (response.success === false) settled = true;
          finish();
          return;
        }
        if (frame.kind === "event") {
          if (events.length >= 512) {
            fail(new Error("Pi RPC event count exceeds limit"));
            return;
          }
          events.push(frame.event);
          if (isRecord(frame.event) && frame.event.type === "agent_settled") settled = true;
          finish();
          return;
        }
        if (frame.kind === "replay_gap") events.push(frame);
      });
    });
  }
}

function waitForWebSocketOpen(socket: WebSocket): Promise<WebSocket> {
  if (socket.readyState === WebSocket.OPEN) return Promise.resolve(socket);
  return new Promise((resolve, reject) => {
    const onOpen = (): void => {
      socket.off("error", onError);
      resolve(socket);
    };
    const onError = (error: Error): void => {
      socket.off("open", onOpen);
      reject(error);
    };
    socket.once("open", onOpen);
    socket.once("error", onError);
  });
}

function parseBaseUrl(value: string, allowInsecureRemote: boolean): URL {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error("session API URL must use http or https");
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("session API URL must not contain credentials, query, or fragment");
  }
  if (url.protocol === "http:" && !isLoopback(url.hostname) && !allowInsecureRemote) {
    throw new Error("remote plaintext session API requires explicit insecure opt-in");
  }
  url.pathname = url.pathname.replace(/\/$/, "") + "/";
  return url;
}

function websocketUrl(baseUrl: URL, sessionRef: string, generation?: number): string {
  return dashboardRpcUrl(baseUrl, sessionRef, {
    role: "controller",
    ...(generation === undefined ? {} : { generation }),
  });
}

function dashboardRpcUrl(
  baseUrl: URL,
  sessionRef: string,
  options: {
    role?: "controller" | "observer";
    generation?: number;
    cursor?: string;
    hydrate?: boolean;
  },
): string {
  const url = new URL(
    `/v1/session/${encodeURIComponent(sessionReference(sessionRef))}/rpc`,
    baseUrl,
  );
  url.searchParams.set("role", options.role ?? "observer");
  if (options.hydrate !== undefined) {
    url.searchParams.set("hydrate", String(options.hydrate));
  }
  appendAttachmentIdentity(url, options.generation, options.cursor);
  url.protocol = baseUrl.protocol === "https:" ? "wss:" : "ws:";
  return url.href;
}

function dashboardTuiUrl(
  baseUrl: URL,
  sessionRef: string,
  options: {
    role?: "controller" | "observer";
    generation?: number;
    cursor?: string;
    dimensions?: { rows: number; columns: number };
  },
): string {
  const url = new URL(
    `/v1/dashboard/session/${encodeURIComponent(sessionReference(sessionRef))}/tui`,
    baseUrl,
  );
  url.searchParams.set("role", options.role ?? "observer");
  appendAttachmentIdentity(url, options.generation, options.cursor);
  if (options.dimensions !== undefined) {
    url.searchParams.set("rows", String(dimension(options.dimensions.rows, "rows", 200)));
    url.searchParams.set("columns", String(dimension(options.dimensions.columns, "columns", 320)));
  }
  url.protocol = baseUrl.protocol === "https:" ? "wss:" : "ws:";
  return url.href;
}

function appendAttachmentIdentity(
  url: URL,
  generation: number | undefined,
  cursor: string | undefined,
): void {
  if (generation !== undefined) {
    if (!Number.isSafeInteger(generation) || generation < 0) throw new Error("invalid generation");
    url.searchParams.set("generation", String(generation));
  }
  if (cursor !== undefined) {
    if (cursor.length < 1 || cursor.length > 1024) throw new Error("invalid cursor");
    url.searchParams.set("cursor", cursor);
  }
}

function dimension(value: number, name: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`invalid TUI ${name}`);
  }
  return value;
}

function isLoopback(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (normalized === "::1") return true;
  return isIP(normalized) === 4 && Number(normalized.split(".", 1)[0]) === 127;
}

function bearer(value: string): string {
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes < 16 || bytes > 4096 || !/^[A-Za-z0-9\-._~+/]+=*$/.test(value)) {
    throw new Error("invalid session API bearer");
  }
  return value;
}

function sessionReference(value: string): string {
  if (value.length < 1 || value.length > 256) throw new Error("invalid session reference");
  return value;
}

function ticketReference(value: string): string {
  if (value.length < 1 || value.length > 256) throw new Error("invalid ticket reference");
  return value;
}

function scheduleReference(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value)) throw new Error("invalid schedule reference");
  return value;
}

function apiError(value: unknown): ApiErrorBody {
  if (!isRecord(value)) return { code: "invalid_error", message: "session API error", retryable: false };
  return {
    code: typeof value.code === "string" ? value.code : "invalid_error",
    message: typeof value.message === "string" ? value.message : "session API error",
    retryable: value.retryable === true,
  };
}

function rawDataBuffer(value: RawData): Buffer {
  if (Buffer.isBuffer(value)) return value;
  if (Array.isArray(value)) return Buffer.concat(value);
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  throw new Error("unsupported WebSocket payload");
}

function assertBoundedScheduleBody(value: unknown): void {
  const encoded = JSON.stringify(value);
  if (encoded === undefined || Buffer.byteLength(encoded, "utf8") > DEFAULT_SCHEDULE_LIMITS.maxRecordBytes) {
    throw new Error("schedule request exceeds byte limit");
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
