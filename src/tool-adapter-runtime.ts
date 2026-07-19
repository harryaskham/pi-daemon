import { createHash, randomUUID } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  truncateHead,
  withFileMutationQueue,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import { encodeBoundedLine, NdjsonDecoder } from "./protocol.js";
import {
  parseHostToolAdapterMessage,
  validateHostToolAdapterDescriptor,
  validateToolAdapterRelativePath,
  type HostToolAdapterAbortedFrame,
  type HostToolAdapterDescriptor,
  type HostToolAdapterLimits,
  type HostToolAdapterMessage,
  type HostToolAdapterResultFrame,
  type NeutralToolOperation,
} from "./tool-adapter-protocol.js";

export const HOST_TOOL_NAMES = {
  "fs.list": "fs_list",
  "fs.stat": "fs_stat",
  "fs.read": "fs_read",
  "fs.search": "fs_search",
  "fs.write": "fs_write",
  "fs.edit": "fs_edit",
} as const satisfies Record<NeutralToolOperation, string>;

export type HostToolName = (typeof HOST_TOOL_NAMES)[NeutralToolOperation];

type JsonPrimitive = string | number | boolean | null;
export type HostToolJsonValue =
  | JsonPrimitive
  | HostToolJsonValue[]
  | { [key: string]: HostToolJsonValue };
export type HostToolJsonObject = { [key: string]: HostToolJsonValue };

interface CommonFrame {
  protocolVersion: "1.0";
  kind: string;
  adapterId: string;
  adapterVersion: string;
  hostInstanceId: string;
  sessionId: string;
  generation: number;
}

interface PendingInvocation {
  requestId: string;
  idempotencyKey: string;
  operation: NeutralToolOperation;
  payload: HostToolJsonObject;
  signal: AbortSignal | undefined;
  resolve: (value: HostToolJsonValue) => void;
  reject: (error: HostToolAdapterError) => void;
  abortListener: (() => void) | undefined;
  timer: NodeJS.Timeout | undefined;
}

interface AbortedInvocation {
  abortRequestId: string;
  idempotencyKey: string;
  operation: NeutralToolOperation;
  timer: NodeJS.Timeout;
}

export class HostToolAdapterError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly indeterminate: boolean;

  constructor(
    code: string,
    message: string,
    options: { retryable?: boolean; indeterminate?: boolean } = {},
  ) {
    super(message);
    this.name = "HostToolAdapterError";
    this.code = safeCode(code);
    this.retryable = options.retryable === true;
    this.indeterminate = options.indeterminate === true;
  }
}

export interface OpenHostToolAdapterOptions {
  cwd: string;
}

/**
 * Tracks one long-lived adapter connection per daemon session generation.
 * Registry keys deliberately omit the secret capability handle.
 */
export class HostToolAdapterRegistry {
  readonly #sessions = new Map<string, HostToolAdapterSession>();
  #disposed = false;

  async open(
    descriptor: HostToolAdapterDescriptor,
    options: OpenHostToolAdapterOptions,
  ): Promise<HostToolAdapterSession> {
    if (this.#disposed) {
      throw new HostToolAdapterError("adapter_registry_closed", "Host tool adapter registry is closed");
    }
    const validatedDescriptor = runtimeDescriptor(descriptor);
    const key = descriptorKey(validatedDescriptor);
    if (this.#sessions.has(key)) {
      throw new HostToolAdapterError(
        "adapter_session_conflict",
        "A host tool adapter is already bound for this session generation",
      );
    }
    let session: HostToolAdapterSession | undefined;
    session = await HostToolAdapterSession.connect(validatedDescriptor, options, () => {
      if (session !== undefined && this.#sessions.get(key) === session) {
        this.#sessions.delete(key);
      }
    });
    if (this.#disposed) {
      await session.dispose();
      throw new HostToolAdapterError("adapter_registry_closed", "Host tool adapter registry is closed");
    }
    this.#sessions.set(key, session);
    return session;
  }

  get size(): number {
    return this.#sessions.size;
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    const sessions = [...this.#sessions.values()];
    this.#sessions.clear();
    await Promise.allSettled(sessions.map(async (session) => session.dispose()));
  }
}

/** One bound, session-scoped, multiplexed adapter connection. */
export class HostToolAdapterSession {
  readonly cwd: string;
  readonly #descriptor: HostToolAdapterDescriptor;
  readonly #socket: Socket;
  readonly #decoder: NdjsonDecoder;
  readonly #onClose: () => void;
  readonly #queue: PendingInvocation[] = [];
  readonly #active = new Map<string, PendingInvocation>();
  readonly #aborted = new Map<string, AbortedInvocation>();
  #bound = false;
  #disposed = false;
  #writeBlocked = false;
  #bindResolve: (() => void) | undefined;
  #bindReject: ((error: HostToolAdapterError) => void) | undefined;
  #bindTimer: NodeJS.Timeout | undefined;

  private constructor(
    descriptor: HostToolAdapterDescriptor,
    cwd: string,
    socket: Socket,
    onClose: () => void,
  ) {
    this.#descriptor = structuredClone(descriptor);
    this.cwd = cwd;
    this.#socket = socket;
    this.#onClose = onClose;
    this.#decoder = new NdjsonDecoder(descriptor.limits.maxResponseBytes - 1);
    socket.on("data", (chunk: Buffer) => this.#onData(chunk));
    socket.on("drain", () => {
      this.#writeBlocked = false;
      this.#pump();
    });
    socket.once("error", () => this.#failConnection("adapter_connection_failed"));
    socket.once("end", () => this.#failConnection("adapter_connection_closed"));
    socket.once("close", () => this.#failConnection("adapter_connection_closed"));
  }

  static async connect(
    descriptor: HostToolAdapterDescriptor,
    options: OpenHostToolAdapterOptions,
    onClose: () => void = () => undefined,
  ): Promise<HostToolAdapterSession> {
    const validatedDescriptor = runtimeDescriptor(descriptor);
    await validatePrivateUnixSocket(validatedDescriptor.endpoint.path);
    const cwd = await canonicalDirectory(options.cwd);
    const socket = createConnection({ path: validatedDescriptor.endpoint.path });
    const connected = await waitForSocketConnect(
      socket,
      validatedDescriptor.limits.requestTimeoutMs,
    );
    if (!connected) {
      socket.on("error", () => undefined);
      socket.destroy();
      throw new HostToolAdapterError(
        "adapter_connect_timeout",
        "Host tool adapter connection timed out",
        { retryable: true },
      );
    }
    const session = new HostToolAdapterSession(
      validatedDescriptor,
      cwd,
      socket,
      onClose,
    );
    try {
      await session.#bind();
      return session;
    } catch (error) {
      socket.destroy();
      throw error;
    }
  }

  get closed(): boolean {
    return this.#disposed;
  }

  get operations(): readonly NeutralToolOperation[] {
    return [...this.#descriptor.operations];
  }

  get limits(): Readonly<HostToolAdapterLimits> {
    return { ...this.#descriptor.limits };
  }

  get activeRequests(): number {
    return this.#active.size;
  }

  get queuedRequests(): number {
    return this.#queue.length;
  }

  async invoke(
    operation: NeutralToolOperation,
    payload: HostToolJsonObject,
    options: { idempotencyKey: string; signal?: AbortSignal },
  ): Promise<HostToolJsonValue> {
    if (this.#disposed || !this.#bound) {
      throw new HostToolAdapterError("adapter_session_closed", "Host tool adapter session is closed");
    }
    if (!this.#descriptor.operations.includes(operation)) {
      throw new HostToolAdapterError(
        "adapter_operation_denied",
        "Host tool adapter operation is not allowed for this session",
      );
    }
    if (options.signal?.aborted) {
      throw new HostToolAdapterError("adapter_request_aborted", "Host tool adapter request was aborted");
    }
    if (
      this.#active.size >= this.#descriptor.limits.maxConcurrentRequests &&
      this.#queue.length >= this.#descriptor.limits.maxQueuedRequests
    ) {
      throw new HostToolAdapterError(
        "adapter_queue_capacity",
        "Host tool adapter request queue is full",
        { retryable: true },
      );
    }
    const idempotencyKey = boundedIdentifier(
      options.idempotencyKey,
      "idempotency key",
      512,
    );
    return await new Promise<HostToolJsonValue>((resolvePromise, rejectPromise) => {
      const pending: PendingInvocation = {
        requestId: randomUUID(),
        idempotencyKey,
        operation,
        payload,
        signal: options.signal,
        resolve: resolvePromise,
        reject: rejectPromise,
        abortListener: undefined,
        timer: undefined,
      };
      if (options.signal !== undefined) {
        const abortListener = (): void => this.#abortInvocation(pending);
        pending.abortListener = abortListener;
        options.signal.addEventListener("abort", abortListener, { once: true });
      }
      pending.timer = setTimeout(
        () => this.#timeoutInvocation(pending),
        this.#descriptor.limits.requestTimeoutMs,
      );
      pending.timer.unref();
      this.#queue.push(pending);
      this.#pump();
    });
  }

  async normalizePath(
    input: string,
    options: { allowMissingLeaf?: boolean } = {},
  ): Promise<string> {
    let normalized: string;
    try {
      normalized = validateToolAdapterRelativePath(input, "path");
    } catch {
      throw new HostToolAdapterError("adapter_path_invalid", "Host tool path is invalid");
    }
    const segments = normalized === "." ? [] : normalized.split("/");
    let current = this.cwd;
    for (let index = 0; index < segments.length; index += 1) {
      current = resolve(current, segments[index]!);
      if (!isWithin(this.cwd, current)) {
        throw new HostToolAdapterError("adapter_path_invalid", "Host tool path is invalid");
      }
      try {
        const info = await lstat(current);
        if (info.isSymbolicLink()) {
          throw new HostToolAdapterError("adapter_path_symlink", "Host tool paths may not traverse symbolic links");
        }
      } catch (error) {
        const missingLeaf =
          isNodeError(error) &&
          error.code === "ENOENT" &&
          options.allowMissingLeaf === true &&
          index === segments.length - 1;
        if (!missingLeaf) {
          if (error instanceof HostToolAdapterError) throw error;
          throw new HostToolAdapterError("adapter_path_unavailable", "Host tool path is unavailable");
        }
      }
    }
    return segments.length === 0 ? "." : segments.join("/");
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#bound = false;
    if (this.#bindTimer !== undefined) clearTimeout(this.#bindTimer);
    this.#bindTimer = undefined;
    const error = new HostToolAdapterError(
      "adapter_session_closed",
      "Host tool adapter session is closed",
      { indeterminate: this.#active.size > 0 },
    );
    for (const pending of this.#queue.splice(0)) this.#settle(pending, undefined, error);
    for (const pending of this.#active.values()) this.#settle(pending, undefined, error);
    this.#active.clear();
    for (const aborted of this.#aborted.values()) clearTimeout(aborted.timer);
    this.#aborted.clear();
    if (!this.#socket.destroyed) {
      try {
        const frame = this.#parseFrame(this.#commonFrame("revoke"));
        const encoded = encodeBoundedLine(
          frame,
          this.#descriptor.limits.maxRequestBytes,
        );
        await Promise.race([
          new Promise<void>((resolvePromise) => {
            this.#socket.write(encoded, () => resolvePromise());
          }),
          new Promise<void>((resolvePromise) => {
            const timer = setTimeout(resolvePromise, Math.min(100, this.#descriptor.limits.requestTimeoutMs));
            timer.unref();
          }),
        ]);
      } catch {
        // Revoke is best effort; EOF is the adapter's mandatory revocation backstop.
      }
      this.#socket.end();
      this.#socket.destroy();
    }
    this.#onClose();
  }

  async #bind(): Promise<void> {
    const frame = {
      ...this.#commonFrame("bind"),
      capabilityHandle: this.#descriptor.binding.capabilityHandle,
      operations: [...this.#descriptor.operations],
      limits: { ...this.#descriptor.limits },
    };
    const encoded = encodeBoundedLine(
      this.#parseFrame(frame),
      this.#descriptor.limits.maxRequestBytes,
    );
    await new Promise<void>((resolvePromise, rejectPromise) => {
      this.#bindResolve = resolvePromise;
      this.#bindReject = rejectPromise;
      this.#bindTimer = setTimeout(() => {
        this.#bindTimer = undefined;
        this.#bindResolve = undefined;
        this.#bindReject = undefined;
        rejectPromise(
          new HostToolAdapterError("adapter_bind_timeout", "Host tool adapter bind timed out", {
            retryable: true,
          }),
        );
      }, this.#descriptor.limits.requestTimeoutMs);
      this.#bindTimer.unref();
      this.#socket.write(encoded, (error) => {
        if (error !== null && error !== undefined) {
          if (this.#bindTimer !== undefined) clearTimeout(this.#bindTimer);
          this.#bindTimer = undefined;
          this.#bindResolve = undefined;
          this.#bindReject = undefined;
          rejectPromise(
            new HostToolAdapterError(
              "adapter_connection_failed",
              "Host tool adapter connection failed",
              { retryable: true },
            ),
          );
        }
      });
    });
  }

  #onData(chunk: Buffer): void {
    if (this.#disposed) return;
    try {
      for (const value of this.#decoder.push(chunk)) this.#onFrame(value);
    } catch {
      this.#failConnection("adapter_protocol_invalid");
    }
  }

  #onFrame(value: unknown): void {
    if (containsSecret(value, this.#descriptor.binding.capabilityHandle)) {
      this.#failConnection("adapter_secret_reflected");
      return;
    }
    let frame: HostToolAdapterMessage;
    try {
      frame = parseHostToolAdapterMessage(value, this.#descriptor);
    } catch {
      this.#failConnection("adapter_protocol_invalid");
      return;
    }
    if (frame.kind === "bound") {
      if (this.#bound || this.#bindResolve === undefined) {
        this.#failConnection("adapter_protocol_invalid");
        return;
      }
      this.#bound = true;
      if (this.#bindTimer !== undefined) clearTimeout(this.#bindTimer);
      this.#bindTimer = undefined;
      const resolvePromise = this.#bindResolve;
      this.#bindResolve = undefined;
      this.#bindReject = undefined;
      resolvePromise();
      return;
    }
    if (!this.#bound) {
      this.#failConnection("adapter_protocol_invalid");
      return;
    }
    if (frame.kind === "result") {
      this.#onResult(frame);
      return;
    }
    if (frame.kind === "aborted") {
      this.#onAborted(frame);
      return;
    }
    if (frame.kind === "revoked") return;
    this.#failConnection("adapter_protocol_invalid");
  }

  #onResult(value: HostToolAdapterResultFrame): void {
    const { requestId, idempotencyKey, operation } = value;
    const pending = this.#active.get(requestId);
    const aborted = this.#aborted.get(requestId);
    const expected = pending ?? aborted;
    if (
      expected === undefined ||
      expected.idempotencyKey !== idempotencyKey ||
      expected.operation !== operation
    ) {
      this.#failConnection("adapter_response_mismatch");
      return;
    }
    if (aborted !== undefined) return;
    this.#active.delete(requestId);
    if (value.ok) {
      this.#settle(
        pending!,
        value.data as unknown as HostToolJsonValue,
        undefined,
      );
    } else {
      this.#settle(
        pending!,
        undefined,
        new HostToolAdapterError(
          value.error.code,
          "Host tool adapter request failed",
          { retryable: value.error.retryable },
        ),
      );
    }
    this.#pump();
  }

  #onAborted(value: HostToolAdapterAbortedFrame): void {
    const aborted = this.#aborted.get(value.targetRequestId);
    if (aborted === undefined || aborted.abortRequestId !== value.requestId) {
      this.#failConnection("adapter_response_mismatch");
      return;
    }
    clearTimeout(aborted.timer);
    this.#aborted.delete(value.targetRequestId);
  }

  #pump(): void {
    if (this.#disposed || !this.#bound || this.#writeBlocked) return;
    while (
      this.#queue.length > 0 &&
      this.#active.size < this.#descriptor.limits.maxConcurrentRequests &&
      !this.#writeBlocked
    ) {
      const pending = this.#queue.shift()!;
      if (pending.signal?.aborted) {
        this.#settle(
          pending,
          undefined,
          new HostToolAdapterError("adapter_request_aborted", "Host tool adapter request was aborted"),
        );
        continue;
      }
      const frame = {
        ...this.#commonFrame("invoke"),
        requestId: pending.requestId,
        idempotencyKey: pending.idempotencyKey,
        operation: pending.operation,
        payload: pending.payload,
      };
      let parsedFrame: HostToolAdapterMessage;
      try {
        parsedFrame = this.#parseFrame(frame);
      } catch {
        this.#settle(
          pending,
          undefined,
          new HostToolAdapterError(
            "adapter_request_invalid",
            "Host tool adapter request is invalid",
          ),
        );
        continue;
      }
      let encoded: Buffer;
      try {
        encoded = encodeBoundedLine(
          parsedFrame,
          this.#descriptor.limits.maxRequestBytes,
        );
      } catch {
        this.#settle(
          pending,
          undefined,
          new HostToolAdapterError(
            "adapter_request_too_large",
            "Host tool adapter request exceeds its bound",
          ),
        );
        continue;
      }
      this.#active.set(pending.requestId, pending);
      this.#writeBlocked = !this.#socket.write(encoded, (error) => {
        if (error !== null && error !== undefined) this.#failConnection("adapter_connection_failed");
      });
    }
  }

  #abortInvocation(pending: PendingInvocation): void {
    const queuedIndex = this.#queue.indexOf(pending);
    if (queuedIndex >= 0) {
      this.#queue.splice(queuedIndex, 1);
      this.#settle(
        pending,
        undefined,
        new HostToolAdapterError("adapter_request_aborted", "Host tool adapter request was aborted"),
      );
      return;
    }
    if (!this.#active.delete(pending.requestId)) return;
    this.#rememberAborted(pending);
    this.#sendAbort(pending);
    this.#settle(
      pending,
      undefined,
      new HostToolAdapterError("adapter_request_aborted", "Host tool adapter request was aborted", {
        indeterminate: true,
      }),
    );
    this.#pump();
  }

  #timeoutInvocation(pending: PendingInvocation): void {
    const queuedIndex = this.#queue.indexOf(pending);
    if (queuedIndex >= 0) {
      this.#queue.splice(queuedIndex, 1);
      this.#settle(
        pending,
        undefined,
        new HostToolAdapterError(
          "adapter_request_timeout",
          "Host tool adapter request timed out",
          { retryable: true },
        ),
      );
      return;
    }
    if (!this.#active.delete(pending.requestId)) return;
    this.#rememberAborted(pending);
    this.#sendAbort(pending);
    this.#settle(
      pending,
      undefined,
      new HostToolAdapterError("adapter_request_timeout", "Host tool adapter request timed out", {
        retryable: true,
        indeterminate: true,
      }),
    );
    this.#pump();
  }

  #rememberAborted(pending: PendingInvocation): void {
    if (this.#aborted.size >= this.#descriptor.limits.maxIdempotencyKeys) {
      this.#failConnection("adapter_abort_capacity");
      return;
    }
    const abortRequestId = randomUUID();
    const timer = setTimeout(() => {
      this.#aborted.delete(pending.requestId);
    }, this.#descriptor.limits.idempotencyTtlMs);
    timer.unref();
    this.#aborted.set(pending.requestId, {
      abortRequestId,
      idempotencyKey: pending.idempotencyKey,
      operation: pending.operation,
      timer,
    });
  }

  #sendAbort(pending: PendingInvocation): void {
    try {
      const aborted = this.#aborted.get(pending.requestId);
      if (aborted === undefined) return;
      const frame = {
        ...this.#commonFrame("abort"),
        requestId: aborted.abortRequestId,
        targetRequestId: pending.requestId,
      };
      const encoded = encodeBoundedLine(
        this.#parseFrame(frame),
        this.#descriptor.limits.maxRequestBytes,
      );
      this.#socket.write(encoded, (error) => {
        if (error !== null && error !== undefined) this.#failConnection("adapter_connection_failed");
      });
    } catch {
      this.#failConnection("adapter_protocol_invalid");
    }
  }

  #settle(
    pending: PendingInvocation,
    value: HostToolJsonValue | undefined,
    error: HostToolAdapterError | undefined,
  ): void {
    if (pending.timer !== undefined) clearTimeout(pending.timer);
    pending.timer = undefined;
    if (pending.signal !== undefined && pending.abortListener !== undefined) {
      pending.signal.removeEventListener("abort", pending.abortListener);
    }
    pending.abortListener = undefined;
    if (error !== undefined) pending.reject(error);
    else pending.resolve(value ?? null);
  }

  #failConnection(code: string): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#bound = false;
    if (this.#bindTimer !== undefined) clearTimeout(this.#bindTimer);
    this.#bindTimer = undefined;
    const bindReject = this.#bindReject;
    this.#bindResolve = undefined;
    this.#bindReject = undefined;
    bindReject?.(
      new HostToolAdapterError(code, "Host tool adapter protocol failed", {
        retryable: true,
      }),
    );
    const activeIds = new Set(this.#active.keys());
    const failure = new HostToolAdapterError(code, "Host tool adapter connection failed", {
      retryable: true,
      indeterminate: activeIds.size > 0,
    });
    for (const pending of this.#queue.splice(0)) this.#settle(pending, undefined, failure);
    for (const pending of this.#active.values()) this.#settle(pending, undefined, failure);
    this.#active.clear();
    for (const aborted of this.#aborted.values()) clearTimeout(aborted.timer);
    this.#aborted.clear();
    this.#socket.destroy();
    this.#onClose();
  }

  #parseFrame(value: unknown): HostToolAdapterMessage {
    try {
      return parseHostToolAdapterMessage(value, this.#descriptor);
    } catch {
      throw new HostToolAdapterError(
        "adapter_protocol_invalid",
        "Host tool adapter frame is invalid",
      );
    }
  }

  #commonFrame<const Kind extends string>(kind: Kind): CommonFrame & { kind: Kind } {
    return {
      protocolVersion: "1.0",
      kind,
      adapterId: this.#descriptor.adapterId,
      adapterVersion: this.#descriptor.adapterVersion,
      hostInstanceId: this.#descriptor.binding.hostInstanceId,
      sessionId: this.#descriptor.binding.sessionId,
      generation: this.#descriptor.binding.generation,
    };
  }

}

export function createHostToolDefinitions(session: HostToolAdapterSession): ToolDefinition[] {
  return session.operations.map((operation) => createHostToolDefinition(session, operation));
}

function createHostToolDefinition(
  session: HostToolAdapterSession,
  operation: NeutralToolOperation,
): ToolDefinition {
  const name = HOST_TOOL_NAMES[operation];
  const schema = toolSchema(operation, session.limits.maxRequestBytes);
  const definition = {
    name,
    label: name,
    description: toolDescription(operation),
    promptSnippet: toolPromptSnippet(operation),
    promptGuidelines: [
      "All paths are root-relative POSIX paths; never use absolute paths or parent traversal.",
      "These tools are delegated through a session-scoped host capability and expose no shell or process access.",
    ],
    parameters: schema,
    executionMode: operation === "fs.write" || operation === "fs.edit" ? "sequential" : "parallel",
    async execute(
      toolCallId: string,
      params: unknown,
      signal: AbortSignal | undefined,
    ) {
      const payload = await toolPayload(session, operation, params);
      const idempotencyKey = toolIdempotencyKey(operation, toolCallId);
      const invoke = () =>
        session.invoke(operation, payload, {
          idempotencyKey,
          ...(signal === undefined ? {} : { signal }),
        });
      const data =
        operation === "fs.write" || operation === "fs.edit"
          ? await withFileMutationQueue(resolve(session.cwd, payload.path as string), invoke)
          : await invoke();
      const display = boundedToolResult(operation, data);
      return {
        content: [{ type: "text", text: display.text }],
        details: display.details,
      };
    },
  };
  return definition as unknown as ToolDefinition;
}

async function toolPayload(
  session: HostToolAdapterSession,
  operation: NeutralToolOperation,
  value: unknown,
): Promise<HostToolJsonObject> {
  if (!isRecord(value)) {
    throw new HostToolAdapterError("adapter_tool_input_invalid", "Host tool input is invalid");
  }
  const path = value.path;
  if (typeof path !== "string") {
    throw new HostToolAdapterError("adapter_tool_input_invalid", "Host tool input is invalid");
  }
  const normalizedPath = await session.normalizePath(path, {
    allowMissingLeaf: operation === "fs.write",
  });
  const payload: HostToolJsonObject = { path: normalizedPath };
  switch (operation) {
    case "fs.list":
      copyOptionalSafeInteger(value, payload, "maxEntries", 1);
      break;
    case "fs.stat":
      break;
    case "fs.read":
      copyOptionalSafeInteger(value, payload, "offset", 0);
      copyOptionalSafeInteger(value, payload, "maxBytes", 1);
      break;
    case "fs.search":
      if (typeof value.query !== "string" || value.query.length === 0) {
        throw new HostToolAdapterError("adapter_tool_input_invalid", "Host tool input is invalid");
      }
      payload.query = value.query;
      copyOptionalSafeInteger(value, payload, "maxResults", 1);
      break;
    case "fs.write":
      if (typeof value.content !== "string") {
        throw new HostToolAdapterError("adapter_tool_input_invalid", "Host tool input is invalid");
      }
      payload.content = value.content;
      copyOptionalBoolean(value, payload, "create");
      copyOptionalBoolean(value, payload, "overwrite");
      copyOptionalString(value, payload, "expectedDigest");
      break;
    case "fs.edit": {
      if (
        !Array.isArray(value.edits) ||
        value.edits.length === 0 ||
        !value.edits.every(
          (edit) =>
            isRecord(edit) &&
            typeof edit.oldText === "string" &&
            typeof edit.newText === "string",
        )
      ) {
        throw new HostToolAdapterError("adapter_tool_input_invalid", "Host tool input is invalid");
      }
      payload.edits = value.edits.map((edit) => ({
        oldText: edit.oldText as string,
        newText: edit.newText as string,
      }));
      copyOptionalString(value, payload, "expectedDigest");
      break;
    }
  }
  return payload;
}

function toolSchema(operation: NeutralToolOperation, maxRequestBytes: number): object {
  const path = {
    type: "string",
    minLength: 1,
    maxLength: Math.min(4096, maxRequestBytes),
    description: "Root-relative POSIX path",
  };
  const properties: Record<string, unknown> = { path };
  const required = ["path"];
  switch (operation) {
    case "fs.list":
      properties.maxEntries = boundedCountSchema;
      break;
    case "fs.stat":
      break;
    case "fs.read":
      properties.offset = nonNegativeIntegerSchema;
      properties.maxBytes = positiveIntegerSchema;
      break;
    case "fs.search":
      properties.query = { type: "string", minLength: 1, maxLength: 4_096 };
      properties.maxResults = boundedCountSchema;
      required.push("query");
      break;
    case "fs.write":
      properties.content = { type: "string", maxLength: maxRequestBytes };
      properties.create = { type: "boolean" };
      properties.overwrite = { type: "boolean" };
      properties.expectedDigest = digestSchema;
      required.push("content");
      break;
    case "fs.edit":
      properties.edits = {
        type: "array",
        minItems: 1,
        maxItems: Math.max(1, Math.min(256, Math.floor(maxRequestBytes / 8))),
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            oldText: { type: "string", maxLength: maxRequestBytes },
            newText: { type: "string", maxLength: maxRequestBytes },
          },
          required: ["oldText", "newText"],
        },
      };
      properties.expectedDigest = digestSchema;
      required.push("edits");
      break;
  }
  return { type: "object", additionalProperties: false, properties, required };
}

const positiveIntegerSchema = {
  type: "integer",
  minimum: 1,
  maximum: Number.MAX_SAFE_INTEGER,
};
const boundedCountSchema = {
  type: "integer",
  minimum: 1,
  maximum: 10_000,
};
const nonNegativeIntegerSchema = {
  type: "integer",
  minimum: 0,
  maximum: Number.MAX_SAFE_INTEGER,
};
const digestSchema = {
  type: "string",
  minLength: 64,
  maxLength: 64,
  pattern: "^[a-f0-9]{64}$",
};

function toolDescription(operation: NeutralToolOperation): string {
  switch (operation) {
    case "fs.list":
      return "List entries under a root-confined directory through the host filesystem adapter.";
    case "fs.stat":
      return "Read bounded metadata for a root-confined file or directory through the host filesystem adapter.";
    case "fs.read":
      return "Read bounded file content through the root-confined host filesystem adapter.";
    case "fs.search":
      return "Search bounded file content under a root-confined path through the host filesystem adapter.";
    case "fs.write":
      return "Write one root-confined file through the host filesystem adapter with optional digest preconditions.";
    case "fs.edit":
      return "Apply exact text replacements to one root-confined file through the host filesystem adapter.";
  }
}

function toolPromptSnippet(operation: NeutralToolOperation): string {
  return `${HOST_TOOL_NAMES[operation]} delegates ${operation} to the session-scoped host filesystem adapter`;
}

function boundedToolResult(
  operation: NeutralToolOperation,
  value: HostToolJsonValue,
): {
  text: string;
  details: {
    operation: NeutralToolOperation;
    truncated: boolean;
    totalBytes: number;
    totalLines: number;
  };
} {
  const raw =
    operation === "fs.read" && isRecord(value) && typeof value.content === "string"
      ? value.content
      : JSON.stringify(value, null, 2);
  const truncation = truncateHead(raw, {
    maxBytes: DEFAULT_MAX_BYTES,
    maxLines: DEFAULT_MAX_LINES,
  });
  const notice = truncation.truncated
    ? `\n\n[Output truncated: ${truncation.totalBytes} bytes / ${truncation.totalLines} lines; refine the request bounds.]`
    : "";
  return {
    text: `${truncation.content}${notice}`,
    details: {
      operation,
      truncated: truncation.truncated,
      totalBytes: truncation.totalBytes,
      totalLines: truncation.totalLines,
    },
  };
}

function toolIdempotencyKey(operation: NeutralToolOperation, toolCallId: string): string {
  return `tool-${createHash("sha256").update(operation).update("\0").update(toolCallId).digest("hex")}`;
}

async function validatePrivateUnixSocket(path: string): Promise<void> {
  try {
    if (!isAbsolute(path) || path.includes("\0")) throw new Error("invalid");
    const resolvedPath = resolve(path);
    const parent = dirname(resolvedPath);
    const [socketInfo, parentInfo, canonicalParent] = await Promise.all([
      lstat(resolvedPath),
      lstat(parent),
      realpath(parent),
    ]);
    if (
      resolvedPath !== path ||
      canonicalParent !== parent ||
      socketInfo.isSymbolicLink() ||
      !socketInfo.isSocket() ||
      parentInfo.isSymbolicLink() ||
      !parentInfo.isDirectory() ||
      (socketInfo.mode & 0o077) !== 0 ||
      (parentInfo.mode & 0o077) !== 0
    ) {
      throw new Error("invalid");
    }
    const getuid = process.getuid;
    if (
      getuid !== undefined &&
      (socketInfo.uid !== getuid() || parentInfo.uid !== getuid())
    ) {
      throw new Error("invalid");
    }
  } catch {
    throw new HostToolAdapterError(
      "adapter_endpoint_insecure",
      "Host tool adapter endpoint is not an owner-private Unix socket",
    );
  }
}

async function canonicalDirectory(path: string): Promise<string> {
  try {
    const canonical = await realpath(path);
    const info = await lstat(canonical);
    if (!info.isDirectory()) throw new Error("not directory");
    return canonical;
  } catch {
    throw new HostToolAdapterError("adapter_root_invalid", "Host tool adapter root is invalid");
  }
}

function waitForSocketConnect(socket: Socket, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolvePromise) => {
    let settled = false;
    const finish = (connected: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.off("connect", onConnect);
      socket.off("error", onError);
      resolvePromise(connected);
    };
    const onConnect = (): void => finish(true);
    const onError = (): void => finish(false);
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref();
    socket.once("connect", onConnect);
    socket.once("error", onError);
  });
}

function runtimeDescriptor(
  descriptor: HostToolAdapterDescriptor,
): HostToolAdapterDescriptor {
  try {
    return validateHostToolAdapterDescriptor(descriptor);
  } catch {
    throw new HostToolAdapterError(
      "adapter_descriptor_invalid",
      "Host tool adapter descriptor is invalid",
    );
  }
}

function descriptorKey(descriptor: HostToolAdapterDescriptor): string {
  return [
    descriptor.binding.hostInstanceId,
    descriptor.binding.sessionId,
    String(descriptor.binding.generation),
  ].join("\0");
}

function boundedIdentifier(value: string, label: string, maxLength: number): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maxLength ||
    !/^[A-Za-z0-9._:-]+$/.test(value)
  ) {
    throw new HostToolAdapterError("adapter_identifier_invalid", `Host tool ${label} is invalid`);
  }
  return value;
}

function copyOptionalSafeInteger(
  source: Record<string, unknown>,
  target: HostToolJsonObject,
  key: string,
  minimum: number,
): void {
  const value = source[key];
  if (value === undefined) return;
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new HostToolAdapterError("adapter_tool_input_invalid", "Host tool input is invalid");
  }
  target[key] = value as number;
}

function copyOptionalBoolean(
  source: Record<string, unknown>,
  target: HostToolJsonObject,
  key: string,
): void {
  const value = source[key];
  if (value === undefined) return;
  if (typeof value !== "boolean") {
    throw new HostToolAdapterError("adapter_tool_input_invalid", "Host tool input is invalid");
  }
  target[key] = value;
}

function copyOptionalString(
  source: Record<string, unknown>,
  target: HostToolJsonObject,
  key: string,
): void {
  const value = source[key];
  if (value === undefined) return;
  if (typeof value !== "string") {
    throw new HostToolAdapterError("adapter_tool_input_invalid", "Host tool input is invalid");
  }
  target[key] = value;
}

function containsSecret(value: unknown, secret: string, seen = new Set<object>()): boolean {
  if (typeof value === "string") return value.includes(secret);
  if (value === null || typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.some((entry) => containsSecret(entry, secret, seen));
    for (const [key, entry] of Object.entries(value)) {
      if (key.includes(secret) || containsSecret(entry, secret, seen)) return true;
    }
    return false;
  } finally {
    seen.delete(value);
  }
}

function safeCode(value: string): string {
  return /^[a-z][a-z0-9_]{0,127}$/.test(value) ? value : "adapter_error";
}

function isWithin(root: string, path: string): boolean {
  const child = relative(resolve(root), resolve(path));
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
