import { lstatSync } from "node:fs";
import { chmod, lstat, open, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

import {
  AgentSessionRuntime,
  AuthStorage,
  createAgentSession,
  createAgentSessionRuntime,
  createAgentSessionServices,
  createBashTool,
  createExtensionRuntime,
  createLocalBashOperations,
  getAgentDir,
  ModelRegistry,
  resolveCliModel,
  resolveModelScopeWithDiagnostics,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type AgentSessionEvent,
  type AgentSessionServices,
  type BashOperations,
  type CreateAgentSessionOptions,
  type CreateAgentSessionResult,
  type CreateAgentSessionRuntimeFactory,
  type ResourceLoader,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import { encodedSessionId, ensurePrivateDirectory } from "./durability.js";
import {
  PiRpcController,
  type PiRpcControllerOptions,
} from "./pi-rpc-controller.js";
import {
  extensionFlagValues,
  providerApiKeyFromEnvironment,
  toolConfiguration,
  type PreparedSessionRuntimeOptions,
} from "./session-config.js";
import type {
  AdapterEvent,
  PromptRequest,
  SessionAdapter,
  SessionFactory,
  SessionOpenRequest,
} from "./multiplexer.js";

export interface PiSessionFactoryOptions {
  stateDir: string;
  agentDir?: string;
  allowedRoots: string[];
  authStorage?: AuthStorage;
  modelRegistry?: ModelRegistry;
  createSession?: (options: CreateAgentSessionOptions) => Promise<CreateAgentSessionResult>;
  rpcControllerOptions?: PiRpcControllerOptions;
}

export interface PiFactoryReadiness {
  agentDir: string;
  configuredProviders: string[];
  availableModels: number;
  modelRegistryError?: string;
  authErrors: string[];
}

/**
 * Real Pi SDK adapter with process-global auth/model state and per-session
 * SessionManager, SettingsManager, ResourceLoader, event subscription, and cwd.
 */
export class PiSessionFactory implements SessionFactory {
  readonly agentDir: string;
  readonly authStorage: AuthStorage;
  readonly modelRegistry: ModelRegistry;
  readonly #stateDir: string;
  readonly #allowedRoots: string[];
  readonly #createSession: (
    options: CreateAgentSessionOptions,
  ) => Promise<CreateAgentSessionResult>;
  readonly #rpcControllerOptions: PiRpcControllerOptions;

  constructor(options: PiSessionFactoryOptions) {
    if (options.stateDir.length === 0) throw new Error("stateDir must not be empty");
    this.#stateDir = resolve(options.stateDir);
    if (options.allowedRoots.length === 0) {
      throw new Error("at least one allowedRoots entry is required");
    }
    this.#allowedRoots = options.allowedRoots.map((root) => resolve(root));
    this.agentDir = resolve(options.agentDir ?? getAgentDir());
    const authPath = join(this.agentDir, "auth.json");
    if (options.authStorage === undefined) validatePrivateAuthFile(authPath);
    this.authStorage = options.authStorage ?? AuthStorage.create(authPath);
    this.modelRegistry =
      options.modelRegistry ??
      ModelRegistry.create(this.authStorage, join(this.agentDir, "models.json"));
    this.#createSession = options.createSession ?? createAgentSession;
    this.#rpcControllerOptions = { ...(options.rpcControllerOptions ?? {}) };
  }

  readiness(): PiFactoryReadiness {
    const registryError = this.modelRegistry.getError();
    const result: PiFactoryReadiness = {
      agentDir: this.agentDir,
      configuredProviders: this.authStorage.list().sort(),
      availableModels: this.modelRegistry.getAvailable().length,
      authErrors: this.authStorage.drainErrors().map((error) => error.message),
    };
    if (registryError !== undefined) result.modelRegistryError = registryError;
    return result;
  }

  async open(request: SessionOpenRequest): Promise<SessionAdapter> {
    const runtimeOptions = request.runtimeOptions;
    const configuredSpec = runtimeOptions?.persistedSpec;
    const selectedAgentDir = resolve(configuredSpec?.agentDir ?? request.agentDir ?? this.agentDir);
    if (runtimeOptions === undefined && selectedAgentDir !== this.agentDir) {
      throw new PiAdapterError(
        "agent_dir_mismatch",
        "legacy no-tools sessions cannot override the shared host agentDir",
      );
    }
    await ensurePrivateDirectory(selectedAgentDir, "Pi agent directory");
    if (selectedAgentDir !== this.agentDir) {
      validatePrivateAuthFile(join(selectedAgentDir, "auth.json"));
    }

    const roots = await Promise.all([
      realpath(this.#stateDir),
      realpath(this.agentDir),
      realpath(selectedAgentDir),
      ...this.#allowedRoots.map(async (root) => realpath(root)),
    ]);
    const [stateRoot, defaultAgentRoot, selectedAgentRoot, ...allowedRoots] = roots;
    const validateCwd = async (candidate: string): Promise<string> =>
      validateRuntimeCwd(
        candidate,
        stateRoot!,
        [defaultAgentRoot!, selectedAgentRoot!],
        allowedRoots,
      );
    const cwd = await validateCwd(configuredSpec?.cwd ?? request.cwd);

    const sessionsRoot = join(this.#stateDir, "sessions");
    const logicalSessionRoot = join(sessionsRoot, encodedSessionId(request.sessionId));
    const configuredSessionDir = configuredSpec?.target.sessionDir;
    const sessionDir = configuredSessionDir ?? join(logicalSessionRoot, "pi");
    await ensurePrivateDirectory(this.#stateDir, "state directory");
    await ensurePrivateDirectory(sessionsRoot, "sessions directory");
    await ensurePrivateDirectory(logicalSessionRoot, "logical session directory");
    await ensurePrivateDirectory(sessionDir, "Pi session directory");
    const canonicalSessionDir = await realpath(sessionDir);
    validateSessionRoot(canonicalSessionDir, cwd, selectedAgentRoot!);
    const sessionManager = await createSessionManager(request, cwd, canonicalSessionDir);

    const baseAuthStorage =
      selectedAgentDir === this.agentDir
        ? this.authStorage
        : AuthStorage.create(join(selectedAgentDir, "auth.json"));
    const authStorage = scopedAuthStorage(baseAuthStorage, runtimeOptions);
    const modelRegistry =
      authStorage === this.authStorage && selectedAgentDir === this.agentDir
        ? this.modelRegistry
        : ModelRegistry.create(authStorage, join(selectedAgentDir, "models.json"));
    const configuredModel = configuredSpec?.model;
    const resolvedModel =
      configuredModel === undefined
        ? undefined
        : resolveCliModel({
            ...(configuredModel.provider === undefined
              ? {}
              : { cliProvider: configuredModel.provider }),
            ...(configuredModel.id === undefined ? {} : { cliModel: configuredModel.id }),
            ...(configuredModel.thinkingLevel === undefined
              ? {}
              : { cliThinking: configuredModel.thinkingLevel }),
            modelRegistry,
          });
    if (resolvedModel?.error !== undefined) {
      throw new PiAdapterError("model_unavailable", resolvedModel.error);
    }
    const scope =
      configuredModel?.scopedModels === undefined
        ? { scopedModels: [], diagnostics: [] }
        : await resolveModelScopeWithDiagnostics(configuredModel.scopedModels, modelRegistry);
    const legacyModel =
      request.model === undefined
        ? undefined
        : modelRegistry.find(request.model.provider, request.model.id);
    const model =
      resolvedModel?.model ??
      legacyModel ??
      scope.scopedModels[0]?.model ??
      (configuredSpec === undefined ? modelRegistry.getAvailable()[0] : undefined);
    if (configuredSpec === undefined && model === undefined) {
      throw new PiAdapterError("model_unavailable", "no authenticated Pi model is available");
    }
    if (model !== undefined && !modelRegistry.hasConfiguredAuth(model)) {
      throw new PiAdapterError(
        "model_auth_unavailable",
        `authentication is not configured for provider: ${model.provider}`,
      );
    }
    const thinkingLevel =
      resolvedModel?.thinkingLevel ?? configuredModel?.thinkingLevel ?? request.model?.thinkingLevel;
    const configuredTools =
      configuredSpec === undefined
        ? { noTools: "all" as const, tools: [] as string[], excludeTools: undefined }
        : toolConfiguration(configuredSpec);
    const configuredExtensionFlags =
      configuredSpec === undefined ? undefined : extensionFlagValues(configuredSpec);

    const createRuntime: CreateAgentSessionRuntimeFactory = async ({
      cwd: runtimeCwd,
      agentDir: runtimeAgentDir,
      sessionManager: runtimeSessionManager,
      sessionStartEvent,
    }) => {
      const canonicalCwd = await validateCwd(runtimeCwd);
      if (resolve(runtimeAgentDir) !== selectedAgentDir) {
        throw new PiAdapterError(
          "agent_dir_mismatch",
          "runtime replacement cannot override the configured session agentDir",
        );
      }
      const settingsManager =
        configuredSpec === undefined
          ? SettingsManager.inMemory()
          : SettingsManager.inMemory(
              configuredSpec.settings as Parameters<typeof SettingsManager.inMemory>[0],
              {
                projectTrusted: configuredSpec.resources?.projectTrust === "approve",
              },
            );
      const services =
        configuredSpec === undefined
          ? legacyServices(
              canonicalCwd,
              selectedAgentDir,
              authStorage,
              modelRegistry,
              settingsManager,
              request.resources?.systemPrompt,
            )
          : await createAgentSessionServices({
              cwd: canonicalCwd,
              agentDir: selectedAgentDir,
              authStorage,
              modelRegistry,
              settingsManager,
              ...(configuredExtensionFlags === undefined
                ? {}
                : { extensionFlagValues: configuredExtensionFlags }),
              resourceLoaderOptions: resourceLoaderOptions(configuredSpec),
            });
      services.diagnostics.push(
        ...scope.diagnostics.map((diagnostic) => ({
          type: "warning" as const,
          message: diagnostic.message,
        })),
      );
      const materializedSessionManager = await materializeSessionManager(
        runtimeSessionManager,
        canonicalCwd,
      );
      const customTools =
        runtimeOptions === undefined
          ? []
          : environmentToolOverrides(
              canonicalCwd,
              runtimeOptions.environmentOverlay,
              runtimeOptions.persistedSpec,
            );
      const result = await this.#createSession({
        cwd: canonicalCwd,
        agentDir: selectedAgentDir,
        authStorage,
        modelRegistry,
        ...(model === undefined ? {} : { model }),
        ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
        ...(scope.scopedModels.length === 0 ? {} : { scopedModels: scope.scopedModels }),
        ...(configuredTools.noTools === undefined ? {} : { noTools: configuredTools.noTools }),
        ...(configuredTools.tools === undefined ? {} : { tools: configuredTools.tools }),
        ...(configuredTools.excludeTools === undefined
          ? {}
          : { excludeTools: configuredTools.excludeTools }),
        customTools,
        resourceLoader: services.resourceLoader,
        sessionManager: materializedSessionManager,
        settingsManager,
        ...(sessionStartEvent === undefined ? {} : { sessionStartEvent }),
      });
      if (runtimeOptions === undefined && result.session.getActiveToolNames().length !== 0) {
        result.session.dispose();
        throw new PiAdapterError(
          "unsafe_tool_profile",
          "Pi SDK enabled tools despite the no-tools resource policy",
        );
      }
      return { ...result, services, diagnostics: services.diagnostics };
    };

    const runtime = await createAgentSessionRuntime(createRuntime, {
      cwd,
      agentDir: selectedAgentDir,
      sessionManager,
    });
    try {
      const adapter = await PiSessionAdapter.create(runtime, {
        sessionRoot: canonicalSessionDir,
        validateCwd,
      });
      await adapter.rpcController(
        configuredRpcControllerOptions(this.#rpcControllerOptions, runtimeOptions),
      );
      return adapter;
    } catch (error) {
      await runtime.dispose().catch(() => {});
      throw error;
    }
  }
}

export interface PiSessionIdentity {
  sessionId: string;
  sessionFile?: string;
}

export interface PiSessionAdapterOptions {
  sessionRoot: string;
  validateCwd: (cwd: string) => Promise<string>;
}

type SessionExtensionBindings = Parameters<AgentSession["bindExtensions"]>[0];

export class PiSessionAdapter implements SessionAdapter {
  readonly #runtime: AgentSessionRuntime;
  readonly #sessionRoot: string;
  readonly #validateCwd: (cwd: string) => Promise<string>;
  #unsubscribe: (() => void) | undefined;
  #identityChangeHandler: ((identity: PiSessionIdentity) => Promise<void>) | undefined;
  #sessionNameChangeHandler: ((name: string) => Promise<void>) | undefined;
  #extensionBindingsFactory: () => SessionExtensionBindings = () => ({ mode: "rpc" });
  readonly #rpcEventListeners = new Set<(event: AgentSessionEvent) => void>();
  #rpcController: Promise<PiRpcController> | undefined;
  #eventSink: ((event: AdapterEvent) => void) | undefined;
  #disposed = false;
  #invalidated = true;

  private constructor(runtime: AgentSessionRuntime, options: PiSessionAdapterOptions) {
    this.#runtime = runtime;
    this.#sessionRoot = options.sessionRoot;
    this.#validateCwd = options.validateCwd;
    runtime.setBeforeSessionInvalidate(() => this.#invalidateSession());
    runtime.setRebindSession(async (session) => this.#bindSession(session, true, true));
  }

  static async create(
    runtime: AgentSessionRuntime,
    options: PiSessionAdapterOptions,
  ): Promise<PiSessionAdapter> {
    const adapter = new PiSessionAdapter(runtime, options);
    await adapter.#bindSession(runtime.session, false, false);
    return adapter;
  }

  identity(): PiSessionIdentity {
    this.#assertOpen();
    const session = this.#runtime.session;
    return {
      sessionId: session.sessionId,
      ...(session.sessionFile === undefined ? {} : { sessionFile: session.sessionFile }),
    };
  }

  setIdentityChangeHandler(
    handler: ((identity: PiSessionIdentity) => Promise<void>) | undefined,
  ): void {
    this.#assertOpen();
    this.#identityChangeHandler = handler;
  }

  setSessionNameChangeHandler(
    handler: ((name: string) => Promise<void>) | undefined,
  ): void {
    this.#assertOpen();
    this.#sessionNameChangeHandler = handler;
  }

  async setRpcSessionName(name: string): Promise<void> {
    this.#assertOpen();
    await this.#sessionNameChangeHandler?.(name);
    this.#runtime.session.setSessionName(name);
  }

  rpcSession(): AgentSession {
    this.#assertOpen();
    return this.#runtime.session;
  }

  subscribeRpcEvents(listener: (event: AgentSessionEvent) => void): () => void {
    this.#assertOpen();
    this.#rpcEventListeners.add(listener);
    return () => this.#rpcEventListeners.delete(listener);
  }

  async setRpcExtensionBindingsFactory(
    factory: () => SessionExtensionBindings,
  ): Promise<void> {
    this.#assertReplaceable();
    this.#extensionBindingsFactory = factory;
    await this.#runtime.session.bindExtensions(factory());
  }

  rpcController(options: PiRpcControllerOptions = {}): Promise<PiRpcController> {
    this.#assertOpen();
    if (this.#rpcController === undefined) {
      const pending = PiRpcController.create(this, options);
      this.#rpcController = pending;
      void pending.catch(() => {
        if (this.#rpcController === pending) this.#rpcController = undefined;
      });
    }
    return this.#rpcController;
  }

  async prompt(request: PromptRequest): Promise<unknown> {
    this.#assertOpen();
    const session = this.#runtime.session;
    this.#eventSink = request.onEvent;
    try {
      await session.prompt(request.prompt, {
        expandPromptTemplates: false,
        source: "rpc",
        preflightResult: (accepted) => {
          if (!accepted) request.onEvent({ event: "preflightRejected" });
        },
      });
      await session.waitForIdle();
      return {
        text: session.getLastAssistantText(),
        sessionId: session.sessionId,
        sessionFile: session.sessionFile,
        model:
          session.model === undefined
            ? undefined
            : { provider: session.model.provider, id: session.model.id },
        thinkingLevel: session.thinkingLevel,
      };
    } finally {
      if (this.#eventSink === request.onEvent) this.#eventSink = undefined;
    }
  }

  async steer(message: string): Promise<void> {
    this.#assertOpen();
    await this.#runtime.session.steer(message);
  }

  async followUp(message: string): Promise<void> {
    this.#assertOpen();
    await this.#runtime.session.followUp(message);
  }

  async abort(): Promise<void> {
    this.#assertOpen();
    await this.#runtime.session.abort();
  }

  async newSession(parentSession?: string): Promise<{ cancelled: boolean }> {
    this.#assertReplaceable();
    const parent =
      parentSession === undefined ? undefined : await this.#validatedSessionPath(parentSession);
    return this.#runtime.newSession(
      parent === undefined ? undefined : { parentSession: parent },
    );
  }

  async switchSession(
    sessionPath: string,
    cwdOverride?: string,
  ): Promise<{ cancelled: boolean }> {
    this.#assertReplaceable();
    const path = await this.#validatedSessionPath(sessionPath);
    const preview = SessionManager.open(path, this.#sessionRoot, cwdOverride);
    await this.#validateCwd(preview.getCwd());
    return this.#runtime.switchSession(path, cwdOverride === undefined ? {} : { cwdOverride });
  }

  async fork(
    entryId: string,
    position: "before" | "at" = "before",
  ): Promise<{ cancelled: boolean; selectedText?: string }> {
    this.#assertReplaceable();
    return this.#runtime.fork(entryId, { position });
  }

  async importFromJsonl(
    inputPath: string,
    cwdOverride?: string,
  ): Promise<{ cancelled: boolean }> {
    this.#assertReplaceable();
    const path = await this.#validatedSessionPath(inputPath);
    const preview = SessionManager.open(path, this.#sessionRoot, cwdOverride);
    await this.#validateCwd(preview.getCwd());
    return this.#runtime.importFromJsonl(path, cwdOverride);
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#identityChangeHandler = undefined;
    this.#sessionNameChangeHandler = undefined;
    const rpcController = await this.#rpcController?.catch(() => undefined);
    rpcController?.dispose();
    this.#rpcController = undefined;
    this.#rpcEventListeners.clear();
    this.#invalidateSession();
    await this.#runtime.dispose();
  }

  async #bindSession(
    session: AgentSession,
    replacement: boolean,
    bindExtensions: boolean,
  ): Promise<void> {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    try {
      if (bindExtensions) {
        await session.bindExtensions(this.#extensionBindingsFactory());
      }
      this.#unsubscribe = session.subscribe((event) => this.#onSessionEvent(event));
      this.#invalidated = false;
      if (replacement && this.#identityChangeHandler !== undefined) {
        await this.#identityChangeHandler(this.identity());
      }
    } catch (error) {
      this.#invalidateSession();
      throw error;
    }
  }

  #invalidateSession(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    this.#eventSink = undefined;
    this.#invalidated = true;
  }

  async #validatedSessionPath(sessionPath: string): Promise<string> {
    const path = await realpath(
      isAbsolute(sessionPath) ? sessionPath : join(this.#sessionRoot, sessionPath),
    );
    if (!isWithin(this.#sessionRoot, path)) {
      throw new PiAdapterError(
        "session_path_outside_state",
        "session path must be inside the logical session's state directory",
      );
    }
    return path;
  }

  #assertReplaceable(): void {
    this.#assertOpen();
    if (!this.#runtime.session.isIdle) {
      throw new PiAdapterError(
        "session_busy",
        "Pi conversation cannot be replaced while the session is active",
      );
    }
  }

  #assertOpen(): void {
    if (this.#disposed) throw new PiAdapterError("session_disposed", "Pi session is disposed");
    if (this.#invalidated) {
      throw new PiAdapterError(
        "session_invalidated",
        "Pi session runtime was invalidated before replacement completed",
      );
    }
  }

  #onSessionEvent(event: AgentSessionEvent): void {
    for (const listener of this.#rpcEventListeners) listener(event);
    const mapped = mapPiEvent(event);
    if (mapped !== undefined) this.#eventSink?.(mapped);
  }
}

export class PiAdapterError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "PiAdapterError";
    this.code = code;
  }
}

class LockedResourceLoader implements ResourceLoader {
  readonly #systemPrompt: string | undefined;
  readonly #extensions = {
    extensions: [],
    errors: [],
    runtime: createExtensionRuntime(),
  };

  constructor(systemPrompt: string | undefined) {
    this.#systemPrompt = systemPrompt;
  }

  getExtensions(): ReturnType<ResourceLoader["getExtensions"]> {
    return this.#extensions;
  }

  getSkills(): ReturnType<ResourceLoader["getSkills"]> {
    return { skills: [], diagnostics: [] };
  }

  getPrompts(): ReturnType<ResourceLoader["getPrompts"]> {
    return { prompts: [], diagnostics: [] };
  }

  getThemes(): ReturnType<ResourceLoader["getThemes"]> {
    return { themes: [], diagnostics: [] };
  }

  getAgentsFiles(): ReturnType<ResourceLoader["getAgentsFiles"]> {
    return { agentsFiles: [] };
  }

  getSystemPrompt(): string | undefined {
    return this.#systemPrompt;
  }

  getAppendSystemPrompt(): string[] {
    return [];
  }

  extendResources(paths: Parameters<ResourceLoader["extendResources"]>[0]): void {
    const attempted = paths.skillPaths?.length || paths.promptPaths?.length || paths.themePaths?.length;
    if (attempted) {
      throw new PiAdapterError(
        "resource_extension_refused",
        "shared no-tools sessions cannot extend resource paths",
      );
    }
  }

  async reload(): Promise<void> {}
}

function legacyServices(
  cwd: string,
  agentDir: string,
  authStorage: AuthStorage,
  modelRegistry: ModelRegistry,
  settingsManager: SettingsManager,
  systemPrompt: string | undefined,
): AgentSessionServices {
  return {
    cwd,
    agentDir,
    authStorage,
    modelRegistry,
    settingsManager,
    resourceLoader: new LockedResourceLoader(systemPrompt),
    diagnostics: [],
  };
}

function resourceLoaderOptions(
  spec: PreparedSessionRuntimeOptions["persistedSpec"],
): NonNullable<Parameters<typeof createAgentSessionServices>[0]["resourceLoaderOptions"]> {
  const resources = spec.resources;
  const approved = resources?.projectTrust === "approve";
  const extensions = resources?.extensions ?? [];
  const skills = resources?.skills ?? [];
  const prompts = resources?.promptTemplates ?? [];
  const themes = resources?.themes ?? [];
  return {
    additionalExtensionPaths: [...extensions],
    additionalSkillPaths: [...skills],
    additionalPromptTemplatePaths: [...prompts],
    additionalThemePaths: [...themes],
    noExtensions: resources?.noExtensions === true || (!approved && extensions.length === 0),
    noSkills: resources?.noSkills === true || (!approved && skills.length === 0),
    noPromptTemplates:
      resources?.noPromptTemplates === true || (!approved && prompts.length === 0),
    noThemes: resources?.noThemes === true || (!approved && themes.length === 0),
    noContextFiles: resources?.noContextFiles === true || !approved,
    ...(resources?.systemPrompt === undefined ? {} : { systemPrompt: resources.systemPrompt }),
    ...(resources?.appendSystemPrompt === undefined
      ? {}
      : { appendSystemPrompt: [...resources.appendSystemPrompt] }),
  };
}

function scopedAuthStorage(
  base: AuthStorage,
  runtimeOptions: PreparedSessionRuntimeOptions | undefined,
): AuthStorage {
  if (runtimeOptions === undefined || Object.keys(runtimeOptions.environmentOverlay).length === 0) {
    return base;
  }
  const scoped = AuthStorage.inMemory(base.getAll());
  const provider = runtimeOptions.persistedSpec.model?.provider;
  if (provider === undefined) return scoped;
  const environment = { ...runtimeOptions.environmentOverlay };
  const apiKey = providerApiKeyFromEnvironment(provider, runtimeOptions.environmentOverlay);
  const existing = scoped.get(provider);
  if (apiKey !== undefined) {
    scoped.set(provider, { type: "api_key", key: apiKey, env: environment });
  } else if (existing?.type === "api_key") {
    scoped.set(provider, {
      ...existing,
      env: { ...(existing.env ?? {}), ...environment },
    });
  }
  return scoped;
}

function configuredRpcControllerOptions(
  base: PiRpcControllerOptions,
  runtimeOptions: PreparedSessionRuntimeOptions | undefined,
): PiRpcControllerOptions {
  if (
    base.executeBash !== undefined ||
    runtimeOptions === undefined ||
    !configuredBashEnabled(runtimeOptions.persistedSpec)
  ) {
    return { ...base };
  }
  const environment = { ...runtimeOptions.environmentOverlay };
  return {
    ...base,
    executeBash: async (session, command, excludeFromContext) => {
      const shellPath = session.settingsManager.getShellPath();
      const local = createLocalBashOperations(
        shellPath === undefined ? undefined : { shellPath },
      );
      const operations: BashOperations = {
        exec: (requestedCommand, cwd, options) =>
          local.exec(requestedCommand, cwd, {
            ...options,
            env: { ...process.env, ...(options.env ?? {}), ...environment },
          }),
      };
      return session.executeBash(command, undefined, {
        ...(excludeFromContext === undefined ? {} : { excludeFromContext }),
        operations,
      });
    },
  };
}

function environmentToolOverrides(
  cwd: string,
  environment: Readonly<Record<string, string>>,
  spec: PreparedSessionRuntimeOptions["persistedSpec"],
): ToolDefinition[] {
  if (Object.keys(environment).length === 0 || !configuredBashEnabled(spec)) return [];
  const bash = createBashTool(cwd, {
    spawnHook: (context) => ({
      ...context,
      env: { ...context.env, ...environment },
    }),
  });
  return [
    {
      ...bash,
      label: "bash",
      promptSnippet: "Execute shell commands in the configured session environment",
      promptGuidelines: [
        "Use bash for shell commands; the daemon applies the session-scoped environment only to the child process.",
      ],
    } as unknown as ToolDefinition,
  ];
}

function configuredBashEnabled(spec: PreparedSessionRuntimeOptions["persistedSpec"]): boolean {
  const tools = spec.tools;
  const excluded = tools?.exclude?.includes("bash") ?? false;
  if (excluded) return false;
  switch (tools?.mode ?? "default") {
    case "default":
      return true;
    case "none":
    case "no-builtin":
      return false;
    case "allowlist":
      return tools?.include?.includes("bash") ?? false;
  }
}

function validateSessionRoot(sessionRoot: string, cwd: string, agentRoot: string): void {
  if (
    isWithin(cwd, sessionRoot) ||
    isWithin(sessionRoot, cwd) ||
    isWithin(agentRoot, sessionRoot) ||
    isWithin(sessionRoot, agentRoot)
  ) {
    throw new PiAdapterError(
      "authority_root_overlap",
      "Pi session storage must not overlap the workload or credential roots",
    );
  }
}

async function materializeSessionManager(
  sessionManager: SessionManager,
  cwd: string,
): Promise<SessionManager> {
  if (!sessionManager.isPersisted()) return sessionManager;
  const sessionFile = sessionManager.getSessionFile();
  const header = sessionManager.getHeader();
  if (sessionFile === undefined || header === null) {
    throw new PiAdapterError(
      "session_identity_missing",
      "persisted Pi session is missing its file or header identity",
    );
  }

  let exists = false;
  try {
    const info = await lstat(sessionFile);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new PiAdapterError(
        "insecure_session_path",
        "Pi session path must be a regular non-symlink file",
      );
    }
    const getuid = process.getuid;
    if (getuid !== undefined && info.uid !== getuid()) {
      throw new PiAdapterError(
        "insecure_session_path",
        "Pi session file must be owned by the current user",
      );
    }
    exists = true;
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") throw error;
  }
  if (!exists) {
    const entries = [header, ...sessionManager.getEntries()];
    const handle = await open(sessionFile, "wx", 0o600);
    try {
      await handle.writeFile(`${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
  await chmod(sessionFile, 0o600);

  const reopened = SessionManager.open(sessionFile, sessionManager.getSessionDir(), cwd);
  if (reopened.getSessionId() !== sessionManager.getSessionId()) {
    throw new PiAdapterError(
      "session_identity_mismatch",
      "materialized Pi session identity does not match the requested conversation",
    );
  }
  return reopened;
}

async function createSessionManager(
  request: SessionOpenRequest,
  cwd: string,
  sessionDir: string,
): Promise<SessionManager> {
  const target = request.runtimeOptions?.persistedSpec.target ?? request.session;
  if (target === undefined) {
    throw new PiAdapterError("session_target_required", "session target is required");
  }
  switch (target.mode) {
    case "memory":
      return SessionManager.inMemory(cwd);
    case "new":
      return SessionManager.create(cwd, sessionDir);
    case "continue":
      return SessionManager.continueRecent(cwd, sessionDir);
    case "open": {
      const configuredPath = target.path;
      if (configuredPath === undefined) {
        throw new PiAdapterError("session_path_required", "open mode requires a session path");
      }
      const path = await realpath(
        isAbsolute(configuredPath) ? configuredPath : join(sessionDir, configuredPath),
      );
      if (!isWithin(sessionDir, path)) {
        throw new PiAdapterError(
          "session_path_outside_state",
          "session path must be inside the configured session directory",
        );
      }
      return SessionManager.open(path, sessionDir, cwd);
    }
    case "fork": {
      const source = request.runtimeOptions?.resolvedSourceSessionPath;
      if (source === undefined) {
        throw new PiAdapterError(
          "session_target_unresolved",
          "fork sourceSession must resolve to a retained Pi session path before open",
        );
      }
      return SessionManager.forkFrom(await realpath(source), cwd, sessionDir);
    }
  }
}

async function validateRuntimeCwd(
  candidate: string,
  stateRoot: string,
  agentRoots: string[],
  allowedRoots: string[],
): Promise<string> {
  const cwd = await realpath(candidate);
  if (!(await stat(cwd)).isDirectory()) {
    throw new PiAdapterError("cwd_not_directory", "logical session cwd must be a directory");
  }
  if (!allowedRoots.some((root) => isWithin(root, cwd))) {
    throw new PiAdapterError("cwd_not_allowed", "logical session cwd is outside allowed roots");
  }
  if (
    isWithin(cwd, stateRoot) ||
    isWithin(stateRoot, cwd) ||
    agentRoots.some((agentRoot) => isWithin(cwd, agentRoot) || isWithin(agentRoot, cwd))
  ) {
    throw new PiAdapterError(
      "authority_root_overlap",
      "logical session cwd must not overlap daemon state or Pi credential roots",
    );
  }
  return cwd;
}

function validatePrivateAuthFile(path: string): void {
  let info;
  try {
    info = lstatSync(path);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return;
    throw error;
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new PiAdapterError("insecure_auth_path", "Pi auth storage must be a regular file");
  }
  const getuid = process.getuid;
  if (getuid !== undefined && info.uid !== getuid()) {
    throw new PiAdapterError("insecure_auth_path", "Pi auth storage must be owned by current user");
  }
  if ((info.mode & 0o077) !== 0) {
    throw new PiAdapterError("insecure_auth_path", "Pi auth storage must be owner-only");
  }
}

function isWithin(root: string, path: string): boolean {
  const child = relative(resolve(root), resolve(path));
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function mapPiEvent(event: AgentSessionEvent): AdapterEvent | undefined {
  switch (event.type) {
    case "message_start":
      return { event: "messageStart", data: { message: event.message } };
    case "message_update":
      return {
        event: "messageUpdate",
        data: { assistantMessageEvent: event.assistantMessageEvent },
      };
    case "message_end":
      return { event: "messageEnd", data: { message: event.message } };
    case "tool_execution_start":
      return {
        event: "toolStart",
        data: {
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args: event.args,
        },
      };
    case "tool_execution_update":
      return {
        event: "toolUpdate",
        data: {
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          partialResult: event.partialResult,
        },
      };
    case "tool_execution_end":
      return {
        event: "toolEnd",
        data: {
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          result: event.result,
          isError: event.isError,
        },
      };
    case "turn_start":
      return { event: "turnStart" };
    case "turn_end":
      return {
        event: "turnEnd",
        data: { message: event.message, toolResults: event.toolResults },
      };
    case "queue_update":
      return {
        event: "queueUpdate",
        data: { steering: [...event.steering], followUp: [...event.followUp] },
      };
    case "compaction_start":
      return { event: "compactionStart", data: { reason: event.reason } };
    case "compaction_end":
      return {
        event: "compactionEnd",
        data: {
          reason: event.reason,
          aborted: event.aborted,
          willRetry: event.willRetry,
          errorMessage: event.errorMessage,
        },
      };
    case "auto_retry_start":
      return {
        event: "autoRetryStart",
        data: {
          attempt: event.attempt,
          maxAttempts: event.maxAttempts,
          delayMs: event.delayMs,
          errorMessage: event.errorMessage,
        },
      };
    case "auto_retry_end":
      return {
        event: "autoRetryEnd",
        data: {
          success: event.success,
          attempt: event.attempt,
          finalError: event.finalError,
        },
      };
    case "entry_appended":
      return { event: "entryAppended", data: { entry: event.entry } };
    case "session_info_changed":
      return { event: "sessionInfoChanged", data: { name: event.name } };
    case "thinking_level_changed":
      return { event: "thinkingLevelChanged", data: { level: event.level } };
    case "agent_settled":
      return { event: "agentSettled" };
    case "agent_start":
    case "agent_end":
      return undefined;
  }
}
