import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from "node:http";
import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";
import { isIP } from "node:net";
import { basename, dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Duplex } from "node:stream";
import { createSecureContext, type SecureContext } from "node:tls";

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
  DashboardAuthorizationEnforcer,
  activationTicketResource,
  draftResource,
  draftTicketResource,
  exportTicketResource,
  managedSessionRef,
  scheduleResource,
  workspaceResource,
} from "./dashboard-authorization-enforcer.js";
import {
  DashboardAuthorizationError,
  DashboardAuthorizationService,
  dashboardAuthorizationEtag,
  type DashboardResourcePolicy,
  type DashboardResourceRef,
  type DashboardResourceRole,
} from "./dashboard-authorization.js";
import {
  dashboardControllerEtag,
  type DashboardAuthorizationMutationRequest,
  type DashboardControllerTransferRequest,
  type DashboardGrantSetRequest,
  type DashboardOwnershipTransferRequest,
  type DashboardWorkspaceSelectionRequest,
} from "./dashboard-authorization-contract.js";
import { DashboardControllerCoordinator } from "./dashboard-controller-coordinator.js";
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
import {
  createDashboardIdentityProvider,
  loadDashboardIdentityProviderFile,
} from "./dashboard-identity-config.js";
import { HostMetrics } from "./observability.js";
import { scheduleEtag } from "./dashboard-schedule-resources.js";
import {
  loadDashboardTls,
  type DashboardTlsOptions,
  type DashboardTlsSourceConfig,
} from "./dashboard-tls.js";
import { DEFAULT_SCHEDULE_LIMITS } from "./schedule-contract.js";
import type { ApiErrorBody, JsonValue } from "./session-api.js";

const DEFAULT_MAX_HEADER_BYTES = 32 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_STATIC_MAX_BYTES = 8 * 1024 * 1024;
const MAX_URL_BYTES = 8192;
const MAX_CONTROLLER_TRANSFER_RECEIPTS = 256;
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
  authorization?: DashboardAuthorizationService | DashboardAuthorizationEnforcer;
  controllerCoordinator?: DashboardControllerCoordinator;
  assetsDir?: string;
  host?: string;
  port?: number;
  publicOrigin?: string;
  allowInsecureHttp?: boolean;
  trustForwardedHeaders?: boolean;
  tls?: DashboardTlsOptions;
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
  /** Revalidates provider-backed cookie identity before every sensitive frame/event. */
  revalidateSession: () => DashboardAuthenticatedSession;
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
    authorization: DashboardAuthorizationEnforcer;
    controllerCoordinator: DashboardControllerCoordinator;
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
  readonly authorization: DashboardAuthorizationEnforcer;
  readonly controllerCoordinator: DashboardControllerCoordinator;
  readonly assetsDir: string;
  readonly host: string;
  readonly port: number;
  readonly serverInstanceId: string;
  readonly limits: DashboardServerLimits;
  readonly metrics: HostMetrics;
  readonly #configuredPublicOrigin: string | undefined;
  readonly #securePublicOrigin: boolean;
  readonly #trustForwardedHeaders: boolean;
  readonly #tls: DashboardTlsOptions | undefined;
  #tlsContext: SecureContext | undefined;
  #tlsReloadTimer: NodeJS.Timeout | undefined;
  #tlsReloadRunning = false;
  readonly #streamHandler: DashboardStreamHandler | undefined;
  readonly #server: HttpServer | HttpsServer;
  readonly #webSocketServer: WebSocketServer;
  readonly #upgradeSockets = new Set<Duplex>();
  readonly #peers = new Set<DashboardWebSocketPeer>();
  readonly #peerSessionKeys = new Map<DashboardWebSocketPeer, string>();
  readonly #peerExpiryTimers = new Map<DashboardWebSocketPeer, NodeJS.Timeout>();
  readonly #controllerTransfers = new Map<string, {
    fingerprint: string;
    promise: Promise<{ policy: DashboardResourcePolicy; controller: ReturnType<DashboardControllerCoordinator["state"]> }>;
  }>();
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
    this.serverInstanceId = safeId(options.serverInstanceId ?? `dash-${randomUUID()}`, "serverInstanceId");
    this.#configuredPublicOrigin =
      options.publicOrigin === undefined ? undefined : validatePublicOrigin(options.publicOrigin);
    this.#securePublicOrigin = this.#configuredPublicOrigin?.startsWith("https://") ?? false;
    this.#trustForwardedHeaders = options.trustForwardedHeaders ?? false;
    this.#tls = options.tls;
    if (this.#tls !== undefined) {
      if (!this.#securePublicOrigin || this.#configuredPublicOrigin === undefined) {
        throw new Error("native Dashboard TLS requires an exact HTTPS publicOrigin");
      }
      this.#tlsContext = createSecureContext({
        cert: this.#tls.cert,
        key: this.#tls.key,
        minVersion: "TLSv1.2",
      });
    } else if (!isLoopbackBind(this.host)) {
      throw new Error(
        "plaintext Dashboard listener is loopback-only; configure native TLS or a loopback reverse proxy",
      );
    }
    if (
      this.#configuredPublicOrigin !== undefined &&
      !this.#securePublicOrigin &&
      !isLoopbackOrigin(this.#configuredPublicOrigin) &&
      options.allowInsecureHttp !== true
    ) {
      throw new Error(
        "non-loopback Dashboard publicOrigin requires HTTPS unless allowInsecureHttp is explicitly enabled",
      );
    }
    if (this.auth.secureCookies !== this.#securePublicOrigin) {
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
    this.authorization = options.authorization instanceof DashboardAuthorizationEnforcer
      ? options.authorization
      : new DashboardAuthorizationEnforcer({
          backend: this.backend,
          authorization: options.authorization ?? new DashboardAuthorizationService({
            stateDir: dirname(this.workspaceStore.stateDir),
            mode: "single-owner",
          }),
          maxInventoryPageItems: this.limits.dashboard.maxInventoryPageItems,
          cursorTtlMs: this.auth.sessionTtlMs,
        });
    this.controllerCoordinator = options.controllerCoordinator ?? new DashboardControllerCoordinator();
    this.#streamHandler = options.streamHandler;
    const requestHandler = (request: IncomingMessage, response: ServerResponse): void => {
      void this.#handleRequest(request, response);
    };
    this.#server =
      this.#tls === undefined
        ? createHttpServer({ maxHeaderSize: this.limits.maxHeaderBytes }, requestHandler)
        : createHttpsServer(
            {
              cert: this.#tls.cert,
              key: this.#tls.key,
              minVersion: "TLSv1.2",
              maxHeaderSize: this.limits.maxHeaderBytes,
              SNICallback: (servername, callback) => {
                if (!sniMatchesOrigin(servername, this.#configuredPublicOrigin!)) {
                  callback(new Error("Dashboard TLS SNI rejected"));
                  return;
                }
                callback(null, this.#tlsContext!);
              },
            },
            requestHandler,
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
    await this.authorization.initialize();
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
    const scheme = this.#tls === undefined ? "http" : "https";
    this.#origin =
      this.#configuredPublicOrigin ?? `${scheme}://${formatHost(this.host)}:${address.port}`;
    this.#started = true;
    this.#startTlsReload();
    return this.address!;
  }

  async stop(): Promise<void> {
    if (this.#tlsReloadTimer !== undefined) clearInterval(this.#tlsReloadTimer);
    this.#tlsReloadTimer = undefined;
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

  #startTlsReload(): void {
    if (
      this.#tls?.reload === undefined ||
      this.#tls.reloadIntervalMs === undefined ||
      !("setSecureContext" in this.#server)
    ) {
      return;
    }
    this.#tlsReloadTimer = setInterval(() => {
      if (this.#tlsReloadRunning) return;
      this.#tlsReloadRunning = true;
      void this.#tls!
        .reload!()
        .then((material) => {
          if (material === undefined || !("setSecureContext" in this.#server)) return;
          const context = createSecureContext({
            cert: material.cert,
            key: material.key,
            minVersion: "TLSv1.2",
          });
          this.#server.setSecureContext({
            cert: material.cert,
            key: material.key,
            minVersion: "TLSv1.2",
          });
          this.#tlsContext = context;
          material.commit();
          this.metrics.increment("dashboard_tls_rotations");
        })
        .catch(() => this.metrics.increment("dashboard_tls_rotation_failures"))
        .finally(() => {
          this.#tlsReloadRunning = false;
        });
    }, this.#tls.reloadIntervalMs);
    this.#tlsReloadTimer.unref();
  }

  async #handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const startedAt = performance.now();
    const requestId = requestIdFrom(request.headers["x-request-id"]);
    let diagnosticPath = "/";
    if (this.#securePublicOrigin) {
      response.setHeader("Strict-Transport-Security", "max-age=31536000");
    }
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
      diagnosticPath = url.pathname;
      if (request.method === "GET" || request.method === "HEAD") {
        if (url.pathname === "/dash/healthz") {
          response.writeHead(204, {
            ...securityHeaders(),
            "Cache-Control": "no-store, max-age=0",
          });
          response.end();
          return;
        }
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
        let result = this.auth.login(body as DashboardLoginRequest);
        let issued = tryAuthenticate(this.auth, result.setCookie);
        if (issued === undefined) throw new Error("issued dashboard browser session is unavailable");
        if (this.authorization.authorization.mode === "multi-user") {
          const workspaceId = identityWorkspaceId(issued.principal.identityId);
          if (issued.workspaceId !== workspaceId) {
            issued = this.auth.switchWorkspace(issued, workspaceId);
            result = {
              ...result,
              session: { ...result.session, workspaceId },
            };
          }
        }
        try {
          await this.authorization.registerCreated(
            issued.principal,
            "workspace",
            result.session.workspaceId,
          );
          await this.workspaceStore.getOrCreate(result.session.workspaceId);
        } catch (error) {
          this.auth.revoke(issued);
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

      if (request.method === "GET" && url.pathname === `${DASH_API_BASE_PATH}/workspaces`) {
        const visible = await this.authorization.authorization.listPolicies(
          session.principal,
          { kind: "workspace", limit: 100 },
        );
        const workspaces = await Promise.all(visible.policies.map(async (policy) => ({
          workspace: await this.workspaceStore.getOrCreate(policy.resource.id),
          policy,
          role: (await this.authorization.effectiveRole(session.principal, policy.resource))!,
        })));
        sendJson(
          response,
          200,
          successEnvelopeFrom(context, { workspaces, truncated: visible.truncated }),
          this.limits.dashboard.maxOutboundBytesPerConnection,
        );
        return;
      }

      if (request.method === "POST" && url.pathname === `${DASH_API_BASE_PATH}/workspaces/select`) {
        const body = workspaceSelectionRequest(
          await readJsonBody(request, this.limits.dashboard.maxHttpBodyBytes),
        );
        await this.authorization.require(
          session.principal,
          workspaceResource(body.workspaceId),
          "read",
        );
        await this.workspaceStore.getOrCreate(body.workspaceId);
        this.#closeSessionPeers(session.sessionKey, 1008, "browser workspace changed");
        const switched = this.auth.switchWorkspace(session, body.workspaceId);
        const browserSession = this.auth.browserSession(switched);
        sendJson(
          response,
          200,
          successEnvelope(
            requestId,
            this.serverInstanceId,
            switched.clientId,
            switched.workspaceId,
            browserSession,
          ),
          this.limits.dashboard.maxOutboundBytesPerConnection,
          { [DASH_CSRF_HEADER]: browserSession.csrfToken },
        );
        return;
      }

      const authorizationRoute = matchAuthorizationRoute(url.pathname);
      if (authorizationRoute !== undefined) {
        if (authorizationRoute.action !== "audit" && url.searchParams.size > 0) {
          throw invalidQuery();
        }
        const resource = authorizationRoute.kind === "session"
          ? (await this.authorization.requireInventorySession(
              session.principal,
              authorizationRoute.resourceId,
              "admin",
            )).resource
          : workspaceResource(authorizationRoute.resourceId);
        if (authorizationRoute.action === "controller" && resource.kind !== "session") {
          throw new DashboardAuthorizationError("not_found", "dashboard resource was not found", 404);
        }
        const policy = await this.authorization.authorization.policy(session.principal, resource);
        const responseHeaders = { ETag: dashboardAuthorizationEtag(policy) };

        if (request.method === "GET" && authorizationRoute.action === "policy") {
          sendJson(
            response,
            200,
            successEnvelopeFrom(context, { policy, role: "admin" as const }),
            this.limits.dashboard.maxOutboundBytesPerConnection,
            responseHeaders,
          );
          return;
        }
        if (request.method === "GET" && authorizationRoute.action === "audit") {
          for (const key of url.searchParams.keys()) {
            if (key !== "afterSequence" && key !== "limit") throw invalidQuery();
          }
          const audit = await this.authorization.authorization.auditEvents(
            session.principal,
            {
              resource,
              afterSequence: optionalNonNegativeQueryInteger(url, "afterSequence") ?? 0,
              limit: optionalPositiveQueryInteger(url, "limit", 1_000) ?? 100,
            },
          );
          sendJson(
            response,
            200,
            successEnvelopeFrom(context, audit),
            this.limits.dashboard.maxOutboundBytesPerConnection,
          );
          return;
        }
        if (request.method === "GET" && authorizationRoute.action === "controller") {
          const controller = this.controllerCoordinator.state(resource);
          sendJson(
            response,
            200,
            successEnvelopeFrom(context, controller),
            this.limits.dashboard.maxOutboundBytesPerConnection,
            { ETag: dashboardControllerEtag(resource, controller.revision) },
          );
          return;
        }
        if (
          request.method === "PUT" &&
          authorizationRoute.action === "grant" &&
          authorizationRoute.subjectIdentityId !== undefined
        ) {
          const body = grantSetRequest(
            await readJsonBody(request, this.limits.dashboard.maxHttpBodyBytes),
          );
          assertMutationHeaders(request, body);
          assertAuthorizationIfMatch(request, policy, body.expectedRevision);
          requireKnownDashboardIdentity(this.auth, authorizationRoute.subjectIdentityId);
          const updated = await this.authorization.authorization.setGrant({
            principal: session.principal,
            resource,
            subjectIdentityId: authorizationRoute.subjectIdentityId,
            role: body.role,
            expectedRevision: body.expectedRevision,
            idempotencyKey: body.idempotencyKey,
          });
          await this.controllerCoordinator.applyIdentityRole(
            resource,
            authorizationRoute.subjectIdentityId,
            body.role,
          );
          sendJson(
            response,
            200,
            successEnvelopeFrom(context, { policy: updated, role: "admin" as const }),
            this.limits.dashboard.maxOutboundBytesPerConnection,
            { ETag: dashboardAuthorizationEtag(updated) },
          );
          return;
        }
        if (
          request.method === "DELETE" &&
          authorizationRoute.action === "grant" &&
          authorizationRoute.subjectIdentityId !== undefined
        ) {
          const body = authorizationMutationRequest(
            await readJsonBody(request, this.limits.dashboard.maxHttpBodyBytes),
          );
          assertMutationHeaders(request, body);
          assertAuthorizationIfMatch(request, policy, body.expectedRevision);
          const updated = await this.authorization.authorization.revokeGrant({
            principal: session.principal,
            resource,
            subjectIdentityId: authorizationRoute.subjectIdentityId,
            expectedRevision: body.expectedRevision,
            idempotencyKey: body.idempotencyKey,
          });
          await this.controllerCoordinator.applyIdentityRole(
            resource,
            authorizationRoute.subjectIdentityId,
            undefined,
          );
          if (resource.kind === "workspace") {
            for (const sessionKey of this.auth.revokeIdentityWorkspace(
              authorizationRoute.subjectIdentityId,
              resource.id,
            )) {
              this.#closeSessionPeers(sessionKey, 1008, "workspace access revoked");
            }
          }
          sendJson(
            response,
            200,
            successEnvelopeFrom(context, { policy: updated, role: "admin" as const }),
            this.limits.dashboard.maxOutboundBytesPerConnection,
            { ETag: dashboardAuthorizationEtag(updated) },
          );
          return;
        }
        if (request.method === "POST" && authorizationRoute.action === "transfer") {
          const body = ownershipTransferRequest(
            await readJsonBody(request, this.limits.dashboard.maxHttpBodyBytes),
          );
          assertMutationHeaders(request, body);
          assertAuthorizationIfMatch(request, policy, body.expectedRevision);
          requireKnownDashboardIdentity(this.auth, body.newOwnerIdentityId);
          const previousOwnerIdentityId = policy.ownerIdentityId;
          const updated = await this.authorization.authorization.transferOwnership({
            principal: session.principal,
            resource,
            newOwnerIdentityId: body.newOwnerIdentityId,
            ...(body.previousOwnerRole === undefined
              ? {}
              : { previousOwnerRole: body.previousOwnerRole }),
            expectedRevision: body.expectedRevision,
            idempotencyKey: body.idempotencyKey,
          });
          const previousRole = policyRoleForIdentity(updated, previousOwnerIdentityId);
          await this.controllerCoordinator.applyIdentityRole(
            resource,
            previousOwnerIdentityId,
            previousRole,
          );
          if (resource.kind === "workspace" && previousRole === undefined) {
            for (const sessionKey of this.auth.revokeIdentityWorkspace(
              previousOwnerIdentityId,
              resource.id,
            )) {
              this.#closeSessionPeers(sessionKey, 1008, "workspace ownership transferred");
            }
          }
          sendJson(
            response,
            200,
            successEnvelopeFrom(context, { policy: updated, role: "admin" as const }),
            this.limits.dashboard.maxOutboundBytesPerConnection,
            { ETag: dashboardAuthorizationEtag(updated) },
          );
          return;
        }
        if (request.method === "POST" && authorizationRoute.action === "controller") {
          const body = controllerTransferRequest(
            await readJsonBody(request, this.limits.dashboard.maxHttpBodyBytes),
          );
          assertMutationHeaders(request, body);
          assertAuthorizationIfMatch(request, policy, body.expectedRevision);
          if (
            requiredHeader(request.headers["x-controller-if-match"], "X-Controller-If-Match") !==
            dashboardControllerEtag(resource, body.expectedControllerRevision)
          ) {
            throw new DashboardAuthorizationError(
              "controller_revision_conflict",
              "controller revision no longer matches",
              409,
            );
          }
          const targetPrincipal = requireKnownDashboardIdentity(this.auth, body.targetIdentityId);
          const targetRole = targetPrincipal.globalRole === "administrator"
            ? "admin"
            : policyRoleForIdentity(policy, body.targetIdentityId);
          if (targetRole === undefined || !authorizationRoleAtLeast(targetRole, "control")) {
            throw new DashboardAuthorizationError(
              "controller_target_unauthorized",
              "controller transfer target lacks control authority",
              409,
            );
          }
          const transferred = await this.#transferController(
            session,
            resource,
            policy,
            body,
          );
          sendJson(
            response,
            200,
            successEnvelopeFrom(context, transferred),
            this.limits.dashboard.maxOutboundBytesPerConnection,
            {
              ETag: dashboardAuthorizationEtag(transferred.policy),
              "X-Controller-ETag": dashboardControllerEtag(
                resource,
                transferred.controller.revision,
              ),
            },
          );
          return;
        }
      }

      if (request.method === "GET" && url.pathname === `${DASH_API_BASE_PATH}/bootstrap`) {
        const settings = await this.settingsStore.get();
        await this.authorization.require(
          session.principal,
          workspaceResource(session.workspaceId),
          "read",
        );
        const [capabilities, workspace, inventory] = await Promise.all([
          this.capabilities(),
          this.workspaceStore.getOrCreate(session.workspaceId),
          this.authorization.listSessions(session.principal, {
            limit: settings.effective.sidebar.initialLimit,
          }),
        ]);
        const resumed = this.auth.browserSession(session);
        sendJson(
          response,
          200,
          successEnvelopeFrom(context, {
            capabilities,
            settings,
            workspace,
            inventory,
            identity: session.principal,
          }),
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
        await this.authorization.registerCreated(session.principal, "draft", draft.draftId);
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
        const page = await this.authorization.listSessions(
          session.principal,
          inventoryQuery(url, this.limits.dashboard),
        );
        sendJson(response, 200, successEnvelopeFrom(context, page), this.limits.dashboard.maxOutboundBytesPerConnection);
        return;
      }

      const draftSendTicketMatch = matchPath(
        url.pathname,
        `${DASH_API_BASE_PATH}/session-draft-send/`,
        "",
      );
      if (request.method === "GET" && draftSendTicketMatch !== undefined) {
        await this.authorization.require(
          session.principal,
          draftTicketResource(draftSendTicketMatch),
          "read",
        );
        const ticket = await this.backend.getSessionDraftSend(draftSendTicketMatch);
        if (ticket.session !== undefined) {
          await this.authorization.registerCreated(
            session.principal,
            "session",
            managedSessionRef(ticket.session.sessionId).id,
          );
        }
        sendJson(response, 200, successEnvelopeFrom(context, ticket), this.limits.dashboard.maxOutboundBytesPerConnection);
        return;
      }
      const draftMatch = matchPath(url.pathname, `${DASH_API_BASE_PATH}/session-drafts/`, "");
      if (request.method === "GET" && draftMatch !== undefined) {
        await this.authorization.require(
          session.principal,
          draftResource(draftMatch),
          "read",
        );
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
        await this.authorization.require(
          session.principal,
          draftResource(draftSendMatch),
          "control",
        );
        const body = validateDashboardSessionDraftSendRequest(
          await readJsonBody(request, this.limits.dashboard.maxHttpBodyBytes),
        );
        assertMutationHeaders(request, body);
        assertDashboardDraftIfMatch(request, draftSendMatch, body.expectedRevision);
        const ticket = await this.backend.sendSessionDraft(draftSendMatch, body);
        await this.authorization.registerCreated(
          session.principal,
          "draft-ticket",
          ticket.ticketId,
        );
        if (ticket.session !== undefined) {
          await this.authorization.registerCreated(
            session.principal,
            "session",
            managedSessionRef(ticket.session.sessionId).id,
          );
        }
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
        await this.authorization.require(
          session.principal,
          draftResource(draftMatch),
          "control",
        );
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
        const { info } = await this.authorization.requireInventorySession(
          session.principal,
          sessionMatch,
          "read",
        );
        sendJson(response, 200, successEnvelopeFrom(context, info), this.limits.dashboard.maxOutboundBytesPerConnection);
        return;
      }
      const transcriptMatch = matchPath(url.pathname, `${DASH_API_BASE_PATH}/sessions/`, "/transcript");
      if (request.method === "GET" && transcriptMatch !== undefined) {
        await this.authorization.requireInventorySession(
          session.principal,
          transcriptMatch,
          "read",
        );
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
        const activation = activationRequest(body);
        await this.authorization.requireInventorySession(
          session.principal,
          activateMatch,
          activation.mode === "preview-only"
            ? "read"
            : activation.mode === "reuse"
              ? "control"
              : "admin",
        );
        const ticket = await this.backend.activateSession(activateMatch, activation);
        await this.authorization.registerCreated(
          session.principal,
          "activation-ticket",
          ticket.ticketId,
        );
        if (
          ticket.managedSession !== undefined &&
          (ticket.mode === "direct" || ticket.mode === "fork")
        ) {
          await this.authorization.registerCreated(
            session.principal,
            "session",
            managedSessionRef(ticket.managedSession.sessionId).id,
          );
        }
        sendJson(response, 202, successEnvelopeFrom(context, ticket), this.limits.dashboard.maxOutboundBytesPerConnection);
        return;
      }
      const activationMatch = matchPath(url.pathname, `${DASH_API_BASE_PATH}/activation/`, "");
      if (request.method === "GET" && activationMatch !== undefined) {
        await this.authorization.require(
          session.principal,
          activationTicketResource(activationMatch),
          "read",
        );
        const ticket = await this.backend.getActivation(activationMatch);
        if (
          ticket.managedSession !== undefined &&
          (ticket.mode === "direct" || ticket.mode === "fork")
        ) {
          await this.authorization.registerCreated(
            session.principal,
            "session",
            managedSessionRef(ticket.managedSession.sessionId).id,
          );
        }
        sendJson(response, 200, successEnvelopeFrom(context, ticket), this.limits.dashboard.maxOutboundBytesPerConnection);
        return;
      }
      const exportMatch = matchPath(url.pathname, `${DASH_API_BASE_PATH}/sessions/`, "/export");
      if (request.method === "POST" && exportMatch !== undefined) {
        await this.authorization.requireManagedSession(
          session.principal,
          exportMatch,
          "admin",
        );
        const body = await readJsonBody(request, this.limits.dashboard.maxHttpBodyBytes);
        const ticket = await this.backend.exportSession(exportMatch, exportRequest(body));
        await this.authorization.registerCreated(
          session.principal,
          "export-ticket",
          ticket.ticketId,
        );
        if (ticket.exportedInventoryId !== undefined) {
          await this.authorization.registerInventorySessionIfPresent(
            session.principal,
            ticket.exportedInventoryId,
          );
        }
        sendJson(response, 202, successEnvelopeFrom(context, ticket), this.limits.dashboard.maxOutboundBytesPerConnection);
        return;
      }
      const exportTicketMatch = matchPath(url.pathname, `${DASH_API_BASE_PATH}/export/`, "");
      if (request.method === "GET" && exportTicketMatch !== undefined) {
        await this.authorization.require(
          session.principal,
          exportTicketResource(exportTicketMatch),
          "read",
        );
        const ticket = await this.backend.getExport(exportTicketMatch);
        if (ticket.exportedInventoryId !== undefined) {
          await this.authorization.registerInventorySessionIfPresent(
            session.principal,
            ticket.exportedInventoryId,
          );
        }
        sendJson(response, 200, successEnvelopeFrom(context, ticket), this.limits.dashboard.maxOutboundBytesPerConnection);
        return;
      }

      if (request.method === "GET" && url.pathname === `${DASH_API_BASE_PATH}/schedules/capabilities`) {
        const capabilities = await this.backend.scheduleCapabilities();
        sendJson(response, 200, successEnvelopeFrom(context, capabilities), this.limits.dashboard.maxOutboundBytesPerConnection);
        return;
      }
      if (request.method === "GET" && url.pathname === `${DASH_API_BASE_PATH}/schedules/status`) {
        requireGlobalAdministrator(session);
        const status = await this.backend.scheduleStatus();
        sendJson(response, 200, successEnvelopeFrom(context, status), this.limits.dashboard.maxOutboundBytesPerConnection);
        return;
      }
      if (url.pathname === `${DASH_API_BASE_PATH}/schedules`) {
        if (request.method === "GET") {
          const sessionRef = scheduleListQuery(url);
          if (sessionRef !== undefined) {
            await this.authorization.requireManagedSession(
              session.principal,
              sessionRef,
              "control",
            );
          }
          const candidates = (await this.backend.listSchedules(sessionRef)).map(contentSafeSchedule);
          const decisions = await Promise.all(
            candidates.map(async (candidate) => ({
              candidate,
              role: await this.authorization.effectiveRole(
                session.principal,
                scheduleResource(candidate.scheduleId),
              ),
            })),
          );
          const schedules = decisions
            .filter(({ role }) => role !== undefined && authorizationRoleAtLeast(role, "control"))
            .map(({ candidate }) => candidate);
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
          await this.authorization.requireManagedSession(
            session.principal,
            body.schedule.sessionRef,
            "admin",
          );
          const resource = contentSafeSchedule(await this.backend.createSchedule(body));
          await this.authorization.registerCreated(
            session.principal,
            "schedule",
            resource.scheduleId,
          );
          sendJson(response, 201, successEnvelopeFrom(context, resource), this.limits.dashboard.maxOutboundBytesPerConnection, {
            ETag: scheduleEtag(resource.scheduleId, resource.revision),
          });
          return;
        }
      }
      const scheduleMatch = matchPath(url.pathname, `${DASH_API_BASE_PATH}/schedules/`, "");
      if (scheduleMatch !== undefined) {
        if (request.method === "GET") {
          await this.authorization.require(
            session.principal,
            scheduleResource(scheduleMatch),
            "control",
          );
          const resource = contentSafeSchedule(await this.backend.getSchedule(scheduleMatch));
          sendJson(response, 200, successEnvelopeFrom(context, resource), this.limits.dashboard.maxOutboundBytesPerConnection, {
            ETag: scheduleEtag(resource.scheduleId, resource.revision),
          });
          return;
        }
        if (request.method === "PUT") {
          await this.authorization.require(
            session.principal,
            scheduleResource(scheduleMatch),
            "admin",
          );
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
          await this.authorization.require(
            session.principal,
            scheduleResource(scheduleMatch),
            "admin",
          );
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
          await this.authorization.require(
            session.principal,
            workspaceResource(workspaceMatch),
            "read",
          );
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
          await this.authorization.require(
            session.principal,
            workspaceResource(workspaceMatch),
            "control",
          );
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

      if (url.pathname === `${DASH_API_BASE_PATH}/diagnostics`) {
        if (request.method === "GET") {
          requireGlobalAdministrator(session);
          const capabilities = await this.backend.capabilities();
          if (capabilities.resources.diagnostics !== true) {
            throw new DashboardServerError(501, "diagnostics_unavailable", "dashboard diagnostics are unavailable");
          }
          sendJson(
            response,
            200,
            successEnvelopeFrom(context, await this.backend.diagnostics()),
            this.limits.dashboard.maxOutboundBytesPerConnection,
            { "Cache-Control": "no-store" },
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
          requireGlobalAdministrator(session);
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
          requireGlobalAdministrator(session);
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
      if (session?.principal.globalRole === "administrator") {
        this.backend.recordDiagnosticFailure?.({
          method: request.method,
          path: diagnosticPath,
          status: safe.status,
          code: safe.body.code,
        });
      }
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

  #transferController(
    session: DashboardAuthenticatedSession,
    resource: DashboardResourceRef,
    policy: DashboardResourcePolicy,
    request: DashboardControllerTransferRequest,
  ): Promise<{
    policy: DashboardResourcePolicy;
    controller: ReturnType<DashboardControllerCoordinator["state"]>;
  }> {
    const key = `${session.principal.identityId}\u0000${request.idempotencyKey}`;
    const fingerprint = createHash("sha256").update(JSON.stringify({
      resource,
      request,
    }), "utf8").digest("base64url");
    const retained = this.#controllerTransfers.get(key);
    if (retained !== undefined) {
      if (retained.fingerprint !== fingerprint) {
        return Promise.reject(new DashboardAuthorizationError(
          "idempotency_conflict",
          "idempotency key was already used for another controller transfer",
          409,
        ));
      }
      return retained.promise;
    }
    const promise = (async () => {
      const transferred = await this.controllerCoordinator.transfer({
        resource,
        targetIdentityId: request.targetIdentityId,
        ...(request.targetParticipantId === undefined
          ? {}
          : { targetParticipantId: request.targetParticipantId }),
        expectedRevision: request.expectedControllerRevision,
        correlationId: request.requestId,
      });
      let recorded: DashboardResourcePolicy;
      try {
        recorded = await this.authorization.authorization.recordControllerTransfer({
          principal: session.principal,
          resource,
          ...(transferred.previousControllerIdentityId === undefined
            ? {}
            : { previousControllerIdentityId: transferred.previousControllerIdentityId }),
          newControllerIdentityId: request.targetIdentityId,
          expectedRevision: policy.revision,
          idempotencyKey: request.idempotencyKey,
        });
      } catch {
        throw new DashboardAuthorizationError(
          "controller_transfer_indeterminate",
          "controller transfer completed but its durable audit outcome is indeterminate",
          500,
        );
      }
      return { policy: recorded, controller: transferred.state };
    })();
    while (this.#controllerTransfers.size >= MAX_CONTROLLER_TRANSFER_RECEIPTS) {
      const oldest = this.#controllerTransfers.keys().next().value;
      if (oldest === undefined) break;
      this.#controllerTransfers.delete(oldest);
    }
    this.#controllerTransfers.set(key, { fingerprint, promise });
    return promise;
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
      await this.authorization.require(
        session.principal,
        workspaceResource(session.workspaceId),
        "read",
      );
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
        Promise.resolve(this.#streamHandler({
          session,
          revalidateSession: () => this.auth.revalidate(session),
          peer,
        })).catch(() => {
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
    this.#assertForwardedHeaders(request);
  }

  #assertForwardedHeaders(request: IncomingMessage): void {
    const forwarded = request.headers.forwarded;
    const forwardedHost = request.headers["x-forwarded-host"];
    const forwardedProto = request.headers["x-forwarded-proto"];
    const forwardedPort = request.headers["x-forwarded-port"];
    const anyForwarded =
      forwarded !== undefined ||
      forwardedHost !== undefined ||
      forwardedProto !== undefined ||
      forwardedPort !== undefined;
    if (!anyForwarded) return;
    if (!this.#trustForwardedHeaders || forwarded !== undefined) {
      throw new DashboardServerError(403, "proxy_headers_rejected", "dashboard proxy headers are not trusted");
    }
    if (!isLoopbackAddress(request.socket.remoteAddress)) {
      throw new DashboardServerError(403, "proxy_headers_rejected", "dashboard proxy headers require a loopback peer");
    }
    const origin = new URL(this.#origin!);
    const expectedPort = origin.port || (origin.protocol === "https:" ? "443" : "80");
    if (
      (forwardedHost !== undefined && singleHeader(forwardedHost) !== origin.host) ||
      (forwardedProto !== undefined && singleHeader(forwardedProto) !== origin.protocol.slice(0, -1)) ||
      (forwardedPort !== undefined && singleHeader(forwardedPort) !== expectedPort)
    ) {
      throw new DashboardServerError(403, "proxy_headers_rejected", "dashboard proxy headers do not match publicOrigin");
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
  const configuredWeb = options.loadedConfig.config.web;
  const web = mergeWebConfig({
    ...configuredWeb,
    ...options.webOverrides,
    tls: {
      ...configuredWeb?.tls,
      ...options.webOverrides?.tls,
    },
    proxy: {
      ...configuredWeb?.proxy,
      ...options.webOverrides?.proxy,
    },
    auth: options.webOverrides?.auth?.identityProviderFile !== undefined
      ? {
          ...(configuredWeb?.auth?.sessionTtlMs === undefined
            ? {}
            : { sessionTtlMs: configuredWeb.auth.sessionTtlMs }),
          ...options.webOverrides.auth,
        }
      : {
          ...configuredWeb?.auth,
          ...options.webOverrides?.auth,
        },
  });
  if (web.enabled === false) throw new Error("dashboard web server is disabled");
  const authSourceCount = [
    web.auth.tokenFile,
    web.auth.identityProvider,
    web.auth.identityProviderFile,
  ].filter((source) => source !== undefined).length;
  if (authSourceCount > 1) {
    throw new Error("dashboard authentication sources are mutually exclusive");
  }
  const provider = web.auth.identityProviderFile !== undefined
    ? await loadDashboardIdentityProviderFile(
        options.loadedConfig.resolvePath(web.auth.identityProviderFile),
      )
    : web.auth.identityProvider === undefined
      ? undefined
      : await createDashboardIdentityProvider(
          web.auth.identityProvider,
          options.loadedConfig.resolvePath,
        );
  const tokenPath = provider !== undefined
    ? undefined
    : web.auth.tokenFile === undefined
      ? join(options.stateDir, "web-token")
      : options.loadedConfig.resolvePath(web.auth.tokenFile);
  if (tokenPath !== undefined) await ensureDashboardCredentialFile(tokenPath);
  const publicOrigin = options.publicOrigin ?? web.publicOrigin;
  const tlsSource: DashboardTlsSourceConfig = {
    ...(web.tls.certFile === undefined
      ? {}
      : { certFile: options.loadedConfig.resolvePath(web.tls.certFile) }),
    ...(web.tls.certFd === undefined ? {} : { certFd: web.tls.certFd }),
    ...(web.tls.keyFile === undefined
      ? {}
      : { keyFile: options.loadedConfig.resolvePath(web.tls.keyFile) }),
    ...(web.tls.keyFd === undefined ? {} : { keyFd: web.tls.keyFd }),
    ...(web.tls.reloadIntervalMs === undefined
      ? {}
      : { reloadIntervalMs: web.tls.reloadIntervalMs }),
  };
  const tls = await loadDashboardTls(tlsSource);
  const browserAuthOptions = {
    sessionTtlMs: web.auth.sessionTtlMs,
    secureCookies: publicOrigin?.startsWith("https://") ?? false,
  };
  const auth = provider === undefined
    ? await DashboardBrowserAuth.fromTokenFile(tokenPath!, browserAuthOptions)
    : new DashboardBrowserAuth({
        ...browserAuthOptions,
        identityProvider: provider,
        workspaceIdForPrincipal: (principal) => identityWorkspaceId(principal.identityId),
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
  const authorizationService = new DashboardAuthorizationService({
    stateDir: options.stateDir,
    mode: provider === undefined ? "single-owner" : "multi-user",
  });
  const authorization = new DashboardAuthorizationEnforcer({
    backend: options.backend,
    authorization: authorizationService,
    maxInventoryPageItems: dashboardLimits.maxInventoryPageItems,
    cursorTtlMs: auth.sessionTtlMs,
  });
  if (options.streamHandler !== undefined && options.streamHandlerFactory !== undefined) {
    throw new Error("configure either streamHandler or streamHandlerFactory, not both");
  }
  const controllerCoordinator = new DashboardControllerCoordinator();
  const serverInstanceId = options.serverInstanceId ?? `dash-${randomUUID()}`;
  const streamHandler = options.streamHandler ?? options.streamHandlerFactory?.({
    backend: options.backend,
    authorization,
    controllerCoordinator,
    serverInstanceId,
    limits: dashboardLimits,
  });
  return new DashboardServer({
    backend: options.backend,
    auth,
    workspaceStore,
    settingsStore,
    authorization,
    controllerCoordinator,
    ...(options.assetsDir === undefined ? {} : { assetsDir: options.assetsDir }),
    host: web.bind,
    port: web.port,
    ...(publicOrigin === undefined ? {} : { publicOrigin }),
    allowInsecureHttp: web.allowInsecureHttp,
    trustForwardedHeaders: web.proxy.trustForwardedHeaders,
    ...(tls === undefined ? {} : { tls }),
    serverInstanceId,
    limits: dashboardLimits,
    ...(streamHandler === undefined ? {} : { streamHandler }),
  });
}

function mergeWebConfig(config: PiDaemonWebConfig | undefined): {
  enabled: boolean;
  bind: string;
  port: number;
  publicOrigin?: string;
  allowInsecureHttp: boolean;
  tls: DashboardTlsSourceConfig;
  proxy: { trustForwardedHeaders: boolean };
  auth: {
    tokenFile?: string;
    identityProvider?: import("./config.js").PiDaemonWebIdentityProviderConfig;
    identityProviderFile?: string;
    sessionTtlMs: number;
  };
  inventory: { roots: string[]; reconcileIntervalMs: number; maxSessions: number };
  residency: { warmTtlMs: number; maxPinnedPerWorkspace: number };
  tui: { enabled: boolean; defaultPresentation: "rich" | "tui"; maxRows: number; maxColumns: number };
  ui: Readonly<Record<string, import("./config.js").ConfigJson>>;
} {
  return {
    enabled: config?.enabled ?? DEFAULT_PI_DAEMON_WEB_CONFIG.enabled,
    bind: config?.bind ?? DEFAULT_PI_DAEMON_WEB_CONFIG.bind,
    port: config?.port ?? DEFAULT_PI_DAEMON_WEB_CONFIG.port,
    ...(config?.publicOrigin === undefined ? {} : { publicOrigin: config.publicOrigin }),
    allowInsecureHttp:
      config?.allowInsecureHttp ?? DEFAULT_PI_DAEMON_WEB_CONFIG.allowInsecureHttp,
    tls: {
      ...(config?.tls?.certFile === undefined ? {} : { certFile: config.tls.certFile }),
      ...(config?.tls?.certFd === undefined ? {} : { certFd: config.tls.certFd }),
      ...(config?.tls?.keyFile === undefined ? {} : { keyFile: config.tls.keyFile }),
      ...(config?.tls?.keyFd === undefined ? {} : { keyFd: config.tls.keyFd }),
      ...(config?.tls?.reloadIntervalMs === undefined
        ? {}
        : { reloadIntervalMs: config.tls.reloadIntervalMs }),
    },
    proxy: {
      trustForwardedHeaders:
        config?.proxy?.trustForwardedHeaders ??
        DEFAULT_PI_DAEMON_WEB_CONFIG.proxy.trustForwardedHeaders,
    },
    auth: {
      ...(config?.auth?.tokenFile === undefined ? {} : { tokenFile: config.auth.tokenFile }),
      ...(config?.auth?.identityProvider === undefined
        ? {}
        : { identityProvider: config.auth.identityProvider }),
      ...(config?.auth?.identityProviderFile === undefined
        ? {}
        : { identityProviderFile: config.auth.identityProviderFile }),
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

interface DashboardAuthorizationRoute {
  kind: "session" | "workspace";
  resourceId: string;
  action: "policy" | "grant" | "transfer" | "audit" | "controller";
  subjectIdentityId?: string;
}

function matchAuthorizationRoute(pathname: string): DashboardAuthorizationRoute | undefined {
  const prefix = `${DASH_API_BASE_PATH}/authorization/`;
  if (!pathname.startsWith(prefix)) return undefined;
  const raw = pathname.slice(prefix.length).split("/");
  if (raw[0] !== "session" && raw[0] !== "workspace") return undefined;
  try {
    const resourceId = safeId(decodeURIComponent(raw[1] ?? ""), "resourceId");
    if (raw.length === 2) return { kind: raw[0], resourceId, action: "policy" };
    if (raw.length === 3 && ["transfer", "audit", "controller"].includes(raw[2]!)) {
      return { kind: raw[0], resourceId, action: raw[2] as "transfer" | "audit" | "controller" };
    }
    if (raw.length === 4 && raw[2] === "grants") {
      return {
        kind: raw[0],
        resourceId,
        action: "grant",
        subjectIdentityId: safeId(decodeURIComponent(raw[3]!), "subjectIdentityId"),
      };
    }
  } catch (error) {
    if (error instanceof DashboardServerError) throw error;
  }
  return undefined;
}

function authorizationMutationRequest(value: unknown): DashboardAuthorizationMutationRequest {
  const object = requestObject(value, "authorization mutation request");
  exactRequestKeys(object, ["requestId", "idempotencyKey", "expectedRevision"]);
  return {
    requestId: requiredId(object.requestId, "requestId"),
    idempotencyKey: requiredId(object.idempotencyKey, "idempotencyKey"),
    expectedRevision: positiveRevision(object.expectedRevision, "expectedRevision"),
  };
}

function grantSetRequest(value: unknown): DashboardGrantSetRequest {
  const object = requestObject(value, "grant mutation request");
  exactRequestKeys(object, ["requestId", "idempotencyKey", "expectedRevision", "role"]);
  if (object.role !== "read" && object.role !== "control" && object.role !== "admin") {
    throw new DashboardServerError(400, "invalid_request", "authorization role is invalid");
  }
  return {
    ...authorizationMutationRequest({
      requestId: object.requestId,
      idempotencyKey: object.idempotencyKey,
      expectedRevision: object.expectedRevision,
    }),
    role: object.role,
  };
}

function ownershipTransferRequest(value: unknown): DashboardOwnershipTransferRequest {
  const object = requestObject(value, "ownership transfer request");
  exactRequestKeys(object, [
    "requestId",
    "idempotencyKey",
    "expectedRevision",
    "newOwnerIdentityId",
    "previousOwnerRole",
  ], ["previousOwnerRole"]);
  if (
    object.previousOwnerRole !== undefined &&
    object.previousOwnerRole !== "read" &&
    object.previousOwnerRole !== "control" &&
    object.previousOwnerRole !== "admin"
  ) {
    throw new DashboardServerError(400, "invalid_request", "previous owner role is invalid");
  }
  return {
    ...authorizationMutationRequest({
      requestId: object.requestId,
      idempotencyKey: object.idempotencyKey,
      expectedRevision: object.expectedRevision,
    }),
    newOwnerIdentityId: requiredId(object.newOwnerIdentityId, "newOwnerIdentityId"),
    ...(object.previousOwnerRole === undefined
      ? {}
      : { previousOwnerRole: object.previousOwnerRole }),
  };
}

function controllerTransferRequest(value: unknown): DashboardControllerTransferRequest {
  const object = requestObject(value, "controller transfer request");
  exactRequestKeys(object, [
    "requestId",
    "idempotencyKey",
    "expectedRevision",
    "expectedControllerRevision",
    "targetIdentityId",
    "targetParticipantId",
  ], ["targetParticipantId"]);
  return {
    ...authorizationMutationRequest({
      requestId: object.requestId,
      idempotencyKey: object.idempotencyKey,
      expectedRevision: object.expectedRevision,
    }),
    expectedControllerRevision: nonNegativeRevision(
      object.expectedControllerRevision,
      "expectedControllerRevision",
    ),
    targetIdentityId: requiredId(object.targetIdentityId, "targetIdentityId"),
    ...(object.targetParticipantId === undefined
      ? {}
      : { targetParticipantId: requiredId(object.targetParticipantId, "targetParticipantId") }),
  };
}

function workspaceSelectionRequest(value: unknown): DashboardWorkspaceSelectionRequest {
  const object = requestObject(value, "workspace selection request");
  exactRequestKeys(object, ["requestId", "workspaceId"]);
  return {
    requestId: requiredId(object.requestId, "requestId"),
    workspaceId: requiredId(object.workspaceId, "workspaceId"),
  };
}

function positiveRevision(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new DashboardServerError(400, "invalid_request", `${name} is invalid`);
  }
  return value as number;
}

function nonNegativeRevision(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new DashboardServerError(400, "invalid_request", `${name} is invalid`);
  }
  return value as number;
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
  if (error instanceof DashboardAuthorizationError) {
    return {
      status: error.status,
      body: { code: error.code, message: error.message, retryable: false },
    };
  }
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

function identityWorkspaceId(identityId: string): string {
  const digest = createHash("sha256")
    .update("dashboard-workspace-v1\0", "utf8")
    .update(identityId, "utf8")
    .digest("base64url");
  return `workspace-${digest.slice(0, 32)}`;
}

function requireGlobalAdministrator(session: DashboardAuthenticatedSession): void {
  if (session.principal.globalRole !== "administrator") {
    throw new DashboardServerError(403, "forbidden", "dashboard administrator role is required");
  }
}

function requireKnownDashboardIdentity(
  auth: DashboardBrowserAuth,
  identityId: string,
): NonNullable<ReturnType<DashboardBrowserAuth["principal"]>> {
  const principal = auth.principal(identityId);
  if (principal === undefined) {
    throw new DashboardAuthorizationError(
      "authorization_target_invalid",
      "authorization target is unavailable",
      409,
    );
  }
  return principal;
}

function policyRoleForIdentity(
  policy: DashboardResourcePolicy,
  identityId: string,
): DashboardResourceRole | undefined {
  if (policy.ownerIdentityId === identityId) return "admin";
  return policy.grants.find((grant) => grant.identityId === identityId)?.role;
}

function authorizationRoleAtLeast(
  actual: DashboardResourceRole,
  required: DashboardResourceRole,
): boolean {
  const rank = { read: 1, control: 2, admin: 3 } as const;
  return rank[actual] >= rank[required];
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

function assertAuthorizationIfMatch(
  request: IncomingMessage,
  policy: DashboardResourcePolicy,
  expectedRevision: number,
): void {
  if (
    requiredHeader(request.headers["if-match"], "If-Match") !==
    dashboardAuthorizationEtag({ ...policy, revision: expectedRevision })
  ) {
    throw new DashboardAuthorizationError(
      "authorization_revision_conflict",
      "authorization policy revision no longer matches",
      409,
    );
  }
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

function optionalNonNegativeQueryInteger(url: URL, name: string): number | undefined {
  const value = singleQueryValue(url, name);
  if (value === null) return undefined;
  if (!/^\d+$/.test(value)) throw invalidQuery();
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw invalidQuery();
  return parsed;
}

function optionalPositiveQueryInteger(url: URL, name: string, max: number): number | undefined {
  return optionalQueryInteger(singleQueryValue(url, name), max);
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

function singleHeader(value: string | string[]): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 1024 ||
    value.includes(",") ||
    value.trim() !== value
  ) {
    throw new DashboardServerError(403, "proxy_headers_rejected", "dashboard proxy header is invalid");
  }
  return value;
}

function sniMatchesOrigin(servername: string, publicOrigin: string): boolean {
  const expected = new URL(publicOrigin).hostname.toLowerCase().replace(/\.$/u, "");
  const actual = servername.toLowerCase().replace(/\.$/u, "");
  return actual === expected;
}

function isLoopbackOrigin(origin: string): boolean {
  return isLoopbackBind(new URL(origin).hostname);
}

function isLoopbackAddress(address: string | undefined): boolean {
  if (address === undefined) return false;
  return isLoopbackBind(address.startsWith("::ffff:") ? address.slice(7) : address);
}

function isLoopbackBind(host: string): boolean {
  if (host.toLowerCase() === "localhost") return true;
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
