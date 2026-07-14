import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { TextDecoder } from "node:util";

import {
  ProtocolSerializationError,
  encodeBoundedLine,
} from "./protocol.js";

export interface WebSocketLimits {
  maxMessageBytes: number;
  maxOutboundBytes: number;
  keepAliveMs: number;
}

export interface WebSocketAcceptOptions {
  protocol: string;
  limits: WebSocketLimits;
}

export class WebSocketHandshakeError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "WebSocketHandshakeError";
    this.status = status;
    this.code = code;
  }
}

export class WebSocketPeer {
  readonly protocol: string;
  readonly #socket: Duplex;
  readonly #limits: WebSocketLimits;
  readonly #decoder = new TextDecoder("utf-8", { fatal: true });
  readonly #queue: Buffer[] = [];
  #buffer = Buffer.alloc(0);
  #queuedBytes = 0;
  #blocked = false;
  #closed = false;
  #fragmentOpcode: number | undefined;
  #fragmentBytes = 0;
  #fragments: Buffer[] = [];
  #awaitingPong = false;
  #keepAlive: NodeJS.Timeout | undefined;
  #onMessage: ((text: string) => void) | undefined;
  #onClose: (() => void) | undefined;

  constructor(socket: Duplex, options: WebSocketAcceptOptions) {
    this.#socket = socket;
    this.protocol = options.protocol;
    this.#limits = options.limits;
    socket.on("data", (chunk: Buffer) => this.#read(chunk));
    socket.on("drain", () => this.#flush());
    socket.on("close", () => this.#finish());
    socket.on("end", () => this.#finish());
    socket.on("error", () => this.#finish());
    this.#keepAlive = setInterval(() => this.#ping(), this.#limits.keepAliveMs);
    this.#keepAlive.unref();
  }

  get closed(): boolean {
    return this.#closed;
  }

  setHandlers(options: { onMessage: (text: string) => void; onClose: () => void }): void {
    this.#onMessage = options.onMessage;
    this.#onClose = options.onClose;
  }

  sendJson(value: unknown): ProtocolSerializationError | undefined {
    if (this.#closed) return undefined;
    let encoded: Buffer;
    try {
      const line = encodeBoundedLine(value, this.#limits.maxMessageBytes);
      encoded = line.subarray(0, line.length - 1);
    } catch (error) {
      if (error instanceof ProtocolSerializationError) return error;
      return new ProtocolSerializationError(
        "outbound_not_serializable",
        "WebSocket message is not serializable",
      );
    }
    if (!this.#enqueue(frame(0x1, encoded))) this.#terminate();
    return undefined;
  }

  close(code = 1000, reason = ""): void {
    if (this.#closed) return;
    const reasonBytes = Buffer.from(reason, "utf8");
    const boundedReason = reasonBytes.subarray(0, Math.min(reasonBytes.length, 123));
    const payload = Buffer.allocUnsafe(2 + boundedReason.length);
    payload.writeUInt16BE(code, 0);
    boundedReason.copy(payload, 2);
    this.#closed = true;
    this.#clearKeepAlive();
    this.#queue.length = 0;
    this.#queuedBytes = 0;
    this.#socket.end(frame(0x8, payload));
    this.#onClose?.();
    this.#onClose = undefined;
  }

  terminate(): void {
    this.#terminate();
  }

  #read(chunk: Buffer): void {
    if (this.#closed) return;
    this.#buffer =
      this.#buffer.length === 0
        ? Buffer.from(chunk)
        : Buffer.concat([this.#buffer, chunk], this.#buffer.length + chunk.length);
    try {
      while (this.#parseFrame()) {
        // Drain complete frames before retaining a partial bounded suffix.
      }
      if (this.#buffer.length > this.#limits.maxMessageBytes + 14) {
        throw new Error("partial WebSocket frame exceeds byte limit");
      }
    } catch {
      this.close(1002, "invalid WebSocket frame");
    }
  }

  #parseFrame(): boolean {
    if (this.#buffer.length < 2) return false;
    const first = this.#buffer[0]!;
    const second = this.#buffer[1]!;
    const fin = (first & 0x80) !== 0;
    const opcode = first & 0x0f;
    if ((first & 0x70) !== 0) throw new Error("reserved WebSocket bits are set");
    if ((second & 0x80) === 0) throw new Error("client WebSocket frame is not masked");
    let offset = 2;
    let length = second & 0x7f;
    if (length === 126) {
      if (this.#buffer.length < 4) return false;
      length = this.#buffer.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (this.#buffer.length < 10) return false;
      const high = this.#buffer.readUInt32BE(2);
      const low = this.#buffer.readUInt32BE(6);
      if (high > 0x1fffff) throw new Error("WebSocket frame length is unsafe");
      length = high * 2 ** 32 + low;
      offset = 10;
    }
    const control = opcode >= 0x8;
    if (control && (!fin || length > 125)) throw new Error("invalid WebSocket control frame");
    if (length > this.#limits.maxMessageBytes) throw new Error("WebSocket frame exceeds byte limit");
    const frameBytes = offset + 4 + length;
    if (this.#buffer.length < frameBytes) return false;
    const mask = this.#buffer.subarray(offset, offset + 4);
    const payload = Buffer.from(this.#buffer.subarray(offset + 4, frameBytes));
    this.#buffer = this.#buffer.subarray(frameBytes);
    for (let index = 0; index < payload.length; index += 1) {
      payload[index] = payload[index]! ^ mask[index % 4]!;
    }
    this.#handleFrame(opcode, fin, payload);
    return !this.#closed && this.#buffer.length > 0;
  }

  #handleFrame(opcode: number, fin: boolean, payload: Buffer): void {
    if (opcode === 0x8) {
      this.close(1000);
      return;
    }
    if (opcode === 0x9) {
      if (!this.#enqueue(frame(0x0a, payload))) this.#terminate();
      return;
    }
    if (opcode === 0x0a) {
      this.#awaitingPong = false;
      return;
    }
    if (opcode === 0x2) throw new Error("binary WebSocket messages are unsupported");
    if (opcode !== 0x0 && opcode !== 0x1) throw new Error("unsupported WebSocket opcode");
    if (opcode === 0x0 && this.#fragmentOpcode === undefined) {
      throw new Error("unexpected continuation frame");
    }
    if (opcode === 0x1 && this.#fragmentOpcode !== undefined) {
      throw new Error("new message before fragmented message completed");
    }
    if (opcode === 0x1) this.#fragmentOpcode = opcode;
    this.#fragmentBytes += payload.length;
    if (this.#fragmentBytes > this.#limits.maxMessageBytes) {
      throw new Error("fragmented WebSocket message exceeds byte limit");
    }
    this.#fragments.push(payload);
    if (!fin) return;
    const message =
      this.#fragments.length === 1
        ? this.#fragments[0]!
        : Buffer.concat(this.#fragments, this.#fragmentBytes);
    this.#fragments = [];
    this.#fragmentBytes = 0;
    this.#fragmentOpcode = undefined;
    let text: string;
    try {
      text = this.#decoder.decode(message);
    } catch {
      throw new Error("WebSocket text is not UTF-8");
    }
    this.#onMessage?.(text);
  }

  #enqueue(value: Buffer): boolean {
    if (this.#closed) return false;
    if (
      this.#socket.writableLength + this.#queuedBytes + value.length >
      this.#limits.maxOutboundBytes
    ) {
      return false;
    }
    if (!this.#blocked && this.#queue.length === 0) {
      this.#blocked = !this.#socket.write(value);
      return true;
    }
    this.#queue.push(value);
    this.#queuedBytes += value.length;
    return true;
  }

  #flush(): void {
    if (this.#closed && this.#queue.length === 0) return;
    this.#blocked = false;
    while (!this.#blocked && this.#queue.length > 0) {
      const next = this.#queue.shift()!;
      this.#queuedBytes -= next.length;
      this.#blocked = !this.#socket.write(next);
    }
  }

  #ping(): void {
    if (this.#closed) return;
    if (this.#awaitingPong) {
      this.close(1001, "keepalive timeout");
      return;
    }
    this.#awaitingPong = true;
    if (!this.#enqueue(frame(0x9, randomBytes(4)))) this.#terminate();
  }

  #finish(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#clearKeepAlive();
    this.#queue.length = 0;
    this.#queuedBytes = 0;
    this.#onClose?.();
    this.#onClose = undefined;
  }

  #terminate(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#clearKeepAlive();
    this.#queue.length = 0;
    this.#queuedBytes = 0;
    this.#socket.destroy();
    this.#onClose?.();
    this.#onClose = undefined;
  }

  #clearKeepAlive(): void {
    if (this.#keepAlive !== undefined) clearInterval(this.#keepAlive);
    this.#keepAlive = undefined;
  }
}

export function validateWebSocketHandshake(request: IncomingMessage): string {
  if (request.method !== "GET") {
    throw new WebSocketHandshakeError(400, "invalid_websocket_method", "WebSocket upgrade requires GET");
  }
  if (request.headers.upgrade?.toLowerCase() !== "websocket") {
    throw new WebSocketHandshakeError(426, "websocket_upgrade_required", "WebSocket upgrade is required");
  }
  const connection = request.headers.connection
    ?.split(",")
    .map((value) => value.trim().toLowerCase());
  if (!connection?.includes("upgrade")) {
    throw new WebSocketHandshakeError(400, "invalid_websocket_headers", "Connection upgrade header is invalid");
  }
  if (request.headers["sec-websocket-version"] !== "13") {
    throw new WebSocketHandshakeError(426, "unsupported_websocket_version", "WebSocket version 13 is required");
  }
  const key = request.headers["sec-websocket-key"];
  if (typeof key !== "string") {
    throw new WebSocketHandshakeError(400, "invalid_websocket_key", "WebSocket key is required");
  }
  let decoded: Buffer;
  try {
    decoded = Buffer.from(key, "base64");
  } catch {
    throw new WebSocketHandshakeError(400, "invalid_websocket_key", "WebSocket key is invalid");
  }
  if (decoded.length !== 16 || decoded.toString("base64") !== key) {
    throw new WebSocketHandshakeError(400, "invalid_websocket_key", "WebSocket key is invalid");
  }
  return key;
}

export function acceptWebSocket(
  socket: Duplex,
  key: string,
  options: WebSocketAcceptOptions,
): WebSocketPeer {
  const accept = createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");
  socket.write(
    [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${accept}`,
      `Sec-WebSocket-Protocol: ${options.protocol}`,
      "",
      "",
    ].join("\r\n"),
  );
  return new WebSocketPeer(socket, options);
}

function frame(opcode: number, payload: Buffer): Buffer {
  let header: Buffer;
  if (payload.length < 126) {
    header = Buffer.from([0x80 | opcode, payload.length]);
  } else if (payload.length <= 0xffff) {
    header = Buffer.allocUnsafe(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.allocUnsafe(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(payload.length, 6);
  }
  return Buffer.concat([header, payload], header.length + payload.length);
}
