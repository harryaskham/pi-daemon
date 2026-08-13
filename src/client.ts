import { createConnection, type Socket } from "node:net";

import {
  DEFAULT_MAX_LINE_BYTES,
  NdjsonDecoder,
  PROTOCOL_V2_VERSION,
  PROTOCOL_VERSION,
  encodeLine,
  type EventEnvelope,
  type ProtocolErrorBody,
  type ResponseEnvelope,
} from "./protocol.js";
import {
  parseSupportedProtocolCommand,
  type SupportedProtocolCommand as ProtocolCommand,
} from "./protocol-v2.js";

export interface PiDaemonClientOptions {
  socketPath: string;
  connectTimeoutMs?: number;
  requestTimeoutMs?: number;
  maxLineBytes?: number;
}

export class PiDaemonClientTimeoutError extends Error {
  readonly code = "pi_daemon_client_timeout";
  readonly phase: "connect" | "request";

  constructor(message: string, phase: "connect" | "request") {
    super(message);
    this.name = "PiDaemonClientTimeoutError";
    this.phase = phase;
  }
}

export class ProtocolResponseError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly details: Record<string, unknown> | undefined;
  readonly response: ResponseEnvelope;

  constructor(response: ResponseEnvelope) {
    const body = response.error ?? {
      code: "invalid_error_response",
      message: "server returned an error without an error body",
      retryable: false,
    };
    super(body.message);
    this.name = "ProtocolResponseError";
    this.code = body.code;
    this.retryable = body.retryable;
    this.details = body.details;
    this.response = response;
  }
}

interface PendingRequest {
  resolve: (response: ResponseEnvelope) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export type ClientEventListener = (event: EventEnvelope) => void;

export class PiDaemonClient {
  readonly socketPath: string;
  readonly #socket: Socket;
  readonly #decoder: NdjsonDecoder;
  readonly #requestTimeoutMs: number;
  readonly #pending = new Map<string, PendingRequest>();
  readonly #listeners = new Set<ClientEventListener>();
  #closed = false;

  private constructor(
    socket: Socket,
    socketPath: string,
    maxLineBytes: number,
    requestTimeoutMs: number,
  ) {
    this.#socket = socket;
    this.socketPath = socketPath;
    this.#decoder = new NdjsonDecoder(maxLineBytes);
    this.#requestTimeoutMs = requestTimeoutMs;
    socket.on("data", (chunk) =>
      this.#onData(typeof chunk === "string" ? Buffer.from(chunk) : chunk),
    );
    socket.on("error", (error) => this.#fail(error));
    socket.on("close", () => this.#fail(new Error("pi-daemon connection closed")));
  }

  static async connect(options: PiDaemonClientOptions): Promise<PiDaemonClient> {
    const timeoutMs = options.connectTimeoutMs ?? 5_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
      throw new Error("connectTimeoutMs must be a positive safe integer");
    }
    const requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1) {
      throw new Error("requestTimeoutMs must be a positive safe integer");
    }
    const socket = createConnection(options.socketPath);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new PiDaemonClientTimeoutError(
          `timed out connecting to pi-daemon at ${options.socketPath}`,
          "connect",
        ));
      }, timeoutMs);
      const cleanup = (): void => {
        clearTimeout(timer);
        socket.off("connect", onConnect);
        socket.off("error", onError);
      };
      const onConnect = (): void => {
        cleanup();
        resolve();
      };
      const onError = (error: Error): void => {
        cleanup();
        reject(error);
      };
      socket.once("connect", onConnect);
      socket.once("error", onError);
    });
    socket.setNoDelay(true);
    return new PiDaemonClient(
      socket,
      options.socketPath,
      options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES,
      requestTimeoutMs,
    );
  }

  get closed(): boolean {
    return this.#closed;
  }

  subscribe(listener: ClientEventListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  request(commandValue: unknown): Promise<ResponseEnvelope> {
    if (this.#closed) return Promise.reject(new Error("pi-daemon client is closed"));
    let command: ProtocolCommand;
    try {
      command = parseSupportedProtocolCommand(commandValue);
    } catch (error) {
      return Promise.reject(error);
    }
    if (this.#pending.has(command.requestId)) {
      return Promise.reject(new Error(`requestId is already in flight: ${command.requestId}`));
    }

    const promise = new Promise<ResponseEnvelope>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(command.requestId);
        reject(new PiDaemonClientTimeoutError(
          `timed out waiting for pi-daemon response: ${command.requestId}`,
          "request",
        ));
      }, this.#requestTimeoutMs);
      this.#pending.set(command.requestId, { resolve, reject, timer });
    });
    const accepted = this.#socket.write(encodeLine(command), "utf8", (error) => {
      if (error === null || error === undefined) return;
      const pending = this.#pending.get(command.requestId);
      this.#pending.delete(command.requestId);
      if (pending !== undefined) clearTimeout(pending.timer);
      pending?.reject(error);
    });
    if (!accepted) this.#socket.once("drain", () => {});
    return promise;
  }

  /**
   * Perform one handshake at an explicit protocol version.
   *
   * The version is significant: a host only advertises its v2 capability set
   * (`configuredOpen`, `sessionDir`, `hostToolAdapter`,
   * `hostToolOperationCount`, `supportedProtocolVersions`) when the REQUEST
   * declares a 2.x version. Asking at "1.0" therefore cannot distinguish a
   * v1-only host from a fully v2-capable one, which is the exact distinction an
   * external orchestrator needs before it relies on configured opens.
   *
   * Defaults to v1 so existing callers keep their exact wire behavior; use
   * {@link negotiateHandshake} to discover the best version a host supports.
   */
  async handshake(
    requestId = "handshake",
    protocolVersion: string = PROTOCOL_VERSION,
  ): Promise<ResponseEnvelope> {
    return this.request({
      protocolVersion,
      requestId,
      operation: "handshake",
      payload: {},
    });
  }

  /**
   * Handshake at the highest version this client understands, falling back to
   * v1 when the host cannot answer a 2.x request.
   *
   * Fallback is deliberately conservative: it triggers only when the v2 attempt
   * fails outright, never when the host answers successfully. A v1-only host
   * that rejects the 2.x request still yields a truthful v1 result rather than
   * a hard error, so this is safe to use against any host generation.
   */
  async negotiateHandshake(
    requestId = "handshake",
  ): Promise<{ response: ResponseEnvelope; requestedProtocolVersion: string }> {
    try {
      const response = await this.handshake(requestId, PROTOCOL_V2_VERSION);
      if (response.ok !== false) {
        return { response, requestedProtocolVersion: PROTOCOL_V2_VERSION };
      }
    } catch {
      // Fall through to the v1 attempt below; a host that cannot parse or
      // accept a 2.x handshake must still be probeable.
    }
    return {
      response: await this.handshake(requestId, PROTOCOL_VERSION),
      requestedProtocolVersion: PROTOCOL_VERSION,
    };
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#socket.end();
    this.#rejectPending(new Error("pi-daemon client closed"));
  }

  #onData(chunk: Buffer): void {
    let values: unknown[];
    try {
      values = this.#decoder.push(chunk);
    } catch (error) {
      this.#socket.destroy();
      this.#fail(error instanceof Error ? error : new Error("invalid protocol response"));
      return;
    }
    for (const value of values) this.#handleValue(value);
  }

  #handleValue(value: unknown): void {
    if (isEventEnvelope(value)) {
      for (const listener of this.#listeners) {
        try {
          listener(value);
        } catch {
          // A consumer callback cannot break protocol progress.
        }
      }
      return;
    }
    if (!isResponseEnvelope(value)) {
      this.#socket.destroy();
      this.#fail(new Error("server returned an invalid protocol envelope"));
      return;
    }
    const pending = this.#pending.get(value.requestId);
    if (pending === undefined) return;
    this.#pending.delete(value.requestId);
    clearTimeout(pending.timer);
    if (value.ok) pending.resolve(value);
    else pending.reject(new ProtocolResponseError(value));
  }

  #fail(error: Error): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#rejectPending(error);
  }

  #rejectPending(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }
}

function isResponseEnvelope(value: unknown): value is ResponseEnvelope {
  if (!isRecord(value)) return false;
  return (
    value.kind === "response" &&
    typeof value.protocolVersion === "string" &&
    typeof value.requestId === "string" &&
    typeof value.hostInstanceId === "string" &&
    typeof value.ok === "boolean" &&
    (value.ok || isProtocolError(value.error))
  );
}

function isEventEnvelope(value: unknown): value is EventEnvelope {
  if (!isRecord(value)) return false;
  return (
    value.kind === "event" &&
    typeof value.protocolVersion === "string" &&
    typeof value.event === "string" &&
    typeof value.hostInstanceId === "string" &&
    typeof value.sessionId === "string" &&
    Number.isSafeInteger(value.generation) &&
    Number.isSafeInteger(value.sequence)
  );
}

function isProtocolError(value: unknown): value is ProtocolErrorBody {
  return (
    isRecord(value) &&
    typeof value.code === "string" &&
    typeof value.message === "string" &&
    typeof value.retryable === "boolean"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
