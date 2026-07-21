import { join } from "node:path";

import type {
  LoadedPiDaemonConfig,
  PiDaemonWebRuntimePolicyConfig,
} from "./config.js";
import {
  InProcessDashboardBackend,
  type InProcessDashboardTuiChannels,
} from "./dashboard-backend.js";
import { DashboardNeutralApiController } from "./dashboard-neutral-api.js";
import {
  DashboardSessionDraftService,
  FileDashboardSessionDraftStore,
} from "./dashboard-session-drafts.js";
import {
  DashboardSessionDraftMaterializer,
  MultiplexerDashboardSessionDraftRuntime,
} from "./dashboard-session-materializer.js";
import { Multiplexer } from "./multiplexer.js";
import type { RpcAttachmentManager } from "./rpc-attachments.js";
import type { SessionCatalogStore } from "./session-catalog.js";
import type { SessionSpec } from "./session-api.js";
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

export function dashboardActivationRuntimeSpec(
  cwd: string,
  policy: PiDaemonWebRuntimePolicyConfig | undefined,
): SessionSpec {
  const configured = policy === undefined ? undefined : structuredClone(policy);
  return {
    cwd,
    target: { mode: "memory" },
    ...(configured?.model === undefined ? {} : { model: configured.model }),
    tools: configured?.tools ?? { mode: "none" },
    resources: {
      extensions: [],
      skills: [],
      promptTemplates: [],
      themes: [],
      noContextFiles: true,
      ...(configured?.resources ?? {}),
    },
    ...(configured?.settings === undefined ? {} : { settings: configured.settings }),
    isolation: { mode: "unisolated" },
  };
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
  readonly draftMaterializer: DashboardSessionDraftMaterializer;
  readonly backend: InProcessDashboardBackend;
  readonly neutralApi: DashboardNeutralApiController;
  readonly recovery: EmbeddedDashboardServiceRecovery;

  #stopped = false;

  private constructor(options: {
    inventory: SessionInventory;
    projector: TranscriptProjector;
    ownership: SessionOwnershipService;
    drafts: DashboardSessionDraftService;
    draftMaterializer: DashboardSessionDraftMaterializer;
    backend: InProcessDashboardBackend;
    neutralApi: DashboardNeutralApiController;
    recovery: EmbeddedDashboardServiceRecovery;
  }) {
    this.inventory = options.inventory;
    this.projector = options.projector;
    this.ownership = options.ownership;
    this.drafts = options.drafts;
    this.draftMaterializer = options.draftMaterializer;
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
    const runtimePolicy = options.loadedConfig.config.web?.runtimePolicy;

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
    const draftStore = new FileDashboardSessionDraftStore({ stateDir: options.stateDir });
    const drafts = new DashboardSessionDraftService({
      store: draftStore,
      allowedRoots: options.allowedRoots,
    });
    let backend: InProcessDashboardBackend | undefined;
    const draftMaterializer = new DashboardSessionDraftMaterializer({
      store: draftStore,
      runtime: new MultiplexerDashboardSessionDraftRuntime({
        multiplexer: options.multiplexer,
        hasController: (sessionId) =>
          (backend?.hasController(sessionId) ?? false) ||
          (options.rpcAttachments?.hasController(sessionId) ?? false),
      }),
    });
    ownership = new SessionOwnershipService({
      stateDir: options.stateDir,
      inventory,
      store: new FileSessionOwnershipStore({ stateDir: options.stateDir }),
      runtime: ownershipRuntime,
      runtimeSpec: ({ info }) =>
        dashboardActivationRuntimeSpec(info.cwd, runtimePolicy),
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
      draftExecution: draftMaterializer,
      ...(options.schedules === undefined ? {} : { schedules: options.schedules }),
      ...(options.scheduler === undefined ? {} : { scheduler: options.scheduler }),
      ...(options.tuiChannels === undefined ? {} : { tuiChannels: options.tuiChannels }),
    });
    const neutralApi = new DashboardNeutralApiController({
      inventory,
      projector,
      ownership,
      drafts,
      draftExecution: draftMaterializer,
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
        draftMaterializer.recover(),
      ]);
      await inventory.start();
      return new EmbeddedDashboardServiceRuntime({
        inventory,
        projector,
        ownership,
        drafts,
        draftMaterializer,
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
      draftMaterializer.beginDrain();
      await draftMaterializer.settle().catch(() => undefined);
      backend.dispose();
      await inventory.stop().catch(() => undefined);
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    this.draftMaterializer.beginDrain();
    await this.draftMaterializer.settle();
    this.backend.dispose();
    await this.inventory.stop();
  }
}
