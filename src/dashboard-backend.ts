import { randomUUID } from "node:crypto";

import type { RpcExtensionUIResponse, RpcResponse } from "@earendil-works/pi-coding-agent";

import {
  DASH_API_VERSION,
  DASH_DEFAULT_LIMITS,
  DASH_PERFORMANCE_BUDGETS,
  DASH_STREAM_SUBPROTOCOL,
  asDashboardCursor,
} from "./dashboard-contract.js";
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
  DashboardControlEvent,
  DashboardCursor,
  DashboardExtensionUiEvent,
  DashboardReplayGap,
  DashboardScheduleDeleteRequest,
  DashboardScheduleMutationRequest,
  DashboardScheduleResource,
  DashboardScheduleStatus,
  DashboardSessionEvent,
  DashboardSessionIdentity,
  DashboardTuiChannel,
  DashboardTuiChannelEvent,
  SessionChannelOptions,
  SessionExportRequest,
  SessionExportTicket,
  SessionInfoResource,
  SessionInventoryPage,
  SessionInventoryQuery,
  TranscriptPage,
  TranscriptQuery,
  TuiChannelOptions,
} from "./dashboard-contract.js";
import {
  Multiplexer,
  MultiplexerError,
  type SessionResidencyLease,
} from "./multiplexer.js";
import type {
  PiRpcController,
  PiRpcControllerOutput,
} from "./pi-rpc-controller.js";
import { catalogRecordToSessionResource } from "./session-catalog.js";
import { ensureSessionResident } from "./session-residency.js";
import type { JsonObject, JsonValue, PiRpcEvent, SessionResource } from "./session-api.js";
import type {
  DashboardSessionDraftCancelRequest,
  DashboardSessionDraftCreateRequest,
  DashboardSessionDraftExecution,
  DashboardSessionDraftResource,
  DashboardSessionDraftSendRequest,
  DashboardSessionDraftSendTicket,
  DashboardSessionDraftService,
} from "./dashboard-session-drafts.js";
import type { SessionInventory } from "./session-inventory.js";
import {
  browserScheduleResource,
  scheduleDefinition,
  scheduleStatus,
} from "./dashboard-schedule-resources.js";
import { scheduleCapabilities, type ScheduleCapabilities } from "./schedule-contract.js";
import type { SchedulerRuntime } from "./scheduler-runtime.js";
import { ScheduleStoreError, type FileScheduleStore } from "./schedule-store.js";
import type { SessionOwnershipService } from "./session-ownership.js";
import {
  TranscriptProjectionError,
  type TranscriptProjector,
} from "./transcript-projector.js";

const READ_ONLY_COMMANDS = new Set<DashboardCommandOperation>([
  "get_state",
  "get_entries",
  "get_session_stats",
  "get_commands",
  "get_available_models",
  "get_tree",
]);

export interface InProcessDashboardBackendLimits {
  maxRichHubs: number;
  maxChannelsPerHub: number;
  maxReplayEvents: number;
  maxReplayBytes: number;
  maxEventBytes: number;
  maxCommandResults: number;
  leaseTtlMs: number;
}

export const DEFAULT_IN_PROCESS_DASHBOARD_LIMITS: Readonly<InProcessDashboardBackendLimits> = {
  maxRichHubs: 64,
  maxChannelsPerHub: 32,
  maxReplayEvents: DASH_DEFAULT_LIMITS.maxReplayEvents,
  maxReplayBytes: DASH_DEFAULT_LIMITS.maxReplayBytesPerSession,
  maxEventBytes: DASH_DEFAULT_LIMITS.maxReplayEventBytes,
  maxCommandResults: 128,
  leaseTtlMs: DASH_DEFAULT_LIMITS.visibleLeaseExpiryMs,
};

export class InProcessDashboardBackendError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, message: string, retryable = false) {
    super(message);
    this.name = "InProcessDashboardBackendError";
    this.code = code;
    this.retryable = retryable;
  }
}

export interface InProcessDashboardTuiChannels {
  open(context: {
    options: TuiChannelOptions;
    identity: DashboardSessionIdentity;
    session: SessionResource;
    controller: PiRpcController;
  }): Promise<DashboardTuiChannel>;
  invalidate?(identity: DashboardSessionIdentity, reason?: string): void;
  dispose?(): void;
}

export interface InProcessDashboardBackendOptions {
  inventory: Pick<SessionInventory, "list" | "getInfo">;
  projector: Pick<TranscriptProjector, "project">;
  ownership: Pick<
    SessionOwnershipService,
    "activateSession" | "getActivation" | "exportSession" | "getExport"
  >;
  multiplexer: Multiplexer;
  schedules?: Pick<FileScheduleStore, "list" | "get" | "create" | "update" | "delete" | "limits">;
  scheduler?: Pick<SchedulerRuntime, "recompute" | "status">;
  drafts?: Pick<DashboardSessionDraftService, "create" | "get" | "cancel">;
  draftExecution?: DashboardSessionDraftExecution;
  tuiChannels?: InProcessDashboardTuiChannels;
  capabilities?: DashboardCapabilities;
  limits?: Partial<InProcessDashboardBackendLimits>;
}

interface RetainedDashboardEvent {
  sequence: number;
  cursor: DashboardCursor;
  event: DashboardChannelEvent;
  bytes: number;
}

interface RichChannelOpenResult {
  channel: DashboardChannel;
  release: () => void;
}

/**
 * Transport-free DashboardBackend over the daemon's existing policy-owning services.
 * Direct calls remove serialization overhead only; they never replace catalog,
 * ownership, generation, controller, scheduler, or durable ticket boundaries.
 */
export class InProcessDashboardBackend implements DashboardBackend {
  readonly #inventory: InProcessDashboardBackendOptions["inventory"];
  readonly #projector: InProcessDashboardBackendOptions["projector"];
  readonly #ownership: InProcessDashboardBackendOptions["ownership"];
  readonly #multiplexer: Multiplexer;
  readonly #schedules: InProcessDashboardBackendOptions["schedules"];
  readonly #scheduler: InProcessDashboardBackendOptions["scheduler"];
  readonly #drafts: InProcessDashboardBackendOptions["drafts"];
  readonly #draftExecution: DashboardSessionDraftExecution | undefined;
  readonly #tuiChannels: InProcessDashboardTuiChannels | undefined;
  readonly #capabilities: DashboardCapabilities;
  readonly #limits: InProcessDashboardBackendLimits;
  readonly #richHubs = new Map<string, InProcessRichHub>();
  readonly #scheduleMutations = new Map<string, { fingerprint: string; result: Promise<DashboardScheduleResource | void> }>();
  readonly #unsubscribeMultiplexer: () => void;
  #disposed = false;

  constructor(options: InProcessDashboardBackendOptions) {
    this.#inventory = options.inventory;
    this.#projector = options.projector;
    this.#ownership = options.ownership;
    this.#multiplexer = options.multiplexer;
    this.#schedules = options.schedules;
    this.#scheduler = options.scheduler;
    this.#drafts = options.drafts;
    this.#draftExecution = options.draftExecution;
    this.#tuiChannels = options.tuiChannels;
    this.#limits = resolveLimits(options.limits);
    this.#capabilities = options.capabilities ?? defaultCapabilities(
      options.tuiChannels !== undefined,
      options.schedules !== undefined,
      options.drafts !== undefined,
      this.#limits,
    );
    this.#unsubscribeMultiplexer = this.#multiplexer.subscribe((event) => {
      if (event.sessionId === undefined) return;
      if (event.generation !== undefined) {
        this.#tuiChannels?.invalidate?.(
          {
            hostInstanceId: this.#multiplexer.hostInstanceId,
            sessionId: event.sessionId,
            generation: event.generation,
          },
          event.event,
        );
      }
      for (const [key, hub] of this.#richHubs) {
        if (hub.identity.sessionId !== event.sessionId) continue;
        if (
          hub.identity.generation !== event.generation ||
          ["sessionClosed", "sessionDormant", "sessionDeleted", "sessionEvicted"].includes(event.event)
        ) {
          hub.dispose("session generation or residency changed");
          this.#richHubs.delete(key);
        }
      }
    });
  }

  async capabilities(): Promise<DashboardCapabilities> {
    this.#assertOpen();
    return structuredClone(this.#capabilities);
  }

  /** Read-only ownership guard; controller authority remains inside each hub. */
  hasController(sessionId: string): boolean {
    for (const hub of this.#richHubs.values()) {
      if (hub.identity.sessionId === sessionId && hub.hasController) return true;
    }
    return false;
  }

  async listSessions(query: SessionInventoryQuery): Promise<SessionInventoryPage> {
    this.#assertOpen();
    return this.#inventory.list(query);
  }

  async getSessionInfo(inventoryId: string): Promise<SessionInfoResource> {
    this.#assertOpen();
    const info = await this.#inventory.getInfo(inventoryId);
    if (info === undefined) throw new InProcessDashboardBackendError("inventory_not_found", "inventory session does not exist");
    const managed = info.managed;
    if (managed === undefined) return info;
    const hub = this.#richHubs.get(hubKey(managed.sessionId, managed.generation));
    return {
      ...info,
      runtime: {
        ...info.runtime,
        readerCount: hub?.channelCount ?? info.runtime?.readerCount ?? 0,
        warmLeaseCount: this.#multiplexer.residencyLeaseCount(
          managed.sessionId,
          managed.generation,
        ),
        isolation: "unisolated",
      },
    };
  }

  async getTranscript(inventoryId: string, query: TranscriptQuery): Promise<TranscriptPage> {
    this.#assertOpen();
    const info = await this.#inventory.getInfo(inventoryId);
    if (info === undefined) throw new InProcessDashboardBackendError("inventory_not_found", "inventory session does not exist");
    if (info.source.canonicalPath === undefined) {
      return {
        inventoryId,
        ...(info.piSessionId === undefined ? {} : { piSessionId: info.piSessionId }),
        ...(info.managed === undefined
          ? {}
          : { managedSession: { sessionId: info.managed.sessionId, generation: info.managed.generation } }),
        ...(info.currentLeafId === undefined ? {} : { currentLeafId: info.currentLeafId }),
        records: [],
        order: "chronological",
        projection: {
          formatVersion: 1,
          cached: false,
          truncated: false,
          builtAt: new Date().toISOString(),
        },
        hydration: "not-requested",
      };
    }
    const projectionRequest = {
      inventoryId,
      path: info.source.canonicalPath,
      query,
      ...(info.source.fingerprint === undefined
        ? {}
        : { expectedFingerprint: info.source.fingerprint.value }),
    };
    try {
      return await this.#projector.project(projectionRequest);
    } catch (error) {
      if (
        !(error instanceof TranscriptProjectionError) ||
        error.code !== "source_fingerprint_changed" ||
        projectionRequest.expectedFingerprint === undefined
      ) {
        throw error;
      }
      // Inventory is deliberately reconciled off the request path. A live Pi
      // writer can therefore advance a safe read-only preview between scans.
      // Rebuild once from the projector's own stable before/after file check;
      // activation still requires this returned current fingerprint.
      return this.#projector.project({
        inventoryId,
        path: info.source.canonicalPath,
        query,
      });
    }
  }

  async activateSession(inventoryId: string, request: ActivationRequest): Promise<ActivationTicket> {
    this.#assertOpen();
    return this.#ownership.activateSession(inventoryId, request);
  }

  async getActivation(ticketId: string): Promise<ActivationTicket> {
    this.#assertOpen();
    return this.#ownership.getActivation(ticketId);
  }

  async exportSession(sessionRef: string, request: SessionExportRequest): Promise<SessionExportTicket> {
    this.#assertOpen();
    return this.#ownership.exportSession(sessionRef, request);
  }

  async getExport(ticketId: string): Promise<SessionExportTicket> {
    this.#assertOpen();
    return this.#ownership.getExport(ticketId);
  }

  async createSessionDraft(
    request: DashboardSessionDraftCreateRequest,
  ): Promise<DashboardSessionDraftResource> {
    this.#assertOpen();
    return this.#draftService().create(request);
  }

  async getSessionDraft(draftId: string): Promise<DashboardSessionDraftResource> {
    this.#assertOpen();
    const draft = await this.#draftService().get(draftId);
    if (draft === undefined) {
      throw new InProcessDashboardBackendError("draft_not_found", "dashboard session draft not found");
    }
    return draft;
  }

  cancelSessionDraft(
    draftId: string,
    request: DashboardSessionDraftCancelRequest,
  ): Promise<DashboardSessionDraftResource> {
    this.#assertOpen();
    return this.#draftService().cancel(draftId, request);
  }

  sendSessionDraft(
    draftId: string,
    request: DashboardSessionDraftSendRequest,
  ): Promise<DashboardSessionDraftSendTicket> {
    this.#assertOpen();
    if (this.#draftExecution === undefined) {
      throw new InProcessDashboardBackendError(
        "draft_execution_unavailable",
        "dashboard session draft execution is unavailable",
        true,
      );
    }
    return this.#draftExecution.submitSend(draftId, request);
  }

  async getSessionDraftSend(ticketId: string): Promise<DashboardSessionDraftSendTicket> {
    this.#assertOpen();
    if (this.#draftExecution === undefined) {
      throw new InProcessDashboardBackendError(
        "draft_execution_unavailable",
        "dashboard session draft execution is unavailable",
        true,
      );
    }
    const ticket = await this.#draftExecution.getSend(ticketId);
    if (ticket === undefined) {
      throw new InProcessDashboardBackendError("draft_ticket_not_found", "draft send ticket not found");
    }
    return ticket;
  }

  async scheduleCapabilities(): Promise<ScheduleCapabilities> {
    this.#assertOpen();
    return scheduleCapabilities(this.#scheduleStore().limits, this.#scheduler !== undefined);
  }

  async listSchedules(sessionRef?: string): Promise<DashboardScheduleResource[]> {
    this.#assertOpen();
    const store = this.#scheduleStore();
    const canonical = sessionRef === undefined
      ? undefined
      : (await this.#retainedScheduleSession(sessionRef)).sessionId;
    return (await store.list(canonical)).map(browserScheduleResource);
  }

  async getSchedule(scheduleId: string): Promise<DashboardScheduleResource> {
    this.#assertOpen();
    const resource = await this.#scheduleStore().get(scheduleId);
    if (resource === undefined) {
      throw new InProcessDashboardBackendError("schedule_not_found", "schedule does not exist");
    }
    return browserScheduleResource(resource);
  }

  createSchedule(request: DashboardScheduleMutationRequest): Promise<DashboardScheduleResource> {
    this.#assertOpen();
    return this.#scheduleMutation(`create:${request.idempotencyKey}`, request, async () => {
      if (request.expectedRevision !== undefined) {
        throw new InProcessDashboardBackendError("invalid_schedule_request", "create must not include expectedRevision");
      }
      if (request.schedule.prompt === undefined) {
        throw new InProcessDashboardBackendError("invalid_schedule_request", "prompt is required when creating a schedule");
      }
      const session = await this.#retainedScheduleSession(request.schedule.sessionRef);
      const write = { ...request.schedule, sessionRef: session.sessionId };
      const created = await this.#scheduleStore().create(
        scheduleDefinition(write, request.schedule.prompt),
      );
      await this.#scheduler?.recompute();
      return browserScheduleResource((await this.#scheduleStore().get(created.scheduleId)) ?? created);
    }) as Promise<DashboardScheduleResource>;
  }

  updateSchedule(scheduleId: string, request: DashboardScheduleMutationRequest): Promise<DashboardScheduleResource> {
    this.#assertOpen();
    return this.#scheduleMutation(`update:${scheduleId}:${request.idempotencyKey}`, request, async () => {
      if (request.schedule.scheduleId !== scheduleId || request.expectedRevision === undefined) {
        throw new InProcessDashboardBackendError("invalid_schedule_request", "schedule identity and expectedRevision are required");
      }
      const current = await this.#scheduleStore().get(scheduleId);
      if (current === undefined) throw new InProcessDashboardBackendError("schedule_not_found", "schedule does not exist");
      if (request.expectedRevision !== current.revision) {
        throw new InProcessDashboardBackendError("schedule_precondition_failed", "schedule revision precondition failed");
      }
      const session = await this.#retainedScheduleSession(request.schedule.sessionRef);
      if (session.sessionId !== current.sessionRef) {
        throw new InProcessDashboardBackendError("schedule_identity_conflict", "schedule session is immutable");
      }
      const write = { ...request.schedule, sessionRef: session.sessionId };
      const updated = await this.#scheduleStore().update(
        scheduleId,
        current.revision,
        scheduleDefinition(write, request.schedule.prompt ?? current.prompt),
      );
      await this.#scheduler?.recompute();
      return browserScheduleResource((await this.#scheduleStore().get(scheduleId)) ?? updated);
    }) as Promise<DashboardScheduleResource>;
  }

  deleteSchedule(scheduleId: string, request: DashboardScheduleDeleteRequest): Promise<void> {
    this.#assertOpen();
    return this.#scheduleMutation(`delete:${scheduleId}:${request.idempotencyKey}`, request, async () => {
      const current = await this.#scheduleStore().get(scheduleId);
      if (current === undefined) throw new InProcessDashboardBackendError("schedule_not_found", "schedule does not exist");
      if (request.expectedRevision !== current.revision) {
        throw new InProcessDashboardBackendError("schedule_precondition_failed", "schedule revision precondition failed");
      }
      await this.#scheduleStore().delete(scheduleId, current.revision);
      await this.#scheduler?.recompute();
    }) as Promise<void>;
  }

  async scheduleStatus(): Promise<DashboardScheduleStatus> {
    this.#assertOpen();
    return scheduleStatus(
      await this.#scheduleStore().list(),
      this.#scheduler !== undefined,
      this.#scheduler?.status().nextWakeAt,
    );
  }

  async getManagedSession(sessionRef: string): Promise<SessionResource> {
    this.#assertOpen();
    const record = await this.#multiplexer.retainedSession(sessionRef);
    if (record === undefined) throw new InProcessDashboardBackendError("session_not_found", "managed session does not exist");
    return catalogRecordToSessionResource(record);
  }

  async openSessionChannel(options: SessionChannelOptions): Promise<DashboardChannel> {
    this.#assertOpen();
    const context = await this.#residentContext(options.sessionRef, options.generation);
    const key = hubKey(context.identity.sessionId, context.identity.generation);
    let hub = this.#richHubs.get(key);
    if (hub === undefined) {
      if (this.#richHubs.size >= this.#limits.maxRichHubs) {
        const idle = [...this.#richHubs.entries()].find(([, candidate]) => candidate.channelCount === 0);
        if (idle === undefined) throw new InProcessDashboardBackendError("channel_capacity", "rich channel capacity reached", true);
        idle[1].dispose("rich channel evicted");
        this.#richHubs.delete(idle[0]);
      }
      hub = new InProcessRichHub(
        context.identity,
        context.controller,
        this.#limits,
        () => this.#richHubs.delete(key),
      );
      this.#richHubs.set(key, hub);
    }
    const [entries, lease] = await Promise.all([
      this.#managedPreview(context.session),
      this.#multiplexer.acquireResidencyLease(
        context.identity.sessionId,
        context.identity.generation,
        this.#limits.leaseTtlMs,
      ),
    ]);
    const requestState = requestStateFor(this.#multiplexer, context.identity.sessionId);
    const opened = hub.open(options, context.session, entries, requestState, lease);
    return opened.channel;
  }

  async openTuiChannel(options: TuiChannelOptions): Promise<DashboardTuiChannel> {
    this.#assertOpen();
    if (this.#tuiChannels === undefined) {
      throw new InProcessDashboardBackendError(
        "tui_unavailable",
        this.#capabilities.presentations.tui.unavailableReason ?? "TUI presentation is unavailable",
      );
    }
    const context = await this.#residentContext(options.sessionRef, options.generation);
    const lease = await this.#multiplexer.acquireResidencyLease(
      context.identity.sessionId,
      context.identity.generation,
      this.#limits.leaseTtlMs,
    );
    try {
      const channel = await this.#tuiChannels.open({ options, ...context });
      if (channel.presentation !== "tui") {
        await channel.close();
        throw new InProcessDashboardBackendError("tui_contract_mismatch", "TUI factory returned the wrong presentation");
      }
      try {
        assertIdentity(channel.identity, context.identity);
      } catch (error) {
        await channel.close();
        throw error;
      }
      return new LeasedTuiChannel(channel, lease, this.#limits.leaseTtlMs);
    } catch (error) {
      lease.release();
      throw error;
    }
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#unsubscribeMultiplexer();
    for (const hub of this.#richHubs.values()) hub.dispose("dashboard backend disposed");
    this.#richHubs.clear();
    this.#tuiChannels?.dispose?.();
  }

  #draftService(): NonNullable<InProcessDashboardBackendOptions["drafts"]> {
    if (this.#drafts === undefined) {
      throw new InProcessDashboardBackendError(
        "drafts_unavailable",
        "dashboard session drafts are unavailable",
      );
    }
    return this.#drafts;
  }

  async #residentContext(
    sessionRef: string,
    requestedGeneration: number | undefined,
  ): Promise<{
    identity: DashboardSessionIdentity;
    session: SessionResource;
    controller: PiRpcController;
  }> {
    const retained = await this.#ensureResident(sessionRef, requestedGeneration);
    const generation = requestedGeneration ?? retained.generation;
    if (generation !== retained.generation) {
      throw new InProcessDashboardBackendError("stale_generation", "session generation changed");
    }
    const controller = await this.#multiplexer.rpcController(retained.sessionId, generation);
    return {
      identity: {
        hostInstanceId: this.#multiplexer.hostInstanceId,
        sessionId: retained.sessionId,
        generation,
      },
      session: catalogRecordToSessionResource(retained),
      controller,
    };
  }

  async #ensureResident(sessionRef: string, generation: number | undefined) {
    try {
      return await ensureSessionResident(this.#multiplexer, sessionRef, generation);
    } catch (error) {
      if (error instanceof MultiplexerError) {
        throw new InProcessDashboardBackendError(
          error.code,
          error.message,
          error.retryable,
        );
      }
      throw error;
    }
  }

  async #managedPreview(session: SessionResource): Promise<TranscriptPage["records"]> {
    const page = await this.#inventory.list({ search: session.sessionId, limit: 100 });
    const match = page.sessions.find((record) => record.managed?.sessionId === session.sessionId);
    if (match === undefined) return [];
    return (await this.getTranscript(match.inventoryId, { limit: DASH_DEFAULT_LIMITS.maxTranscriptPageRecords })).records;
  }

  #scheduleStore(): NonNullable<InProcessDashboardBackendOptions["schedules"]> {
    if (this.#schedules === undefined || !this.#capabilities.resources.schedules) {
      throw new InProcessDashboardBackendError("schedules_unavailable", "schedule resources are unavailable");
    }
    return this.#schedules;
  }

  async #retainedScheduleSession(sessionRef: string) {
    const retained = await this.#multiplexer.retainedSession(sessionRef);
    if (retained === undefined) throw new InProcessDashboardBackendError("session_not_found", "managed session does not exist");
    return retained;
  }

  #scheduleMutation<T extends DashboardScheduleResource | void>(
    key: string,
    input: unknown,
    operation: () => Promise<T>,
  ): Promise<T> {
    const fingerprint = JSON.stringify(input);
    const existing = this.#scheduleMutations.get(key);
    if (existing !== undefined) {
      if (existing.fingerprint !== fingerprint) {
        throw new InProcessDashboardBackendError("idempotency_conflict", "idempotency key was reused with different schedule content");
      }
      return existing.result.then((value) => structuredClone(value)) as Promise<T>;
    }
    if (this.#scheduleMutations.size >= 1024) {
      const oldest = this.#scheduleMutations.keys().next().value;
      if (oldest !== undefined) this.#scheduleMutations.delete(oldest);
    }
    const result = operation().catch((error: unknown) => {
      this.#scheduleMutations.delete(key);
      if (error instanceof ScheduleStoreError) {
        throw new InProcessDashboardBackendError(
          error.code === "revision_conflict" ? "schedule_precondition_failed" : `schedule_${error.code}`,
          error.message,
        );
      }
      throw error;
    });
    this.#scheduleMutations.set(key, { fingerprint, result });
    return result.then((value) => structuredClone(value)) as Promise<T>;
  }

  #assertOpen(): void {
    if (this.#disposed) throw new InProcessDashboardBackendError("backend_closed", "dashboard backend is closed");
  }
}

class InProcessRichHub {
  readonly identity: DashboardSessionIdentity;
  readonly #controller: PiRpcController;
  readonly #limits: InProcessDashboardBackendLimits;
  readonly #onIdle: () => void;
  readonly #channels = new Map<string, InProcessRichChannel>();
  readonly #events: RetainedDashboardEvent[] = [];
  readonly #commandResults = new Map<string, { fingerprint: string; promise: Promise<DashboardCommandResult> }>();
  readonly #unsubscribeController: () => void;
  #controllerChannelId: string | undefined;
  #sequence = 0;
  #replayBytes = 0;
  #commandTail: Promise<void> = Promise.resolve();
  #disposed = false;

  constructor(
    identity: DashboardSessionIdentity,
    controller: PiRpcController,
    limits: InProcessDashboardBackendLimits,
    onIdle: () => void,
  ) {
    this.identity = identity;
    this.#controller = controller;
    this.#limits = limits;
    this.#onIdle = onIdle;
    this.#unsubscribeController = controller.subscribe((output) => this.#publish(output));
  }

  get channelCount(): number {
    return this.#channels.size;
  }

  get hasController(): boolean {
    return this.#controllerChannelId !== undefined;
  }

  open(
    options: SessionChannelOptions,
    session: SessionResource,
    entries: TranscriptPage["records"],
    requestState: JsonObject,
    lease: SessionResidencyLease,
  ): RichChannelOpenResult {
    if (this.#disposed) throw new InProcessDashboardBackendError("channel_closed", "rich channel is closed");
    if (this.#channels.size >= this.#limits.maxChannelsPerHub) {
      lease.release();
      throw new InProcessDashboardBackendError("channel_capacity", "session channel capacity reached", true);
    }
    const channelId = randomUUID();
    const controllerGranted = options.role === "controller" && this.#controllerChannelId === undefined;
    if (controllerGranted) this.#controllerChannelId = channelId;
    const role = controllerGranted ? "controller" : "observer";
    const rpc = this.#controller.snapshot();
    const snapshot = {
      identity: this.identity,
      session,
      rpcState: boundedObject(rpc.rpcState, this.#limits.maxEventBytes),
      requestState,
      entries: structuredClone(entries),
      currentLeafId: rpc.leafId,
      highWaterCursor: this.#cursor(this.#sequence),
    };
    const pending = this.#replay(options.cursor);
    if (options.role === "controller" && !controllerGranted) {
      pending.push({
        kind: "control",
        identity: this.identity,
        action: "control_denied",
        reason: "controller already held",
      });
    }
    const renewEvery = Math.max(1_000, Math.floor(this.#limits.leaseTtlMs / 3));
    const renewal = setInterval(() => lease.renew(), renewEvery);
    renewal.unref?.();
    const channel = new InProcessRichChannel(
      channelId,
      role,
      snapshot,
      pending,
      this,
      () => {
        clearInterval(renewal);
        lease.release();
      },
    );
    this.#channels.set(channelId, channel);
    return { channel, release: () => channel.close() };
  }

  subscribe(channelId: string, listener: DashboardChannelListener<DashboardChannelEvent>): () => void {
    const channel = this.#requireChannel(channelId);
    return channel.attachListener(listener);
  }

  command(channelId: string, command: DashboardCommand): Promise<DashboardCommandResult> {
    const channel = this.#requireChannel(channelId);
    assertIdentity(command.identity, this.identity);
    if (channel.role !== "controller" && !READ_ONLY_COMMANDS.has(command.operation)) {
      return Promise.resolve(rejected(command.correlationId, "controller_required", "controller role is required", true));
    }
    const fingerprint = JSON.stringify({ operation: command.operation, payload: command.payload ?? null });
    if (command.idempotencyKey !== undefined) {
      const existing = this.#commandResults.get(command.idempotencyKey);
      if (existing !== undefined) {
        if (existing.fingerprint !== fingerprint) {
          return Promise.resolve(rejected(command.correlationId, "idempotency_conflict", "idempotency key was reused with different command content"));
        }
        return existing.promise.then((result) => ({
          ...result,
          correlationId: command.correlationId,
        }));
      }
    }
    const run = async (): Promise<DashboardCommandResult> => {
      const response = await this.#controller.handle({
        ...(command.payload ?? {}),
        type: command.operation,
        id: command.correlationId,
      });
      return commandResult(response, command);
    };
    const promise = this.#serialize(run);
    if (command.idempotencyKey !== undefined) {
      if (this.#commandResults.size >= this.#limits.maxCommandResults) {
        const first = this.#commandResults.keys().next().value;
        if (first !== undefined) this.#commandResults.delete(first);
      }
      this.#commandResults.set(command.idempotencyKey, { fingerprint, promise });
    }
    return promise;
  }

  requestControl(channelId: string, correlationId: string): DashboardCommandResult {
    const channel = this.#requireChannel(channelId);
    if (this.#controllerChannelId === undefined || this.#controllerChannelId === channelId) {
      this.#controllerChannelId = channelId;
      channel.setRole("controller");
      this.#broadcast({
        kind: "control",
        identity: this.identity,
        action: "control_granted",
        connectionId: channelId,
      });
      return { correlationId, state: "completed", data: { role: "controller" } };
    }
    const event: DashboardControlEvent = {
      kind: "control",
      identity: this.identity,
      action: "control_denied",
      connectionId: channelId,
      reason: "controller already held",
    };
    channel.deliver(event);
    return rejected(correlationId, "controller_busy", "another pane holds controller role", true);
  }

  releaseControl(channelId: string, correlationId: string): DashboardCommandResult {
    const channel = this.#requireChannel(channelId);
    if (this.#controllerChannelId !== channelId) {
      return rejected(correlationId, "controller_required", "pane does not hold controller role");
    }
    this.#controllerChannelId = undefined;
    channel.setRole("observer");
    this.#controller.cancelPendingUi();
    this.#broadcast({
      kind: "control",
      identity: this.identity,
      action: "control_released",
      connectionId: channelId,
    });
    return { correlationId, state: "completed", data: { role: "observer" } };
  }

  answerExtensionUi(channelId: string, requestId: string, response: JsonObject): void {
    const channel = this.#requireChannel(channelId);
    if (channel.role !== "controller") {
      throw new InProcessDashboardBackendError("controller_required", "controller role is required");
    }
    const accepted = this.#controller.respondToExtensionUi({
      type: "extension_ui_response",
      id: requestId,
      ...response,
    } as RpcExtensionUIResponse);
    if (!accepted) throw new InProcessDashboardBackendError("extension_request_not_found", "extension UI request does not exist");
  }

  remove(channelId: string): void {
    const channel = this.#channels.get(channelId);
    if (channel === undefined) return;
    this.#channels.delete(channelId);
    if (this.#controllerChannelId === channelId) {
      this.#controllerChannelId = undefined;
      this.#controller.cancelPendingUi();
      this.#broadcast({
        kind: "control",
        identity: this.identity,
        action: "control_released",
        connectionId: channelId,
      });
    }
    if (this.#channels.size === 0) {
      this.dispose("last rich channel closed");
      this.#onIdle();
    }
  }

  dispose(reason: string): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#unsubscribeController();
    this.#controller.cancelPendingUi();
    for (const channel of [...this.#channels.values()]) channel.forceClose(reason);
    this.#channels.clear();
    this.#events.length = 0;
    this.#commandResults.clear();
  }

  #publish(output: PiRpcControllerOutput): void {
    if (this.#disposed) return;
    const sequence = ++this.#sequence;
    const cursor = this.#cursor(sequence);
    let event: DashboardChannelEvent;
    try {
      event = outputToEvent(output, this.identity, sequence, cursor, this.#limits.maxEventBytes);
    } catch {
      event = {
        kind: "session_event",
        identity: this.identity,
        cursor,
        sequence,
        event: { type: "serialization_error" },
      };
    }
    const bytes = byteLength(event);
    if (bytes > this.#limits.maxEventBytes) return;
    this.#events.push({ sequence, cursor, event, bytes });
    this.#replayBytes += bytes;
    while (
      this.#events.length > this.#limits.maxReplayEvents ||
      this.#replayBytes > this.#limits.maxReplayBytes
    ) {
      const removed = this.#events.shift();
      if (removed) this.#replayBytes -= removed.bytes;
    }
    this.#broadcast(event);
  }

  #replay(cursor: DashboardCursor | undefined): DashboardChannelEvent[] {
    if (cursor === undefined) return [];
    const parsed = parseCursor(cursor);
    const highWaterCursor = this.#cursor(this.#sequence);
    if (parsed === undefined) {
      return [gap(this.identity, cursor, highWaterCursor, "cursor-expired")];
    }
    if (parsed.hostInstanceId !== this.identity.hostInstanceId) {
      return [gap(this.identity, cursor, highWaterCursor, "host-restarted")];
    }
    if (
      parsed.sessionId !== this.identity.sessionId ||
      parsed.generation !== this.identity.generation
    ) {
      return [gap(this.identity, cursor, highWaterCursor, "generation-changed")];
    }
    if (parsed.sequence === this.#sequence) return [];
    const oldest = this.#events[0];
    if (oldest === undefined || parsed.sequence < oldest.sequence - 1 || parsed.sequence > this.#sequence) {
      return [gap(
        this.identity,
        cursor,
        highWaterCursor,
        "cursor-expired",
        oldest?.cursor,
      )];
    }
    return this.#events.filter((event) => event.sequence > parsed.sequence).map((event) => structuredClone(event.event));
  }

  #cursor(sequence: number): DashboardCursor {
    return encodeCursor({ ...this.identity, sequence });
  }

  #broadcast(event: DashboardChannelEvent): void {
    for (const channel of this.#channels.values()) channel.deliver(event);
  }

  #requireChannel(channelId: string): InProcessRichChannel {
    const channel = this.#channels.get(channelId);
    if (channel === undefined) throw new InProcessDashboardBackendError("channel_closed", "rich channel is closed");
    return channel;
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    let resolveResult!: (value: T) => void;
    let rejectResult!: (error: unknown) => void;
    const result = new Promise<T>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    this.#commandTail = this.#commandTail.then(async () => {
      try {
        resolveResult(await operation());
      } catch (error) {
        rejectResult(error);
      }
    });
    return result;
  }
}

class InProcessRichChannel implements DashboardChannel {
  readonly presentation = "rich" as const;
  readonly identity: DashboardSessionIdentity;
  readonly snapshot;
  readonly #id: string;
  readonly #hub: InProcessRichHub;
  readonly #pending: DashboardChannelEvent[];
  readonly #releaseLease: () => void;
  readonly #listeners = new Set<DashboardChannelListener<DashboardChannelEvent>>();
  #role: "controller" | "observer";
  #closed = false;

  constructor(
    id: string,
    role: "controller" | "observer",
    snapshot: DashboardChannel["snapshot"],
    pending: DashboardChannelEvent[],
    hub: InProcessRichHub,
    releaseLease: () => void,
  ) {
    this.#id = id;
    this.#role = role;
    this.snapshot = snapshot;
    this.identity = snapshot.identity;
    this.#pending = pending;
    this.#hub = hub;
    this.#releaseLease = releaseLease;
  }

  get role(): "controller" | "observer" {
    return this.#role;
  }

  setRole(role: "controller" | "observer"): void {
    this.#role = role;
  }

  command(command: DashboardCommand): Promise<DashboardCommandResult> {
    this.#assertOpen();
    return this.#hub.command(this.#id, command);
  }

  async requestControl(correlationId: string): Promise<DashboardCommandResult> {
    this.#assertOpen();
    return this.#hub.requestControl(this.#id, correlationId);
  }

  async releaseControl(correlationId: string): Promise<DashboardCommandResult> {
    this.#assertOpen();
    return this.#hub.releaseControl(this.#id, correlationId);
  }

  async answerExtensionUi(requestId: string, response: JsonObject): Promise<void> {
    this.#assertOpen();
    this.#hub.answerExtensionUi(this.#id, requestId, response);
  }

  subscribe(listener: DashboardChannelListener<DashboardChannelEvent>): () => void {
    this.#assertOpen();
    this.#listeners.add(listener);
    for (const event of this.#pending.splice(0)) listener(structuredClone(event));
    return () => this.#listeners.delete(listener);
  }

  attachListener(listener: DashboardChannelListener<DashboardChannelEvent>): () => void {
    return this.subscribe(listener);
  }

  deliver(event: DashboardChannelEvent): void {
    if (this.#closed) return;
    for (const listener of this.#listeners) listener(structuredClone(event));
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#releaseLease();
    this.#listeners.clear();
    this.#hub.remove(this.#id);
  }

  forceClose(_reason: string): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#releaseLease();
    this.#listeners.clear();
  }

  #assertOpen(): void {
    if (this.#closed) throw new InProcessDashboardBackendError("channel_closed", "rich channel is closed");
  }
}

class LeasedTuiChannel implements DashboardTuiChannel {
  readonly presentation = "tui" as const;
  readonly identity;
  readonly snapshot;
  readonly #channel: DashboardTuiChannel;
  readonly #lease: SessionResidencyLease;
  readonly #renewal: ReturnType<typeof setInterval>;
  #closed = false;

  constructor(
    channel: DashboardTuiChannel,
    lease: SessionResidencyLease,
    leaseTtlMs: number,
  ) {
    this.#channel = channel;
    this.#lease = lease;
    this.identity = channel.identity;
    this.snapshot = channel.snapshot;
    this.#renewal = setInterval(() => lease.renew(), Math.max(1_000, Math.floor(leaseTtlMs / 3)));
    this.#renewal.unref?.();
  }

  get role() {
    return this.#channel.role;
  }

  resize(dimensions: TuiChannelOptions["dimensions"]): Promise<void> {
    this.#assertOpen();
    return this.#channel.resize(dimensions);
  }

  sendInput(input: Parameters<DashboardTuiChannel["sendInput"]>[0]): Promise<void> {
    this.#assertOpen();
    return this.#channel.sendInput(input);
  }

  requestControl(correlationId: string): Promise<DashboardCommandResult> {
    this.#assertOpen();
    return this.#channel.requestControl(correlationId);
  }

  releaseControl(correlationId: string): Promise<DashboardCommandResult> {
    this.#assertOpen();
    return this.#channel.releaseControl(correlationId);
  }

  subscribe(listener: DashboardChannelListener<DashboardTuiChannelEvent>): () => void {
    this.#assertOpen();
    return this.#channel.subscribe(listener);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    clearInterval(this.#renewal);
    try {
      await this.#channel.close();
    } finally {
      this.#lease.release();
    }
  }

  #assertOpen(): void {
    if (this.#closed) throw new InProcessDashboardBackendError("channel_closed", "TUI channel is closed");
  }
}

function defaultCapabilities(
  tuiAvailable: boolean,
  schedulesAvailable: boolean,
  draftsAvailable: boolean,
  backendLimits: InProcessDashboardBackendLimits,
): DashboardCapabilities {
  const commands: DashboardCommandOperation[] = [
    "get_state",
    "get_entries",
    "get_session_stats",
    "get_commands",
    "get_available_models",
    "prompt",
    "steer",
    "follow_up",
    "abort",
    "set_model",
    "set_thinking_level",
    "set_steering_mode",
    "set_follow_up_mode",
    "compact",
    "set_auto_compaction",
    "set_auto_retry",
    "abort_retry",
    "set_session_name",
    "get_tree",
    "fork",
    "clone",
  ];
  return {
    apiVersion: DASH_API_VERSION,
    streamSubprotocol: DASH_STREAM_SUBPROTOCOL,
    sameBrowserProtocolAcrossDeployments: true,
    authentication: {
      browserSession: "http-only-cookie",
      csrf: "same-origin-header",
      daemonBearerExposed: false,
    },
    resources: {
      inventory: true,
      transcriptPreview: true,
      activation: true,
      export: true,
      workspaces: true,
      settings: true,
      schedules: schedulesAvailable,
      sessionDrafts: draftsAvailable,
    },
    presentations: {
      rich: { available: true, replay: true, controller: true, commands },
      tui: tuiAvailable
        ? { available: true, replay: true, controller: true, commands }
        : {
            available: false,
            replay: true,
            controller: true,
            commands,
            unavailableReason: "interactive-view-seam-required",
          },
    },
    limits: {
      ...DASH_DEFAULT_LIMITS,
      maxSubscriptionsPerConnection: backendLimits.maxChannelsPerHub,
      maxReplayEvents: backendLimits.maxReplayEvents,
      maxReplayEventBytes: backendLimits.maxEventBytes,
      maxReplayBytesPerSession: backendLimits.maxReplayBytes,
      visibleLeaseExpiryMs: backendLimits.leaseTtlMs,
    },
    performanceBudgets: { ...DASH_PERFORMANCE_BUDGETS },
  };
}

function resolveLimits(
  overrides: Partial<InProcessDashboardBackendLimits> | undefined,
): InProcessDashboardBackendLimits {
  const limits = { ...DEFAULT_IN_PROCESS_DASHBOARD_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isInteger(value) || value < 1) throw new RangeError(`${name} must be a positive integer`);
  }
  return limits;
}

function hubKey(sessionId: string, generation: number): string {
  return `${sessionId}\u0000${generation}`;
}

function requestStateFor(multiplexer: Multiplexer, sessionId: string): JsonObject {
  try {
    const snapshot = multiplexer.status(sessionId);
    return {
      queued: snapshot.queuedTurns,
      ...(snapshot.activeRequestId === undefined ? {} : { activeRequestId: snapshot.activeRequestId }),
      state: snapshot.state,
    };
  } catch {
    return { queued: 0, state: "dormant" };
  }
}

function outputToEvent(
  output: PiRpcControllerOutput,
  identity: DashboardSessionIdentity,
  sequence: number,
  cursor: DashboardCursor,
  maxBytes: number,
): DashboardChannelEvent {
  if (isRecord(output) && output.type === "extension_ui_request" && typeof output.id === "string") {
    const { type: _type, id: _id, ...payload } = output;
    return {
      kind: "extension_ui",
      identity,
      requestId: output.id,
      method: typeof payload.method === "string" ? payload.method : "unknown",
      payload: boundedObject(payload, maxBytes),
    } satisfies DashboardExtensionUiEvent;
  }
  return {
    kind: "session_event",
    identity,
    cursor,
    sequence,
    event: boundedObject(output, maxBytes) as PiRpcEvent,
  } satisfies DashboardSessionEvent;
}

function commandResult(response: RpcResponse, command: DashboardCommand): DashboardCommandResult {
  if (!response.success) {
    const error = "error" in response && typeof response.error === "string"
      ? response.error
      : "RPC command was rejected";
    return rejected(command.correlationId, "rpc_command_failed", error);
  }
  const data = "data" in response ? boundedJsonValue(response.data) : undefined;
  return {
    correlationId: command.correlationId,
    state: command.operation === "prompt" ? "streaming" : "completed",
    ...(data === undefined ? {} : { data }),
  };
}

function rejected(
  correlationId: string,
  code: string,
  message: string,
  retryable = false,
): DashboardCommandResult {
  return {
    correlationId,
    state: "rejected",
    error: { code, message, retryable },
  };
}

function assertIdentity(received: DashboardSessionIdentity, expected: DashboardSessionIdentity): void {
  if (
    received.hostInstanceId !== expected.hostInstanceId ||
    received.sessionId !== expected.sessionId ||
    received.generation !== expected.generation
  ) {
    throw new InProcessDashboardBackendError("stale_generation", "dashboard command identity is stale");
  }
}

function encodeCursor(value: DashboardSessionIdentity & { sequence: number }): DashboardCursor {
  return asDashboardCursor(`dash:${Buffer.from(JSON.stringify(value), "utf8").toString("base64url")}`);
}

function parseCursor(cursor: DashboardCursor): (DashboardSessionIdentity & { sequence: number }) | undefined {
  try {
    if (!cursor.startsWith("dash:")) return undefined;
    const value: unknown = JSON.parse(Buffer.from(cursor.slice(5), "base64url").toString("utf8"));
    if (
      !isRecord(value) ||
      typeof value.hostInstanceId !== "string" ||
      typeof value.sessionId !== "string" ||
      !Number.isInteger(value.generation) ||
      !Number.isInteger(value.sequence)
    ) return undefined;
    return {
      hostInstanceId: value.hostInstanceId,
      sessionId: value.sessionId,
      generation: value.generation as number,
      sequence: value.sequence as number,
    };
  } catch {
    return undefined;
  }
}

function gap(
  identity: DashboardSessionIdentity,
  requestedCursor: DashboardCursor,
  highWaterCursor: DashboardCursor,
  reason: DashboardReplayGap["reason"],
  oldestAvailableCursor?: DashboardCursor,
): DashboardReplayGap {
  return {
    kind: "replay_gap",
    identity,
    reason,
    requestedCursor,
    highWaterCursor,
    ...(oldestAvailableCursor === undefined ? {} : { oldestAvailableCursor }),
    snapshotFollows: true,
  };
}

function boundedObject(value: unknown, maxBytes: number): JsonObject {
  const bounded = boundedJsonValue(value, maxBytes);
  if (!isRecord(bounded)) return { value: bounded ?? null };
  return bounded;
}

function boundedJsonValue(
  value: unknown,
  maxBytes: number = DASH_DEFAULT_LIMITS.maxReplayEventBytes,
): JsonValue | undefined {
  if (value === undefined) return undefined;
  const json = JSON.stringify(value);
  if (json === undefined) return undefined;
  if (Buffer.byteLength(json, "utf8") > maxBytes) {
    return { type: "bounded_output", truncated: true };
  }
  return JSON.parse(json) as JsonValue;
}

function byteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
