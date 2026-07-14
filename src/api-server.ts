import { createHash, randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { isIP } from "node:net";
import type { Duplex } from "node:stream";

import { ServiceBearerAuthenticator } from "./api-auth.js";
import { Multiplexer, MultiplexerError } from "./multiplexer.js";
import {
  ProtocolSerializationError,
  encodeBoundedLine,
  type OpenPayload,
  type ProtocolCommand,
} from "./protocol.js";
import {
  SESSION_API_VERSION,
  type ApiErrorBody,
  type SessionEnvironmentSummary,
  type TicketResource,
} from "./session-api.js";
import {
  SessionConfigurationError,
  parseSessionConfiguration,
  requireProvisionedEnvironment,
  type PreparedSessionConfiguration,
  type PreparedSessionRuntimeOptions,
} from "./session-config.js";
import {
  catalogRecordToSessionResource,
  type PersistedSessionSpec,
} from "./session-catalog.js";
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

class ApiRequestError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;

  constructor(status: number, code: string, message: string, retryable = false) {
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

/**
 * Bearer-authenticated HTTP/WebSocket admission boundary for the additive API.
 * Retained session reads share the durable catalog; asynchronous mutation
 * tickets and stream dispatch land in later slices. This class owns the secure
 * listener, capability negotiation, bounded bodies, and fail-closed upgrades.
 */
export class ApiServer {
  readonly host: string;
  readonly port: number;
  readonly limits: ApiServerLimits;
  readonly #multiplexer: Multiplexer;
  readonly #authenticator: ServiceBearerAuthenticator;
  readonly #tickets: MutationTicketController | undefined;
  readonly #server: Server;
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
    this.#server.on("upgrade", (request, socket) => this.#handleUpgrade(request, socket));
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

    try {
      const url = requestUrl(request);
      if (request.method === "GET" && url.pathname === "/v1/capabilities") {
        sendJson(response, 200, {
          apiVersion: SESSION_API_VERSION,
          requestId,
          hostInstanceId: this.#multiplexer.hostInstanceId,
          ok: true,
          data: {
            apiVersion: SESSION_API_VERSION,
            transports: ["unix-ndjson", "http"],
            rpcSubprotocols: [],
            isolationModes: ["unisolated"],
            authentication: "service-bearer",
          },
        });
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
      const normalized = normalizeApiError(error);
      sendJson(
        response,
        normalized.status,
        errorEnvelope(requestId, this.#multiplexer.hostInstanceId, normalized.body),
      );
    }
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

  #handleUpgrade(request: IncomingMessage, socket: Duplex): void {
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

    let pathname: string;
    try {
      pathname = requestUrl(request).pathname;
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
    if (/^\/v1\/session\/[^/]+\/(rpc|apc)$/.test(pathname)) {
      sendRawHttp(
        socket,
        501,
        errorEnvelope(requestId, this.#multiplexer.hostInstanceId, {
          code: "stream_not_implemented",
          message: "authenticated stream upgrade is reserved for the RPC/ACP implementation slice",
          retryable: false,
        }),
      );
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

export async function readBoundedJson(
  request: IncomingMessage,
  maxBodyBytes: number,
): Promise<unknown> {
  const declaredLength = request.headers["content-length"];
  if (declaredLength !== undefined) {
    const parsedLength = /^\d+$/.test(declaredLength) ? Number(declaredLength) : Number.NaN;
    if (!Number.isSafeInteger(parsedLength) || parsedLength < 0) {
      throw new ApiRequestError(400, "invalid_content_length", "Content-Length is invalid");
    }
    if (parsedLength > maxBodyBytes) {
      throw new ApiRequestError(413, "body_too_large", "JSON request body exceeds byte limit");
    }
  }
  let bytes = 0;
  const chunks: Buffer[] = [];
  for await (const value of request) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
    bytes += chunk.length;
    if (bytes > maxBodyBytes) {
      throw new ApiRequestError(413, "body_too_large", "JSON request body exceeds byte limit");
    }
    chunks.push(chunk);
  }
  if (bytes === 0) throw new ApiRequestError(400, "invalid_json", "JSON request body is required");
  try {
    return JSON.parse(Buffer.concat(chunks, bytes).toString("utf8")) as unknown;
  } catch {
    throw new ApiRequestError(400, "invalid_json", "request body is not valid JSON");
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

function assertMatchingRequestId(
  header: string | string[] | undefined,
  bodyRequestId: string,
): void {
  if (header !== undefined && (typeof header !== "string" || header !== bodyRequestId)) {
    throw new ApiRequestError(
      400,
      "request_id_mismatch",
      "X-Request-Id must match the mutation body requestId",
    );
  }
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
    payload: openPayloadFromSpec(command.spec),
  };
}

function openPayloadFromSpec(spec: PersistedSessionSpec): OpenPayload {
  const session: OpenPayload["session"] = {
    mode:
      spec.target.mode === "fork"
        ? "new"
        : (spec.target.mode as OpenPayload["session"]["mode"]),
    ...(spec.target.path === undefined ? {} : { path: spec.target.path }),
  };
  const resources: OpenPayload["resources"] = {
    extensions: "none",
    skills: "none",
    promptTemplates: "none",
    themes: "none",
    contextFiles: "none",
    tools: "none",
    ...(spec.resources?.systemPrompt === undefined
      ? {}
      : { systemPrompt: spec.resources.systemPrompt }),
  };
  const payload: OpenPayload = {
    cwd: spec.cwd,
    session,
    resources,
    ...(spec.name === undefined ? {} : { name: spec.name }),
    ...(spec.agentDir === undefined ? {} : { agentDir: spec.agentDir }),
  };
  if (spec.model?.provider !== undefined && spec.model.id !== undefined) {
    payload.model = {
      provider: spec.model.provider,
      id: spec.model.id,
      ...(spec.model.thinkingLevel === undefined
        ? {}
        : { thinkingLevel: spec.model.thinkingLevel }),
    };
  }
  return payload;
}

function apiRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ApiRequestError(400, "invalid_session_spec", `${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function apiString(
  value: unknown,
  field: string,
  max: number,
  allowEmpty = false,
): string {
  if (
    typeof value !== "string" ||
    (!allowEmpty && value.length === 0) ||
    value.length > max ||
    /[\u0000]/.test(value)
  ) {
    throw new ApiRequestError(400, "invalid_session_spec", `${field} is invalid`);
  }
  return value;
}

function apiOptionalString(
  value: unknown,
  field: string,
  max: number,
  allowEmpty = false,
): string | undefined {
  return value === undefined ? undefined : apiString(value, field, max, allowEmpty);
}

function apiInteger(value: unknown, field: string, minimum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new ApiRequestError(400, "invalid_session_spec", `${field} is invalid`);
  }
  return value as number;
}

function sessionEtag(sessionId: string, revision: number): string {
  return `"${Buffer.from(sessionId, "utf8").toString("base64url")}:${revision}"`;
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
          : status === 501
            ? "Not Implemented"
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
