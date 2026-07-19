import type {
  DashboardSessionDraftResource,
  DashboardSessionDraftSpec,
} from "@harryaskham/pi-daemon/dashboard-session-draft-contract";
import type { SessionResource, SessionThinkingLevel } from "@harryaskham/pi-daemon/session-api";
import type { SessionFixture } from "./model";

export interface SessionDraftFormValues {
  cwd: string;
  name: string;
  persistence: "persistent" | "memory";
  provider: string;
  modelId: string;
  thinkingLevel: SessionThinkingLevel;
  toolsMode: "none" | "allowlist";
  toolNames: string;
  noExtensions: boolean;
  noSkills: boolean;
  noPromptTemplates: boolean;
  noThemes: boolean;
  noContextFiles: boolean;
  projectTrust: "default" | "deny";
}

export interface SessionDraftValidation {
  spec?: DashboardSessionDraftSpec;
  errors: Record<string, string>;
}

export function defaultSessionDraftForm(cwd = ""): SessionDraftFormValues {
  return {
    cwd,
    name: "",
    persistence: "persistent",
    provider: "",
    modelId: "",
    thinkingLevel: "medium",
    toolsMode: "none",
    toolNames: "",
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    projectTrust: "deny",
  };
}

export function sessionDraftFormFromSpec(
  spec: DashboardSessionDraftSpec,
): SessionDraftFormValues {
  return {
    cwd: spec.cwd,
    name: spec.name ?? "",
    persistence: spec.persistence,
    provider: spec.model?.provider ?? "",
    modelId: spec.model?.id ?? "",
    thinkingLevel: spec.model?.thinkingLevel ?? "medium",
    toolsMode: spec.tools.mode,
    toolNames: (spec.tools.include ?? []).join(", "),
    noExtensions: spec.resources.noExtensions,
    noSkills: spec.resources.noSkills,
    noPromptTemplates: spec.resources.noPromptTemplates,
    noThemes: spec.resources.noThemes,
    noContextFiles: spec.resources.noContextFiles,
    projectTrust: spec.resources.projectTrust,
  };
}

export function validateSessionDraftForm(
  values: SessionDraftFormValues,
): SessionDraftValidation {
  const errors: Record<string, string> = {};
  const cwd = values.cwd.trim();
  const name = values.name.trim();
  const provider = values.provider.trim();
  const modelId = values.modelId.trim();
  const tools = values.toolNames
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (!cwd.startsWith("/") || cwd.length > 4_096 || /[\u0000-\u001f\u007f]/u.test(cwd)) {
    errors.cwd = "Use a bounded absolute working directory.";
  }
  if (name.length > 128 || /[\u0000-\u001f\u007f]/u.test(name)) {
    errors.name = "Name must be at most 128 printable characters.";
  }
  if ((provider.length === 0) !== (modelId.length === 0)) {
    errors.model = "Provider and model ID must be set together.";
  }
  if (provider.length > 128 || modelId.length > 256) {
    errors.model = "Provider or model ID exceeds its bound.";
  }
  if (
    tools.length > 32 ||
    tools.some((tool) => tool.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(tool))
  ) {
    errors.tools = "Use at most 32 bounded neutral tool names.";
  }
  if (values.toolsMode === "allowlist" && tools.length === 0) {
    errors.tools = "Add at least one tool or choose no tools.";
  }
  if (Object.keys(errors).length > 0) return { errors };
  const spec: DashboardSessionDraftSpec = {
    cwd,
    ...(name === "" ? {} : { name }),
    persistence: values.persistence,
    ...(provider === ""
      ? {}
      : {
          model: {
            provider,
            id: modelId,
            thinkingLevel: values.thinkingLevel,
          },
        }),
    tools: {
      mode: values.toolsMode,
      ...(values.toolsMode === "allowlist" ? { include: tools } : {}),
    },
    resources: {
      noExtensions: values.noExtensions,
      noSkills: values.noSkills,
      noPromptTemplates: values.noPromptTemplates,
      noThemes: values.noThemes,
      noContextFiles: values.noContextFiles,
      projectTrust: values.projectTrust,
    },
    isolation: { mode: "unisolated" },
  };
  return { spec, errors };
}

export function draftIdForLocalTarget(targetId: string): string | undefined {
  if (!targetId.startsWith("draft-local:")) return undefined;
  const suffix = targetId.slice("draft-local:".length);
  return suffix === "" ? undefined : `draft-${suffix}`.slice(0, 128);
}

export function draftTargetId(draftId: string): string {
  return `draft:${draftId}`;
}

export function draftLiveTargetId(draftId: string): string {
  return `draft-live:${draftId}`;
}

export function draftIdFromTarget(targetId: string): string | undefined {
  const match = /^(?:draft|draft-live):(.+)$/u.exec(targetId);
  return match?.[1];
}

export function materializedDraftSession(
  inventoryId: string,
  draft: DashboardSessionDraftResource,
  resource: SessionResource,
): SessionFixture {
  const cwd = resource.spec.cwd;
  const title = resource.name ?? draft.spec.name ?? "New session";
  const project = cwd.split("/").filter(Boolean).at(-2) ?? "Pi session";
  return {
    inventoryId,
    sourceKind: "memory",
    title,
    cwdBasename: cwd.split("/").filter(Boolean).at(-1) ?? cwd,
    projectLabel: project,
    createdAt: resource.createdAt,
    modifiedAt: resource.updatedAt,
    messageCount: 0,
    entryCount: 0,
    toolCallCount: 0,
    managed: {
      sessionId: resource.sessionId,
      ...(resource.name === undefined ? {} : { name: resource.name }),
      generation: resource.generation,
      revision: resource.revision,
      residency: resource.residency,
      state: resource.state,
    },
    activation: { eligible: true, modes: ["reuse", "fork"] },
    presence: {
      runtime: resource.state === "running" ? "running" : "resident-idle",
      activation: "user-turn",
      focusedPaneCount: 1,
      unread: false,
    },
    sessionId: resource.sessionId,
    generation: resource.generation,
    cwd,
    project,
    model: resource.spec.model?.id ?? "default model",
    thinking:
      resource.spec.model?.thinkingLevel === "xhigh" || resource.spec.model?.thinkingLevel === "max"
        ? "high"
        : resource.spec.model?.thinkingLevel ?? "off",
    contextPercent: 0,
  };
}
