import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { isIP } from "node:net";
import { basename, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Duplex } from "node:stream";

import { WebSocket, WebSocketServer, type RawData } from "ws";

import {
  DASH_API_BASE_PATH,
  DASH_API_VERSION,
  DASH_DEFAULT_LIMITS,
  DASH_STREAM_SUBPROTOCOL,
  asDashboardCursor,
  asDashboardFingerprint,
  type ActivationRequest,
  type DashboardBackend,
  type DashboardEnvelopeContext,
  type DashboardCapabilities,
  type DashboardErrorEnvelope,
  type DashboardLimits,
  type DashboardLoginRequest,
  type DashboardScheduleDeleteRequest,
  type DashboardScheduleMutationRequest,
  type DashboardScheduleResource,
  type DashboardScheduleWrite,
  type DashboardSettingsPatchRequest,
  type DashboardSuccessEnvelope,
  type DashboardWorkspaceUpdateRequest,
  type SessionExportRequest,
  type SessionInventoryQuery,
  type TranscriptQuery,
} from "./dashboard-contract.js";
import {
  DASH_CSRF_HEADER,
  DashboardAuthError,
  DashboardBrowserAuth,
  ensureDashboardCredentialFile,
  type DashboardAuthenticatedSession,
} from "./dashboard-auth.js";
import { dashboardSessionDraftEtag } from "./dashboard-session-draft-contract.js";
import {
  validateDashboardSessionDraftCancelRequest,
  validateDashboardSessionDraftCreateRequest,
  validateDashboardSessionDraftSendRequest,
} from "./dashboard-session-drafts.js";
import {
  DashboardSettingsStore,
  DashboardStoreError,
  DashboardWorkspaceStore,
  settingsEtag,
  workspaceEtag,
} from "./dashboard-store.js";
import {
  DEFAULT_PI_DAEMON_WEB_CONFIG,
  type LoadedPiDaemonConfig,
  type PiDaemonWebConfig,
} from "./config.js";
import { HostMetrics } from "./observability.js";
import { scheduleEtag } from "./dashboard-schedule-resources.js";
import { DEFAULT_SCHEDULE_LIMITS } from "./schedule-contract.js";
import type { ApiErrorBody, JsonValue } from "./session-api.js";

const DEFAULT_MAX_HEADER_BYTES = 32 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_STATIC_MAX_BYTES = 8 * 1024 * 1024;
const MAX_URL_BYTES = 8192;
const JSON_CONTENT_TYPE = "application/json; charset=utf-8";
const CSP = [
  "default-src 'none'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "script-src 'self'",
  // React virtualization and CodeMirror's reviewed style-mod runtime require
  // dynamic style attributes/elements. Script remains nonce/eval/inline-free.
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' blob: data:",
  "font-src 'self'",
  "connect-src 'self'",
  "manifest-src 'self'",
].join("; ");

export interface DashboardServerLimits {
  dashboard: DashboardLimits;
  maxHeaderBytes: number;
  requestTimeoutMs: number;
  maxStaticBytes: number;
}

export interface DashboardServerOptions {
  backend: DashboardBackend;
  auth: DashboardBrowserAuth;
  workspaceStore: DashboardWorkspaceStore;
  settingsStore: DashboardSettingsStore;
  assetsDir?: string;
  host?: string;
  port?: number;
  publicOrigin?: string;
  serverInstanceId?: string;
  limits?: Partial<DashboardLimits> & {
    maxHeaderBytes?: number;
    requestTimeoutMs?: number;
    maxStaticBytes?: number;
  };
  streamHandler?: DashboardStreamHandler;
  metrics?: HostMetrics;
}

export interface DashboardServerAddress {
  host: string;
  port: number;
  origin: string;
}

export interface DashboardStreamHandlerContext {
  session: DashboardAuthenticatedSession;
  peer: DashboardWebSocketPeer;
}

export type DashboardStreamHandler = (
  context: DashboardStreamHandlerContext,
) => void | Promise<void>;

export interface DashboardServerFromConfigOptions {
  loadedConfig: LoadedPiDaemonConfig;
  backend: DashboardBackend;
  assetsDir?: string;
  stateDir: string;
  publicOrigin?: string;
  serverInstanceId?: string;
  streamHandler?: DashboardStreamHandler;
  streamHandlerFactory?: (options: {
    backend: DashboardBackend;
    serverInstanceId: string;
    limits: DashboardLimits;
  }) => DashboardStreamHandler;
  webOverrides?: Partial<PiDaemonWebConfig>;
}

export class DashboardServerError extends Error {
  readonly code: string;
  readonly status: number;
  readonly retryable: boolean;

  constructor(status: number, code: string, message: string, retryable = false) {
    super(message);
    this.name = "DashboardServerError";
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

/**
 * Same-origin browser BFF for both embedded and dedicated DashboardBackend
 * implementations. It owns web credential exchange, exact Host/Origin/CSRF
 * policy, static assets, owner-private UI state, bounded HTTP admission and the
 * bounded WebSocket handoff. The daemon service bearer is not an input.
 */
export class DashboardServer {
  readonly backend: DashboardBackend;
  readonly auth: DashboardBrowserAuth;
  readonly workspaceStore: DashboardWorkspaceStore;
  readonly settingsStore: DashboardSettingsStore;
  readonly assetsDir: string;
  readonly host: string;
  readonly port: number;
  readonly serverInstanceId: string;
  readonly limits: DashboardServerLimits;
  readonly metrics: HostMetrics;
  readonly #configuredPublicOrigin: string | undefined;
  readonly #streamHandler: DashboardStreamHandler | undefined;
  readonly #server: Server;
  readonly #webSocketServer: WebSocketServer;
  readonly #upgradeSockets = new Set<Duplex>();
  readonly #peers = new Set<DashboardWebSocketPeer>();
  readonly #peerSessionKeys = new Map<DashboardWebSocketPeer, string>();
  readonly #peerExpiryTimers = new Map<DashboardWebSocketPeer, NodeJS.Timeout>();
  #started = false;
  #origin: string | undefined;

  constructor(options: DashboardServerOptions) {
    this.backend = options.backend;
    this.auth = options.auth;
    this.workspaceStore = options.workspaceStore;
    this.settingsStore = options.settingsStore;
    this.assetsDir = options.assetsDir ?? fileURLToPath(new URL("./dashboard", import.meta.url));
    if (this.assetsDir.length === 0) throw new Error("dashboard assetsDir must not be empty");
    this.host = options.host ?? "127.0.0.1";
    this.port = portNumber(options.port ?? DEFAULT_PI_DAEMON_WEB_CONFIG.port);
    if (!isLoopbackBind(this.host)) {
      throw new Error(
        "DashboardServer initial HTTP listener is loopback-only; terminate TLS on a loopback reverse proxy",
      );
    }
    this.serverInstanceId = safeId(options.serverInstanceId ?? `dash-${randomUUID()}`, "serverInstanceId");
    this.#configuredPublicOrigin =
      options.publicOrigin === undefined ? undefined : validatePublicOrigin(options.publicOrigin);
    const securePublicOrigin = this.#configuredPublicOrigin?.startsWith("https://") ?? false;
    if (this.auth.secureCookies !== securePublicOrigin) {
      throw new Error(
        "dashboard cookie security must match the configured HTTPS public origin",
      );
    }
    this.metrics = options.metrics ?? new HostMetrics();
    const { maxHeaderBytes, requestTimeoutMs, maxStaticBytes, ...dashboardOverrides } =
      options.limits ?? {};
    if (
      dashboardOverrides.browserSessionTtlMs !== undefined &&
      dashboardOverrides.browserSessionTtlMs !== this.auth.sessionTtlMs
    ) {
      throw new RangeError("browserSessionTtlMs must match the browser authenticator TTL");
    }
    this.limits = {
      dashboard: mergeDashboardLimits({
        ...dashboardOverrides,
        browserSessionTtlMs: this.auth.sessionTtlMs,
      }),
      maxHeaderBytes: positiveInteger(maxHeaderBytes ?? DEFAULT_MAX_HEADER_BYTES, "maxHeaderBytes"),
      requestTimeoutMs: positiveInteger(
        requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
        "requestTimeoutMs",
      ),
      maxStaticBytes: positiveInteger(maxStaticBytes ?? DEFAULT_STATIC_MAX_BYTES, "maxStaticBytes"),
    };
    if (this.limits.dashboard.maxOutboundBytesPerConnection < 1024) {
      throw new RangeError("maxOutboundBytesPerConnection must be at least 1024 bytes");
    }
    if (
      this.limits.dashboard.maxWebSocketFrameBytes >
      this.limits.dashboard.maxOutboundBytesPerConnection
    ) {
      throw new RangeError("maxWebSocketFrameBytes cannot exceed the outbound connection bound");
    }
    this.#streamHandler = options.streamHandler;
    this.#server = createServer(
      { maxHeaderSize: this.limits.maxHeaderBytes },
      (request, response) => void this.#handleRequest(request, response),
    );
    this.#server.maxConnections = this.limits.dashboard.maxConnections;
    this.#server.requestTimeout = this.limits.requestTimeoutMs;
    this.#server.headersTimeout = this.limits.requestTimeoutMs;
    this.#server.keepAliveTimeout = Math.min(5_000, this.limits.requestTimeoutMs);
    this.#webSocketServer = new WebSocketServer({
      noServer: true,
      clientTracking: false,
      maxPayload: this.limits.dashboard.maxWebSocketFrameBytes,
      perMessageDeflate: false,
      handleProtocols: (protocols) =>
        protocols.has(DASH_STREAM_SUBPROTOCOL) ? DASH_STREAM_SUBPROTOCOL : false,
    });
    this.#server.on("upgrade", (request, socket, head) => {
      this.#upgradeSockets.add(socket);
      socket.once("close", () => this.#upgradeSockets.delete(socket));
      void this.#handleUpgrade(request, socket, head);
    });
  }

  get address(): DashboardServerAddress | undefined {
    const address = this.#server.address();
    if (address === null || typeof address === "string" || this.#origin === undefined) return undefined;
    return { host: address.address, port: address.port, origin: this.#origin };
  }

  async capabilities(): Promise<DashboardCapabilities> {
    const backend = await this.backend.capabilities();
    const limits = Object.fromEntries(
      Object.entries(this.limits.dashboard).map(([name, value]) => [
        name,
        Math.min(value, backend.limits[name as keyof DashboardLimits]),
      ]),
    ) as unknown as DashboardLimits;
    return { ...backend, limits };
  }

  async start(): Promise<DashboardServerAddress> {
    if (this.#started) throw new Error("DashboardServer is already started");
    await this.settingsStore.get();
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const onError = (error: Error): void => {
        this.#server.off("listening", onListening);
        rejectPromise(error);
      };
      const onListening = (): void => {
        this.#server.off("error", onError);
        resolvePromise();
      };
      this.#server.once("error", onError);
      this.#server.once("listening", onListening);
      this.#server.listen({ host: this.host, port: this.port, exclusive: true });
    });
    const address = this.#server.address();
    if (address === null || typeof address === "string") throw new Error("dashboard listener has no TCP address");
    this.#origin =
      this.#configuredPublicOrigin ?? `http://${formatHost(this.host)}:${address.port}`;
    this.#started = true;
    return this.address!;
  }

  async stop(): Promise<void> {
    this.auth.revokeAll();
    for (const timer of this.#peerExpiryTimers.values()) clearTimeout(timer);
    this.#peerExpiryTimers.clear();
    this.#peerSessionKeys.clear();
    for (const peer of this.#peers) peer.close(1001, "dashboard server stopping");
    this.#peers.clear();
    for (const socket of this.#upgradeSockets) socket.destroy();
    this.#upgradeSockets.clear();
    if (!this.#started) return;
    this.#started = false;
    this.#server.closeAllConnections();
    await new Promise<void>((resolvePromise, rejectPromise) => {
      this.#server.close((error) => (error === undefined ? resolvePromise() : rejectPromise(error)));
    });
  }

  async #handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const startedAt = performance.now();
    const requestId = requestIdFrom(request.headers["x-request-id"]);
    let timedOut = false;
    const deadline = setTimeout(() => {
      timedOut = true;
      if (!response.headersSent) {
        sendJson(
          response,
          408,
          errorEnvelope(
            requestId,
            this.serverInstanceId,
            "unauthenticated",
            "unauthenticated",
            { code: "request_timeout", message: "dashboard request timed out", retryable: true },
          ),
          this.limits.dashboard.maxOutboundBytesPerConnection,
          { Connection: "close" },
        );
      }
      response.once("finish", () => request.destroy());
    }, this.limits.requestTimeoutMs);
    deadline.unref();
    try {
      this.#assertHost(request);
      const url = this.#requestUrl(request);
      if (request.method === "GET" || request.method === "HEAD") {
        if (url.pathname === "/dash" || url.pathname === "/dash/") {
          await this.#serveStatic(response, "index.html", false, request.method === "HEAD");
          return;
        }
        if (url.pathname.startsWith("/dash/assets/")) {
          const asset = decodeAssetName(url.pathname.slice("/dash/assets/".length));
          await this.#serveStatic(response, join("assets", asset), true, request.method === "HEAD");
          return;
        }
      }

      if (!url.pathname.startsWith(`${DASH_API_BASE_PATH}/`) && url.pathname !== DASH_API_BASE_PATH) {
        throw new DashboardServerError(404, "not_found", "dashboard route was not found");
      }

      if (request.method === "POST" && url.pathname === `${DASH_API_BASE_PATH}/login`) {
        this.#assertMutationOrigin(request);
        const body = await readJsonBody(request, this.limits.dashboard.maxHttpBodyBytes);
        const result = this.auth.login(body as DashboardLoginRequest);
        try {
          await this.workspaceStore.getOrCreate(result.session.workspaceId);
        } catch (error) {
          const issued = tryAuthenticate(this.auth, result.setCookie);
          if (issued !== undefined) this.auth.revoke(issued);
          throw error;
        }
        sendJson(
          response,
          200,
          successEnvelope(
            requestId,
            this.serverInstanceId,
            result.session.clientId,
            result.session.workspaceId,
            result.session,
          ),
          this.limits.dashboard.maxOutboundBytesPerConnection,
          { "Set-Cookie": result.setCookie },
        );
        return;
      }

      const session = this.auth.authenticate(request.headers.cookie);
      if (isMutation(request.method)) {
        this.#assertMutationOrigin(request);
        this.auth.authorizeCsrf(session, request.headers[DASH_CSRF_HEADER]);
      }
      const context = envelopeContext(requestId, this.serverInstanceId, session);

      if (request.method === "POST" && url.pathname === `${DASH_API_BASE_PATH}/logout`) {
        this.#closeSessionPeers(session.sessionKey, 1008, "browser session revoked");
        const expired = this.auth.revoke(session);
        sendJson(
          response,
          200,
          successEnvelopeFrom(context, { revoked: true }),
          this.limits.dashboard.maxOutboundBytesPerConnection,
          { "Set-Cookie": expired },
        );
        return;
      }

      if (request.method === "GET" && url.pathname === `${DASH_API_BASE_PATH}/bootstrap`) {
        const settings = await this.settingsStore.get();
        const [capabilities, workspace, inventory] = await Promise.all([
          this.capabilities(),
          this.workspaceStore.getOrCreate(session.workspaceId),
          this.backend.listSessions({ limit: settings.effective.sidebar.initialLimit }),
        ]);
        const resumed = this.auth.browserSession(session);
        sendJson(
          response,
          200,
          successEnvelopeFrom(context, { capabilities, settings, workspace, inventory }),
          this.limits.dashboard.maxOutboundBytesPerConnection,
          { [DASH_CSRF_HEADER]: resumed.csrfToken },
        );
        return;
      }

      if (request.method === "POST" && url.pathname === `${DASH_API_BASE_PATH}/session-drafts`) {
        const body = validateDashboardSessionDraftCreateRequest(
          await readJsonBody(request, this.limits.dashboard.maxHttpBodyBytes),
        );
        assertMutationHeaders(request, body);
        const draft = await this.backend.createSessionDraft(body);
        sendJson(
          response,
          201,
          successEnvelopeFrom(context, draft),
          this.limits.dashboard.maxOutboundBytesPerConnection,
          {
            Location: `${DASH_API_BASE_PATH}/session-drafts/${encodeURIComponent(draft.draftId)}`,
            ETag: dashboardSessionDraftEtag(draft.draftId, draft.revision),
          },
        );
        return;
      }

      if (request.method === "GET" && url.pathname === `${DASH_API_BASE_PATH}/sessions`) {
        const page = await this.backend.listSessions(inventoryQuery(url, this.limits.dashboard));
        sendJson(response, 200, successEnvelopeFrom(context, page), this.limits.dashboard.maxOutboundBytesPerConnection);
        return;
      }

      const draftSendTicketMatch = matchPath(
        url.pathname,
        `${DASH_API_BASE_PATH}/session-draft-send/`,
        "",
      );
      if (request.method === "GET" && draftSendTicketMatch !== undefined) {
        const ticket = await this.backend.getSessionDraftSend(draftSendTicketMatch);
        sendJson(response, 200, successEnvelopeFrom(context, ticket), this.limits.dashboard.maxOutboundBytesPerConnection);
        return;
      }
      const draftMatch = matchPath(url.pathname, `${DASH_API_BASE_PATH}/session-drafts/`, "");
      if (request.method === "GET" && draftMatch !== undefined) {
        const draft = await this.backend.getSessionDraft(draftMatch);
        sendJson(
          response,
          200,
          successEnvelopeFrom(context, draft),
          this.limits.dashboard.maxOutboundBytesPerConnection,
          { ETag: dashboardSessionDraftEtag(draft.draftId, draft.revision) },
        );
        return;
      }
      const draftSendMatch = matchPath(
        url.pathname,
        `${DASH_API_BASE_PATH}/session-drafts/`,
        "/send",
      );
      if (request.method === "POST" && draftSendMatch !== undefined) {
        const body = validateDashboardSessionDraftSendRequest(
          await readJsonBody(request, this.limits.dashboard.maxHttpBodyBytes),
        );
        assertMutationHeaders(request, body);
        assertDashboardDraftIfMatch(request, draftSendMatch, body.expectedRevision);
        const ticket = await this.backend.sendSessionDraft(draftSendMatch, body);
        sendJson(
          response,
          202,
          successEnvelopeFrom(context, ticket),
          this.limits.dashboard.maxOutboundBytesPerConnection,
          { Location: `${DASH_API_BASE_PATH}/session-draft-send/${encodeURIComponent(ticket.ticketId)}` },
        );
        return;
      }
      if (request.method === "DELETE" && draftMatch !== undefined) {
        const body = validateDashboardSessionDraftCancelRequest(
          await readJsonBody(request, this.limits.dashboard.maxHttpBodyBytes),
        );
        assertMutationHeaders(request, body);
        assertDashboardDraftIfMatch(request, draftMatch, body.expectedRevision);
        const draft = await this.backend.cancelSessionDraft(draftMatch, body);
        sendJson(
          response,
          200,
          successEnvelopeFrom(context, draft),
          this.limits.dashboard.maxOutboundBytesPerConnection,
          { ETag: dashboardSessionDraftEtag(draft.draftId, draft.revision) },
        );
        return;
      }

      const sessionMatch = matchPath(url.pathname, `${DASH_API_BASE_PATH}/sessions/`, "");
      if (request.method === "GET" && sessionMatch !== undefined) {
        const info = await this.backend.getSessionInfo(sessionMatch);
        sendJson(response, 200, successEnvelopeFrom(context, info), this.limits.dashboard.maxOutboundBytesPerConnection);
        return;
      }
      const transcriptMatch = matchPath(url.pathname, `${DASH_API_BASE_PATH}/sessions/`, "/transcript");
      if (request.method === "GET" && transcriptMatch !== undefined) {
        const transcript = await this.backend.getTranscript(
          transcriptMatch,
          transcriptQuery(url, this.limits.dashboard),
        );
        sendJson(response, 200, successEnvelopeFrom(context, transcript), this.limits.dashboard.maxOutboundBytesPerConnection);
        return;
      }
      const activateMatch = matchPath(url.pathname, `${DASH_API_BASE_PATH}/sessions/`, "/activate");
      if (request.method === "POST" && activateMatch !== undefined) {
        const body = await readJsonBody(request, this.limits.dashboard.maxHttpBodyBytes);
        const ticket = await this.backend.activateSession(activateMatch, activationRequest(body));
        sendJson(response, 202, successEnvelopeFrom(context, ticket), this.limits.dashboard.maxOutboundBytesPerConnection);
        return;
      }
      const activationMatch = matchPath(url.pathname, `${DASH_API_BASE_PATH}/activation/`, "");
      if (request.method === "GET" && activationMatch !== undefined) {
        const ticket = await this.backend.getActivation(activationMatch);
        sendJson(response, 200, successEnvelopeFrom(context, ticket), this.limits.dashboard.maxOutboundBytesPerConnection);
        return;
      }
      const exportMatch = matchPath(url.pathname, `${DASH_API_BASE_PATH}/sessions/`, "/export");
      if (request.method === "POST" && exportMatch !== undefined) {
        const body = await readJsonBody(request, this.limits.dashboard.maxHttpBodyBytes);
        const ticket = await this.backend.exportSession(exportMatch, exportRequest(body));
        sendJson(response, 202, successEnvelopeFrom(context, ticket), this.limits.dashboard.maxOutboundBytesPerConnection);
        return;
      }
      const exportTicketMatch = matchPath(url.pathname, `${DASH_API_BASE_PATH}/export/`, "");
      if (request.method === "GET" && exportTicketMatch !== undefined) {
        const ticket = await this.backend.getExport(exportTicketMatch);
        sendJson(response, 200, successEnvelopeFrom(context, ticket), this.limits.dashboard.maxOutboundBytesPerConnection);
        return;
      }

      if (request.method === "GET" && url.pathname === `${DASH_API_BASE_PATH}/schedules/capabilities`) {
        const capabilities = await this.backend.scheduleCapabilities();
        sendJson(response, 200, successEnvelopeFrom(context, capabilities), this.limits.dashboard.maxOutboundBytesPerConnection);
        return;
      }
      if (request.method === "GET" && url.pathname === `${DASH_API_BASE_PATH}/schedules/status`) {
        const status = await this.backend.scheduleStatus();
        sendJson(response, 200, successEnvelopeFrom(context, status), this.limits.dashboard.maxOutboundBytesPerConnection);
        return;
      }
      if (url.pathname === `${DASH_API_BASE_PATH}/schedules`) {
        if (request.method === "GET") {
          const sessionRef = scheduleListQuery(url);
          const schedules = (await this.backend.listSchedules(sessionRef)).map(contentSafeSchedule);
          if (schedules.length > DEFAULT_SCHEDULE_LIMITS.maxSchedules) {
            throw new DashboardServerError(500, "schedule_response_capacity", "schedule response count exceeds its bound");
          }
          sendJson(response, 200, successEnvelopeFrom(context, { schedules }), this.limits.dashboard.maxOutboundBytesPerConnection);
          return;
        }
        if (request.method === "POST") {
          const body = scheduleMutationRequest(await readJsonBody(request, Math.min(
            this.limits.dashboard.maxHttpBodyBytes,
            DEFAULT_SCHEDULE_LIMITS.maxRecordBytes,
          )), false);
          assertMutationHeaders(request, body);
          const resource = contentSafeSchedule(await this.backend.createSchedule(body));
          sendJson(response, 201, successEnvelopeFrom(context, resource), this.limits.dashboard.maxOutboundBytesPerConnection, {
            ETag: scheduleEtag(resource.scheduleId, resource.revision),
          });
          return;
        }
      }
      const scheduleMatch = matchPath(url.pathname, `${DASH_API_BASE_PATH}/schedules/`, "");
      if (scheduleMatch !== undefined) {
        if (request.method === "GET") {
          const resource = contentSafeSchedule(await this.backend.getSchedule(scheduleMatch));
          sendJson(response, 200, successEnvelopeFrom(context, resource), this.limits.dashboard.maxOutboundBytesPerConnection, {
            ETag: scheduleEtag(resource.scheduleId, resource.revision),
          });
          return;
        }
        if (request.method === "PUT") {
          const body = scheduleMutationRequest(await readJsonBody(request, Math.min(
            this.limits.dashboard.maxHttpBodyBytes,
            DEFAULT_SCHEDULE_LIMITS.maxRecordBytes,
          )), true);
          assertMutationHeaders(request, body);
          assertScheduleIfMatch(request, scheduleMatch, body.expectedRevision!);
          const resource = contentSafeSchedule(await this.backend.updateSchedule(scheduleMatch, body));
          sendJson(response, 200, successEnvelopeFrom(context, resource), this.limits.dashboard.maxOutboundBytesPerConnection, {
            ETag: scheduleEtag(resource.scheduleId, resource.revision),
          });
          return;
        }
        if (request.method === "DELETE") {
          const body = scheduleDeleteRequest(await readJsonBody(request, 4096));
          assertMutationHeaders(request, body);
          assertScheduleIfMatch(request, scheduleMatch, body.expectedRevision);
          await this.backend.deleteSchedule(scheduleMatch, body);
          sendJson(response, 200, successEnvelopeFrom(context, { deleted: true }), this.limits.dashboard.maxOutboundBytesPerConnection);
          return;
        }
      }

      const workspaceMatch = matchPath(url.pathname, `${DASH_API_BASE_PATH}/workspaces/`, "");
      if (workspaceMatch !== undefined) {
        if (workspaceMatch !== session.workspaceId) {
          throw new DashboardServerError(404, "not_found", "dashboard route was not found");
        }
        if (request.method === "GET") {
          const workspace = await this.workspaceStore.getOrCreate(workspaceMatch);
          sendJson(
            response,
            200,
            successEnvelopeFrom(context, workspace),
            this.limits.dashboard.maxOutboundBytesPerConnection,
            { ETag: workspaceEtag(workspace) },
          );
          return;
        }
        if (request.method === "PUT") {
          const body = await readJsonBody(request, this.limits.dashboard.maxHttpBodyBytes);
          const workspace = await this.workspaceStore.update(
            workspaceMatch,
            body as DashboardWorkspaceUpdateRequest,
            requiredHeader(request.headers["if-match"], "If-Match"),
          );
          sendJson(
            response,
            200,
            successEnvelopeFrom(context, workspace),
            this.limits.dashboard.maxOutboundBytesPerConnection,
            { ETag: workspaceEtag(workspace) },
          );
          return;
        }
      }

      if (url.pathname === `${DASH_API_BASE_PATH}/settings`) {
        if (request.method === "GET") {
          const settings = await this.settingsStore.get();
          sendJson(
            response,
            200,
            successEnvelopeFrom(context, settings),
            this.limits.dashboard.maxOutboundBytesPerConnection,
            { ETag: settingsEtag(settings) },
          );
          return;
        }
        if (request.method === "PATCH") {
          const body = await readJsonBody(request, this.limits.dashboard.maxHttpBodyBytes);
          const settings = await this.settingsStore.patch(
            body as DashboardSettingsPatchRequest,
            requiredHeader(request.headers["if-match"], "If-Match"),
          );
          sendJson(
            response,
            200,
            successEnvelopeFrom(context, settings),
            this.limits.dashboard.maxOutboundBytesPerConnection,
            { ETag: settingsEtag(settings) },
          );
          return;
        }
        if (request.method === "DELETE") {
          const expectedRevision = integerHeader(
            request.headers["x-expected-revision"],
            "X-Expected-Revision",
          );
          const settings = await this.settingsStore.reset({
            expectedRevision,
            idempotencyKey: safeId(
              requiredHeader(request.headers["idempotency-key"], "Idempotency-Key"),
              "Idempotency-Key",
            ),
            ifMatch: requiredHeader(request.headers["if-match"], "If-Match"),
          });
          sendJson(
            response,
            200,
            successEnvelopeFrom(context, settings),
            this.limits.dashboard.maxOutboundBytesPerConnection,
            { ETag: settingsEtag(settings) },
          );
          return;
        }
      }

      throw new DashboardServerError(404, "not_found", "dashboard route was not found");
    } catch (error) {
      if (timedOut) return;
      const safe = safeHttpError(error);
      const session = tryAuthenticate(this.auth, request.headers.cookie);
      sendJson(
        response,
        safe.status,
        errorEnvelope(
          requestId,
          this.serverInstanceId,
          session?.clientId ?? "unauthenticated",
          session?.workspaceId ?? "unauthenticated",
          safe.body,
        ),
        this.limits.dashboard.maxOutboundBytesPerConnection,
        safe.status === 401 ? { Connection: "close" } : undefined,
      );
      if (safe.status === 401) response.once("finish", () => request.destroy());
    } finally {
      clearTimeout(deadline);
      this.metrics.observe("dashboard_http_latency_ms", performance.now() - startedAt);
    }
  }

  async #serveStatic(
    response: ServerResponse,
    relativePath: string,
    immutable: boolean,
    head: boolean,
  ): Promise<void> {
    const path = join(this.assetsDir, relativePath);
    const content = await readStaticFile(path, this.limits.maxStaticBytes);
    response.writeHead(200, {
      ...securityHeaders(),
      "Content-Type": contentType(path),
      "Content-Length": String(content.length),
      "Cache-Control": immutable
        ? "public, max-age=31536000, immutable"
        : "no-store, max-age=0",
    });
    response.end(head ? undefined : content);
  }

  async #handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    try {
      this.#assertHost(request);
      this.#assertMutationOrigin(request);
      const url = this.#requestUrl(request);
      if (url.pathname !== `${DASH_API_BASE_PATH}/stream`) throw new DashboardAuthError("unauthorized", "upgrade denied");
      const protocols = parseProtocols(request.headers["sec-websocket-protocol"]);
      if (protocols.length !== 1 || protocols[0] !== DASH_STREAM_SUBPROTOCOL) {
        throw new DashboardAuthError("unauthorized", "upgrade denied");
      }
      const session = this.auth.authenticate(request.headers.cookie);
      if (this.#peers.size >= this.limits.dashboard.maxConnections) {
        throw new DashboardServerError(503, "connection_capacity", "dashboard connection capacity is exhausted", true);
      }
      this.#webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
        const peer = new DashboardWebSocketPeer(webSocket, this.limits.dashboard);
        this.#peers.add(peer);
        this.#peerSessionKeys.set(peer, session.sessionKey);
        const expiresIn = Math.max(1, Date.parse(session.expiresAt) - Date.now());
        const expiryTimer = setTimeout(
          () => peer.close(1008, "browser session expired"),
          expiresIn,
        );
        expiryTimer.unref();
        this.#peerExpiryTimers.set(peer, expiryTimer);
        peer.onClose(() => {
          this.#peers.delete(peer);
          this.#peerSessionKeys.delete(peer);
          const timer = this.#peerExpiryTimers.get(peer);
          if (timer !== undefined) clearTimeout(timer);
          this.#peerExpiryTimers.delete(peer);
        });
        if (this.#streamHandler === undefined) {
          peer.close(1013, "dashboard stream backend unavailable");
          return;
        }
        Promise.resolve(this.#streamHandler({ session, peer })).catch(() => {
          peer.close(1011, "dashboard stream failed");
        });
      });
    } catch {
      rejectUpgrade(socket);
    }
  }

  #closeSessionPeers(sessionKey: string, code: number, reason: string): void {
    for (const [peer, key] of this.#peerSessionKeys) {
      if (key === sessionKey) peer.close(code, reason);
    }
  }

  #assertHost(request: IncomingMessage): void {
    if (this.#origin === undefined) throw new DashboardServerError(503, "not_ready", "dashboard server is not ready", true);
    if (request.headers.host !== new URL(this.#origin).host) {
      throw new DashboardServerError(403, "host_rejected", "dashboard Host validation failed");
    }
  }

  #assertMutationOrigin(request: IncomingMessage): void {
    if (this.#origin === undefined || request.headers.origin !== this.#origin) {
      throw new DashboardServerError(403, "origin_rejected", "dashboard Origin validation failed");
    }
  }

  #requestUrl(request: IncomingMessage): URL {
    if (this.#origin === undefined || request.url === undefined || Buffer.byteLength(request.url, "utf8") > MAX_URL_BYTES) {
      throw new DashboardServerError(400, "invalid_url", "dashboard request URL is invalid");
    }
    let url: URL;
    try {
      url = new URL(request.url, this.#origin);
    } catch {
      throw new DashboardServerError(400, "invalid_url", "dashboard request URL is invalid");
    }
    if (url.origin !== this.#origin || url.username !== "" || url.password !== "") {
      throw new DashboardServerError(400, "invalid_url", "dashboard request URL is invalid");
    }
    return url;
  }
}

/** Bounded server-owned WebSocket peer; downstream handlers never write raw sockets. */
export class DashboardWebSocketPeer {
  readonly #socket: WebSocket;
  readonly #limits: DashboardLimits;

  constructor(socket: WebSocket, limits: DashboardLimits) {
    this.#socket = socket;
    this.#limits = limits;
    // ws emits an error before its bounded maxPayload close. Admission errors
    // are connection-local and must never become uncaught process errors.
    this.#socket.on("error", () => undefined);
  }

  get protocol(): string {
    return this.#socket.protocol;
  }

  send(value: JsonValue | Record<string, unknown>): boolean {
    if (this.#socket.readyState !== WebSocket.OPEN) return false;
    let encoded: string;
    try {
      encoded = JSON.stringify(value);
    } catch {
      this.close(1007, "dashboard frame is not serializable");
      return false;
    }
    const bytes = Buffer.byteLength(encoded, "utf8");
    if (
      bytes > this.#limits.maxWebSocketFrameBytes ||
      this.#socket.bufferedAmount + bytes > this.#limits.maxOutboundBytesPerConnection
    ) {
      this.close(1009, "dashboard output bound exceeded");
      return false;
    }
    this.#socket.send(encoded);
    return true;
  }

  onMessage(listener: (text: string) => void | Promise<void>): () => void {
    const handler = (data: RawData, binary: boolean): void => {
      if (binary) {
        this.close(1003, "binary dashboard frames are unsupported");
        return;
      }
      const text = rawDataText(data);
      if (Buffer.byteLength(text, "utf8") > this.#limits.maxWebSocketFrameBytes) {
        this.close(1009, "dashboard frame bound exceeded");
        return;
      }
      Promise.resolve(listener(text)).catch(() => this.close(1011, "dashboard frame handler failed"));
    };
    this.#socket.on("message", handler);
    return () => this.#socket.off("message", handler);
  }

  onClose(listener: () => void): () => void {
    this.#socket.on("close", listener);
    return () => this.#socket.off("close", listener);
  }

  close(code = 1000, reason = ""): void {
    if (this.#socket.readyState === WebSocket.CLOSING || this.#socket.readyState === WebSocket.CLOSED) return;
    this.#socket.close(code, reason.slice(0, 123));
  }
}

export async function createDashboardServerFromConfig(
  options: DashboardServerFromConfigOptions,
): Promise<DashboardServer> {
  const web = mergeWebConfig({
    ...options.loadedConfig.config.web,
    ...options.webOverrides,
  });
  if (web.enabled === false) throw new Error("dashboard web server is disabled");
  const tokenPath =
    web.auth.tokenFile === undefined
      ? join(options.stateDir, "web-token")
      : options.loadedConfig.resolvePath(web.auth.tokenFile);
  await ensureDashboardCredentialFile(tokenPath);
  const publicOrigin = options.publicOrigin;
  const auth = await DashboardBrowserAuth.fromTokenFile(tokenPath, {
    sessionTtlMs: web.auth.sessionTtlMs,
    secureCookies: publicOrigin?.startsWith("https://") ?? false,
  });
  const dashboardLimits = {
    ...DASH_DEFAULT_LIMITS,
    maxIndexedSessions: web.inventory.maxSessions,
    inventoryReconcileIntervalMs: web.inventory.reconcileIntervalMs,
    maxPinnedSessionsPerWorkspace: web.residency.maxPinnedPerWorkspace,
    maxTuiRows: web.tui.maxRows,
    maxTuiColumns: web.tui.maxColumns,
    browserSessionTtlMs: web.auth.sessionTtlMs,
  } satisfies DashboardLimits;
  const workspaceStore = new DashboardWorkspaceStore({
    stateDir: options.stateDir,
    limits: dashboardLimits,
  });
  const settingsStore = new DashboardSettingsStore({
    stateDir: options.stateDir,
    limits: dashboardLimits,
    configuredUi: web.ui,
  });
  if (options.streamHandler !== undefined && options.streamHandlerFactory !== undefined) {
    throw new Error("configure either streamHandler or streamHandlerFactory, not both");
  }
  const serverInstanceId = options.serverInstanceId ?? `dash-${randomUUID()}`;
  const streamHandler = options.streamHandler ?? options.streamHandlerFactory?.({
    backend: options.backend,
    serverInstanceId,
    limits: dashboardLimits,
  });
  return new DashboardServer({
    backend: options.backend,
    auth,
    workspaceStore,
    settingsStore,
    ...(options.assetsDir === undefined ? {} : { assetsDir: options.assetsDir }),
    host: web.bind,
    port: web.port,
    ...(publicOrigin === undefined ? {} : { publicOrigin }),
    serverInstanceId,
    limits: dashboardLimits,
    ...(streamHandler === undefined ? {} : { streamHandler }),
  });
}

function mergeWebConfig(config: PiDaemonWebConfig | undefined): {
  enabled: boolean;
  bind: string;
  port: number;
  auth: { tokenFile?: string; sessionTtlMs: number };
  inventory: { roots: string[]; reconcileIntervalMs: number; maxSessions: number };
  residency: { warmTtlMs: number; maxPinnedPerWorkspace: number };
  tui: { enabled: boolean; defaultPresentation: "rich" | "tui"; maxRows: number; maxColumns: number };
  ui: Readonly<Record<string, import("./config.js").ConfigJson>>;
} {
  return {
    enabled: config?.enabled ?? DEFAULT_PI_DAEMON_WEB_CONFIG.enabled,
    bind: config?.bind ?? DEFAULT_PI_DAEMON_WEB_CONFIG.bind,
    port: config?.port ?? DEFAULT_PI_DAEMON_WEB_CONFIG.port,
    auth: {
      ...(config?.auth?.tokenFile === undefined ? {} : { tokenFile: config.auth.tokenFile }),
      sessionTtlMs: config?.auth?.sessionTtlMs ?? DEFAULT_PI_DAEMON_WEB_CONFIG.auth.sessionTtlMs,
    },
    inventory: {
      roots: [...(config?.inventory?.roots ?? DEFAULT_PI_DAEMON_WEB_CONFIG.inventory.roots)],
      reconcileIntervalMs:
        config?.inventory?.reconcileIntervalMs ??
        DEFAULT_PI_DAEMON_WEB_CONFIG.inventory.reconcileIntervalMs,
      maxSessions:
        config?.inventory?.maxSessions ?? DEFAULT_PI_DAEMON_WEB_CONFIG.inventory.maxSessions,
    },
    residency: {
      warmTtlMs:
        config?.residency?.warmTtlMs ?? DEFAULT_PI_DAEMON_WEB_CONFIG.residency.warmTtlMs,
      maxPinnedPerWorkspace:
        config?.residency?.maxPinnedPerWorkspace ??
        DEFAULT_PI_DAEMON_WEB_CONFIG.residency.maxPinnedPerWorkspace,
    },
    tui: {
      enabled: config?.tui?.enabled ?? DEFAULT_PI_DAEMON_WEB_CONFIG.tui.enabled,
      defaultPresentation:
        config?.tui?.defaultPresentation ??
        DEFAULT_PI_DAEMON_WEB_CONFIG.tui.defaultPresentation,
      maxRows: config?.tui?.maxRows ?? DEFAULT_PI_DAEMON_WEB_CONFIG.tui.maxRows,
      maxColumns: config?.tui?.maxColumns ?? DEFAULT_PI_DAEMON_WEB_CONFIG.tui.maxColumns,
    },
    ui: config?.ui ?? DEFAULT_PI_DAEMON_WEB_CONFIG.ui,
  };
}

function contentSafeSchedule(value: DashboardScheduleResource): DashboardScheduleResource {
  const { prompt: _prompt, ...safe } = value as DashboardScheduleResource & { prompt?: unknown };
  return { ...safe, promptConfigured: true };
}

function scheduleMutationRequest(
  value: unknown,
  update: boolean,
): DashboardScheduleMutationRequest {
  const object = requestObject(value, "schedule mutation request");
  exactRequestKeys(
    object,
    ["requestId", "idempotencyKey", "expectedRevision", "schedule"],
    update ? [] : ["expectedRevision"],
  );
  const expectedRevision = object.expectedRevision === undefined
    ? undefined
    : requestRevision(object.expectedRevision);
  if (update && expectedRevision === undefined) {
    throw new DashboardServerError(400, "invalid_request", "expectedRevision is required");
  }
  const schedule = scheduleWrite(object.schedule, update);
  return {
    requestId: requiredId(object.requestId, "requestId"),
    idempotencyKey: requiredId(object.idempotencyKey, "idempotencyKey"),
    ...(expectedRevision === undefined ? {} : { expectedRevision }),
    schedule,
  };
}

function scheduleDeleteRequest(value: unknown): DashboardScheduleDeleteRequest {
  const object = requestObject(value, "schedule delete request");
  exactRequestKeys(object, ["requestId", "idempotencyKey", "expectedRevision"]);
  return {
    requestId: requiredId(object.requestId, "requestId"),
    idempotencyKey: requiredId(object.idempotencyKey, "idempotencyKey"),
    expectedRevision: requestRevision(object.expectedRevision),
  };
}

function scheduleWrite(value: unknown, update: boolean): DashboardScheduleWrite {
  const object = requestObject(value, "schedule");
  const keys = [
    "scheduleId", "sessionRef", "enabled", "cron", "timezone", "prompt", "execution",
    "overlapPolicy", "missedWakePolicy", "jitterMs", "maxAdmissionDelayMs",
  ];
  exactRequestKeys(object, keys, update ? ["prompt", "execution"] : ["execution"]);
  if (typeof object.enabled !== "boolean") throw invalidScheduleRequest();
  if (typeof object.cron !== "string" || typeof object.timezone !== "string") throw invalidScheduleRequest();
  if (object.prompt !== undefined && (
    typeof object.prompt !== "string" || object.prompt.length === 0 || object.prompt.includes("\0") ||
    Buffer.byteLength(object.prompt, "utf8") > DEFAULT_SCHEDULE_LIMITS.maxPromptBytes
  )) throw invalidScheduleRequest();
  if (!(object.overlapPolicy === "skip" || object.overlapPolicy === "queue-one" || object.overlapPolicy === "reject")) {
    throw invalidScheduleRequest();
  }
  if (!isRecord(object.missedWakePolicy) || !["skip", "run-once", "bounded-catch-up"].includes(String(object.missedWakePolicy.mode))) {
    throw invalidScheduleRequest();
  }
  if (!Number.isSafeInteger(object.jitterMs) || !Number.isSafeInteger(object.maxAdmissionDelayMs)) throw invalidScheduleRequest();
  return {
    scheduleId: requiredId(object.scheduleId, "scheduleId"),
    sessionRef: requiredId(object.sessionRef, "sessionRef"),
    enabled: object.enabled,
    cron: object.cron,
    timezone: object.timezone,
    ...(object.prompt === undefined ? {} : { prompt: object.prompt as string }),
    ...(object.execution === undefined ? {} : { execution: object.execution as NonNullable<DashboardScheduleWrite["execution"]> }),
    overlapPolicy: object.overlapPolicy,
    missedWakePolicy: object.missedWakePolicy as unknown as DashboardScheduleWrite["missedWakePolicy"],
    jitterMs: object.jitterMs as number,
    maxAdmissionDelayMs: object.maxAdmissionDelayMs as number,
  };
}

function assertMutationHeaders(
  request: IncomingMessage,
  body: { requestId: string; idempotencyKey: string },
): void {
  if (requiredHeader(request.headers["idempotency-key"], "Idempotency-Key") !== body.idempotencyKey) {
    throw new DashboardServerError(400, "invalid_header", "Idempotency-Key does not match the request body");
  }
  const suppliedRequestId = request.headers["x-request-id"];
  if (suppliedRequestId !== undefined && suppliedRequestId !== body.requestId) {
    throw new DashboardServerError(400, "invalid_header", "X-Request-ID does not match the request body");
  }
}

function assertDashboardDraftIfMatch(
  request: IncomingMessage,
  draftId: string,
  revision: number,
): void {
  if (
    typeof request.headers["if-match"] !== "string" ||
    request.headers["if-match"] !== dashboardSessionDraftEtag(draftId, revision)
  ) {
    throw new DashboardServerError(
      412,
      "draft_revision_conflict",
      "If-Match does not match expectedRevision",
    );
  }
}

function assertScheduleIfMatch(
  request: IncomingMessage,
  scheduleId: string,
  revision: number,
): void {
  if (requiredHeader(request.headers["if-match"], "If-Match") !== scheduleEtag(scheduleId, revision)) {
    throw new DashboardServerError(412, "schedule_precondition_failed", "If-Match does not match expectedRevision");
  }
}

function requestRevision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw invalidScheduleRequest();
  return value as number;
}

function invalidScheduleRequest(): DashboardServerError {
  return new DashboardServerError(400, "invalid_schedule_request", "schedule request is invalid");
}

function scheduleListQuery(url: URL): string | undefined {
  for (const key of url.searchParams.keys()) if (key !== "session") throw invalidQuery();
  const session = singleQueryValue(url, "session");
  if (session === null) return undefined;
  return safeId(session, "session");
}

function activationRequest(value: unknown): ActivationRequest {
  const object = requestObject(value, "activation request");
  exactRequestKeys(object, [
    "requestId",
    "idempotencyKey",
    "mode",
    "expectedFingerprint",
    "desiredSessionName",
    "policyRef",
  ], ["expectedFingerprint", "desiredSessionName", "policyRef"]);
  if (!(["reuse", "direct", "fork", "preview-only"] as unknown[]).includes(object.mode)) {
    throw new DashboardServerError(400, "invalid_request", "activation mode is invalid");
  }
  const expectedFingerprint = optionalFingerprint(object.expectedFingerprint);
  const desiredSessionName = optionalBoundedText(object.desiredSessionName, "desiredSessionName", 256);
  const policyRef = optionalId(object.policyRef, "policyRef");
  return {
    requestId: requiredId(object.requestId, "requestId"),
    idempotencyKey: requiredId(object.idempotencyKey, "idempotencyKey"),
    mode: object.mode as ActivationRequest["mode"],
    ...(expectedFingerprint === undefined ? {} : { expectedFingerprint }),
    ...(desiredSessionName === undefined ? {} : { desiredSessionName }),
    ...(policyRef === undefined ? {} : { policyRef }),
  };
}

function exportRequest(value: unknown): SessionExportRequest {
  const object = requestObject(value, "export request");
  exactRequestKeys(object, [
    "requestId",
    "idempotencyKey",
    "mode",
    "expectedSourceFingerprint",
    "releaseAfterExport",
  ], ["expectedSourceFingerprint", "releaseAfterExport"]);
  if (object.mode !== "as-new" && object.mode !== "append-to-origin") {
    throw new DashboardServerError(400, "invalid_request", "export mode is invalid");
  }
  if (object.releaseAfterExport !== undefined && typeof object.releaseAfterExport !== "boolean") {
    throw new DashboardServerError(400, "invalid_request", "releaseAfterExport is invalid");
  }
  const expectedSourceFingerprint = optionalFingerprint(object.expectedSourceFingerprint);
  return {
    requestId: requiredId(object.requestId, "requestId"),
    idempotencyKey: requiredId(object.idempotencyKey, "idempotencyKey"),
    mode: object.mode,
    ...(expectedSourceFingerprint === undefined ? {} : { expectedSourceFingerprint }),
    ...(object.releaseAfterExport === undefined
      ? {}
      : { releaseAfterExport: object.releaseAfterExport }),
  };
}

function requestObject(value: unknown, name: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new DashboardServerError(400, "invalid_request", `${name} must be an object`);
  }
  return value;
}

function exactRequestKeys(
  object: Record<string, unknown>,
  allowed: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowedSet = new Set(allowed);
  const optionalSet = new Set(optional);
  if (
    Object.keys(object).some((key) => !allowedSet.has(key)) ||
    allowed.some((key) => !optionalSet.has(key) && !Object.prototype.hasOwnProperty.call(object, key))
  ) {
    throw new DashboardServerError(400, "invalid_request", "request fields are invalid");
  }
}

function optionalFingerprint(value: unknown): ReturnType<typeof asDashboardFingerprint> | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new DashboardServerError(400, "invalid_request", "source fingerprint is invalid");
  }
  try {
    return asDashboardFingerprint(value);
  } catch {
    throw new DashboardServerError(400, "invalid_request", "source fingerprint is invalid");
  }
}

function optionalBoundedText(value: unknown, name: string, maxBytes: number): string | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > maxBytes ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new DashboardServerError(400, "invalid_request", `${name} is invalid`);
  }
  return value;
}

function requiredId(value: unknown, name: string): string {
  if (typeof value !== "string") {
    throw new DashboardServerError(400, "invalid_request", `${name} is invalid`);
  }
  return safeId(value, name);
}

function optionalId(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new DashboardServerError(400, "invalid_request", `${name} is invalid`);
  }
  return safeId(value, name);
}

function inventoryQuery(url: URL, limits: DashboardLimits): SessionInventoryQuery {
  const allowed = new Set(["cursor", "limit", "search", "sourceKind", "runtime", "unread", "modifiedAfter"]);
  for (const key of url.searchParams.keys()) if (!allowed.has(key)) throw invalidQuery();
  const result: SessionInventoryQuery = {};
  const cursor = singleQueryValue(url, "cursor");
  if (cursor !== null) result.cursor = asDashboardCursor(cursor);
  const limit = optionalQueryInteger(singleQueryValue(url, "limit"), limits.maxInventoryPageItems);
  if (limit !== undefined) result.limit = limit;
  const search = singleQueryValue(url, "search");
  if (search !== null) {
    if (search.length > limits.maxSearchQueryChars) throw invalidQuery();
    result.search = search;
  }
  const sourceKinds = url.searchParams.getAll("sourceKind");
  if (sourceKinds.length > 0) {
    const allowedKinds = ["managed", "external", "direct", "imported", "exported", "memory"] as const;
    if (
      sourceKinds.length > allowedKinds.length ||
      new Set(sourceKinds).size !== sourceKinds.length ||
      sourceKinds.some((kind) => !(allowedKinds as readonly string[]).includes(kind))
    ) throw invalidQuery();
    result.sourceKinds = sourceKinds as NonNullable<SessionInventoryQuery["sourceKinds"]>;
  }
  const runtime = url.searchParams.getAll("runtime");
  if (runtime.length > 0) {
    const allowedRuntime = ["unmanaged", "dormant", "resident-idle", "running", "failed"] as const;
    if (
      runtime.length > allowedRuntime.length ||
      new Set(runtime).size !== runtime.length ||
      runtime.some((state) => !(allowedRuntime as readonly string[]).includes(state))
    ) throw invalidQuery();
    result.runtime = runtime as NonNullable<SessionInventoryQuery["runtime"]>;
  }
  const unread = singleQueryValue(url, "unread");
  if (unread !== null) {
    if (unread !== "true" && unread !== "false") throw invalidQuery();
    result.unread = unread === "true";
  }
  const modifiedAfter = singleQueryValue(url, "modifiedAfter");
  if (modifiedAfter !== null) {
    if (!Number.isFinite(Date.parse(modifiedAfter)) || modifiedAfter.length > 64) throw invalidQuery();
    result.modifiedAfter = modifiedAfter;
  }
  return result;
}

function transcriptQuery(url: URL, limits: DashboardLimits): TranscriptQuery {
  const allowed = new Set(["cursor", "limit", "direction", "leafId"]);
  for (const key of url.searchParams.keys()) if (!allowed.has(key)) throw invalidQuery();
  const result: TranscriptQuery = {};
  const cursor = singleQueryValue(url, "cursor");
  if (cursor !== null) result.cursor = asDashboardCursor(cursor);
  const limit = optionalQueryInteger(singleQueryValue(url, "limit"), limits.maxTranscriptPageRecords);
  if (limit !== undefined) result.limit = limit;
  const direction = singleQueryValue(url, "direction");
  if (direction !== null) {
    if (direction !== "older" && direction !== "newer") throw invalidQuery();
    result.direction = direction;
  }
  const leafId = singleQueryValue(url, "leafId");
  if (leafId !== null) result.leafId = safeId(leafId, "leafId");
  return result;
}

async function readJsonBody(request: IncomingMessage, maxBytes: number): Promise<unknown> {
  const contentTypeHeader = request.headers["content-type"];
  if (typeof contentTypeHeader !== "string" || !/^application\/json(?:\s*;.*)?$/i.test(contentTypeHeader)) {
    throw new DashboardServerError(415, "unsupported_media_type", "dashboard request requires application/json");
  }
  const contentLength = request.headers["content-length"];
  if (contentLength !== undefined) {
    if (typeof contentLength !== "string" || !/^\d+$/.test(contentLength) || Number(contentLength) > maxBytes) {
      throw new DashboardServerError(413, "body_too_large", "dashboard request body exceeds its byte limit");
    }
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > maxBytes) throw new DashboardServerError(413, "body_too_large", "dashboard request body exceeds its byte limit");
    chunks.push(buffer);
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, bytes)));
  } catch {
    throw new DashboardServerError(400, "invalid_json", "dashboard request body is not valid JSON");
  }
}

async function readStaticFile(path: string, maxBytes: number): Promise<Buffer> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (isNodeError(error) && (error.code === "ENOENT" || error.code === "ELOOP")) {
      throw new DashboardServerError(404, "not_found", "dashboard asset was not found");
    }
    throw error;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || (info.mode & 0o022) !== 0 || info.size > maxBytes) {
      throw new DashboardServerError(404, "not_found", "dashboard asset was not found");
    }
    const getuid = process.getuid;
    if (getuid !== undefined && info.uid !== getuid() && info.uid !== 0) {
      throw new DashboardServerError(404, "not_found", "dashboard asset was not found");
    }
    const result = Buffer.allocUnsafe(info.size);
    let offset = 0;
    while (offset < result.length) {
      const { bytesRead } = await handle.read(result, offset, result.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset !== result.length) throw new DashboardServerError(404, "not_found", "dashboard asset was not found");
    return result;
  } finally {
    await handle.close();
  }
}

function decodeAssetName(value: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw new DashboardServerError(404, "not_found", "dashboard asset was not found");
  }
  if (
    decoded !== basename(decoded) ||
    !/^[A-Za-z0-9_.-]+-[A-Za-z0-9_-]{8,}\.(?:js|css|woff2?|png|jpe?g|webp|svg|ico)$/.test(decoded)
  ) {
    throw new DashboardServerError(404, "not_found", "dashboard asset was not found");
  }
  return decoded;
}

function matchPath(pathname: string, prefix: string, suffix: string): string | undefined {
  if (!pathname.startsWith(prefix) || !pathname.endsWith(suffix)) return undefined;
  const encoded = pathname.slice(prefix.length, pathname.length - suffix.length || undefined);
  if (encoded.length === 0 || encoded.includes("/")) return undefined;
  let value: string;
  try {
    value = decodeURIComponent(encoded);
  } catch {
    return undefined;
  }
  try {
    return safeId(value, "route identity");
  } catch {
    return undefined;
  }
}

function sendJson(
  response: ServerResponse,
  status: number,
  value: unknown,
  maxBytes: number,
  extraHeaders: Record<string, string> = {},
): void {
  let encoded = JSON.stringify(value);
  let bytes = Buffer.byteLength(encoded, "utf8");
  if (bytes > maxBytes) {
    status = 500;
    const context = responseContext(value);
    encoded = JSON.stringify({
      dashVersion: DASH_API_VERSION,
      ...context,
      ok: false,
      error: {
        code: "response_too_large",
        message: "dashboard response exceeds its byte limit",
        retryable: false,
      },
    });
    bytes = Buffer.byteLength(encoded, "utf8");
  }
  response.writeHead(status, {
    ...securityHeaders(),
    "Content-Type": JSON_CONTENT_TYPE,
    "Content-Length": String(bytes),
    "Cache-Control": "no-store, max-age=0",
    ...extraHeaders,
  });
  response.end(encoded);
}

function responseContext(value: unknown): DashboardEnvelopeContext {
  if (isRecord(value)) {
    const requestId = value.requestId;
    const serverInstanceId = value.serverInstanceId;
    const clientId = value.clientId;
    const workspaceId = value.workspaceId;
    if (
      typeof requestId === "string" &&
      typeof serverInstanceId === "string" &&
      typeof clientId === "string" &&
      typeof workspaceId === "string"
    ) {
      return { requestId, serverInstanceId, clientId, workspaceId };
    }
  }
  return {
    requestId: "response-too-large",
    serverInstanceId: "unknown",
    clientId: "unknown",
    workspaceId: "unknown",
  };
}

function securityHeaders(): Record<string, string> {
  return {
    "Content-Security-Policy": CSP,
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Cross-Origin-Opener-Policy": "same-origin",
  };
}

function successEnvelope<T>(
  requestId: string,
  serverInstanceId: string,
  clientId: string,
  workspaceId: string,
  data: T,
): DashboardSuccessEnvelope<T> {
  return { dashVersion: DASH_API_VERSION, requestId, serverInstanceId, clientId, workspaceId, ok: true, data };
}

function successEnvelopeFrom<T>(
  context: DashboardEnvelopeContext,
  data: T,
): DashboardSuccessEnvelope<T> {
  return { dashVersion: DASH_API_VERSION, ...context, ok: true, data };
}

function errorEnvelope(
  requestId: string,
  serverInstanceId: string,
  clientId: string,
  workspaceId: string,
  error: ApiErrorBody,
): DashboardErrorEnvelope {
  return { dashVersion: DASH_API_VERSION, requestId, serverInstanceId, clientId, workspaceId, ok: false, error };
}

function envelopeContext(
  requestId: string,
  serverInstanceId: string,
  session: DashboardAuthenticatedSession,
): DashboardEnvelopeContext {
  return { requestId, serverInstanceId, clientId: session.clientId, workspaceId: session.workspaceId };
}

function safeHttpError(error: unknown): { status: number; body: ApiErrorBody } {
  if (error instanceof DashboardAuthError) {
    return { status: error.status, body: { code: error.code, message: error.message, retryable: false } };
  }
  if (error instanceof DashboardStoreError || error instanceof DashboardServerError) {
    return {
      status: error.status,
      body: {
        code: error.code,
        message: error.message,
        retryable: error instanceof DashboardServerError ? error.retryable : false,
      },
    };
  }
  if (
    error instanceof Error &&
    (error.name === "InProcessDashboardBackendError" || error.name === "RemoteDashboardBackendError") &&
    "code" in error && typeof error.code === "string"
  ) {
    const status = error.code.includes("not_found") ? 404
      : error.code.includes("precondition") ? 412
      : error.code.includes("unavailable") ? 501
      : error.code.includes("capacity") ? 429
      : error.code.includes("conflict") ? 409
      : error.code.includes("invalid") ? 400
      : 500;
    return {
      status,
      body: {
        code: error.code,
        message: status === 500 ? "dashboard backend operation failed" : error.message,
        retryable: "retryable" in error && error.retryable === true,
      },
    };
  }
  return {
    status: 500,
    body: { code: "internal_error", message: "dashboard request failed", retryable: false },
  };
}

function tryAuthenticate(
  auth: DashboardBrowserAuth,
  cookie: string | string[] | undefined,
): DashboardAuthenticatedSession | undefined {
  try {
    return auth.authenticate(cookie);
  } catch {
    return undefined;
  }
}

function requiredHeader(value: string | string[] | undefined, name: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 1024) {
    throw new DashboardServerError(400, "missing_header", `${name} header is required`);
  }
  return value;
}

function integerHeader(value: string | string[] | undefined, name: string): number {
  const text = requiredHeader(value, name);
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(Number(text))) {
    throw new DashboardServerError(400, "invalid_header", `${name} header is invalid`);
  }
  return Number(text);
}

function requestIdFrom(value: string | string[] | undefined): string {
  if (typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) return value;
  return `request-${randomUUID()}`;
}

function safeId(value: string, name: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    throw new DashboardServerError(400, "invalid_identifier", `${name} is invalid`);
  }
  return value;
}

function singleQueryValue(url: URL, name: string): string | null {
  const values = url.searchParams.getAll(name);
  if (values.length > 1) throw invalidQuery();
  return values[0] ?? null;
}

function optionalQueryInteger(value: string | null, max: number): number | undefined {
  if (value === null) return undefined;
  if (!/^\d+$/.test(value)) throw invalidQuery();
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > max) throw invalidQuery();
  return parsed;
}

function invalidQuery(): DashboardServerError {
  return new DashboardServerError(400, "invalid_query", "dashboard query is invalid");
}

function isMutation(method: string | undefined): boolean {
  return method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
}

function rawDataText(data: RawData): string {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return Buffer.from(data).toString("utf8");
}

function parseProtocols(value: string | string[] | undefined): string[] {
  if (typeof value !== "string" || value.length > 1024) return [];
  return value.split(",").map((part) => part.trim()).filter(Boolean);
}

function rejectUpgrade(socket: Duplex): void {
  if (!socket.destroyed) {
    socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
  }
}

function contentType(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".html": return "text/html; charset=utf-8";
    case ".js": return "text/javascript; charset=utf-8";
    case ".css": return "text/css; charset=utf-8";
    case ".svg": return "image/svg+xml";
    case ".png": return "image/png";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".webp": return "image/webp";
    case ".woff": return "font/woff";
    case ".woff2": return "font/woff2";
    case ".ico": return "image/x-icon";
    default: return "application/octet-stream";
  }
}

function validatePublicOrigin(value: string): string {
  const url = new URL(value);
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error("publicOrigin must be an HTTP(S) origin without path, credentials, query, or hash");
  }
  return url.origin;
}

function isLoopbackBind(host: string): boolean {
  if (host === "localhost") return true;
  if (host === "::1") return true;
  if (isIP(host) === 4) return host.startsWith("127.");
  return false;
}

function formatHost(host: string): string {
  return isIP(host) === 6 ? `[${host}]` : host;
}

function portNumber(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 65_535) throw new RangeError("port must be between 0 and 65535");
  return value;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be positive`);
  return value;
}

function mergeDashboardLimits(overrides: Partial<DashboardLimits>): DashboardLimits {
  const result = { ...DASH_DEFAULT_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(result)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be positive`);
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
