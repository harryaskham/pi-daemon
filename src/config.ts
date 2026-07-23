import { lstat, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { parseDocument } from "yaml";

import {
  parseSessionConfiguration,
  SessionConfigurationError,
} from "./session-config.js";
import type {
  JsonObject,
  SessionModelSpec,
  SessionResourceSpec,
  SessionToolSpec,
} from "./session-api.js";

export const PI_DAEMON_CONFIG_ENV = "PI_DAEMON_CONFIG" as const;
export const PI_DAEMON_INSTANCE_ENV = "PI_DAEMON_INSTANCE" as const;
export const DEFAULT_CONFIG_MAX_BYTES = 1024 * 1024;
export const DEFAULT_CONFIG_MAX_DEPTH = 16;
export const DEFAULT_CONFIG_MAX_PROPERTIES = 2048;
export const DEFAULT_CONFIG_MAX_STRING_BYTES = 256 * 1024;

export type SessionStorageMode = "pi-session-root" | "daemon-owned";
export type DashboardDeploymentMode = "embedded" | "dedicated";
export type PiDaemonWebPresentation = "rich" | "tui";

export interface PiDaemonLimitConfig {
  maxSessions?: number;
  maxConcurrentTurns?: number;
  maxSessionQueueDepth?: number;
  idleSessionTtlMs?: number;
  recoveryOpenTimeoutMs?: number;
  recoveryTotalTimeoutMs?: number;
  maxConnections?: number;
  maxInFlightRequestsPerConnection?: number;
  maxLineBytes?: number;
  maxEventBytes?: number;
  maxResponseBytes?: number;
  maxOutboundBytesPerConnection?: number;
}

export interface PiDaemonSecurityConfig {
  allowAuthorityRootOverlap?: boolean;
}

export interface PiDaemonScheduleConfig {
  /** Non-secret defaults merged into each imported schedule definition. */
  defaults?: { [key: string]: ConfigJson };
  /** Schedule JSON/YAML files, resolved relative to the daemon config. */
  imports?: string[];
}

export interface PiDaemonApiConfig {
  enabled?: boolean;
  bind?: string;
  port?: number;
  tokenFile?: string;
  allowInsecureHttp?: boolean;
}

export interface PiDaemonWebIdentityConfig {
  identityId: string;
  globalRole: "administrator" | "member";
  displayName?: string;
  /** Owner-only credential path; resolved relative to the containing configuration. */
  credentialFile?: string;
  /** Inherited credential descriptor; never a browser or daemon-service bearer. */
  credentialFd?: number;
}

export interface PiDaemonWebIdentityProviderConfig {
  type: "static";
  identities: PiDaemonWebIdentityConfig[];
}

export interface PiDaemonWebAuthConfig {
  /** Legacy exact single-owner credential source. Mutually exclusive with identityProvider*. */
  tokenFile?: string;
  /** Strict non-secret provider metadata and credential source paths/descriptors. */
  identityProvider?: PiDaemonWebIdentityProviderConfig;
  /** Strict YAML/JSON provider document, resolved relative to the daemon config. */
  identityProviderFile?: string;
  sessionTtlMs?: number;
}

export interface PiDaemonWebTlsConfig {
  certFile?: string;
  certFd?: number;
  keyFile?: string;
  keyFd?: number;
  reloadIntervalMs?: number;
}

export interface PiDaemonWebProxyConfig {
  /** Verify, but never derive authority from, loopback proxy headers. */
  trustForwardedHeaders?: boolean;
}

export interface PiDaemonWebInventoryConfig {
  roots?: string[];
  reconcileIntervalMs?: number;
  maxSessions?: number;
}

export interface PiDaemonWebResidencyConfig {
  warmTtlMs?: number;
  maxPinnedPerWorkspace?: number;
}

export interface PiDaemonWebTuiConfig {
  enabled?: boolean;
  defaultPresentation?: PiDaemonWebPresentation;
  maxRows?: number;
  maxColumns?: number;
}

export type ConfigJson =
  | null
  | boolean
  | number
  | string
  | ConfigJson[]
  | { [key: string]: ConfigJson };

export interface PiDaemonWebRuntimePolicyConfig {
  model?: SessionModelSpec;
  tools?: SessionToolSpec;
  resources?: SessionResourceSpec;
  settings?: JsonObject;
}

export interface PiDaemonWebSessionDefaultsConfig {
  /** Resolved relative to the selected daemon config; use ~ for the service home. */
  cwd?: string;
  /** Owner-controlled Pi settings JSON used only for provider/model/thinking defaults. */
  piSettingsFile?: string;
  /** Copy the owner runtime authority into the browser-safe draft defaults. */
  inheritRuntimePolicy?: boolean;
}

export interface PiDaemonWebConfig {
  enabled?: boolean;
  mode?: DashboardDeploymentMode;
  bind?: string;
  port?: number;
  /** Exact browser-visible origin. Required for native TLS and remote exposure. */
  publicOrigin?: string;
  /** Explicit development escape hatch for a non-loopback HTTP public origin. */
  allowInsecureHttp?: boolean;
  tls?: PiDaemonWebTlsConfig;
  proxy?: PiDaemonWebProxyConfig;
  auth?: PiDaemonWebAuthConfig;
  inventory?: PiDaemonWebInventoryConfig;
  residency?: PiDaemonWebResidencyConfig;
  tui?: PiDaemonWebTuiConfig;
  /**
   * Owner-configured, bounded runtime authority for Dashboard activations.
   * Nothing is inherited from ambient project or normal Pi settings.
   */
  runtimePolicy?: PiDaemonWebRuntimePolicyConfig;
  /** Optional owner defaults for lazy New Session drafts; absent retains restrictive browser defaults. */
  sessionDefaults?: PiDaemonWebSessionDefaultsConfig;
  /** Forward-compatible, bounded UI defaults. Browser/runtime validation is stricter. */
  ui?: { [key: string]: ConfigJson };
}

export const DEFAULT_SESSION_STORAGE_MODE: SessionStorageMode = "pi-session-root";
export const DEFAULT_PI_DAEMON_WEB_CONFIG = {
  enabled: true,
  mode: "embedded",
  bind: "127.0.0.1",
  port: 7464,
  allowInsecureHttp: false,
  proxy: { trustForwardedHeaders: false },
  auth: { sessionTtlMs: 12 * 60 * 60 * 1000 },
  inventory: { roots: [], reconcileIntervalMs: 30_000, maxSessions: 10_000 },
  residency: { warmTtlMs: 30 * 60 * 1000, maxPinnedPerWorkspace: 8 },
  tui: {
    enabled: true,
    defaultPresentation: "rich",
    maxRows: 200,
    maxColumns: 320,
  },
  ui: {},
} as const satisfies PiDaemonWebConfig;

export interface PiDaemonConfig {
  instance?: string;
  stateDir?: string;
  socketPath?: string;
  agentDir?: string;
  authSeedFile?: string;
  allowedRoots?: string[];
  sessionStorage?: { mode?: SessionStorageMode };
  security?: PiDaemonSecurityConfig;
  limits?: PiDaemonLimitConfig;
  api?: PiDaemonApiConfig;
  schedules?: PiDaemonScheduleConfig;
  web?: PiDaemonWebConfig;
}

export interface LoadedPiDaemonConfig {
  instance: string;
  path: string;
  explicitPath: boolean;
  present: boolean;
  config: PiDaemonConfig;
  /** Resolve a path read from this config relative to its containing directory. */
  resolvePath(value: string): string;
}

export class PiDaemonConfigError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "PiDaemonConfigError";
    this.code = code;
  }
}

export async function loadPiDaemonConfig(options: {
  cliConfigPath?: string;
  cliInstance?: string;
  environment?: Readonly<Record<string, string | undefined>>;
  homeDirectory?: string;
  xdgConfigHome?: string;
  maxBytes?: number;
} = {}): Promise<LoadedPiDaemonConfig> {
  const environment = options.environment ?? process.env;
  const homeDirectory = options.homeDirectory ?? homedir();
  const configuredInstance = options.cliInstance ?? environment[PI_DAEMON_INSTANCE_ENV];
  const instance = validateInstance(configuredInstance ?? "default");
  const selectedPath = options.cliConfigPath ?? environment[PI_DAEMON_CONFIG_ENV];
  const explicitPath = selectedPath !== undefined;
  const configHome =
    options.xdgConfigHome ?? environment.XDG_CONFIG_HOME ?? join(homeDirectory, ".config");
  const path = expandPath(
    selectedPath ?? join(configHome, "pi", "daemon", instance, "config.yaml"),
    homeDirectory,
    process.cwd(),
  );
  const maxBytes = positiveInteger(options.maxBytes ?? DEFAULT_CONFIG_MAX_BYTES, "maxBytes");

  let info;
  try {
    info = await stat(path);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      if (explicitPath) {
        throw new PiDaemonConfigError("config_not_found", "selected configuration file does not exist");
      }
      return loadedConfig(instance, path, explicitPath, false, {}, homeDirectory);
    }
    throw new PiDaemonConfigError("config_unreadable", "configuration file could not be inspected");
  }
  if (!info.isFile()) {
    throw new PiDaemonConfigError("config_not_regular", "configuration path must resolve to a regular file");
  }
  const getuid = process.getuid;
  if (getuid !== undefined && info.uid !== getuid() && info.uid !== 0) {
    throw new PiDaemonConfigError(
      "config_owner_mismatch",
      "configuration file must be owned by the current user or root",
    );
  }
  if ((info.mode & 0o022) !== 0) {
    throw new PiDaemonConfigError(
      "config_insecure_mode",
      "configuration file must not be group/world writable",
    );
  }
  if (info.size > maxBytes) {
    throw new PiDaemonConfigError("config_too_large", "configuration file exceeds its byte limit");
  }

  // lstat is intentionally advisory: Home Manager commonly exposes immutable
  // Nix-store configuration through a symlink. The resolved target above must
  // still be a regular, non-writable, current-user/root-owned file.
  try {
    await lstat(path);
  } catch {
    throw new PiDaemonConfigError("config_unreadable", "configuration file could not be inspected");
  }

  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw new PiDaemonConfigError("config_unreadable", "configuration file could not be read");
  }
  if (Buffer.byteLength(text, "utf8") > maxBytes) {
    throw new PiDaemonConfigError("config_too_large", "configuration file exceeds its byte limit");
  }
  const document = parseDocument(text, {
    prettyErrors: false,
    strict: true,
    uniqueKeys: true,
  });
  if (document.errors.length > 0) {
    throw new PiDaemonConfigError("config_invalid_yaml", "configuration file is not valid YAML");
  }
  let parsed: unknown;
  try {
    parsed = document.toJS({ maxAliasCount: 0 });
  } catch {
    throw new PiDaemonConfigError("config_invalid_yaml", "configuration aliases are not allowed");
  }
  const config = parseConfig(parsed ?? {});
  if (config.instance !== undefined && config.instance !== instance) {
    throw new PiDaemonConfigError(
      "config_instance_mismatch",
      "configuration instance does not match the selected instance",
    );
  }
  return loadedConfig(instance, path, explicitPath, true, config, homeDirectory);
}

function loadedConfig(
  instance: string,
  path: string,
  explicitPath: boolean,
  present: boolean,
  config: PiDaemonConfig,
  homeDirectory: string,
): LoadedPiDaemonConfig {
  return {
    instance,
    path,
    explicitPath,
    present,
    config,
    resolvePath: (value) => expandPath(value, homeDirectory, dirname(path)),
  };
}

function parseConfig(value: unknown): PiDaemonConfig {
  const root = objectValue(value, "configuration");
  assertKnownKeys(root, [
    "instance",
    "stateDir",
    "socketPath",
    "agentDir",
    "authSeedFile",
    "allowedRoots",
    "sessionStorage",
    "security",
    "limits",
    "api",
    "schedules",
    "web",
  ]);
  assertTreeBounds(root);
  const result: PiDaemonConfig = {};
  const instance = optionalString(root, "instance", 63);
  if (instance !== undefined) result.instance = validateInstance(instance);
  copyOptionalString(root, result, "stateDir");
  copyOptionalString(root, result, "socketPath");
  copyOptionalString(root, result, "agentDir");
  copyOptionalString(root, result, "authSeedFile");
  const allowedRoots = optionalStringArray(root, "allowedRoots", 256);
  if (allowedRoots !== undefined) result.allowedRoots = allowedRoots;
  if (root.sessionStorage !== undefined) {
    const storage = objectValue(root.sessionStorage, "sessionStorage");
    assertKnownKeys(storage, ["mode"]);
    const mode = optionalEnum(storage, "mode", ["pi-session-root", "daemon-owned"] as const);
    result.sessionStorage = mode === undefined ? {} : { mode };
  }
  if (root.security !== undefined) {
    const security = objectValue(root.security, "security");
    assertKnownKeys(security, ["allowAuthorityRootOverlap"]);
    const allowAuthorityRootOverlap = optionalBoolean(security, "allowAuthorityRootOverlap");
    result.security = allowAuthorityRootOverlap === undefined ? {} : { allowAuthorityRootOverlap };
  }
  if (root.limits !== undefined) result.limits = parseLimits(root.limits);
  if (root.api !== undefined) result.api = parseApi(root.api);
  if (root.schedules !== undefined) result.schedules = parseSchedules(root.schedules);
  if (root.web !== undefined) result.web = parseWeb(root.web);
  return result;
}

function parseLimits(value: unknown): PiDaemonLimitConfig {
  const object = objectValue(value, "limits");
  const keys = [
    "maxSessions",
    "maxConcurrentTurns",
    "maxSessionQueueDepth",
    "idleSessionTtlMs",
    "recoveryOpenTimeoutMs",
    "recoveryTotalTimeoutMs",
    "maxConnections",
    "maxInFlightRequestsPerConnection",
    "maxLineBytes",
    "maxEventBytes",
    "maxResponseBytes",
    "maxOutboundBytesPerConnection",
  ] as const;
  assertKnownKeys(object, keys);
  const result: PiDaemonLimitConfig = {};
  for (const key of keys) {
    const minimum = key === "maxSessionQueueDepth" || key === "idleSessionTtlMs" ? 0 : 1;
    const number = optionalInteger(object, key, minimum);
    if (number !== undefined) result[key] = number;
  }
  return result;
}

function parseSchedules(value: unknown): PiDaemonScheduleConfig {
  const object = objectValue(value, "schedules");
  assertKnownKeys(object, ["defaults", "imports"]);
  const result: PiDaemonScheduleConfig = {};
  if (object.defaults !== undefined) {
    const defaults = objectValue(object.defaults, "schedules.defaults");
    assertKnownKeys(defaults, ["enabled", "cron", "timezone", "execution", "overlapPolicy", "missedWakePolicy", "jitterMs", "maxAdmissionDelayMs"]);
    result.defaults = defaults as { [key: string]: ConfigJson };
  }
  const imports = optionalStringArray(object, "imports", 256);
  if (imports !== undefined) result.imports = imports;
  return result;
}

function parseApi(value: unknown): PiDaemonApiConfig {
  const object = objectValue(value, "api");
  assertKnownKeys(object, ["enabled", "bind", "port", "tokenFile", "allowInsecureHttp"]);
  const result: PiDaemonApiConfig = {};
  copyOptionalBoolean(object, result, "enabled");
  copyOptionalString(object, result, "bind");
  copyOptionalString(object, result, "tokenFile");
  copyOptionalBoolean(object, result, "allowInsecureHttp");
  const port = optionalInteger(object, "port", 0, 65_535);
  if (port !== undefined) result.port = port;
  if (result.enabled === true && result.port === undefined) {
    throw new PiDaemonConfigError("config_invalid", "api.port is required when api.enabled is true");
  }
  return result;
}

function parseWeb(value: unknown): PiDaemonWebConfig {
  const object = objectValue(value, "web");
  assertKnownKeys(object, [
    "enabled",
    "mode",
    "bind",
    "port",
    "publicOrigin",
    "allowInsecureHttp",
    "tls",
    "proxy",
    "auth",
    "inventory",
    "residency",
    "tui",
    "runtimePolicy",
    "sessionDefaults",
    "ui",
  ]);
  const result: PiDaemonWebConfig = {};
  copyOptionalBoolean(object, result, "enabled");
  copyOptionalString(object, result, "bind");
  copyOptionalString(object, result, "publicOrigin");
  copyOptionalBoolean(object, result, "allowInsecureHttp");
  const mode = optionalEnum(object, "mode", ["embedded", "dedicated"] as const);
  if (mode !== undefined) result.mode = mode;
  const port = optionalInteger(object, "port", 0, 65_535);
  if (port !== undefined) result.port = port;
  if (object.tls !== undefined) result.tls = parseWebTls(object.tls);
  if (object.proxy !== undefined) result.proxy = parseWebProxy(object.proxy);
  if (object.auth !== undefined) result.auth = parseWebAuth(object.auth);
  if (object.inventory !== undefined) result.inventory = parseWebInventory(object.inventory);
  if (object.residency !== undefined) result.residency = parseWebResidency(object.residency);
  if (object.tui !== undefined) result.tui = parseWebTui(object.tui);
  if (object.runtimePolicy !== undefined) {
    result.runtimePolicy = parseWebRuntimePolicy(object.runtimePolicy);
  }
  if (object.sessionDefaults !== undefined) {
    result.sessionDefaults = parseWebSessionDefaults(
      object.sessionDefaults,
      result.runtimePolicy,
    );
  }
  if (object.ui !== undefined) {
    const ui = objectValue(object.ui, "web.ui");
    rejectSecretLikeKeys(ui, "web.ui");
    result.ui = structuredClone(ui) as { [key: string]: ConfigJson };
  }
  return result;
}

function parseWebSessionDefaults(
  value: unknown,
  runtimePolicy: PiDaemonWebRuntimePolicyConfig | undefined,
): PiDaemonWebSessionDefaultsConfig {
  const object = objectValue(value, "web.sessionDefaults");
  assertKnownKeys(object, ["cwd", "piSettingsFile", "inheritRuntimePolicy"]);
  const result: PiDaemonWebSessionDefaultsConfig = {};
  copyOptionalString(object, result, "cwd");
  copyOptionalString(object, result, "piSettingsFile");
  copyOptionalBoolean(object, result, "inheritRuntimePolicy");
  if (result.inheritRuntimePolicy === true && runtimePolicy === undefined) {
    throw new PiDaemonConfigError(
      "config_invalid",
      "web.sessionDefaults.inheritRuntimePolicy requires web.runtimePolicy",
    );
  }
  return result;
}

function parseWebRuntimePolicy(value: unknown): PiDaemonWebRuntimePolicyConfig {
  const object = objectValue(value, "web.runtimePolicy");
  assertKnownKeys(object, ["model", "tools", "resources", "settings"]);
  rejectSecretLikeKeys(object, "web.runtimePolicy");
  if (object.settings !== undefined) {
    const settings = objectValue(object.settings, "web.runtimePolicy.settings");
    if (Object.prototype.hasOwnProperty.call(settings, "packages")) {
      throw new PiDaemonConfigError(
        "config_invalid",
        "web.runtimePolicy.settings.packages is not allowed; use resources.inheritInstalledPackages for Pi CLI installs or list reviewed resources explicitly",
      );
    }
  }
  if (object.resources !== undefined) {
    const resources = objectValue(object.resources, "web.runtimePolicy.resources");
    for (const field of ["extensions", "skills", "promptTemplates", "themes"] as const) {
      if (resources[field] === undefined) continue;
      const paths = optionalStringArray(resources, field, 128) ?? [];
      if (paths.some((path) => !isAbsolute(path) && !/^(?:git|npm):/u.test(path))) {
        throw new PiDaemonConfigError(
          "config_invalid",
          `web.runtimePolicy.resources.${field} paths must be absolute`,
        );
      }
    }
  }
  try {
    const spec = parseSessionConfiguration({
      cwd: "/",
      target: { mode: "memory" },
      ...structuredClone(object),
    }).persistedSpec;
    return {
      ...(spec.model === undefined ? {} : { model: spec.model }),
      ...(spec.tools === undefined ? {} : { tools: spec.tools }),
      ...(spec.resources === undefined ? {} : { resources: spec.resources }),
      ...(spec.settings === undefined ? {} : { settings: spec.settings }),
    };
  } catch (error) {
    if (error instanceof SessionConfigurationError) {
      throw new PiDaemonConfigError("config_invalid", `web.runtimePolicy: ${error.message}`);
    }
    throw error;
  }
}

function parseWebTls(value: unknown): PiDaemonWebTlsConfig {
  const object = objectValue(value, "web.tls");
  assertKnownKeys(object, ["certFile", "certFd", "keyFile", "keyFd", "reloadIntervalMs"]);
  const result: PiDaemonWebTlsConfig = {};
  copyOptionalString(object, result, "certFile");
  copyOptionalString(object, result, "keyFile");
  const certFd = optionalInteger(object, "certFd", 3);
  if (certFd !== undefined) result.certFd = certFd;
  const keyFd = optionalInteger(object, "keyFd", 3);
  if (keyFd !== undefined) result.keyFd = keyFd;
  const reloadIntervalMs = optionalInteger(object, "reloadIntervalMs", 1_000);
  if (reloadIntervalMs !== undefined) result.reloadIntervalMs = reloadIntervalMs;
  return result;
}

function parseWebProxy(value: unknown): PiDaemonWebProxyConfig {
  const object = objectValue(value, "web.proxy");
  assertKnownKeys(object, ["trustForwardedHeaders"]);
  const trustForwardedHeaders = optionalBoolean(object, "trustForwardedHeaders");
  return trustForwardedHeaders === undefined ? {} : { trustForwardedHeaders };
}

function parseWebAuth(value: unknown): PiDaemonWebAuthConfig {
  const object = objectValue(value, "web.auth");
  assertKnownKeys(object, ["tokenFile", "identityProvider", "identityProviderFile", "sessionTtlMs"]);
  const result: PiDaemonWebAuthConfig = {};
  copyOptionalString(object, result, "tokenFile");
  copyOptionalString(object, result, "identityProviderFile");
  if (object.identityProvider !== undefined) {
    result.identityProvider = parseDashboardIdentityProviderConfig(object.identityProvider);
  }
  const sources = [result.tokenFile, result.identityProvider, result.identityProviderFile]
    .filter((source) => source !== undefined).length;
  if (sources > 1) {
    throw new PiDaemonConfigError(
      "config_invalid",
      "web.auth tokenFile, identityProvider, and identityProviderFile are mutually exclusive",
    );
  }
  const ttl = optionalInteger(object, "sessionTtlMs", 1);
  if (ttl !== undefined) result.sessionTtlMs = ttl;
  return result;
}

export function parseDashboardIdentityProviderConfig(
  value: unknown,
): PiDaemonWebIdentityProviderConfig {
  const object = objectValue(value, "web.auth.identityProvider");
  assertKnownKeys(object, ["type", "identities"]);
  if (object.type !== "static") {
    throw new PiDaemonConfigError(
      "config_invalid",
      "web.auth.identityProvider.type must be static",
    );
  }
  if (!Array.isArray(object.identities) || object.identities.length < 1 || object.identities.length > 128) {
    throw new PiDaemonConfigError(
      "config_invalid",
      "web.auth.identityProvider.identities must contain between 1 and 128 entries",
    );
  }
  const identities: PiDaemonWebIdentityConfig[] = [];
  const identityIds = new Set<string>();
  const files = new Set<string>();
  const fds = new Set<number>();
  let administrators = 0;
  for (const [index, raw] of object.identities.entries()) {
    const identity = objectValue(raw, `web.auth.identityProvider.identities[${index}]`);
    assertKnownKeys(identity, ["identityId", "globalRole", "displayName", "credentialFile", "credentialFd"]);
    const identityId = optionalString(identity, "identityId", 128);
    if (identityId === undefined || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(identityId)) {
      throw new PiDaemonConfigError("config_invalid", "dashboard identity ID is invalid");
    }
    if (identityIds.has(identityId)) {
      throw new PiDaemonConfigError("config_invalid", "dashboard identity IDs must be unique");
    }
    identityIds.add(identityId);
    const globalRole = optionalEnum(identity, "globalRole", ["administrator", "member"] as const);
    if (globalRole === undefined) {
      throw new PiDaemonConfigError("config_invalid", "dashboard identity globalRole is required");
    }
    if (globalRole === "administrator") administrators += 1;
    const displayName = optionalString(identity, "displayName", 256);
    if (displayName !== undefined && /[\r\n\0]/u.test(displayName)) {
      throw new PiDaemonConfigError("config_invalid", "dashboard identity displayName is invalid");
    }
    const credentialFile = optionalString(identity, "credentialFile", 4096);
    const credentialFd = optionalInteger(identity, "credentialFd", 3);
    if ((credentialFile === undefined) === (credentialFd === undefined)) {
      throw new PiDaemonConfigError(
        "config_invalid",
        "each dashboard identity requires exactly one credentialFile or credentialFd",
      );
    }
    if (credentialFile !== undefined) {
      if (files.has(credentialFile)) {
        throw new PiDaemonConfigError("config_invalid", "dashboard identity credentialFile sources must be unique");
      }
      files.add(credentialFile);
    }
    if (credentialFd !== undefined) {
      if (fds.has(credentialFd)) {
        throw new PiDaemonConfigError("config_invalid", "dashboard identity credentialFd sources must be unique");
      }
      fds.add(credentialFd);
    }
    identities.push({
      identityId,
      globalRole,
      ...(displayName === undefined ? {} : { displayName }),
      ...(credentialFile === undefined ? {} : { credentialFile }),
      ...(credentialFd === undefined ? {} : { credentialFd }),
    });
  }
  if (administrators < 1) {
    throw new PiDaemonConfigError("config_invalid", "dashboard identities require at least one administrator");
  }
  return { type: "static", identities };
}

function parseWebInventory(value: unknown): PiDaemonWebInventoryConfig {
  const object = objectValue(value, "web.inventory");
  assertKnownKeys(object, ["roots", "reconcileIntervalMs", "maxSessions"]);
  const result: PiDaemonWebInventoryConfig = {};
  const roots = optionalStringArray(object, "roots", 256);
  if (roots !== undefined) result.roots = roots;
  const interval = optionalInteger(object, "reconcileIntervalMs", 1);
  if (interval !== undefined) result.reconcileIntervalMs = interval;
  const maxSessions = optionalInteger(object, "maxSessions", 1);
  if (maxSessions !== undefined) result.maxSessions = maxSessions;
  return result;
}

function parseWebResidency(value: unknown): PiDaemonWebResidencyConfig {
  const object = objectValue(value, "web.residency");
  assertKnownKeys(object, ["warmTtlMs", "maxPinnedPerWorkspace"]);
  const result: PiDaemonWebResidencyConfig = {};
  const warmTtlMs = optionalInteger(object, "warmTtlMs", 0);
  if (warmTtlMs !== undefined) result.warmTtlMs = warmTtlMs;
  const maxPinned = optionalInteger(object, "maxPinnedPerWorkspace", 1);
  if (maxPinned !== undefined) result.maxPinnedPerWorkspace = maxPinned;
  return result;
}

function parseWebTui(value: unknown): PiDaemonWebTuiConfig {
  const object = objectValue(value, "web.tui");
  assertKnownKeys(object, ["enabled", "defaultPresentation", "maxRows", "maxColumns"]);
  const result: PiDaemonWebTuiConfig = {};
  copyOptionalBoolean(object, result, "enabled");
  const presentation = optionalEnum(object, "defaultPresentation", ["rich", "tui"] as const);
  if (presentation !== undefined) result.defaultPresentation = presentation;
  const maxRows = optionalInteger(object, "maxRows", 1);
  if (maxRows !== undefined) result.maxRows = maxRows;
  const maxColumns = optionalInteger(object, "maxColumns", 1);
  if (maxColumns !== undefined) result.maxColumns = maxColumns;
  return result;
}

function validateInstance(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,62}$/.test(value)) {
    throw new PiDaemonConfigError(
      "config_invalid_instance",
      "instance must be 1-63 alphanumeric/hyphen characters",
    );
  }
  return value;
}

function objectValue(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new PiDaemonConfigError("config_invalid", `${name} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new PiDaemonConfigError("config_invalid", `${name} must be a plain object`);
  }
  return value as Record<string, unknown>;
}

function assertKnownKeys(object: Record<string, unknown>, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(object).find((key) => !allowedSet.has(key));
  if (unknown !== undefined) {
    throw new PiDaemonConfigError("config_unknown_field", `unknown configuration field: ${unknown}`);
  }
}

function optionalString(
  object: Record<string, unknown>,
  key: string,
  maxBytes = 16 * 1024,
): string | undefined {
  const value = object[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > maxBytes) {
    throw new PiDaemonConfigError("config_invalid", `${key} must be a bounded non-empty string`);
  }
  return value;
}

function optionalStringArray(
  object: Record<string, unknown>,
  key: string,
  maxItems: number,
): string[] | undefined {
  const value = object[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > maxItems) {
    throw new PiDaemonConfigError("config_invalid", `${key} must be a bounded string array`);
  }
  return value.map((entry) => {
    if (typeof entry !== "string" || entry.length === 0 || Buffer.byteLength(entry, "utf8") > 16 * 1024) {
      throw new PiDaemonConfigError("config_invalid", `${key} must contain bounded non-empty strings`);
    }
    return entry;
  });
}

function optionalInteger(
  object: Record<string, unknown>,
  key: string,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number | undefined {
  const value = object[key];
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new PiDaemonConfigError(
      "config_invalid",
      `${key} must be an integer from ${minimum} through ${maximum}`,
    );
  }
  return value as number;
}

function optionalEnum<const T extends readonly string[]>(
  object: Record<string, unknown>,
  key: string,
  values: T,
): T[number] | undefined {
  const value = object[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !values.includes(value)) {
    throw new PiDaemonConfigError("config_invalid", `${key} has an unsupported value`);
  }
  return value as T[number];
}

function optionalBoolean(object: Record<string, unknown>, key: string): boolean | undefined {
  const value = object[key];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw new PiDaemonConfigError("config_invalid", `${key} must be true or false`);
  }
  return value;
}

function copyOptionalString<T extends object>(
  source: Record<string, unknown>,
  target: T,
  key: keyof T & string,
): void {
  const value = optionalString(source, key);
  if (value !== undefined) (target as Record<string, unknown>)[key] = value;
}

function copyOptionalBoolean<T extends object>(
  source: Record<string, unknown>,
  target: T,
  key: keyof T & string,
): void {
  const value = optionalBoolean(source, key);
  if (value !== undefined) (target as Record<string, unknown>)[key] = value;
}

function assertTreeBounds(root: Record<string, unknown>): void {
  let properties = 0;
  let stringBytes = 0;
  const visit = (value: unknown, depth: number): void => {
    if (depth > DEFAULT_CONFIG_MAX_DEPTH) {
      throw new PiDaemonConfigError("config_too_large", "configuration exceeds its depth limit");
    }
    if (typeof value === "string") {
      stringBytes += Buffer.byteLength(value, "utf8");
    } else if (Array.isArray(value)) {
      for (const entry of value) visit(entry, depth + 1);
    } else if (value !== null && typeof value === "object") {
      for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
        properties += 1;
        stringBytes += Buffer.byteLength(key, "utf8");
        visit(entry, depth + 1);
      }
    } else if (typeof value === "number") {
      if (!Number.isFinite(value)) {
        throw new PiDaemonConfigError("config_invalid", "configuration numbers must be finite");
      }
    } else if (value !== null && typeof value !== "boolean" && value !== undefined) {
      throw new PiDaemonConfigError("config_invalid", "configuration contains an unsupported value");
    }
    if (properties > DEFAULT_CONFIG_MAX_PROPERTIES || stringBytes > DEFAULT_CONFIG_MAX_STRING_BYTES) {
      throw new PiDaemonConfigError("config_too_large", "configuration exceeds its structural limit");
    }
  };
  visit(root, 0);
}

function rejectSecretLikeKeys(value: unknown, path: string): void {
  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) rejectSecretLikeKeys(entry, `${path}[${index}]`);
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (/^(token|secret|password|api[-_]?key|bearer)$/i.test(key)) {
      throw new PiDaemonConfigError(
        "config_secret_value_forbidden",
        `${path} must not contain literal secret-bearing fields`,
      );
    }
    rejectSecretLikeKeys(entry, `${path}.${key}`);
  }
}

function expandPath(value: string, homeDirectory: string, relativeTo: string): string {
  const expanded = value === "~" ? homeDirectory : value.startsWith("~/") ? join(homeDirectory, value.slice(2)) : value;
  return resolve(isAbsolute(expanded) ? expanded : join(relativeTo, expanded));
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
