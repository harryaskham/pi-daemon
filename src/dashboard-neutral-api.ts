import {
  DASH_API_VERSION,
  DASH_DEFAULT_LIMITS,
  type ActivationRequest,
  type ActivationTicket,
  type DashboardFingerprint,
  type DashboardLeaseResource,
  type DashboardLimits,
  type DashboardServiceCapabilities,
  type DashboardSessionDefaultsResource,
  type SessionExportRequest,
  type SessionExportTicket,
  type SessionInfoResource,
  type SessionInventoryPage,
  type SessionInventoryQuery,
  type TranscriptPage,
  type TranscriptQuery,
} from "./dashboard-contract.js";
import type { SessionInventory } from "./session-inventory.js";
import { EXTENSION_VIEW_CAPABILITY } from "./extension-view-contract.js";
import {
  DashboardSessionDraftError,
  type DashboardSessionDraftCancelRequest,
  type DashboardSessionDraftCreateRequest,
  type DashboardSessionDraftExecution,
  type DashboardSessionDraftResource,
  type DashboardSessionDraftSendRequest,
  type DashboardSessionDraftSendTicket,
  type DashboardSessionDraftService,
} from "./dashboard-session-drafts.js";
import {
  SessionOwnershipError,
  type SessionOwnershipService,
} from "./session-ownership.js";
import {
  SessionOwnershipStoreError,
  ownershipRecordInfo,
} from "./session-ownership-store.js";
import {
  TranscriptProjectionError,
  type TranscriptProjector,
} from "./transcript-projector.js";

export interface DashboardNeutralApi {
  capabilities(): Promise<DashboardServiceCapabilities>;
  listSessions(query: SessionInventoryQuery): Promise<SessionInventoryPage>;
  getSessionInfo(inventoryId: string): Promise<SessionInfoResource>;
  getTranscript(
    inventoryId: string,
    query: TranscriptQuery,
    expectedFingerprint?: DashboardFingerprint,
  ): Promise<TranscriptPage>;
  activateSession(inventoryId: string, request: ActivationRequest): Promise<ActivationTicket>;
  getActivation(ticketId: string): Promise<ActivationTicket>;
  exportSession(sessionRef: string, request: SessionExportRequest): Promise<SessionExportTicket>;
  getExport(ticketId: string): Promise<SessionExportTicket>;
  renewLease(sessionRef: string, leaseId: string): Promise<DashboardLeaseResource>;
  createSessionDraft(request: DashboardSessionDraftCreateRequest): Promise<DashboardSessionDraftResource>;
  getSessionDraft(draftId: string): Promise<DashboardSessionDraftResource>;
  cancelSessionDraft(draftId: string, request: DashboardSessionDraftCancelRequest): Promise<DashboardSessionDraftResource>;
  sendSessionDraft(draftId: string, request: DashboardSessionDraftSendRequest): Promise<DashboardSessionDraftSendTicket>;
  getSessionDraftSend(ticketId: string): Promise<DashboardSessionDraftSendTicket>;
}

export interface DashboardNeutralApiControllerOptions {
  inventory: Pick<SessionInventory, "list" | "getInfo">;
  projector: TranscriptProjector;
  ownership: SessionOwnershipService;
  limits?: Partial<DashboardLimits>;
  tuiAvailable?: boolean;
  tuiUnavailableReason?: string;
  schedulesAvailable?: boolean;
  drafts?: Pick<DashboardSessionDraftService, "create" | "get" | "cancel">;
  draftExecution?: DashboardSessionDraftExecution;
  sessionDefaults?: DashboardSessionDefaultsResource;
}

/** Transport-neutral service API used by authenticated HTTP and remote backends. */
export class DashboardNeutralApiController implements DashboardNeutralApi {
  readonly #inventory: DashboardNeutralApiControllerOptions["inventory"];
  readonly #projector: TranscriptProjector;
  readonly #ownership: SessionOwnershipService;
  readonly #limits: DashboardLimits;
  readonly #tuiAvailable: boolean;
  readonly #tuiUnavailableReason: string | undefined;
  readonly #schedulesAvailable: boolean;
  readonly #drafts: DashboardNeutralApiControllerOptions["drafts"];
  readonly #draftExecution: DashboardSessionDraftExecution | undefined;
  readonly #sessionDefaults: DashboardSessionDefaultsResource | undefined;

  constructor(options: DashboardNeutralApiControllerOptions) {
    this.#inventory = options.inventory;
    this.#projector = options.projector;
    this.#ownership = options.ownership;
    this.#limits = mergeLimits(options.limits);
    this.#tuiAvailable = options.tuiAvailable ?? false;
    this.#tuiUnavailableReason = options.tuiUnavailableReason;
    this.#schedulesAvailable = options.schedulesAvailable ?? false;
    this.#drafts = options.drafts;
    this.#draftExecution = options.draftExecution;
    this.#sessionDefaults = options.sessionDefaults;
  }

  async capabilities(): Promise<DashboardServiceCapabilities> {
    return {
      apiVersion: DASH_API_VERSION,
      authentication: "service-bearer",
      resources: {
        inventory: true,
        transcriptPreview: true,
        activation: true,
        ownership: true,
        export: true,
        leases: true,
        ...(this.#schedulesAvailable ? { schedules: true } : {}),
        ...(this.#drafts === undefined ? {} : { sessionDrafts: true }),
        treeNavigation: true,
      },
      presentations: {
        rich: { available: true },
        tui: {
          available: this.#tuiAvailable,
          subprotocol: "pi-daemon-tui.v1",
          ...(this.#tuiAvailable || this.#tuiUnavailableReason === undefined
            ? {}
            : { unavailableReason: this.#tuiUnavailableReason }),
        },
      },
      extensionViews: structuredClone(EXTENSION_VIEW_CAPABILITY),
      ...(this.#sessionDefaults === undefined
        ? {}
        : { sessionDefaults: structuredClone(this.#sessionDefaults) }),
      limits: { ...this.#limits },
    };
  }

  listSessions(query: SessionInventoryQuery): Promise<SessionInventoryPage> {
    return this.#inventory.list(query);
  }

  async getSessionInfo(inventoryId: string): Promise<SessionInfoResource> {
    const info = await this.#inventory.getInfo(inventoryId);
    if (info === undefined) {
      throw new DashboardNeutralApiError(404, "inventory_not_found", "inventory item not found");
    }
    return info;
  }

  async getTranscript(
    inventoryId: string,
    query: TranscriptQuery,
    expectedFingerprint?: DashboardFingerprint,
  ): Promise<TranscriptPage> {
    const info = await this.getSessionInfo(inventoryId);
    if (info.source.canonicalPath === undefined || info.source.fingerprint === undefined) {
      throw new DashboardNeutralApiError(
        409,
        "transcript_source_unavailable",
        "inventory item has no previewable source",
      );
    }
    if (
      expectedFingerprint !== undefined &&
      expectedFingerprint !== info.source.fingerprint.value
    ) {
      throw new DashboardNeutralApiError(
        409,
        "source_fingerprint_changed",
        "inventory source changed before transcript projection",
        true,
      );
    }
    return this.#projector.project({
      inventoryId,
      path: info.source.canonicalPath,
      query,
      expectedFingerprint: expectedFingerprint ?? info.source.fingerprint.value,
    });
  }

  activateSession(
    inventoryId: string,
    request: ActivationRequest,
  ): Promise<ActivationTicket> {
    return this.#ownership.activateSession(inventoryId, request);
  }

  getActivation(ticketId: string): Promise<ActivationTicket> {
    return this.#ownership.getActivation(ticketId);
  }

  exportSession(
    sessionRef: string,
    request: SessionExportRequest,
  ): Promise<SessionExportTicket> {
    return this.#ownership.exportSession(sessionRef, request);
  }

  getExport(ticketId: string): Promise<SessionExportTicket> {
    return this.#ownership.getExport(ticketId);
  }

  async createSessionDraft(
    request: DashboardSessionDraftCreateRequest,
  ): Promise<DashboardSessionDraftResource> {
    return this.#draftService().create(request);
  }

  async getSessionDraft(draftId: string): Promise<DashboardSessionDraftResource> {
    const draft = await this.#draftService().get(draftId);
    if (draft === undefined) {
      throw new DashboardNeutralApiError(404, "draft_not_found", "dashboard session draft not found");
    }
    return draft;
  }

  cancelSessionDraft(
    draftId: string,
    request: DashboardSessionDraftCancelRequest,
  ): Promise<DashboardSessionDraftResource> {
    return this.#draftService().cancel(draftId, request);
  }

  sendSessionDraft(
    draftId: string,
    request: DashboardSessionDraftSendRequest,
  ): Promise<DashboardSessionDraftSendTicket> {
    return this.#draftExecutor().submitSend(draftId, request);
  }

  async getSessionDraftSend(ticketId: string): Promise<DashboardSessionDraftSendTicket> {
    const ticket = await this.#draftExecutor().getSend(ticketId);
    if (ticket === undefined) {
      throw new DashboardNeutralApiError(404, "draft_ticket_not_found", "draft send ticket not found");
    }
    return ticket;
  }

  async renewLease(sessionRef: string, leaseId: string): Promise<DashboardLeaseResource> {
    const record = await this.#ownership.renewLease(sessionRef, leaseId);
    return {
      sessionRef: record.managedSessionId,
      leaseId: record.lease.leaseId,
      ...(record.lease.expiresAt === undefined ? {} : { expiresAt: record.lease.expiresAt }),
      ownership: ownershipRecordInfo(record),
    };
  }

  #draftService(): NonNullable<DashboardNeutralApiControllerOptions["drafts"]> {
    if (this.#drafts === undefined) {
      throw new DashboardNeutralApiError(404, "drafts_unavailable", "dashboard session drafts are unavailable");
    }
    return this.#drafts;
  }

  #draftExecutor(): DashboardSessionDraftExecution {
    if (this.#draftExecution === undefined) {
      throw new DashboardNeutralApiError(
        503,
        "draft_execution_unavailable",
        "dashboard session draft execution is unavailable",
        true,
      );
    }
    return this.#draftExecution;
  }
}

export class DashboardNeutralApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;

  constructor(status: number, code: string, message: string, retryable = false) {
    super(message);
    this.name = "DashboardNeutralApiError";
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

export function normalizeDashboardNeutralError(error: unknown): DashboardNeutralApiError {
  if (error instanceof DashboardNeutralApiError) return error;
  if (error instanceof TranscriptProjectionError) {
    return new DashboardNeutralApiError(
      error.code.includes("too_large") || error.code.includes("capacity") ? 413 :
        error.code.includes("fingerprint") || error.code.includes("stale") ? 409 : 422,
      error.code,
      error.message,
      error.retryable,
    );
  }
  if (error instanceof DashboardSessionDraftError) {
    const status = error.code.includes("not_found") ? 404 :
      error.code.includes("capacity") ? 429 :
        error.code.includes("conflict") || error.code.includes("indeterminate") ? 409 : 422;
    return new DashboardNeutralApiError(status, error.code, error.message, error.retryable);
  }
  if (error instanceof SessionOwnershipError || error instanceof SessionOwnershipStoreError) {
    const code = error.code;
    const status =
      code.includes("not_found") ? 404 :
        code.includes("capacity") ? 429 :
          code.includes("too_large") ? 413 :
            code.includes("conflict") ||
              code.includes("busy") ||
              code.includes("writer") ||
              code.includes("controller") ||
              code.includes("fingerprint") ||
              code.includes("diverged") ||
              code.includes("lease") ? 409 : 422;
    return new DashboardNeutralApiError(status, code, error.message, error.retryable);
  }
  return new DashboardNeutralApiError(
    500,
    "dashboard_api_failed",
    "dashboard service operation failed",
  );
}

function mergeLimits(overrides: Partial<DashboardLimits> | undefined): DashboardLimits {
  const limits = { ...DASH_DEFAULT_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new RangeError(`dashboard limit ${name} must be a positive safe integer`);
    }
  }
  return limits;
}
