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
  DashboardScheduleDeleteRequest,
  DashboardScheduleMutationRequest,
  DashboardScheduleResource,
  DashboardScheduleStatus,
  DashboardScheduleWrite,
  DashboardSessionIdentity,
  DashboardTuiChannel,
  NormalizedTranscriptRecord,
  SessionChannelOptions,
  SessionExportRequest,
  SessionExportTicket,
  SessionInfoResource,
  TuiChannelOptions,
} from "@harryaskham/pi-daemon/dashboard-contract";
import type {
  DashboardSessionDraftCancelRequest,
  DashboardSessionDraftCreateRequest,
  DashboardSessionDraftResource,
  DashboardSessionDraftSendRequest,
  DashboardSessionDraftSendTicket,
} from "@harryaskham/pi-daemon/dashboard-session-draft-contract";
import type { ScheduleCapabilities } from "@harryaskham/pi-daemon/schedule-contract";
import { EXTENSION_VIEW_CAPABILITY } from "@harryaskham/pi-daemon/extension-view-contract";
import { createExtensionViewFixture } from "@harryaskham/pi-daemon/extension-view-fixtures";
import type { JsonObject, JsonValue, SessionResource } from "@harryaskham/pi-daemon/session-api";
import { LocalFixtureBackend } from "./fixture-backend";
import { createTranscriptFixtures, createTranscriptShowcaseFixtures } from "./fixtures";
import type { SessionFixture } from "./model";

const COMMANDS: DashboardCommandOperation[] = [
  "get_state", "get_entries", "get_session_stats", "get_commands", "get_available_models",
  "prompt", "steer", "follow_up", "abort", "set_model", "set_thinking_level",
  "set_steering_mode", "set_follow_up_mode", "compact", "set_auto_compaction",
  "set_auto_retry", "abort_retry", "set_session_name", "get_tree", "navigate_tree", "fork", "clone",
];
const READ_ONLY = new Set<DashboardCommandOperation>([
  "get_state", "get_entries", "get_session_stats", "get_commands", "get_available_models", "get_tree",
]);

export class LiveFixtureDashboardBackend extends LocalFixtureBackend implements DashboardBackend {
  #liveTranscript?: NormalizedTranscriptRecord[];
  readonly #activations = new Map<string, ActivationTicket>();
  readonly #exports = new Map<string, SessionExportTicket>();
  readonly #hubs = new Map<string, FixtureRichHub>();
  readonly #schedules = new Map<string, DashboardScheduleResource>();
  readonly #drafts = new Map<string, DashboardSessionDraftResource>();
  readonly #draftTickets = new Map<string, DashboardSessionDraftSendTicket>();

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
      resources: { inventory: true, transcriptPreview: true, activation: true, export: true, workspaces: true, settings: true, schedules: false, sessionDrafts: true, treeNavigation: true },
      presentations: {
        rich: { available: true, replay: true, controller: true, commands: [...COMMANDS] },
        tui: { available: false, replay: true, controller: true, commands: [...COMMANDS], unavailableReason: "fixture-uses-local-tui-story" },
      },
      extensionViews: structuredClone(EXTENSION_VIEW_CAPABILITY),
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
    if (request.mode !== "preview-only") session.activityAt = new Date().toISOString();
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

  async createSessionDraft(request: DashboardSessionDraftCreateRequest): Promise<DashboardSessionDraftResource> {
    const existing = [...this.#drafts.values()].find((draft) => draft.draftId === request.draftId);
    if (existing !== undefined) return structuredClone(existing);
    const now = new Date().toISOString();
    const draft: DashboardSessionDraftResource = {
      contractVersion: "1.0",
      draftId: request.draftId ?? `draft-${request.idempotencyKey}`,
      revision: 1,
      state: "draft",
      createdAt: now,
      updatedAt: now,
      spec: structuredClone(request.spec),
      firstMessageStartsSession: true,
    };
    this.#drafts.set(draft.draftId, draft);
    return structuredClone(draft);
  }
  async getSessionDraft(draftId: string): Promise<DashboardSessionDraftResource> {
    const draft = this.#drafts.get(draftId);
    if (draft === undefined) throw new Error("fixture draft not found");
    return structuredClone(draft);
  }
  async cancelSessionDraft(draftId: string, request: DashboardSessionDraftCancelRequest): Promise<DashboardSessionDraftResource> {
    const current = await this.getSessionDraft(draftId);
    if (current.revision !== request.expectedRevision) throw new Error("fixture draft revision conflict");
    const cancelled: DashboardSessionDraftResource = {
      ...current,
      revision: current.revision + 1,
      state: "cancelled",
      updatedAt: new Date().toISOString(),
    };
    this.#drafts.set(draftId, cancelled);
    return structuredClone(cancelled);
  }
  async sendSessionDraft(draftId: string, request: DashboardSessionDraftSendRequest): Promise<DashboardSessionDraftSendTicket> {
    const current = await this.getSessionDraft(draftId);
    if (current.revision !== request.expectedRevision) throw new Error("fixture draft revision conflict");
    const now = new Date().toISOString();
    const session = { sessionId: `session-${draftId}`, generation: 1 };
    const ticket: DashboardSessionDraftSendTicket = {
      ticketId: `draft-send-${request.idempotencyKey}`,
      draftId,
      draftRevision: request.expectedRevision,
      requestId: request.requestId,
      idempotencyKey: request.idempotencyKey,
      state: "succeeded",
      submittedAt: now,
      updatedAt: now,
      session,
    };
    this.#draftTickets.set(ticket.ticketId, ticket);
    this.#drafts.set(draftId, {
      ...current,
      revision: current.revision + 1,
      state: "live",
      updatedAt: now,
      materialization: { ticketId: ticket.ticketId, state: "succeeded", session },
    });
    if (!this.sessions.some((candidate) => candidate.sessionId === session.sessionId)) {
      const project = current.spec.cwd.split("/").filter(Boolean).at(-2) ?? "fixture";
      this.sessions.unshift({
        inventoryId: `draft-live:${draftId}`,
        sourceKind: "memory",
        title: current.spec.name ?? "New session",
        cwdBasename: current.spec.cwd.split("/").filter(Boolean).at(-1) ?? "session",
        projectLabel: project,
        createdAt: now,
        modifiedAt: now,
        messageCount: 0,
        entryCount: 0,
        toolCallCount: 0,
        managed: {
          sessionId: session.sessionId,
          generation: session.generation,
          revision: 1,
          residency: "resident",
          state: "idle",
        },
        activation: { eligible: true, modes: ["reuse", "fork"] },
        presence: {
          runtime: "resident-idle",
          activation: "user-turn",
          focusedPaneCount: 1,
          unread: false,
        },
        sessionId: session.sessionId,
        generation: session.generation,
        cwd: current.spec.cwd,
        project,
        model: current.spec.model?.id ?? "gpt-5.6",
        thinking:
          current.spec.model?.thinkingLevel === "xhigh" || current.spec.model?.thinkingLevel === "max"
            ? "high"
            : current.spec.model?.thinkingLevel ?? "off",
        contextPercent: 0,
      });
    }
    return structuredClone(ticket);
  }
  async getSessionDraftSend(ticketId: string): Promise<DashboardSessionDraftSendTicket> {
    const ticket = this.#draftTickets.get(ticketId);
    if (ticket === undefined) throw new Error("fixture draft ticket not found");
    return structuredClone(ticket);
  }

  async scheduleCapabilities(): Promise<ScheduleCapabilities> { return fixtureScheduleCapabilities(); }
  async listSchedules(sessionRef?: string): Promise<DashboardScheduleResource[]> {
    if (this.#schedules.size === 0 && sessionRef !== undefined) this.#schedules.set("weekday-review", fixtureSchedule(sessionRef));
    return [...this.#schedules.values()].filter((item) => sessionRef === undefined || item.sessionRef === sessionRef).map((item) => structuredClone(item));
  }
  async getSchedule(scheduleId: string): Promise<DashboardScheduleResource> {
    const resource = this.#schedules.get(scheduleId);
    if (resource === undefined) throw new Error("fixture schedule not found");
    return structuredClone(resource);
  }
  async createSchedule(request: DashboardScheduleMutationRequest): Promise<DashboardScheduleResource> {
    if (this.#schedules.has(request.schedule.scheduleId)) throw new Error("schedule already exists");
    const resource = fixtureResourceFromWrite(request.schedule, 0);
    this.#schedules.set(resource.scheduleId, resource);
    return structuredClone(resource);
  }
  async updateSchedule(scheduleId: string, request: DashboardScheduleMutationRequest): Promise<DashboardScheduleResource> {
    const current = this.#schedules.get(scheduleId);
    if (current === undefined) throw new Error("fixture schedule not found");
    if (request.expectedRevision !== current.revision) throw new Error("schedule revision conflict");
    const updated = { ...fixtureResourceFromWrite(request.schedule, current.revision + 1), createdAt: current.createdAt, ...(current.lastTrigger === undefined ? {} : { lastTrigger: current.lastTrigger }) };
    this.#schedules.set(scheduleId, updated);
    return structuredClone(updated);
  }
  async deleteSchedule(scheduleId: string, request: DashboardScheduleDeleteRequest): Promise<void> {
    const current = this.#schedules.get(scheduleId);
    if (current === undefined || current.revision !== request.expectedRevision) throw new Error("schedule revision conflict");
    this.#schedules.delete(scheduleId);
  }
  async scheduleStatus(): Promise<DashboardScheduleStatus> {
    const schedules = [...this.#schedules.values()];
    return { timerRuntime: false, externalTimersSupported: true, scheduleCount: schedules.length, enabledCount: schedules.filter((item) => item.enabled).length, ...(schedules[0]?.nextTriggerAt === undefined ? {} : { nextWakeAt: schedules[0].nextTriggerAt }) };
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
    if (command.operation === "get_tree") return completed(command.correlationId, fixtureSessionTree() as unknown as JsonValue);
    if (command.operation === "navigate_tree") {
      const entryId = typeof command.payload?.entryId === "string" ? command.payload.entryId : "";
      return completed(command.correlationId, {
        cancelled: false,
        ...(entryId === "tree-left" ? { editorText: "Try the abandoned approach" } : {}),
        ...(command.payload?.summarize === true ? { summaryEntryId: "tree-summary-new" } : {}),
      });
    }
    if (command.operation === "fork") {
      const entryId = typeof command.payload?.entryId === "string" ? command.payload.entryId : "";
      return completed(command.correlationId, { text: entryId === "tree-left" ? "Try the abandoned approach" : "", cancelled: false });
    }
    if (command.operation === "clone") return completed(command.correlationId, { cancelled: false });
    if (command.operation === "prompt") {
      const text = typeof command.payload?.message === "string" ? command.payload.message : "Fixture prompt";
      this.#publish({ type: "agent_start" });
      this.#publish({
        type: "message_update",
        normalizedRecord: messageRecord(`live-${this.#sequence}`, "assistant", `Streaming fixture response to: ${text}`, "live", "streaming"),
      });
      if (text.includes("raw Pi events")) {
        const rawMessage = { role: "assistant", content: [{ type: "text", text: "Raw Pi stream" }], timestamp: new Date().toISOString() };
        this.#publish({ type: "message_start", message: rawMessage });
        this.#publish({ type: "message_update", message: { ...rawMessage, content: [{ type: "text", text: "Raw Pi stream updated" }] }, assistantMessageEvent: { type: "text_delta", delta: " updated" } });
        this.#publish({ type: "tool_execution_start", toolCallId: "raw-tool", toolName: "read", args: { path: "raw.txt" } });
        this.#publish({ type: "tool_execution_end", toolCallId: "raw-tool", toolName: "read", result: { content: [{ type: "text", text: "raw tool complete" }] }, isError: false });
        this.#publish({ type: "message_end", message: { ...rawMessage, content: [{ type: "text", text: "Raw Pi stream complete" }] } });
        this.#publish({ type: "entry_appended", entry: { id: "raw-entry", parentId: null, type: "message", timestamp: new Date().toISOString(), message: { ...rawMessage, content: [{ type: "text", text: "Raw Pi stream persisted" }] } } });
      }
      globalThis.setTimeout(() => {
        const record = messageRecord(`durable-${this.#sequence}`, "assistant", `Completed fixture response to: ${text}`, "persisted", "complete");
        this.records.push(record);
        this.#publish({ type: "entry_appended", record });
        if (text.includes("extension")) {
          this.#broadcast({ kind: "extension_ui", identity: this.identity, requestId: "fixture-extension", method: "confirm", payload: { title: "Extension confirmation", message: "Continue fixture?" } });
        }
        if (text.includes("declarative extension view")) {
          const view = createExtensionViewFixture();
          this.#broadcast({
            kind: "extension_view",
            identity: this.identity,
            requestId: "fixture-extension-view",
            provenance: { transport: "pi-rpc", validator: "pi-daemon", validation: "validated", browserCodeExecution: false },
            fallback: { text: view.fallbackText, reason: "unsupported-renderer" },
            view,
          });
        }
        if (text.includes("extension surfaces")) {
          this.#broadcast({ kind: "extension_ui", identity: this.identity, requestId: "fixture-notify", method: "notify", payload: { message: "Fixture notification", notifyType: "warning" } });
          this.#broadcast({ kind: "extension_ui", identity: this.identity, requestId: "fixture-status", method: "setStatus", payload: { statusKey: "fixture", statusText: "Extension active" } });
          this.#broadcast({ kind: "extension_ui", identity: this.identity, requestId: "fixture-widget", method: "setWidget", payload: { widgetKey: "fixture", widgetLines: ["Fixture widget", "bounded line"], widgetPlacement: "aboveEditor" } });
          this.#broadcast({ kind: "extension_ui", identity: this.identity, requestId: "fixture-title", method: "setTitle", payload: { title: "Fixture extension title" } });
          this.#broadcast({ kind: "extension_ui", identity: this.identity, requestId: "fixture-editor", method: "set_editor_text", payload: { text: "prefilled extension text" } });
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
    if (!["fixture-extension", "fixture-extension-view"].includes(requestId)) throw new Error("Extension request not found");
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

function fixtureScheduleCapabilities(): ScheduleCapabilities {
  return {
    contractVersion: "1.0", persistence: true, timerRuntime: false,
    cronSyntax: "posix-five-field", timezoneDatabase: "runtime-iana",
    optimisticConcurrency: "expected-revision", overlapPolicies: ["skip", "queue-one", "reject"],
    missedWakePolicies: ["skip", "run-once", "bounded-catch-up"],
    promptHandling: "owner-private-sensitive-content", terminalTicketSummary: "content-free",
    clock: "wall-clock-utc-instants",
    limits: { maxSchedules: 1_024, maxSchedulesPerSession: 32, maxPromptBytes: 65_536, maxRecordBytes: 131_072, maxRecoveryBytes: 134_217_728, maxCatchUpRuns: 24, maxJitterMs: 86_400_000, maxAdmissionDelayMs: 86_400_000 },
  };
}

function fixtureResourceFromWrite(write: DashboardScheduleWrite, revision: number): DashboardScheduleResource {
  const now = new Date().toISOString();
  const { prompt: _prompt, ...safeWrite } = write;
  return {
    contractVersion: "1.0",
    ...safeWrite,
    promptConfigured: true,
    revision,
    nextTriggerAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    createdAt: now,
    updatedAt: now,
  };
}

function fixtureSchedule(sessionRef: string): DashboardScheduleResource {
  const resource = fixtureResourceFromWrite({ scheduleId: "weekday-review", sessionRef, enabled: true, cron: "0 9 * * 1-5", timezone: "Europe/London", overlapPolicy: "queue-one", missedWakePolicy: { mode: "run-once" }, jitterMs: 30_000, maxAdmissionDelayMs: 300_000, execution: { model: { provider: "anthropic", id: "claude-sonnet" }, thinkingLevel: "medium" } }, 3);
  return {
    ...resource,
    lastTrigger: { scheduledFor: new Date(Date.now() - 86_400_000).toISOString(), observedAt: new Date(Date.now() - 86_399_000).toISOString(), disposition: "admitted", terminalTicket: { ticketId: "ticket-fixture-complete", state: "completed", updatedAt: new Date(Date.now() - 86_300_000).toISOString() } },
  };
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

function fixtureSessionTree(): JsonObject {
  const at = (minute: number) => `2026-07-22T12:${String(minute).padStart(2, "0")}:00.000Z`;
  const entry = (id: string, parentId: string | null, text: string, minute: number) => ({
    type: "message",
    id,
    parentId,
    timestamp: at(minute),
    message: { role: "user", content: [{ type: "text", text }] },
  });
  if (typeof globalThis.location === "object" && new URLSearchParams(globalThis.location.search).get("tree") === "large") {
    const children = Array.from({ length: 9_999 }, (_, index) => ({
      entry: entry(`tree-large-${index}`, "tree-large-root", `Branch ${index}`, index % 60),
      ...(index % 500 === 0 ? { label: `checkpoint-${index}`, labelTimestamp: at(index % 60) } : {}),
      children: [],
    }));
    return {
      leafId: "tree-large-9998",
      tree: [{ entry: entry("tree-large-root", null, "Large tree root", 0), children }],
    } as unknown as JsonObject;
  }
  return {
    leafId: "tree-active-leaf",
    tree: [{
      entry: entry("tree-root", null, "Start the implementation", 0),
      children: [
        {
          entry: entry("tree-left", "tree-root", "Try the abandoned approach", 1),
          label: "experiment",
          labelTimestamp: at(2),
          children: [{
            entry: { type: "branch_summary", id: "tree-left-summary", parentId: "tree-left", timestamp: at(3), fromId: "tree-left", summary: "The experimental branch was bounded but slower." },
            children: [],
          }],
        },
        {
          entry: entry("tree-active", "tree-root", "Use the active approach", 4),
          label: "active",
          labelTimestamp: at(4),
          children: [{
            entry: { type: "model_change", id: "tree-active-leaf", parentId: "tree-active", timestamp: at(5), provider: "github-copilot", modelId: "gpt-5.6" },
            children: [],
          }],
        },
      ],
    }],
  } as unknown as JsonObject;
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
