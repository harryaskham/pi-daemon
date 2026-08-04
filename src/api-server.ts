import { createHash, randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { isIP } from "node:net";
import type { Duplex } from "node:stream";
import { pipeline } from "node:stream/promises";

import {
  ACP_WEBSOCKET_SUBPROTOCOL,
  AcpAdapterError,
  AcpAdapterManager,
  type AcpAdapterLimits,
} from "./acp-adapter.js";
import { ServiceBearerAuthenticator } from "./api-auth.js";
import {
  BlobStoreError,
  FileBlobStore,
  blobIdForScope,
  contentReadStream,
  fileIdForScope,
  type BlobTransferResource,
  type SessionUploadResource,
} from "./blob-store.js";
import {
  ApiRequestError,
  apiInteger,
  apiOptionalString,
  apiRecord,
  apiString,
  assertMatchingRequestId,
  readBoundedJson,
} from "./api-request-contract.js";
import {
  dashboardPathRef,
  dashboardRouteRequest,
  isDashboardRoutePath,
  routeDashboardRequest,
} from "./api-dashboard-routes.js";
import type { DashboardNeutralApi } from "./dashboard-neutral-api.js";

/**
 * Retained public re-export: `readBoundedJson` was part of this module's
 * exported surface before the neutral Dash routing extraction (bd-23110a) moved
 * it into the shared request contract.
 */
export { readBoundedJson } from "./api-request-contract.js";
import {
  DashboardTuiAttachmentError,
  dashboardTuiUpgradeHeaders,
  type DashboardTuiAttachmentManager,
} from "./dashboard-tui-attachments.js";
import { Multiplexer, MultiplexerError } from "./multiplexer.js";
import {
  ProtocolSerializationError,
  encodeBoundedLine,
  type ProtocolCommand,
} from "./protocol.js";
import {
  DASHBOARD_TUI_SUBPROTOCOL,
  SESSION_API_VERSION,
  type ApiErrorBody,
  type SessionEnvironmentSummary,
  type TicketResource,
} from "./session-api.js";
import {
  SessionConfigurationError,
  parseSessionConfiguration,
  requireProvisionedEnvironment,
  sessionOpenPayloadFromSpec,
  type PreparedSessionConfiguration,
  type PreparedSessionRuntimeOptions,
} from "./session-config.js";
import { catalogRecordToSessionResource } from "./session-catalog.js";
import {
  scheduleCapabilities,
  ScheduleValidationError,
  type ScheduleResource,
} from "./schedule-contract.js";
import type { SchedulerRuntime } from "./scheduler-runtime.js";
import {
  FileScheduleStore,
  ScheduleStoreError,
  type ScheduleDefinition,
} from "./schedule-store.js";
import {
  RpcAttachmentError,
  RpcAttachmentManager,
  type RpcAttachmentLimits,
} from "./rpc-attachments.js";
import { WebSocketHandshakeError } from "./websocket.js";
import {
  MutationTicketController,
  TicketStoreError,
  mutationTicketResource,
  type MutationTicketCommand,
  type MutationTicketRecord,
  type MutationTicketRecovery,
} from "./tickets.js";

export interface ApiServerLimits {
  maxConnections: number;
  maxBodyBytes: number;
  maxHeaderBytes: number;
  requestTimeoutMs: number;
}

export const DEFAULT_API_RESPONSE_BYTES = 2 * 1024 * 1024;

export const DEFAULT_API_SERVER_LIMITS: Readonly<ApiServerLimits> = {
  maxConnections: 64,
  maxBodyBytes: 1024 * 1024,
  maxHeaderBytes: 32 * 1024,
  requestTimeoutMs: 30_000,
};

export interface ApiServerOptions {
  multiplexer: Multiplexer;
  authenticator: ServiceBearerAuthenticator;
  tickets?: MutationTicketController;
  host?: string;
  port?: number;
  allowInsecureRemote?: boolean;
  limits?: Partial<ApiServerLimits>;
  rpcLimits?: Partial<RpcAttachmentLimits>;
  rpcAttachments?: RpcAttachmentManager;
  acpLimits?: Partial<AcpAdapterLimits>;
  acpAdapters?: AcpAdapterManager;
  dashboardApi?: DashboardNeutralApi;
  dashboardTuiAttachments?: DashboardTuiAttachmentManager;
  /** Durable neutral schedules and, when configured, their native timer owner. */
  schedules?: FileScheduleStore;
  scheduler?: Pick<SchedulerRuntime, "recompute" | "status">;
  /** Owner-private opaque blob reservations and daemon-owned session upload references. */
  blobs?: FileBlobStore;
}

export interface ApiServerAddress {
  host: string;
  port: number;
}

interface MutationSubmission {
  ticket: MutationTicketRecord;
  responseRequestId: string;
}

interface ReconciliationSubmission {
  resource: TicketResource;
  responseRequestId: string;
}

/**
 * Bearer-authenticated HTTP/WebSocket admission boundary for the additive API.
 * Retained session reads share the durable catalog, mutations use durable
 * tickets, and Pi RPC upgrades use bounded multi-reader attachment hubs. This
 * class owns secure admission, capability negotiation, bounded bodies, and
 * fail-closed WebSocket routing; ACP remains an additive downstream adapter.
 */
export class ApiServer {
  readonly host: string;
  readonly port: number;
  readonly limits: ApiServerLimits;
  readonly #multiplexer: Multiplexer;
  readonly #authenticator: ServiceBearerAuthenticator;
  readonly #tickets: MutationTicketController | undefined;
  readonly #rpcAttachments: RpcAttachmentManager;
  readonly #acpAdapters: AcpAdapterManager;
  readonly #dashboardApi: DashboardNeutralApi | undefined;
  readonly #dashboardTuiAttachments: DashboardTuiAttachmentManager | undefined;
  readonly #schedules: FileScheduleStore | undefined;
  readonly #scheduler: ApiServerOptions["scheduler"];
  readonly #blobs: FileBlobStore | undefined;
  readonly #scheduleMutations = new Map<string, { fingerprint: string; status: number; data?: ScheduleResource }>();
  readonly #server: Server;
  readonly #upgradeSockets = new Set<Duplex>();
  #started = false;
  #ticketRecovery: MutationTicketRecovery | undefined;
  #indeterminateMutationTickets = 0;

  constructor(options: ApiServerOptions) {
    this.host = options.host ?? "127.0.0.1";
    this.port = portNumber(options.port ?? 7463);
    if (!isLoopbackBind(this.host) && options.allowInsecureRemote !== true) {
      throw new Error(
        "non-loopback plaintext API bind requires allowInsecureRemote; prefer a loopback TLS reverse proxy",
      );
    }
    this.#multiplexer = options.multiplexer;
    this.#authenticator = options.authenticator;
    this.#tickets = options.tickets;
    this.#rpcAttachments =
      options.rpcAttachments ?? new RpcAttachmentManager(this.#multiplexer, options.rpcLimits);
    this.#acpAdapters =
      options.acpAdapters ?? new AcpAdapterManager(this.#multiplexer, options.acpLimits);
    this.#dashboardApi = options.dashboardApi;
    this.#dashboardTuiAttachments = options.dashboardTuiAttachments;
    this.#schedules = options.schedules;
    this.#scheduler = options.scheduler;
    this.#blobs = options.blobs;
    this.limits = {
      maxConnections: positiveInteger(
        options.limits?.maxConnections ?? DEFAULT_API_SERVER_LIMITS.maxConnections,
        "maxConnections",
      ),
      maxBodyBytes: positiveInteger(
        options.limits?.maxBodyBytes ?? DEFAULT_API_SERVER_LIMITS.maxBodyBytes,
        "maxBodyBytes",
      ),
      maxHeaderBytes: positiveInteger(
        options.limits?.maxHeaderBytes ?? DEFAULT_API_SERVER_LIMITS.maxHeaderBytes,
        "maxHeaderBytes",
      ),
      requestTimeoutMs: positiveInteger(
        options.limits?.requestTimeoutMs ?? DEFAULT_API_SERVER_LIMITS.requestTimeoutMs,
        "requestTimeoutMs",
      ),
    };
    this.#server = createServer(
      { maxHeaderSize: this.limits.maxHeaderBytes },
      (request, response) => void this.#handleRequest(request, response),
    );
    this.#server.maxConnections = this.limits.maxConnections;
    this.#server.requestTimeout = this.limits.requestTimeoutMs;
    this.#server.headersTimeout = this.limits.requestTimeoutMs;
    this.#server.on("upgrade", (request, socket) => {
      this.#upgradeSockets.add(socket);
      socket.once("close", () => this.#upgradeSockets.delete(socket));
      void this.#handleUpgrade(request, socket);
    });
  }

  get ticketRecovery(): MutationTicketRecovery | undefined {
    return this.#ticketRecovery === undefined
      ? undefined
      : structuredClone(this.#ticketRecovery);
  }

  get address(): ApiServerAddress | undefined {
    const address = this.#server.address();
    if (address === null || typeof address === "string") return undefined;
    return { host: address.address, port: address.port };
  }

  async start(): Promise<ApiServerAddress> {
    if (this.#started) throw new Error("API server is already started");
    await this.#blobs?.recover();
    this.#ticketRecovery = await this.#tickets?.recover(async (command, context) =>
      this.#executeMutation(command, context?.runtimeOptions),
    );
    if (this.#tickets !== undefined) {
      this.#indeterminateMutationTickets =
        this.#ticketRecovery?.indeterminate.length ?? 0;
      this.#multiplexer.setMutationRecoveryHealth(
        this.#tickets.pendingRuns,
        this.#indeterminateMutationTickets,
      );
      const recoveredQueuedIds =
        this.#ticketRecovery?.queued.map((ticket) => ticket.ticketId) ?? [];
      void this.#tickets.settled().then(async () => {
        const recovered = await Promise.all(
          recoveredQueuedIds.map(async (ticketId) => this.#tickets!.get(ticketId)),
        );
        const failures = recovered.filter((ticket) => ticket?.state === "failed").length;
        this.#multiplexer.setMutationRecoveryHealth(
          0,
          this.#indeterminateMutationTickets,
          failures,
        );
      });
    }
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        this.#server.off("listening", onListening);
        reject(error);
      };
      const onListening = (): void => {
        this.#server.off("error", onError);
        resolve();
      };
      this.#server.once("error", onError);
      this.#server.once("listening", onListening);
      this.#server.listen({ host: this.host, port: this.port, exclusive: true });
    });
    this.#started = true;
    return this.address!;
  }

  async stop(): Promise<void> {
    this.#tickets?.beginDrain();
    if (!this.#started) return;
    this.#started = false;
    this.#rpcAttachments.dispose();
    this.#acpAdapters.dispose();
    for (const socket of this.#upgradeSockets) socket.destroy();
    this.#upgradeSockets.clear();
    this.#server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      this.#server.close((error) => (error === undefined ? resolve() : reject(error)));
    });
  }

  async #handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const requestId = safeRequestId(request.headers["x-request-id"]);
    if (!this.#authenticator.authenticate(request.headers.authorization)) {
      sendJson(
        response,
        401,
        errorEnvelope(requestId, this.#multiplexer.hostInstanceId, {
          code: "unauthorized",
          message: "missing or invalid service bearer",
          retryable: false,
        }),
        { "WWW-Authenticate": "Bearer", Connection: "close" },
      );
      response.once("finish", () => request.destroy());
      return;
    }

    let requestPath = "/";
    try {
      const url = requestUrl(request);
      requestPath = url.pathname;
      if (request.method === "GET" && url.pathname === "/v1/capabilities") {
        sendJson(response, 200, {
          apiVersion: SESSION_API_VERSION,
          requestId,
          hostInstanceId: this.#multiplexer.hostInstanceId,
          ok: true,
          data: {
            apiVersion: SESSION_API_VERSION,
            transports: ["unix-ndjson", "http", "websocket"],
            rpcSubprotocols: [...this.#rpcAttachments.capabilities.subprotocols],
            rpc: this.#rpcAttachments.capabilities,
            acp: this.#acpAdapters.capabilities,
            isolationModes: ["unisolated"],
            authentication: "service-bearer",
            schedules: this.#schedules === undefined
              ? { available: false }
              : scheduleCapabilities(this.#schedules.limits, this.#scheduler !== undefined),
            blobTransfers: this.#blobs === undefined
              ? { available: false }
              : this.#blobs.capabilities,
            ...(this.#dashboardApi === undefined
              ? {}
              : { dashboard: await this.#dashboardApi.capabilities() }),
          },
        });
        return;
      }

      if (
        this.#dashboardApi !== undefined &&
        (await this.#handleDashboardRequest(request, response, url, requestId))
      ) {
        return;
      }

      if (url.pathname === "/v1/schedule" || url.pathname === "/v1/schedule/status" || url.pathname.startsWith("/v1/schedule/")) {
        await this.#handleScheduleRequest(request, response, url, requestId);
        return;
      }

      if (blobTransferPath(url.pathname) !== undefined) {
        await this.#handleBlobTransferRequest(request, response, url, requestId);
        return;
      }

      if (request.method === "GET" && url.pathname === "/v1/session") {
        const limit = listLimit(url.searchParams.get("limit"));
        const cursor = url.searchParams.get("cursor") ?? undefined;
        const page = await this.#multiplexer.retainedSessions({
          limit,
          ...(cursor === undefined ? {} : { cursor }),
        });
        sendJson(response, 200, {
          apiVersion: SESSION_API_VERSION,
          requestId,
          hostInstanceId: this.#multiplexer.hostInstanceId,
          ok: true,
          data: {
            sessions: page.sessions.map(catalogRecordToSessionResource),
            ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
          },
        });
        return;
      }

      if (request.method === "GET") {
        if (url.pathname === "/v1/ticket") {
          const method = ticketLookupMethod(url.searchParams.get("method"));
          const target = url.searchParams.get("target");
          if (target === null || target.length === 0 || target.length > 4096) {
            throw new ApiRequestError(400, "invalid_ticket_target", "ticket target is invalid");
          }
          const idempotencyKey = requiredIdempotencyKey(
            request.headers["idempotency-key"],
          );
          const mutationTicket =
            method === "WAKE"
              ? undefined
              : await this.#tickets?.getByIdempotency(method, target, idempotencyKey);
          const wakeSession =
            method === "WAKE" ? wakeSessionFromTarget(target) : undefined;
          const wakeTicket =
            wakeSession === undefined
              ? undefined
              : await this.#multiplexer.requestTicketByIdempotency(
                  wakeSession,
                  idempotencyKey,
                );
          const resource =
            mutationTicket === undefined
              ? wakeTicket
              : mutationTicketResource(mutationTicket);
          if (resource === undefined) {
            throw new ApiRequestError(404, "ticket_not_found", "ticket not found");
          }
          sendJson(response, 200, {
            apiVersion: SESSION_API_VERSION,
            requestId,
            hostInstanceId: this.#multiplexer.hostInstanceId,
            ok: true,
            data: resource,
          });
          return;
        }

        const ticketId = ticketIdFromPath(url.pathname);
        if (ticketId !== undefined) {
          const mutationTicket = await this.#tickets?.get(ticketId);
          const resource =
            mutationTicket === undefined
              ? await this.#multiplexer.requestTicket(ticketId)
              : mutationTicketResource(mutationTicket);
          if (resource === undefined) {
            throw new ApiRequestError(404, "ticket_not_found", "ticket not found");
          }
          sendJson(response, 200, {
            apiVersion: SESSION_API_VERSION,
            requestId,
            hostInstanceId: this.#multiplexer.hostInstanceId,
            ok: true,
            data: resource,
          });
          return;
        }

        const sessionRef = sessionRefFromPath(url.pathname);
        if (sessionRef !== undefined) {
          const record = await this.#multiplexer.retainedSession(sessionRef);
          if (record === undefined) {
            throw new ApiRequestError(404, "session_not_found", "session not found");
          }
          sendJson(
            response,
            200,
            {
              apiVersion: SESSION_API_VERSION,
              requestId,
              hostInstanceId: this.#multiplexer.hostInstanceId,
              ok: true,
              data: catalogRecordToSessionResource(record),
            },
            { ETag: sessionEtag(record.sessionId, record.revision) },
          );
          return;
        }
      }

      if (request.method === "POST") {
        const reconcileTicketId = reconcileTicketIdFromPath(url.pathname);
        if (reconcileTicketId !== undefined) {
          const reconciliation = await this.#reconcileTicket(
            request,
            reconcileTicketId,
          );
          sendJson(response, 200, {
            apiVersion: SESSION_API_VERSION,
            requestId: reconciliation.responseRequestId,
            hostInstanceId: this.#multiplexer.hostInstanceId,
            ok: true,
            data: reconciliation.resource,
          });
          return;
        }
      }

      if (request.method === "POST" && url.pathname === "/v1/session") {
        if (this.#tickets === undefined) {
          await readBoundedJson(request, this.limits.maxBodyBytes);
          throw new ApiRequestError(
            501,
            "not_implemented",
            "session mutation tickets are not configured",
          );
        }
        const waitForTerminal = booleanQuery(
          url.searchParams.get("waitForTerminal"),
          false,
        );
        const submission = await this.#submitCreate(request, requestId);
        const responseTicket = await this.#ticketForResponse(
          waitForTerminal,
          submission.ticket,
        );
        sendJson(
          response,
          202,
          ticketEnvelope(
            submission.responseRequestId,
            this.#multiplexer.hostInstanceId,
            responseTicket,
          ),
          {
            Location: `/v1/ticket/${encodeURIComponent(responseTicket.ticketId)}`,
          },
        );
        return;
      }

      if (request.method === "PUT" || request.method === "DELETE") {
        const sessionRef = sessionRefFromPath(url.pathname);
        if (sessionRef !== undefined) {
          if (this.#tickets === undefined) {
            if (request.method === "PUT") await readBoundedJson(request, this.limits.maxBodyBytes);
            throw new ApiRequestError(
              501,
              "not_implemented",
              "session mutation tickets are not configured",
            );
          }
          const waitForTerminal = booleanQuery(
            url.searchParams.get("waitForTerminal"),
            false,
          );
          const submission =
            request.method === "PUT"
              ? await this.#submitUpdate(request, sessionRef, requestId)
              : await this.#submitDelete(request, url, sessionRef, requestId);
          const responseTicket = await this.#ticketForResponse(
            waitForTerminal,
            submission.ticket,
          );
          sendJson(
            response,
            202,
            ticketEnvelope(
              submission.responseRequestId,
              this.#multiplexer.hostInstanceId,
              responseTicket,
            ),
            {
              Location: `/v1/ticket/${encodeURIComponent(
                responseTicket.ticketId,
              )}`,
            },
          );
          return;
        }
      }
      throw new ApiRequestError(404, "route_not_found", "API route not found");
    } catch (error) {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      const normalized = normalizeApiError(error);
      this.#dashboardApi?.recordApiFailure?.({
        method: request.method,
        path: requestPath,
        status: normalized.status,
        code: normalized.body.code,
      });
      sendJson(
        response,
        normalized.status,
        errorEnvelope(requestId, this.#multiplexer.hostInstanceId, normalized.body),
      );
    }
  }

  async #handleBlobTransferRequest(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    requestId: string,
  ): Promise<void> {
    const store = this.#blobs;
    if (store === undefined) {
      throw new ApiRequestError(
        501,
        "blob_transfers_unavailable",
        "blob transfer storage is not configured",
      );
    }
    const route = blobTransferPath(url.pathname);
    if (route === undefined) {
      throw new ApiRequestError(404, "route_not_found", "API route not found");
    }

    if (route.kind === "blobs" && request.method === "POST") {
      if (this.#tickets === undefined) {
        throw new ApiRequestError(
          501,
          "not_implemented",
          "blob reservation tickets are not configured",
        );
      }
      const idempotencyKey = requiredIdempotencyKey(request.headers["idempotency-key"]);
      const body = parseBlobReservationRequest(
        await readBoundedJson(request, this.limits.maxBodyBytes),
      );
      assertMatchingRequestId(request.headers["x-request-id"], body.requestId);
      const session = await this.#requireTransferSession(
        route.sessionRef,
        body.expectedGeneration,
      );
      const canonicalTarget = `/v1/session/${encodeURIComponent(session.sessionId)}/blob`;
      const blobId = blobIdForScope(`POST\n${canonicalTarget}\n${idempotencyKey}`);
      const ticket = await this.#tickets.submit({
        method: "POST",
        canonicalTarget,
        idempotencyKey,
        command: {
          operation: "reserve_blob",
          requestId: body.requestId,
          sessionId: session.sessionId,
          expectedGeneration: body.expectedGeneration,
          blobId,
          metadata: body.metadata,
          sizeBytes: body.sizeBytes,
          sha256: body.sha256,
        },
      });
      const responseTicket = await this.#ticketForResponse(
        booleanQuery(url.searchParams.get("waitForTerminal"), false),
        ticket,
      );
      sendJson(
        response,
        202,
        ticketEnvelope(body.requestId, this.#multiplexer.hostInstanceId, responseTicket),
        { Location: `/v1/ticket/${encodeURIComponent(responseTicket.ticketId)}` },
      );
      return;
    }

    if (route.kind === "files" && request.method === "POST") {
      if (this.#tickets === undefined) {
        throw new ApiRequestError(
          501,
          "not_implemented",
          "session upload materialization tickets are not configured",
        );
      }
      const idempotencyKey = requiredIdempotencyKey(request.headers["idempotency-key"]);
      const body = parseBlobMaterializationRequest(
        await readBoundedJson(request, this.limits.maxBodyBytes),
      );
      assertMatchingRequestId(request.headers["x-request-id"], body.requestId);
      const session = await this.#requireTransferSession(
        route.sessionRef,
        body.expectedGeneration,
      );
      const canonicalTarget = `/v1/session/${encodeURIComponent(session.sessionId)}/file`;
      const fileId = fileIdForScope(`POST\n${canonicalTarget}\n${idempotencyKey}`);
      const ticket = await this.#tickets.submit({
        method: "POST",
        canonicalTarget,
        idempotencyKey,
        command: {
          operation: "materialize_blob",
          requestId: body.requestId,
          sessionId: session.sessionId,
          expectedGeneration: body.expectedGeneration,
          blobId: body.blobId,
          fileId,
        },
      });
      const responseTicket = await this.#ticketForResponse(
        booleanQuery(url.searchParams.get("waitForTerminal"), false),
        ticket,
      );
      sendJson(
        response,
        202,
        ticketEnvelope(body.requestId, this.#multiplexer.hostInstanceId, responseTicket),
        { Location: `/v1/ticket/${encodeURIComponent(responseTicket.ticketId)}` },
      );
      return;
    }

    const generation = transferGeneration(url.searchParams.get("generation"));
    const session = await this.#requireTransferSession(route.sessionRef, generation);
    if (route.kind === "blob") {
      if (request.method === "GET") {
        const resource = await store.getBlob(route.blobId, session.sessionId, generation);
        if (resource === undefined) {
          throw new ApiRequestError(404, "blob_not_found", "blob not found");
        }
        sendJson(
          response,
          200,
          blobEnvelope(requestId, this.#multiplexer.hostInstanceId, resource),
          { ETag: blobEtag(resource) },
        );
        return;
      }
      if (request.method === "DELETE") {
        if (this.#tickets === undefined) {
          throw new ApiRequestError(
            501,
            "not_implemented",
            "blob cleanup tickets are not configured",
          );
        }
        const idempotencyKey = requiredIdempotencyKey(
          request.headers["idempotency-key"],
        );
        const ticket = await this.#tickets.submit({
          method: "DELETE",
          canonicalTarget: `/v1/session/${encodeURIComponent(session.sessionId)}/blob/${encodeURIComponent(route.blobId)}?generation=${generation}`,
          idempotencyKey,
          command: {
            operation: "delete_blob",
            requestId,
            sessionId: session.sessionId,
            expectedGeneration: generation,
            blobId: route.blobId,
          },
        });
        const responseTicket = await this.#ticketForResponse(
          booleanQuery(url.searchParams.get("waitForTerminal"), false),
          ticket,
        );
        sendJson(
          response,
          202,
          ticketEnvelope(requestId, this.#multiplexer.hostInstanceId, responseTicket),
          { Location: `/v1/ticket/${encodeURIComponent(responseTicket.ticketId)}` },
        );
        return;
      }
    }
    if (route.kind === "blob-content") {
      if (request.method === "PUT") {
        const key = requiredIdempotencyKey(request.headers["idempotency-key"]);
        const reserved = await store.getBlob(route.blobId, session.sessionId, generation);
        if (reserved === undefined) {
          throw new ApiRequestError(404, "blob_not_found", "blob not found");
        }
        assertContentLength(request.headers["content-length"], reserved.sizeBytes);
        const resource = await store.uploadContent(
          route.blobId,
          session.sessionId,
          generation,
          key,
          request,
        );
        sendJson(
          response,
          200,
          blobEnvelope(requestId, this.#multiplexer.hostInstanceId, resource),
          { ETag: blobEtag(resource) },
        );
        return;
      }
      if (request.method === "GET") {
        const content = await store.blobContent(
          route.blobId,
          session.sessionId,
          generation,
        );
        await sendTransferContent(
          response,
          requestId,
          this.#multiplexer.hostInstanceId,
          content.resource,
          content.path,
        );
        return;
      }
    }
    if (route.kind === "file") {
      if (request.method === "GET") {
        const resource = await store.getReference(
          route.fileId,
          session.sessionId,
          generation,
        );
        if (resource === undefined) {
          throw new ApiRequestError(
            404,
            "file_reference_not_found",
            "session upload reference not found",
          );
        }
        sendJson(
          response,
          200,
          fileEnvelope(requestId, this.#multiplexer.hostInstanceId, resource),
        );
        return;
      }
      if (request.method === "DELETE") {
        if (this.#tickets === undefined) {
          throw new ApiRequestError(
            501,
            "not_implemented",
            "session upload cleanup tickets are not configured",
          );
        }
        const idempotencyKey = requiredIdempotencyKey(
          request.headers["idempotency-key"],
        );
        const ticket = await this.#tickets.submit({
          method: "DELETE",
          canonicalTarget: `/v1/session/${encodeURIComponent(session.sessionId)}/file/${encodeURIComponent(route.fileId)}?generation=${generation}`,
          idempotencyKey,
          command: {
            operation: "delete_file",
            requestId,
            sessionId: session.sessionId,
            expectedGeneration: generation,
            fileId: route.fileId,
          },
        });
        const responseTicket = await this.#ticketForResponse(
          booleanQuery(url.searchParams.get("waitForTerminal"), false),
          ticket,
        );
        sendJson(
          response,
          202,
          ticketEnvelope(requestId, this.#multiplexer.hostInstanceId, responseTicket),
          { Location: `/v1/ticket/${encodeURIComponent(responseTicket.ticketId)}` },
        );
        return;
      }
    }
    if (route.kind === "file-content" && request.method === "GET") {
      const content = await store.referenceContent(
        route.fileId,
        session.sessionId,
        generation,
      );
      await sendTransferContent(
        response,
        requestId,
        this.#multiplexer.hostInstanceId,
        content.resource,
        content.path,
      );
      return;
    }
    throw new ApiRequestError(405, "method_not_allowed", "method is not allowed");
  }

  async #requireTransferSession(
    sessionRef: string,
    expectedGeneration: number,
  ): Promise<{ sessionId: string; generation: number }> {
    const session = await this.#multiplexer.retainedSession(sessionRef);
    if (session === undefined) {
      throw new ApiRequestError(404, "session_not_found", "session not found");
    }
    if (session.generation !== expectedGeneration) {
      throw new ApiRequestError(
        412,
        "session_precondition_failed",
        "session generation changed",
      );
    }
    return { sessionId: session.sessionId, generation: session.generation };
  }

  async #handleScheduleRequest(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    requestId: string,
  ): Promise<void> {
    const store = this.#schedules;
    if (store === undefined) throw new ApiRequestError(501, "schedules_unavailable", "schedule persistence is not configured");
    if (request.method === "GET" && url.pathname === "/v1/schedule/status") {
      const schedules = await store.list();
      const nextWakeAt = this.#scheduler?.status().nextWakeAt ?? schedules
        .filter((value) => value.enabled && value.nextTriggerAt !== undefined)
        .map((value) => value.nextTriggerAt!)
        .sort()[0];
      sendJson(response, 200, { apiVersion: SESSION_API_VERSION, requestId, hostInstanceId: this.#multiplexer.hostInstanceId, ok: true, data: { timerRuntime: this.#scheduler !== undefined, externalTimersSupported: true, scheduleCount: schedules.length, enabledCount: schedules.filter((value) => value.enabled).length, ...(nextWakeAt === undefined ? {} : { nextWakeAt }) } });
      return;
    }
    if (request.method === "GET" && url.pathname === "/v1/schedule") {
      const sessionRef = url.searchParams.get("session");
      if (sessionRef !== null && (sessionRef.length === 0 || sessionRef.length > 256)) throw new ApiRequestError(400, "invalid_session_ref", "session reference is invalid");
      const canonical = sessionRef === null ? undefined : await this.#resolveScheduleSession(sessionRef);
      const schedules = await store.list(canonical);
      sendJson(response, 200, { apiVersion: SESSION_API_VERSION, requestId, hostInstanceId: this.#multiplexer.hostInstanceId, ok: true, data: { schedules } });
      return;
    }
    const parsed = schedulePath(url.pathname);
    if (parsed === undefined) throw new ApiRequestError(404, "route_not_found", "API route not found");
    const current = await store.get(parsed.scheduleId);
    if (request.method === "GET" && parsed.action === undefined) {
      if (current === undefined) throw new ApiRequestError(404, "schedule_not_found", "schedule not found");
      sendJson(response, 200, { apiVersion: SESSION_API_VERSION, requestId, hostInstanceId: this.#multiplexer.hostInstanceId, ok: true, data: current }, { ETag: scheduleEtag(current.scheduleId, current.revision) });
      return;
    }
    if (request.method !== "POST" && request.method !== "PUT" && request.method !== "DELETE") throw new ApiRequestError(405, "method_not_allowed", "method is not allowed");
    const key = requiredIdempotencyKey(request.headers["idempotency-key"]);
    const body = request.method === "DELETE" || parsed.action !== undefined ? undefined : await readBoundedJson(request, Math.min(this.limits.maxBodyBytes, store.limits.maxRecordBytes));
    const fingerprint = createHash("sha256").update(JSON.stringify([request.method, url.pathname, body])).digest("hex");
    const idempotencyId = `${request.method}:${url.pathname}:${key}`;
    const replay = this.#scheduleMutations.get(idempotencyId);
    if (replay !== undefined) {
      if (replay.fingerprint !== fingerprint) throw new ApiRequestError(409, "idempotency_conflict", "idempotency key was already used with different schedule content");
      sendJson(response, replay.status, { apiVersion: SESSION_API_VERSION, requestId, hostInstanceId: this.#multiplexer.hostInstanceId, ok: true, data: replay.data ?? { deleted: true } }, replay.data === undefined ? {} : { ETag: scheduleEtag(replay.data.scheduleId, replay.data.revision) });
      return;
    }
    let result: ScheduleResource | undefined;
    let status = 200;
    if (request.method === "POST" && parsed.action === undefined) {
      if (current !== undefined) throw new ApiRequestError(409, "schedule_exists", "schedule already exists");
      const definition = await this.#scheduleDefinition(body, parsed.scheduleId);
      result = await store.create(definition);
      status = 201;
    } else {
      if (current === undefined) throw new ApiRequestError(404, "schedule_not_found", "schedule not found");
      assertScheduleIfMatch(request.headers["if-match"], current);
      if (request.method === "DELETE" && parsed.action === undefined) {
        await store.delete(current.scheduleId, current.revision);
      } else {
        const definition = parsed.action === undefined
          ? await this.#scheduleDefinition(body, current.scheduleId, current.sessionRef, current.revision)
          : { ...scheduleDefinitionFromResource(current), enabled: parsed.action === "enable" };
        result = await store.update(current.scheduleId, current.revision, definition);
      }
    }
    await this.#scheduler?.recompute();
    if (result !== undefined && this.#scheduler !== undefined) {
      result = (await store.get(result.scheduleId)) ?? result;
    }
    if (this.#scheduleMutations.size >= 1024) this.#scheduleMutations.delete(this.#scheduleMutations.keys().next().value!);
    this.#scheduleMutations.set(idempotencyId, { fingerprint, status, ...(result === undefined ? {} : { data: result }) });
    sendJson(response, status, { apiVersion: SESSION_API_VERSION, requestId, hostInstanceId: this.#multiplexer.hostInstanceId, ok: true, data: result ?? { deleted: true } }, result === undefined ? {} : { ETag: scheduleEtag(result.scheduleId, result.revision) });
  }

  async #scheduleDefinition(value: unknown, scheduleId: string, immutableSession?: string, currentRevision?: number): Promise<ScheduleDefinition> {
    const input = apiRecord(value, "schedule definition");
    const suppliedId = input.scheduleId === undefined ? scheduleId : apiString(input.scheduleId, "scheduleId", 128);
    if (suppliedId !== scheduleId) throw new ApiRequestError(409, "schedule_identity_conflict", "scheduleId is immutable and must match the route");
    const requestedSession = apiString(input.sessionRef, "sessionRef", 256);
    const sessionRef = await this.#resolveScheduleSession(requestedSession);
    if (immutableSession !== undefined && sessionRef !== immutableSession) throw new ApiRequestError(409, "schedule_identity_conflict", "sessionRef is immutable");
    if (input.expectedRevision !== undefined && (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision !== currentRevision)) {
      throw new ApiRequestError(412, "schedule_precondition_failed", "expectedRevision does not match the current schedule revision");
    }
    const { contractVersion: _contractVersion, revision: _revision, createdAt: _createdAt, updatedAt: _updatedAt, expectedRevision: _expectedRevision, ...definition } = input;
    return { ...definition, scheduleId, sessionRef } as ScheduleDefinition;
  }

  async #resolveScheduleSession(sessionRef: string): Promise<string> {
    const record = await this.#multiplexer.retainedSession(sessionRef);
    if (record === undefined) throw new ApiRequestError(404, "session_not_found", "session not found");
    return record.sessionId;
  }

  /**
   * Thin adapter over the extracted neutral Dashboard router (bd-23110a).
   *
   * Admission has already run in `#handleRequest`; this method only supplies the
   * bounded body reader, then renders the router's result through the single
   * shared response envelope. Returns false when the path is not a Dashboard
   * route so the caller continues its own routing.
   */
  async #handleDashboardRequest(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    requestId: string,
  ): Promise<boolean> {
    if (!isDashboardRoutePath(url.pathname)) return false;
    const result = await routeDashboardRequest(
      this.#dashboardApi!,
      dashboardRouteRequest(request, url, () =>
        readBoundedJson(request, this.limits.maxBodyBytes),
      ),
    );
    if (result === undefined) return false;
    sendJson(
      response,
      result.status,
      {
        apiVersion: SESSION_API_VERSION,
        requestId: result.requestId ?? requestId,
        hostInstanceId: this.#multiplexer.hostInstanceId,
        ok: true,
        data: result.data,
      },
      result.headers ?? {},
    );
    return true;
  }

  async #ticketForResponse(
    waitForTerminal: boolean,
    admitted: MutationTicketRecord,
  ): Promise<MutationTicketRecord> {
    if (!waitForTerminal) return admitted;
    return (await this.#tickets!.wait(admitted.ticketId)) ?? admitted;
  }

  async #submitCreate(
    request: IncomingMessage,
    responseRequestId: string,
  ): Promise<MutationSubmission> {
    const idempotencyKey = requiredIdempotencyKey(request.headers["idempotency-key"]);
    const body = parseSessionCreateRequest(
      await readBoundedJson(request, this.limits.maxBodyBytes),
    );
    assertMatchingRequestId(request.headers["x-request-id"], body.requestId);
    const existing = await this.#tickets!.getByIdempotency(
      "POST",
      "/v1/session",
      idempotencyKey,
    );
    const sessionId = body.sessionId ?? existing?.sessionId ?? randomUUID();
    const command: MutationTicketCommand = {
      operation: "create",
      requestId: body.requestId || responseRequestId,
      sessionId,
      generation: 1,
      spec: body.configuration.persistedSpec,
      environmentSummary: environmentSummary(body.configuration),
    };
    return {
      ticket: await this.#tickets!.submit(
        {
          method: "POST",
          canonicalTarget: "/v1/session",
          idempotencyKey,
          command,
        },
        { runtimeOptions: body.configuration.runtimeOptions },
      ),
      responseRequestId: body.requestId,
    };
  }

  async #submitUpdate(
    request: IncomingMessage,
    sessionRef: string,
    responseRequestId: string,
  ): Promise<MutationSubmission> {
    const idempotencyKey = requiredIdempotencyKey(request.headers["idempotency-key"]);
    const body = parseSessionUpdateRequest(
      await readBoundedJson(request, this.limits.maxBodyBytes),
    );
    assertMatchingRequestId(request.headers["x-request-id"], body.requestId);
    const directTarget = `/v1/session/${encodeURIComponent(sessionRef)}`;
    const directTicket = await this.#tickets!.getByIdempotency(
      "PUT",
      directTarget,
      idempotencyKey,
    );
    if (directTicket !== undefined) {
      if (directTicket.command.operation !== "update") {
        throw new TicketStoreError("corrupt_ticket", "ticket operation does not match scope");
      }
      assertIfMatch(
        request.headers["if-match"],
        directTicket.sessionId,
        directTicket.command.expectedRevision,
      );
      const command: MutationTicketCommand = {
        operation: "update",
        requestId: body.requestId || responseRequestId,
        sessionId: directTicket.sessionId,
        expectedGeneration: body.expectedGeneration,
        expectedRevision: body.expectedRevision,
        generation: body.expectedGeneration + 1,
        spec: body.configuration.persistedSpec,
        environmentSummary: environmentSummary(body.configuration),
      };
      return {
        ticket: await this.#tickets!.submit(
          {
            method: "PUT",
            canonicalTarget: directTarget,
            idempotencyKey,
            command,
          },
          { runtimeOptions: body.configuration.runtimeOptions },
        ),
        responseRequestId: body.requestId,
      };
    }
    const current = await this.#multiplexer.retainedSession(sessionRef);
    if (current === undefined) {
      throw new ApiRequestError(404, "session_not_found", "session not found");
    }
    assertIfMatch(request.headers["if-match"], current.sessionId, current.revision);
    if (
      body.expectedGeneration !== current.generation ||
      body.expectedRevision !== current.revision
    ) {
      throw new ApiRequestError(
        412,
        "session_precondition_failed",
        "session generation or revision changed",
      );
    }
    const command: MutationTicketCommand = {
      operation: "update",
      requestId: body.requestId || responseRequestId,
      sessionId: current.sessionId,
      expectedGeneration: body.expectedGeneration,
      expectedRevision: body.expectedRevision,
      generation: body.expectedGeneration + 1,
      spec: body.configuration.persistedSpec,
      environmentSummary: environmentSummary(body.configuration),
    };
    return {
      ticket: await this.#tickets!.submit(
        {
          method: "PUT",
          canonicalTarget: `/v1/session/${encodeURIComponent(current.sessionId)}`,
          idempotencyKey,
          command,
        },
        { runtimeOptions: body.configuration.runtimeOptions },
      ),
      responseRequestId: body.requestId,
    };
  }

  async #submitDelete(
    request: IncomingMessage,
    url: URL,
    sessionRef: string,
    responseRequestId: string,
  ): Promise<MutationSubmission> {
    const idempotencyKey = requiredIdempotencyKey(request.headers["idempotency-key"]);
    const retainArtifacts = booleanQuery(url.searchParams.get("retainArtifacts"), true);
    const directTarget = `/v1/session/${encodeURIComponent(sessionRef)}?retainArtifacts=${retainArtifacts}`;
    const directTicket = await this.#tickets!.getByIdempotency(
      "DELETE",
      directTarget,
      idempotencyKey,
    );
    if (directTicket !== undefined) {
      if (directTicket.command.operation !== "delete") {
        throw new TicketStoreError("corrupt_ticket", "ticket operation does not match scope");
      }
      assertIfMatch(
        request.headers["if-match"],
        directTicket.sessionId,
        directTicket.command.expectedRevision,
      );
      const command: MutationTicketCommand = {
        operation: "delete",
        requestId: responseRequestId,
        sessionId: directTicket.sessionId,
        expectedGeneration: directTicket.command.expectedGeneration,
        expectedRevision: directTicket.command.expectedRevision,
        retainArtifacts,
      };
      return {
        ticket: await this.#tickets!.submit({
          method: "DELETE",
          canonicalTarget: directTarget,
          idempotencyKey,
          command,
        }),
        responseRequestId,
      };
    }
    const current = await this.#multiplexer.retainedSession(sessionRef);
    if (current === undefined) {
      throw new ApiRequestError(404, "session_not_found", "session not found");
    }
    assertIfMatch(request.headers["if-match"], current.sessionId, current.revision);
    const command: MutationTicketCommand = {
      operation: "delete",
      requestId: responseRequestId,
      sessionId: current.sessionId,
      expectedGeneration: current.generation,
      expectedRevision: current.revision,
      retainArtifacts,
    };
    return {
      ticket: await this.#tickets!.submit({
        method: "DELETE",
        canonicalTarget: `/v1/session/${encodeURIComponent(current.sessionId)}?retainArtifacts=${retainArtifacts}`,
        idempotencyKey,
        command,
      }),
      responseRequestId,
    };
  }

  async #reconcileTicket(
    request: IncomingMessage,
    ticketId: string,
  ): Promise<ReconciliationSubmission> {
    const body = parseTicketReconciliation(
      await readBoundedJson(request, this.limits.maxBodyBytes),
    );
    assertMatchingRequestId(request.headers["x-request-id"], body.requestId);
    const mutation = await this.#tickets?.get(ticketId);
    if (mutation !== undefined) {
      const reconciled = await this.#tickets!.reconcile(
        ticketId,
        body.state === "succeeded"
          ? { state: "succeeded", result: body.result }
          : { state: "failed", error: body.error },
      );
      this.#indeterminateMutationTickets = Math.max(
        0,
        this.#indeterminateMutationTickets - 1,
      );
      this.#multiplexer.setMutationRecoveryHealth(
        this.#tickets!.pendingRuns,
        this.#indeterminateMutationTickets,
      );
      return {
        resource: mutationTicketResource(reconciled),
        responseRequestId: body.requestId,
      };
    }
    try {
      return {
        resource: await this.#multiplexer.reconcileWakeTicket(
          ticketId,
          body.state === "succeeded"
            ? { state: "completed", result: body.result }
            : { state: "failed", error: body.error },
        ),
        responseRequestId: body.requestId,
      };
    } catch (error) {
      if (
        error instanceof MultiplexerError &&
        (error.code === "ticket_not_found" || error.code === "journal_entry_missing")
      ) {
        throw new ApiRequestError(404, "ticket_not_found", "ticket not found");
      }
      throw error;
    }
  }

  async #executeMutation(
    command: MutationTicketCommand,
    suppliedRuntimeOptions?: PreparedSessionRuntimeOptions,
  ): Promise<unknown> {
    if (
      command.operation === "reserve_blob" ||
      command.operation === "materialize_blob" ||
      command.operation === "delete_blob" ||
      command.operation === "delete_file"
    ) {
      if (this.#blobs === undefined) {
        throw new BlobStoreError(
          "blob_transfers_unavailable",
          "blob transfer storage is not configured",
        );
      }
      const current = await this.#multiplexer.retainedSession(command.sessionId);
      if (current === undefined) {
        throw new MultiplexerError("session_not_found", "session not found");
      }
      if (current.generation !== command.expectedGeneration) {
        throw new MultiplexerError(
          "session_precondition_failed",
          "session generation changed",
        );
      }
      if (command.operation === "reserve_blob") {
        return this.#blobs.reserve({
          blobId: command.blobId,
          sessionId: command.sessionId,
          generation: command.expectedGeneration,
          metadata: command.metadata,
          sizeBytes: command.sizeBytes,
          sha256: command.sha256,
        });
      }
      if (command.operation === "materialize_blob") {
        return this.#blobs.materialize({
          fileId: command.fileId,
          sessionId: command.sessionId,
          generation: command.expectedGeneration,
          blobId: command.blobId,
        });
      }
      if (command.operation === "delete_blob") {
        return {
          blobId: command.blobId,
          deleted: await this.#blobs.deleteBlob(
            command.blobId,
            command.sessionId,
            command.expectedGeneration,
          ),
        };
      }
      return {
        fileId: command.fileId,
        deleted: await this.#blobs.deleteReference(
          command.fileId,
          command.sessionId,
          command.expectedGeneration,
        ),
      };
    }

    const runtimeOptions =
      command.operation === "delete"
        ? undefined
        : await this.#runtimeOptionsForMutation(command, suppliedRuntimeOptions);
    if (command.operation === "create") {
      if ((await this.#multiplexer.retainedSession(command.sessionId)) !== undefined) {
        throw new MultiplexerError("session_exists", "session ID already exists");
      }
      await this.#multiplexer.open(openCommandFromTicket(command), {
        runtimeOptions: runtimeOptions!,
        environmentSummary: command.environmentSummary,
        catalogSpec: command.spec,
      });
      return this.#currentSessionResource(command.sessionId);
    }

    const current = await this.#multiplexer.retainedSession(command.sessionId);
    if (current === undefined) {
      throw new MultiplexerError("session_not_found", "session not found");
    }
    if (
      current.generation !== command.expectedGeneration ||
      current.revision !== command.expectedRevision
    ) {
      throw new MultiplexerError("session_precondition_failed", "session version changed");
    }

    if (command.operation === "update") {
      if (current.residency === "resident") {
        await this.#multiplexer.close({
          protocolVersion: "1.0",
          requestId: `${command.requestId}-replace-close`,
          operation: "close",
          sessionId: command.sessionId,
          generation: current.generation,
          payload: { retainSession: true },
        });
      }
      await this.#multiplexer.open(openCommandFromTicket(command), {
        runtimeOptions: runtimeOptions!,
        environmentSummary: command.environmentSummary,
        catalogSpec: command.spec,
      });
      await this.#blobs?.deleteGeneration(command.sessionId, command.expectedGeneration);
      return this.#currentSessionResource(command.sessionId);
    }

    const changed = command.retainArtifacts
      ? await this.#multiplexer.close({
          protocolVersion: "1.0",
          requestId: command.requestId,
          operation: "close",
          sessionId: command.sessionId,
          generation: command.expectedGeneration,
          payload: { retainSession: true },
        })
      : await this.#multiplexer.deleteRetainedSession(command.sessionId, {
          requestId: command.requestId,
          expectedGeneration: command.expectedGeneration,
          expectedRevision: command.expectedRevision,
        });
    if (!changed) throw new MultiplexerError("session_not_found", "session not found");
    if (!command.retainArtifacts) {
      await this.#blobs?.deleteGeneration(command.sessionId, command.expectedGeneration);
    }
    return {
      sessionId: command.sessionId,
      retained: command.retainArtifacts,
      deleted: !command.retainArtifacts,
    };
  }

  async #runtimeOptionsForMutation(
    command: Extract<MutationTicketCommand, { operation: "create" | "update" }>,
    supplied: PreparedSessionRuntimeOptions | undefined,
  ): Promise<PreparedSessionRuntimeOptions> {
    requireProvisionedEnvironment(
      command.environmentSummary,
      supplied?.environmentOverlay,
    );
    let runtimeOptions: PreparedSessionRuntimeOptions =
      supplied ?? {
        persistedSpec: command.spec,
        environmentOverlay: Object.freeze({}),
      };
    if (command.spec.target.mode === "fork") {
      const sourceRef = command.spec.target.sourceSession;
      const source =
        sourceRef === undefined
          ? undefined
          : await this.#multiplexer.retainedSession(sourceRef);
      if (source?.conversation?.sessionFile === undefined) {
        throw new MultiplexerError(
          "fork_source_unavailable",
          "fork source has no retained Pi conversation",
        );
      }
      runtimeOptions = {
        ...runtimeOptions,
        resolvedSourceSessionPath: source.conversation.sessionFile,
      };
    }
    return runtimeOptions;
  }

  async #currentSessionResource(sessionId: string): Promise<unknown> {
    const record = await this.#multiplexer.retainedSession(sessionId);
    if (record === undefined) {
      throw new MultiplexerError("catalog_record_missing", "session catalog record is missing");
    }
    return catalogRecordToSessionResource(record);
  }

  async #handleUpgrade(request: IncomingMessage, socket: Duplex): Promise<void> {
    const requestId = safeRequestId(request.headers["x-request-id"]);
    if (!this.#authenticator.authenticate(request.headers.authorization)) {
      sendRawHttp(
        socket,
        401,
        errorEnvelope(requestId, this.#multiplexer.hostInstanceId, {
          code: "unauthorized",
          message: "missing or invalid service bearer",
          retryable: false,
        }),
        { "WWW-Authenticate": "Bearer" },
      );
      return;
    }

    let url: URL;
    try {
      url = requestUrl(request);
    } catch {
      sendRawHttp(
        socket,
        400,
        errorEnvelope(requestId, this.#multiplexer.hostInstanceId, {
          code: "invalid_request_target",
          message: "request target is invalid",
          retryable: false,
        }),
      );
      return;
    }
    let rpcSessionRef: string | undefined;
    try {
      rpcSessionRef = rpcSessionRefFromPath(url.pathname);
    } catch (error) {
      const normalized = normalizeAttachmentError(error);
      sendRawHttp(
        socket,
        normalized.status,
        errorEnvelope(requestId, this.#multiplexer.hostInstanceId, normalized.body),
      );
      return;
    }
    if (rpcSessionRef !== undefined) {
      try {
        await this.#rpcAttachments.attach(request, socket, rpcSessionRef, url);
      } catch (error) {
        const normalized = normalizeAttachmentError(error);
        sendRawHttp(
          socket,
          normalized.status,
          errorEnvelope(requestId, this.#multiplexer.hostInstanceId, normalized.body),
          normalized.status === 426
            ? { "Sec-WebSocket-Protocol": "pi-rpc.v1, pi-daemon-rpc.v1" }
            : {},
        );
      }
      return;
    }
    let acpSessionRef: string | undefined;
    try {
      acpSessionRef = acpSessionRefFromPath(url.pathname);
    } catch (error) {
      const normalized = normalizeAttachmentError(error);
      sendRawHttp(
        socket,
        normalized.status,
        errorEnvelope(requestId, this.#multiplexer.hostInstanceId, normalized.body),
      );
      return;
    }
    if (acpSessionRef !== undefined) {
      try {
        await this.#acpAdapters.attach(request, socket, acpSessionRef, url);
      } catch (error) {
        const normalized = normalizeAttachmentError(error);
        sendRawHttp(
          socket,
          normalized.status,
          errorEnvelope(requestId, this.#multiplexer.hostInstanceId, normalized.body),
          normalized.status === 426
            ? { "Sec-WebSocket-Protocol": ACP_WEBSOCKET_SUBPROTOCOL }
            : {},
        );
      }
      return;
    }
    let dashboardTuiRef: string | undefined;
    try {
      dashboardTuiRef = dashboardPathRef(
        url.pathname,
        "/v1/dashboard/session/",
        "/tui",
      );
    } catch (error) {
      const normalized = normalizeAttachmentError(error);
      sendRawHttp(
        socket,
        normalized.status,
        errorEnvelope(requestId, this.#multiplexer.hostInstanceId, normalized.body),
      );
      return;
    }
    if (dashboardTuiRef !== undefined) {
      try {
        if (request.headers["sec-websocket-protocol"] !== DASHBOARD_TUI_SUBPROTOCOL) {
          throw new DashboardTuiAttachmentError(
            426,
            "tui_subprotocol_required",
            "dashboard TUI WebSocket subprotocol is required",
          );
        }
        if (this.#dashboardTuiAttachments === undefined) {
          throw new DashboardTuiAttachmentError(
            501,
            "tui_unavailable",
            "dashboard TUI attachment service is unavailable",
          );
        }
        await this.#dashboardTuiAttachments.attach(request, socket, dashboardTuiRef, url);
      } catch (error) {
        const normalized = normalizeDashboardTuiError(error);
        sendRawHttp(
          socket,
          normalized.status,
          errorEnvelope(requestId, this.#multiplexer.hostInstanceId, normalized.body),
          normalized.status === 426 ? dashboardTuiUpgradeHeaders() : {},
        );
      }
      return;
    }
    sendRawHttp(
      socket,
      404,
      errorEnvelope(requestId, this.#multiplexer.hostInstanceId, {
        code: "route_not_found",
        message: "API route not found",
        retryable: false,
      }),
    );
  }
}

function requestUrl(request: IncomingMessage): URL {
  try {
    return new URL(request.url ?? "", "http://pi-daemon.invalid");
  } catch {
    throw new ApiRequestError(400, "invalid_request_target", "request target is invalid");
  }
}

function ticketEnvelope(
  requestId: string,
  hostInstanceId: string,
  record: MutationTicketRecord,
) {
  return {
    apiVersion: SESSION_API_VERSION,
    requestId,
    hostInstanceId,
    ok: true as const,
    data: mutationTicketResource(record),
  };
}

function reconcileTicketIdFromPath(pathname: string): string | undefined {
  const match = /^\/v1\/ticket\/([^/]+)\/reconcile$/.exec(pathname);
  if (match === null) return undefined;
  return decodeTicketId(match[1]!);
}

function ticketIdFromPath(pathname: string): string | undefined {
  const match = /^\/v1\/ticket\/([^/]+)$/.exec(pathname);
  if (match === null) return undefined;
  return decodeTicketId(match[1]!);
}

function decodeTicketId(value: string): string {
  try {
    const ticketId = decodeURIComponent(value);
    if (!/^ticket-[A-Za-z0-9_-]{43}$/.test(ticketId)) throw new Error("invalid ticket ID");
    return ticketId;
  } catch {
    throw new ApiRequestError(400, "invalid_ticket_id", "ticket identifier is invalid");
  }
}

function parseTicketReconciliation(value: unknown):
  | {
      requestId: string;
      state: "succeeded";
      result: unknown;
    }
  | {
      requestId: string;
      state: "failed";
      error: ApiErrorBody;
    } {
  const input = apiRecord(value, "ticket reconciliation");
  const requestId = apiString(input.requestId, "requestId", 128);
  const evidence = apiRecord(input.evidence, "evidence");
  if (
    !Array.isArray(evidence.piEntryIds) ||
    evidence.piEntryIds.length < 1 ||
    evidence.piEntryIds.length > 256 ||
    !evidence.piEntryIds.every(
      (entryId) => typeof entryId === "string" && entryId.length > 0 && entryId.length <= 256,
    )
  ) {
    throw new ApiRequestError(
      400,
      "invalid_reconciliation_evidence",
      "reconciliation requires bounded retained Pi entry IDs",
    );
  }
  const piEntryIds = evidence.piEntryIds as string[];
  if (input.result !== undefined) {
    throw new ApiRequestError(
      400,
      "invalid_reconciliation",
      "reconciliation persists Pi entry IDs, not client-supplied result content",
    );
  }
  if (input.state === "succeeded") {
    return {
      requestId,
      state: "succeeded",
      result: { reconciled: true, piEntryIds: [...piEntryIds] },
    };
  }
  if (input.state === "failed") {
    const error = apiRecord(input.error, "error");
    const retryable = error.retryable;
    if (typeof retryable !== "boolean") {
      throw new ApiRequestError(
        400,
        "invalid_reconciliation",
        "error.retryable is invalid",
      );
    }
    return {
      requestId,
      state: "failed",
      error: {
        code: apiString(error.code, "error.code", 128),
        message: "client reconciliation marked the ticket failed",
        retryable,
      },
    };
  }
  throw new ApiRequestError(
    400,
    "invalid_reconciliation",
    "reconciliation state must be succeeded or failed",
  );
}

function ticketLookupMethod(
  value: string | null,
): "POST" | "PUT" | "DELETE" | "WAKE" {
  if (value !== "POST" && value !== "PUT" && value !== "DELETE" && value !== "WAKE") {
    throw new ApiRequestError(400, "invalid_ticket_method", "ticket method is invalid");
  }
  return value;
}

function wakeSessionFromTarget(target: string): string {
  const match = /^\/v1\/session\/([^/]+)\/wake$/.exec(target);
  if (match === null) {
    throw new ApiRequestError(
      400,
      "invalid_ticket_target",
      "WAKE ticket target must be a canonical session wake path",
    );
  }
  try {
    const sessionId = decodeURIComponent(match[1]!);
    if (sessionId.length === 0 || sessionId.length > 256) throw new Error("invalid session ID");
    return sessionId;
  } catch {
    throw new ApiRequestError(400, "invalid_ticket_target", "WAKE ticket target is invalid");
  }
}

function requiredIdempotencyKey(value: string | string[] | undefined): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 512 ||
    /[\r\n]/.test(value)
  ) {
    throw new ApiRequestError(
      400,
      "invalid_idempotency_key",
      "Idempotency-Key is required and must be at most 512 characters",
    );
  }
  return value;
}

function assertIfMatch(
  value: string | string[] | undefined,
  sessionId: string,
  revision: number,
): void {
  if (typeof value !== "string" || value !== sessionEtag(sessionId, revision)) {
    throw new ApiRequestError(
      412,
      "session_precondition_failed",
      "If-Match does not match the current session revision",
    );
  }
}

function booleanQuery(value: string | null, defaultValue: boolean): boolean {
  if (value === null) return defaultValue;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new ApiRequestError(400, "invalid_boolean", "query boolean must be true or false");
}

function environmentSummary(
  configuration: PreparedSessionConfiguration,
): SessionEnvironmentSummary {
  if (configuration.environmentSummary.keys.length === 0) {
    return { ...configuration.environmentSummary };
  }
  const semantic = configuration.environmentSummary.keys.map((key) => [
    key,
    configuration.environmentOverlay[key],
  ]);
  const digest = createHash("sha256")
    .update(JSON.stringify(semantic), "utf8")
    .digest("hex");
  return { ...configuration.environmentSummary, digest: `sha256:${digest}` };
}

function parseSessionCreateRequest(value: unknown): {
  requestId: string;
  sessionId?: string;
  configuration: PreparedSessionConfiguration;
} {
  const input = apiRecord(value, "session create request");
  const requestId = apiString(input.requestId, "requestId", 128);
  const sessionId = apiOptionalString(input.sessionId, "sessionId", 256);
  const configuration = parseSessionConfiguration(input.spec);
  return {
    requestId,
    ...(sessionId === undefined ? {} : { sessionId }),
    configuration,
  };
}

function parseSessionUpdateRequest(value: unknown): {
  requestId: string;
  expectedGeneration: number;
  expectedRevision: number;
  configuration: PreparedSessionConfiguration;
} {
  const input = apiRecord(value, "session update request");
  return {
    requestId: apiString(input.requestId, "requestId", 128),
    expectedGeneration: apiInteger(input.expectedGeneration, "expectedGeneration", 0),
    expectedRevision: apiInteger(input.expectedRevision, "expectedRevision", 1),
    configuration: parseSessionConfiguration(input.spec),
  };
}

function openCommandFromTicket(
  command: Extract<MutationTicketCommand, { operation: "create" | "update" }>,
): Extract<ProtocolCommand, { operation: "open" }> {
  return {
    protocolVersion: "1.0",
    requestId: command.requestId,
    operation: "open",
    sessionId: command.sessionId,
    generation: command.generation,
    payload: sessionOpenPayloadFromSpec(command.spec),
  };
}

function sessionEtag(sessionId: string, revision: number): string {
  return `"${Buffer.from(sessionId, "utf8").toString("base64url")}:${revision}"`;
}

function scheduleEtag(scheduleId: string, revision: number): string {
  return `"${Buffer.from(scheduleId, "utf8").toString("base64url")}:${revision}"`;
}

function assertScheduleIfMatch(value: string | string[] | undefined, resource: ScheduleResource): void {
  if (typeof value !== "string" || value !== scheduleEtag(resource.scheduleId, resource.revision)) {
    throw new ApiRequestError(412, "schedule_precondition_failed", "If-Match does not match the current schedule revision");
  }
}

function scheduleDefinitionFromResource(resource: ScheduleResource): ScheduleDefinition {
  const { contractVersion: _contractVersion, revision: _revision, createdAt: _createdAt, updatedAt: _updatedAt, ...definition } = resource;
  return definition;
}

function schedulePath(pathname: string): { scheduleId: string; action?: "enable" | "disable" } | undefined {
  const match = /^\/v1\/schedule\/([^/]+)(?:\/(enable|disable))?$/.exec(pathname);
  if (match === null) return undefined;
  try {
    const scheduleId = decodeURIComponent(match[1]!);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(scheduleId)) throw new Error("invalid schedule ID");
    return { scheduleId, ...(match[2] === undefined ? {} : { action: match[2] as "enable" | "disable" }) };
  } catch {
    throw new ApiRequestError(400, "invalid_schedule_id", "schedule ID is invalid");
  }
}

type BlobTransferPath =
  | { kind: "blobs"; sessionRef: string }
  | { kind: "blob"; sessionRef: string; blobId: string }
  | { kind: "blob-content"; sessionRef: string; blobId: string }
  | { kind: "files"; sessionRef: string }
  | { kind: "file"; sessionRef: string; fileId: string }
  | { kind: "file-content"; sessionRef: string; fileId: string };

function blobTransferPath(pathname: string): BlobTransferPath | undefined {
  const match = /^\/v1\/session\/([^/]+)\/(blob|file)(?:\/([^/]+)(?:\/(content))?)?$/u.exec(
    pathname,
  );
  if (match === null) return undefined;
  try {
    const sessionRef = decodeURIComponent(match[1]!);
    if (sessionRef.length === 0 || sessionRef.length > 256) {
      throw new Error("invalid session reference");
    }
    const family = match[2]!;
    const encodedId = match[3];
    const content = match[4] === "content";
    if (encodedId === undefined) {
      return family === "blob"
        ? { kind: "blobs", sessionRef }
        : { kind: "files", sessionRef };
    }
    const id = decodeURIComponent(encodedId);
    if (family === "blob") {
      if (!/^blob-[A-Za-z0-9_-]{43}$/u.test(id)) throw new Error("invalid blob ID");
      return content
        ? { kind: "blob-content", sessionRef, blobId: id }
        : { kind: "blob", sessionRef, blobId: id };
    }
    if (!/^file-[A-Za-z0-9_-]{43}$/u.test(id)) throw new Error("invalid file ID");
    return content
      ? { kind: "file-content", sessionRef, fileId: id }
      : { kind: "file", sessionRef, fileId: id };
  } catch {
    throw new ApiRequestError(
      400,
      "invalid_blob_route",
      "blob transfer route identifier is invalid",
    );
  }
}

interface BlobReservationRequestBody {
  requestId: string;
  expectedGeneration: number;
  metadata: { name: string; mediaType: string };
  sizeBytes: number;
  sha256: string;
}

interface BlobMaterializationRequestBody {
  requestId: string;
  expectedGeneration: number;
  blobId: string;
}

function parseBlobReservationRequest(value: unknown): BlobReservationRequestBody {
  const body = transferRecord(
    value,
    ["requestId", "expectedGeneration", "metadata", "sizeBytes", "sha256"],
    "blob reservation",
  );
  const metadata = transferRecord(valueField(body, "metadata"), ["name", "mediaType"], "blob metadata");
  const requestId = transferString(body.requestId, "requestId", 128);
  const expectedGeneration = transferInteger(body.expectedGeneration, "expectedGeneration");
  const name = transferString(metadata.name, "metadata.name", 512, true);
  const mediaType = transferString(metadata.mediaType, "metadata.mediaType", 255);
  if (!/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/u.test(mediaType)) {
    throw new ApiRequestError(400, "invalid_blob_metadata", "metadata.mediaType is invalid");
  }
  const sizeBytes = transferInteger(body.sizeBytes, "sizeBytes");
  const sha256 = transferString(body.sha256, "sha256", 64);
  if (!/^[a-f0-9]{64}$/u.test(sha256)) {
    throw new ApiRequestError(400, "invalid_blob_hash", "sha256 is invalid");
  }
  return {
    requestId,
    expectedGeneration,
    metadata: { name, mediaType: mediaType.toLowerCase() },
    sizeBytes,
    sha256,
  };
}

function parseBlobMaterializationRequest(value: unknown): BlobMaterializationRequestBody {
  const body = transferRecord(
    value,
    ["requestId", "expectedGeneration", "blobId"],
    "blob materialization",
  );
  const blobId = transferString(body.blobId, "blobId", 48);
  if (!/^blob-[A-Za-z0-9_-]{43}$/u.test(blobId)) {
    throw new ApiRequestError(400, "invalid_blob_id", "blobId is invalid");
  }
  return {
    requestId: transferString(body.requestId, "requestId", 128),
    expectedGeneration: transferInteger(body.expectedGeneration, "expectedGeneration"),
    blobId,
  };
}

function transferRecord(
  value: unknown,
  allowedKeys: readonly string[],
  field: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ApiRequestError(400, "invalid_blob_request", `${field} must be an object`);
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !allowedKeys.includes(key))) {
    throw new ApiRequestError(400, "invalid_blob_request", `${field} has unknown fields`);
  }
  return record;
}

function valueField(value: Record<string, unknown>, field: string): unknown {
  return value[field];
}

function transferString(
  value: unknown,
  field: string,
  maxBytes: number,
  unicodeBytes = false,
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    (unicodeBytes ? Buffer.byteLength(value, "utf8") : value.length) > maxBytes ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new ApiRequestError(400, "invalid_blob_request", `${field} is invalid`);
  }
  return value;
}

function transferInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new ApiRequestError(400, "invalid_blob_request", `${field} is invalid`);
  }
  return value as number;
}

function transferGeneration(value: string | null): number {
  if (value === null || !/^\d+$/u.test(value)) {
    throw new ApiRequestError(
      400,
      "missing_session_generation",
      "generation query parameter is required",
    );
  }
  return transferInteger(Number(value), "generation");
}

function assertContentLength(value: string | undefined, expectedBytes: number): void {
  if (value === undefined) return;
  if (!/^\d+$/u.test(value) || Number(value) !== expectedBytes) {
    throw new ApiRequestError(
      400,
      "blob_size_mismatch",
      "Content-Length does not match the reserved blob size",
    );
  }
}

function blobEnvelope(
  requestId: string,
  hostInstanceId: string,
  resource: BlobTransferResource,
) {
  return {
    apiVersion: SESSION_API_VERSION,
    requestId,
    hostInstanceId,
    ok: true as const,
    data: resource,
  };
}

function fileEnvelope(
  requestId: string,
  hostInstanceId: string,
  resource: SessionUploadResource,
) {
  return {
    apiVersion: SESSION_API_VERSION,
    requestId,
    hostInstanceId,
    ok: true as const,
    data: resource,
  };
}

function blobEtag(resource: BlobTransferResource): string {
  return `"${resource.blobId}:${resource.revision}"`;
}

async function sendTransferContent(
  response: ServerResponse,
  requestId: string,
  hostInstanceId: string,
  resource: BlobTransferResource | SessionUploadResource,
  path: string,
): Promise<void> {
  const encodedName = encodeURIComponent(resource.metadata.name).replace(
    /[!'()*]/gu,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  response.writeHead(200, {
    "Content-Type": "application/octet-stream",
    "Content-Length": String(resource.sizeBytes),
    "Content-Disposition": `attachment; filename*=UTF-8''${encodedName}`,
    "X-Content-Type-Options": "nosniff",
    "X-Pi-Request-Id": requestId,
    "X-Pi-Host-Instance-Id": hostInstanceId,
    "X-Pi-Untrusted-Media-Type": resource.metadata.mediaType,
    Digest: `sha-256=${Buffer.from(resource.sha256, "hex").toString("base64")}`,
    "Cache-Control": "no-store",
  });
  await pipeline(contentReadStream(path), response);
}

function sessionRefFromPath(pathname: string): string | undefined {
  const match = /^\/v1\/session\/([^/]+)$/.exec(pathname);
  if (match === null) return undefined;
  try {
    const value = decodeURIComponent(match[1]!);
    if (value.length === 0 || value.length > 256) {
      throw new Error("invalid session reference");
    }
    return value;
  } catch {
    throw new ApiRequestError(400, "invalid_session_ref", "session reference is invalid");
  }
}

function rpcSessionRefFromPath(pathname: string): string | undefined {
  const match = /^\/v1\/session\/([^/]+)\/rpc$/.exec(pathname);
  if (match === null) return undefined;
  try {
    const value = decodeURIComponent(match[1]!);
    if (value.length === 0 || value.length > 256) throw new Error("invalid session reference");
    return value;
  } catch {
    throw new RpcAttachmentError(400, "invalid_session_ref", "session reference is invalid");
  }
}

function acpSessionRefFromPath(pathname: string): string | undefined {
  const match = /^\/v1\/session\/([^/]+)\/apc$/.exec(pathname);
  if (match === null) return undefined;
  try {
    const value = decodeURIComponent(match[1]!);
    if (value.length === 0 || value.length > 256) throw new Error("invalid session reference");
    return value;
  } catch {
    throw new AcpAdapterError(400, "invalid_session_ref", "session reference is invalid");
  }
}

function listLimit(value: string | null): number {
  if (value === null) return 50;
  if (!/^\d+$/.test(value)) {
    throw new ApiRequestError(400, "invalid_limit", "session list limit is invalid");
  }
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new ApiRequestError(400, "invalid_limit", "session list limit must be between 1 and 100");
  }
  return limit;
}

function safeRequestId(value: string | string[] | undefined): string {
  return typeof value === "string" && value.length > 0 && value.length <= 128 && !/[\r\n]/.test(value)
    ? value
    : `http-${randomUUID()}`;
}

function errorEnvelope(requestId: string, hostInstanceId: string, error: ApiErrorBody) {
  return {
    apiVersion: SESSION_API_VERSION,
    requestId,
    hostInstanceId,
    ok: false as const,
    error,
  };
}

function normalizeAttachmentError(error: unknown): { status: number; body: ApiErrorBody } {
  if (
    error instanceof RpcAttachmentError ||
    error instanceof AcpAdapterError ||
    error instanceof WebSocketHandshakeError
  ) {
    return {
      status: error.status,
      body: {
        code: error.code,
        message: error.message,
        retryable:
          error instanceof RpcAttachmentError || error instanceof AcpAdapterError
            ? error.retryable
            : false,
      },
    };
  }
  return {
    status: 500,
    body: { code: "stream_attach_failed", message: "stream attachment failed", retryable: false },
  };
}

function normalizeDashboardTuiError(error: unknown): {
  status: number;
  body: ApiErrorBody;
} {
  if (error instanceof DashboardTuiAttachmentError) {
    return {
      status: error.status,
      body: {
        code: error.code,
        message: error.message,
        retryable: error.retryable,
      },
    };
  }
  return {
    status: 500,
    body: {
      code: "tui_attach_failed",
      message: "dashboard TUI attachment failed",
      retryable: false,
    },
  };
}

function normalizeApiError(error: unknown): { status: number; body: ApiErrorBody } {
  if (error instanceof ProtocolSerializationError) {
    return {
      status: 500,
      body: {
        code: error.code,
        message: "API response exceeds the bounded JSON transport contract",
        retryable: false,
      },
    };
  }
  if (error instanceof ScheduleValidationError) {
    return { status: error.code === "schedule_too_large" ? 413 : 400, body: { code: error.code, message: error.message, retryable: false } };
  }
  if (error instanceof ScheduleStoreError) {
    const status = error.code === "not_found" ? 404 : error.code === "revision_conflict" ? 412 : error.code === "already_exists" ? 409 : error.code === "schedule_capacity" ? 429 : 503;
    return { status, body: { code: error.code, message: error.message, retryable: status === 429 || status === 503 } };
  }
  if (error instanceof BlobStoreError) {
    const status =
      error.code === "blob_not_found" || error.code === "file_reference_not_found"
        ? 404
        : error.code === "blob_session_precondition_failed"
          ? 412
          : error.code === "blob_capacity" || error.code === "blob_reference_capacity"
            ? 429
            : error.code === "blob_too_large"
              ? 413
              : error.code === "blob_hash_mismatch" ||
                  error.code === "blob_size_mismatch" ||
                  error.code === "blob_quarantined"
                ? 422
                : error.code === "blob_transfers_unavailable"
                  ? 503
                  : error.code === "corrupt_blob_state" ||
                      error.code === "blob_recovery_limit"
                    ? 500
                    : error.code === "idempotency_conflict" ||
                        error.code === "blob_reservation_conflict" ||
                        error.code === "file_reference_conflict" ||
                        error.code === "blob_in_use" ||
                        error.code === "blob_not_ready" ||
                        error.code === "blob_expired"
                      ? 409
                      : 400;
    return {
      status,
      body: {
        code: error.code,
        message:
          status === 500 ? "blob transfer state is unavailable" : error.message,
        retryable: error.retryable || status === 429 || status === 503,
      },
    };
  }
  if (error instanceof SessionConfigurationError) {
    const status =
      error.statusClass === "too_large"
        ? 413
        : error.statusClass === "unsupported" ||
            error.statusClass === "credentials_required"
          ? 422
          : 400;
    return {
      status,
      body: { code: error.code, message: error.message, retryable: false },
    };
  }
  if (error instanceof ApiRequestError) {
    return {
      status: error.status,
      body: { code: error.code, message: error.message, retryable: error.retryable },
    };
  }
  if (error instanceof TicketStoreError) {
    const status =
      error.code === "ticket_not_found"
        ? 404
        : error.code === "idempotency_conflict" ||
            error.code === "ticket_not_indeterminate" ||
            error.code === "invalid_ticket_transition"
          ? 409
          : error.code === "ticket_capacity"
            ? 429
            : error.code === "ticket_record_too_large"
              ? 413
              : error.code === "tickets_not_ready" || error.code === "tickets_draining"
                ? 503
                : 400;
    return {
      status,
      body: { code: error.code, message: error.message, retryable: error.retryable },
    };
  }
  if (error instanceof MultiplexerError) {
    const status =
      error.code === "session_not_found"
        ? 404
        : error.code === "stale_generation" ||
            error.code === "session_busy" ||
            error.code === "ticket_not_indeterminate"
          ? 409
          : error.retryable
            ? 503
            : 400;
    return {
      status,
      body: {
        code: error.code,
        message: error.message,
        retryable: error.retryable,
      },
    };
  }
  return {
    status: 500,
    body: { code: "internal_error", message: "internal server error", retryable: false },
  };
}

function sendJson(
  response: ServerResponse,
  status: number,
  value: unknown,
  headers: Record<string, string> = {},
): void {
  const body = encodeBoundedLine(value, DEFAULT_API_RESPONSE_BYTES);
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Length": String(body.length),
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
    ...headers,
  });
  response.end(body);
}

function sendRawHttp(
  socket: Duplex,
  status: number,
  value: unknown,
  headers: Record<string, string> = {},
): void {
  const reason =
    status === 400
      ? "Bad Request"
      : status === 401
        ? "Unauthorized"
        : status === 404
          ? "Not Found"
          : status === 409
            ? "Conflict"
            : status === 426
              ? "Upgrade Required"
              : status === 501
                ? "Not Implemented"
                : status === 503
                  ? "Service Unavailable"
                  : "Error";
  const body = encodeBoundedLine(value, DEFAULT_API_RESPONSE_BYTES);
  const lines = [
    `HTTP/1.1 ${status} ${reason}`,
    "Cache-Control: no-store",
    "Connection: close",
    `Content-Length: ${body.length}`,
    "Content-Type: application/json; charset=utf-8",
    "X-Content-Type-Options: nosniff",
    ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
    "",
    "",
  ];
  socket.end(Buffer.concat([Buffer.from(lines.join("\r\n"), "utf8"), body]));
}

function isLoopbackBind(host: string): boolean {
  const normalized = host.toLowerCase();
  if (normalized === "::1") return true;
  return isIP(normalized) === 4 && Number(normalized.split(".", 1)[0]) === 127;
}

function portNumber(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 65535) {
    throw new Error("API port must be an integer between 0 and 65535");
  }
  return value;
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${field} must be a positive safe integer`);
  }
  return value;
}
