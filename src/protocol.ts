import { TextDecoder } from "node:util";

export const PROTOCOL_VERSION = "1.0" as const;
export const PROTOCOL_MAJOR = 1;
export const DEFAULT_MAX_LINE_BYTES = 1024 * 1024;
export const DEFAULT_MAX_PROMPT_CHARS = 256 * 1024;

export const OPERATIONS = [
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
] as const;

export type Operation = (typeof OPERATIONS)[number];
export type SessionMode = "new" | "open" | "continue" | "memory";
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface ModelPolicy {
  provider: string;
  id: string;
  thinkingLevel?: ThinkingLevel;
}

export interface ResourcePolicy {
  extensions: "none";
  skills: "none";
  promptTemplates: "none";
  themes: "none";
  contextFiles: "none";
  tools: "none";
  systemPrompt?: string;
}

export interface SessionTarget {
  mode: SessionMode;
  path?: string;
}

export interface OpenPayload {
  cwd: string;
  name?: string;
  agentDir?: string;
  session: SessionTarget;
  model?: ModelPolicy;
  resources?: ResourcePolicy;
}

export interface WakePayload {
  prompt: string;
  source?: string;
  waitForTerminal?: boolean;
}

export interface MessagePayload {
  message: string;
}

export interface ClosePayload {
  retainSession?: boolean;
}

export interface DrainPayload {
  timeoutMs?: number;
}

interface CommandBase<T extends Operation, P> {
  protocolVersion: string;
  requestId: string;
  operation: T;
  payload: P;
  /** Unknown future fields are intentionally accepted. */
  [key: string]: unknown;
}

export type HandshakeCommand = CommandBase<"handshake", Record<string, never>>;
export type OpenCommand = CommandBase<"open", OpenPayload> & {
  sessionId: string;
  generation: number;
};
export type WakeCommand = CommandBase<"wake", WakePayload> & {
  sessionId: string;
  generation: number;
  idempotencyKey: string;
};
export type SteerCommand = CommandBase<"steer", MessagePayload> & {
  sessionId: string;
  generation: number;
  idempotencyKey: string;
};
export type FollowUpCommand = CommandBase<"followUp", MessagePayload> & {
  sessionId: string;
  generation: number;
  idempotencyKey: string;
};
export type StatusCommand = CommandBase<"status", Record<string, never>> & {
  sessionId?: string;
};
export type AbortCommand = CommandBase<"abort", Record<string, never>> & {
  sessionId: string;
  generation: number;
};
export type AttachCommand = CommandBase<"attach", Record<string, never>> & {
  sessionId: string;
  generation: number;
};
export type DetachCommand = CommandBase<"detach", Record<string, never>> & {
  sessionId: string;
  generation: number;
};
export type CloseCommand = CommandBase<"close", ClosePayload> & {
  sessionId: string;
  generation: number;
};
export type DrainCommand = CommandBase<"drain", DrainPayload>;

export type ProtocolCommand =
  | HandshakeCommand
  | OpenCommand
  | WakeCommand
  | SteerCommand
  | FollowUpCommand
  | StatusCommand
  | AbortCommand
  | AttachCommand
  | DetachCommand
  | CloseCommand
  | DrainCommand;

export interface ProtocolErrorBody {
  code: string;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}

export interface ResponseEnvelope<T = unknown> {
  protocolVersion: typeof PROTOCOL_VERSION;
  kind: "response";
  requestId: string;
  hostInstanceId: string;
  sessionId?: string;
  sequence?: number;
  ok: boolean;
  data?: T;
  error?: ProtocolErrorBody;
}

export interface EventEnvelope<T = unknown> {
  protocolVersion: typeof PROTOCOL_VERSION;
  kind: "event";
  event: string;
  hostInstanceId: string;
  sessionId: string;
  generation: number;
  sequence: number;
  requestId?: string;
  data?: T;
}

export interface ParseLimits {
  maxPromptChars?: number;
}

export class ProtocolValidationError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "ProtocolValidationError";
    this.code = code;
    this.details = details;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new ProtocolValidationError("invalid_field", `${field} must be an object`, { field });
  }
  return value;
}

function stringField(
  source: Record<string, unknown>,
  field: string,
  options: { min?: number; max?: number; optional?: boolean } = {},
): string | undefined {
  const value = source[field];
  if (value === undefined && options.optional) return undefined;
  if (typeof value !== "string") {
    throw new ProtocolValidationError("invalid_field", `${field} must be a string`, { field });
  }
  const min = options.min ?? 1;
  const max = options.max ?? 512;
  if (value.length < min || value.length > max) {
    throw new ProtocolValidationError(
      "invalid_field",
      `${field} length must be between ${min} and ${max}`,
      { field, length: value.length, min, max },
    );
  }
  return value;
}

function integerField(
  source: Record<string, unknown>,
  field: string,
  options: { min?: number; max?: number; optional?: boolean } = {},
): number | undefined {
  const value = source[field];
  if (value === undefined && options.optional) return undefined;
  if (!Number.isSafeInteger(value)) {
    throw new ProtocolValidationError("invalid_field", `${field} must be a safe integer`, { field });
  }
  const number = value as number;
  const min = options.min ?? 0;
  const max = options.max ?? Number.MAX_SAFE_INTEGER;
  if (number < min || number > max) {
    throw new ProtocolValidationError("invalid_field", `${field} must be between ${min} and ${max}`, {
      field,
      value: number,
      min,
      max,
    });
  }
  return number;
}

function protocolMajor(version: string): number | undefined {
  const match = /^(\d+)\.(\d+)$/.exec(version);
  if (!match) return undefined;
  return Number(match[1]);
}

function validateBase(value: unknown): Record<string, unknown> {
  const command = record(value, "command");
  const version = stringField(command, "protocolVersion", { max: 32 });
  const major = protocolMajor(version!);
  if (major === undefined) {
    throw new ProtocolValidationError(
      "invalid_protocol_version",
      "protocolVersion must be <major>.<minor>",
    );
  }
  if (major !== PROTOCOL_MAJOR) {
    throw new ProtocolValidationError("incompatible_protocol", `unsupported protocol major ${major}`, {
      supported: PROTOCOL_VERSION,
      received: version,
    });
  }
  stringField(command, "requestId", { max: 128 });
  const operation = stringField(command, "operation", { max: 32 });
  if (!OPERATIONS.includes(operation as Operation)) {
    throw new ProtocolValidationError("unknown_operation", `unknown operation: ${operation}`, {
      operation,
    });
  }
  record(command.payload, "payload");
  return command;
}

function validateSessionIdentity(command: Record<string, unknown>, idempotent = false): void {
  stringField(command, "sessionId", { max: 256 });
  integerField(command, "generation", { min: 0 });
  if (idempotent) stringField(command, "idempotencyKey", { max: 512 });
}

function validateModel(value: unknown): void {
  if (value === undefined) return;
  const model = record(value, "payload.model");
  stringField(model, "provider", { max: 128 });
  stringField(model, "id", { max: 256 });
  const thinking = stringField(model, "thinkingLevel", { max: 16, optional: true });
  if (
    thinking !== undefined &&
    !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(thinking)
  ) {
    throw new ProtocolValidationError("invalid_field", "unsupported thinkingLevel", {
      field: "thinkingLevel",
      value: thinking,
    });
  }
}

function validateResources(value: unknown): void {
  if (value === undefined) return;
  const resources = record(value, "payload.resources");
  for (const field of [
    "extensions",
    "skills",
    "promptTemplates",
    "themes",
    "contextFiles",
    "tools",
  ]) {
    const value = stringField(resources, field, { max: 16 });
    if (value !== "none") {
      throw new ProtocolValidationError(
        "unsupported_resource_policy",
        `${field} must be 'none' in protocol v1`,
        { field, value },
      );
    }
  }
  stringField(resources, "systemPrompt", { min: 0, max: 256 * 1024, optional: true });
}

/** Parse and validate one forward-tolerant protocol command. */
export function parseCommand(value: unknown, limits: ParseLimits = {}): ProtocolCommand {
  const command = validateBase(value);
  const operation = command.operation as Operation;
  const payload = command.payload as Record<string, unknown>;

  switch (operation) {
    case "handshake":
      break;
    case "open": {
      validateSessionIdentity(command);
      stringField(payload, "cwd", { max: 4096 });
      stringField(payload, "name", { max: 128, optional: true });
      stringField(payload, "agentDir", { max: 4096, optional: true });
      const session = record(payload.session, "payload.session");
      const mode = stringField(session, "mode", { max: 16 });
      if (!["new", "open", "continue", "memory"].includes(mode!)) {
        throw new ProtocolValidationError("invalid_field", "unsupported session mode", {
          field: "payload.session.mode",
          value: mode,
        });
      }
      const path = stringField(session, "path", { max: 4096, optional: true });
      if (mode === "open" && path === undefined) {
        throw new ProtocolValidationError(
          "invalid_field",
          "payload.session.path is required for open mode",
          { field: "payload.session.path" },
        );
      }
      validateModel(payload.model);
      validateResources(payload.resources);
      break;
    }
    case "wake": {
      validateSessionIdentity(command, true);
      stringField(payload, "prompt", {
        max: limits.maxPromptChars ?? DEFAULT_MAX_PROMPT_CHARS,
      });
      stringField(payload, "source", { max: 128, optional: true });
      if (
        payload.waitForTerminal !== undefined &&
        typeof payload.waitForTerminal !== "boolean"
      ) {
        throw new ProtocolValidationError(
          "invalid_field",
          "payload.waitForTerminal must be a boolean",
          { field: "payload.waitForTerminal" },
        );
      }
      break;
    }
    case "steer":
    case "followUp":
      validateSessionIdentity(command, true);
      stringField(payload, "message", {
        max: limits.maxPromptChars ?? DEFAULT_MAX_PROMPT_CHARS,
      });
      break;
    case "status":
      stringField(command, "sessionId", { max: 256, optional: true });
      break;
    case "abort":
    case "attach":
    case "detach":
      validateSessionIdentity(command);
      break;
    case "close":
      validateSessionIdentity(command);
      if (payload.retainSession !== undefined && typeof payload.retainSession !== "boolean") {
        throw new ProtocolValidationError(
          "invalid_field",
          "payload.retainSession must be a boolean",
          { field: "payload.retainSession" },
        );
      }
      break;
    case "drain":
      integerField(payload, "timeoutMs", { min: 0, max: 24 * 60 * 60 * 1000, optional: true });
      break;
    default: {
      const exhaustive: never = operation;
      throw new ProtocolValidationError("unknown_operation", `unknown operation: ${exhaustive}`);
    }
  }

  return command as unknown as ProtocolCommand;
}

export function successResponse<T>(
  requestId: string,
  hostInstanceId: string,
  data: T,
  options: { sessionId?: string; sequence?: number } = {},
): ResponseEnvelope<T> {
  return {
    protocolVersion: PROTOCOL_VERSION,
    kind: "response",
    requestId,
    hostInstanceId,
    ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
    ...(options.sequence === undefined ? {} : { sequence: options.sequence }),
    ok: true,
    data,
  };
}

export function errorResponse(
  requestId: string,
  hostInstanceId: string,
  error: ProtocolErrorBody,
  options: { sessionId?: string; sequence?: number } = {},
): ResponseEnvelope {
  return {
    protocolVersion: PROTOCOL_VERSION,
    kind: "response",
    requestId,
    hostInstanceId,
    ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
    ...(options.sequence === undefined ? {} : { sequence: options.sequence }),
    ok: false,
    error,
  };
}

export function eventEnvelope<T>(input: {
  event: string;
  hostInstanceId: string;
  sessionId: string;
  generation: number;
  sequence: number;
  requestId?: string;
  data?: T;
}): EventEnvelope<T> {
  return {
    protocolVersion: PROTOCOL_VERSION,
    kind: "event",
    event: input.event,
    hostInstanceId: input.hostInstanceId,
    sessionId: input.sessionId,
    generation: input.generation,
    sequence: input.sequence,
    ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
    ...(input.data === undefined ? {} : { data: input.data }),
  };
}

export function encodeLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

export class ProtocolSerializationError extends Error {
  readonly code: "outbound_record_too_large" | "outbound_not_serializable";
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: ProtocolSerializationError["code"],
    message: string,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ProtocolSerializationError";
    this.code = code;
    this.details = details;
  }
}

/**
 * Encode one JSON record only after a structural pass proves its allocation is
 * within `maxBytes` (including the trailing LF).
 *
 * Transport records are intentionally restricted to plain JSON data. This
 * avoids invoking arbitrary `toJSON` methods or accessors while handling SDK
 * events, and lets oversized strings/arrays fail before JSON.stringify or
 * Buffer allocation. The final byte check is defense in depth against a
 * serializer/estimator drift.
 */
export function encodeBoundedLine(value: unknown, maxBytes: number): Buffer {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error("maxBytes must be a positive safe integer");
  }
  try {
    const prepared = prepareJsonValue(value, maxBytes - 1, new Set<object>());
    const recordBytes = prepared.bytes + 1;
    if (recordBytes > maxBytes) throwRecordTooLarge(maxBytes, recordBytes);
    const encoded = JSON.stringify(prepared.value);
    if (encoded === undefined) {
      throw new ProtocolSerializationError(
        "outbound_not_serializable",
        "outbound record has no JSON representation",
      );
    }
    const actualBytes = Buffer.byteLength(encoded, "utf8") + 1;
    if (actualBytes > maxBytes || actualBytes !== recordBytes) {
      throwRecordTooLarge(maxBytes, actualBytes);
    }
    return Buffer.from(`${encoded}\n`, "utf8");
  } catch (error) {
    if (error instanceof ProtocolSerializationError) throw error;
    throw new ProtocolSerializationError(
      "outbound_not_serializable",
      "outbound record is not serializable plain JSON data",
    );
  }
}

interface PreparedJsonValue {
  bytes: number;
  value: unknown;
}

function prepareJsonValue(value: unknown, budget: number, seen: Set<object>): PreparedJsonValue {
  switch (typeof value) {
    case "string":
      return { bytes: measureJsonStringBytes(value, budget), value };
    case "number":
      return {
        bytes: boundedCount(Number.isFinite(value) ? String(value) : "null", budget),
        value,
      };
    case "boolean":
      return { bytes: boundedCount(value ? "true" : "false", budget), value };
    case "object": {
      if (value === null) return { bytes: boundedCount("null", budget), value: null };
      if (seen.has(value)) {
        throw new ProtocolSerializationError(
          "outbound_not_serializable",
          "outbound record contains a circular reference",
        );
      }
      seen.add(value);
      try {
        const toJson = Object.getOwnPropertyDescriptor(value, "toJSON");
        if (toJson !== undefined && (!("value" in toJson) || typeof toJson.value === "function")) {
          throwNotSerializable("outbound record contains custom JSON serialization");
        }
        if (Array.isArray(value)) {
          const normalized: unknown[] = [];
          let bytes = boundedAdd(0, 2, budget);
          for (let index = 0; index < value.length; index += 1) {
            if (index > 0) bytes = boundedAdd(bytes, 1, budget);
            const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
            if (descriptor === undefined) {
              bytes = boundedAdd(bytes, 4, budget);
              normalized.push(null);
              continue;
            }
            if (!("value" in descriptor)) throwNotSerializable("array contains an accessor");
            if (["undefined", "function", "symbol"].includes(typeof descriptor.value)) {
              bytes = boundedAdd(bytes, 4, budget);
              normalized.push(null);
              continue;
            }
            const prepared = prepareJsonValue(descriptor.value, budget - bytes, seen);
            bytes = boundedAdd(bytes, prepared.bytes, budget);
            normalized.push(prepared.value);
          }
          return { bytes, value: normalized };
        }

        const prototype = Object.getPrototypeOf(value);
        if (prototype !== Object.prototype && prototype !== null) {
          throwNotSerializable("outbound record contains a non-plain object");
        }
        const normalized: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
        let bytes = boundedAdd(0, 2, budget);
        let emitted = 0;
        for (const key in value) {
          if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
          const descriptor = Object.getOwnPropertyDescriptor(value, key);
          if (descriptor === undefined || !("value" in descriptor)) {
            throwNotSerializable("object contains an accessor");
          }
          const child = descriptor.value;
          if (["undefined", "function", "symbol"].includes(typeof child)) continue;
          if (emitted > 0) bytes = boundedAdd(bytes, 1, budget);
          bytes = boundedAdd(bytes, measureJsonStringBytes(key, budget - bytes), budget);
          bytes = boundedAdd(bytes, 1, budget);
          const prepared = prepareJsonValue(child, budget - bytes, seen);
          bytes = boundedAdd(bytes, prepared.bytes, budget);
          normalized[key] = prepared.value;
          emitted += 1;
        }
        return { bytes, value: normalized };
      } finally {
        seen.delete(value);
      }
    }
    case "bigint":
      throwNotSerializable("outbound record contains a bigint");
    case "undefined":
    case "function":
    case "symbol":
      throwNotSerializable("outbound record has no JSON representation");
  }
}

function measureJsonStringBytes(value: string, budget: number): number {
  let bytes = boundedAdd(0, 2, budget);
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    let addition: number;
    if (code === 0x22 || code === 0x5c || [0x08, 0x09, 0x0a, 0x0c, 0x0d].includes(code)) {
      addition = 2;
    } else if (code <= 0x1f) {
      addition = 6;
    } else if (code <= 0x7f) {
      addition = 1;
    } else if (code <= 0x7ff) {
      addition = 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        addition = 4;
        index += 1;
      } else {
        addition = 6;
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      addition = 6;
    } else {
      addition = 3;
    }
    bytes = boundedAdd(bytes, addition, budget);
  }
  return bytes;
}

function boundedCount(value: string, budget: number): number {
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes > budget) throwRecordTooLarge(budget + 1, bytes + 1);
  return bytes;
}

function boundedAdd(current: number, addition: number, budget: number): number {
  const total = current + addition;
  if (!Number.isSafeInteger(total) || total > budget) {
    throwRecordTooLarge(budget + 1, Number.isSafeInteger(total) ? total + 1 : undefined);
  }
  return total;
}

function throwRecordTooLarge(maxBytes: number, recordBytes?: number): never {
  throw new ProtocolSerializationError(
    "outbound_record_too_large",
    "outbound record exceeds byte limit",
    { maxBytes, ...(recordBytes === undefined ? {} : { recordBytes }) },
  );
}

function throwNotSerializable(reason: string): never {
  throw new ProtocolSerializationError("outbound_not_serializable", reason);
}

/** Byte-bounded LF-only NDJSON decoder with fatal UTF-8 and JSON errors. */
export class NdjsonDecoder {
  readonly #maxLineBytes: number;
  #buffer = Buffer.alloc(0);
  #decoder = new TextDecoder("utf-8", { fatal: true });

  constructor(maxLineBytes = DEFAULT_MAX_LINE_BYTES) {
    if (!Number.isSafeInteger(maxLineBytes) || maxLineBytes < 1) {
      throw new Error("maxLineBytes must be a positive safe integer");
    }
    this.#maxLineBytes = maxLineBytes;
  }

  push(chunk: Uint8Array): unknown[] {
    this.#buffer = Buffer.concat([this.#buffer, Buffer.from(chunk)]);
    const values: unknown[] = [];
    while (true) {
      const newline = this.#buffer.indexOf(0x0a);
      if (newline < 0) break;
      if (newline > this.#maxLineBytes) {
        throw new ProtocolValidationError("line_too_large", "NDJSON line exceeds byte limit", {
          maxLineBytes: this.#maxLineBytes,
          actualBytes: newline,
        });
      }
      let line = this.#buffer.subarray(0, newline);
      this.#buffer = this.#buffer.subarray(newline + 1);
      if (line.length > 0 && line[line.length - 1] === 0x0d) line = line.subarray(0, -1);
      if (line.length === 0) continue;
      values.push(this.#parseLine(line));
    }
    if (this.#buffer.length > this.#maxLineBytes) {
      throw new ProtocolValidationError("line_too_large", "NDJSON line exceeds byte limit", {
        maxLineBytes: this.#maxLineBytes,
        actualBytes: this.#buffer.length,
      });
    }
    return values;
  }

  finish(): unknown[] {
    if (this.#buffer.length === 0) return [];
    const line = this.#buffer;
    this.#buffer = Buffer.alloc(0);
    return [this.#parseLine(line)];
  }

  #parseLine(line: Uint8Array): unknown {
    let text: string;
    try {
      text = this.#decoder.decode(line);
    } catch {
      throw new ProtocolValidationError("invalid_utf8", "NDJSON line is not valid UTF-8");
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new ProtocolValidationError("invalid_json", "NDJSON line is not valid JSON");
    }
  }
}
