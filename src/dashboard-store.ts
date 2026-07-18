import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rm,
} from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  DASH_DEFAULT_LIMITS,
  asDashboardCursor,
  type DashboardLayoutNode,
  type DashboardLimits,
  type DashboardSettingsPatchRequest,
  type DashboardSettingsResource,
  type DashboardUiSettings,
  type DashboardUiSettingsPatch,
  type DashboardWorkspaceResource,
  type DashboardWorkspaceUpdateRequest,
  type PaneTarget,
} from "./dashboard-contract.js";
import type { ConfigJson } from "./config.js";

const STORE_FORMAT_VERSION = 1 as const;
const MAX_IDEMPOTENCY_ENTRIES = 128;
const MAX_STATE_ID_BYTES = 128;
const MAX_READ_SLACK_BYTES = 1;

export const DASH_DEFAULT_UI_SETTINGS: Readonly<DashboardUiSettings> = Object.freeze({
  theme: Object.freeze({ name: "nord-midnight", density: "comfortable" }),
  editor: Object.freeze({ mode: "multiline" }),
  sidebar: Object.freeze({ initialLimit: 100, showProject: true, groupBy: "none" }),
  transcript: Object.freeze({ expandTools: false, expandThinking: false }),
  motion: Object.freeze({ reduced: false }),
  cache: Object.freeze({
    transcriptBytes: DASH_DEFAULT_LIMITS.browserTranscriptCacheBytes,
    transcriptEntries: DASH_DEFAULT_LIMITS.browserTranscriptCacheEntries,
  }),
});

export class DashboardStoreError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = "DashboardStoreError";
    this.code = code;
    this.status = status;
  }
}

interface IdempotencyReceipt {
  key: string;
  fingerprint: string;
  revision: number;
}

interface WorkspaceEnvelope {
  formatVersion: typeof STORE_FORMAT_VERSION;
  resource: DashboardWorkspaceResource;
  idempotency: IdempotencyReceipt[];
}

interface SettingsEnvelope {
  formatVersion: typeof STORE_FORMAT_VERSION;
  revision: number;
  runtimeOverlay: DashboardUiSettingsPatch;
  idempotency: IdempotencyReceipt[];
}

export interface DashboardWorkspaceStoreOptions {
  stateDir: string;
  limits?: Partial<DashboardLimits>;
  now?: () => Date;
}

export interface DashboardSettingsStoreOptions extends DashboardWorkspaceStoreOptions {
  configuredUi?: Readonly<Record<string, ConfigJson>>;
}

export function workspaceEtag(resource: DashboardWorkspaceResource): string {
  return `"workspace:${resource.workspaceId}:${resource.revision}"`;
}

export function settingsEtag(resource: DashboardSettingsResource): string {
  return `"settings:${resource.revision}"`;
}

/** Owner-private, revisioned, atomically-published workspace split trees. */
export class DashboardWorkspaceStore {
  readonly stateDir: string;
  readonly workspacesDir: string;
  readonly limits: DashboardLimits;
  readonly #now: () => Date;
  #tail: Promise<void> = Promise.resolve();

  constructor(options: DashboardWorkspaceStoreOptions) {
    if (options.stateDir.length === 0) throw new Error("stateDir must not be empty");
    this.stateDir = join(options.stateDir, "web");
    this.workspacesDir = join(this.stateDir, "workspaces");
    this.limits = mergeLimits(options.limits);
    this.#now = options.now ?? (() => new Date());
  }

  async getOrCreate(workspaceId: string): Promise<DashboardWorkspaceResource> {
    validateStateId(workspaceId, "workspaceId");
    return this.#serialize(workspaceId, async () => {
      await this.#initialize();
      const loaded = await this.#readRecoverable(workspaceId);
      if (loaded !== undefined) return structuredClone(loaded.resource);
      await this.#enforceWorkspaceCapacity();
      const resource = defaultWorkspace(workspaceId, this.#timestamp());
      await this.#write(workspaceId, { formatVersion: STORE_FORMAT_VERSION, resource, idempotency: [] });
      return structuredClone(resource);
    });
  }

  async update(
    workspaceId: string,
    request: DashboardWorkspaceUpdateRequest,
    ifMatch: string,
  ): Promise<DashboardWorkspaceResource> {
    validateStateId(workspaceId, "workspaceId");
    const normalized = validateWorkspaceUpdate(request, this.limits);
    return this.#serialize(workspaceId, async () => {
      await this.#initialize();
      const loaded = await this.#readRecoverable(workspaceId);
      if (loaded === undefined) await this.#enforceWorkspaceCapacity();
      const envelope = loaded ?? {
        formatVersion: STORE_FORMAT_VERSION,
        resource: defaultWorkspace(workspaceId, this.#timestamp()),
        idempotency: [],
      };
      const fingerprint = stableFingerprint({
        expectedRevision: normalized.expectedRevision,
        selectedPaneId: normalized.selectedPaneId,
        layout: normalized.layout,
        seenCursors: normalized.seenCursors,
      });
      const repeated = envelope.idempotency.find((receipt) => receipt.key === normalized.idempotencyKey);
      if (repeated !== undefined) {
        if (repeated.fingerprint !== fingerprint) throw idempotencyConflict();
        if (repeated.revision === envelope.resource.revision) {
          return structuredClone(envelope.resource);
        }
        throw new DashboardStoreError(
          "idempotency_result_expired",
          "retained workspace idempotency result was superseded",
          409,
        );
      }
      if (ifMatch !== workspaceEtag(envelope.resource)) throw revisionConflict("workspace");
      if (normalized.expectedRevision !== envelope.resource.revision) throw revisionConflict("workspace");
      const now = this.#timestamp();
      const resource: DashboardWorkspaceResource = {
        workspaceId,
        revision: envelope.resource.revision + 1,
        createdAt: envelope.resource.createdAt,
        updatedAt: now,
        selectedPaneId: normalized.selectedPaneId,
        layout: normalized.layout,
        seenCursors: normalized.seenCursors,
      };
      envelope.resource = resource;
      envelope.idempotency.push({
        key: normalized.idempotencyKey,
        fingerprint,
        revision: resource.revision,
      });
      envelope.idempotency = envelope.idempotency.slice(-MAX_IDEMPOTENCY_ENTRIES);
      await this.#write(workspaceId, envelope);
      return structuredClone(resource);
    });
  }

  async #initialize(): Promise<void> {
    await ensurePrivateDirectory(this.stateDir, "dashboard state directory");
    await ensurePrivateDirectory(this.workspacesDir, "dashboard workspace directory");
  }

  async #readRecoverable(workspaceId: string): Promise<WorkspaceEnvelope | undefined> {
    const path = this.#path(workspaceId);
    let value: unknown;
    try {
      value = await readPrivateJson(path, this.limits.maxWorkspaceBytes);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return undefined;
      if (error instanceof DashboardStoreError && error.code === "stored_state_corrupt") {
        await quarantineCorrupt(path, this.#timestamp());
        return undefined;
      }
      throw error;
    }
    try {
      return validateWorkspaceEnvelope(value, workspaceId, this.limits);
    } catch (error) {
      if (error instanceof DashboardStoreError && error.code === "stored_state_corrupt") {
        await quarantineCorrupt(path, this.#timestamp());
        return undefined;
      }
      throw error;
    }
  }

  async #enforceWorkspaceCapacity(): Promise<void> {
    const entries = await readdir(this.workspacesDir, { withFileTypes: true });
    const count = entries.filter(
      (entry) => entry.isFile() && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}\.json$/.test(entry.name),
    ).length;
    if (count >= this.limits.maxWorkspaces) {
      throw new DashboardStoreError(
        "workspace_capacity",
        "dashboard workspace capacity is exhausted",
        503,
      );
    }
  }

  async #write(workspaceId: string, envelope: WorkspaceEnvelope): Promise<void> {
    while (
      envelope.idempotency.length > 0 &&
      jsonBytes(envelope) + 1 > this.limits.maxWorkspaceBytes
    ) {
      envelope.idempotency.shift();
    }
    if (jsonBytes(envelope) + 1 > this.limits.maxWorkspaceBytes) {
      throw new DashboardStoreError("workspace_too_large", "workspace exceeds its byte limit", 413);
    }
    await atomicWritePrivateJson(this.#path(workspaceId), envelope);
  }

  #path(workspaceId: string): string {
    return join(this.workspacesDir, `${workspaceId}.json`);
  }

  #timestamp(): string {
    const timestamp = this.#now();
    if (!Number.isFinite(timestamp.getTime())) throw new Error("now returned an invalid date");
    return timestamp.toISOString();
  }

  #serialize<T>(_key: string, operation: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(operation, operation);
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

/** Config-default + UI-only runtime overlay with optimistic durable revisions. */
export class DashboardSettingsStore {
  readonly stateDir: string;
  readonly settingsPath: string;
  readonly limits: DashboardLimits;
  readonly configured: DashboardUiSettingsPatch;
  readonly #configuredEffective: DashboardUiSettings;
  readonly #configuredSources: Record<string, "default" | "config">;
  readonly #now: () => Date;
  #tail: Promise<void> = Promise.resolve();

  constructor(options: DashboardSettingsStoreOptions) {
    if (options.stateDir.length === 0) throw new Error("stateDir must not be empty");
    this.stateDir = join(options.stateDir, "web");
    this.settingsPath = join(this.stateDir, "settings.json");
    this.limits = mergeLimits(options.limits);
    this.#now = options.now ?? (() => new Date());
    this.configured = validateSettingsPatch(options.configuredUi ?? {}, this.limits);
    this.#configuredEffective = applySettingsPatch(boundedDefaultUiSettings(this.limits), this.configured);
    this.#configuredSources = settingsSources(this.configured);
  }

  async get(): Promise<DashboardSettingsResource> {
    return this.#serialize(async () => this.#resource(await this.#readRecoverable()));
  }

  async patch(
    request: DashboardSettingsPatchRequest,
    ifMatch: string,
  ): Promise<DashboardSettingsResource> {
    const normalized = validateSettingsPatchRequest(request, this.limits);
    return this.#serialize(async () => {
      const envelope = await this.#readRecoverable();
      const fingerprint = stableFingerprint({
        expectedRevision: normalized.expectedRevision,
        patch: normalized.patch,
      });
      const repeated = envelope.idempotency.find((receipt) => receipt.key === normalized.idempotencyKey);
      if (repeated !== undefined) {
        if (repeated.fingerprint !== fingerprint) throw idempotencyConflict();
        if (repeated.revision === envelope.revision) return this.#resource(envelope);
        throw new DashboardStoreError(
          "idempotency_result_expired",
          "retained settings idempotency result was superseded",
          409,
        );
      }
      if (ifMatch !== settingsEtag(this.#resource(envelope))) throw revisionConflict("settings");
      if (normalized.expectedRevision !== envelope.revision) throw revisionConflict("settings");
      envelope.revision += 1;
      envelope.runtimeOverlay = mergeSettingsPatches(envelope.runtimeOverlay, normalized.patch);
      envelope.idempotency.push({
        key: normalized.idempotencyKey,
        fingerprint,
        revision: envelope.revision,
      });
      envelope.idempotency = envelope.idempotency.slice(-MAX_IDEMPOTENCY_ENTRIES);
      await this.#write(envelope);
      return this.#resource(envelope);
    });
  }

  async reset(options: {
    expectedRevision: number;
    idempotencyKey: string;
    ifMatch: string;
  }): Promise<DashboardSettingsResource> {
    validateRevision(options.expectedRevision);
    validateStateId(options.idempotencyKey, "idempotencyKey");
    return this.#serialize(async () => {
      const envelope = await this.#readRecoverable();
      const fingerprint = stableFingerprint({ reset: true, expectedRevision: options.expectedRevision });
      const repeated = envelope.idempotency.find((receipt) => receipt.key === options.idempotencyKey);
      if (repeated !== undefined) {
        if (repeated.fingerprint !== fingerprint) throw idempotencyConflict();
        if (repeated.revision === envelope.revision) return this.#resource(envelope);
        throw new DashboardStoreError(
          "idempotency_result_expired",
          "retained settings reset result was superseded",
          409,
        );
      }
      if (options.ifMatch !== settingsEtag(this.#resource(envelope))) throw revisionConflict("settings");
      if (options.expectedRevision !== envelope.revision) throw revisionConflict("settings");
      envelope.revision += 1;
      envelope.runtimeOverlay = {};
      envelope.idempotency.push({
        key: options.idempotencyKey,
        fingerprint,
        revision: envelope.revision,
      });
      envelope.idempotency = envelope.idempotency.slice(-MAX_IDEMPOTENCY_ENTRIES);
      await this.#write(envelope);
      return this.#resource(envelope);
    });
  }

  async #readRecoverable(): Promise<SettingsEnvelope> {
    await ensurePrivateDirectory(this.stateDir, "dashboard state directory");
    let value: unknown;
    try {
      value = await readPrivateJson(this.settingsPath, this.limits.maxSettingsBytes);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return defaultSettingsEnvelope();
      if (error instanceof DashboardStoreError && error.code === "stored_state_corrupt") {
        await quarantineCorrupt(this.settingsPath, this.#timestamp());
        return defaultSettingsEnvelope();
      }
      throw error;
    }
    try {
      return validateSettingsEnvelope(value, this.limits);
    } catch (error) {
      if (error instanceof DashboardStoreError && error.code === "stored_state_corrupt") {
        await quarantineCorrupt(this.settingsPath, this.#timestamp());
        return defaultSettingsEnvelope();
      }
      throw error;
    }
  }

  #resource(envelope: SettingsEnvelope): DashboardSettingsResource {
    const effective = applySettingsPatch(this.#configuredEffective, envelope.runtimeOverlay);
    return {
      revision: envelope.revision,
      effective,
      runtimeOverlay: structuredClone(envelope.runtimeOverlay),
      sources: {
        ...this.#configuredSources,
        ...runtimeSources(envelope.runtimeOverlay),
      },
    };
  }

  async #write(envelope: SettingsEnvelope): Promise<void> {
    while (
      envelope.idempotency.length > 0 &&
      jsonBytes(envelope) + 1 > this.limits.maxSettingsBytes
    ) {
      envelope.idempotency.shift();
    }
    if (jsonBytes(envelope) + 1 > this.limits.maxSettingsBytes) {
      throw new DashboardStoreError("settings_too_large", "settings exceed their byte limit", 413);
    }
    await atomicWritePrivateJson(this.settingsPath, envelope);
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(operation, operation);
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  #timestamp(): string {
    const timestamp = this.#now();
    if (!Number.isFinite(timestamp.getTime())) throw new Error("now returned an invalid date");
    return timestamp.toISOString();
  }
}

function defaultWorkspace(workspaceId: string, timestamp: string): DashboardWorkspaceResource {
  return {
    workspaceId,
    revision: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
    selectedPaneId: "pane-main",
    layout: { type: "leaf", paneId: "pane-main", content: { type: "empty" } },
    seenCursors: {},
  };
}

function defaultSettingsEnvelope(): SettingsEnvelope {
  return { formatVersion: STORE_FORMAT_VERSION, revision: 0, runtimeOverlay: {}, idempotency: [] };
}

function validateWorkspaceEnvelope(
  value: unknown,
  workspaceId: string,
  limits: DashboardLimits,
): WorkspaceEnvelope {
  const object = storedObject(value);
  assertExactKeys(object, ["formatVersion", "resource", "idempotency"], true);
  if (object.formatVersion !== STORE_FORMAT_VERSION || !isRecord(object.resource)) storedCorrupt();
  const resourceObject = object.resource as Record<string, unknown>;
  if (resourceObject.workspaceId !== workspaceId) storedCorrupt();
  const resource = validateWorkspaceResource(resourceObject, limits);
  const idempotency = validateStoredReceipts(object.idempotency);
  return { formatVersion: STORE_FORMAT_VERSION, resource, idempotency };
}

function validateWorkspaceResource(
  object: Record<string, unknown>,
  limits: DashboardLimits,
): DashboardWorkspaceResource {
  assertExactKeys(object, [
    "workspaceId",
    "revision",
    "createdAt",
    "updatedAt",
    "selectedPaneId",
    "layout",
    "seenCursors",
  ], true);
  const workspaceId = storedString(object.workspaceId, MAX_STATE_ID_BYTES);
  const revision = storedRevision(object.revision);
  const createdAt = storedTimestamp(object.createdAt);
  const updatedAt = storedTimestamp(object.updatedAt);
  const selectedPaneId = storedString(object.selectedPaneId, MAX_STATE_ID_BYTES);
  const layoutState = { panes: 0, paneIds: new Set<string>() };
  const layout = validateLayout(object.layout, limits, 1, layoutState, true);
  if (!layoutState.paneIds.has(selectedPaneId)) storedCorrupt();
  const seenCursors = validateSeenCursors(object.seenCursors, limits, true);
  return { workspaceId, revision, createdAt, updatedAt, selectedPaneId, layout, seenCursors };
}

function validateWorkspaceUpdate(
  value: DashboardWorkspaceUpdateRequest,
  limits: DashboardLimits,
): DashboardWorkspaceUpdateRequest {
  const object = inputObject(value, "workspace update");
  assertExactKeys(object, [
    "requestId",
    "idempotencyKey",
    "expectedRevision",
    "selectedPaneId",
    "layout",
    "seenCursors",
  ]);
  const requestId = inputId(object.requestId, "requestId");
  const idempotencyKey = inputId(object.idempotencyKey, "idempotencyKey");
  const expectedRevision = inputRevision(object.expectedRevision);
  const selectedPaneId = inputId(object.selectedPaneId, "selectedPaneId");
  const layoutState = { panes: 0, paneIds: new Set<string>() };
  const layout = validateLayout(object.layout, limits, 1, layoutState, false);
  if (!layoutState.paneIds.has(selectedPaneId)) {
    throw new DashboardStoreError("invalid_workspace", "selected pane is not present in layout");
  }
  const seenCursors = validateSeenCursors(object.seenCursors, limits, false);
  const normalized = {
    requestId,
    idempotencyKey,
    expectedRevision,
    selectedPaneId,
    layout,
    seenCursors,
  };
  if (jsonBytes(normalized) > limits.maxWorkspaceBytes) {
    throw new DashboardStoreError("workspace_too_large", "workspace exceeds its byte limit", 413);
  }
  return normalized;
}

function validateLayout(
  value: unknown,
  limits: DashboardLimits,
  depth: number,
  state: { panes: number; paneIds: Set<string> },
  stored: boolean,
): DashboardLayoutNode {
  if (depth > limits.maxLayoutDepth) invalid(stored, "layout exceeds its depth limit");
  const object = stored ? storedObject(value) : inputObject(value, "layout node");
  if (object.type === "leaf") {
    assertExactKeys(object, ["type", "paneId", "content"], stored, ["content"]);
    const paneId = stored
      ? storedString(object.paneId, MAX_STATE_ID_BYTES)
      : inputId(object.paneId, "paneId");
    if (state.paneIds.has(paneId)) invalid(stored, "layout contains duplicate pane IDs");
    state.paneIds.add(paneId);
    state.panes += 1;
    if (state.panes > limits.maxWorkspacePanes) invalid(stored, "layout exceeds its pane limit");
    const content = object.content === undefined ? undefined : validatePaneTarget(object.content, stored);
    return {
      type: "leaf",
      paneId,
      ...(content === undefined ? {} : { content }),
    };
  }
  if (object.type === "split") {
    assertExactKeys(object, ["type", "direction", "ratio", "first", "second"], stored);
    if (object.direction !== "horizontal" && object.direction !== "vertical") {
      invalid(stored, "layout split direction is invalid");
    }
    if (typeof object.ratio !== "number" || !Number.isFinite(object.ratio) || object.ratio < 0.1 || object.ratio > 0.9) {
      invalid(stored, "layout split ratio must be between 0.1 and 0.9");
    }
    return {
      type: "split",
      direction: object.direction,
      ratio: object.ratio,
      first: validateLayout(object.first, limits, depth + 1, state, stored),
      second: validateLayout(object.second, limits, depth + 1, state, stored),
    };
  }
  invalid(stored, "layout node type is invalid");
}

function validatePaneTarget(value: unknown, stored: boolean): PaneTarget {
  const object = stored ? storedObject(value) : inputObject(value, "pane content");
  if (object.type === "empty") {
    assertExactKeys(object, ["type"], stored);
    return { type: "empty" };
  }
  if (object.type === "info") {
    assertExactKeys(object, ["type", "inventoryId"], stored);
    return {
      type: "info",
      inventoryId: stored
        ? storedString(object.inventoryId, MAX_STATE_ID_BYTES)
        : inputId(object.inventoryId, "inventoryId"),
    };
  }
  if (object.type === "chat") {
    assertExactKeys(object, ["type", "inventoryId", "presentation"], stored);
    if (object.presentation !== "rich" && object.presentation !== "tui") {
      invalid(stored, "pane presentation is invalid");
    }
    return {
      type: "chat",
      inventoryId: stored
        ? storedString(object.inventoryId, MAX_STATE_ID_BYTES)
        : inputId(object.inventoryId, "inventoryId"),
      presentation: object.presentation,
    };
  }
  invalid(stored, "pane target type is invalid");
}

function validateSeenCursors(
  value: unknown,
  limits: DashboardLimits,
  stored: boolean,
): Record<string, ReturnType<typeof asDashboardCursor>> {
  const object = stored ? storedObject(value) : inputObject(value, "seen cursors");
  const keys = Object.keys(object).sort();
  if (keys.length > limits.maxIndexedSessions) invalid(stored, "seen cursor map exceeds its count limit");
  const result: Record<string, ReturnType<typeof asDashboardCursor>> = {};
  for (const key of keys) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(key) || typeof object[key] !== "string") {
      invalid(stored, "seen cursor map contains an invalid entry");
    }
    try {
      result[key] = asDashboardCursor(object[key]);
    } catch {
      invalid(stored, "seen cursor map contains an invalid cursor");
    }
  }
  return result;
}

function validateSettingsEnvelope(value: unknown, limits: DashboardLimits): SettingsEnvelope {
  const object = storedObject(value);
  assertExactKeys(object, ["formatVersion", "revision", "runtimeOverlay", "idempotency"], true);
  if (object.formatVersion !== STORE_FORMAT_VERSION) storedCorrupt();
  const revision = storedRevision(object.revision);
  let runtimeOverlay: DashboardUiSettingsPatch;
  try {
    runtimeOverlay = validateSettingsPatch(object.runtimeOverlay, limits);
  } catch {
    storedCorrupt();
  }
  return {
    formatVersion: STORE_FORMAT_VERSION,
    revision,
    runtimeOverlay,
    idempotency: validateStoredReceipts(object.idempotency),
  };
}

function validateSettingsPatchRequest(
  value: DashboardSettingsPatchRequest,
  limits: DashboardLimits,
): DashboardSettingsPatchRequest {
  const object = inputObject(value, "settings patch request");
  assertExactKeys(object, ["requestId", "idempotencyKey", "expectedRevision", "patch"]);
  return {
    requestId: inputId(object.requestId, "requestId"),
    idempotencyKey: inputId(object.idempotencyKey, "idempotencyKey"),
    expectedRevision: inputRevision(object.expectedRevision),
    patch: validateSettingsPatch(object.patch, limits),
  };
}

export function validateSettingsPatch(
  value: unknown,
  limits: DashboardLimits = DASH_DEFAULT_LIMITS,
): DashboardUiSettingsPatch {
  const object = inputObject(value, "UI settings patch");
  assertExactKeys(object, ["theme", "editor", "sidebar", "transcript", "motion", "cache"], false, [
    "theme",
    "editor",
    "sidebar",
    "transcript",
    "motion",
    "cache",
  ]);
  const result: DashboardUiSettingsPatch = {};
  if (object.theme !== undefined) {
    const group = inputObject(object.theme, "theme settings");
    assertExactKeys(group, ["name", "density"], false, ["name", "density"]);
    const theme: NonNullable<DashboardUiSettingsPatch["theme"]> = {};
    if (group.name !== undefined) {
      if (typeof group.name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(group.name)) {
        throw invalidSettings("theme.name");
      }
      theme.name = group.name;
    }
    if (group.density !== undefined) {
      if (group.density !== "compact" && group.density !== "comfortable") throw invalidSettings("theme.density");
      theme.density = group.density;
    }
    result.theme = theme;
  }
  if (object.editor !== undefined) {
    const group = inputObject(object.editor, "editor settings");
    assertExactKeys(group, ["mode"], false, ["mode"]);
    const editor: NonNullable<DashboardUiSettingsPatch["editor"]> = {};
    if (group.mode !== undefined) {
      if (group.mode !== "multiline" && group.mode !== "vim") throw invalidSettings("editor.mode");
      editor.mode = group.mode;
    }
    result.editor = editor;
  }
  if (object.sidebar !== undefined) {
    const group = inputObject(object.sidebar, "sidebar settings");
    assertExactKeys(group, ["initialLimit", "showProject", "groupBy"], false, [
      "initialLimit",
      "showProject",
      "groupBy",
    ]);
    const sidebar: NonNullable<DashboardUiSettingsPatch["sidebar"]> = {};
    if (group.initialLimit !== undefined) {
      if (
        typeof group.initialLimit !== "number" ||
        !Number.isSafeInteger(group.initialLimit) ||
        group.initialLimit < 1 ||
        group.initialLimit > limits.maxInventoryPageItems
      ) {
        throw invalidSettings("sidebar.initialLimit");
      }
      sidebar.initialLimit = group.initialLimit;
    }
    if (group.showProject !== undefined) {
      if (typeof group.showProject !== "boolean") throw invalidSettings("sidebar.showProject");
      sidebar.showProject = group.showProject;
    }
    if (group.groupBy !== undefined) {
      if (!(["none", "source", "age"] as unknown[]).includes(group.groupBy)) throw invalidSettings("sidebar.groupBy");
      sidebar.groupBy = group.groupBy as "none" | "source" | "age";
    }
    result.sidebar = sidebar;
  }
  if (object.transcript !== undefined) {
    const group = inputObject(object.transcript, "transcript settings");
    assertExactKeys(group, ["expandTools", "expandThinking"], false, ["expandTools", "expandThinking"]);
    const transcript: NonNullable<DashboardUiSettingsPatch["transcript"]> = {};
    if (group.expandTools !== undefined) {
      if (typeof group.expandTools !== "boolean") throw invalidSettings("transcript.expandTools");
      transcript.expandTools = group.expandTools;
    }
    if (group.expandThinking !== undefined) {
      if (typeof group.expandThinking !== "boolean") throw invalidSettings("transcript.expandThinking");
      transcript.expandThinking = group.expandThinking;
    }
    result.transcript = transcript;
  }
  if (object.motion !== undefined) {
    const group = inputObject(object.motion, "motion settings");
    assertExactKeys(group, ["reduced"], false, ["reduced"]);
    const motion: NonNullable<DashboardUiSettingsPatch["motion"]> = {};
    if (group.reduced !== undefined) {
      if (typeof group.reduced !== "boolean") throw invalidSettings("motion.reduced");
      motion.reduced = group.reduced;
    }
    result.motion = motion;
  }
  if (object.cache !== undefined) {
    const group = inputObject(object.cache, "cache settings");
    assertExactKeys(group, ["transcriptBytes", "transcriptEntries"], false, [
      "transcriptBytes",
      "transcriptEntries",
    ]);
    const cache: NonNullable<DashboardUiSettingsPatch["cache"]> = {};
    if (group.transcriptBytes !== undefined) {
      if (
        typeof group.transcriptBytes !== "number" ||
        !Number.isSafeInteger(group.transcriptBytes) ||
        group.transcriptBytes < 1 ||
        group.transcriptBytes > limits.browserTranscriptCacheBytes
      ) {
        throw invalidSettings("cache.transcriptBytes");
      }
      cache.transcriptBytes = group.transcriptBytes;
    }
    if (group.transcriptEntries !== undefined) {
      if (
        typeof group.transcriptEntries !== "number" ||
        !Number.isSafeInteger(group.transcriptEntries) ||
        group.transcriptEntries < 1 ||
        group.transcriptEntries > limits.browserTranscriptCacheEntries
      ) {
        throw invalidSettings("cache.transcriptEntries");
      }
      cache.transcriptEntries = group.transcriptEntries;
    }
    result.cache = cache;
  }
  if (jsonBytes(result) > limits.maxSettingsBytes) throw new DashboardStoreError("settings_too_large", "settings exceed their byte limit", 413);
  return result;
}

function applySettingsPatch(
  base: Readonly<DashboardUiSettings>,
  patch: DashboardUiSettingsPatch,
): DashboardUiSettings {
  return {
    theme: { ...base.theme, ...patch.theme },
    editor: { ...base.editor, ...patch.editor },
    sidebar: { ...base.sidebar, ...patch.sidebar },
    transcript: { ...base.transcript, ...patch.transcript },
    motion: { ...base.motion, ...patch.motion },
    cache: { ...base.cache, ...patch.cache },
  };
}

function mergeSettingsPatches(
  base: DashboardUiSettingsPatch,
  patch: DashboardUiSettingsPatch,
): DashboardUiSettingsPatch {
  const result: DashboardUiSettingsPatch = structuredClone(base);
  for (const key of ["theme", "editor", "sidebar", "transcript", "motion", "cache"] as const) {
    if (patch[key] !== undefined) {
      result[key] = { ...(result[key] as object | undefined), ...patch[key] } as never;
    }
  }
  return result;
}

const SETTING_PATHS = [
  "theme.name",
  "theme.density",
  "editor.mode",
  "sidebar.initialLimit",
  "sidebar.showProject",
  "sidebar.groupBy",
  "transcript.expandTools",
  "transcript.expandThinking",
  "motion.reduced",
  "cache.transcriptBytes",
  "cache.transcriptEntries",
] as const;

function settingsSources(
  configured: DashboardUiSettingsPatch,
): Record<string, "default" | "config"> {
  const result: Record<string, "default" | "config"> = {};
  for (const path of SETTING_PATHS) result[path] = hasSetting(configured, path) ? "config" : "default";
  return result;
}

function runtimeSources(runtime: DashboardUiSettingsPatch): Record<string, "runtime"> {
  const result: Record<string, "runtime"> = {};
  for (const path of SETTING_PATHS) if (hasSetting(runtime, path)) result[path] = "runtime";
  return result;
}

function hasSetting(patch: DashboardUiSettingsPatch, path: string): boolean {
  const [group, field] = path.split(".") as [keyof DashboardUiSettingsPatch, string];
  return patch[group] !== undefined && Object.prototype.hasOwnProperty.call(patch[group], field);
}

function validateStoredReceipts(value: unknown): IdempotencyReceipt[] {
  if (!Array.isArray(value) || value.length > MAX_IDEMPOTENCY_ENTRIES) storedCorrupt();
  const keys = new Set<string>();
  return value.map((receipt) => {
    const object = storedObject(receipt);
    assertExactKeys(object, ["key", "fingerprint", "revision"], true);
    const key = storedString(object.key, MAX_STATE_ID_BYTES);
    if (keys.has(key)) storedCorrupt();
    keys.add(key);
    const fingerprint = storedString(object.fingerprint, 128);
    const revision = storedRevision(object.revision);
    return { key, fingerprint, revision };
  });
}

function storedObject(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) storedCorrupt();
  return value;
}

function inputObject(value: unknown, name: string): Record<string, unknown> {
  if (!isRecord(value)) throw new DashboardStoreError("invalid_request", `${name} must be an object`);
  return value;
}

function assertExactKeys(
  object: Record<string, unknown>,
  allowed: readonly string[],
  stored = false,
  optional: readonly string[] = [],
): void {
  const allowedSet = new Set(allowed);
  if (Object.keys(object).some((key) => !allowedSet.has(key))) invalid(stored, "object contains unknown fields");
  const optionalSet = new Set(optional);
  if (allowed.some((key) => !optionalSet.has(key) && !Object.prototype.hasOwnProperty.call(object, key))) {
    invalid(stored, "object is missing required fields");
  }
}

function inputId(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    throw new DashboardStoreError("invalid_request", `${name} is invalid`);
  }
  return value;
}

function validateStateId(value: string, name: string): void {
  inputId(value, name);
}

function inputRevision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new DashboardStoreError("invalid_request", "expectedRevision is invalid");
  }
  return value as number;
}

function validateRevision(value: number): void {
  inputRevision(value);
}

function storedRevision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) storedCorrupt();
  return value as number;
}

function storedString(value: unknown, maxBytes: number): string {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > maxBytes) storedCorrupt();
  return value;
}

function storedTimestamp(value: unknown): string {
  const timestamp = storedString(value, 64);
  if (!Number.isFinite(Date.parse(timestamp))) storedCorrupt();
  return timestamp;
}

function invalidSettings(path: string): DashboardStoreError {
  return new DashboardStoreError("invalid_settings", `${path} is invalid`);
}

function invalid(stored: boolean, message: string): never {
  if (stored) storedCorrupt();
  throw new DashboardStoreError("invalid_request", message);
}

function storedCorrupt(): never {
  throw new DashboardStoreError("stored_state_corrupt", "stored dashboard state is invalid", 500);
}

function revisionConflict(resource: string): DashboardStoreError {
  return new DashboardStoreError(
    "revision_conflict",
    `${resource} revision or ETag no longer matches`,
    409,
  );
}

function idempotencyConflict(): DashboardStoreError {
  return new DashboardStoreError(
    "idempotency_conflict",
    "idempotency key was already used for a different request",
    409,
  );
}

function stableFingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("base64url");
}

function mergeLimits(overrides: Partial<DashboardLimits> | undefined): DashboardLimits {
  const result = { ...DASH_DEFAULT_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(result)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be positive`);
  }
  return result;
}

async function ensurePrivateDirectory(path: string, description: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${description} must be a real directory`);
  const getuid = process.getuid;
  if (getuid !== undefined && info.uid !== getuid()) throw new Error(`${description} must be owned by current user`);
  if ((info.mode & 0o077) !== 0) throw new Error(`${description} must be owner-only`);
}

async function readPrivateJson(path: string, maxBytes: number): Promise<unknown> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (isNodeError(error) && error.code === "ELOOP") {
      throw new Error("dashboard state files must not be symbolic links");
    }
    throw error;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error("dashboard state path must be a regular file");
    const getuid = process.getuid;
    if (getuid !== undefined && info.uid !== getuid()) throw new Error("dashboard state must be owner-owned");
    if ((info.mode & 0o077) !== 0) throw new Error("dashboard state must be owner-only");
    if (info.size > maxBytes) storedCorrupt();
    const buffer = Buffer.allocUnsafe(maxBytes + MAX_READ_SLACK_BYTES);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, null);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > maxBytes) storedCorrupt();
    try {
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, offset)));
    } catch {
      storedCorrupt();
    }
  } finally {
    await handle.close();
  }
}

async function atomicWritePrivateJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
    await chmod(path, 0o600);
    const directory = await open(dirname(path), constants.O_RDONLY);
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function quarantineCorrupt(path: string, timestamp: string): Promise<void> {
  const suffix = timestamp.replace(/[^0-9A-Za-z]/g, "-");
  try {
    await rename(path, `${path}.corrupt-${suffix}-${randomUUID()}`);
  } catch (error) {
    if (!(isNodeError(error) && error.code === "ENOENT")) throw error;
  }
}

function boundedDefaultUiSettings(limits: DashboardLimits): DashboardUiSettings {
  return {
    theme: { ...DASH_DEFAULT_UI_SETTINGS.theme },
    editor: { ...DASH_DEFAULT_UI_SETTINGS.editor },
    sidebar: {
      ...DASH_DEFAULT_UI_SETTINGS.sidebar,
      initialLimit: Math.min(
        DASH_DEFAULT_UI_SETTINGS.sidebar.initialLimit,
        limits.maxInventoryPageItems,
      ),
    },
    transcript: { ...DASH_DEFAULT_UI_SETTINGS.transcript },
    motion: { ...DASH_DEFAULT_UI_SETTINGS.motion },
    cache: {
      transcriptBytes: Math.min(
        DASH_DEFAULT_UI_SETTINGS.cache.transcriptBytes,
        limits.browserTranscriptCacheBytes,
      ),
      transcriptEntries: Math.min(
        DASH_DEFAULT_UI_SETTINGS.cache.transcriptEntries,
        limits.browserTranscriptCacheEntries,
      ),
    },
  };
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
