import { resolve } from "node:path";

import type { JsonObject, SessionEnvironmentSummary, SessionSpec } from "./session-api.js";
import type { OpenPayload } from "./protocol.js";

export interface SessionConfigurationLimits {
  maxEnvironmentEntries: number;
  maxEnvironmentValueBytes: number;
  maxEnvironmentTotalBytes: number;
  maxResourcePathsPerKind: number;
  maxSettingsDepth: number;
  maxSettingsProperties: number;
  maxSettingsStringBytes: number;
}

export const DEFAULT_SESSION_CONFIGURATION_LIMITS: Readonly<SessionConfigurationLimits> = {
  maxEnvironmentEntries: 256,
  maxEnvironmentValueBytes: 64 * 1024,
  maxEnvironmentTotalBytes: 256 * 1024,
  maxResourcePathsPerKind: 128,
  maxSettingsDepth: 16,
  maxSettingsProperties: 512,
  maxSettingsStringBytes: 256 * 1024,
};

export type PersistedSessionConfiguration = Omit<SessionSpec, "env">;

export interface PreparedSessionRuntimeOptions {
  persistedSpec: PersistedSessionConfiguration;
  environmentOverlay: Readonly<Record<string, string>>;
  /** Controller-resolved Pi session path for a target.sourceSession fork reference. */
  resolvedSourceSessionPath?: string;
}

export interface PreparedSessionOpenRequest {
  cwd: string;
  agentDir?: string;
  runtimeOptions: PreparedSessionRuntimeOptions;
}

export interface PreparedSessionConfiguration {
  persistedSpec: PersistedSessionConfiguration;
  environmentSummary: SessionEnvironmentSummary;
  environmentOverlay: Readonly<Record<string, string>>;
  runtimeOptions: PreparedSessionRuntimeOptions;
  openRequest: PreparedSessionOpenRequest;
}

export type SessionConfigurationStatusClass =
  | "invalid"
  | "unsupported"
  | "too_large"
  | "credentials_required";

export class SessionConfigurationError extends Error {
  readonly code:
    | "invalid_session_spec"
    | "session_configuration_too_large"
    | "unsupported_session_configuration"
    | "credentials_required";
  readonly statusClass: SessionConfigurationStatusClass;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(
    code: SessionConfigurationError["code"],
    statusClass: SessionConfigurationStatusClass,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "SessionConfigurationError";
    this.code = code;
    this.statusClass = statusClass;
    this.details = details;
  }
}

export function parseSessionConfiguration(
  value: unknown,
  options: {
    baseDir?: string;
    limits?: Partial<SessionConfigurationLimits>;
  } = {},
): PreparedSessionConfiguration {
  const limits = resolveLimits(options.limits);
  const input = record(value, "spec");
  rejectUnknown(input, [
    "cwd",
    "name",
    "agentDir",
    "target",
    "model",
    "tools",
    "resources",
    "settings",
    "env",
    "isolation",
  ], "spec");
  const baseDir = resolve(options.baseDir ?? process.cwd());
  const cwd = resolve(baseDir, boundedString(input.cwd, "spec.cwd", 4096));
  const target = parseTarget(input.target, cwd);
  const spec: PersistedSessionConfiguration = { cwd, target };

  if (input.name !== undefined) spec.name = boundedString(input.name, "spec.name", 128);
  if (input.agentDir !== undefined) {
    spec.agentDir = resolve(baseDir, boundedString(input.agentDir, "spec.agentDir", 4096));
  }
  if (input.model !== undefined) spec.model = parseModel(input.model);
  if (input.tools !== undefined) spec.tools = parseTools(input.tools);
  if (input.resources !== undefined) {
    spec.resources = parseResources(input.resources, cwd, limits);
  }
  if (input.settings !== undefined) {
    spec.settings = cloneJsonObject(input.settings, limits);
  }
  if (input.isolation !== undefined) {
    const isolation = record(input.isolation, "spec.isolation");
    rejectUnknown(isolation, ["mode"], "spec.isolation");
    if (isolation.mode !== "unisolated") {
      throw new SessionConfigurationError(
        "unsupported_session_configuration",
        "unsupported",
        "only unisolated in-process execution is supported",
      );
    }
    spec.isolation = { mode: "unisolated" };
  } else {
    spec.isolation = { mode: "unisolated" };
  }
  if (
    spec.settings !== undefined &&
    Object.prototype.hasOwnProperty.call(spec.settings, "packages") &&
    spec.resources?.projectTrust !== "approve"
  ) {
    throw new SessionConfigurationError(
      "unsupported_session_configuration",
      "unsupported",
      "settings.packages requires explicit projectTrust=approve in unisolated mode",
    );
  }

  const environmentOverlay = Object.freeze(parseEnvironment(input.env, limits));
  const keys = Object.keys(environmentOverlay).sort((left, right) => left.localeCompare(right));
  const runtimeOptions: PreparedSessionRuntimeOptions = {
    persistedSpec: spec,
    environmentOverlay,
  };
  const openRequest: PreparedSessionOpenRequest = {
    cwd: spec.cwd,
    ...(spec.agentDir === undefined ? {} : { agentDir: spec.agentDir }),
    runtimeOptions,
  };
  return {
    persistedSpec: spec,
    environmentSummary: {
      keys,
      persistence: "memory-only",
      provisioned: true,
    },
    environmentOverlay,
    runtimeOptions,
    openRequest,
  };
}

export const prepareSessionConfiguration = parseSessionConfiguration;

/** Stable transport payload for opening a prepared/persisted session spec. */
export function sessionOpenPayloadFromSpec(
  spec: PersistedSessionConfiguration,
): OpenPayload {
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

export function requireProvisionedEnvironment(
  summary: SessionEnvironmentSummary,
  overlay: Readonly<Record<string, string>> | undefined,
): void {
  if (summary.keys.length === 0) return;
  if (!summary.provisioned || overlay === undefined) {
    throw new SessionConfigurationError(
      "credentials_required",
      "credentials_required",
      "session environment must be re-provisioned after restart",
      { keys: [...summary.keys] },
    );
  }
}

export function unprovisionedEnvironmentSummary(
  summary: SessionEnvironmentSummary,
): SessionEnvironmentSummary {
  return { ...summary, provisioned: summary.keys.length === 0 };
}

export function toolConfiguration(spec: PersistedSessionConfiguration): {
  noTools?: "all" | "builtin";
  tools?: string[];
  excludeTools?: string[];
} {
  const tools = spec.tools;
  if (tools === undefined) return {};
  const result: { noTools?: "all" | "builtin"; tools?: string[]; excludeTools?: string[] } = {};
  switch (tools.mode ?? "default") {
    case "default":
      break;
    case "none":
      result.noTools = "all";
      result.tools = [];
      break;
    case "no-builtin":
      result.noTools = "builtin";
      break;
    case "allowlist":
      result.tools = [...(tools.include ?? [])];
      break;
  }
  if (tools.exclude !== undefined) result.excludeTools = [...tools.exclude];
  return result;
}

export function extensionFlagValues(
  spec: PersistedSessionConfiguration,
): Map<string, boolean | string> | undefined {
  const flags = spec.resources?.extensionFlags;
  return flags === undefined ? undefined : new Map(Object.entries(flags));
}

/**
 * Resolve an API-key-style provider credential from a session-local environment
 * without mutating process.env. OAuth/profile/ADC flows intentionally remain
 * outside this helper and keep their configured AuthStorage behavior.
 */
export function providerApiKeyFromEnvironment(
  provider: string,
  environment: Readonly<Record<string, string>>,
): string | undefined {
  const names = PROVIDER_API_KEY_ENV[provider];
  if (names === undefined) return undefined;
  for (const name of names) {
    const value = environment[name];
    if (value !== undefined && value.length > 0) return value;
  }
  return undefined;
}

const PROVIDER_API_KEY_ENV: Readonly<Record<string, readonly string[]>> = {
  "github-copilot": ["COPILOT_GITHUB_TOKEN"],
  anthropic: ["ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY"],
  openai: ["OPENAI_API_KEY"],
  "azure-openai-responses": ["AZURE_OPENAI_API_KEY"],
  nvidia: ["NVIDIA_API_KEY"],
  deepseek: ["DEEPSEEK_API_KEY"],
  google: ["GEMINI_API_KEY"],
  "google-vertex": ["GOOGLE_CLOUD_API_KEY"],
  groq: ["GROQ_API_KEY"],
  cerebras: ["CEREBRAS_API_KEY"],
  xai: ["XAI_API_KEY"],
  openrouter: ["OPENROUTER_API_KEY"],
  "vercel-ai-gateway": ["AI_GATEWAY_API_KEY"],
  zai: ["ZAI_API_KEY"],
  mistral: ["MISTRAL_API_KEY"],
  minimax: ["MINIMAX_API_KEY"],
  "minimax-cn": ["MINIMAX_CN_API_KEY"],
  moonshotai: ["MOONSHOT_API_KEY"],
  "moonshotai-cn": ["MOONSHOT_API_KEY"],
  huggingface: ["HF_TOKEN"],
  fireworks: ["FIREWORKS_API_KEY"],
  together: ["TOGETHER_API_KEY"],
  opencode: ["OPENCODE_API_KEY"],
  "opencode-go": ["OPENCODE_API_KEY"],
  "kimi-coding": ["KIMI_API_KEY"],
};

function parseTarget(value: unknown, cwd: string): PersistedSessionConfiguration["target"] {
  const input = record(value, "spec.target");
  rejectUnknown(input, ["mode", "path", "sourceSession", "entryId", "sessionDir"], "spec.target");
  if (!["new", "continue", "open", "fork", "memory"].includes(input.mode as string)) {
    invalid("spec.target.mode is invalid");
  }
  const mode = input.mode as PersistedSessionConfiguration["target"]["mode"];
  const result: PersistedSessionConfiguration["target"] = { mode };
  if (input.path !== undefined) {
    result.path = resolve(cwd, boundedString(input.path, "spec.target.path", 4096));
  }
  if (input.sessionDir !== undefined) {
    result.sessionDir = resolve(cwd, boundedString(input.sessionDir, "spec.target.sessionDir", 4096));
  }
  if (input.sourceSession !== undefined) {
    result.sourceSession = boundedString(input.sourceSession, "spec.target.sourceSession", 512);
  }
  if (input.entryId !== undefined) {
    result.entryId = boundedString(input.entryId, "spec.target.entryId", 512);
  }
  if (mode === "open" && result.path === undefined) invalid("open target requires path");
  if (mode === "fork" && result.sourceSession === undefined) {
    invalid("fork target requires sourceSession");
  }
  return result;
}

function parseModel(value: unknown): NonNullable<PersistedSessionConfiguration["model"]> {
  const input = record(value, "spec.model");
  rejectUnknown(input, ["provider", "id", "thinkingLevel", "scopedModels"], "spec.model");
  const result: NonNullable<PersistedSessionConfiguration["model"]> = {};
  if (input.provider !== undefined) {
    result.provider = boundedString(input.provider, "spec.model.provider", 128);
  }
  if (input.id !== undefined) result.id = boundedString(input.id, "spec.model.id", 256);
  if (input.thinkingLevel !== undefined) {
    if (!["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(input.thinkingLevel as string)) {
      invalid("spec.model.thinkingLevel is invalid");
    }
    result.thinkingLevel = input.thinkingLevel as Exclude<
      NonNullable<PersistedSessionConfiguration["model"]>["thinkingLevel"],
      undefined
    >;
  }
  if (input.scopedModels !== undefined) {
    result.scopedModels = uniqueStrings(input.scopedModels, "spec.model.scopedModels", 128, 512);
  }
  return result;
}

function parseTools(value: unknown): NonNullable<PersistedSessionConfiguration["tools"]> {
  const input = record(value, "spec.tools");
  rejectUnknown(input, ["mode", "include", "exclude"], "spec.tools");
  const result: NonNullable<PersistedSessionConfiguration["tools"]> = {};
  if (input.mode !== undefined) {
    if (!["default", "none", "no-builtin", "allowlist"].includes(input.mode as string)) {
      invalid("spec.tools.mode is invalid");
    }
    result.mode = input.mode as Exclude<
      NonNullable<PersistedSessionConfiguration["tools"]>["mode"],
      undefined
    >;
  }
  if (input.include !== undefined) {
    result.include = uniqueStrings(input.include, "spec.tools.include", 256, 128);
  }
  if (input.exclude !== undefined) {
    result.exclude = uniqueStrings(input.exclude, "spec.tools.exclude", 256, 128);
  }
  if (result.mode === "allowlist" && result.include === undefined) result.include = [];
  return result;
}

function parseResources(
  value: unknown,
  cwd: string,
  limits: SessionConfigurationLimits,
): NonNullable<PersistedSessionConfiguration["resources"]> {
  const input = record(value, "spec.resources");
  rejectUnknown(input, [
    "extensions",
    "skills",
    "promptTemplates",
    "themes",
    "noExtensions",
    "noSkills",
    "noPromptTemplates",
    "noThemes",
    "noContextFiles",
    "systemPrompt",
    "appendSystemPrompt",
    "projectTrust",
    "extensionFlags",
  ], "spec.resources");
  const result: NonNullable<PersistedSessionConfiguration["resources"]> = {};
  for (const [field, target] of [
    ["extensions", "extensions"],
    ["skills", "skills"],
    ["promptTemplates", "promptTemplates"],
    ["themes", "themes"],
  ] as const) {
    if (input[field] !== undefined) {
      result[target] = uniqueStrings(
        input[field],
        `spec.resources.${field}`,
        limits.maxResourcePathsPerKind,
        4096,
      ).map((path) => resolve(cwd, path));
    }
  }
  for (const field of [
    "noExtensions",
    "noSkills",
    "noPromptTemplates",
    "noThemes",
    "noContextFiles",
  ] as const) {
    if (input[field] !== undefined) result[field] = boolean(input[field], `spec.resources.${field}`);
  }
  if (input.systemPrompt !== undefined) {
    result.systemPrompt = boundedString(input.systemPrompt, "spec.resources.systemPrompt", 262144);
  }
  if (input.appendSystemPrompt !== undefined) {
    result.appendSystemPrompt = stringArray(
      input.appendSystemPrompt,
      "spec.resources.appendSystemPrompt",
      64,
      262144,
    );
  }
  if (input.projectTrust !== undefined) {
    if (!["default", "approve", "deny"].includes(input.projectTrust as string)) {
      invalid("spec.resources.projectTrust is invalid");
    }
    result.projectTrust = input.projectTrust as Exclude<
      NonNullable<PersistedSessionConfiguration["resources"]>["projectTrust"],
      undefined
    >;
  }
  if (input.extensionFlags !== undefined) {
    const flags = record(input.extensionFlags, "spec.resources.extensionFlags");
    if (Object.keys(flags).length > 256) invalid("too many extension flags");
    const normalized: Record<string, string | boolean> = Object.create(null) as Record<
      string,
      string | boolean
    >;
    for (const [key, flag] of Object.entries(flags)) {
      boundedString(key, "extension flag name", 128);
      if (typeof flag !== "boolean" && typeof flag !== "string") {
        invalid("extension flag values must be strings or booleans");
      }
      normalized[key] = typeof flag === "string" ? boundedString(flag, `extension flag ${key}`, 4096) : flag;
    }
    result.extensionFlags = normalized;
  }
  return result;
}

function parseEnvironment(
  value: unknown,
  limits: SessionConfigurationLimits,
): Record<string, string> {
  if (value === undefined) return Object.create(null) as Record<string, string>;
  const input = record(value, "spec.env");
  const entries = Object.entries(input);
  if (entries.length > limits.maxEnvironmentEntries) {
    environmentTooLarge("environment has too many entries", {
      maxEnvironmentEntries: limits.maxEnvironmentEntries,
    });
  }
  const result: Record<string, string> = Object.create(null) as Record<string, string>;
  let totalBytes = 0;
  for (const [key, rawValue] of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || key.length > 256) {
      invalid(`environment key is invalid: ${key}`);
    }
    if (typeof rawValue !== "string") invalid(`environment value must be a string: ${key}`);
    const valueBytes = Buffer.byteLength(rawValue as string, "utf8");
    if (valueBytes > limits.maxEnvironmentValueBytes) {
      environmentTooLarge("environment value exceeds byte limit", {
        key,
        maxEnvironmentValueBytes: limits.maxEnvironmentValueBytes,
      });
    }
    totalBytes += Buffer.byteLength(key, "utf8") + valueBytes;
    if (totalBytes > limits.maxEnvironmentTotalBytes) {
      environmentTooLarge("environment exceeds aggregate byte limit", {
        maxEnvironmentTotalBytes: limits.maxEnvironmentTotalBytes,
      });
    }
    result[key] = rawValue as string;
  }
  return result;
}

function cloneJsonObject(value: unknown, limits: SessionConfigurationLimits): JsonObject {
  const counters = { properties: 0, stringBytes: 0 };
  const cloned = cloneJson(value, "spec.settings", 0, limits, counters);
  if (!isRecord(cloned)) invalid("spec.settings must be an object");
  return cloned as JsonObject;
}

function cloneJson(
  value: unknown,
  path: string,
  depth: number,
  limits: SessionConfigurationLimits,
  counters: { properties: number; stringBytes: number },
): unknown {
  if (depth > limits.maxSettingsDepth) invalid(`${path} exceeds maximum depth`);
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) invalid(`${path} contains a non-finite number`);
    return value;
  }
  if (typeof value === "string") {
    counters.stringBytes += Buffer.byteLength(value, "utf8");
    if (counters.stringBytes > limits.maxSettingsStringBytes) {
      invalid("spec.settings strings exceed aggregate byte limit");
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((child, index) => cloneJson(child, `${path}[${index}]`, depth + 1, limits, counters));
  }
  if (!isRecord(value)) invalid(`${path} contains a non-JSON value`);
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [key, child] of Object.entries(value)) {
    if (["__proto__", "prototype", "constructor"].includes(key)) {
      invalid(`${path} contains a forbidden key`);
    }
    counters.properties += 1;
    if (counters.properties > limits.maxSettingsProperties) {
      invalid("spec.settings has too many properties");
    }
    result[key] = cloneJson(child, `${path}.${key}`, depth + 1, limits, counters);
  }
  return result;
}

function uniqueStrings(
  value: unknown,
  path: string,
  maxItems: number,
  maxLength: number,
): string[] {
  const values = stringArray(value, path, maxItems, maxLength);
  if (new Set(values).size !== values.length) invalid(`${path} contains duplicates`);
  return values;
}

function stringArray(value: unknown, path: string, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value)) invalid(`${path} must be an array`);
  if (value.length > maxItems) invalid(`${path} has too many items`);
  return value.map((item, index) => boundedString(item, `${path}[${index}]`, maxLength));
}

function boundedString(value: unknown, path: string, maxLength: number): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maxLength) {
    invalid(`${path} must be a non-empty string no longer than ${maxLength} characters`);
  }
  return value as string;
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") invalid(`${path} must be a boolean`);
  return value as boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) invalid(`${path} must be an object`);
  return value;
}

function rejectUnknown(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) invalid(`${path} contains unknown field: ${key}`);
  }
}

function resolveLimits(overrides: Partial<SessionConfigurationLimits> | undefined): SessionConfigurationLimits {
  const limits = { ...DEFAULT_SESSION_CONFIGURATION_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  }
  return limits;
}

function invalid(message: string): never {
  throw new SessionConfigurationError("invalid_session_spec", "invalid", message);
}

function environmentTooLarge(message: string, details: Record<string, unknown>): never {
  throw new SessionConfigurationError(
    "session_configuration_too_large",
    "too_large",
    message,
    details,
  );
}
