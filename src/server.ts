import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, rm } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";

import { Multiplexer, MultiplexerError } from "./multiplexer.js";
import {
  DEFAULT_MAX_LINE_BYTES,
  NdjsonDecoder,
  PROTOCOL_VERSION,
  ProtocolValidationError,
  encodeLine,
  errorResponse,
  parseCommand,
  successResponse,
  type EventEnvelope,
  type ProtocolCommand,
  type ProtocolErrorBody,
  type ResponseEnvelope,
} from "./protocol.js";
import { PI_DAEMON_VERSION } from "./version.js";

export interface ProtocolServerLimits {
  maxConnections: number;
  maxInFlightRequestsPerConnection: number;
  maxLineBytes: number;
  maxOutboundBytesPerConnection: number;
}

export const DEFAULT_PROTOCOL_SERVER_LIMITS: Readonly<ProtocolServerLimits> = {
  maxConnections: 64,
  maxInFlightRequestsPerConnection: 64,
  maxLineBytes: DEFAULT_MAX_LINE_BYTES,
  maxOutboundBytesPerConnection: 4 * 1024 * 1024,
};

export interface ProtocolServerOptions {
  socketPath: string;
  multiplexer: Multiplexer;
  limits?: Partial<ProtocolServerLimits>;
}

interface SocketIdentity {
  dev: number;
  ino: number;
}

class ConnectionWriter {
  readonly #socket: Socket;
  readonly #maxOutboundBytes: number;
  readonly #queue: Buffer[] = [];
  #queuedBytes = 0;
  #blocked = false;
  #closed = false;
  #endRequested = false;

  constructor(socket: Socket, maxOutboundBytes: number) {
    this.#socket = socket;
    this.#maxOutboundBytes = maxOutboundBytes;
    socket.on("drain", () => this.#flush());
    socket.on("close", () => {
      this.#closed = true;
      this.#queue.length = 0;
      this.#queuedBytes = 0;
    });
  }

  send(value: unknown): boolean {
    if (this.#closed || this.#socket.destroyed) return false;
    const line = Buffer.from(encodeLine(value), "utf8");
    if (line.length > this.#maxOutboundBytes) return this.#overflow();

    if (!this.#blocked && this.#queue.length === 0) {
      if (this.#socket.writableLength + line.length > this.#maxOutboundBytes) {
        return this.#overflow();
      }
      this.#blocked = !this.#socket.write(line);
      return true;
    }

    if (this.#queuedBytes + line.length > this.#maxOutboundBytes) return this.#overflow();
    this.#queue.push(line);
    this.#queuedBytes += line.length;
    return true;
  }

  end(): void {
    if (this.#closed || this.#socket.destroyed) return;
    this.#endRequested = true;
    if (!this.#blocked && this.#queue.length === 0) this.#socket.end();
  }

  #flush(): void {
    if (this.#closed) return;
    this.#blocked = false;
    while (this.#queue.length > 0) {
      const line = this.#queue.shift()!;
      this.#queuedBytes -= line.length;
      if (this.#socket.writableLength + line.length > this.#maxOutboundBytes) {
        this.#overflow();
        return;
      }
      if (!this.#socket.write(line)) {
        this.#blocked = true;
        return;
      }
    }
    if (this.#endRequested) this.#socket.end();
  }

  #overflow(): false {
    this.#closed = true;
    this.#queue.length = 0;
    this.#queuedBytes = 0;
    this.#socket.destroy(new Error("bounded outbound queue exceeded"));
    return false;
  }
}

interface ClientConnection {
  id: string;
  socket: Socket;
  writer: ConnectionWriter;
  decoder: NdjsonDecoder;
  requestIds: Set<string>;
  subscribedSessions: Map<string, number>;
  closed: boolean;
}

export class ProtocolServer {
  readonly socketPath: string;
  readonly limits: ProtocolServerLimits;
  readonly #multiplexer: Multiplexer;
  readonly #server: Server;
  readonly #connections = new Set<ClientConnection>();
  readonly #unsubscribe: () => void;
  #socketIdentity: SocketIdentity | undefined;
  #started = false;

  constructor(options: ProtocolServerOptions) {
    if (options.socketPath.length === 0) throw new Error("socketPath must not be empty");
    this.socketPath = options.socketPath;
    this.#multiplexer = options.multiplexer;
    this.limits = {
      maxConnections: positiveInteger(
        options.limits?.maxConnections ?? DEFAULT_PROTOCOL_SERVER_LIMITS.maxConnections,
        "maxConnections",
      ),
      maxInFlightRequestsPerConnection: positiveInteger(
        options.limits?.maxInFlightRequestsPerConnection ??
          DEFAULT_PROTOCOL_SERVER_LIMITS.maxInFlightRequestsPerConnection,
        "maxInFlightRequestsPerConnection",
      ),
      maxLineBytes: positiveInteger(
        options.limits?.maxLineBytes ?? DEFAULT_PROTOCOL_SERVER_LIMITS.maxLineBytes,
        "maxLineBytes",
      ),
      maxOutboundBytesPerConnection: positiveInteger(
        options.limits?.maxOutboundBytesPerConnection ??
          DEFAULT_PROTOCOL_SERVER_LIMITS.maxOutboundBytesPerConnection,
        "maxOutboundBytesPerConnection",
      ),
    };
    this.#server = createServer((socket) => this.#accept(socket));
    this.#unsubscribe = this.#multiplexer.subscribe((event) => this.#publishEvent(event));
  }

  get connectionCount(): number {
    return this.#connections.size;
  }

  async start(): Promise<void> {
    if (this.#started) throw new Error("protocol server is already started");
    const socketDirectory = dirname(this.socketPath);
    await mkdir(socketDirectory, { recursive: true, mode: 0o700 });
    await validatePrivateDirectory(socketDirectory, "socket directory");
    await prepareSocketPath(this.socketPath);
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
      this.#server.listen(this.socketPath);
    });
    await chmod(this.socketPath, 0o600);
    const socketStat = await lstat(this.socketPath);
    this.#socketIdentity = { dev: socketStat.dev, ino: socketStat.ino };
    this.#started = true;
  }

  async stop(): Promise<void> {
    if (!this.#started) {
      this.#unsubscribe();
      return;
    }
    this.#started = false;
    for (const connection of this.#connections) connection.socket.destroy();
    await new Promise<void>((resolve, reject) => {
      this.#server.close((error) => (error === undefined ? resolve() : reject(error)));
    });
    this.#unsubscribe();
    await removeOwnedSocket(this.socketPath, this.#socketIdentity);
    this.#socketIdentity = undefined;
  }

  #accept(socket: Socket): void {
    if (this.#connections.size >= this.limits.maxConnections) {
      socket.destroy(new Error("connection capacity reached"));
      return;
    }
    socket.setNoDelay(true);
    const connection: ClientConnection = {
      id: randomUUID(),
      socket,
      writer: new ConnectionWriter(socket, this.limits.maxOutboundBytesPerConnection),
      decoder: new NdjsonDecoder(this.limits.maxLineBytes),
      requestIds: new Set(),
      subscribedSessions: new Map(),
      closed: false,
    };
    this.#connections.add(connection);
    socket.on("data", (chunk) => this.#onData(connection, chunk));
    socket.on("error", () => {});
    socket.on("close", () => {
      connection.closed = true;
      this.#connections.delete(connection);
    });
  }

  #onData(connection: ClientConnection, chunk: Buffer): void {
    if (connection.closed) return;
    let values: unknown[];
    try {
      values = connection.decoder.push(chunk);
    } catch (error) {
      this.#sendError(connection, fallbackRequestId(undefined), error);
      this.#endConnection(connection);
      return;
    }
    for (const value of values) this.#handleValue(connection, value);
  }

  #handleValue(connection: ClientConnection, value: unknown): void {
    let command: ProtocolCommand;
    try {
      command = parseCommand(value);
    } catch (error) {
      const requestId = fallbackRequestId(extractRequestId(value));
      this.#sendError(connection, requestId, error);
      if (error instanceof ProtocolValidationError && error.code === "incompatible_protocol") {
        this.#endConnection(connection);
      }
      return;
    }

    if (connection.requestIds.has(command.requestId)) {
      this.#sendError(
        connection,
        command.requestId,
        new ProtocolValidationError("duplicate_request_id", "requestId is already in flight"),
      );
      return;
    }
    if (connection.requestIds.size >= this.limits.maxInFlightRequestsPerConnection) {
      this.#sendError(
        connection,
        command.requestId,
        new MultiplexerError("connection_busy", "connection request capacity reached", {
          retryable: true,
        }),
      );
      return;
    }

    connection.requestIds.add(command.requestId);
    void this.#dispatch(connection, command)
      .then((response) => connection.writer.send(response))
      .catch((error) => this.#sendError(connection, command.requestId, error, command))
      .finally(() => connection.requestIds.delete(command.requestId));
  }

  async #dispatch(
    connection: ClientConnection,
    command: ProtocolCommand,
  ): Promise<ResponseEnvelope> {
    switch (command.operation) {
      case "handshake":
        return successResponse(command.requestId, this.#multiplexer.hostInstanceId, {
          protocolVersion: PROTOCOL_VERSION,
          packageVersion: PI_DAEMON_VERSION,
          nodeVersion: process.version,
          capabilities: {
            operations: [
              "handshake",
              "open",
              "wake",
              "steer",
              "followUp",
              "status",
              "abort",
              "attach",
              "detach",
              "close",
              "drain",
            ],
            transport: "unix-ndjson",
            durable: this.#multiplexer.status().durable,
          },
          limits: {
            ...this.limits,
            multiplexer: this.#multiplexer.limits,
          },
          host: this.#multiplexer.status(),
        });
      case "open": {
        const result = await this.#multiplexer.open(command);
        return successResponse(command.requestId, this.#multiplexer.hostInstanceId, result, {
          sessionId: command.sessionId,
          sequence: result.session.sequence,
        });
      }
      case "wake": {
        const result = await this.#multiplexer.wake(command);
        return successResponse(command.requestId, this.#multiplexer.hostInstanceId, result, {
          sessionId: command.sessionId,
          sequence: result.session.sequence,
        });
      }
      case "steer":
        await this.#multiplexer.steer(command);
        return successResponse(command.requestId, this.#multiplexer.hostInstanceId, { queued: true }, {
          sessionId: command.sessionId,
        });
      case "followUp":
        await this.#multiplexer.followUp(command);
        return successResponse(command.requestId, this.#multiplexer.hostInstanceId, { queued: true }, {
          sessionId: command.sessionId,
        });
      case "status": {
        const status =
          command.sessionId === undefined
            ? this.#multiplexer.status()
            : this.#multiplexer.status(command.sessionId);
        return successResponse(
          command.requestId,
          this.#multiplexer.hostInstanceId,
          status,
          command.sessionId === undefined ? {} : { sessionId: command.sessionId },
        );
      }
      case "abort": {
        const aborted = await this.#multiplexer.abort(command);
        return successResponse(command.requestId, this.#multiplexer.hostInstanceId, { aborted }, {
          sessionId: command.sessionId,
        });
      }
      case "attach": {
        const session = this.#sessionForGeneration(command.sessionId, command.generation);
        connection.subscribedSessions.set(command.sessionId, command.generation);
        return successResponse(
          command.requestId,
          this.#multiplexer.hostInstanceId,
          { attached: true, generation: command.generation, sequence: session.sequence },
          { sessionId: command.sessionId, sequence: session.sequence },
        );
      }
      case "detach": {
        const session = this.#sessionForGeneration(command.sessionId, command.generation);
        const detached = connection.subscribedSessions.get(command.sessionId) === command.generation;
        if (detached) connection.subscribedSessions.delete(command.sessionId);
        return successResponse(
          command.requestId,
          this.#multiplexer.hostInstanceId,
          { detached, generation: command.generation, sequence: session.sequence },
          { sessionId: command.sessionId, sequence: session.sequence },
        );
      }
      case "close": {
        const closed = await this.#multiplexer.close(command);
        this.#clearSessionSubscriptions(command.sessionId);
        return successResponse(command.requestId, this.#multiplexer.hostInstanceId, { closed }, {
          sessionId: command.sessionId,
        });
      }
      case "drain": {
        const timeoutMs = command.payload.timeoutMs ?? 30_000;
        const result = await this.#multiplexer.drain(timeoutMs);
        return successResponse(command.requestId, this.#multiplexer.hostInstanceId, {
          draining: true,
          timeoutMs,
          ...result,
        });
      }
    }
  }

  #publishEvent(event: EventEnvelope): void {
    for (const connection of this.#connections) {
      if (connection.subscribedSessions.get(event.sessionId) === event.generation) {
        connection.writer.send(event);
      }
    }
  }

  #clearSessionSubscriptions(sessionId: string): void {
    for (const current of this.#connections) current.subscribedSessions.delete(sessionId);
  }

  #sessionForGeneration(sessionId: string, generation: number) {
    const session = this.#multiplexer.status(sessionId);
    if (session.generation !== generation) {
      throw new MultiplexerError("stale_generation", "session generation does not match", {
        details: { currentGeneration: session.generation, receivedGeneration: generation },
      });
    }
    return session;
  }

  #endConnection(connection: ClientConnection): void {
    if (connection.closed) return;
    connection.closed = true;
    connection.socket.pause();
    connection.writer.end();
  }

  #sendError(
    connection: ClientConnection,
    requestId: string,
    error: unknown,
    command?: ProtocolCommand,
  ): void {
    const body = protocolError(error);
    const options: { sessionId?: string } = {};
    if (command !== undefined && "sessionId" in command && typeof command.sessionId === "string") {
      options.sessionId = command.sessionId;
    }
    connection.writer.send(
      errorResponse(requestId, this.#multiplexer.hostInstanceId, body, options),
    );
  }
}

function protocolError(error: unknown): ProtocolErrorBody {
  if (error instanceof ProtocolValidationError) {
    return {
      code: error.code,
      message: error.message,
      retryable: false,
      ...(error.details === undefined ? {} : { details: error.details }),
    };
  }
  if (error instanceof MultiplexerError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      ...(error.details === undefined ? {} : { details: error.details }),
    };
  }
  return {
    code: "internal_error",
    message: "internal server error",
    retryable: false,
  };
}

function extractRequestId(value: unknown): string | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const requestId = (value as Record<string, unknown>).requestId;
  return typeof requestId === "string" && requestId.length > 0 && requestId.length <= 128
    ? requestId
    : undefined;
}

function fallbackRequestId(requestId: string | undefined): string {
  return requestId ?? `invalid-${randomUUID()}`;
}

async function validatePrivateDirectory(path: string, label: string): Promise<void> {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`${label} must be a real directory: ${path}`);
  }
  const getuid = process.getuid;
  if (getuid !== undefined && info.uid !== getuid()) {
    throw new Error(`${label} must be owned by the current user: ${path}`);
  }
  if ((info.mode & 0o022) !== 0) {
    throw new Error(`${label} must not be group/world writable: ${path}`);
  }
}

async function prepareSocketPath(path: string): Promise<void> {
  let existing;
  try {
    existing = await lstat(path);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return;
    throw error;
  }
  if (!existing.isSocket()) throw new Error(`refusing to replace non-socket path: ${path}`);
  const getuid = process.getuid;
  if (getuid !== undefined && existing.uid !== getuid()) {
    throw new Error(`refusing to replace socket not owned by current user: ${path}`);
  }

  const active = await socketIsActive(path);
  if (active) throw new Error(`socket is already active: ${path}`);
  await rm(path);
}

async function socketIsActive(path: string): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    const socket = createConnection(path);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`timed out probing existing socket: ${path}`));
    }, 1_000);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(true);
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      if (isNodeError(error) && ["ECONNREFUSED", "ENOENT"].includes(error.code ?? "")) {
        resolve(false);
      } else {
        reject(error);
      }
    });
  });
}

async function removeOwnedSocket(path: string, identity: SocketIdentity | undefined): Promise<void> {
  if (identity === undefined) return;
  try {
    const current = await lstat(path);
    if (current.isSocket() && current.dev === identity.dev && current.ino === identity.ino) {
      await rm(path);
    }
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${field} must be a positive safe integer`);
  }
  return value;
}
