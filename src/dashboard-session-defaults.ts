import { readFile, realpath, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";

import type {
  PiDaemonWebRuntimePolicyConfig,
  LoadedPiDaemonConfig,
} from "./config.js";
import type { DashboardSessionDefaultsResource } from "./dashboard-contract.js";
import {
  validateDashboardSessionDraftSpec,
  type DashboardSessionDraftSpec,
} from "./dashboard-session-drafts.js";
import type { SessionThinkingLevel } from "./session-api.js";

const MAX_PI_SETTINGS_BYTES = 1_048_576;
const THINKING_LEVELS = new Set<SessionThinkingLevel>([
  "off", "minimal", "low", "medium", "high", "xhigh", "max",
]);

export class DashboardSessionDefaultsError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "DashboardSessionDefaultsError";
  }
}

export async function resolveDashboardSessionDefaults(
  loadedConfig: LoadedPiDaemonConfig,
  options: { allowedRoots?: readonly string[] } = {},
): Promise<DashboardSessionDefaultsResource | undefined> {
  const defaults = loadedConfig.config.web?.sessionDefaults;
  if (defaults === undefined) return undefined;
  const runtimePolicy = loadedConfig.config.web?.runtimePolicy;
  const inheritAuthority = defaults.inheritRuntimePolicy === true;
  if (inheritAuthority && runtimePolicy === undefined) {
    throw new DashboardSessionDefaultsError(
      "session_defaults_policy_missing",
      "session defaults require an owner runtime policy",
    );
  }
  const piModel = defaults.piSettingsFile === undefined
    ? undefined
    : await readPiModelDefaults(loadedConfig.resolvePath(defaults.piSettingsFile));
  const model = piModel ?? runtimePolicy?.model;
  const configuredCwd = loadedConfig.resolvePath(defaults.cwd ?? "~");
  const cwd = options.allowedRoots === undefined
    ? configuredCwd
    : await validateDefaultCwd(configuredCwd, options.allowedRoots);
  const spec = validateDashboardSessionDraftSpec({
    cwd,
    persistence: "persistent",
    ...(model?.provider === undefined || model.id === undefined
      ? {}
      : {
          model: {
            provider: model.provider,
            id: model.id,
            ...(model.thinkingLevel === undefined ? {} : { thinkingLevel: model.thinkingLevel }),
          },
        }),
    tools: inheritAuthority
      ? draftTools(runtimePolicy?.tools)
      : { mode: "none" },
    resources: inheritAuthority
      ? draftResources(runtimePolicy?.resources)
      : restrictedResources(),
    isolation: { mode: "unisolated" },
  });
  assertDashboardSessionDraftWithinRuntimePolicy(spec, inheritAuthority ? runtimePolicy : undefined);
  return {
    spec,
    sources: {
      cwd: "configured",
      model: piModel !== undefined
        ? "pi-settings"
        : runtimePolicy?.model !== undefined
          ? "runtime-policy"
          : "none",
      authority: inheritAuthority ? "runtime-policy" : "restricted",
    },
  };
}

export function assertDashboardSessionDraftWithinRuntimePolicy(
  spec: DashboardSessionDraftSpec,
  runtimePolicy: PiDaemonWebRuntimePolicyConfig | undefined,
): void {
  const tools = spec.tools;
  const allowedTools = runtimePolicy?.tools;
  const allowedMode = allowedTools?.mode ?? (runtimePolicy === undefined ? "none" : "default");
  if (tools.mode !== "none") {
    if (runtimePolicy === undefined || allowedMode === "none") denied("draft tool authority exceeds host runtime policy");
    if (allowedMode === "no-builtin" && tools.mode !== "no-builtin") {
      denied("draft built-in tool authority exceeds host runtime policy");
    }
    if (allowedMode === "allowlist") {
      if (tools.mode !== "allowlist") denied("draft tool mode exceeds host allowlist");
      const allowed = new Set(allowedTools?.include ?? []);
      if ((tools.include ?? []).some((name) => !allowed.has(name))) {
        denied("draft tool allowlist exceeds host runtime policy");
      }
    }
  }

  const allowedResources = runtimePolicy?.resources;
  const allowedTrust = allowedResources?.projectTrust ?? "default";
  if (spec.resources.projectTrust === "approve" && allowedTrust !== "approve") {
    denied("draft project trust exceeds host runtime policy");
  }
  for (const field of [
    "noExtensions",
    "noSkills",
    "noPromptTemplates",
    "noThemes",
    "noContextFiles",
  ] as const) {
    if (spec.resources[field] === false && effectiveResourceDisabled(allowedResources, field)) {
      denied(`draft ${field} authority exceeds host runtime policy`);
    }
  }
}

function draftTools(
  tools: PiDaemonWebRuntimePolicyConfig["tools"],
): DashboardSessionDraftSpec["tools"] {
  return {
    mode: tools?.mode ?? "default",
    ...(tools?.include === undefined ? {} : { include: [...tools.include] }),
    ...(tools?.exclude === undefined ? {} : { exclude: [...tools.exclude] }),
  };
}

function draftResources(
  resources: PiDaemonWebRuntimePolicyConfig["resources"],
): DashboardSessionDraftSpec["resources"] {
  const projectTrust = resources?.projectTrust ?? "default";
  return {
    noExtensions: effectiveResourceDisabled(resources, "noExtensions"),
    noSkills: effectiveResourceDisabled(resources, "noSkills"),
    noPromptTemplates: effectiveResourceDisabled(resources, "noPromptTemplates"),
    noThemes: effectiveResourceDisabled(resources, "noThemes"),
    noContextFiles: resources?.noContextFiles !== false,
    projectTrust,
  };
}

function restrictedResources(): DashboardSessionDraftSpec["resources"] {
  return {
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    projectTrust: "deny",
  };
}

function effectiveResourceDisabled(
  resources: PiDaemonWebRuntimePolicyConfig["resources"],
  field: "noExtensions" | "noSkills" | "noPromptTemplates" | "noThemes" | "noContextFiles",
): boolean {
  if (field === "noContextFiles") return resources?.noContextFiles !== false;
  if (resources?.[field] === true) return true;
  if (resources?.[field] === false) return false;
  const listField = {
    noExtensions: "extensions",
    noSkills: "skills",
    noPromptTemplates: "promptTemplates",
    noThemes: "themes",
  }[field] as "extensions" | "skills" | "promptTemplates" | "themes";
  if (resources?.[listField] !== undefined) return false;
  return resources?.projectTrust !== "approve";
}

async function readPiModelDefaults(path: string): Promise<{
  provider: string;
  id: string;
  thinkingLevel?: SessionThinkingLevel;
} | undefined> {
  let info;
  try {
    info = await stat(path);
  } catch {
    throw new DashboardSessionDefaultsError(
      "pi_settings_unavailable",
      "configured Pi settings file is unavailable",
    );
  }
  if (!info.isFile() || info.size > MAX_PI_SETTINGS_BYTES) {
    throw new DashboardSessionDefaultsError(
      "pi_settings_invalid",
      "configured Pi settings file is not a bounded regular file",
    );
  }
  const getuid = process.getuid;
  if (getuid !== undefined && info.uid !== getuid() && info.uid !== 0) {
    throw new DashboardSessionDefaultsError(
      "pi_settings_owner_mismatch",
      "configured Pi settings file must be owned by the current user or root",
    );
  }
  if ((info.mode & 0o022) !== 0) {
    throw new DashboardSessionDefaultsError(
      "pi_settings_insecure_mode",
      "configured Pi settings file must not be group/world writable",
    );
  }
  let value: unknown;
  try {
    const text = await readFile(path, "utf8");
    if (Buffer.byteLength(text, "utf8") > MAX_PI_SETTINGS_BYTES) throw new Error();
    value = JSON.parse(text) as unknown;
  } catch {
    throw new DashboardSessionDefaultsError(
      "pi_settings_invalid",
      "configured Pi settings file is not bounded JSON",
    );
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DashboardSessionDefaultsError("pi_settings_invalid", "configured Pi settings root is invalid");
  }
  const settings = value as Record<string, unknown>;
  const provider = firstString(settings.trueDefaultProvider, settings.defaultProvider);
  const id = firstString(settings.trueDefaultModel, settings.defaultModel);
  const thinking = firstString(
    settings.trueDefaultThinkingLevel,
    settings.defaultThinkingLevel,
  );
  if ((provider === undefined) !== (id === undefined)) {
    throw new DashboardSessionDefaultsError(
      "pi_settings_invalid",
      "configured Pi default provider and model must be paired",
    );
  }
  if (provider === undefined || id === undefined) return undefined;
  if (provider.length > 128 || id.length > 256) {
    throw new DashboardSessionDefaultsError("pi_settings_invalid", "configured Pi model defaults exceed bounds");
  }
  const thinkingLevel = thinking === undefined
    ? undefined
    : THINKING_LEVELS.has(thinking as SessionThinkingLevel)
      ? thinking as SessionThinkingLevel
      : undefined;
  if (thinking !== undefined && thinkingLevel === undefined) {
    throw new DashboardSessionDefaultsError("pi_settings_invalid", "configured Pi thinking default is invalid");
  }
  return {
    provider,
    id,
    ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
  };
}

async function validateDefaultCwd(cwd: string, roots: readonly string[]): Promise<string> {
  const [canonicalCwd, canonicalRoots] = await Promise.all([
    realpath(cwd).catch(() => undefined),
    Promise.all(roots.map((root) => realpath(resolve(root)).catch(() => undefined))),
  ]);
  if (
    canonicalCwd === undefined ||
    !canonicalRoots.some((root) => root !== undefined && isWithin(root, canonicalCwd))
  ) {
    throw new DashboardSessionDefaultsError(
      "session_defaults_cwd_not_allowed",
      "configured session default cwd is unavailable or outside allowed roots",
    );
  }
  return canonicalCwd;
}

function isWithin(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.length > 0);
}

function denied(message: string): never {
  throw new DashboardSessionDefaultsError("draft_authority_denied", message);
}
