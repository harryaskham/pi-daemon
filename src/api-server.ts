import { randomUUID } from "node:crypto";
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
import { SESSION_API_VERSION, type ApiErrorBody } from "./session-api.js";
import { catalogRecordToSessionResource } from "./session-catalog.js";

export interface ApiServerLimits {
  maxConnections: number;
  maxBodyBytes: number;
  maxHeaderBytes: number;
  requestTimeoutMs: number;
}

export const DEFAULT_API_SERVER_LIMITS: Readonly<ApiServerLimits> = {
  maxConnections: 64,
  maxBodyBytes: 1024 * 1024,
  maxHeaderBytes: 32 * 1024,
  requestTimeoutMs: 30_000,
};

export interface ApiServerOptions {
  multiplexer: Multiplexer;
  authenticator: ServiceBearerAuthenticator;
  host?: string;
  port?: number;
  allowInsecureRemote?: boolean;
  limits?: Partial<ApiServerLimits>;
}

export interface ApiServerAddress {
  host: string;
  port: number;
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
  readonly #server: Server;
  #started = false;

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

  get address(): ApiServerAddress | undefined {
    const address = this.#server.address();
    if (address === null || typeof address === "string") return undefined;
    return { host: address.address, port: address.port };
  }

  async start(): Promise<ApiServerAddress> {
    if (this.#started) throw new Error("API server is already started");
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

      if (request.method === "POST" && url.pathname === "/v1/session") {
        await readBoundedJson(request, this.limits.maxBodyBytes);
        throw new ApiRequestError(
          501,
          "not_implemented",
          "session CRUD dispatch is not implemented by this transport foundation",
        );
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
  if (error instanceof ApiRequestError) {
    return {
      status: error.status,
      body: { code: error.code, message: error.message, retryable: error.retryable },
    };
  }
  if (error instanceof MultiplexerError) {
    const status =
      error.code === "session_not_found"
        ? 404
        : error.code === "stale_generation" || error.code === "session_busy"
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
  const body = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
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
  const body = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
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
