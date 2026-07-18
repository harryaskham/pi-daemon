import { posix as posixPath } from "node:path";

import { ProtocolValidationError } from "./protocol.js";

export const TOOL_ADAPTER_PROTOCOL_VERSION = "1.0" as const;
export const TOOL_ADAPTER_MAX_SOCKET_PATH_BYTES = 100;
export const TOOL_ADAPTER_MAX_CONTENT_BYTES = 4 * 1024 * 1024;

export const NEUTRAL_TOOL_OPERATIONS = [
  "fs.list",
  "fs.stat",
  "fs.read",
  "fs.search",
  "fs.write",
  "fs.edit",
] as const;

export type NeutralToolOperation = (typeof NEUTRAL_TOOL_OPERATIONS)[number];

export const HOST_TOOL_ADAPTER_FRAME_KINDS = [
  "bind",
  "bound",
  "invoke",
  "result",
  "revoke",
  "revoked",
  "abort",
  "aborted",
] as const;
const WIRE_KINDS = HOST_TOOL_ADAPTER_FRAME_KINDS;

export const TOOL_ADAPTER_LIMIT_BOUNDS = Object.freeze({
  maxRequestBytes: Object.freeze({ min: 2_048, max: TOOL_ADAPTER_MAX_CONTENT_BYTES }),
  maxResponseBytes: Object.freeze({ min: 1_024, max: TOOL_ADAPTER_MAX_CONTENT_BYTES }),
  maxConcurrentRequests: Object.freeze({ min: 1, max: 64 }),
  maxQueuedRequests: Object.freeze({ min: 0, max: 256 }),
  requestTimeoutMs: Object.freeze({ min: 100, max: 120_000 }),
  maxIdempotencyKeys: Object.freeze({ min: 1, max: 4_096 }),
  idempotencyTtlMs: Object.freeze({ min: 1_000, max: 86_400_000 }),
});

export interface HostToolAdapterEndpoint {
  transport: "unix";
  path: string;
}

export interface HostToolAdapterSessionIdentity {
  hostInstanceId: string;
  sessionId: string;
  generation: number;
}

export interface HostToolAdapterBinding extends HostToolAdapterSessionIdentity {
  /** Secret base64url capability. It appears only in a descriptor and bind frame. */
  capabilityHandle: string;
}

export interface HostToolAdapterLimits {
  maxRequestBytes: number;
  maxResponseBytes: number;
  maxConcurrentRequests: number;
  maxQueuedRequests: number;
  requestTimeoutMs: number;
  maxIdempotencyKeys: number;
  idempotencyTtlMs: number;
}

export interface HostToolAdapterDescriptor {
  protocolVersion: typeof TOOL_ADAPTER_PROTOCOL_VERSION;
  adapterId: string;
  adapterVersion: string;
  endpoint: HostToolAdapterEndpoint;
  binding: HostToolAdapterBinding;
  operations: NeutralToolOperation[];
  limits: HostToolAdapterLimits;
}

export interface HostToolAdapterPolicy {
  mode: "host-adapter";
  descriptor: HostToolAdapterDescriptor;
}

export interface FsListRequestPayload {
  path: string;
  maxEntries?: number;
}

export interface FsListEntry {
  name: string;
  type: "file" | "directory";
  size?: number;
  modifiedAt?: string;
}

export interface FsListResult {
  entries: FsListEntry[];
  truncated: boolean;
}

export interface FsStatRequestPayload {
  path: string;
}

export interface FsStatResult {
  type: "file" | "directory";
  size: number;
  modifiedAt?: string;
}

export interface FsReadRequestPayload {
  path: string;
  offset?: number;
  maxBytes?: number;
}

export interface FsReadResult {
  content: string;
  bytesRead: number;
  eof: boolean;
}

export interface FsSearchRequestPayload {
  path: string;
  query: string;
  maxResults?: number;
}

export interface FsSearchMatch {
  path: string;
  line: number;
  column: number;
  text: string;
}

export interface FsSearchResult {
  matches: FsSearchMatch[];
  truncated: boolean;
}

export interface FsWriteRequestPayload {
  path: string;
  content: string;
  create?: boolean;
  overwrite?: boolean;
  expectedDigest?: string;
}

export interface FsWriteResult {
  created: boolean;
  bytesWritten: number;
  digest: string;
}

export interface FsEditReplacement {
  oldText: string;
  newText: string;
}

export interface FsEditRequestPayload {
  path: string;
  edits: FsEditReplacement[];
  expectedDigest?: string;
}

export interface FsEditResult {
  replacements: number;
  digest: string;
}

export interface HostToolAdapterRequestPayloads {
  "fs.list": FsListRequestPayload;
  "fs.stat": FsStatRequestPayload;
  "fs.read": FsReadRequestPayload;
  "fs.search": FsSearchRequestPayload;
  "fs.write": FsWriteRequestPayload;
  "fs.edit": FsEditRequestPayload;
}

export interface HostToolAdapterResultPayloads {
  "fs.list": FsListResult;
  "fs.stat": FsStatResult;
  "fs.read": FsReadResult;
  "fs.search": FsSearchResult;
  "fs.write": FsWriteResult;
  "fs.edit": FsEditResult;
}

interface HostToolAdapterWireIdentity extends HostToolAdapterSessionIdentity {
  protocolVersion: typeof TOOL_ADAPTER_PROTOCOL_VERSION;
  adapterId: string;
  adapterVersion: string;
}

export interface HostToolAdapterBindFrame extends HostToolAdapterWireIdentity {
  kind: "bind";
  /** The only wire frame allowed to carry this secret. */
  capabilityHandle: string;
  operations: NeutralToolOperation[];
  limits: HostToolAdapterLimits;
}

export interface HostToolAdapterBoundFrame extends HostToolAdapterWireIdentity {
  kind: "bound";
  operations: NeutralToolOperation[];
  limits: HostToolAdapterLimits;
}

type HostToolAdapterOperationInvokeFrame<O extends NeutralToolOperation> =
  HostToolAdapterWireIdentity & {
    kind: "invoke";
    requestId: string;
    idempotencyKey: string;
    operation: O;
    payload: HostToolAdapterRequestPayloads[O];
  };

export type HostToolAdapterInvokeFrame = {
  [O in NeutralToolOperation]: HostToolAdapterOperationInvokeFrame<O>;
}[NeutralToolOperation];

type HostToolAdapterOperationSuccessResultFrame<O extends NeutralToolOperation> =
  HostToolAdapterWireIdentity & {
    kind: "result";
    requestId: string;
    idempotencyKey: string;
    operation: O;
    ok: true;
    data: HostToolAdapterResultPayloads[O];
  };

export type HostToolAdapterSuccessResultFrame = {
  [O in NeutralToolOperation]: HostToolAdapterOperationSuccessResultFrame<O>;
}[NeutralToolOperation];

export interface HostToolAdapterErrorBody {
  code: string;
  message: string;
  retryable: boolean;
}

export type HostToolAdapterErrorResultFrame = HostToolAdapterWireIdentity & {
  kind: "result";
  requestId: string;
  idempotencyKey: string;
  operation: NeutralToolOperation;
  ok: false;
  error: HostToolAdapterErrorBody;
};

export type HostToolAdapterResultFrame =
  | HostToolAdapterSuccessResultFrame
  | HostToolAdapterErrorResultFrame;

export interface HostToolAdapterRevokeFrame extends HostToolAdapterWireIdentity {
  kind: "revoke";
}

export interface HostToolAdapterRevokedFrame extends HostToolAdapterWireIdentity {
  kind: "revoked";
}

export interface HostToolAdapterAbortFrame extends HostToolAdapterWireIdentity {
  kind: "abort";
  /** Correlates this abort control exchange. */
  requestId: string;
  /** Identifies the in-flight invoke to cancel. */
  targetRequestId: string;
}

export interface HostToolAdapterAbortedFrame extends HostToolAdapterWireIdentity {
  kind: "aborted";
  requestId: string;
  targetRequestId: string;
  aborted: boolean;
  error?: HostToolAdapterErrorBody;
}

export type HostToolAdapterMessage =
  | HostToolAdapterBindFrame
  | HostToolAdapterBoundFrame
  | HostToolAdapterInvokeFrame
  | HostToolAdapterResultFrame
  | HostToolAdapterRevokeFrame
  | HostToolAdapterRevokedFrame
  | HostToolAdapterAbortFrame
  | HostToolAdapterAbortedFrame;

export interface ExpectedHostToolAdapterBinding {
  hostInstanceId?: string;
  sessionId?: string;
  generation?: number;
  capabilityHandle?: string;
}

export function validateHostToolAdapterDescriptor(
  value: unknown,
  expectedBinding: ExpectedHostToolAdapterBinding = {},
): HostToolAdapterDescriptor {
  const descriptor = objectValue(value, "descriptor", "invalid_tool_adapter_descriptor");
  onlyKeys(
    descriptor,
    [
      "protocolVersion",
      "adapterId",
      "adapterVersion",
      "endpoint",
      "binding",
      "operations",
      "limits",
    ],
    "descriptor",
    "invalid_tool_adapter_descriptor",
  );
  const protocolVersion = requiredString(descriptor, "protocolVersion", 1, 16);
  if (protocolVersion !== TOOL_ADAPTER_PROTOCOL_VERSION) {
    throw validationError(
      "unsupported_tool_adapter_version",
      "unsupported host tool-adapter protocol version",
      "descriptor.protocolVersion",
    );
  }
  const adapterId = requiredString(descriptor, "adapterId", 1, 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(adapterId)) {
    throw validationError(
      "invalid_tool_adapter_identity",
      "adapterId must be a bounded neutral identifier",
      "descriptor.adapterId",
    );
  }
  const adapterVersion = requiredString(descriptor, "adapterVersion", 1, 64);
  if (!SEMVER_PATTERN.test(adapterVersion)) {
    throw validationError(
      "invalid_tool_adapter_identity",
      "adapterVersion must be a semantic version",
      "descriptor.adapterVersion",
    );
  }
  const endpoint = validateEndpoint(descriptor.endpoint);
  const binding = validateBinding(descriptor.binding, expectedBinding);
  const operations = validateOperations(descriptor.operations);
  const limits = validateLimits(descriptor.limits);
  const result: HostToolAdapterDescriptor = {
    protocolVersion: TOOL_ADAPTER_PROTOCOL_VERSION,
    adapterId,
    adapterVersion,
    endpoint,
    binding,
    operations,
    limits,
  };
  validateLifecycleFrameBounds(result);
  return result;
}

export function parseHostToolAdapterMessage(
  value: unknown,
  expectedDescriptor?: HostToolAdapterDescriptor,
): HostToolAdapterMessage {
  const message = objectValue(value, "message", "invalid_tool_adapter_message");
  const kind = requiredString(message, "kind", 1, 16);
  if (!WIRE_KINDS.includes(kind as (typeof WIRE_KINDS)[number])) {
    throw validationError(
      "invalid_tool_adapter_message",
      "host tool-adapter message kind is invalid",
      "message.kind",
    );
  }
  const commonKeys = [
    "protocolVersion",
    "kind",
    "adapterId",
    "adapterVersion",
    "hostInstanceId",
    "sessionId",
    "generation",
  ];
  const identity = validateWireIdentity(message, expectedDescriptor);

  switch (kind) {
    case "bind": {
      onlyKeys(
        message,
        [...commonKeys, "capabilityHandle", "operations", "limits"],
        "message",
        "invalid_tool_adapter_message",
      );
      const capabilityHandle = validateCapabilityHandle(message.capabilityHandle, "message.capabilityHandle");
      if (
        expectedDescriptor !== undefined &&
        capabilityHandle !== expectedDescriptor.binding.capabilityHandle
      ) {
        throw validationError(
          "tool_adapter_binding_mismatch",
          "host tool-adapter bind capability does not match its descriptor",
          "message.capabilityHandle",
        );
      }
      const operations = validateOperations(message.operations);
      const limits = validateLimits(message.limits);
      const frame = { ...identity, kind: "bind" as const, capabilityHandle, operations, limits };
      if (jsonLineBytes(frame) > limits.maxRequestBytes) {
        throw validationError(
          "invalid_tool_adapter_limit",
          "maxRequestBytes cannot contain the bind frame",
          "message.limits.maxRequestBytes",
        );
      }
      validateContractEcho(operations, limits, expectedDescriptor);
      return frame;
    }
    case "bound": {
      onlyKeys(
        message,
        [...commonKeys, "operations", "limits"],
        "message",
        "invalid_tool_adapter_message",
      );
      const operations = validateOperations(message.operations);
      const limits = validateLimits(message.limits);
      const frame = { ...identity, kind: "bound" as const, operations, limits };
      if (jsonLineBytes(frame) > limits.maxResponseBytes) {
        throw validationError(
          "invalid_tool_adapter_limit",
          "maxResponseBytes cannot contain the bound frame",
          "message.limits.maxResponseBytes",
        );
      }
      validateContractEcho(operations, limits, expectedDescriptor);
      return frame;
    }
    case "invoke": {
      onlyKeys(
        message,
        [...commonKeys, "requestId", "idempotencyKey", "operation", "payload"],
        "message",
        "invalid_tool_adapter_message",
      );
      const requestId = boundedIdentifier(message, "requestId", 128);
      const idempotencyKey = boundedIdentifier(message, "idempotencyKey", 512);
      const operation = validateOperation(message.operation, expectedDescriptor);
      return {
        ...identity,
        kind: "invoke",
        requestId,
        idempotencyKey,
        operation,
        payload: validateRequestPayload(operation, message.payload),
      } as HostToolAdapterInvokeFrame;
    }
    case "result": {
      onlyKeys(
        message,
        [
          ...commonKeys,
          "requestId",
          "idempotencyKey",
          "operation",
          "ok",
          "data",
          "error",
        ],
        "message",
        "invalid_tool_adapter_message",
      );
      const requestId = boundedIdentifier(message, "requestId", 128);
      const idempotencyKey = boundedIdentifier(message, "idempotencyKey", 512);
      const operation = validateOperation(message.operation, expectedDescriptor);
      const base = { ...identity, kind: "result" as const, requestId, idempotencyKey, operation };
      if (typeof message.ok !== "boolean") {
        throw validationError(
          "invalid_tool_adapter_message",
          "host tool-adapter result ok must be a boolean",
          "message.ok",
        );
      }
      if (message.ok) {
        if (!("data" in message) || "error" in message) {
          throw validationError(
            "invalid_tool_adapter_message",
            "successful host tool-adapter result must contain only data",
            "message.data",
          );
        }
        return {
          ...base,
          ok: true,
          data: validateResultPayload(operation, message.data),
        } as HostToolAdapterSuccessResultFrame;
      }
      if (!("error" in message) || "data" in message) {
        throw validationError(
          "invalid_tool_adapter_message",
          "failed host tool-adapter result must contain only error",
          "message.error",
        );
      }
      return { ...base, ok: false, error: validateErrorBody(message.error) };
    }
    case "revoke":
    case "revoked":
      onlyKeys(message, commonKeys, "message", "invalid_tool_adapter_message");
      return { ...identity, kind };
    case "abort": {
      onlyKeys(
        message,
        [...commonKeys, "requestId", "targetRequestId"],
        "message",
        "invalid_tool_adapter_message",
      );
      return {
        ...identity,
        kind: "abort",
        requestId: boundedIdentifier(message, "requestId", 128),
        targetRequestId: boundedIdentifier(message, "targetRequestId", 128),
      };
    }
    case "aborted": {
      onlyKeys(
        message,
        [...commonKeys, "requestId", "targetRequestId", "aborted", "error"],
        "message",
        "invalid_tool_adapter_message",
      );
      const aborted = requiredBoolean(message, "aborted");
      if (aborted && "error" in message) {
        throw validationError(
          "invalid_tool_adapter_message",
          "successful aborted frame must not contain an error",
          "message.error",
        );
      }
      return {
        ...identity,
        kind: "aborted",
        requestId: boundedIdentifier(message, "requestId", 128),
        targetRequestId: boundedIdentifier(message, "targetRequestId", 128),
        aborted,
        ...(message.error === undefined ? {} : { error: validateErrorBody(message.error) }),
      };
    }
    default:
      throw validationError(
        "invalid_tool_adapter_message",
        "host tool-adapter message kind is invalid",
        "message.kind",
      );
  }
}

export function validateToolAdapterRelativePath(value: unknown, field = "path"): string {
  if (typeof value !== "string" || value.length < 1 || Buffer.byteLength(value, "utf8") > 4_096) {
    throw validationError(
      "invalid_tool_adapter_path",
      "tool-adapter path must be a bounded root-relative POSIX path",
      field,
    );
  }
  if (
    value.includes("\0") ||
    value.includes("\\") ||
    hasControlCharacters(value) ||
    posixPath.isAbsolute(value) ||
    posixPath.normalize(value) !== value ||
    value.split("/").includes("..")
  ) {
    throw validationError(
      "invalid_tool_adapter_path",
      "tool-adapter path must be a bounded root-relative POSIX path",
      field,
    );
  }
  return value;
}

function validateEndpoint(value: unknown): HostToolAdapterEndpoint {
  const endpoint = objectValue(value, "descriptor.endpoint", "invalid_tool_adapter_endpoint");
  onlyKeys(
    endpoint,
    ["transport", "path"],
    "descriptor.endpoint",
    "invalid_tool_adapter_endpoint",
  );
  if (endpoint.transport !== "unix") {
    throw validationError(
      "invalid_tool_adapter_endpoint",
      "host tool-adapter endpoint transport must be unix",
      "descriptor.endpoint.transport",
    );
  }
  const path = requiredString(endpoint, "path", 1, 4_096);
  if (
    Buffer.byteLength(path, "utf8") > TOOL_ADAPTER_MAX_SOCKET_PATH_BYTES ||
    path === "/" ||
    !posixPath.isAbsolute(path) ||
    posixPath.normalize(path) !== path ||
    path.includes("\0") ||
    hasControlCharacters(path)
  ) {
    throw validationError(
      "invalid_tool_adapter_endpoint",
      "host tool-adapter endpoint must be a canonical absolute Unix socket path",
      "descriptor.endpoint.path",
    );
  }
  return { transport: "unix", path };
}

function validateBinding(
  value: unknown,
  expected: ExpectedHostToolAdapterBinding,
): HostToolAdapterBinding {
  const binding = objectValue(value, "binding", "invalid_tool_adapter_binding");
  onlyKeys(
    binding,
    ["hostInstanceId", "sessionId", "generation", "capabilityHandle"],
    "binding",
    "invalid_tool_adapter_binding",
  );
  const hostInstanceId = boundedOpaqueIdentifier(binding, "hostInstanceId", 1, 128);
  const sessionId = boundedOpaqueIdentifier(binding, "sessionId", 1, 256);
  const generation = requiredInteger(binding, "generation", 0, Number.MAX_SAFE_INTEGER);
  const capabilityHandle = validateCapabilityHandle(
    binding.capabilityHandle,
    "binding.capabilityHandle",
  );
  const result = { hostInstanceId, sessionId, generation, capabilityHandle };
  for (const field of [
    "hostInstanceId",
    "sessionId",
    "generation",
    "capabilityHandle",
  ] as const) {
    if (expected[field] !== undefined && expected[field] !== result[field]) {
      throw validationError(
        "tool_adapter_binding_mismatch",
        "host tool-adapter binding does not match the logical session incarnation",
        `binding.${field}`,
      );
    }
  }
  return result;
}

function validateWireIdentity(
  message: Record<string, unknown>,
  expectedDescriptor: HostToolAdapterDescriptor | undefined,
): HostToolAdapterWireIdentity {
  const protocolVersion = requiredString(message, "protocolVersion", 1, 16);
  if (protocolVersion !== TOOL_ADAPTER_PROTOCOL_VERSION) {
    throw validationError(
      "unsupported_tool_adapter_version",
      "unsupported host tool-adapter protocol version",
      "message.protocolVersion",
    );
  }
  const adapterId = requiredString(message, "adapterId", 1, 128);
  const adapterVersion = requiredString(message, "adapterVersion", 1, 64);
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(adapterId) ||
    !SEMVER_PATTERN.test(adapterVersion)
  ) {
    throw validationError(
      "invalid_tool_adapter_identity",
      "host tool-adapter message identity is invalid",
      "message.adapterId",
    );
  }
  const hostInstanceId = requiredString(message, "hostInstanceId", 1, 128);
  const sessionId = requiredString(message, "sessionId", 1, 256);
  if (hasControlCharacters(hostInstanceId) || hasControlCharacters(sessionId)) {
    throw validationError(
      "invalid_tool_adapter_binding",
      "host tool-adapter session identity contains control characters",
      "message.sessionId",
    );
  }
  const generation = requiredInteger(message, "generation", 0, Number.MAX_SAFE_INTEGER);
  const result = {
    protocolVersion: TOOL_ADAPTER_PROTOCOL_VERSION,
    adapterId,
    adapterVersion,
    hostInstanceId,
    sessionId,
    generation,
  };
  if (expectedDescriptor !== undefined) {
    const expected = {
      adapterId: expectedDescriptor.adapterId,
      adapterVersion: expectedDescriptor.adapterVersion,
      hostInstanceId: expectedDescriptor.binding.hostInstanceId,
      sessionId: expectedDescriptor.binding.sessionId,
      generation: expectedDescriptor.binding.generation,
    };
    for (const field of Object.keys(expected) as Array<keyof typeof expected>) {
      if (result[field] !== expected[field]) {
        throw validationError(
          field === "adapterId" || field === "adapterVersion"
            ? "tool_adapter_identity_mismatch"
            : "tool_adapter_binding_mismatch",
          "host tool-adapter frame identity does not match its descriptor",
          `message.${field}`,
        );
      }
    }
  }
  return result;
}

function validateCapabilityHandle(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    value.length < 32 ||
    value.length > 512 ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  ) {
    throw validationError(
      "invalid_tool_adapter_capability",
      "capabilityHandle must be a bounded base64url value",
      field,
    );
  }
  return value;
}

function validateLifecycleFrameBounds(descriptor: HostToolAdapterDescriptor): void {
  const identity = {
    protocolVersion: TOOL_ADAPTER_PROTOCOL_VERSION,
    adapterId: descriptor.adapterId,
    adapterVersion: descriptor.adapterVersion,
    hostInstanceId: descriptor.binding.hostInstanceId,
    sessionId: descriptor.binding.sessionId,
    generation: descriptor.binding.generation,
  };
  const bindBytes = jsonLineBytes({
    ...identity,
    kind: "bind",
    capabilityHandle: descriptor.binding.capabilityHandle,
    operations: descriptor.operations,
    limits: descriptor.limits,
  });
  if (bindBytes > descriptor.limits.maxRequestBytes) {
    throw validationError(
      "invalid_tool_adapter_limit",
      "maxRequestBytes cannot contain the mandatory bind frame",
      "descriptor.limits.maxRequestBytes",
    );
  }
  const boundBytes = jsonLineBytes({
    ...identity,
    kind: "bound",
    operations: descriptor.operations,
    limits: descriptor.limits,
  });
  if (boundBytes > descriptor.limits.maxResponseBytes) {
    throw validationError(
      "invalid_tool_adapter_limit",
      "maxResponseBytes cannot contain the mandatory bound frame",
      "descriptor.limits.maxResponseBytes",
    );
  }
}

function jsonLineBytes(value: Record<string, unknown>): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8") + 1;
}

function validateContractEcho(
  operations: NeutralToolOperation[],
  limits: HostToolAdapterLimits,
  expectedDescriptor: HostToolAdapterDescriptor | undefined,
): void {
  if (expectedDescriptor === undefined) return;
  if (
    operations.length !== expectedDescriptor.operations.length ||
    operations.some((operation, index) => operation !== expectedDescriptor.operations[index])
  ) {
    throw validationError(
      "tool_adapter_contract_mismatch",
      "host tool-adapter frame operations do not match its descriptor",
      "message.operations",
    );
  }
  for (const field of Object.keys(TOOL_ADAPTER_LIMIT_BOUNDS) as Array<
    keyof HostToolAdapterLimits
  >) {
    if (limits[field] !== expectedDescriptor.limits[field]) {
      throw validationError(
        "tool_adapter_contract_mismatch",
        "host tool-adapter frame limits do not match its descriptor",
        `message.limits.${field}`,
      );
    }
  }
}

function validateOperation(
  value: unknown,
  expectedDescriptor: HostToolAdapterDescriptor | undefined,
): NeutralToolOperation {
  if (!isNeutralToolOperation(value)) {
    throw validationError(
      "unsupported_tool_operation",
      "host tool-adapter operation is not allowlisted",
      "message.operation",
    );
  }
  if (expectedDescriptor !== undefined && !expectedDescriptor.operations.includes(value)) {
    throw validationError(
      "unsupported_tool_operation",
      "host tool-adapter operation was not granted by its descriptor",
      "message.operation",
    );
  }
  return value;
}

function validateOperations(value: unknown): NeutralToolOperation[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > NEUTRAL_TOOL_OPERATIONS.length) {
    throw validationError(
      "unsupported_tool_operation",
      "host tool-adapter operations must be a non-empty bounded allowlist",
      "descriptor.operations",
    );
  }
  const operations: NeutralToolOperation[] = [];
  for (const operation of value) {
    if (!isNeutralToolOperation(operation) || operations.includes(operation)) {
      throw validationError(
        "unsupported_tool_operation",
        "host tool-adapter operation is unknown or duplicated",
        "descriptor.operations",
      );
    }
    operations.push(operation);
  }
  return operations;
}

function validateLimits(value: unknown): HostToolAdapterLimits {
  const limits = objectValue(value, "descriptor.limits", "invalid_tool_adapter_limit");
  const names = Object.keys(TOOL_ADAPTER_LIMIT_BOUNDS) as Array<keyof HostToolAdapterLimits>;
  onlyKeys(limits, names, "descriptor.limits", "invalid_tool_adapter_limit");
  const result = {} as HostToolAdapterLimits;
  for (const name of names) {
    const bounds = TOOL_ADAPTER_LIMIT_BOUNDS[name];
    result[name] = requiredInteger(limits, name, bounds.min, bounds.max);
  }
  return result;
}

function validateRequestPayload(
  operation: NeutralToolOperation,
  value: unknown,
): HostToolAdapterRequestPayloads[NeutralToolOperation] {
  const payload = objectValue(value, "message.payload", "invalid_tool_adapter_payload");
  switch (operation) {
    case "fs.list":
      onlyKeys(payload, ["path", "maxEntries"], "message.payload", "invalid_tool_adapter_payload");
      return {
        path: validateToolAdapterRelativePath(payload.path, "message.payload.path"),
        ...optionalIntegerProperty(payload, "maxEntries", 1, 10_000),
      };
    case "fs.stat":
      onlyKeys(payload, ["path"], "message.payload", "invalid_tool_adapter_payload");
      return { path: validateToolAdapterRelativePath(payload.path, "message.payload.path") };
    case "fs.read":
      onlyKeys(
        payload,
        ["path", "offset", "maxBytes"],
        "message.payload",
        "invalid_tool_adapter_payload",
      );
      return {
        path: validateToolAdapterRelativePath(payload.path, "message.payload.path"),
        ...optionalIntegerProperty(payload, "offset", 0, Number.MAX_SAFE_INTEGER),
        ...optionalIntegerProperty(payload, "maxBytes", 1, TOOL_ADAPTER_MAX_CONTENT_BYTES),
      };
    case "fs.search":
      onlyKeys(
        payload,
        ["path", "query", "maxResults"],
        "message.payload",
        "invalid_tool_adapter_payload",
      );
      return {
        path: validateToolAdapterRelativePath(payload.path, "message.payload.path"),
        query: requiredString(payload, "query", 1, 4_096),
        ...optionalIntegerProperty(payload, "maxResults", 1, 10_000),
      };
    case "fs.write":
      onlyKeys(
        payload,
        ["path", "content", "create", "overwrite", "expectedDigest"],
        "message.payload",
        "invalid_tool_adapter_payload",
      );
      return {
        path: validateToolAdapterRelativePath(payload.path, "message.payload.path"),
        content: boundedContent(payload, "content"),
        ...optionalBooleanProperty(payload, "create"),
        ...optionalBooleanProperty(payload, "overwrite"),
        ...optionalDigestProperty(payload, "expectedDigest"),
      };
    case "fs.edit": {
      onlyKeys(
        payload,
        ["path", "edits", "expectedDigest"],
        "message.payload",
        "invalid_tool_adapter_payload",
      );
      if (!Array.isArray(payload.edits) || payload.edits.length < 1 || payload.edits.length > 256) {
        throw validationError(
          "invalid_tool_adapter_payload",
          "fs.edit edits must be a non-empty bounded array",
          "message.payload.edits",
        );
      }
      const edits = payload.edits.map((value, index) => {
        const edit = objectValue(
          value,
          `message.payload.edits[${index}]`,
          "invalid_tool_adapter_payload",
        );
        onlyKeys(
          edit,
          ["oldText", "newText"],
          `message.payload.edits[${index}]`,
          "invalid_tool_adapter_payload",
        );
        const oldText = boundedContent(edit, "oldText", 1);
        const newText = boundedContent(edit, "newText", 0);
        return { oldText, newText };
      });
      return {
        path: validateToolAdapterRelativePath(payload.path, "message.payload.path"),
        edits,
        ...optionalDigestProperty(payload, "expectedDigest"),
      };
    }
  }
}

function validateResultPayload(
  operation: NeutralToolOperation,
  value: unknown,
): HostToolAdapterResultPayloads[NeutralToolOperation] {
  const data = objectValue(value, "message.data", "invalid_tool_adapter_result");
  switch (operation) {
    case "fs.list": {
      onlyKeys(data, ["entries", "truncated"], "message.data", "invalid_tool_adapter_result");
      if (!Array.isArray(data.entries) || data.entries.length > 10_000) {
        throw validationError(
          "invalid_tool_adapter_result",
          "fs.list entries must be a bounded array",
          "message.data.entries",
        );
      }
      const entries = data.entries.map((value, index) => {
        const entry = objectValue(
          value,
          `message.data.entries[${index}]`,
          "invalid_tool_adapter_result",
        );
        onlyKeys(
          entry,
          ["name", "type", "size", "modifiedAt"],
          `message.data.entries[${index}]`,
          "invalid_tool_adapter_result",
        );
        const name = requiredString(entry, "name", 1, 255);
        if (name === "." || name === ".." || name.includes("/") || hasControlCharacters(name)) {
          throw validationError(
            "invalid_tool_adapter_result",
            "fs.list entry name must be one safe path segment",
            `message.data.entries[${index}].name`,
          );
        }
        const type = fileType(entry.type, `message.data.entries[${index}].type`);
        return {
          name,
          type,
          ...optionalIntegerProperty(entry, "size", 0, Number.MAX_SAFE_INTEGER),
          ...optionalTimestampProperty(entry, "modifiedAt"),
        };
      });
      return {
        entries,
        truncated: requiredBoolean(data, "truncated"),
      };
    }
    case "fs.stat":
      onlyKeys(
        data,
        ["type", "size", "modifiedAt"],
        "message.data",
        "invalid_tool_adapter_result",
      );
      return {
        type: fileType(data.type, "message.data.type"),
        size: requiredInteger(data, "size", 0, Number.MAX_SAFE_INTEGER),
        ...optionalTimestampProperty(data, "modifiedAt"),
      };
    case "fs.read":
      onlyKeys(
        data,
        ["content", "bytesRead", "eof"],
        "message.data",
        "invalid_tool_adapter_result",
      );
      return {
        content: boundedContent(data, "content", 0),
        bytesRead: requiredInteger(data, "bytesRead", 0, TOOL_ADAPTER_MAX_CONTENT_BYTES),
        eof: requiredBoolean(data, "eof"),
      };
    case "fs.search": {
      onlyKeys(data, ["matches", "truncated"], "message.data", "invalid_tool_adapter_result");
      if (!Array.isArray(data.matches) || data.matches.length > 10_000) {
        throw validationError(
          "invalid_tool_adapter_result",
          "fs.search matches must be a bounded array",
          "message.data.matches",
        );
      }
      const matches = data.matches.map((value, index) => {
        const match = objectValue(
          value,
          `message.data.matches[${index}]`,
          "invalid_tool_adapter_result",
        );
        onlyKeys(
          match,
          ["path", "line", "column", "text"],
          `message.data.matches[${index}]`,
          "invalid_tool_adapter_result",
        );
        return {
          path: validateToolAdapterRelativePath(
            match.path,
            `message.data.matches[${index}].path`,
          ),
          line: requiredInteger(match, "line", 1, Number.MAX_SAFE_INTEGER),
          column: requiredInteger(match, "column", 1, Number.MAX_SAFE_INTEGER),
          text: requiredString(match, "text", 0, 4_096),
        };
      });
      return { matches, truncated: requiredBoolean(data, "truncated") };
    }
    case "fs.write":
      onlyKeys(
        data,
        ["created", "bytesWritten", "digest"],
        "message.data",
        "invalid_tool_adapter_result",
      );
      return {
        created: requiredBoolean(data, "created"),
        bytesWritten: requiredInteger(data, "bytesWritten", 0, TOOL_ADAPTER_MAX_CONTENT_BYTES),
        digest: requiredDigest(data, "digest"),
      };
    case "fs.edit":
      onlyKeys(
        data,
        ["replacements", "digest"],
        "message.data",
        "invalid_tool_adapter_result",
      );
      return {
        replacements: requiredInteger(data, "replacements", 0, 256),
        digest: requiredDigest(data, "digest"),
      };
  }
}

function validateErrorBody(value: unknown): HostToolAdapterErrorBody {
  const error = objectValue(value, "message.error", "invalid_tool_adapter_result");
  onlyKeys(
    error,
    ["code", "message", "retryable"],
    "message.error",
    "invalid_tool_adapter_result",
  );
  const code = requiredString(error, "code", 1, 128);
  if (!/^[a-z][a-z0-9_]*$/.test(code)) {
    throw validationError(
      "invalid_tool_adapter_result",
      "host tool-adapter error code is invalid",
      "message.error.code",
    );
  }
  return {
    code,
    message: requiredString(error, "message", 1, 1_024),
    retryable: requiredBoolean(error, "retryable"),
  };
}

const SEMVER_PATTERN =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;

function objectValue(
  value: unknown,
  field: string,
  code: string,
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw validationError(code, `${field} must be an object`, field);
  }
  return value as Record<string, unknown>;
}

function onlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  field: string,
  code: string,
): void {
  const allowedKeys = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      throw validationError(code, `${field} contains an unsupported field`, `${field}.${key}`);
    }
  }
}

function requiredString(
  source: Record<string, unknown>,
  field: string,
  min: number,
  max: number,
): string {
  const value = source[field];
  if (typeof value !== "string" || value.length < min || value.length > max) {
    throw validationError(
      "invalid_tool_adapter_field",
      `${field} must be a bounded string`,
      field,
    );
  }
  return value;
}

function boundedIdentifier(
  source: Record<string, unknown>,
  field: string,
  max: number,
): string {
  const value = requiredString(source, field, 1, max);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)) {
    throw validationError(
      "invalid_tool_adapter_message",
      `${field} must be a bounded identifier`,
      `message.${field}`,
    );
  }
  return value;
}

function boundedOpaqueIdentifier(
  source: Record<string, unknown>,
  field: string,
  min: number,
  max: number,
): string {
  const value = requiredString(source, field, min, max);
  if (hasControlCharacters(value)) {
    throw validationError(
      "invalid_tool_adapter_binding",
      `${field} contains control characters`,
      `binding.${field}`,
    );
  }
  return value;
}

function requiredInteger(
  source: Record<string, unknown>,
  field: string,
  min: number,
  max: number,
): number {
  const value = source[field];
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    throw validationError(
      field in TOOL_ADAPTER_LIMIT_BOUNDS
        ? "invalid_tool_adapter_limit"
        : "invalid_tool_adapter_field",
      `${field} must be a bounded safe integer`,
      field,
    );
  }
  return value as number;
}

function requiredBoolean(source: Record<string, unknown>, field: string): boolean {
  const value = source[field];
  if (typeof value !== "boolean") {
    throw validationError(
      "invalid_tool_adapter_field",
      `${field} must be a boolean`,
      field,
    );
  }
  return value;
}

function optionalIntegerProperty(
  source: Record<string, unknown>,
  field: string,
  min: number,
  max: number,
): Record<string, number> {
  if (source[field] === undefined) return {};
  return { [field]: requiredInteger(source, field, min, max) };
}

function optionalBooleanProperty(
  source: Record<string, unknown>,
  field: string,
): Record<string, boolean> {
  if (source[field] === undefined) return {};
  return { [field]: requiredBoolean(source, field) };
}

function requiredDigest(source: Record<string, unknown>, field: string): string {
  const value = requiredString(source, field, 64, 64);
  if (!DIGEST_PATTERN.test(value)) {
    throw validationError(
      "invalid_tool_adapter_field",
      `${field} must be a lowercase SHA-256 digest`,
      field,
    );
  }
  return value;
}

function optionalDigestProperty(
  source: Record<string, unknown>,
  field: string,
): Record<string, string> {
  if (source[field] === undefined) return {};
  return { [field]: requiredDigest(source, field) };
}

function optionalTimestampProperty(
  source: Record<string, unknown>,
  field: string,
): Record<string, string> {
  if (source[field] === undefined) return {};
  const value = requiredString(source, field, 20, 64);
  if (!TIMESTAMP_PATTERN.test(value)) {
    throw validationError(
      "invalid_tool_adapter_result",
      `${field} must be a UTC RFC 3339 timestamp`,
      field,
    );
  }
  return { [field]: value };
}

function boundedContent(
  source: Record<string, unknown>,
  field: string,
  min = 0,
): string {
  const value = source[field];
  if (
    typeof value !== "string" ||
    value.length < min ||
    Buffer.byteLength(value, "utf8") > TOOL_ADAPTER_MAX_CONTENT_BYTES
  ) {
    throw validationError(
      "invalid_tool_adapter_payload",
      `${field} exceeds the host tool-adapter content bound`,
      field,
    );
  }
  return value;
}

function fileType(value: unknown, field: string): "file" | "directory" {
  if (value !== "file" && value !== "directory") {
    throw validationError(
      "invalid_tool_adapter_result",
      "filesystem result type must be file or directory",
      field,
    );
  }
  return value;
}

function isNeutralToolOperation(value: unknown): value is NeutralToolOperation {
  return (
    typeof value === "string" &&
    (NEUTRAL_TOOL_OPERATIONS as readonly string[]).includes(value)
  );
}

function hasControlCharacters(value: string): boolean {
  return /[\u0000-\u001f\u007f]/.test(value);
}

function validationError(code: string, message: string, field: string): ProtocolValidationError {
  return new ProtocolValidationError(code, message, { field });
}
