import { randomUUID } from "node:crypto";

import {
  Theme,
  type AgentSession,
  type AgentSessionEvent,
  type ExtensionUIContext,
  type RpcCommand,
  type RpcExtensionUIRequest,
  type RpcExtensionUIResponse,
  type RpcResponse,
} from "@earendil-works/pi-coding-agent";

import { PI_SDK_COMPATIBILITY_VERSION } from "./pi-sdk-contract.js";
import { PI_RPC_COMMAND_TYPES } from "./session-api.js";

export interface PiRpcRuntimeHost {
  rpcSession(): AgentSession;
  subscribeRpcEvents(listener: (event: AgentSessionEvent) => void): () => void;
  setRpcExtensionBindingsFactory(
    factory: () => Parameters<AgentSession["bindExtensions"]>[0],
  ): Promise<void>;
  newSession(parentSession?: string): Promise<{ cancelled: boolean }>;
  switchSession(sessionPath: string): Promise<{ cancelled: boolean }>;
  fork(
    entryId: string,
    position?: "before" | "at",
  ): Promise<{ cancelled: boolean; selectedText?: string }>;
  setRpcSessionName(name: string): Promise<void>;
}

export type PiRpcControllerOutput =
  | AgentSessionEvent
  | RpcExtensionUIRequest
  | {
      type: "extension_error";
      extensionPath: string;
      event: string;
      error: string;
    }
  | { type: "extension_shutdown_requested" };

export interface PiRpcControllerOptions {
  maxPendingUiRequests?: number;
  maxOutputListeners?: number;
  executeBash?: (
    session: AgentSession,
    command: string,
    excludeFromContext: boolean | undefined,
  ) => Promise<unknown>;
  exportHtml?: (session: AgentSession, outputPath: string | undefined) => Promise<string>;
}

type RpcUiRequestPayload = RpcExtensionUIRequest extends infer Request
  ? Request extends { type: "extension_ui_request"; id: string }
    ? Omit<Request, "type" | "id">
    : never
  : never;

interface PendingUiRequest {
  resolve: (response: RpcExtensionUIResponse) => void;
  cancel: () => void;
}

const DEFAULT_MAX_PENDING_UI_REQUESTS = 32;
const DEFAULT_MAX_OUTPUT_LISTENERS = 64;

export const PI_RPC_HOST_CAPABILITIES = {
  sdkVersion: PI_SDK_COMPATIBILITY_VERSION,
  commandTypes: PI_RPC_COMMAND_TYPES,
  rawSessionEvents: true,
  extensionUi: true,
  processTransportOwned: false,
  policyGatedCommands: ["bash", "abort_bash", "export_html"],
} as const;

export interface PiRpcSnapshot {
  rpcState: Record<string, unknown>;
  leafId: string | null;
}

export interface PiRpcControllerCapabilities {
  contract: typeof PI_RPC_HOST_CAPABILITIES;
  policy: { bash: boolean; exportHtml: boolean };
  maxPendingUiRequests: number;
  maxOutputListeners: number;
}

/**
 * Transport-neutral implementation of Pi 0.80.6's stock RPC command semantics.
 *
 * It deliberately does not own stdin/stdout, process signals, process.exit, or
 * socket framing. Callers attach outputs and carry responses over any bounded
 * authenticated transport.
 */
export class PiRpcController {
  readonly #host: PiRpcRuntimeHost;
  readonly #maxPendingUiRequests: number;
  readonly #maxOutputListeners: number;
  readonly #executeBash: PiRpcControllerOptions["executeBash"];
  readonly #exportHtml: PiRpcControllerOptions["exportHtml"];
  readonly #listeners = new Set<(output: PiRpcControllerOutput) => void>();
  readonly #pendingUi = new Map<string, PendingUiRequest>();
  #unsubscribeEvents: (() => void) | undefined;
  #disposed = false;

  private constructor(host: PiRpcRuntimeHost, options: PiRpcControllerOptions) {
    this.#host = host;
    this.#maxPendingUiRequests = positiveInteger(
      options.maxPendingUiRequests ?? DEFAULT_MAX_PENDING_UI_REQUESTS,
      "maxPendingUiRequests",
    );
    this.#maxOutputListeners = positiveInteger(
      options.maxOutputListeners ?? DEFAULT_MAX_OUTPUT_LISTENERS,
      "maxOutputListeners",
    );
    this.#executeBash = options.executeBash;
    this.#exportHtml = options.exportHtml;
  }

  static async create(
    host: PiRpcRuntimeHost,
    options: PiRpcControllerOptions = {},
  ): Promise<PiRpcController> {
    const controller = new PiRpcController(host, options);
    controller.#unsubscribeEvents = host.subscribeRpcEvents((event) => controller.#emit(event));
    await host.setRpcExtensionBindingsFactory(() => controller.#extensionBindings());
    return controller;
  }

  get capabilities(): PiRpcControllerCapabilities {
    return {
      contract: PI_RPC_HOST_CAPABILITIES,
      policy: {
        bash: this.#executeBash !== undefined,
        exportHtml: this.#exportHtml !== undefined,
      },
      maxPendingUiRequests: this.#maxPendingUiRequests,
      maxOutputListeners: this.#maxOutputListeners,
    };
  }

  subscribe(listener: (output: PiRpcControllerOutput) => void): () => void {
    this.#assertOpen();
    if (this.#listeners.size >= this.#maxOutputListeners) {
      throw new Error("Pi RPC output listener capacity reached");
    }
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  respondToExtensionUi(response: RpcExtensionUIResponse): boolean {
    this.#assertOpen();
    const pending = this.#pendingUi.get(response.id);
    if (pending === undefined) return false;
    this.#pendingUi.delete(response.id);
    pending.resolve(response);
    return true;
  }

  /** Cancel every pending dialog when the explicit transport controller leaves. */
  cancelPendingUi(): void {
    this.#assertOpen();
    for (const pending of this.#pendingUi.values()) pending.cancel();
    this.#pendingUi.clear();
  }

  /** Capture state and leaf synchronously in the controller event-loop boundary. */
  snapshot(): PiRpcSnapshot {
    this.#assertOpen();
    const session = this.#host.rpcSession();
    return {
      rpcState: {
        model: session.model,
        thinkingLevel: session.thinkingLevel,
        isStreaming: session.isStreaming,
        isCompacting: session.isCompacting,
        steeringMode: session.steeringMode,
        followUpMode: session.followUpMode,
        sessionFile: session.sessionFile,
        sessionId: session.sessionId,
        sessionName: session.sessionName,
        autoCompactionEnabled: session.autoCompactionEnabled,
        messageCount: session.messages.length,
        pendingMessageCount: session.pendingMessageCount,
      },
      leafId: session.sessionManager.getLeafId(),
    };
  }

  async handle(value: unknown): Promise<RpcResponse> {
    this.#assertOpen();
    let command: RpcCommand;
    try {
      command = parsePiRpcCommand(value);
    } catch (error) {
      return failure(extractRpcId(value), extractRpcType(value), safeRpcError(error));
    }
    const id = command.id;
    try {
      const session = this.#host.rpcSession();
      switch (command.type) {
        case "prompt":
          return await this.#prompt(session, command);
        case "steer":
          await session.steer(command.message, command.images);
          return success(id, "steer");
        case "follow_up":
          await session.followUp(command.message, command.images);
          return success(id, "follow_up");
        case "abort":
          await session.abort();
          return success(id, "abort");
        case "new_session":
          return success(
            id,
            "new_session",
            await this.#host.newSession(command.parentSession),
          );
        case "get_state":
          return success(id, "get_state", this.snapshot().rpcState);
        case "set_model": {
          const models = await session.modelRegistry.getAvailable();
          const model = models.find(
            (candidate) =>
              candidate.provider === command.provider && candidate.id === command.modelId,
          );
          if (model === undefined) {
            return failure(
              id,
              "set_model",
              `Model not found: ${command.provider}/${command.modelId}`,
            );
          }
          await session.setModel(model);
          return success(id, "set_model", model);
        }
        case "cycle_model":
          return success(id, "cycle_model", (await session.cycleModel()) ?? null);
        case "get_available_models":
          return success(id, "get_available_models", {
            models: await session.modelRegistry.getAvailable(),
          });
        case "set_thinking_level":
          session.setThinkingLevel(command.level);
          return success(id, "set_thinking_level");
        case "cycle_thinking_level": {
          const level = session.cycleThinkingLevel();
          return success(id, "cycle_thinking_level", level === undefined ? null : { level });
        }
        case "set_steering_mode":
          session.setSteeringMode(command.mode);
          return success(id, "set_steering_mode");
        case "set_follow_up_mode":
          session.setFollowUpMode(command.mode);
          return success(id, "set_follow_up_mode");
        case "compact":
          return success(id, "compact", await session.compact(command.customInstructions));
        case "set_auto_compaction":
          session.setAutoCompactionEnabled(command.enabled);
          return success(id, "set_auto_compaction");
        case "set_auto_retry":
          session.setAutoRetryEnabled(command.enabled);
          return success(id, "set_auto_retry");
        case "abort_retry":
          session.abortRetry();
          return success(id, "abort_retry");
        case "bash":
          if (this.#executeBash === undefined) {
            return failure(id, "bash", "Bash is disabled by this session policy");
          }
          return success(
            id,
            "bash",
            await this.#executeBash(session, command.command, command.excludeFromContext),
          );
        case "abort_bash":
          if (this.#executeBash === undefined) {
            return failure(id, "abort_bash", "Bash is disabled by this session policy");
          }
          session.abortBash();
          return success(id, "abort_bash");
        case "get_session_stats":
          return success(id, "get_session_stats", session.getSessionStats());
        case "export_html":
          if (this.#exportHtml === undefined) {
            return failure(id, "export_html", "HTML export is disabled by this session policy");
          }
          return success(id, "export_html", {
            path: await this.#exportHtml(session, command.outputPath),
          });
        case "switch_session":
          return success(
            id,
            "switch_session",
            await this.#host.switchSession(command.sessionPath),
          );
        case "fork": {
          const result = await this.#host.fork(command.entryId, "before");
          return success(id, "fork", {
            text: result.selectedText ?? "",
            cancelled: result.cancelled,
          });
        }
        case "clone": {
          const leafId = session.sessionManager.getLeafId();
          if (leafId === null) {
            return failure(id, "clone", "Cannot clone session: no current entry selected");
          }
          const result = await this.#host.fork(leafId, "at");
          return success(id, "clone", { cancelled: result.cancelled });
        }
        case "get_fork_messages":
          return success(id, "get_fork_messages", {
            messages: session.getUserMessagesForForking(),
          });
        case "get_entries": {
          const manager = session.sessionManager;
          let entries = manager.getEntries();
          if (command.since !== undefined) {
            const index = entries.findIndex((entry) => entry.id === command.since);
            if (index < 0) {
              return failure(id, "get_entries", `Entry not found: ${command.since}`);
            }
            entries = entries.slice(index + 1);
          }
          return success(id, "get_entries", { entries, leafId: manager.getLeafId() });
        }
        case "get_tree":
          return success(id, "get_tree", {
            tree: session.sessionManager.getTree(),
            leafId: session.sessionManager.getLeafId(),
          });
        case "get_last_assistant_text":
          return success(id, "get_last_assistant_text", {
            text: session.getLastAssistantText() ?? null,
          });
        case "set_session_name": {
          const name = command.name.trim();
          if (name.length === 0) {
            return failure(id, "set_session_name", "Session name cannot be empty");
          }
          await this.#host.setRpcSessionName(name);
          return success(id, "set_session_name");
        }
        case "get_messages":
          return success(id, "get_messages", { messages: session.messages });
        case "get_commands":
          return success(id, "get_commands", { commands: availableCommands(session) });
      }
    } catch (error) {
      return failure(id, command.type, safeRpcError(error));
    }
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#unsubscribeEvents?.();
    this.#unsubscribeEvents = undefined;
    for (const pending of this.#pendingUi.values()) pending.cancel();
    this.#pendingUi.clear();
    this.#listeners.clear();
  }

  #prompt(session: AgentSession, command: Extract<RpcCommand, { type: "prompt" }>): Promise<RpcResponse> {
    return new Promise<RpcResponse>((resolve) => {
      let responded = false;
      const complete = (response: RpcResponse): void => {
        if (responded) return;
        responded = true;
        resolve(response);
      };
      void session
        .prompt(command.message, {
          ...(command.images === undefined ? {} : { images: command.images }),
          ...(command.streamingBehavior === undefined
            ? {}
            : { streamingBehavior: command.streamingBehavior }),
          source: "rpc",
          preflightResult: (accepted) => {
            if (accepted) complete(success(command.id, "prompt"));
          },
        })
        .then(() => complete(success(command.id, "prompt")))
        .catch((error) => complete(failure(command.id, "prompt", safeRpcError(error))));
    });
  }

  #extensionBindings(): Parameters<AgentSession["bindExtensions"]>[0] {
    return {
      uiContext: this.#extensionUiContext(),
      mode: "rpc",
      commandContextActions: {
        waitForIdle: () => this.#host.rpcSession().waitForIdle(),
        newSession: async (options) => this.#host.newSession(options?.parentSession),
        fork: async (entryId, options) => {
          const result = await this.#host.fork(entryId, options?.position);
          return { cancelled: result.cancelled };
        },
        navigateTree: async (targetId, options) => {
          const result = await this.#host.rpcSession().navigateTree(targetId, options);
          return { cancelled: result.cancelled };
        },
        switchSession: async (sessionPath) => this.#host.switchSession(sessionPath),
        reload: async () => this.#host.rpcSession().reload(),
      },
      shutdownHandler: () => this.#emit({ type: "extension_shutdown_requested" }),
      onError: (error) =>
        this.#emit({
          type: "extension_error",
          extensionPath: error.extensionPath,
          event: error.event,
          error: safeRpcError(error.error),
        }),
    };
  }

  #extensionUiContext(): ExtensionUIContext {
    const controller = this;
    return {
      select: (title, options, settings) =>
        controller.#dialog(
          {
            method: "select",
            title,
            options,
            ...(settings?.timeout === undefined ? {} : { timeout: settings.timeout }),
          },
          undefined,
          (response) => ("value" in response ? response.value : undefined),
          settings,
        ),
      confirm: (title, message, settings) =>
        controller.#dialog(
          {
            method: "confirm",
            title,
            message,
            ...(settings?.timeout === undefined ? {} : { timeout: settings.timeout }),
          },
          false,
          (response) => ("confirmed" in response ? response.confirmed : false),
          settings,
        ),
      input: (title, placeholder, settings) =>
        controller.#dialog(
          {
            method: "input",
            title,
            ...(placeholder === undefined ? {} : { placeholder }),
            ...(settings?.timeout === undefined ? {} : { timeout: settings.timeout }),
          },
          undefined,
          (response) => ("value" in response ? response.value : undefined),
          settings,
        ),
      editor: (title, prefill) =>
        controller.#dialog(
          { method: "editor", title, ...(prefill === undefined ? {} : { prefill }) },
          undefined,
          (response) => ("value" in response ? response.value : undefined),
        ),
      notify(message, notifyType) {
        controller.#emitUi({
          method: "notify",
          message,
          ...(notifyType === undefined ? {} : { notifyType }),
        });
      },
      onTerminalInput() {
        return () => {};
      },
      setStatus(statusKey, statusText) {
        controller.#emitUi({ method: "setStatus", statusKey, statusText });
      },
      setWorkingMessage() {},
      setWorkingVisible() {},
      setWorkingIndicator() {},
      setHiddenThinkingLabel() {},
      setWidget(widgetKey, content, options) {
        if (content === undefined || Array.isArray(content)) {
          controller.#emitUi({
            method: "setWidget",
            widgetKey,
            widgetLines: content,
            ...(options?.placement === undefined
              ? {}
              : { widgetPlacement: options.placement }),
          });
        }
      },
      setFooter() {},
      setHeader() {},
      setTitle(title) {
        controller.#emitUi({ method: "setTitle", title });
      },
      async custom<T>() {
        return undefined as T;
      },
      pasteToEditor(text) {
        controller.#emitUi({ method: "set_editor_text", text });
      },
      setEditorText(text) {
        controller.#emitUi({ method: "set_editor_text", text });
      },
      getEditorText() {
        return "";
      },
      addAutocompleteProvider() {},
      setEditorComponent() {},
      getEditorComponent() {
        return undefined;
      },
      get theme() {
        return HEADLESS_RPC_THEME;
      },
      getAllThemes() {
        return [];
      },
      getTheme() {
        return undefined;
      },
      setTheme() {
        return { success: false, error: "Theme switching is not supported by RPC" };
      },
      getToolsExpanded() {
        return false;
      },
      setToolsExpanded() {},
    };
  }

  #dialog<T>(
    request: RpcUiRequestPayload,
    fallback: T,
    parse: (response: RpcExtensionUIResponse) => T,
    options?: { signal?: AbortSignal; timeout?: number },
  ): Promise<T> {
    if (options?.signal?.aborted || this.#pendingUi.size >= this.#maxPendingUiRequests) {
      return Promise.resolve(fallback);
    }
    const id = randomUUID();
    return new Promise<T>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (value: T): void => {
        if (timer !== undefined) clearTimeout(timer);
        options?.signal?.removeEventListener("abort", cancel);
        this.#pendingUi.delete(id);
        resolve(value);
      };
      const cancel = (): void => finish(fallback);
      if (options?.timeout !== undefined && options.timeout > 0) {
        timer = setTimeout(cancel, options.timeout);
        timer.unref();
      }
      options?.signal?.addEventListener("abort", cancel, { once: true });
      this.#pendingUi.set(id, {
        resolve: (response) => finish(parse(response)),
        cancel,
      });
      this.#emit({ type: "extension_ui_request", id, ...request } as RpcExtensionUIRequest);
    });
  }

  #emitUi(request: RpcUiRequestPayload): void {
    this.#emit({ type: "extension_ui_request", id: randomUUID(), ...request } as RpcExtensionUIRequest);
  }

  #emit(output: PiRpcControllerOutput): void {
    if (this.#disposed) return;
    for (const listener of this.#listeners) {
      try {
        listener(output);
      } catch {
        // One transport reader must not break the hosted Pi runtime or other readers.
      }
    }
  }

  #assertOpen(): void {
    if (this.#disposed) throw new Error("Pi RPC controller is disposed");
  }
}

export class PiRpcValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PiRpcValidationError";
  }
}

export function parsePiRpcCommand(value: unknown): RpcCommand {
  if (!isRecord(value)) throw new PiRpcValidationError("RPC command must be an object");
  optionalBoundedString(value, "id", 256);
  const type = requiredBoundedString(value, "type", 128);
  if (!(PI_RPC_COMMAND_TYPES as readonly string[]).includes(type)) {
    throw new PiRpcValidationError(`Unknown command: ${type}`);
  }
  switch (type as RpcCommand["type"]) {
    case "prompt":
      requiredBoundedString(value, "message", 1024 * 1024);
      optionalImages(value.images);
      optionalEnum(value, "streamingBehavior", ["steer", "followUp"]);
      break;
    case "steer":
    case "follow_up":
      requiredBoundedString(value, "message", 1024 * 1024);
      optionalImages(value.images);
      break;
    case "new_session":
      optionalBoundedString(value, "parentSession", 4096);
      break;
    case "set_model":
      requiredBoundedString(value, "provider", 256);
      requiredBoundedString(value, "modelId", 512);
      break;
    case "set_thinking_level":
      requiredEnum(value, "level", ["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
      break;
    case "set_steering_mode":
    case "set_follow_up_mode":
      requiredEnum(value, "mode", ["all", "one-at-a-time"]);
      break;
    case "compact":
      optionalBoundedString(value, "customInstructions", 1024 * 1024);
      break;
    case "set_auto_compaction":
    case "set_auto_retry":
      requiredBoolean(value, "enabled");
      break;
    case "bash":
      requiredBoundedString(value, "command", 1024 * 1024);
      optionalBoolean(value, "excludeFromContext");
      break;
    case "export_html":
      optionalBoundedString(value, "outputPath", 4096);
      break;
    case "switch_session":
      requiredBoundedString(value, "sessionPath", 4096);
      break;
    case "fork":
      requiredBoundedString(value, "entryId", 256);
      break;
    case "get_entries":
      optionalBoundedString(value, "since", 256);
      break;
    case "set_session_name":
      requiredBoundedString(value, "name", 1024);
      break;
    case "abort":
    case "get_state":
    case "cycle_model":
    case "get_available_models":
    case "cycle_thinking_level":
    case "abort_retry":
    case "abort_bash":
    case "get_session_stats":
    case "clone":
    case "get_fork_messages":
    case "get_tree":
    case "get_last_assistant_text":
    case "get_messages":
    case "get_commands":
      break;
  }
  return value as RpcCommand;
}

function optionalImages(value: unknown): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length > 32) {
    throw new PiRpcValidationError("RPC images must be an array of at most 32 items");
  }
  for (const image of value) {
    if (!isRecord(image) || image.type !== "image") {
      throw new PiRpcValidationError("RPC image item is invalid");
    }
    requiredBoundedString(image, "data", 16 * 1024 * 1024);
    requiredBoundedString(image, "mimeType", 256);
  }
}

function requiredBoundedString(
  value: Record<string, unknown>,
  field: string,
  maxLength: number,
): string {
  const child = value[field];
  if (typeof child !== "string" || child.length === 0 || child.length > maxLength) {
    throw new PiRpcValidationError(`RPC ${field} must be a non-empty bounded string`);
  }
  return child;
}

function optionalBoundedString(
  value: Record<string, unknown>,
  field: string,
  maxLength: number,
): void {
  if (value[field] === undefined) return;
  requiredBoundedString(value, field, maxLength);
}

function requiredBoolean(value: Record<string, unknown>, field: string): void {
  if (typeof value[field] !== "boolean") {
    throw new PiRpcValidationError(`RPC ${field} must be a boolean`);
  }
}

function optionalBoolean(value: Record<string, unknown>, field: string): void {
  if (value[field] !== undefined) requiredBoolean(value, field);
}

function requiredEnum(
  value: Record<string, unknown>,
  field: string,
  allowed: readonly string[],
): void {
  if (typeof value[field] !== "string" || !allowed.includes(value[field])) {
    throw new PiRpcValidationError(`RPC ${field} is invalid`);
  }
}

function optionalEnum(
  value: Record<string, unknown>,
  field: string,
  allowed: readonly string[],
): void {
  if (value[field] !== undefined) requiredEnum(value, field, allowed);
}

function extractRpcId(value: unknown): string | undefined {
  if (!isRecord(value) || typeof value.id !== "string" || value.id.length > 256) return undefined;
  return value.id;
}

function extractRpcType(value: unknown): string {
  if (!isRecord(value) || typeof value.type !== "string" || value.type.length > 128) return "parse";
  return value.type;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function availableCommands(session: AgentSession) {
  const commands: Array<{
    name: string;
    description?: string;
    source: "extension" | "prompt" | "skill";
    sourceInfo: ReturnType<AgentSession["extensionRunner"]["getRegisteredCommands"]>[number]["sourceInfo"];
  }> = [];
  for (const command of session.extensionRunner.getRegisteredCommands()) {
    commands.push({
      name: command.invocationName,
      ...(command.description === undefined ? {} : { description: command.description }),
      source: "extension",
      sourceInfo: command.sourceInfo,
    });
  }
  for (const template of session.promptTemplates) {
    commands.push({
      name: template.name,
      ...(template.description === undefined ? {} : { description: template.description }),
      source: "prompt",
      sourceInfo: template.sourceInfo,
    });
  }
  for (const skill of session.resourceLoader.getSkills().skills) {
    commands.push({
      name: `skill:${skill.name}`,
      ...(skill.description === undefined ? {} : { description: skill.description }),
      source: "skill",
      sourceInfo: skill.sourceInfo,
    });
  }
  return commands;
}

function success(id: string | undefined, command: string, data?: unknown): RpcResponse {
  return {
    ...(id === undefined ? {} : { id }),
    type: "response",
    command,
    success: true,
    ...(data === undefined ? {} : { data }),
  } as RpcResponse;
}

function failure(id: string | undefined, command: string, error: string): RpcResponse {
  return {
    ...(id === undefined ? {} : { id }),
    type: "response",
    command,
    success: false,
    error,
  };
}

function safeRpcError(error: unknown): string {
  const message = error instanceof Error ? error.message : "RPC command failed";
  return message
    .replace(/Bearer\s+[^\s]+/gi, "Bearer [REDACTED]")
    .replace(
      /(["']?(?:api[_-]?key|token|secret|password)["']?\s*[:=]\s*)["']?[^"'\s,;}]+["']?/gi,
      "$1[REDACTED]",
    )
    .replace(/\b(?:sk|gh[pousr]|github_pat)[_-][A-Za-z0-9_-]{8,}\b/g, "[REDACTED]")
    .slice(0, 4096);
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${field} must be a positive safe integer`);
  }
  return value;
}

const FOREGROUND_COLORS = [
  "accent",
  "border",
  "borderAccent",
  "borderMuted",
  "success",
  "error",
  "warning",
  "muted",
  "dim",
  "text",
  "thinkingText",
  "userMessageText",
  "customMessageText",
  "customMessageLabel",
  "toolTitle",
  "toolOutput",
  "mdHeading",
  "mdLink",
  "mdLinkUrl",
  "mdCode",
  "mdCodeBlock",
  "mdCodeBlockBorder",
  "mdQuote",
  "mdQuoteBorder",
  "mdHr",
  "mdListBullet",
  "toolDiffAdded",
  "toolDiffRemoved",
  "toolDiffContext",
  "syntaxComment",
  "syntaxKeyword",
  "syntaxFunction",
  "syntaxVariable",
  "syntaxString",
  "syntaxNumber",
  "syntaxType",
  "syntaxOperator",
  "syntaxPunctuation",
  "thinkingOff",
  "thinkingMinimal",
  "thinkingLow",
  "thinkingMedium",
  "thinkingHigh",
  "thinkingXhigh",
  "thinkingMax",
  "bashMode",
] as const;
const BACKGROUND_COLORS = [
  "selectedBg",
  "userMessageBg",
  "customMessageBg",
  "toolPendingBg",
  "toolSuccessBg",
  "toolErrorBg",
] as const;
const HEADLESS_RPC_THEME = new Theme(
  Object.fromEntries(FOREGROUND_COLORS.map((name) => [name, "#ffffff"])) as never,
  Object.fromEntries(BACKGROUND_COLORS.map((name) => [name, "#000000"])) as never,
  "truecolor",
  { name: "pi-daemon-rpc" },
);
