import { join } from "node:path";

import type { LoadedPiDaemonConfig } from "./config.js";
import {
  InProcessDashboardBackend,
  type InProcessDashboardTuiChannels,
} from "./dashboard-backend.js";
import { DashboardNeutralApiController } from "./dashboard-neutral-api.js";
import {
  DashboardSessionDraftService,
  FileDashboardSessionDraftStore,
} from "./dashboard-session-drafts.js";
import { Multiplexer } from "./multiplexer.js";
import type { RpcAttachmentManager } from "./rpc-attachments.js";
import type { SessionCatalogStore } from "./session-catalog.js";
import type { SchedulerRuntime } from "./scheduler-runtime.js";
import type { FileScheduleStore } from "./schedule-store.js";
import {
  resolveSessionInventoryConfig,
  SessionInventory,
} from "./session-inventory.js";
import { FileSessionOwnershipStore } from "./session-ownership-store.js";
import {
  MultiplexerSessionOwnershipRuntime,
  SessionOwnershipService,
} from "./session-ownership.js";
import { TranscriptProjector } from "./transcript-projector.js";

export interface EmbeddedDashboardServiceRuntimeOptions {
  loadedConfig: LoadedPiDaemonConfig;
  stateDir: string;
  agentDir: string;
  allowedRoots: readonly string[];
  catalog: Pick<SessionCatalogStore, "recover">;
  multiplexer: Multiplexer;
  schedules?: FileScheduleStore;
  scheduler?: Pick<SchedulerRuntime, "recompute" | "status">;
  rpcAttachments?: Pick<RpcAttachmentManager, "hasController">;
  tuiChannels?: InProcessDashboardTuiChannels;
}

export interface EmbeddedDashboardServiceRecovery {
  queuedOwnershipTickets: number;
  indeterminateOwnershipTickets: number;
  ownershipRecords: number;
  sessionDrafts: number;
  sessionDraftTickets: number;
  queuedSessionDraftTickets: number;
  runningSessionDraftTickets: number;
  indeterminateSessionDraftTickets: number;
}

/**
 * One policy-owning Dashboard service graph shared by the embedded browser BFF
 * and the authenticated neutral API. Construction never hydrates a Pi session
 * or submits a model turn; inventory reconcile remains background work.
 */
export class EmbeddedDashboardServiceRuntime {
  readonly inventory: SessionInventory;
  readonly projector: TranscriptProjector;
  readonly ownership: SessionOwnershipService;
  readonly drafts: DashboardSessionDraftService;
  readonly backend: InProcessDashboardBackend;
  readonly neutralApi: DashboardNeutralApiController;
  readonly recovery: EmbeddedDashboardServiceRecovery;

  #stopped = false;

  private constructor(options: {
    inventory: SessionInventory;
    projector: TranscriptProjector;
    ownership: SessionOwnershipService;
    drafts: DashboardSessionDraftService;
    backend: InProcessDashboardBackend;
    neutralApi: DashboardNeutralApiController;
    recovery: EmbeddedDashboardServiceRecovery;
  }) {
    this.inventory = options.inventory;
    this.projector = options.projector;
    this.ownership = options.ownership;
    this.drafts = options.drafts;
    this.backend = options.backend;
    this.neutralApi = options.neutralApi;
    this.recovery = options.recovery;
  }

  static async create(
    options: EmbeddedDashboardServiceRuntimeOptions,
  ): Promise<EmbeddedDashboardServiceRuntime> {
    const piSessionsRoot = join(options.agentDir, "sessions");
    const daemonSessionsRoot = join(options.stateDir, "owned-sessions");
    const inventoryConfig = resolveSessionInventoryConfig(options.loadedConfig, {
      defaultSessionRoot: piSessionsRoot,
    });

    let ownership: SessionOwnershipService;
    const inventory = new SessionInventory({
      stateDir: options.stateDir,
      catalog: options.catalog,
      roots: inventoryConfig.roots,
      limits: inventoryConfig.limits,
      activationPolicy: (input) => ownership.activationPolicy(input),
      ownershipResolver: (input) => ownership.resolveInventoryOwnership(input),
    });
    const projector = new TranscriptProjector({ stateDir: options.stateDir });
    const ownershipRuntime = new MultiplexerSessionOwnershipRuntime(options.multiplexer);
    const drafts = new DashboardSessionDraftService({
      store: new FileDashboardSessionDraftStore({ stateDir: options.stateDir }),
      allowedRoots: options.allowedRoots,
    });
    let backend: InProcessDashboardBackend | undefined;
    ownership = new SessionOwnershipService({
      stateDir: options.stateDir,
      inventory,
      store: new FileSessionOwnershipStore({ stateDir: options.stateDir }),
      runtime: ownershipRuntime,
      runtimeSpec: ({ info }) => ({
        cwd: info.cwd,
        target: { mode: "memory" },
        tools: { mode: "none" },
        resources: {
          extensions: [],
          skills: [],
          promptTemplates: [],
          themes: [],
        },
        isolation: { mode: "unisolated" },
      }),
      piSessionsRoot,
      daemonSessionsRoot,
      sourceRoots: inventoryConfig.roots,
      allowedCwdRoots: options.allowedRoots,
      ...(options.loadedConfig.config.sessionStorage?.mode === undefined
        ? {}
        : { storageMode: options.loadedConfig.config.sessionStorage.mode }),
      hasController: (sessionId) =>
        (backend?.hasController(sessionId) ?? false) ||
        (options.rpcAttachments?.hasController(sessionId) ?? false),
      isMutationActive: async (sessionId) => {
        const retained = await options.multiplexer.retainedSession(sessionId);
        return retained !== undefined && retained.state !== "idle";
      },
    });
    backend = new InProcessDashboardBackend({
      inventory,
      projector,
      ownership,
      multiplexer: options.multiplexer,
      drafts,
      ...(options.schedules === undefined ? {} : { schedules: options.schedules }),
      ...(options.scheduler === undefined ? {} : { scheduler: options.scheduler }),
      ...(options.tuiChannels === undefined ? {} : { tuiChannels: options.tuiChannels }),
    });
    const neutralApi = new DashboardNeutralApiController({
      inventory,
      projector,
      ownership,
      drafts,
      tuiAvailable: options.tuiChannels !== undefined,
      schedulesAvailable: options.schedules !== undefined,
      ...(options.tuiChannels === undefined
        ? { tuiUnavailableReason: "server-side interactive view is unavailable" }
        : {}),
    });

    try {
      await ownership.initialize();
      const [recovered, draftRecovery] = await Promise.all([
        ownership.recover(),
        drafts.recover(),
      ]);
      await inventory.start();
      return new EmbeddedDashboardServiceRuntime({
        inventory,
        projector,
        ownership,
        drafts,
        backend,
        neutralApi,
        recovery: {
          queuedOwnershipTickets: recovered.queued,
          indeterminateOwnershipTickets: recovered.indeterminate,
          ownershipRecords: recovered.records,
          sessionDrafts: draftRecovery.drafts,
          sessionDraftTickets: draftRecovery.tickets,
          queuedSessionDraftTickets: draftRecovery.queuedTickets,
          runningSessionDraftTickets: draftRecovery.runningTickets,
          indeterminateSessionDraftTickets: draftRecovery.indeterminateTickets,
        },
      });
    } catch (error) {
      backend.dispose();
      await inventory.stop().catch(() => undefined);
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    this.backend.dispose();
    await this.inventory.stop();
  }
}
