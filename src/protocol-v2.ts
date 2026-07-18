import {
  PROTOCOL_V2_VERSION,
  ProtocolValidationError,
  parseCommand,
  type EventEnvelope,
  type OpenCommand,
  type ParseLimits,
  type ProtocolCommand,
  type ResourcePolicy,
  type ResponseEnvelope,
  type SessionTarget,
  type ModelPolicy,
} from "./protocol.js";
import {
  validateHostToolAdapterDescriptor,
  type HostToolAdapterPolicy,
} from "./tool-adapter-protocol.js";

export interface ResourcePolicyV2 extends Omit<ResourcePolicy, "tools"> {
  tools: "none" | HostToolAdapterPolicy;
}

export interface OpenPayloadV2 {
  cwd: string;
  name?: string;
  agentDir?: string;
  session: SessionTarget;
  model?: ModelPolicy;
  resources?: ResourcePolicyV2;
}

export interface OpenCommandV2 {
  protocolVersion: string;
  requestId: string;
  operation: "open";
  sessionId: string;
  generation: number;
  payload: OpenPayloadV2;
  [key: string]: unknown;
}

export type ProtocolV2Command =
  | OpenCommandV2
  | Exclude<ProtocolCommand, OpenCommand>;
export type SupportedProtocolCommand = ProtocolCommand | ProtocolV2Command;

export interface ProtocolV2ResponseEnvelope<T = unknown>
  extends Omit<ResponseEnvelope<T>, "protocolVersion"> {
  protocolVersion: string;
}

export interface ProtocolV2EventEnvelope<T = unknown>
  extends Omit<EventEnvelope<T>, "protocolVersion"> {
  protocolVersion: string;
}

export interface ProtocolV2ParseOptions extends ParseLimits {
  /** When supplied, v2 open rejects descriptors minted for another host incarnation. */
  expectedHostInstanceId?: string;
}

/**
 * Validate one protocol-v2 command without enabling it in the v1 server.
 * Runtime dispatch must opt into this parser and plumb the validated descriptor
 * through its secret-safe, generation-bound admission path.
 */
export function parseProtocolV2Command(
  value: unknown,
  options: ProtocolV2ParseOptions = {},
): ProtocolV2Command {
  const command = commandRecord(value);
  const version = command.protocolVersion;
  if (typeof version !== "string" || !/^2\.\d+$/.test(version)) {
    throw new ProtocolValidationError(
      typeof version === "string" && /^\d+\.\d+$/.test(version)
        ? "incompatible_protocol"
        : "invalid_protocol_version",
      "protocolVersion must be a supported 2.x version",
      { supported: PROTOCOL_V2_VERSION },
    );
  }

  if (command.operation !== "open") {
    validateThroughV1(command, options);
    return command as unknown as ProtocolV2Command;
  }

  const payload = objectValue(command.payload, "payload");
  const resourcesValue = payload.resources;
  let validatedPolicy: "none" | HostToolAdapterPolicy | undefined;
  let projectedResources = resourcesValue;
  if (resourcesValue !== undefined) {
    const resources = objectValue(resourcesValue, "payload.resources");
    const tools = resources.tools;
    if (tools === "none") {
      validatedPolicy = "none";
    } else {
      const policy = objectValue(tools, "payload.resources.tools");
      onlyKeys(policy, ["mode", "descriptor"], "payload.resources.tools");
      if (policy.mode !== "host-adapter") {
        throw new ProtocolValidationError(
          "unsupported_resource_policy",
          "tools must be 'none' or a host-adapter policy in protocol v2",
          { field: "payload.resources.tools.mode" },
        );
      }
      const sessionId = command.sessionId;
      const generation = command.generation;
      if (typeof sessionId !== "string" || !Number.isSafeInteger(generation)) {
        // Preserve the established v1 identity error shape.
        validateThroughV1(
          {
            ...command,
            payload: { ...payload, resources: { ...resources, tools: "none" } },
          },
          options,
        );
      }
      const descriptor = validateHostToolAdapterDescriptor(policy.descriptor, {
        ...(options.expectedHostInstanceId === undefined
          ? {}
          : { hostInstanceId: options.expectedHostInstanceId }),
        ...(typeof sessionId === "string" ? { sessionId } : {}),
        ...(Number.isSafeInteger(generation) ? { generation: generation as number } : {}),
      });
      validatedPolicy = { mode: "host-adapter", descriptor };
    }
    projectedResources = { ...resources, tools: "none" };
  }

  validateThroughV1(
    {
      ...command,
      payload: {
        ...payload,
        ...(projectedResources === undefined ? {} : { resources: projectedResources }),
      },
    },
    options,
  );

  return {
    ...command,
    protocolVersion: version,
    payload: {
      ...payload,
      ...(resourcesValue === undefined
        ? {}
        : {
            resources: {
              ...(resourcesValue as Record<string, unknown>),
              tools: validatedPolicy,
            },
          }),
    },
  } as unknown as OpenCommandV2;
}

/** Dispatch to the v1 or v2 validator by command major. No server opts in implicitly. */
export function parseSupportedProtocolCommand(
  value: unknown,
  options: ProtocolV2ParseOptions = {},
): SupportedProtocolCommand {
  const command = commandRecord(value);
  const version = command.protocolVersion;
  if (typeof version === "string" && /^2\.\d+$/.test(version)) {
    return parseProtocolV2Command(value, options);
  }
  return parseCommand(value, options);
}

function validateThroughV1(
  command: Record<string, unknown>,
  options: ParseLimits,
): ProtocolCommand {
  return parseCommand({ ...command, protocolVersion: "1.0" }, options);
}

function commandRecord(value: unknown): Record<string, unknown> {
  return objectValue(value, "command");
}

function objectValue(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ProtocolValidationError("invalid_field", `${field} must be an object`, { field });
  }
  return value as Record<string, unknown>;
}

function onlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  field: string,
): void {
  const allowedKeys = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      throw new ProtocolValidationError(
        "invalid_tool_adapter_descriptor",
        `${field} contains an unsupported field`,
        { field: `${field}.${key}` },
      );
    }
  }
}
