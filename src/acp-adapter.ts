import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { isAbsolute, resolve } from "node:path";
import type { Duplex } from "node:stream";

import {
  PROTOCOL_VERSION,
  RequestError,
  agent,
  methods,
  type AgentConnection,
  type AnyMessage,
  type ContentBlock,
  type InitializeRequest,
  type InitializeResponse,
  type ListSessionsRequest,
  type ListSessionsResponse,
  type LoadSessionRequest,
  type LoadSessionResponse,
  type NewSessionRequest,
  type NewSessionResponse,
  type PermissionOption,
  type PromptRequest,
  type PromptResponse,
  type SessionConfigOption,
  type SessionModeState,
  type SessionUpdate,
  type SetSessionConfigOptionRequest,
  type SetSessionConfigOptionResponse,
  type SetSessionModeRequest,
  type SetSessionModeResponse,
  type Stream,
  type ToolCallLocation,
  type ToolKind,
} from "@agentclientprotocol/sdk";
type PiImageContent = { type: "image"; data: string; mimeType: string };
import type {
  RpcExtensionUIResponse,
  RpcResponse,
} from "@earendil-works/pi-coding-agent";

import { Multiplexer, MultiplexerError } from "./multiplexer.js";
import {
  type PiRpcController,
  type PiRpcControllerOutput,
} from "./pi-rpc-controller.js";
import type { EventEnvelope } from "./protocol.js";
import type { SessionCatalogRecord } from "./session-catalog.js";
import { PI_DAEMON_VERSION } from "./version.js";
import {
  WebSocketHandshakeError,
  WebSocketPeer,
  acceptWebSocket,
  validateWebSocketHandshake,
} from "./websocket.js";

export const ACP_WEBSOCKET_SUBPROTOCOL = "agent-client-protocol.v1" as const;

export interface AcpAdapterLimits {
  maxHubs: number;
  maxConnectionsPerHub: number;
  maxMessageBytes: number;
  maxOutboundBytesPerConnection: number;
  keepAliveMs: number;
  maxListSessions: number;
}

export const DEFAULT_ACP_ADAPTER_LIMITS: Readonly<AcpAdapterLimits> = {
  maxHubs: 32,
  maxConnectionsPerHub: 16,
  maxMessageBytes: 1024 * 1024,
  maxOutboundBytesPerConnection: 4 * 1024 * 1024,
  keepAliveMs: 30_000,
  maxListSessions: 100,
};

export interface AcpAdapterCapabilities {
  protocol: "ACP";
  protocolVersion: number;
  sdkVersion: "1.2.0";
  websocketSubprotocol: typeof ACP_WEBSOCKET_SUBPROTOCOL;
  upstreamAdapter: { name: "pi-acp"; auditCommit: string; license: "MIT" };
  inProcess: true;
  limits: AcpAdapterLimits;
}

export class AcpAdapterError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;

  constructor(status: number, code: string, message: string, retryable = false) {
    super(message);
    this.name = "AcpAdapterError";
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

export class AcpAdapterManager {
  readonly limits: AcpAdapterLimits;
  readonly #multiplexer: Multiplexer;
  readonly #hubs = new Map<string, AcpSessionHub>();
  readonly #unsubscribeMultiplexer: () => void;
  #disposed = false;

  constructor(multiplexer: Multiplexer, limits: Partial<AcpAdapterLimits> = {}) {
    this.#multiplexer = multiplexer;
    this.limits = resolveLimits(limits);
    this.#unsubscribeMultiplexer = multiplexer.subscribe((event) => this.#onMultiplexerEvent(event));
  }

  get capabilities(): AcpAdapterCapabilities {
    return {
      protocol: "ACP",
      protocolVersion: PROTOCOL_VERSION,
      sdkVersion: "1.2.0",
      websocketSubprotocol: ACP_WEBSOCKET_SUBPROTOCOL,
      upstreamAdapter: {
        name: "pi-acp",
        auditCommit: "49d6ec804d40b52317d873360654054c5d2387a3",
        license: "MIT",
      },
      inProcess: true,
      limits: { ...this.limits },
    };
  }

  async attach(
    request: IncomingMessage,
    socket: Duplex,
    sessionRef: string,
    url: URL,
  ): Promise<void> {
    if (this.#disposed) {
      throw new AcpAdapterError(503, "server_stopping", "ACP attachment server is stopping", true);
    }
    socket.pause();
    const key = validateWebSocketHandshake(request);
    validateSubprotocol(request.headers["sec-websocket-protocol"]);
    const generation = parseGeneration(url.searchParams.get("generation"));
    const record = await this.#multiplexer.retainedSession(sessionRef);
    if (record === undefined) throw new AcpAdapterError(404, "session_not_found", "session not found");
    if (generation !== undefined && generation !== record.generation) {
      throw new AcpAdapterError(409, "stale_generation", "session generation changed");
    }
    let controller: PiRpcController;
    try {
      controller = await this.#multiplexer.rpcController(record.sessionId, record.generation);
    } catch (error) {
      throw adapterError(error);
    }
    const hub = this.#hub(record, controller);
    if (hub.connectionCount >= this.limits.maxConnectionsPerHub) {
      throw new AcpAdapterError(503, "acp_connection_capacity", "ACP connection capacity reached", true);
    }
    const peer = acceptWebSocket(socket, key, {
      protocol: ACP_WEBSOCKET_SUBPROTOCOL,
      limits: {
        maxMessageBytes: this.limits.maxMessageBytes,
        maxOutboundBytes: this.limits.maxOutboundBytesPerConnection,
        keepAliveMs: this.limits.keepAliveMs,
      },
    });
    hub.add(peer);
    socket.resume();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#unsubscribeMultiplexer();
    for (const hub of this.#hubs.values()) hub.dispose();
    this.#hubs.clear();
  }

  #hub(record: SessionCatalogRecord, controller: PiRpcController): AcpSessionHub {
    const key = hubKey(record.sessionId, record.generation);
    const existing = this.#hubs.get(key);
    if (existing !== undefined) return existing;
    if (this.#hubs.size >= this.limits.maxHubs) {
      const idle = [...this.#hubs.entries()].find(([, hub]) => hub.connectionCount === 0);
      if (idle === undefined) {
        throw new AcpAdapterError(503, "acp_hub_capacity", "ACP hub capacity reached", true);
      }
      idle[1].dispose();
      this.#hubs.delete(idle[0]);
    }
    const hub = new AcpSessionHub(
      this.#multiplexer,
      record,
      controller,
      () => {
        if (this.#hubs.get(key) === hub && hub.connectionCount === 0) {
          // Keep the controller subscription and hub for bounded reuse until capacity pressure.
        }
      },
      this.limits.maxListSessions,
    );
    this.#hubs.set(key, hub);
    return hub;
  }

  #onMultiplexerEvent(event: EventEnvelope): void {
    for (const [key, hub] of this.#hubs) {
      if (hub.sessionId !== event.sessionId) continue;
      if (
        hub.generation !== event.generation ||
        ["sessionClosed", "sessionDormant", "sessionDeleted"].includes(event.event)
      ) {
        hub.dispose();
        this.#hubs.delete(key);
      }
    }
  }
}

class AcpSessionHub {
  readonly sessionId: string;
  readonly generation: number;
  readonly cwd: string;
  readonly #multiplexer: Multiplexer;
  readonly #controller: PiRpcController;
  readonly #connections = new Map<string, AcpPeerSession>();
  readonly #unsubscribeController: () => void;
  readonly #onIdle: () => void;
  readonly #maxListSessions: number;
  #activeTurn:
    | {
        peerId: string;
        cancelled: boolean;
        resolve: (reason: "end_turn" | "cancelled") => void;
      }
    | undefined;
  #disposed = false;

  constructor(
    multiplexer: Multiplexer,
    record: SessionCatalogRecord,
    controller: PiRpcController,
    onIdle: () => void,
    maxListSessions = 100,
  ) {
    this.#multiplexer = multiplexer;
    this.#controller = controller;
    this.#onIdle = onIdle;
    this.#maxListSessions = maxListSessions;
    this.sessionId = record.sessionId;
    this.generation = record.generation;
    this.cwd = record.spec.cwd;
    this.#unsubscribeController = controller.subscribe((output) => {
      void this.#publish(output).catch(() => {});
    });
  }

  get connectionCount(): number {
    return this.#connections.size;
  }

  controller(): PiRpcController {
    return this.#controller;
  }

  add(peer: WebSocketPeer): void {
    if (this.#disposed) {
      peer.close(1012, "ACP session closed");
      return;
    }
    const connection = new AcpPeerSession(this, peer, randomUUID());
    this.#connections.set(connection.id, connection);
    connection.start();
  }

  async record(): Promise<SessionCatalogRecord> {
    const record = await this.#multiplexer.retainedSession(this.sessionId);
    if (record === undefined || record.generation !== this.generation) {
      throw RequestError.invalidParams({ sessionId: this.sessionId }, "Session generation changed");
    }
    return record;
  }

  async list(params: ListSessionsRequest): Promise<ListSessionsResponse> {
    const page = await this.#multiplexer.retainedSessions({
      limit: Math.min(50, this.#maxListSessions),
      ...(params.cursor === undefined || params.cursor === null ? {} : { cursor: params.cursor }),
    });
    const requestedCwd = typeof params.cwd === "string" ? resolve(params.cwd) : undefined;
    return {
      sessions: page.sessions
        .filter((record) => requestedCwd === undefined || resolve(record.spec.cwd) === requestedCwd)
        .map((record) => ({
          sessionId: record.sessionId,
          cwd: record.spec.cwd,
          ...(record.name === undefined ? {} : { title: record.name }),
          updatedAt: record.updatedAt,
        })),
      ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
    };
  }

  async prompt(
    peer: AcpPeerSession,
    params: PromptRequest,
    signal: AbortSignal,
  ): Promise<PromptResponse> {
    peer.assertSession(params.sessionId);
    peer.assertBound();
    if (this.#activeTurn !== undefined) {
      throw RequestError.internalError({ code: "session_busy" }, "Another ACP prompt is active");
    }
    const builtIn = await peer.handleBuiltinPrompt(params);
    if (builtIn) return { stopReason: "end_turn" };
    const { message, images } = promptToPi(params.prompt);
    let resolveTurn!: (reason: "end_turn" | "cancelled") => void;
    const settled = new Promise<"end_turn" | "cancelled">((resolveTurnPromise) => {
      resolveTurn = resolveTurnPromise;
    });
    this.#activeTurn = { peerId: peer.id, cancelled: false, resolve: resolveTurn };
    const abort = (): void => void this.cancel(peer).catch(() => {});
    signal.addEventListener("abort", abort, { once: true });
    try {
      const response = await this.#controller.handle({
        type: "prompt",
        message,
        ...(images.length === 0 ? {} : { images }),
      });
      if (!response.success) {
        this.#activeTurn = undefined;
        throw RequestError.internalError({ code: "pi_prompt_rejected" }, response.error);
      }
      return { stopReason: await settled };
    } finally {
      signal.removeEventListener("abort", abort);
      if (this.#activeTurn?.peerId === peer.id) this.#activeTurn = undefined;
    }
  }

  async cancel(peer: AcpPeerSession): Promise<void> {
    const active = this.#activeTurn;
    if (active === undefined) return;
    peer.assertSession(this.sessionId);
    active.cancelled = true;
    await this.#controller.handle({ type: "abort" });
  }

  async configuration(): Promise<{
    modes: SessionModeState;
    configOptions: SessionConfigOption[];
  }> {
    const [stateResponse, modelsResponse] = await Promise.all([
      this.#controller.handle({ type: "get_state" }),
      this.#controller.handle({ type: "get_available_models" }),
    ]);
    if (!stateResponse.success || !modelsResponse.success) {
      throw RequestError.internalError({}, "Pi RPC state is unavailable");
    }
    const state = asRecord(responseData(stateResponse));
    const models = asArray(asRecord(responseData(modelsResponse)).models)
      .map(asRecord)
      .filter((model) => typeof model.provider === "string" && typeof model.id === "string");
    const currentModel = asRecord(state.model);
    const currentModelId =
      typeof currentModel.provider === "string" && typeof currentModel.id === "string"
        ? modelValue(currentModel.provider, currentModel.id)
        : models[0] === undefined
          ? "unavailable"
          : modelValue(String(models[0].provider), String(models[0].id));
    const currentThinking =
      typeof state.thinkingLevel === "string" ? state.thinkingLevel : "off";
    const modes: SessionModeState = {
      currentModeId: currentThinking,
      availableModes: THINKING_LEVELS.map((level) => ({ id: level, name: thinkingName(level) })),
    };
    const configOptions: SessionConfigOption[] = [
      {
        type: "select",
        id: "model",
        name: "Model",
        category: "model",
        currentValue: currentModelId,
        options: models.map((model) => ({
          value: modelValue(String(model.provider), String(model.id)),
          name: typeof model.name === "string" ? model.name : `${model.provider}/${model.id}`,
        })),
      },
      {
        type: "select",
        id: "thought_level",
        name: "Thinking level",
        category: "thought_level",
        currentValue: currentThinking,
        options: THINKING_LEVELS.map((level) => ({ value: level, name: thinkingName(level) })),
      },
    ];
    return { modes, configOptions };
  }

  async setMode(params: SetSessionModeRequest): Promise<SetSessionModeResponse> {
    this.assertSession(params.sessionId);
    const mode = requireThinkingLevel(params.modeId);
    const response = await this.#controller.handle({ type: "set_thinking_level", level: mode });
    if (!response.success) throw RequestError.invalidParams({}, response.error);
    await this.#broadcast({ sessionUpdate: "current_mode_update", currentModeId: mode });
    return {};
  }

  async setConfig(
    params: SetSessionConfigOptionRequest,
  ): Promise<SetSessionConfigOptionResponse> {
    this.assertSession(params.sessionId);
    if (typeof params.value !== "string") {
      throw RequestError.invalidParams({}, "Configuration value must be a string");
    }
    if (params.configId === "thought_level") {
      await this.setMode({ sessionId: params.sessionId, modeId: params.value });
    } else if (params.configId === "model") {
      const parsed = parseModelValue(params.value);
      const response = await this.#controller.handle({
        type: "set_model",
        provider: parsed.provider,
        modelId: parsed.modelId,
      });
      if (!response.success) throw RequestError.invalidParams({}, response.error);
    } else {
      throw RequestError.invalidParams({}, `Unknown configuration option: ${params.configId}`);
    }
    const { configOptions } = await this.configuration();
    await this.#broadcast({ sessionUpdate: "config_option_update", configOptions });
    return { configOptions };
  }

  assertSession(sessionId: string): void {
    if (sessionId !== this.sessionId) {
      throw RequestError.invalidParams({ sessionId }, "ACP route is scoped to a different session");
    }
  }

  remove(peer: AcpPeerSession): void {
    if (!this.#connections.delete(peer.id)) return;
    if (this.#activeTurn?.peerId === peer.id) {
      const active = this.#activeTurn;
      active.cancelled = true;
      active.resolve("cancelled");
      this.#activeTurn = undefined;
      void this.#controller.handle({ type: "abort" });
    }
    if (this.#connections.size === 0) this.#onIdle();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#unsubscribeController();
    this.#controller.cancelPendingUi();
    if (this.#activeTurn !== undefined) this.#activeTurn.resolve("cancelled");
    this.#activeTurn = undefined;
    for (const peer of this.#connections.values()) peer.dispose();
    this.#connections.clear();
  }

  async #publish(output: PiRpcControllerOutput): Promise<void> {
    if (this.#disposed) return;
    if (isExtensionUiRequest(output)) {
      void this.#handleExtensionUi(output);
      return;
    }
    const update = translateOutput(output, this.cwd);
    if (update !== undefined) await this.#broadcast(update);
    if (isRecord(output) && output.type === "agent_settled" && this.#activeTurn !== undefined) {
      const active = this.#activeTurn;
      await Promise.all([...this.#connections.values()].map((peer) => peer.flush()));
      active.resolve(active.cancelled ? "cancelled" : "end_turn");
    }
  }

  async #broadcast(update: SessionUpdate): Promise<void> {
    await Promise.all([...this.#connections.values()].map((peer) => peer.sendUpdate(update)));
  }

  async #handleExtensionUi(output: Extract<PiRpcControllerOutput, { type: "extension_ui_request" }>): Promise<void> {
    const activePeer =
      (this.#activeTurn === undefined ? undefined : this.#connections.get(this.#activeTurn.peerId)) ??
      [...this.#connections.values()].find((peer) => peer.bound);
    if (activePeer === undefined) {
      this.#controller.respondToExtensionUi({
        type: "extension_ui_response",
        id: output.id,
        cancelled: true,
      });
      return;
    }
    const response = await activePeer.requestPermission(output);
    this.#controller.respondToExtensionUi(response);
  }
}

class AcpPeerSession {
  readonly id: string;
  readonly #hub: AcpSessionHub;
  readonly #peer: WebSocketPeer;
  #connection: AgentConnection | undefined;
  #updates: Promise<void> = Promise.resolve();
  #disposed = false;
  bound = false;

  constructor(hub: AcpSessionHub, peer: WebSocketPeer, id: string) {
    this.#hub = hub;
    this.#peer = peer;
    this.id = id;
  }

  start(): void {
    const stream = webSocketAcpStream(this.#peer);
    const app = agent({ name: "pi-daemon-acp" })
      .onRequest(methods.agent.initialize, (ctx) => this.initialize(ctx.params))
      .onRequest(methods.agent.authenticate, async () => ({}))
      .onRequest(methods.agent.session.new, (ctx) => this.newSession(ctx.params))
      .onRequest(methods.agent.session.load, (ctx) => this.loadSession(ctx.params))
      .onRequest(methods.agent.session.list, (ctx) => this.#hub.list(ctx.params))
      .onRequest(methods.agent.session.prompt, (ctx) => this.#hub.prompt(this, ctx.params, ctx.signal))
      .onRequest(methods.agent.session.setMode, (ctx) => {
        this.assertBound();
        return this.#hub.setMode(ctx.params);
      })
      .onRequest(methods.agent.session.setConfigOption, (ctx) => {
        this.assertBound();
        return this.#hub.setConfig(ctx.params);
      })
      .onRequest(methods.agent.session.close, async (ctx) => {
        this.assertSession(ctx.params.sessionId);
        this.bound = false;
        return {};
      })
      .onNotification(methods.agent.session.cancel, async (ctx) => {
        this.assertSession(ctx.params.sessionId);
        await this.#hub.cancel(this);
      });
    this.#connection = app.connect(stream);
    void this.#connection.closed.finally(() => this.dispose());
  }

  async initialize(params: InitializeRequest): Promise<InitializeResponse> {
    return {
      protocolVersion: params.protocolVersion === PROTOCOL_VERSION ? params.protocolVersion : PROTOCOL_VERSION,
      agentInfo: {
        name: "pi-daemon-acp",
        title: "Pi Daemon ACP adapter",
        version: PI_DAEMON_VERSION,
      },
      authMethods: [],
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: true, audio: false, embeddedContext: false },
        mcpCapabilities: { http: false, sse: false, acp: false },
        sessionCapabilities: { list: {}, close: {} },
      },
      _meta: {
        piDaemon: {
          routeSpelling: "apc",
          wireProtocol: "ACP",
          upstreamAdapterAudit: "svkozak/pi-acp@49d6ec804d40b52317d873360654054c5d2387a3",
          inProcess: true,
        },
      },
    };
  }

  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    const record = await this.#hub.record();
    validateCwd(params.cwd, record.spec.cwd);
    rejectMcpServers(params.mcpServers);
    this.bound = true;
    const configuration = await this.#hub.configuration();
    this.#scheduleCommands();
    return {
      sessionId: record.sessionId,
      ...configuration,
      _meta: { piDaemon: { routeScoped: true, generation: record.generation } },
    };
  }

  async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
    this.#hub.assertSession(params.sessionId);
    const record = await this.#hub.record();
    validateCwd(params.cwd, record.spec.cwd);
    rejectMcpServers(params.mcpServers);
    this.bound = true;
    await this.#replayMessages();
    const configuration = await this.#hub.configuration();
    this.#scheduleCommands();
    return configuration;
  }

  assertSession(sessionId: string): void {
    this.#hub.assertSession(sessionId);
  }

  assertBound(): void {
    if (!this.bound) {
      throw RequestError.invalidRequest({}, "Call session/new or session/load before session methods");
    }
  }

  async handleBuiltinPrompt(params: PromptRequest): Promise<boolean> {
    const blocks = params.prompt;
    if (blocks.length !== 1 || blocks[0]?.type !== "text") return false;
    const text = blocks[0].text.trim();
    if (!text.startsWith("/")) return false;
    const firstSpace = text.indexOf(" ");
    const command = (firstSpace < 0 ? text.slice(1) : text.slice(1, firstSpace)).toLowerCase();
    const args = firstSpace < 0 ? "" : text.slice(firstSpace + 1).trim();
    let response: RpcResponse | undefined;
    if (command === "compact") {
      response = await this.#hubController({
        type: "compact",
        ...(args.length === 0 ? {} : { customInstructions: args }),
      });
    } else if (command === "session") {
      response = await this.#hubController({ type: "get_session_stats" });
    } else if (command === "name") {
      if (args.length === 0) {
        await this.sendText("Usage: /name <name>");
        return true;
      }
      response = await this.#hubController({ type: "set_session_name", name: args });
    } else if (command === "autocompact") {
      const state = await this.#hubController({ type: "get_state" });
      if (!state.success) response = state;
      else {
        const current = Boolean(asRecord(responseData(state)).autoCompactionEnabled);
        const enabled = args === "on" ? true : args === "off" ? false : !current;
        response = await this.#hubController({ type: "set_auto_compaction", enabled });
      }
    } else if (command === "steering" || command === "follow-up") {
      if (args !== "all" && args !== "one-at-a-time") {
        await this.sendText(`Usage: /${command} all | /${command} one-at-a-time`);
        return true;
      }
      response = await this.#hubController(
        command === "steering"
          ? { type: "set_steering_mode", mode: args }
          : { type: "set_follow_up_mode", mode: args },
      );
    } else {
      return false;
    }
    await this.sendText(
      response.success
        ? command === "session"
          ? JSON.stringify(responseData(response), null, 2)
          : `/${command} completed.`
        : `/${command} failed: ${response.error}`,
    );
    return true;
  }

  async requestPermission(
    request: Extract<PiRpcControllerOutput, { type: "extension_ui_request" }>,
  ): Promise<RpcExtensionUIResponse> {
    if (request.method !== "select" && request.method !== "confirm") {
      await this.sendText(`Pi ${request.method} UI request is not supported by ACP; cancelled.`);
      return { type: "extension_ui_response", id: request.id, cancelled: true };
    }
    const options: PermissionOption[] =
      request.method === "select"
        ? request.options.map((name, index) => ({
            optionId: `choice-${index}`,
            name,
            kind: "allow_once",
          }))
        : [
            { optionId: "yes", name: "Yes", kind: "allow_once" },
            { optionId: "no", name: "No", kind: "reject_once" },
          ];
    if (options.length === 0) {
      return { type: "extension_ui_response", id: request.id, cancelled: true };
    }
    try {
      const outcome = await this.#connection!.client.request(
        methods.client.session.requestPermission,
        {
          sessionId: this.#hub.sessionId,
          toolCall: {
            toolCallId: `pi-ui-${request.id}`,
            title: request.title,
            kind: "other",
            status: "pending",
            rawInput: request,
          },
          options,
        },
      );
      if (outcome.outcome.outcome === "cancelled") {
        return { type: "extension_ui_response", id: request.id, cancelled: true };
      }
      if (request.method === "confirm") {
        return {
          type: "extension_ui_response",
          id: request.id,
          confirmed: outcome.outcome.optionId === "yes",
        };
      }
      const index = Number(outcome.outcome.optionId.replace(/^choice-/, ""));
      const value = Number.isSafeInteger(index) ? request.options[index] : undefined;
      return value === undefined
        ? { type: "extension_ui_response", id: request.id, cancelled: true }
        : { type: "extension_ui_response", id: request.id, value };
    } catch {
      return { type: "extension_ui_response", id: request.id, cancelled: true };
    }
  }

  sendUpdate(update: SessionUpdate): Promise<void> {
    if (!this.bound || this.#disposed || this.#connection === undefined) return Promise.resolve();
    const task = this.#updates.then(() =>
      this.#connection!.client.notify(methods.client.session.update, {
        sessionId: this.#hub.sessionId,
        update,
      }),
    );
    this.#updates = task.catch(() => {});
    return task;
  }

  flush(): Promise<void> {
    return this.#updates;
  }

  async sendText(text: string): Promise<void> {
    await this.sendUpdate({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text },
    });
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.bound = false;
    this.#hub.remove(this);
    this.#peer.close(1000, "ACP connection closed");
  }

  async #replayMessages(): Promise<void> {
    const response = await this.#hubController({ type: "get_messages" });
    if (!response.success) throw RequestError.internalError({}, response.error);
    const messages = asArray(asRecord(responseData(response)).messages);
    for (const raw of messages) {
      const message = asRecord(raw);
      const role = String(message.role ?? "");
      const text = messageText(message.content, role === "assistant");
      if (text.length === 0) continue;
      await this.sendUpdate({
        sessionUpdate: role === "user" ? "user_message_chunk" : "agent_message_chunk",
        content: { type: "text", text },
      });
    }
  }

  #scheduleCommands(): void {
    setTimeout(() => {
      void this.#hubController({ type: "get_commands" }).then(async (response) => {
        if (!response.success) return;
        const commands = asArray(asRecord(responseData(response)).commands)
          .map(asRecord)
          .filter((command) => typeof command.name === "string")
          .map((command) => ({
            name: String(command.name),
            description:
              typeof command.description === "string" ? command.description : "Pi command",
          }));
        await this.sendUpdate({
          sessionUpdate: "available_commands_update",
          availableCommands: [...commands, ...BUILTIN_COMMANDS],
        });
      });
    }, 0);
  }

  #hubController(command: Parameters<PiRpcController["handle"]>[0]): Promise<RpcResponse> {
    return this.#hubControllerInstance().handle(command);
  }

  #hubControllerInstance(): PiRpcController {
    return this.#hub.controller();
  }
}

function webSocketAcpStream(peer: WebSocketPeer): Stream {
  let inbound: ReadableStreamDefaultController<AnyMessage> | undefined;
  const readable = new ReadableStream<AnyMessage>({
    start(controller) {
      inbound = controller;
    },
    cancel() {
      peer.close(1000, "ACP stream cancelled");
    },
  });
  const writable = new WritableStream<AnyMessage>({
    write(message) {
      const failure = peer.sendJson(message);
      if (failure !== undefined) throw failure;
    },
    close() {
      peer.close(1000, "ACP stream closed");
    },
    abort() {
      peer.terminate();
    },
  });
  peer.setHandlers({
    onMessage: (text) => {
      try {
        const value = JSON.parse(text) as unknown;
        if (!isJsonRpcMessage(value)) throw new Error("invalid JSON-RPC message");
        inbound?.enqueue(value);
      } catch {
        peer.close(1007, "invalid ACP JSON-RPC message");
      }
    },
    onClose: () => {
      try {
        inbound?.close();
      } catch {
        // Already closed by the ACP SDK.
      }
    },
  });
  return { readable, writable };
}

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
type ThinkingLevel = (typeof THINKING_LEVELS)[number];
const BUILTIN_COMMANDS = [
  { name: "compact", description: "Manually compact the session context" },
  { name: "autocompact", description: "Toggle automatic context compaction" },
  { name: "session", description: "Show session statistics" },
  { name: "name", description: "Set session display name", input: { hint: "<name>" } },
  { name: "steering", description: "Set steering delivery mode", input: { hint: "all|one-at-a-time" } },
  { name: "follow-up", description: "Set follow-up delivery mode", input: { hint: "all|one-at-a-time" } },
] as const;

function promptToPi(blocks: ContentBlock[]): { message: string; images: PiImageContent[] } {
  const text: string[] = [];
  const images: PiImageContent[] = [];
  for (const block of blocks) {
    if (block.type === "text") text.push(block.text);
    else if (block.type === "image") {
      images.push({ type: "image", data: block.data, mimeType: block.mimeType });
    } else if (block.type === "resource_link") {
      text.push(`[${block.name}](${block.uri})`);
    } else if (block.type === "resource") {
      throw RequestError.invalidParams({}, "Embedded ACP context is not enabled");
    } else if (block.type === "audio") {
      throw RequestError.invalidParams({}, "ACP audio prompts are not supported");
    }
  }
  if (text.length === 0 && images.length === 0) {
    throw RequestError.invalidParams({}, "ACP prompt is empty");
  }
  return { message: text.join("\n"), images };
}

function translateOutput(output: PiRpcControllerOutput, cwd: string): SessionUpdate | undefined {
  const event = asRecord(output);
  if (event.type === "message_update") {
    const update = asRecord(event.assistantMessageEvent);
    if (update.type === "text_delta" && typeof update.delta === "string") {
      return { sessionUpdate: "agent_message_chunk", content: { type: "text", text: update.delta } };
    }
    if (update.type === "thinking_delta" && typeof update.delta === "string") {
      return { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: update.delta } };
    }
  }
  if (event.type === "tool_execution_start") {
    const toolCallId = String(event.toolCallId ?? randomUUID());
    const toolName = String(event.toolName ?? "tool");
    const locations = toolLocations(event.args, cwd);
    return {
      sessionUpdate: "tool_call",
      toolCallId,
      title: toolName,
      kind: toolKind(toolName),
      status: "in_progress",
      rawInput: event.args,
      ...(locations === undefined ? {} : { locations }),
    };
  }
  if (event.type === "tool_execution_update" || event.type === "tool_execution_end") {
    const ended = event.type === "tool_execution_end";
    const result = ended ? event.result : event.partialResult;
    const text = toolText(result);
    return {
      sessionUpdate: "tool_call_update",
      toolCallId: String(event.toolCallId ?? "unknown"),
      status: ended ? (event.isError === true ? "failed" : "completed") : "in_progress",
      ...(text.length === 0
        ? {}
        : { content: [{ type: "content", content: { type: "text", text } }] }),
      rawOutput: result,
    };
  }
  if (event.type === "session_info_changed") {
    return {
      sessionUpdate: "session_info_update",
      ...(typeof event.name === "string" ? { title: event.name } : {}),
      updatedAt: new Date().toISOString(),
    };
  }
  if (event.type === "queue_update") {
    return {
      sessionUpdate: "session_info_update",
      _meta: {
        piDaemon: {
          steering: asArray(event.steering).length,
          followUp: asArray(event.followUp).length,
        },
      },
    };
  }
  if (event.type === "auto_retry_start") {
    return {
      sessionUpdate: "agent_message_chunk",
      content: {
        type: "text",
        text: `Retrying (attempt ${String(event.attempt ?? "?")}/${String(event.maxAttempts ?? "?")})...`,
      },
    };
  }
  if (event.type === "compaction_start") {
    return {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Compacting session context..." },
    };
  }
  if (event.type === "extension_error") {
    return {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: `Extension error: ${String(event.error ?? "unknown")}` },
    };
  }
  return undefined;
}

function toolKind(name: string): ToolKind {
  if (name === "read") return "read";
  if (name === "write" || name === "edit") return "edit";
  if (name === "bash") return "execute";
  if (name.includes("search") || name === "grep" || name === "find") return "search";
  return "other";
}

function toolLocations(value: unknown, cwd: string): ToolCallLocation[] | undefined {
  const args = asRecord(value);
  const path = typeof args.path === "string" ? args.path : typeof args.file_path === "string" ? args.file_path : undefined;
  return path === undefined
    ? undefined
    : [{ path: isAbsolute(path) ? path : resolve(cwd, path) }];
}

function toolText(value: unknown): string {
  const record = asRecord(value);
  const content = asArray(record.content);
  return content
    .map(asRecord)
    .filter((item) => item.type === "text" && typeof item.text === "string")
    .map((item) => String(item.text))
    .join("\n");
}

function messageText(value: unknown, assistant: boolean): string {
  if (typeof value === "string") return value;
  return asArray(value)
    .map(asRecord)
    .filter((item) => item.type === "text" || (assistant && item.type === "thinking"))
    .map((item) => (typeof item.text === "string" ? item.text : typeof item.thinking === "string" ? item.thinking : ""))
    .filter(Boolean)
    .join("\n");
}

function isExtensionUiRequest(
  output: PiRpcControllerOutput,
): output is Extract<PiRpcControllerOutput, { type: "extension_ui_request" }> {
  return isRecord(output) && output.type === "extension_ui_request" && typeof output.id === "string";
}

function isJsonRpcMessage(value: unknown): value is AnyMessage {
  if (!isRecord(value) || value.jsonrpc !== "2.0") return false;
  if (typeof value.method === "string") {
    return value.id === undefined || validJsonRpcId(value.id);
  }
  return validJsonRpcId(value.id) && (Object.hasOwn(value, "result") || isRecord(value.error));
}

function validJsonRpcId(value: unknown): boolean {
  return value === null || typeof value === "string" || (typeof value === "number" && Number.isSafeInteger(value));
}

function validateSubprotocol(value: string | string[] | undefined): void {
  const offered = (Array.isArray(value) ? value.join(",") : (value ?? ""))
    .split(",")
    .map((entry) => entry.trim());
  if (!offered.includes(ACP_WEBSOCKET_SUBPROTOCOL)) {
    throw new AcpAdapterError(
      426,
      "acp_subprotocol_required",
      `WebSocket subprotocol ${ACP_WEBSOCKET_SUBPROTOCOL} is required`,
    );
  }
}

function validateCwd(requested: string, expected: string): void {
  if (!isAbsolute(requested) || resolve(requested) !== resolve(expected)) {
    throw RequestError.invalidParams({ cwd: requested }, "ACP cwd does not match the scoped session");
  }
}

function rejectMcpServers(servers: NewSessionRequest["mcpServers"] | LoadSessionRequest["mcpServers"]): void {
  if (servers.length > 0) {
    throw RequestError.invalidParams({}, "MCP servers are not supported by this ACP adapter");
  }
}

function requireThinkingLevel(value: string): ThinkingLevel {
  if (!(THINKING_LEVELS as readonly string[]).includes(value)) {
    throw RequestError.invalidParams({ modeId: value }, "Unknown thinking level");
  }
  return value as ThinkingLevel;
}

function modelValue(provider: string, modelId: string): string {
  return `${provider}/${modelId}`;
}

function parseModelValue(value: string): { provider: string; modelId: string } {
  const separator = value.indexOf("/");
  if (separator <= 0 || separator === value.length - 1) {
    throw RequestError.invalidParams({ value }, "Model value must be provider/modelId");
  }
  return { provider: value.slice(0, separator), modelId: value.slice(separator + 1) };
}

function thinkingName(level: string): string {
  return level === "off" ? "Off" : level[0]!.toUpperCase() + level.slice(1);
}

function parseGeneration(value: string | null): number | undefined {
  if (value === null) return undefined;
  if (!/^\d+$/.test(value)) throw new AcpAdapterError(400, "invalid_generation", "generation is invalid");
  const generation = Number(value);
  if (!Number.isSafeInteger(generation) || generation < 0) {
    throw new AcpAdapterError(400, "invalid_generation", "generation is invalid");
  }
  return generation;
}

function resolveLimits(overrides: Partial<AcpAdapterLimits>): AcpAdapterLimits {
  const limits = { ...DEFAULT_ACP_ADAPTER_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  }
  if (limits.maxListSessions > 100) {
    throw new Error("maxListSessions must not exceed the catalog page maximum of 100");
  }
  if (limits.maxMessageBytes > limits.maxOutboundBytesPerConnection) {
    throw new Error("maxMessageBytes must not exceed maxOutboundBytesPerConnection");
  }
  return limits;
}

function adapterError(error: unknown): AcpAdapterError {
  if (error instanceof AcpAdapterError) return error;
  if (error instanceof WebSocketHandshakeError) {
    return new AcpAdapterError(error.status, error.code, error.message);
  }
  if (error instanceof MultiplexerError) {
    const status = error.code === "session_not_found" ? 404 : error.code === "session_not_resident" ? 409 : 422;
    return new AcpAdapterError(status, error.code, error.message, error.retryable);
  }
  return new AcpAdapterError(500, "acp_attach_failed", "ACP attachment failed");
}

function hubKey(sessionId: string, generation: number): string {
  return `${sessionId}\u0000${generation}`;
}

function responseData(response: RpcResponse): unknown {
  return "data" in response ? response.data : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
