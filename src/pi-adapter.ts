import { mkdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

import {
  AuthStorage,
  createAgentSession,
  createExtensionRuntime,
  getAgentDir,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type AgentSessionEvent,
  type CreateAgentSessionOptions,
  type CreateAgentSessionResult,
  type ResourceLoader,
} from "@earendil-works/pi-coding-agent";

import { encodedSessionId } from "./durability.js";
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
  authStorage?: AuthStorage;
  modelRegistry?: ModelRegistry;
  createSession?: (options: CreateAgentSessionOptions) => Promise<CreateAgentSessionResult>;
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
  readonly #createSession: (
    options: CreateAgentSessionOptions,
  ) => Promise<CreateAgentSessionResult>;

  constructor(options: PiSessionFactoryOptions) {
    if (options.stateDir.length === 0) throw new Error("stateDir must not be empty");
    this.#stateDir = resolve(options.stateDir);
    this.agentDir = resolve(options.agentDir ?? getAgentDir());
    this.authStorage = options.authStorage ?? AuthStorage.create(join(this.agentDir, "auth.json"));
    this.modelRegistry =
      options.modelRegistry ??
      ModelRegistry.create(this.authStorage, join(this.agentDir, "models.json"));
    this.#createSession = options.createSession ?? createAgentSession;
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
    const cwd = await realpath(request.cwd);
    if (request.agentDir !== undefined && resolve(request.agentDir) !== this.agentDir) {
      throw new PiAdapterError(
        "agent_dir_mismatch",
        "logical sessions cannot override the shared host agentDir",
      );
    }

    const sessionDir = join(
      this.#stateDir,
      "sessions",
      encodedSessionId(request.sessionId),
      "pi",
    );
    await mkdir(sessionDir, { recursive: true, mode: 0o700 });
    const sessionManager = await createSessionManager(request, cwd, sessionDir);
    const settingsManager = SettingsManager.inMemory();
    const resourceLoader = new LockedResourceLoader(request.resources?.systemPrompt);

    const requestedModel = request.model;
    const model =
      requestedModel === undefined
        ? this.modelRegistry.getAvailable()[0]
        : this.modelRegistry.find(requestedModel.provider, requestedModel.id);
    if (model === undefined) {
      throw new PiAdapterError(
        "model_unavailable",
        requestedModel === undefined
          ? "no authenticated Pi model is available"
          : `Pi model is unavailable: ${requestedModel.provider}/${requestedModel.id}`,
      );
    }
    if (!this.modelRegistry.hasConfiguredAuth(model)) {
      throw new PiAdapterError(
        "model_auth_unavailable",
        `authentication is not configured for provider: ${model.provider}`,
      );
    }

    const result = await this.#createSession({
      cwd,
      agentDir: this.agentDir,
      authStorage: this.authStorage,
      modelRegistry: this.modelRegistry,
      model,
      ...(request.model?.thinkingLevel === undefined
        ? {}
        : { thinkingLevel: request.model.thinkingLevel }),
      noTools: "all",
      tools: [],
      customTools: [],
      resourceLoader,
      sessionManager,
      settingsManager,
    });
    if (result.session.getActiveToolNames().length !== 0) {
      result.session.dispose();
      throw new PiAdapterError(
        "unsafe_tool_profile",
        "Pi SDK enabled tools despite the no-tools resource policy",
      );
    }
    return new PiSessionAdapter(result.session);
  }
}

export class PiSessionAdapter implements SessionAdapter {
  readonly #session: AgentSession;
  readonly #unsubscribe: () => void;
  #eventSink: ((event: AdapterEvent) => void) | undefined;
  #disposed = false;

  constructor(session: AgentSession) {
    this.#session = session;
    this.#unsubscribe = session.subscribe((event) => this.#onSessionEvent(event));
  }

  async prompt(request: PromptRequest): Promise<unknown> {
    this.#assertOpen();
    this.#eventSink = request.onEvent;
    try {
      await this.#session.prompt(request.prompt, {
        expandPromptTemplates: false,
        source: "rpc",
        preflightResult: (accepted) => {
          if (!accepted) request.onEvent({ event: "preflightRejected" });
        },
      });
      return {
        text: this.#session.getLastAssistantText(),
        sessionId: this.#session.sessionId,
        sessionFile: this.#session.sessionFile,
        model:
          this.#session.model === undefined
            ? undefined
            : { provider: this.#session.model.provider, id: this.#session.model.id },
        thinkingLevel: this.#session.thinkingLevel,
      };
    } finally {
      if (this.#eventSink === request.onEvent) this.#eventSink = undefined;
    }
  }

  async steer(message: string): Promise<void> {
    this.#assertOpen();
    await this.#session.steer(message);
  }

  async followUp(message: string): Promise<void> {
    this.#assertOpen();
    await this.#session.followUp(message);
  }

  async abort(): Promise<void> {
    this.#assertOpen();
    await this.#session.abort();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#unsubscribe();
    this.#session.dispose();
  }

  #assertOpen(): void {
    if (this.#disposed) throw new PiAdapterError("session_disposed", "Pi session is disposed");
  }

  #onSessionEvent(event: AgentSessionEvent): void {
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

async function createSessionManager(
  request: SessionOpenRequest,
  cwd: string,
  sessionDir: string,
): Promise<SessionManager> {
  switch (request.session.mode) {
    case "memory":
      return SessionManager.inMemory(cwd);
    case "new":
      return SessionManager.create(cwd, sessionDir);
    case "continue":
      return SessionManager.continueRecent(cwd, sessionDir);
    case "open": {
      const configuredPath = request.session.path;
      if (configuredPath === undefined) {
        throw new PiAdapterError("session_path_required", "open mode requires a session path");
      }
      const path = await realpath(
        isAbsolute(configuredPath) ? configuredPath : join(sessionDir, configuredPath),
      );
      if (!isWithin(sessionDir, path)) {
        throw new PiAdapterError(
          "session_path_outside_state",
          "session path must be inside the logical session's state directory",
        );
      }
      return SessionManager.open(path, sessionDir, cwd);
    }
  }
}

function isWithin(root: string, path: string): boolean {
  const child = relative(resolve(root), resolve(path));
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
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
    case "session_info_changed":
      return { event: "sessionInfoChanged", data: { name: event.name } };
    case "thinking_level_changed":
      return { event: "thinkingLevelChanged", data: { level: event.level } };
    case "agent_start":
    case "agent_end":
      return undefined;
  }
}
