import type { DashboardDiagnosticsSnapshot } from "./dashboard-diagnostics.js";
import {
  DASH_API_VERSION,
  DASH_DEFAULT_LIMITS,
  DASH_PERFORMANCE_BUDGETS,
  DASH_STREAM_SUBPROTOCOL,
  type ActivationRequest,
  type ActivationTicket,
  type DashboardBackend,
  type DashboardCapabilities,
  type DashboardChannel,
  type DashboardCommandOperation,
  type DashboardCursor,
  type DashboardFingerprint,
  type DashboardScheduleDeleteRequest,
  type DashboardScheduleMutationRequest,
  type DashboardScheduleResource,
  type DashboardScheduleStatus,
  type DashboardServiceCapabilities,
  type DashboardTuiChannel,
  type NormalizedTranscriptRecord,
  type SessionChannelOptions,
  type SessionExportRequest,
  type SessionExportTicket,
  type SessionInfoResource,
  type SessionInventoryPage,
  type SessionInventoryQuery,
  type TranscriptPage,
  type TranscriptQuery,
  type TuiChannelOptions,
} from "./dashboard-contract.js";
import { DEFAULT_SCHEDULE_LIMITS, type ScheduleCapabilities } from "./schedule-contract.js";
import type {
  DashboardSessionDraftCancelRequest,
  DashboardSessionDraftCreateRequest,
  DashboardSessionDraftResource,
  DashboardSessionDraftSendRequest,
  DashboardSessionDraftSendTicket,
} from "./dashboard-session-drafts.js";
import { browserScheduleResource, scheduleEtag } from "./dashboard-schedule-resources.js";
import type { SessionResource } from "./session-api.js";
import {
  RemoteDashboardBackendError,
  hubKey,
  remoteError,
  resolveLimits,
  type RemoteDashboardBackendClient,
  type RemoteDashboardBackendLimits,
} from "./dashboard-remote-transport.js";
import { RemoteRichHub } from "./dashboard-remote-rich-hub.js";
import { RemoteTuiHub } from "./dashboard-remote-tui-hub.js";

/**
 * Public orchestration seam for the remote Dashboard backend.
 *
 * This module owns capability negotiation, neutral REST delegation, and hub
 * lifecycle; the framed Rich and TUI attachment transports live in
 * `dashboard-remote-rich-hub.ts` and `dashboard-remote-tui-hub.ts`, and their
 * shared primitives in `dashboard-remote-transport.ts`. The published
 * `./dashboard-remote-backend` entry point re-exports the transport's public
 * client, limits, and error surface so package consumers see one module.
 */

export {
  DEFAULT_REMOTE_DASHBOARD_LIMITS,
  RemoteDashboardBackendError,
} from "./dashboard-remote-transport.js";
export type {
  RemoteDashboardBackendClient,
  RemoteDashboardBackendLimits,
} from "./dashboard-remote-transport.js";

const DASHBOARD_COMMANDS: readonly DashboardCommandOperation[] = [
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

export interface RemoteDashboardBackendOptions {
  client: RemoteDashboardBackendClient;
  limits?: Partial<RemoteDashboardBackendLimits>;
}

/**
 * Dedicated DashboardBackend over the authenticated neutral REST API and the
 * daemon's framed RPC/TUI attachment protocols. One upstream attachment is
 * shared per session generation and presentation; browser pane identity and
 * controller arbitration remain local to the DashboardServer process.
 */
export class RemoteDashboardBackend implements DashboardBackend {
  readonly #client: RemoteDashboardBackendClient;
  readonly #limits: RemoteDashboardBackendLimits;
  readonly #richHubs = new Map<string, Promise<RemoteRichHub>>();
  readonly #tuiHubs = new Map<string, Promise<RemoteTuiHub>>();
  #capabilities: Promise<DashboardCapabilities> | undefined;
  #disposed = false;

  constructor(options: RemoteDashboardBackendOptions) {
    this.#client = options.client;
    this.#limits = resolveLimits(options.limits);
  }

  capabilities(): Promise<DashboardCapabilities> {
    this.#assertOpen();
    this.#capabilities ??= this.#client.dashboardCapabilities()
      .then((result) => dashboardCapabilities(result.data, this.#limits))
      .catch((error: unknown) => {
        this.#capabilities = undefined;
        throw remoteError(error);
      });
    return this.#capabilities.then((value) => structuredClone(value));
  }

  async diagnostics(): Promise<DashboardDiagnosticsSnapshot> {
    this.#assertOpen();
    const capabilities = await this.capabilities();
    if (capabilities.resources.diagnostics !== true) {
      throw new RemoteDashboardBackendError("diagnostics_unavailable", "remote dashboard diagnostics are unavailable");
    }
    return this.#call(() => this.#client.dashboardDiagnostics());
  }

  async listSessions(query: SessionInventoryQuery): Promise<SessionInventoryPage> {
    this.#assertOpen();
    return this.#call(() => this.#client.listDashboardSessions(query));
  }

  async getSessionInfo(inventoryId: string): Promise<SessionInfoResource> {
    this.#assertOpen();
    return this.#call(() => this.#client.getDashboardSession(inventoryId));
  }

  async getTranscript(inventoryId: string, query: TranscriptQuery): Promise<TranscriptPage> {
    this.#assertOpen();
    const info = await this.getSessionInfo(inventoryId);
    return this.#pagedTranscript(
      inventoryId,
      query,
      info.source.fingerprint?.value,
    );
  }

  async activateSession(
    inventoryId: string,
    request: ActivationRequest,
  ): Promise<ActivationTicket> {
    this.#assertOpen();
    return this.#call(() => this.#client.activateDashboardSession(inventoryId, request));
  }

  async getActivation(ticketId: string): Promise<ActivationTicket> {
    this.#assertOpen();
    return this.#call(() => this.#client.getDashboardActivation(ticketId));
  }

  async exportSession(
    sessionRef: string,
    request: SessionExportRequest,
  ): Promise<SessionExportTicket> {
    this.#assertOpen();
    return this.#call(() => this.#client.exportDashboardSession(sessionRef, request));
  }

  async getExport(ticketId: string): Promise<SessionExportTicket> {
    this.#assertOpen();
    return this.#call(() => this.#client.getDashboardExport(ticketId));
  }

  async createSessionDraft(
    request: DashboardSessionDraftCreateRequest,
  ): Promise<DashboardSessionDraftResource> {
    this.#assertOpen();
    await this.#assertDrafts();
    return this.#call(() => this.#client.createDashboardSessionDraft(request));
  }

  async getSessionDraft(draftId: string): Promise<DashboardSessionDraftResource> {
    this.#assertOpen();
    await this.#assertDrafts();
    return this.#call(() => this.#client.getDashboardSessionDraft(draftId));
  }

  async cancelSessionDraft(
    draftId: string,
    request: DashboardSessionDraftCancelRequest,
  ): Promise<DashboardSessionDraftResource> {
    this.#assertOpen();
    await this.#assertDrafts();
    return this.#call(() => this.#client.cancelDashboardSessionDraft(draftId, request));
  }

  async sendSessionDraft(
    draftId: string,
    request: DashboardSessionDraftSendRequest,
  ): Promise<DashboardSessionDraftSendTicket> {
    this.#assertOpen();
    await this.#assertDrafts();
    return this.#call(() => this.#client.sendDashboardSessionDraft(draftId, request));
  }

  async getSessionDraftSend(ticketId: string): Promise<DashboardSessionDraftSendTicket> {
    this.#assertOpen();
    await this.#assertDrafts();
    return this.#call(() => this.#client.getDashboardSessionDraftSend(ticketId));
  }

  async scheduleCapabilities(): Promise<ScheduleCapabilities> {
    this.#assertOpen();
    await this.#assertSchedules();
    return this.#call(() => this.#client.scheduleCapabilities());
  }

  async listSchedules(sessionRef?: string): Promise<DashboardScheduleResource[]> {
    this.#assertOpen();
    await this.#assertSchedules();
    const result = await this.#call(() => this.#client.listSchedules(sessionRef));
    if (result.schedules.length > DEFAULT_SCHEDULE_LIMITS.maxSchedules) {
      throw new RemoteDashboardBackendError("remote_schedule_capacity", "remote schedule count exceeds its bound");
    }
    return result.schedules.map(browserScheduleResource);
  }

  async getSchedule(scheduleId: string): Promise<DashboardScheduleResource> {
    this.#assertOpen();
    await this.#assertSchedules();
    return browserScheduleResource(await this.#call(() => this.#client.getSchedule(scheduleId)));
  }

  async createSchedule(request: DashboardScheduleMutationRequest): Promise<DashboardScheduleResource> {
    this.#assertOpen();
    await this.#assertSchedules();
    if (request.expectedRevision !== undefined || request.schedule.prompt === undefined) {
      throw new RemoteDashboardBackendError("invalid_schedule_request", "create requires prompt and no expectedRevision");
    }
    return browserScheduleResource(await this.#call(() => this.#client.createSchedule(
      request.schedule.scheduleId,
      request.schedule,
      request.idempotencyKey,
    )));
  }

  async updateSchedule(scheduleId: string, request: DashboardScheduleMutationRequest): Promise<DashboardScheduleResource> {
    this.#assertOpen();
    await this.#assertSchedules();
    if (request.schedule.scheduleId !== scheduleId || request.expectedRevision === undefined) {
      throw new RemoteDashboardBackendError("invalid_schedule_request", "schedule identity and expectedRevision are required");
    }
    const expectedRevision = request.expectedRevision;
    const current = request.schedule.prompt === undefined
      ? await this.#call(() => this.#client.getSchedule(scheduleId))
      : undefined;
    return browserScheduleResource(await this.#call(() => this.#client.updateSchedule(
      scheduleId,
      {
        ...request.schedule,
        prompt: request.schedule.prompt ?? current!.prompt,
        expectedRevision,
      },
      scheduleEtag(scheduleId, expectedRevision),
      request.idempotencyKey,
    )));
  }

  async deleteSchedule(scheduleId: string, request: DashboardScheduleDeleteRequest): Promise<void> {
    this.#assertOpen();
    await this.#assertSchedules();
    await this.#call(() => this.#client.deleteSchedule(
      scheduleId,
      scheduleEtag(scheduleId, request.expectedRevision),
      request.idempotencyKey,
    ));
  }

  async scheduleStatus(): Promise<DashboardScheduleStatus> {
    this.#assertOpen();
    await this.#assertSchedules();
    return this.#call(() => this.#client.scheduleStatus());
  }

  async getManagedSession(sessionRef: string): Promise<SessionResource> {
    this.#assertOpen();
    return this.#call(() => this.#client.getSession(sessionRef));
  }

  async openSessionChannel(options: SessionChannelOptions): Promise<DashboardChannel> {
    this.#assertOpen();
    await this.capabilities();
    const session = await this.getManagedSession(options.sessionRef);
    const generation = options.generation ?? session.generation;
    if (generation !== session.generation) {
      throw new RemoteDashboardBackendError("stale_generation", "session generation changed");
    }
    const key = hubKey(session.sessionId, generation);
    let pending = this.#richHubs.get(key);
    if (pending === undefined) {
      if (this.#richHubs.size >= this.#limits.maxRichHubs) {
        throw new RemoteDashboardBackendError(
          "remote_channel_capacity",
          "remote Rich channel capacity reached",
          true,
        );
      }
      pending = RemoteRichHub.create({
        client: this.#client,
        sessionRef: session.sessionId,
        generation,
        initialRole: options.role,
        ...(options.cursor === undefined ? {} : { initialCursor: options.cursor }),
        loadPreview: () => this.#loadPreview(session.sessionId),
        limits: this.#limits,
        onIdle: () => this.#richHubs.delete(key),
      });
      this.#richHubs.set(key, pending);
      void pending.catch(() => {
        if (this.#richHubs.get(key) === pending) this.#richHubs.delete(key);
      });
    }
    return (await pending).open(options);
  }

  async openTuiChannel(options: TuiChannelOptions): Promise<DashboardTuiChannel> {
    this.#assertOpen();
    const capabilities = await this.capabilities();
    if (!capabilities.presentations.tui.available) {
      throw new RemoteDashboardBackendError(
        "tui_unavailable",
        capabilities.presentations.tui.unavailableReason ?? "TUI presentation is unavailable",
      );
    }
    const session = await this.getManagedSession(options.sessionRef);
    const generation = options.generation ?? session.generation;
    if (generation !== session.generation) {
      throw new RemoteDashboardBackendError("stale_generation", "session generation changed");
    }
    const key = hubKey(session.sessionId, generation);
    let pending = this.#tuiHubs.get(key);
    if (pending === undefined) {
      if (this.#tuiHubs.size >= this.#limits.maxTuiHubs) {
        throw new RemoteDashboardBackendError(
          "remote_tui_capacity",
          "remote TUI channel capacity reached",
          true,
        );
      }
      pending = RemoteTuiHub.create({
        client: this.#client,
        sessionRef: session.sessionId,
        generation,
        initialOptions: options,
        limits: this.#limits,
        onIdle: () => this.#tuiHubs.delete(key),
      });
      this.#tuiHubs.set(key, pending);
      void pending.catch(() => {
        if (this.#tuiHubs.get(key) === pending) this.#tuiHubs.delete(key);
      });
    }
    return (await pending).open(options);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const pending of this.#richHubs.values()) {
      void pending.then((hub) => hub.dispose("remote backend disposed")).catch(() => undefined);
    }
    for (const pending of this.#tuiHubs.values()) {
      void pending.then((hub) => hub.dispose("remote backend disposed")).catch(() => undefined);
    }
    this.#richHubs.clear();
    this.#tuiHubs.clear();
  }

  async #loadPreview(sessionId: string): Promise<NormalizedTranscriptRecord[]> {
    const page = await this.#call(() => this.#client.listDashboardSessions({
      search: sessionId,
      limit: DASH_DEFAULT_LIMITS.maxInventoryPageItems,
    }));
    const match = page.sessions.find((candidate) => candidate.managed?.sessionId === sessionId);
    if (match === undefined) return [];
    const info = await this.#call(() => this.#client.getDashboardSession(match.inventoryId));
    const transcript = await this.#pagedTranscript(
      match.inventoryId,
      { limit: DASH_DEFAULT_LIMITS.maxTranscriptPageRecords },
      info.source.fingerprint?.value,
    );
    return transcript.records;
  }

  async #pagedTranscript(
    inventoryId: string,
    query: TranscriptQuery,
    expectedFingerprint: DashboardFingerprint | undefined,
  ): Promise<TranscriptPage> {
    const requestedLimit = query.limit ?? DASH_DEFAULT_LIMITS.maxTranscriptPageRecords;
    const direction = query.cursor === undefined ? "older" : (query.direction ?? "older");
    const pages: TranscriptPage[] = [];
    const records: NormalizedTranscriptRecord[] = [];
    let cursor = query.cursor;
    let remaining = requestedLimit;
    const seenCursors = new Set<DashboardCursor>();
    while (remaining > 0) {
      const page = await this.#call(() => this.#client.getDashboardTranscript(
        inventoryId,
        {
          ...query,
          limit: Math.min(3, remaining),
          ...(cursor === undefined ? {} : { cursor }),
        },
        expectedFingerprint,
      ));
      pages.push(page);
      if (direction === "older") records.unshift(...page.records);
      else records.push(...page.records);
      remaining -= page.records.length;
      const nextCursor = direction === "older" ? page.olderCursor : page.newerCursor;
      if (
        page.records.length === 0 ||
        nextCursor === undefined ||
        seenCursors.has(nextCursor)
      ) break;
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }
    const first = pages[0];
    const last = pages.at(-1);
    if (first === undefined || last === undefined) {
      throw new RemoteDashboardBackendError(
        "remote_protocol_error",
        "remote transcript paging returned no page",
      );
    }
    const { olderCursor: _older, newerCursor: _newer, records: _records, ...base } = first;
    const olderCursor = direction === "older" ? last.olderCursor : first.olderCursor;
    const newerCursor = direction === "older" ? first.newerCursor : last.newerCursor;
    return {
      ...base,
      records,
      ...(olderCursor === undefined ? {} : { olderCursor }),
      ...(newerCursor === undefined ? {} : { newerCursor }),
    };
  }

  async #assertDrafts(): Promise<void> {
    if (!(await this.capabilities()).resources.sessionDrafts) {
      throw new RemoteDashboardBackendError(
        "drafts_unavailable",
        "remote daemon does not advertise Dashboard session draft resources",
      );
    }
  }

  async #assertSchedules(): Promise<void> {
    if (!(await this.capabilities()).resources.schedules) {
      throw new RemoteDashboardBackendError(
        "schedules_unavailable",
        "remote daemon does not advertise Dashboard schedule resources",
      );
    }
  }

  async #call<T>(operation: () => Promise<{ data: T }>): Promise<T> {
    try {
      return (await operation()).data;
    } catch (error) {
      throw remoteError(error);
    }
  }

  #assertOpen(): void {
    if (this.#disposed) {
      throw new RemoteDashboardBackendError("backend_closed", "remote dashboard backend is closed");
    }
  }
}

function dashboardCapabilities(
  service: DashboardServiceCapabilities,
  localLimits: RemoteDashboardBackendLimits,
): DashboardCapabilities {
  if (
    service.apiVersion !== DASH_API_VERSION ||
    service.authentication !== "service-bearer" ||
    !service.presentations.rich.available ||
    service.presentations.tui.subprotocol !== "pi-daemon-tui.v1"
  ) {
    throw new RemoteDashboardBackendError(
      "remote_capability_mismatch",
      "remote Dashboard service is not compatible with this backend",
    );
  }
  const commands: DashboardCommandOperation[] = [
    ...DASHBOARD_COMMANDS,
    ...(service.resources.treeNavigation === true ? ["navigate_tree" as const] : []),
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
      export: service.resources.export,
      workspaces: true,
      settings: true,
      schedules: service.resources.schedules === true,
      sessionDrafts: service.resources.sessionDrafts === true,
      treeNavigation: service.resources.treeNavigation === true,
      diagnostics: service.resources.diagnostics === true,
    },
    presentations: {
      rich: { available: true, replay: true, controller: true, commands },
      tui: service.presentations.tui.available
        ? { available: true, replay: true, controller: true, commands }
        : {
            available: false,
            replay: true,
            controller: true,
            commands,
            unavailableReason: service.presentations.tui.unavailableReason ?? "remote-tui-unavailable",
          },
    },
    ...(service.extensionViews === undefined
      ? {}
      : { extensionViews: structuredClone(service.extensionViews) }),
    ...(service.sessionDefaults === undefined
      ? {}
      : { sessionDefaults: structuredClone(service.sessionDefaults) }),
    limits: {
      ...service.limits,
      maxSubscriptionsPerConnection: Math.min(
        service.limits.maxSubscriptionsPerConnection,
        localLimits.maxChannelsPerHub,
      ),
      maxReplayEvents: Math.min(service.limits.maxReplayEvents, localLimits.maxReplayEvents),
      maxReplayEventBytes: Math.min(service.limits.maxReplayEventBytes, localLimits.maxEventBytes),
      maxReplayBytesPerSession: Math.min(
        service.limits.maxReplayBytesPerSession,
        localLimits.maxReplayBytes,
      ),
      maxInFlightCommandsPerConnection: Math.min(
        service.limits.maxInFlightCommandsPerConnection,
        localLimits.maxInFlightCommands,
      ),
    },
    performanceBudgets: { ...DASH_PERFORMANCE_BUDGETS },
  };
}
