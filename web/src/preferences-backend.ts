import type {
  DashboardSettingsPatchRequest,
  DashboardSettingsResource,
  DashboardUiSettings,
  DashboardUiSettingsPatch,
  DashboardWorkspaceResource,
  DashboardWorkspaceUpdateRequest,
} from "@harryaskham/pi-daemon/dashboard-contract";

export class DashboardRevisionConflict extends Error {
  readonly currentRevision: number;
  constructor(resource: "workspace" | "settings", currentRevision: number) {
    super(`${resource} revision conflict; current revision is ${currentRevision}`);
    this.name = "DashboardRevisionConflict";
    this.currentRevision = currentRevision;
  }
}

export interface DashboardPreferencesBackend {
  getWorkspace(workspaceId: string): Promise<DashboardWorkspaceResource>;
  updateWorkspace(request: DashboardWorkspaceUpdateRequest): Promise<DashboardWorkspaceResource>;
  getSettings(): Promise<DashboardSettingsResource>;
  patchSettings(request: DashboardSettingsPatchRequest): Promise<DashboardSettingsResource>;
  resetSettings(expectedRevision: number): Promise<DashboardSettingsResource>;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function mergeSettings(base: DashboardUiSettings, patch: DashboardUiSettingsPatch): DashboardUiSettings {
  return {
    theme: { ...base.theme, ...patch.theme },
    editor: { ...base.editor, ...patch.editor },
    sidebar: { ...base.sidebar, ...patch.sidebar },
    transcript: { ...base.transcript, ...patch.transcript },
    motion: { ...base.motion, ...patch.motion },
    cache: { ...base.cache, ...patch.cache },
  };
}

function mergePatch(base: DashboardUiSettingsPatch, patch: DashboardUiSettingsPatch): DashboardUiSettingsPatch {
  return {
    ...(base.theme || patch.theme ? { theme: { ...base.theme, ...patch.theme } } : {}),
    ...(base.editor || patch.editor ? { editor: { ...base.editor, ...patch.editor } } : {}),
    ...(base.sidebar || patch.sidebar ? { sidebar: { ...base.sidebar, ...patch.sidebar } } : {}),
    ...(base.transcript || patch.transcript ? { transcript: { ...base.transcript, ...patch.transcript } } : {}),
    ...(base.motion || patch.motion ? { motion: { ...base.motion, ...patch.motion } } : {}),
    ...(base.cache || patch.cache ? { cache: { ...base.cache, ...patch.cache } } : {}),
  };
}

function patchSources(
  current: DashboardSettingsResource["sources"],
  patch: DashboardUiSettingsPatch,
): DashboardSettingsResource["sources"] {
  const sources = { ...current };
  for (const [section, values] of Object.entries(patch)) {
    if (!values || typeof values !== "object") continue;
    for (const key of Object.keys(values)) sources[`${section}.${key}`] = "runtime";
  }
  return sources;
}

export class LocalDashboardPreferencesBackend implements DashboardPreferencesBackend {
  #workspace: DashboardWorkspaceResource;
  #settings: DashboardSettingsResource;
  readonly #configuredSettings: DashboardUiSettings;
  readonly #configuredSources: DashboardSettingsResource["sources"];
  readonly #workspaceIdempotency = new Map<string, { body: string; resource: DashboardWorkspaceResource }>();
  readonly #settingsIdempotency = new Map<string, { body: string; resource: DashboardSettingsResource }>();

  constructor(workspace: DashboardWorkspaceResource, settings: DashboardSettingsResource) {
    this.#workspace = clone(workspace);
    this.#settings = clone(settings);
    this.#configuredSettings = clone(settings.effective);
    this.#configuredSources = clone(settings.sources);
  }

  workspaceSnapshot(): DashboardWorkspaceResource {
    return clone(this.#workspace);
  }

  settingsSnapshot(): DashboardSettingsResource {
    return clone(this.#settings);
  }

  async getWorkspace(workspaceId: string): Promise<DashboardWorkspaceResource> {
    if (workspaceId !== this.#workspace.workspaceId) throw new Error("workspace not found");
    return this.workspaceSnapshot();
  }

  async updateWorkspace(request: DashboardWorkspaceUpdateRequest): Promise<DashboardWorkspaceResource> {
    const body = JSON.stringify(request);
    const prior = this.#workspaceIdempotency.get(request.idempotencyKey);
    if (prior) {
      if (prior.body !== body) throw new Error("workspace idempotency key reused with different content");
      return clone(prior.resource);
    }
    if (request.expectedRevision !== this.#workspace.revision) {
      throw new DashboardRevisionConflict("workspace", this.#workspace.revision);
    }
    const now = new Date().toISOString();
    this.#workspace = {
      ...this.#workspace,
      revision: this.#workspace.revision + 1,
      updatedAt: now,
      selectedPaneId: request.selectedPaneId,
      layout: clone(request.layout),
      seenCursors: clone(request.seenCursors),
    };
    this.#workspaceIdempotency.set(request.idempotencyKey, { body, resource: clone(this.#workspace) });
    return this.workspaceSnapshot();
  }

  async getSettings(): Promise<DashboardSettingsResource> {
    return this.settingsSnapshot();
  }

  async patchSettings(request: DashboardSettingsPatchRequest): Promise<DashboardSettingsResource> {
    const body = JSON.stringify(request);
    const prior = this.#settingsIdempotency.get(request.idempotencyKey);
    if (prior) {
      if (prior.body !== body) throw new Error("settings idempotency key reused with different content");
      return clone(prior.resource);
    }
    if (request.expectedRevision !== this.#settings.revision) {
      throw new DashboardRevisionConflict("settings", this.#settings.revision);
    }
    this.#settings = {
      revision: this.#settings.revision + 1,
      effective: mergeSettings(this.#settings.effective, request.patch),
      runtimeOverlay: mergePatch(this.#settings.runtimeOverlay, request.patch),
      sources: patchSources(this.#settings.sources, request.patch),
    };
    this.#settingsIdempotency.set(request.idempotencyKey, { body, resource: clone(this.#settings) });
    return this.settingsSnapshot();
  }

  async resetSettings(expectedRevision: number): Promise<DashboardSettingsResource> {
    if (expectedRevision !== this.#settings.revision) {
      throw new DashboardRevisionConflict("settings", this.#settings.revision);
    }
    this.#settings = {
      revision: this.#settings.revision + 1,
      effective: clone(this.#configuredSettings),
      runtimeOverlay: {},
      sources: clone(this.#configuredSources),
    };
    return this.settingsSnapshot();
  }
}
