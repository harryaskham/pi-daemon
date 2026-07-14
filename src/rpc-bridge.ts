import { isIP } from "node:net";
import type { Readable, Writable } from "node:stream";
import { TextDecoder } from "node:util";

import WebSocket, { type RawData } from "ws";

import { NdjsonDecoder, encodeBoundedLine } from "./protocol.js";
import type {
  PiRpcResponse,
  RpcAttachReadyFrame,
  RpcControlFrame,
  RpcEventFrame,
  RpcReplayGapFrame,
} from "./session-api.js";

export interface RpcStdioBridgeLimits {
  maxLineBytes: number;
  maxMessageBytes: number;
  maxPendingCommands: number;
  maxPendingBytes: number;
  maxOutputBytes: number;
  maxInFlightCommands: number;
  connectTimeoutMs: number;
  terminalDrainTimeoutMs: number;
  outputDrainTimeoutMs: number;
  reconnectAttempts: number;
  reconnectBaseDelayMs: number;
  reconnectMaxDelayMs: number;
}

export const DEFAULT_RPC_STDIO_BRIDGE_LIMITS: Readonly<RpcStdioBridgeLimits> = {
  maxLineBytes: 1024 * 1024,
  maxMessageBytes: 1024 * 1024,
  maxPendingCommands: 64,
  maxPendingBytes: 4 * 1024 * 1024,
  maxOutputBytes: 4 * 1024 * 1024,
  maxInFlightCommands: 8,
  connectTimeoutMs: 10_000,
  terminalDrainTimeoutMs: 5 * 60_000,
  outputDrainTimeoutMs: 5_000,
  reconnectAttempts: 8,
  reconnectBaseDelayMs: 100,
  reconnectMaxDelayMs: 5_000,
};

export interface RpcStdioBridgeOptions {
  baseUrl: string;
  sessionRef: string;
  bearerToken: string;
  input: Readable;
  output: Writable;
  statusOutput?: Writable;
  role?: "controller" | "observer";
  allowInsecureRemote?: boolean;
  limits?: Partial<RpcStdioBridgeLimits>;
  webSocketFactory?: RpcBridgeWebSocketFactory;
}

export interface RpcBridgeWebSocketOptions {
  headers: { Authorization: string };
  handshakeTimeout: number;
  maxPayload: number;
  perMessageDeflate: false;
}

export type RpcBridgeWebSocketFactory = (
  url: string,
  protocol: "pi-daemon-rpc.v1",
  options: RpcBridgeWebSocketOptions,
) => WebSocket;

export interface RpcStdioBridgeResult {
  code: number;
  reconnects: number;
  gaps: number;
  lastCursor?: string;
}

interface PendingCommand {
  value: unknown;
  bytes: number;
  command: string;
  id: string | undefined;
}

interface ConnectionClose {
  code: number;
  opened: boolean;
}

class RpcBridgeConnectionError extends Error {
  readonly retryable: boolean;

  constructor(message: string, retryable: boolean) {
    super(message);
    this.name = "RpcBridgeConnectionError";
    this.retryable = retryable;
  }
}

/**
 * Bridge stock Pi RPC JSONL on streams to one framed daemon attachment.
 *
 * The bridge intentionally uses the framed protocol internally so a reconnect
 * can resume from an opaque daemon cursor. Only stock Pi RPC responses/events
 * are written to stdout; daemon attach, control, replay, and lifecycle status
 * stays on the separate status stream.
 */
export class RpcStdioBridge {
  readonly limits: RpcStdioBridgeLimits;
  readonly #baseUrl: URL;
  readonly #sessionRef: string;
  readonly #bearerToken: string;
  readonly #input: Readable;
  readonly #role: "controller" | "observer";
  readonly #socketFactory: RpcBridgeWebSocketFactory;
  readonly #decoder: NdjsonDecoder;
  readonly #output: BoundedWriter;
  readonly #status: BoundedWriter | undefined;
  readonly #pending: PendingCommand[] = [];
  readonly #inFlight: PendingCommand[] = [];
  #retainedInputBytes = 0;
  #socket: WebSocket | undefined;
  #ready = false;
  #sending = false;
  #inputEnded = false;
  #stopping = false;
  #failed = false;
  #lastCursor: string | undefined;
  #reconnects = 0;
  #gaps = 0;
  #wakeDelay: (() => void) | undefined;
  #terminalDrainTimer: NodeJS.Timeout | undefined;

  constructor(options: RpcStdioBridgeOptions) {
    this.limits = resolveLimits(options.limits);
    this.#baseUrl = parseBaseUrl(options.baseUrl, options.allowInsecureRemote === true);
    this.#sessionRef = sessionReference(options.sessionRef);
    this.#bearerToken = bearer(options.bearerToken);
    this.#input = options.input;
    this.#role = options.role ?? "controller";
    this.#socketFactory = options.webSocketFactory ?? defaultWebSocketFactory;
    this.#decoder = new NdjsonDecoder(this.limits.maxLineBytes);
    this.#output = new BoundedWriter(options.output, this.limits.maxOutputBytes, () => {
      this.#fail("stdout backpressure limit exceeded");
    });
    this.#status =
      options.statusOutput === undefined
        ? undefined
        : new BoundedWriter(options.statusOutput, 64 * 1024, () => {
            this.#fail("status output backpressure limit exceeded");
          });
  }

  async run(): Promise<RpcStdioBridgeResult> {
    this.#listenInput();
    let attempts = 0;
    while (!this.#stopping) {
      if (this.#inputEnded && this.#pending.length === 0 && this.#inFlight.length === 0) break;
      try {
        const close = await this.#oneConnection();
        if (this.#stopping) break;
        this.#failInFlight("connection_lost_indeterminate");
        if (this.#inputEnded && this.#pending.length === 0) break;
        if (close.opened) attempts = 0;
        attempts += 1;
        if (attempts > this.limits.reconnectAttempts) {
          this.#fail("RPC reconnect attempts exhausted");
          break;
        }
        this.#reconnects += 1;
        this.#writeStatus("reconnecting", { attempt: attempts, closeCode: close.code });
        await this.#delay(reconnectDelay(attempts, this.limits));
      } catch (error) {
        if (this.#stopping) break;
        const retryable =
          !(error instanceof RpcBridgeConnectionError) || error.retryable;
        attempts += 1;
        if (!retryable || attempts > this.limits.reconnectAttempts) {
          this.#fail(
            retryable ? "RPC reconnect attempts exhausted" : "RPC attachment rejected",
          );
          break;
        }
        this.#reconnects += 1;
        this.#writeStatus("reconnecting", { attempt: attempts });
        await this.#delay(reconnectDelay(attempts, this.limits));
      }
    }
    this.stop();
    const [outputDrained, statusDrained] = await Promise.all([
      this.#output.settled(this.limits.outputDrainTimeoutMs),
      this.#status?.settled(this.limits.outputDrainTimeoutMs) ?? Promise.resolve(true),
    ]);
    if (!outputDrained || !statusDrained) this.#failed = true;
    return {
      code: this.#failed ? 1 : 0,
      reconnects: this.#reconnects,
      gaps: this.#gaps,
      ...(this.#lastCursor === undefined ? {} : { lastCursor: this.#lastCursor }),
    };
  }

  stop(): void {
    if (this.#stopping) return;
    this.#stopping = true;
    this.#input.pause();
    if (this.#terminalDrainTimer !== undefined) clearTimeout(this.#terminalDrainTimer);
    this.#terminalDrainTimer = undefined;
    if (this.#socket !== undefined) closeSocket(this.#socket, 1000, "stdio bridge stopping");
    this.#wakeDelay?.();
    this.#wakeDelay = undefined;
  }

  #listenInput(): void {
    this.#input.on("data", (chunk: Buffer | string) => {
      if (this.#stopping) return;
      try {
        const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
        for (const value of this.#decoder.push(bytes)) this.#enqueue(value);
      } catch {
        this.#fail("stdin is not bounded valid RPC JSONL");
      }
    });
    this.#input.once("end", () => {
      if (this.#stopping) return;
      try {
        for (const value of this.#decoder.finish()) this.#enqueue(value);
      } catch {
        this.#fail("stdin is not bounded valid RPC JSONL");
        return;
      }
      this.#inputEnded = true;
      this.#armTerminalDrainDeadline();
      this.#finishIfDrained();
    });
    this.#input.once("error", () => this.#fail("stdin failed"));
  }

  #enqueue(value: unknown): void {
    const encoded = encodeBoundedLine(value, this.limits.maxLineBytes);
    if (
      this.#pending.length + this.#inFlight.length >= this.limits.maxPendingCommands ||
      this.#retainedInputBytes + encoded.length > this.limits.maxPendingBytes
    ) {
      this.#fail("pending RPC input limit exceeded");
      return;
    }
    const pending: PendingCommand = {
      value,
      bytes: encoded.length,
      command: commandType(value),
      id: commandId(value),
    };
    this.#pending.push(pending);
    this.#retainedInputBytes += pending.bytes;
    this.#flush();
  }

  async #oneConnection(): Promise<ConnectionClose> {
    const url = this.#attachmentUrl();
    const socket = this.#socketFactory(url, "pi-daemon-rpc.v1", {
      headers: { Authorization: `Bearer ${this.#bearerToken}` },
      handshakeTimeout: this.limits.connectTimeoutMs,
      maxPayload: this.limits.maxMessageBytes,
      perMessageDeflate: false,
    });
    this.#socket = socket;
    this.#ready = false;
    this.#sending = false;
    let opened = false;
    let settled = false;
    return await new Promise<ConnectionClose>((resolve, reject) => {
      const finishResolve = (code: number): void => {
        if (settled) return;
        settled = true;
        this.#ready = false;
        this.#sending = false;
        if (this.#socket === socket) this.#socket = undefined;
        resolve({ code, opened });
      };
      const finishReject = (error: Error): void => {
        if (settled) return;
        settled = true;
        this.#ready = false;
        this.#sending = false;
        if (this.#socket === socket) this.#socket = undefined;
        socket.terminate();
        reject(error);
      };
      socket.once("open", () => {
        opened = true;
      });
      socket.on("message", (data, isBinary) => {
        if (isBinary) {
          finishReject(new RpcBridgeConnectionError("binary RPC frame", false));
          return;
        }
        this.#onSocketMessage(data);
      });
      socket.once("unexpected-response", (_request, response) => {
        const status = response.statusCode ?? 0;
        response.resume();
        finishReject(
          new RpcBridgeConnectionError(
            "RPC attachment HTTP handshake rejected",
            status >= 500 || [404, 408, 409, 429].includes(status),
          ),
        );
      });
      socket.once("error", () => {
        if (!opened) finishReject(new RpcBridgeConnectionError("RPC connection failed", true));
      });
      socket.once("close", (code) => finishResolve(code));
    });
  }

  #onSocketMessage(data: RawData): void {
    let value: unknown;
    try {
      const bytes = rawDataBuffer(data);
      if (bytes.length > this.limits.maxMessageBytes) throw new Error("message too large");
      value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
    } catch {
      this.#fail("daemon sent invalid RPC frame");
      return;
    }
    const kind = frameKind(value);
    switch (kind) {
      case "attach_ready":
        this.#onReady(value as RpcAttachReadyFrame);
        return;
      case "replay_gap":
        this.#onGap(value as RpcReplayGapFrame);
        return;
      case "event": {
        const frame = value as RpcEventFrame;
        if (typeof frame.cursor !== "string") {
          this.#fail("daemon sent invalid event cursor");
          return;
        }
        this.#lastCursor = frame.cursor;
        this.#output.write(frame.event);
        return;
      }
      case "response": {
        const response = (value as { response?: unknown }).response;
        if (!isObject(response)) {
          this.#fail("daemon sent invalid RPC response");
          return;
        }
        this.#settleInFlight(response);
        this.#output.write(response);
        this.#flush();
        this.#finishIfDrained();
        return;
      }
      case "control":
        this.#onControl(value as RpcControlFrame);
        return;
      default:
        this.#fail("daemon sent unknown RPC frame");
    }
  }

  #onReady(frame: RpcAttachReadyFrame): void {
    if (
      typeof frame.connectionId !== "string" ||
      typeof frame.highWaterCursor !== "string" ||
      typeof frame.generation !== "number" ||
      typeof frame.sessionId !== "string" ||
      frame.sessionId.length === 0
    ) {
      this.#fail("daemon sent invalid attach state");
      return;
    }
    if (this.#role === "controller" && frame.role !== "controller") {
      this.#fail("RPC controller attachment is busy");
      return;
    }
    this.#lastCursor = frame.highWaterCursor;
    this.#ready = true;
    this.#writeStatus("attached", {
      role: frame.role,
      generation: frame.generation,
      replayCursor: frame.highWaterCursor,
    });
    this.#flush();
    this.#finishIfDrained();
  }

  #onGap(frame: RpcReplayGapFrame): void {
    if (
      !["cursor_expired", "host_restarted", "generation_changed"].includes(frame.reason)
    ) {
      this.#fail("daemon sent invalid replay gap");
      return;
    }
    this.#gaps += 1;
    this.#writeStatus("replay_gap", { reason: frame.reason, snapshotFollows: true });
  }

  #onControl(frame: RpcControlFrame): void {
    if (frame.action === "control_denied" && this.#role === "controller") {
      this.#fail("RPC controller attachment is busy");
      return;
    }
    this.#writeStatus("control", { action: frame.action });
  }

  #flush(): void {
    const socket = this.#socket;
    if (
      this.#stopping ||
      this.#failed ||
      !this.#ready ||
      this.#sending ||
      socket === undefined ||
      socket.readyState !== WebSocket.OPEN ||
      this.#pending.length === 0 ||
      this.#inFlight.length >= this.limits.maxInFlightCommands
    ) {
      return;
    }
    const pending = this.#pending.shift()!;
    const frame = isExtensionUiResponse(pending.value)
      ? { kind: "extension_ui_response", response: pending.value }
      : { kind: "command", command: pending.value };
    let text: string;
    try {
      const encoded = encodeBoundedLine(frame, this.limits.maxMessageBytes);
      text = encoded.subarray(0, encoded.length - 1).toString("utf8");
    } catch {
      this.#fail("RPC command frame exceeds message limit");
      return;
    }
    if (!isExtensionUiResponse(pending.value)) this.#inFlight.push(pending);
    else this.#retainedInputBytes -= pending.bytes;
    this.#sending = true;
    socket.send(text, (error) => {
      this.#sending = false;
      if (error != null) {
        this.#fail("RPC socket write failed");
        return;
      }
      this.#flush();
    });
  }

  #settleInFlight(response: Record<string, unknown>): void {
    const id = response.id;
    const command = typeof response.command === "string" ? response.command : undefined;
    let index = -1;
    if (id !== undefined) index = this.#inFlight.findIndex((item) => Object.is(item.id, id));
    if (index < 0 && command !== undefined) {
      index = this.#inFlight.findIndex((item) => item.command === command);
    }
    if (index >= 0) {
      const [settled] = this.#inFlight.splice(index, 1);
      this.#retainedInputBytes -= settled!.bytes;
    }
  }

  #failInFlight(error: string): void {
    for (const pending of this.#inFlight.splice(0)) {
      this.#retainedInputBytes -= pending.bytes;
      const response: PiRpcResponse = {
        type: "response",
        command: pending.command,
        success: false,
        error,
        ...(pending.id === undefined ? {} : { id: pending.id }),
      };
      this.#output.write(response);
    }
  }

  #finishIfDrained(): void {
    if (!this.#inputEnded || this.#pending.length > 0 || this.#inFlight.length > 0) return;
    if (this.#terminalDrainTimer !== undefined) clearTimeout(this.#terminalDrainTimer);
    this.#terminalDrainTimer = undefined;
    if (this.#socket !== undefined) closeSocket(this.#socket, 1000, "stdin ended");
    this.#wakeDelay?.();
  }

  #armTerminalDrainDeadline(): void {
    if (this.#terminalDrainTimer !== undefined || this.#stopping) return;
    this.#terminalDrainTimer = setTimeout(() => {
      this.#terminalDrainTimer = undefined;
      this.#fail("terminal RPC response deadline exceeded");
    }, this.limits.terminalDrainTimeoutMs);
  }

  #fail(message: string): void {
    if (this.#failed) return;
    this.#failed = true;
    this.#writeStatus("fatal", { message });
    this.#failInFlight("bridge_failed_indeterminate");
    this.stop();
  }

  #writeStatus(event: string, fields: Record<string, unknown>): void {
    this.#status?.write({ type: "pi_daemon_rpc_status", event, ...fields });
  }

  #attachmentUrl(): string {
    const url = new URL(this.#baseUrl);
    const prefix = url.pathname.endsWith("/") ? url.pathname.slice(0, -1) : url.pathname;
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = `${prefix}/v1/session/${encodeURIComponent(this.#sessionRef)}/rpc`;
    url.search = "";
    url.searchParams.set("role", this.#role);
    if (this.#lastCursor !== undefined) url.searchParams.set("cursor", this.#lastCursor);
    return url.toString();
  }

  async #delay(ms: number): Promise<void> {
    if (this.#stopping) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.#wakeDelay = undefined;
        resolve();
      }, ms);
      this.#wakeDelay = () => {
        clearTimeout(timer);
        this.#wakeDelay = undefined;
        resolve();
      };
    });
  }
}

class BoundedWriter {
  readonly #stream: Writable;
  readonly #maxBytes: number;
  readonly #onOverflow: () => void;
  readonly #queue: Buffer[] = [];
  #queuedBytes = 0;
  #blocked = false;

  constructor(stream: Writable, maxBytes: number, onOverflow: () => void) {
    this.#stream = stream;
    this.#maxBytes = maxBytes;
    this.#onOverflow = onOverflow;
    stream.on("drain", () => {
      this.#blocked = false;
      this.#flush();
    });
    stream.on("error", () => this.#onOverflow());
  }

  write(value: unknown): void {
    let line: Buffer;
    try {
      line = encodeBoundedLine(value, this.#maxBytes);
    } catch {
      this.#onOverflow();
      return;
    }
    if (this.#queuedBytes + line.length > this.#maxBytes) {
      this.#onOverflow();
      return;
    }
    this.#queue.push(line);
    this.#queuedBytes += line.length;
    this.#flush();
  }

  async settled(timeoutMs: number): Promise<boolean> {
    if (this.#queue.length === 0 && !this.#blocked) return true;
    return await new Promise<boolean>((resolve) => {
      const interval = setInterval(() => {
        if (this.#queue.length === 0 && !this.#blocked) finish(true);
      }, 1);
      const timeout = setTimeout(() => finish(false), timeoutMs);
      const finish = (drained: boolean): void => {
        clearInterval(interval);
        clearTimeout(timeout);
        resolve(drained);
      };
    });
  }

  #flush(): void {
    while (!this.#blocked && this.#queue.length > 0) {
      const line = this.#queue.shift()!;
      this.#queuedBytes -= line.length;
      this.#blocked = !this.#stream.write(line);
    }
  }
}

function resolveLimits(input: Partial<RpcStdioBridgeLimits> | undefined): RpcStdioBridgeLimits {
  const limits = { ...DEFAULT_RPC_STDIO_BRIDGE_LIMITS, ...input };
  for (const [key, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${key} must be a positive safe integer`);
  }
  if (limits.maxLineBytes > limits.maxPendingBytes) {
    throw new Error("maxLineBytes must not exceed maxPendingBytes");
  }
  if (limits.maxMessageBytes > limits.maxOutputBytes) {
    throw new Error("maxMessageBytes must not exceed maxOutputBytes");
  }
  return limits;
}

function parseBaseUrl(value: string, allowInsecureRemote: boolean): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("baseUrl must be an absolute HTTP(S) URL");
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username !== "" || url.password !== "") {
    throw new Error("baseUrl must be an HTTP(S) URL without credentials");
  }
  if (url.search !== "" || url.hash !== "") {
    throw new Error("baseUrl must not contain query or fragment components");
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const loopback = hostname === "::1" || (isIP(hostname) === 4 && hostname.startsWith("127."));
  if (url.protocol === "http:" && !loopback && !allowInsecureRemote) {
    throw new Error("remote plaintext RPC requires allowInsecureRemote");
  }
  return url;
}

function sessionReference(value: string): string {
  if (value.length < 1 || value.length > 256 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error("sessionRef must be a bounded nonempty ID or exact name");
  }
  return value;
}

function bearer(value: string): string {
  const bytes = Buffer.byteLength(value, "utf8");
  if (
    bytes < 16 ||
    bytes > 4096 ||
    !/^[A-Za-z0-9\-._~+/]+=*$/.test(value)
  ) {
    throw new Error("bearerToken is invalid");
  }
  return value;
}

function reconnectDelay(attempt: number, limits: RpcStdioBridgeLimits): number {
  return Math.min(
    limits.reconnectMaxDelayMs,
    limits.reconnectBaseDelayMs * 2 ** Math.min(attempt - 1, 20),
  );
}

function commandType(value: unknown): string {
  return isObject(value) && typeof value.type === "string" ? value.type : "unknown";
}

function commandId(value: unknown): string | undefined {
  return isObject(value) && typeof value.id === "string" ? value.id : undefined;
}

function isExtensionUiResponse(value: unknown): value is Record<string, unknown> {
  return isObject(value) && value.type === "extension_ui_response" && typeof value.id === "string";
}

function frameKind(value: unknown): string | undefined {
  return isObject(value) && typeof value.kind === "string" ? value.kind : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rawDataBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data as ArrayBuffer);
}

function closeSocket(socket: WebSocket, code: number, reason: string): void {
  try {
    socket.close(code, reason);
  } catch {
    try {
      socket.terminate();
    } catch {
      // The socket is already terminal.
    }
  }
}

const defaultWebSocketFactory: RpcBridgeWebSocketFactory = (url, protocol, options) =>
  new WebSocket(url, protocol, options);
