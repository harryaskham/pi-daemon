import {
  DASH_API_VERSION,
  DASH_DEFAULT_LIMITS,
  DASH_PERFORMANCE_BUDGETS,
  DASH_STREAM_SUBPROTOCOL,
  asDashboardCursor,
} from "@harryaskham/pi-daemon/dashboard-contract";
import type {
  ActivationRequest,
  ActivationTicket,
  DashboardBackend,
  DashboardCapabilities,
  DashboardChannel,
  DashboardChannelEvent,
  DashboardChannelListener,
  DashboardCommand,
  DashboardCommandOperation,
  DashboardCommandResult,
  DashboardControllerRole,
  DashboardCursor,
  DashboardSessionIdentity,
  DashboardTuiChannel,
  NormalizedTranscriptRecord,
  SessionChannelOptions,
  SessionExportRequest,
  SessionExportTicket,
  SessionInfoResource,
  TuiChannelOptions,
} from "@harryaskham/pi-daemon/dashboard-contract";
import type { JsonObject, JsonValue, SessionResource } from "@harryaskham/pi-daemon/session-api";
import { LocalFixtureBackend } from "./fixture-backend";
import { createTranscriptFixtures, createTranscriptShowcaseFixtures } from "./fixtures";
import type { SessionFixture } from "./model";

const COMMANDS: DashboardCommandOperation[] = [
  "get_state", "get_entries", "get_session_stats", "get_commands", "get_available_models",
  "prompt", "steer", "follow_up", "abort", "set_model", "set_thinking_level",
  "set_steering_mode", "set_follow_up_mode", "compact", "set_auto_compaction",
  "set_auto_retry", "abort_retry", "set_session_name", "get_tree", "fork", "clone",
];
const READ_ONLY = new Set<DashboardCommandOperation>([
  "get_state", "get_entries", "get_session_stats", "get_commands", "get_available_models", "get_tree",
]);

export class LiveFixtureDashboardBackend extends LocalFixtureBackend implements DashboardBackend {
  #liveTranscript?: NormalizedTranscriptRecord[];
  readonly #activations = new Map<string, ActivationTicket>();
  readonly #exports = new Map<string, SessionExportTicket>();
  readonly #hubs = new Map<string, FixtureRichHub>();

  override get transcript(): NormalizedTranscriptRecord[] {
    return this.#liveTranscript ??= [
      ...createTranscriptFixtures(1_192),
      ...createTranscriptShowcaseFixtures(),
    ];
  }

  async capabilities(): Promise<DashboardCapabilities> {
    return {
      apiVersion: DASH_API_VERSION,
      streamSubprotocol: DASH_STREAM_SUBPROTOCOL,
      sameBrowserProtocolAcrossDeployments: true,
      authentication: { browserSession: "http-only-cookie", csrf: "same-origin-header", daemonBearerExposed: false },
      resources: { inventory: true, transcriptPreview: true, activation: true, export: true, workspaces: true, settings: true, schedules: false },
      presentations: {
        rich: { available: true, replay: true, controller: true, commands: [...COMMANDS] },
        tui: { available: false, replay: true, controller: true, commands: [...COMMANDS], unavailableReason: "fixture-uses-local-tui-story" },
      },
      limits: { ...DASH_DEFAULT_LIMITS },
      performanceBudgets: { ...DASH_PERFORMANCE_BUDGETS },
    };
  }

  async getSessionInfo(inventoryId: string): Promise<SessionInfoResource> {
    const session = await this.getSessionView(inventoryId);
    const hub = this.#hubs.get(session.sessionId);
    const controllerConnectionId = hub?.controllerId;
    return {
      ...session,
      source: {
        canonicalPath: `/fixture/sessions/${session.sessionId}.jsonl`,
        aliases: [],
      },
      ownership: {
        mode: session.managed === undefined ? "none" : session.sourceKind === "imported" ? "imported" : "direct",
      },
      diagnostics: [],
      runtime: {
        model: { provider: "fixture", id: session.model, thinkingLevel: session.thinking },
        ...(controllerConnectionId === undefined ? {} : { controllerConnectionId }),
        readerCount: hub?.size ?? 0,
        warmLeaseCount: hub?.size ?? 0,
        isolation: "unisolated",
      },
    };
  }

  async activateSession(inventoryId: string, request: ActivationRequest): Promise<ActivationTicket> {
    const session = await this.getSessionView(inventoryId);
    const ticket: ActivationTicket = {
      ticketId: `activation-${request.idempotencyKey}`,
      requestId: request.requestId,
      idempotencyKey: request.idempotencyKey,
      inventoryId,
      mode: request.mode,
      state: request.mode === "preview-only" ? "failed" : "succeeded",
      submittedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...(request.mode === "preview-only"
        ? { error: { code: "preview_only", message: "Preview-only sessions cannot activate", retryable: false } }
        : { managedSession: { sessionId: session.sessionId, generation: session.generation } }),
    };
    this.#activations.set(ticket.ticketId, ticket);
    return structuredClone(ticket);
  }

  async getActivation(ticketId: string): Promise<ActivationTicket> {
    const ticket = this.#activations.get(ticketId);
    if (!ticket) throw new Error("activation ticket not found");
    return structuredClone(ticket);
  }

  async exportSession(sessionRef: string, request: SessionExportRequest): Promise<SessionExportTicket> {
    const ticket: SessionExportTicket = {
      ticketId: `export-${request.idempotencyKey}`,
      requestId: request.requestId,
      idempotencyKey: request.idempotencyKey,
      sessionRef,
      mode: request.mode,
      state: request.mode === "append-to-origin" ? "indeterminate" : "succeeded",
      submittedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...(request.mode === "as-new" ? { exportedInventoryId: `exported-${sessionRef}` } : {}),
    };
    this.#exports.set(ticket.ticketId, ticket);
    return structuredClone(ticket);
  }

  async getExport(ticketId: string): Promise<SessionExportTicket> {
    const ticket = this.#exports.get(ticketId);
    if (!ticket) throw new Error("export ticket not found");
    return structuredClone(ticket);
  }

  async getManagedSession(sessionRef: string): Promise<SessionResource> {
    const session = this.sessions.find((candidate) => candidate.sessionId === sessionRef);
    if (!session) throw new Error("managed session not found");
    return resource(session);
  }

  async openSessionChannel(options: SessionChannelOptions): Promise<DashboardChannel> {
    const session = this.sessions.find((candidate) => candidate.sessionId === options.sessionRef);
    if (!session) throw new Error("managed session not found");
    if (options.generation !== undefined && options.generation !== session.generation) throw new Error("stale generation");
    let hub = this.#hubs.get(session.sessionId);
    if (!hub) {
      hub = new FixtureRichHub(session, this.transcript.slice(-200), () => this.#hubs.delete(session.sessionId));
      this.#hubs.set(session.sessionId, hub);
    }
    return hub.open(options);
  }

  async openTuiChannel(_options: TuiChannelOptions): Promise<DashboardTuiChannel> {
    throw new Error("fixture TUI channel is unavailable");
  }
}

class FixtureRichHub {
  readonly session: SessionFixture;
  readonly identity: DashboardSessionIdentity;
  readonly records: NormalizedTranscriptRecord[];
  readonly #onIdle: () => void;
  readonly #channels = new Map<string, FixtureRichChannel>();
  readonly #events: Array<{ sequence: number; cursor: DashboardCursor; event: DashboardChannelEvent }> = [];
  #controllerId: string | undefined;
  #sequence = 0;
  #model: string;
  #thinking: string;

  constructor(session: SessionFixture, records: NormalizedTranscriptRecord[], onIdle: () => void) {
    this.session = session;
    this.records = structuredClone(records);
    this.identity = { hostInstanceId: "fixture-host-01", sessionId: session.sessionId, generation: session.generation };
    this.#onIdle = onIdle;
    this.#model = session.model;
    this.#thinking = session.thinking;
  }

  get size(): number { return this.#channels.size; }
  get controllerId(): string | undefined { return this.#controllerId; }

  open(options: SessionChannelOptions): DashboardChannel {
    const id = crypto.randomUUID();
    const granted = options.role === "controller" && this.#controllerId === undefined;
    if (granted) this.#controllerId = id;
    const role = granted ? "controller" : "observer";
    const pending = replay(this.#events, options.cursor, this.identity, this.#cursor(this.#sequence));
    if (options.role === "controller" && !granted) {
      pending.push({ kind: "control", identity: this.identity, action: "control_denied", reason: "controller already held" });
    }
    const channel = new FixtureRichChannel(id, role, this.#snapshot(), pending, this);
    this.#channels.set(id, channel);
    return channel;
  }

  async command(id: string, command: DashboardCommand): Promise<DashboardCommandResult> {
    const channel = this.#require(id);
    if (channel.role !== "controller" && !READ_ONLY.has(command.operation)) return rejected(command.correlationId, "controller_required", "Controller role is required");
    if (command.operation === "get_state") return completed(command.correlationId, this.#rpcState());
    if (command.operation === "get_entries") {
      return completed(command.correlationId, { records: this.records } as unknown as JsonValue);
    }
    if (command.operation === "get_session_stats") return completed(command.correlationId, { contextPercent: this.session.contextPercent, messages: this.records.length });
    if (command.operation === "get_commands") return completed(command.correlationId, { commands: ["/model", "/thinking", "/compact", "/name", "/abort"] });
    if (command.operation === "get_available_models") return completed(command.correlationId, { models: ["gpt-5.6", "claude-opus-4.8", "gpt-5-mini"] });
    if (command.operation === "prompt") {
      const text = typeof command.payload?.message === "string" ? command.payload.message : "Fixture prompt";
      this.#publish({ type: "agent_start" });
      this.#publish({
        type: "message_update",
        normalizedRecord: messageRecord(`live-${this.#sequence}`, "assistant", `Streaming fixture response to: ${text}`, "live", "streaming"),
      });
      globalThis.setTimeout(() => {
        const record = messageRecord(`durable-${this.#sequence}`, "assistant", `Completed fixture response to: ${text}`, "persisted", "complete");
        this.records.push(record);
        this.#publish({ type: "entry_appended", record });
        if (text.includes("extension")) {
          this.#broadcast({ kind: "extension_ui", identity: this.identity, requestId: "fixture-extension", method: "confirm", payload: { title: "Extension confirmation", message: "Continue fixture?" } });
        }
        this.#publish({ type: "agent_settled" });
      }, 80);
      return { correlationId: command.correlationId, state: "streaming" };
    }
    if (command.operation === "steer" || command.operation === "follow_up") {
      this.#publish({ type: "queue", mode: command.operation, normalizedRecord: timelineRecord(`queue-${this.#sequence}`, `${command.operation} queued`) });
      return completed(command.correlationId);
    }
    if (command.operation === "abort") {
      this.#publish({ type: "agent_settled", reason: "aborted" });
      return completed(command.correlationId);
    }
    if (command.operation === "set_model" && typeof command.payload?.modelId === "string") this.#model = command.payload.modelId;
    if (command.operation === "set_thinking_level" && typeof command.payload?.level === "string") this.#thinking = command.payload.level;
    const label = `${command.operation.replaceAll("_", " ")} completed`;
    this.#publish({ type: command.operation, normalizedRecord: timelineRecord(`timeline-${this.#sequence}`, label) });
    return completed(command.correlationId, this.#rpcState());
  }

  requestControl(id: string, correlationId: string): DashboardCommandResult {
    const channel = this.#require(id);
    if (this.#controllerId && this.#controllerId !== id) return rejected(correlationId, "controller_busy", "Another pane owns control");
    this.#controllerId = id;
    channel.setRole("controller");
    this.#broadcast({ kind: "control", identity: this.identity, action: "control_granted", connectionId: id });
    return completed(correlationId, { role: "controller" });
  }

  releaseControl(id: string, correlationId: string): DashboardCommandResult {
    const channel = this.#require(id);
    if (this.#controllerId !== id) return rejected(correlationId, "controller_required", "Pane does not own control");
    this.#controllerId = undefined;
    channel.setRole("observer");
    this.#broadcast({ kind: "control", identity: this.identity, action: "control_released", connectionId: id });
    return completed(correlationId, { role: "observer" });
  }

  answerExtension(id: string, requestId: string): void {
    if (this.#require(id).role !== "controller") throw new Error("Controller role is required");
    if (requestId !== "fixture-extension") throw new Error("Extension request not found");
  }

  remove(id: string): void {
    this.#channels.delete(id);
    if (this.#controllerId === id) this.#controllerId = undefined;
    if (this.#channels.size === 0) this.#onIdle();
  }

  #snapshot() {
    return {
      identity: this.identity,
      session: resource(this.session),
      rpcState: this.#rpcState(),
      requestState: { queued: 0 },
      entries: structuredClone(this.records),
      currentLeafId: this.session.currentLeafId ?? null,
      highWaterCursor: this.#cursor(this.#sequence),
    };
  }

  #rpcState(): JsonObject {
    return { model: this.#model, thinkingLevel: this.#thinking, isStreaming: false, commands: COMMANDS };
  }

  #publish(event: Record<string, unknown>): void {
    const sequence = ++this.#sequence;
    const cursor = this.#cursor(sequence);
    const wrapped: DashboardChannelEvent = {
      kind: "session_event",
      identity: this.identity,
      cursor,
      sequence,
      event: event as import("@harryaskham/pi-daemon/session-api").PiRpcEvent,
    };
    this.#events.push({ sequence, cursor, event: wrapped });
    while (this.#events.length > 64) this.#events.shift();
    this.#broadcast(wrapped);
  }

  #broadcast(event: DashboardChannelEvent): void {
    for (const channel of this.#channels.values()) channel.deliver(event);
  }

  #cursor(sequence: number): DashboardCursor {
    return asDashboardCursor(`fixture:rich:${this.session.generation}:${sequence}`);
  }

  #require(id: string): FixtureRichChannel {
    const channel = this.#channels.get(id);
    if (!channel) throw new Error("Channel closed");
    return channel;
  }
}

class FixtureRichChannel implements DashboardChannel {
  readonly presentation = "rich" as const;
  readonly identity;
  readonly snapshot;
  readonly #id: string;
  readonly #hub: FixtureRichHub;
  readonly #pending: DashboardChannelEvent[];
  readonly #listeners = new Set<DashboardChannelListener<DashboardChannelEvent>>();
  #role: DashboardControllerRole;
  #closed = false;

  constructor(id: string, role: DashboardControllerRole, snapshot: DashboardChannel["snapshot"], pending: DashboardChannelEvent[], hub: FixtureRichHub) {
    this.#id = id;
    this.#role = role;
    this.snapshot = snapshot;
    this.identity = snapshot.identity;
    this.#pending = pending;
    this.#hub = hub;
  }

  get role(): DashboardControllerRole { return this.#role; }
  setRole(role: DashboardControllerRole): void { this.#role = role; }
  command(command: DashboardCommand): Promise<DashboardCommandResult> { return this.#hub.command(this.#id, command); }
  async requestControl(correlationId: string) { return this.#hub.requestControl(this.#id, correlationId); }
  async releaseControl(correlationId: string) { return this.#hub.releaseControl(this.#id, correlationId); }
  async answerExtensionUi(requestId: string, _response: JsonObject) { this.#hub.answerExtension(this.#id, requestId); }
  subscribe(listener: DashboardChannelListener<DashboardChannelEvent>) {
    this.#listeners.add(listener);
    for (const event of this.#pending.splice(0)) listener(structuredClone(event));
    return () => this.#listeners.delete(listener);
  }
  deliver(event: DashboardChannelEvent) { if (!this.#closed) for (const listener of this.#listeners) listener(structuredClone(event)); }
  async close() { if (!this.#closed) { this.#closed = true; this.#listeners.clear(); this.#hub.remove(this.#id); } }
}

function replay(
  events: Array<{ sequence: number; cursor: DashboardCursor; event: DashboardChannelEvent }>,
  cursor: DashboardCursor | undefined,
  identity: DashboardSessionIdentity,
  highWaterCursor: DashboardCursor,
): DashboardChannelEvent[] {
  if (!cursor) return [];
  const match = /:(\d+)$/.exec(cursor);
  const sequence = match ? Number(match[1]) : Number.NaN;
  if (!Number.isSafeInteger(sequence)) {
    return [{ kind: "replay_gap", identity, reason: "cursor-expired", requestedCursor: cursor, highWaterCursor, snapshotFollows: true }];
  }
  const oldest = events[0]?.sequence ?? sequence;
  if (sequence < oldest - 1) {
    return [{ kind: "replay_gap", identity, reason: "cursor-expired", requestedCursor: cursor, highWaterCursor, ...(events[0] ? { oldestAvailableCursor: events[0].cursor } : {}), snapshotFollows: true }];
  }
  return events.filter((event) => event.sequence > sequence).map((event) => structuredClone(event.event));
}

function resource(session: SessionFixture): SessionResource {
  return {
    sessionId: session.sessionId,
    name: session.title,
    generation: session.generation,
    revision: session.managed?.revision ?? 1,
    residency: "resident",
    state: session.presence.runtime === "running" ? "running" : "idle",
    createdAt: session.createdAt,
    updatedAt: session.modifiedAt,
    lastUsedAt: session.modifiedAt,
    spec: { cwd: session.cwd, target: { mode: "memory" }, isolation: { mode: "unisolated" } },
    environment: { keys: [], persistence: "memory-only", provisioned: true },
    links: { self: `/v1/session/${session.sessionId}`, rpc: `/v1/session/${session.sessionId}/rpc`, apc: `/v1/session/${session.sessionId}/apc` },
  };
}

function messageRecord(id: string, role: "user" | "assistant", text: string, source: "persisted" | "live" | "optimistic", state: "complete" | "streaming" | "error"): NormalizedTranscriptRecord {
  return { recordId: id, key: { entryId: id, messageId: id }, kind: "message", role, state, source, timestamp: new Date().toISOString(), content: [{ type: "markdown", text }] };
}

function timelineRecord(id: string, label: string): NormalizedTranscriptRecord {
  return { recordId: id, key: { entryId: id }, kind: "timeline", event: "queue", label, source: "live", timestamp: new Date().toISOString() };
}

function completed(correlationId: string, data?: JsonValue): DashboardCommandResult {
  return { correlationId, state: "completed", ...(data === undefined ? {} : { data }) };
}

function rejected(correlationId: string, code: string, message: string): DashboardCommandResult {
  return { correlationId, state: "rejected", error: { code, message, retryable: true } };
}

export const liveFixtureBackend = new LiveFixtureDashboardBackend();
