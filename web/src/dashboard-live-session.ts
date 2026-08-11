import type {
  ActivationMode,
  ActivationTicket,
  DashboardFingerprint,
  DashboardBackend,
  DashboardChannel,
  DashboardChannelEvent,
  DashboardCommandOperation,
  DashboardCommandResult,
  DashboardControllerRole,
  DashboardExtensionUiEvent,
  DashboardExtensionViewEvent,
  DashboardSessionIdentity,
  DashboardTicketState,
  NormalizedTranscriptRecord,
  SessionExportTicket,
  SessionInfoResource,
  TranscriptPage,
  TranscriptContentBlock,
  TranscriptMessageRecord,
  TranscriptTimelineRecord,
  TranscriptToolRecord,
} from "@harryaskham/pi-daemon/dashboard-contract";
import { DASH_DIRECT_COOPT_POLICY_REF } from "@harryaskham/pi-daemon/dashboard-contract";
import type { JsonObject, JsonValue, SessionResource } from "@harryaskham/pi-daemon/session-api";
import {
  createTranscriptStore,
  transcriptStoreReducer,
  type TranscriptStoreState,
} from "./transcript-store";
import {
  parseSessionTree,
  type SessionTreeModel,
} from "./session-tree";

export type LiveSessionTreePhase = "idle" | "loading" | "ready" | "stale" | "mutating" | "error";

export type LiveSessionPhase =
  | "preview-loading"
  | "preview"
  | "activation-choice"
  | "activating"
  | "hydrating"
  | "live"
  | "streaming"
  | "reconnecting"
  | "preview-only"
  | "indeterminate"
  | "error"
  | "closed";

export interface LiveExtensionRequest {
  requestId: string;
  method: string;
  payload: JsonObject;
}

export interface LiveExtensionNotification {
  requestId: string;
  message: string;
  type: "info" | "warning" | "error";
}

export interface LiveExtensionWidget {
  key: string;
  lines: string[];
  placement: "aboveEditor" | "belowEditor";
}

export type PendingSteeringMessageState =
  | "pending"
  | "delivering"
  | "delivered"
  | "indeterminate";

/** Browser-private preview of a message waiting for the next Pi steering point. */
export interface PendingSteeringMessage {
  queueId: string;
  preview: string;
  truncated: boolean;
  queuedAt: string;
  state: PendingSteeringMessageState;
  errorCode?: string;
}

export interface DashboardLiveSessionState {
  inventoryId: string;
  phase: LiveSessionPhase;
  info?: SessionInfoResource;
  transcript?: TranscriptStoreState;
  transcriptAvailability?: TranscriptPage["availability"];
  transcriptFreshness?: TranscriptPage["freshness"];
  managedSession?: SessionResource;
  identity?: DashboardSessionIdentity;
  role: DashboardControllerRole;
  rpcState: JsonObject;
  requestState: JsonObject;
  sessionStats?: JsonValue;
  availableCommands?: JsonValue;
  availableModels?: JsonValue;
  activationModes: ActivationMode[];
  selectedActivationMode?: ActivationMode;
  previewFingerprint?: DashboardFingerprint;
  activationTicket?: ActivationTicket;
  exportTicket?: SessionExportTicket;
  extensionRequests: LiveExtensionRequest[];
  extensionViews: DashboardExtensionViewEvent[];
  extensionNotifications: LiveExtensionNotification[];
  extensionStatuses: Record<string, string>;
  extensionWidgets: Record<string, LiveExtensionWidget>;
  pendingSteeringMessages: PendingSteeringMessage[];
  extensionTitle?: string;
  extensionEditorText?: string;
  tree?: SessionTreeModel;
  treePhase: LiveSessionTreePhase;
  treeSelectedEntryId?: string;
  treeCompareEntryId?: string;
  treeEditorText?: string;
  treeError?: { code: string; message: string; retryable: boolean };
  unread: boolean;
  error?: { code: string; message: string; retryable: boolean };
}

export interface DashboardLiveSessionOptions {
  role?: DashboardControllerRole;
  ticketPollMs?: number;
  maxTicketPolls?: number;
  initialManaged?: { sessionId: string; generation: number };
  onSeen?(cursor: import("@harryaskham/pi-daemon/dashboard-contract").DashboardCursor): void;
}

type Listener = (state: DashboardLiveSessionState) => void;

type SteeringDeliveryMode = "steer" | "next-turn";
type SteeringReceiptState = "queued" | "cancelled" | "delivered" | "indeterminate";

interface SteeringQueueEntry extends PendingSteeringMessage {
  message: string;
  idempotencyKey: string;
  remoteObserved: boolean;
}

interface SteeringReceipt {
  queueId: string;
  message: string;
  state: SteeringReceiptState;
}

const MAX_PENDING_STEERING_MESSAGES = 32;
const MAX_PENDING_STEERING_BYTES = 1_048_576;
const MAX_STEERING_RECEIPTS = 128;
const STEERING_PREVIEW_CHARS = 512;

const CONTEXT_REFRESH_OPERATIONS = new Set<DashboardCommandOperation>([
  "compact",
  "set_model",
  "navigate_tree",
  "fork",
  "clone",
]);
const CONTEXT_REFRESH_EVENTS = new Set([
  "agent_end",
  "agent_settled",
  "turn_end",
  "compaction_end",
  "session_compact",
  "session_switched",
  "session_tree",
  "model_change",
  "model_changed",
  "model_select",
]);

type StatePatch = Omit<
  Partial<DashboardLiveSessionState>,
  | "error"
  | "selectedActivationMode"
  | "treeSelectedEntryId"
  | "treeCompareEntryId"
  | "treeEditorText"
  | "treeError"
> & {
  error?: DashboardLiveSessionState["error"] | undefined;
  selectedActivationMode?: ActivationMode | undefined;
  treeSelectedEntryId?: string | undefined;
  treeCompareEntryId?: string | undefined;
  treeEditorText?: string | undefined;
  treeError?: DashboardLiveSessionState["treeError"] | undefined;
};

export class DashboardLiveSessionController {
  readonly backend: DashboardBackend;
  readonly inventoryId: string;
  readonly options: Required<Omit<DashboardLiveSessionOptions, "initialManaged">> &
    Pick<DashboardLiveSessionOptions, "initialManaged">;
  #state: DashboardLiveSessionState;
  #channel: DashboardChannel | undefined;
  #unsubscribeChannel: (() => void) | undefined;
  #listeners = new Set<Listener>();
  #generation = 0;
  #commandSequence = 0;
  #liveRecordSequence = 0;
  #activeAssistantMessageId: string | undefined;
  #sessionStatsRefresh: Promise<void> | undefined;
  #steeringQueue: SteeringQueueEntry[] = [];
  #steeringReceipts = new Map<string, SteeringReceipt>();
  #steeringPoints: SteeringDeliveryMode[] = [];
  #steeringDrain: Promise<void> | undefined;
  #stopped = false;

  constructor(
    backend: DashboardBackend,
    inventoryId: string,
    options: DashboardLiveSessionOptions = {},
  ) {
    this.backend = backend;
    this.inventoryId = inventoryId;
    this.options = {
      role: options.role ?? "controller",
      ticketPollMs: options.ticketPollMs ?? 100,
      maxTicketPolls: options.maxTicketPolls ?? 100,
      ...(options.initialManaged === undefined
        ? {}
        : { initialManaged: options.initialManaged }),
      onSeen: options.onSeen ?? (() => undefined),
    };
    this.#state = {
      inventoryId,
      phase: "preview-loading",
      role: "observer",
      rpcState: {},
      requestState: {},
      activationModes: [],
      extensionRequests: [],
      extensionViews: [],
      extensionNotifications: [],
      extensionStatuses: {},
      extensionWidgets: {},
      pendingSteeringMessages: [],
      treePhase: "idle",
      unread: false,
    };
  }

  get state(): DashboardLiveSessionState {
    return this.#state;
  }

  subscribe(listener: Listener): () => void {
    this.#listeners.add(listener);
    listener(this.#state);
    return () => this.#listeners.delete(listener);
  }

  async start(): Promise<void> {
    const generation = ++this.#generation;
    this.#stopped = false;
    this.#patch({
      phase: "preview-loading",
      selectedActivationMode: undefined,
      error: undefined,
    });
    const initialManaged = this.options.initialManaged;
    if (initialManaged !== undefined) {
      const identity: DashboardSessionIdentity = {
        hostInstanceId: "draft-materialized",
        sessionId: initialManaged.sessionId,
        generation: initialManaged.generation,
      };
      this.#patch({
        phase: "preview",
        activationModes: ["reuse"],
        selectedActivationMode: "reuse",
        transcript: createTranscriptStore(identity, []),
      });
      try {
        await this.#connect(
          initialManaged.sessionId,
          initialManaged.generation,
          generation,
        );
      } catch (error) {
        if (this.#current(generation)) this.#fail(error, "draft_attach_failed", true);
      }
      return;
    }
    const previewPromise = this.backend.getTranscript(this.inventoryId, { limit: 200 });
    const infoPromise = this.backend.getSessionInfo(this.inventoryId);
    try {
      const preview = await previewPromise;
      if (!this.#current(generation)) return;
      this.#acceptPreview(preview);
      const info = await infoPromise;
      if (!this.#current(generation)) return;
      const selectedActivationMode = preferredActivationMode(info);
      this.#patch({
        info,
        phase: "preview",
        activationModes: [...info.activation.modes],
        ...(selectedActivationMode === undefined ? {} : { selectedActivationMode }),
        unread: info.presence.unread,
      });
      if (
        preview.availability.state !== "available" ||
        preview.availability.observerAttachAllowed !== true ||
        preview.freshness.state !== "current" ||
        preview.quarantine !== undefined
      ) {
        this.#patch({ phase: "preview-only" });
        return;
      }
      if (info.managed?.residency === "resident") {
        await this.#connect(info.managed.sessionId, info.managed.generation, generation);
        return;
      }
      if (info.managed !== undefined) return;
      if (
        !info.activation.eligible ||
        info.activation.modes.every((mode) => mode === "preview-only")
      ) {
        this.#patch({ phase: "preview-only" });
        return;
      }
      this.#patch({ phase: "activation-choice" });
    } catch (error) {
      if (this.#current(generation)) this.#fail(error, "preview_failed");
    }
  }

  selectActivationMode(mode: ActivationMode): void {
    if (mode === "preview-only" || !this.#state.activationModes.includes(mode)) return;
    this.#patch({ selectedActivationMode: mode, error: undefined });
  }

  async activate(mode: ActivationMode): Promise<void> {
    if (this.#stopped) return;
    const generation = this.#generation;
    this.#patch({
      phase: "activating",
      selectedActivationMode: mode,
      error: undefined,
    });
    try {
      const operationId = crypto.randomUUID();
      let ticket = await this.backend.activateSession(this.inventoryId, {
        requestId: `dash-activation-${operationId}`,
        idempotencyKey: `dash-activation-${this.inventoryId}-${mode}-${operationId}`,
        mode,
        ...(
          mode === "reuse" || this.#state.previewFingerprint === undefined
            ? {}
            : { expectedFingerprint: this.#state.previewFingerprint }
        ),
        ...(mode === "direct" ? { policyRef: DASH_DIRECT_COOPT_POLICY_REF } : {}),
      });
      this.#patch({ activationTicket: ticket });
      ticket = await this.#waitActivation(ticket, generation);
      if (!this.#current(generation)) return;
      this.#patch({ activationTicket: ticket });
      if (ticket.state === "indeterminate") {
        this.#patch({ phase: "indeterminate" });
        return;
      }
      if (ticket.state === "failed") {
        this.#patch({
          phase: "error",
          error: ticket.error ?? { code: "activation_failed", message: "Session activation failed", retryable: false },
        });
        return;
      }
      if (ticket.state !== "succeeded" || ticket.managedSession === undefined) {
        this.#patch({ phase: "error", error: { code: "activation_incomplete", message: "Activation did not produce a managed session", retryable: true } });
        return;
      }
      const refreshedInfo = await this.backend.getSessionInfo(this.inventoryId).catch(() => undefined);
      if (refreshedInfo !== undefined && this.#current(generation)) {
        this.#patch({ info: refreshedInfo });
      }
      await this.#connect(ticket.managedSession.sessionId, ticket.managedSession.generation, generation);
    } catch (error) {
      if (this.#current(generation)) this.#fail(error, "activation_failed");
    }
  }

  async exportSession(mode: "as-new" | "append-to-origin", releaseAfterExport = false): Promise<void> {
    const sessionRef = this.#state.managedSession?.sessionId ?? this.#state.identity?.sessionId;
    if (sessionRef === undefined) throw new Error("Session is not managed");
    try {
      const operationId = crypto.randomUUID();
      let ticket = await this.backend.exportSession(sessionRef, {
        requestId: `dash-export-${operationId}`,
        idempotencyKey: `dash-export-${sessionRef}-${mode}-${operationId}`,
        mode,
        releaseAfterExport,
      });
      this.#patch({ exportTicket: ticket });
      for (let index = 0; index < this.options.maxTicketPolls && ["queued", "running"].includes(ticket.state); index += 1) {
        await delay(this.options.ticketPollMs);
        ticket = await this.backend.getExport(ticket.ticketId);
        this.#patch({ exportTicket: ticket });
      }
      if (ticket.state === "indeterminate") this.#patch({ phase: "indeterminate" });
      else if (ticket.state === "failed") {
        this.#patch({
          phase: "error",
          error: ticket.error ?? { code: "export_failed", message: "Session export failed", retryable: false },
        });
      }
    } catch (error) {
      this.#fail(error, "export_failed");
    }
  }

  async submit(
    operation: DashboardCommandOperation,
    payload: JsonObject = {},
    idempotencyKey?: string,
  ): Promise<DashboardCommandResult> {
    if (this.#channel !== undefined) {
      if (
        operation === "prompt" &&
        this.#state.phase === "streaming" &&
        payload.streamingBehavior === undefined
      ) {
        return this.#enqueueSteeringPrompt(payload, idempotencyKey);
      }
      return this.command(operation, payload, idempotencyKey);
    }
    const correlationId = `command-${++this.#commandSequence}`;
    if (operation !== "prompt") {
      const result = rejected(
        correlationId,
        "activation_required",
        "Send a normal message to activate this preview before using session commands",
        false,
      );
      this.#patch({ error: result.error });
      return result;
    }
    if (["activating", "hydrating", "preview-loading", "reconnecting"].includes(this.#state.phase)) {
      return rejected(
        correlationId,
        "activation_in_progress",
        "Session activation is already in progress",
        true,
      );
    }
    if (this.#state.phase === "indeterminate") {
      return {
        correlationId,
        state: "indeterminate",
        error: {
          code: "activation_indeterminate",
          message: "Activation outcome is indeterminate; reconcile before sending again",
          retryable: false,
        },
      };
    }
    if (this.#state.phase === "preview-only" || !this.#state.info?.activation.eligible) {
      const result = rejected(
        correlationId,
        this.#state.info?.activation.reasonCode ?? "preview_only",
        "This preview cannot be activated under the current session policy",
        false,
      );
      this.#patch({ error: result.error });
      return result;
    }
    const generation = this.#generation;
    const managed = this.#state.info.managed;
    if (managed !== undefined) {
      try {
        await this.activate("reuse");
      } catch (error) {
        if (this.#current(generation)) this.#fail(error, "hydration_failed", true);
      }
    } else {
      const mode = this.#state.selectedActivationMode ?? preferredActivationMode(this.#state.info);
      if (mode === undefined) {
        const result = rejected(
          correlationId,
          "activation_mode_required",
          "Choose a safe activation mode before sending",
          false,
        );
        this.#patch({ error: result.error });
        return result;
      }
      await this.activate(mode);
    }
    const settledPhase = this.#state.phase as LiveSessionPhase;
    if (this.#channel === undefined || !["live", "streaming"].includes(settledPhase)) {
      if (settledPhase === "indeterminate") {
        return {
          correlationId,
          state: "indeterminate",
          error: {
            code: "activation_indeterminate",
            message: "Activation outcome is indeterminate; the prompt was not submitted",
            retryable: false,
          },
        };
      }
      return rejected(
        correlationId,
        this.#state.error?.code ?? "activation_failed",
        this.#state.error?.message ?? "Session activation did not reach a live channel",
        this.#state.error?.retryable ?? true,
      );
    }
    return this.command(operation, payload, idempotencyKey);
  }

  /**
   * Cancel one browser-held steering message before a Pi steering point claims
   * it. Once delivery begins the outcome belongs to Pi and cannot be rewritten.
   */
  cancelQueuedSteeringMessage(queueId: string): boolean {
    const index = this.#steeringQueue.findIndex(
      (entry) => entry.queueId === queueId && entry.state === "pending",
    );
    if (index < 0) return false;
    const [entry] = this.#steeringQueue.splice(index, 1);
    if (entry !== undefined) {
      this.#setSteeringReceipt(entry.idempotencyKey, {
        queueId: entry.queueId,
        message: entry.message,
        state: "cancelled",
      });
    }
    this.#syncSteeringQueue();
    return true;
  }

  async command(
    operation: DashboardCommandOperation,
    payload: JsonObject = {},
    idempotencyKey?: string,
  ): Promise<DashboardCommandResult> {
    const channel = this.#channel;
    const identity = this.#state.identity;
    if (channel === undefined || identity === undefined) {
      return rejected(`command-${++this.#commandSequence}`, "channel_unavailable", "Live channel is unavailable", true);
    }
    const correlationId = `command-${++this.#commandSequence}`;
    try {
      const result = await channel.command({
        correlationId,
        identity,
        operation,
        payload,
        ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
      });
      if (result.state === "indeterminate") this.#patch({ phase: "indeterminate" });
      else if (result.state === "rejected" && result.error) this.#patch({ error: result.error });
      else if (operation === "prompt") this.#patch({ phase: "streaming" });
      else if (
        result.state === "completed" &&
        operation === "set_model" &&
        isJsonObject(result.data)
      ) {
        this.#patch({
          rpcState: {
            ...this.#state.rpcState,
            ...(typeof result.data.model === "string" || isJsonObject(result.data.model)
              ? { model: result.data.model }
              : { model: result.data }),
          },
        });
      } else if (
        result.state === "completed" &&
        operation === "set_thinking_level" &&
        typeof payload.level === "string"
      ) {
        this.#patch({
          rpcState: { ...this.#state.rpcState, thinkingLevel: payload.level },
        });
      } else if (result.state === "completed" && isJsonObject(result.data)) {
        this.#patch({ rpcState: { ...this.#state.rpcState, ...result.data } });
      }
      if (result.state === "completed" && CONTEXT_REFRESH_OPERATIONS.has(operation)) {
        this.#patch({ sessionStats: null });
        this.#scheduleSessionStatsRefresh();
      }
      return result;
    } catch (error) {
      this.#fail(error, "command_failed", true);
      return rejected(correlationId, "command_failed", error instanceof Error ? error.message : "Command failed", true);
    }
  }

  async requestControl(): Promise<DashboardCommandResult> {
    if (!this.#channel) return rejected("request-control", "channel_unavailable", "Live channel is unavailable", true);
    const result = await this.#channel.requestControl(`control-${++this.#commandSequence}`);
    this.#patch({ role: this.#channel.role });
    return result;
  }

  async releaseControl(): Promise<DashboardCommandResult> {
    if (!this.#channel) return rejected("release-control", "channel_unavailable", "Live channel is unavailable", true);
    const result = await this.#channel.releaseControl(`control-${++this.#commandSequence}`);
    this.#patch({ role: this.#channel.role });
    return result;
  }

  async answerExtensionUi(requestId: string, response: JsonObject): Promise<void> {
    if (!this.#channel) throw new Error("Live channel is unavailable");
    await this.#channel.answerExtensionUi(requestId, response);
    this.#patch({
      extensionRequests: this.#state.extensionRequests.filter((request) => request.requestId !== requestId),
      extensionViews: this.#state.extensionViews.filter((event) => event.requestId !== requestId),
    });
  }

  async loadTree(): Promise<void> {
    const channel = this.#channel;
    if (channel === undefined) {
      this.#patch({ treePhase: "error", treeError: { code: "channel_unavailable", message: "Live channel is unavailable", retryable: true } });
      return;
    }
    const identity = channel.identity;
    this.#patch({ treePhase: "loading", treeError: undefined });
    try {
      const result = await channel.command({
        correlationId: `tree-load-${++this.#commandSequence}`,
        identity,
        operation: "get_tree",
      });
      if (channel !== this.#channel || !sameSessionIdentity(identity, channel.identity)) return;
      if (result.state !== "completed" || !isJsonObject(result.data)) {
        this.#patch({
          treePhase: "error",
          treeError: result.error ?? { code: "tree_load_failed", message: "Session tree could not be loaded", retryable: true },
        });
        return;
      }
      const tree = parseSessionTree(result.data);
      const selected = this.#state.treeSelectedEntryId;
      const compared = this.#state.treeCompareEntryId;
      const nextSelected = selected !== undefined && tree.byId.has(selected)
        ? selected
        : tree.leafId ?? tree.rootIds[0];
      this.#patch({
        tree,
        treePhase: "ready",
        treeSelectedEntryId: nextSelected,
        treeCompareEntryId: compared !== undefined && tree.byId.has(compared) && compared !== nextSelected
          ? compared
          : undefined,
        treeError: undefined,
      });
    } catch (error) {
      if (channel !== this.#channel) return;
      this.#patch({
        treePhase: "error",
        treeError: {
          code: "tree_invalid",
          message: error instanceof Error ? error.message : "Session tree is invalid",
          retryable: true,
        },
      });
    }
  }

  selectTreeEntry(entryId: string): void {
    if (this.#state.tree?.byId.has(entryId)) this.#patch({ treeSelectedEntryId: entryId });
  }

  compareTreeEntry(entryId: string | undefined): void {
    if (entryId === undefined || this.#state.tree?.byId.has(entryId)) this.#patch({ treeCompareEntryId: entryId });
  }

  async forkTreeEntry(entryId: string, edit = false): Promise<DashboardCommandResult> {
    if (!this.#state.tree?.byId.has(entryId)) {
      return rejected(`tree-fork-${++this.#commandSequence}`, "tree_entry_not_found", "Tree entry does not exist", false);
    }
    this.#patch({ treePhase: "mutating", treeError: undefined });
    const result = await this.command("fork", { entryId }, `tree-fork-${crypto.randomUUID()}`);
    if (result.state === "completed") {
      const data = isJsonObject(result.data) ? result.data : undefined;
      const cancelled = data?.cancelled === true;
      const text = typeof data?.text === "string" ? data.text : undefined;
      if (!cancelled) {
        this.#patch({
          ...(edit && text !== undefined ? { treeEditorText: text } : {}),
          treeCompareEntryId: undefined,
        });
        await this.loadTree();
      } else this.#patch({ treePhase: "ready" });
    } else {
      this.#patch({
        treePhase: "error",
        treeError: result.error ?? { code: "tree_fork_failed", message: "Tree fork did not complete", retryable: true },
      });
    }
    return result;
  }

  async navigateTreeEntry(
    entryId: string,
    options: { summarize?: boolean; customInstructions?: string; label?: string } = {},
  ): Promise<DashboardCommandResult> {
    if (!this.#state.tree?.byId.has(entryId)) {
      return rejected(`tree-navigate-${++this.#commandSequence}`, "tree_entry_not_found", "Tree entry does not exist", false);
    }
    this.#patch({ treePhase: "mutating", treeError: undefined });
    const result = await this.command("navigate_tree", {
      entryId,
      ...(options.summarize === undefined ? {} : { summarize: options.summarize }),
      ...(options.customInstructions === undefined || options.customInstructions.trim().length === 0 ? {} : { customInstructions: options.customInstructions }),
      ...(options.label === undefined || options.label.trim().length === 0 ? {} : { label: options.label }),
    }, `tree-navigate-${crypto.randomUUID()}`);
    if (result.state === "completed") {
      const data = isJsonObject(result.data) ? result.data : undefined;
      const cancelled = data?.cancelled === true;
      const editorText = typeof data?.editorText === "string" ? data.editorText : undefined;
      if (!cancelled) {
        this.#patch({
          ...(editorText === undefined ? {} : { treeEditorText: editorText }),
          treeCompareEntryId: undefined,
        });
        await this.loadTree();
      } else this.#patch({ treePhase: "ready" });
    } else {
      this.#patch({
        treePhase: "error",
        treeError: result.error ?? { code: "tree_navigation_failed", message: "Tree navigation did not complete", retryable: true },
      });
    }
    return result;
  }

  async cloneTree(): Promise<DashboardCommandResult> {
    this.#patch({ treePhase: "mutating", treeError: undefined });
    const result = await this.command("clone", {}, `tree-clone-${crypto.randomUUID()}`);
    if (result.state === "completed") {
      const cancelled = isJsonObject(result.data) && result.data.cancelled === true;
      if (!cancelled) {
        this.#patch({ treeCompareEntryId: undefined });
        await this.loadTree();
      } else this.#patch({ treePhase: "ready" });
    } else {
      this.#patch({
        treePhase: "error",
        treeError: result.error ?? { code: "tree_clone_failed", message: "Tree clone did not complete", retryable: true },
      });
    }
    return result;
  }

  clearTreeEditorText(): void {
    this.#patch({ treeEditorText: undefined });
  }

  markSeen(): void {
    const cursor = this.#state.transcript?.highWaterCursor;
    if (cursor !== undefined) this.options.onSeen(cursor);
    this.#patch({ unread: false });
  }

  async reconnect(): Promise<void> {
    const identity = this.#state.identity;
    if (!identity) return this.start();
    const generation = ++this.#generation;
    await this.#disconnect();
    this.#patch({ phase: "reconnecting", error: undefined });
    await this.#connect(identity.sessionId, identity.generation, generation, this.#state.transcript?.highWaterCursor);
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    this.#generation += 1;
    this.#steeringPoints = [];
    this.#steeringQueue = [];
    await this.#disconnect();
    this.#patch({ phase: "closed", pendingSteeringMessages: [] });
    this.#listeners.clear();
  }

  async #connect(
    sessionRef: string,
    generation: number,
    operationGeneration: number,
    cursor?: import("@harryaskham/pi-daemon/dashboard-contract").DashboardCursor,
  ): Promise<void> {
    if (!this.#current(operationGeneration)) return;
    this.#patch({ phase: "hydrating", sessionStats: null });
    const channel = await this.backend.openSessionChannel({
      sessionRef,
      generation,
      role: this.options.role,
      ...(cursor === undefined ? {} : { cursor }),
    });
    if (!this.#current(operationGeneration)) {
      await channel.close();
      return;
    }
    await this.#disconnect();
    this.#channel = channel;
    this.#unsubscribeChannel = channel.subscribe((event) => this.#onEvent(event));
    this.#acceptChannelSnapshot(channel);
    const streaming = channel.snapshot.rpcState.isStreaming === true;
    this.#patch({ phase: streaming ? "streaming" : "live", role: channel.role });
    if (!streaming && channel.role === "controller") this.#scheduleSteeringDelivery("next-turn");
    void this.#loadChannelMetadata(channel);
  }

  #scheduleSessionStatsRefresh(): void {
    const channel = this.#channel;
    if (channel === undefined || this.#sessionStatsRefresh !== undefined || this.#stopped) return;
    const identity = channel.identity;
    const refresh = (async () => {
      try {
        const result = await channel.command({
          correlationId: `metadata-get_session_stats-${++this.#commandSequence}`,
          identity,
          operation: "get_session_stats",
        });
        if (
          channel !== this.#channel ||
          this.#stopped ||
          !sameSessionIdentity(identity, channel.identity)
        ) {
          return;
        }
        this.#patch({
          sessionStats:
            result.state === "completed" && result.data !== undefined ? result.data : null,
        });
      } catch {
        if (channel === this.#channel && !this.#stopped) this.#patch({ sessionStats: null });
      }
    })();
    this.#sessionStatsRefresh = refresh;
    void refresh.finally(() => {
      if (this.#sessionStatsRefresh === refresh) this.#sessionStatsRefresh = undefined;
    });
  }

  async #loadChannelMetadata(channel: DashboardChannel): Promise<void> {
    const operations: DashboardCommandOperation[] = [
      "get_session_stats",
      "get_commands",
      "get_available_models",
    ];
    const results = await Promise.all(operations.map((operation) => channel.command({
      correlationId: `metadata-${operation}-${++this.#commandSequence}`,
      identity: channel.identity,
      operation,
    }).catch(() => undefined)));
    if (channel !== this.#channel || this.#stopped) return;
    this.#patch({
      ...(results[0]?.state === "completed" ? { sessionStats: results[0].data } : {}),
      ...(results[1]?.state === "completed" ? { availableCommands: results[1].data } : {}),
      ...(results[2]?.state === "completed" ? { availableModels: results[2].data } : {}),
    });
  }

  #acceptPreview(preview: TranscriptPage): void {
    const identity: DashboardSessionIdentity = preview.managedSession
      ? { hostInstanceId: "preview", sessionId: preview.managedSession.sessionId, generation: preview.managedSession.generation }
      : { hostInstanceId: "preview", sessionId: preview.piSessionId ?? this.inventoryId, generation: 0 };
    this.#patch({
      phase: "preview",
      ...(preview.sourceFingerprint === undefined ? {} : { previewFingerprint: preview.sourceFingerprint }),
      transcriptAvailability: { ...preview.availability },
      transcriptFreshness: { ...preview.freshness },
      transcript: createTranscriptStore(identity, preview.records, undefined, preview.newerCursor ?? preview.olderCursor),
    });
  }

  #acceptChannelSnapshot(channel: DashboardChannel): void {
    const current = this.#state.transcript;
    const transcript = current
      ? transcriptStoreReducer(current, {
          type: "snapshot",
          identity: channel.identity,
          records: channel.snapshot.entries,
          cursor: channel.snapshot.highWaterCursor,
        })
      : createTranscriptStore(channel.identity, channel.snapshot.entries, undefined, channel.snapshot.highWaterCursor);
    this.#patch({
      transcript,
      identity: channel.identity,
      managedSession: channel.snapshot.session,
      rpcState: channel.snapshot.rpcState,
      requestState: channel.snapshot.requestState,
      role: channel.role,
    });
  }

  #onEvent(event: DashboardChannelEvent): void {
    if (event.kind === "control") {
      const role = event.action === "control_granted" ? "controller" : "observer";
      this.#patch({ role });
      if (role === "controller" && this.#state.phase === "live") {
        this.#scheduleSteeringDelivery("next-turn");
      }
      return;
    }
    if (event.kind === "extension_ui") {
      this.#acceptExtensionUi(event);
      return;
    }
    if (event.kind === "extension_view") {
      this.#patch({
        extensionViews: [
          ...this.#state.extensionViews.filter((candidate) => candidate.requestId !== event.requestId),
          event,
        ].slice(-8),
      });
      return;
    }
    if (event.kind === "replay_gap") {
      const transcript = this.#state.transcript;
      this.#patch({
        phase: "reconnecting",
        sessionStats: null,
        ...(transcript === undefined
          ? {}
          : {
              transcript: transcriptStoreReducer(transcript, {
                type: "replay_gap",
                identity: event.identity,
                reason: event.reason,
                highWaterCursor: event.highWaterCursor,
              }),
            }),
      });
      if (this.#channel) this.#acceptChannelSnapshot(this.#channel);
      this.#patch({ phase: "live" });
      this.#scheduleSessionStatsRefresh();
      return;
    }
    this.#onSessionEvent(event.event as unknown as Record<string, unknown>, event.identity, event.cursor);
  }

  #acceptExtensionUi(request: DashboardExtensionUiEvent): void {
    if (["select", "confirm", "input", "editor"].includes(request.method)) {
      this.#patch({
        extensionRequests: [
          ...this.#state.extensionRequests.filter((candidate) => candidate.requestId !== request.requestId),
          { requestId: request.requestId, method: request.method, payload: request.payload },
        ].slice(-16),
      });
      return;
    }
    if (request.method === "notify") {
      const type: LiveExtensionNotification["type"] = request.payload.notifyType === "warning" || request.payload.notifyType === "error" ? request.payload.notifyType : "info";
      this.#patch({
        extensionNotifications: [...this.#state.extensionNotifications, {
          requestId: request.requestId,
          message: typeof request.payload.message === "string" ? request.payload.message : "Extension notification",
          type,
        }].slice(-8),
      });
      return;
    }
    if (request.method === "setStatus" && typeof request.payload.statusKey === "string") {
      const statuses = { ...this.#state.extensionStatuses };
      if (typeof request.payload.statusText === "string") statuses[request.payload.statusKey] = request.payload.statusText;
      else delete statuses[request.payload.statusKey];
      this.#patch({ extensionStatuses: statuses });
      return;
    }
    if (request.method === "setWidget" && typeof request.payload.widgetKey === "string") {
      const widgets = { ...this.#state.extensionWidgets };
      const lines = Array.isArray(request.payload.widgetLines)
        ? request.payload.widgetLines.filter((line): line is string => typeof line === "string").slice(0, 32)
        : [];
      if (lines.length === 0) delete widgets[request.payload.widgetKey];
      else widgets[request.payload.widgetKey] = {
        key: request.payload.widgetKey,
        lines,
        placement: request.payload.widgetPlacement === "belowEditor" ? "belowEditor" : "aboveEditor",
      };
      this.#patch({ extensionWidgets: widgets });
      return;
    }
    if (request.method === "setTitle") {
      this.#patch({ extensionTitle: typeof request.payload.title === "string" ? request.payload.title : "" });
      return;
    }
    if (request.method === "set_editor_text" && typeof request.payload.text === "string") {
      this.#patch({ extensionEditorText: request.payload.text });
    }
  }

  #onSessionEvent(
    event: Record<string, unknown>,
    identity: DashboardSessionIdentity,
    cursor: import("@harryaskham/pi-daemon/dashboard-contract").DashboardCursor,
  ): void {
    const transcript = this.#state.transcript;
    const records = this.#recordsForEvent(event);
    if (records.length > 0 && transcript) {
      this.#patch({
        transcript: transcriptStoreReducer(transcript, {
          type: "upsert",
          identity,
          records,
          cursor,
        }),
      });
    }
    const type = typeof event.type === "string" ? event.type : "";
    if (type === "queue_update") this.#reconcileRemoteSteeringQueue(event);
    if (this.#state.tree !== undefined && ["entry_appended", "session_forked", "session_switched"].includes(type)) {
      this.#patch({ treePhase: "stale" });
    }
    if (["agent_start", "message_update", "tool_execution_start", "tool_execution_update"].includes(type)) {
      this.#patch({ phase: "streaming" });
    } else if (type === "agent_settled") {
      this.#patch({ phase: "live", unread: true });
      this.#dropDeliveredSteeringMessages();
      this.#scheduleSteeringDelivery("next-turn");
    } else if (
      type === "retry_start" ||
      type === "auto_retry_start" ||
      type === "compaction_start" ||
      type === "session_before_compact"
    ) {
      this.#patch({
        phase: "streaming",
        ...(["compaction_start", "session_before_compact"].includes(type)
          ? { sessionStats: null }
          : {}),
      });
    } else if (type === "error") {
      this.#patch({ phase: "error", error: { code: "session_event_error", message: String(event.message ?? "Session error"), retryable: true } });
    }
    if (type === "tool_execution_end") this.#scheduleSteeringDelivery("steer");
    if (CONTEXT_REFRESH_EVENTS.has(type)) this.#scheduleSessionStatsRefresh();
  }

  #enqueueSteeringPrompt(
    payload: JsonObject,
    requestedIdempotencyKey: string | undefined,
  ): DashboardCommandResult {
    const correlationId = `command-${++this.#commandSequence}`;
    if (this.#state.role !== "controller") {
      return rejected(correlationId, "controller_required", "Controller role is required", false);
    }
    const message = typeof payload.message === "string" ? payload.message.trim() : "";
    if (message.length === 0) {
      return rejected(correlationId, "invalid_prompt", "Steering message must not be empty", false);
    }
    const idempotencyKey = requestedIdempotencyKey ?? `dash-steering-${crypto.randomUUID()}`;
    const prior = this.#steeringReceipts.get(idempotencyKey);
    if (prior !== undefined) {
      if (prior.message !== message) {
        return rejected(
          correlationId,
          "idempotency_conflict",
          "Steering idempotency key was reused with different content",
          false,
        );
      }
      return {
        correlationId,
        state: "completed",
        data: { queueId: prior.queueId, disposition: prior.state },
      };
    }
    const messageBytes = new TextEncoder().encode(message).byteLength;
    const queuedBytes = this.#steeringQueue.reduce(
      (total, entry) => total + new TextEncoder().encode(entry.message).byteLength,
      0,
    );
    if (
      this.#steeringQueue.length >= MAX_PENDING_STEERING_MESSAGES ||
      messageBytes > MAX_PENDING_STEERING_BYTES ||
      queuedBytes + messageBytes > MAX_PENDING_STEERING_BYTES
    ) {
      return rejected(
        correlationId,
        "steering_queue_capacity",
        "The bounded browser steering queue is full",
        true,
      );
    }
    const queueId = crypto.randomUUID();
    const entry: SteeringQueueEntry = {
      queueId,
      message,
      preview: message.slice(0, STEERING_PREVIEW_CHARS),
      truncated: message.length > STEERING_PREVIEW_CHARS,
      queuedAt: new Date().toISOString(),
      state: "pending",
      idempotencyKey,
      remoteObserved: false,
    };
    this.#steeringQueue.push(entry);
    this.#setSteeringReceipt(idempotencyKey, {
      queueId,
      message,
      state: "queued",
    });
    this.#syncSteeringQueue();
    return {
      correlationId,
      state: "completed",
      data: { queueId, disposition: "queued" },
    };
  }

  #scheduleSteeringDelivery(mode: SteeringDeliveryMode): void {
    if (
      this.#stopped ||
      this.#channel === undefined ||
      this.#state.role !== "controller" ||
      !this.#steeringQueue.some((entry) => entry.state === "pending")
    ) {
      return;
    }
    if (this.#steeringPoints.length < MAX_PENDING_STEERING_MESSAGES) {
      this.#steeringPoints.push(mode);
    }
    this.#ensureSteeringDrain();
  }

  #ensureSteeringDrain(): void {
    if (this.#steeringDrain !== undefined || this.#steeringPoints.length === 0) return;
    // Defer the drain one microtask so the in-flight sentinel is visible before
    // a synchronous fixture/channel event can schedule another steering point.
    const drain = Promise.resolve().then(() => this.#drainSteeringPoints());
    this.#steeringDrain = drain;
    void drain.finally(() => {
      if (this.#steeringDrain !== drain) return;
      this.#steeringDrain = undefined;
      if (
        this.#steeringPoints.length > 0 &&
        this.#steeringQueue.some((entry) => entry.state === "pending")
      ) {
        this.#ensureSteeringDrain();
      }
    });
  }

  async #drainSteeringPoints(): Promise<void> {
    while (!this.#stopped && this.#steeringPoints.length > 0) {
      const mode = this.#steeringPoints.shift();
      const entry = this.#steeringQueue.find((candidate) => candidate.state === "pending");
      if (mode === undefined || entry === undefined) continue;
      entry.state = "delivering";
      delete entry.errorCode;
      this.#syncSteeringQueue();
      const result = await this.command(
        "prompt",
        {
          message: entry.message,
          ...(mode === "steer" ? { streamingBehavior: "steer" } : {}),
        },
        entry.idempotencyKey,
      );
      if (result.state === "completed" || result.state === "streaming") {
        entry.state = "delivered";
        this.#setSteeringReceipt(entry.idempotencyKey, {
          queueId: entry.queueId,
          message: entry.message,
          state: "delivered",
        });
        this.#syncSteeringQueue();
        continue;
      }
      if (result.state === "indeterminate") {
        entry.state = "indeterminate";
        this.#setSteeringReceipt(entry.idempotencyKey, {
          queueId: entry.queueId,
          message: entry.message,
          state: "indeterminate",
        });
        this.#steeringPoints = [];
        this.#syncSteeringQueue();
        return;
      }
      entry.state = "pending";
      entry.errorCode = result.error?.code ?? "steering_rejected";
      this.#steeringPoints = [];
      this.#syncSteeringQueue();
      return;
    }
  }

  #reconcileRemoteSteeringQueue(event: Record<string, unknown>): void {
    const remote = Array.isArray(event.steering)
      ? event.steering.filter((value): value is string => typeof value === "string")
      : [];
    const counts = new Map<string, number>();
    for (const message of remote) counts.set(message, (counts.get(message) ?? 0) + 1);
    let changed = false;
    const next: SteeringQueueEntry[] = [];
    for (const entry of this.#steeringQueue) {
      if (entry.state !== "delivering" && entry.state !== "delivered") {
        next.push(entry);
        continue;
      }
      const count = counts.get(entry.message) ?? 0;
      if (count > 0) {
        counts.set(entry.message, count - 1);
        if (!entry.remoteObserved) {
          entry.remoteObserved = true;
          changed = true;
        }
        next.push(entry);
        continue;
      }
      if (entry.remoteObserved) {
        this.#setSteeringReceipt(entry.idempotencyKey, {
          queueId: entry.queueId,
          message: entry.message,
          state: "delivered",
        });
        changed = true;
        continue;
      }
      next.push(entry);
    }
    if (!changed) return;
    this.#steeringQueue = next;
    this.#syncSteeringQueue();
  }

  #dropDeliveredSteeringMessages(): void {
    const delivered = this.#steeringQueue.filter((entry) => entry.state === "delivered");
    if (delivered.length === 0) return;
    for (const entry of delivered) {
      this.#setSteeringReceipt(entry.idempotencyKey, {
        queueId: entry.queueId,
        message: entry.message,
        state: "delivered",
      });
    }
    this.#steeringQueue = this.#steeringQueue.filter((entry) => entry.state !== "delivered");
    this.#syncSteeringQueue();
  }

  #syncSteeringQueue(): void {
    this.#patch({
      pendingSteeringMessages: this.#steeringQueue.map((entry) => ({
        queueId: entry.queueId,
        preview: entry.preview,
        truncated: entry.truncated,
        queuedAt: entry.queuedAt,
        state: entry.state,
        ...(entry.errorCode === undefined ? {} : { errorCode: entry.errorCode }),
      })),
    });
  }

  #setSteeringReceipt(idempotencyKey: string, receipt: SteeringReceipt): void {
    if (!this.#steeringReceipts.has(idempotencyKey) && this.#steeringReceipts.size >= MAX_STEERING_RECEIPTS) {
      const oldest = this.#steeringReceipts.keys().next().value;
      if (oldest !== undefined) this.#steeringReceipts.delete(oldest);
    }
    this.#steeringReceipts.set(idempotencyKey, receipt);
  }

  #recordsForEvent(event: Record<string, unknown>): NormalizedTranscriptRecord[] {
    const direct = normalizedRecord(event.normalizedRecord ?? event.record);
    if (direct !== undefined) return [direct];
    const type = typeof event.type === "string" ? event.type : "";
    if (type === "message_start" || type === "message_update" || type === "message_end") {
      const message = jsonRecord(event.message) ?? (type === "message_update" ? { role: "assistant", content: [] } : undefined);
      if (message === undefined) return [];
      const role = typeof message.role === "string" ? message.role : "assistant";
      // Pi emits tool execution events and may also emit the same toolResult as
      // a message boundary. The tool event owns the rich card; rendering the
      // message as custom prose would duplicate its raw output in the chat.
      if (role === "toolResult") return [];
      if (role !== "assistant") {
        if (type !== "message_end") return [];
        return [liveMessageRecord(
          `live-message-${++this.#liveRecordSequence}`,
          role === "user" || role === "system" || role === "custom" ? role : "custom",
          message,
          "complete",
        )];
      }
      if (type === "message_start" || this.#activeAssistantMessageId === undefined) {
        this.#activeAssistantMessageId = typeof message.id === "string"
          ? message.id
          : `live-assistant-${++this.#liveRecordSequence}`;
      }
      const update = jsonRecord(event.assistantMessageEvent);
      const partial = jsonRecord(update?.partial);
      const record = liveMessageRecord(
        this.#activeAssistantMessageId,
        "assistant",
        partial ?? message,
        type === "message_end" ? "complete" : "streaming",
      );
      if (type === "message_update" && partial === undefined && update !== undefined) {
        const existing = this.#state.transcript?.records.find(
          (candidate): candidate is TranscriptMessageRecord =>
            candidate.kind === "message" && candidate.key.messageId === this.#activeAssistantMessageId,
        );
        record.content = applyAssistantMessageDelta(existing?.content, record.content, update);
      }
      return [record];
    }
    if (type === "tool_execution_start" || type === "tool_execution_update" || type === "tool_execution_end") {
      const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : undefined;
      if (toolCallId === undefined) return [];
      const result = jsonRecord(type === "tool_execution_update" ? event.partialResult : event.result);
      return [{
        recordId: `tool:${toolCallId}`,
        key: { toolCallId },
        kind: "tool",
        toolName: typeof event.toolName === "string" ? event.toolName : "tool",
        state: type === "tool_execution_start" ? "running" : type === "tool_execution_end" ? event.isError === true ? "error" : "success" : "running",
        source: "live",
        timestamp: new Date().toISOString(),
        ...(jsonRecord(event.args) === undefined ? {} : { arguments: boundedObject(jsonRecord(event.args)!) }),
        content: toolContent(result),
        ...(result?.details === undefined ? {} : { details: boundedValue(result.details) }),
      }];
    }
    if (type === "entry_appended") {
      const entry = jsonRecord(event.entry);
      if (entry === undefined || typeof entry.id !== "string") return [];
      const records = persistedEntryRecords(entry, this.#activeAssistantMessageId);
      if (records.some((record) => record.kind === "message" && record.role === "assistant")) {
        this.#activeAssistantMessageId = undefined;
      }
      return records;
    }
    const timeline = liveTimelineRecord(event, ++this.#liveRecordSequence);
    return timeline === undefined ? [] : [timeline];
  }

  async #waitActivation(ticket: ActivationTicket, generation: number): Promise<ActivationTicket> {
    let current = ticket;
    for (
      let index = 0;
      index < this.options.maxTicketPolls && this.#current(generation) && isPending(current.state);
      index += 1
    ) {
      await delay(this.options.ticketPollMs);
      current = await this.backend.getActivation(current.ticketId);
      this.#patch({ activationTicket: current });
    }
    return current;
  }

  async #disconnect(): Promise<void> {
    this.#unsubscribeChannel?.();
    this.#unsubscribeChannel = undefined;
    const channel = this.#channel;
    this.#channel = undefined;
    this.#sessionStatsRefresh = undefined;
    if (channel) await channel.close();
  }

  #patch(patch: StatePatch): void {
    const next = { ...this.#state, ...patch } as DashboardLiveSessionState & {
      error?: DashboardLiveSessionState["error"] | undefined;
    };
    if (patch.error === undefined && "error" in patch) delete next.error;
    if (
      patch.selectedActivationMode === undefined &&
      "selectedActivationMode" in patch
    ) {
      delete next.selectedActivationMode;
    }
    this.#state = next as DashboardLiveSessionState;
    for (const listener of this.#listeners) listener(this.#state);
  }

  #fail(error: unknown, code: string, retryable = false): void {
    this.#patch({
      phase: "error",
      error: {
        code: errorCode(error, code),
        message: error instanceof Error ? error.message : "Dashboard operation failed",
        retryable: retryable || (typeof error === "object" && error !== null && "retryable" in error && error.retryable === true),
      },
    });
  }

  #current(generation: number): boolean {
    return !this.#stopped && generation === this.#generation;
  }
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameSessionIdentity(left: DashboardSessionIdentity, right: DashboardSessionIdentity): boolean {
  return left.hostInstanceId === right.hostInstanceId && left.sessionId === right.sessionId && left.generation === right.generation;
}

function normalizedRecord(value: unknown): NormalizedTranscriptRecord | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.recordId !== "string" || typeof record.kind !== "string" || typeof record.source !== "string") return undefined;
  if (!record.key || typeof record.key !== "object" || Array.isArray(record.key)) return undefined;
  return value as NormalizedTranscriptRecord;
}

function jsonRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function boundedText(value: string, limit = 262_144): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}\n… output truncated by Dash`;
}

function boundedValue(value: unknown): JsonValue {
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) return null;
    if (encoded.length > 131_072) return "[bounded output omitted]";
    return JSON.parse(encoded) as JsonValue;
  } catch {
    return "[unserializable output omitted]";
  }
}

function boundedObject(value: Record<string, unknown>): JsonObject {
  const bounded = boundedValue(value);
  return typeof bounded === "object" && bounded !== null && !Array.isArray(bounded) ? bounded : {};
}

function messageContent(message: Record<string, unknown>): TranscriptContentBlock[] {
  const content: TranscriptContentBlock[] = [];
  const source = message.content;
  if (typeof source === "string") content.push({ type: "text", text: boundedText(source) });
  if (Array.isArray(source)) {
    for (const candidate of source) {
      const block = jsonRecord(candidate);
      if (block === undefined) continue;
      if (block.type === "text" && typeof block.text === "string") {
        content.push({ type: message.role === "assistant" ? "markdown" : "text", text: boundedText(block.text) });
      } else if (block.type === "thinking" && typeof block.thinking === "string") {
        content.push({ type: "thinking", text: boundedText(block.thinking) });
      }
    }
  }
  if (typeof message.errorMessage === "string") content.push({ type: "error", text: boundedText(message.errorMessage) });
  const usage = jsonRecord(message.usage);
  if (usage !== undefined) {
    const cost = jsonRecord(usage.cost);
    const block: Extract<TranscriptContentBlock, { type: "usage" }> = { type: "usage" };
    if (typeof usage.input === "number") block.inputTokens = usage.input;
    if (typeof usage.output === "number") block.outputTokens = usage.output;
    if (typeof usage.cacheRead === "number") block.cacheReadTokens = usage.cacheRead;
    if (typeof usage.cacheWrite === "number") block.cacheWriteTokens = usage.cacheWrite;
    if (typeof cost?.total === "number") block.cost = cost.total;
    if (Object.keys(block).length > 1) content.push(block);
  }
  return content;
}

function liveMessageRecord(
  messageId: string,
  role: TranscriptMessageRecord["role"],
  message: Record<string, unknown>,
  state: TranscriptMessageRecord["state"],
): TranscriptMessageRecord {
  return {
    recordId: `message:${messageId}`,
    key: { messageId },
    kind: "message",
    role,
    state,
    source: "live",
    timestamp: typeof message.timestamp === "string" ? message.timestamp : new Date().toISOString(),
    content: messageContent(message),
  };
}

function applyAssistantMessageDelta(
  previous: TranscriptContentBlock[] | undefined,
  projected: TranscriptContentBlock[],
  update: Record<string, unknown>,
): TranscriptContentBlock[] {
  const updateType = update.type;
  const delta = update.delta;
  if ((updateType !== "text_delta" && updateType !== "thinking_delta") || typeof delta !== "string") {
    return projected;
  }
  const targetType = updateType === "thinking_delta" ? "thinking" : "markdown";
  const base = previous ?? projected;
  const content = base.filter((block) => block.type !== "usage" && block.type !== "error");
  const requestedIndex = typeof update.contentIndex === "number" && Number.isSafeInteger(update.contentIndex) && update.contentIndex >= 0
    ? update.contentIndex
    : undefined;
  let targetIndex = requestedIndex !== undefined && content[requestedIndex]?.type === targetType
    ? requestedIndex
    : -1;
  if (targetIndex < 0) {
    for (let index = content.length - 1; index >= 0; index -= 1) {
      if (content[index]?.type === targetType) {
        targetIndex = index;
        break;
      }
    }
  }
  if (targetIndex < 0) {
    targetIndex = requestedIndex === undefined ? content.length : Math.min(requestedIndex, content.length);
    content.splice(targetIndex, 0, { type: targetType, text: "" });
  }
  const target = content[targetIndex];
  if (target !== undefined && target.type === targetType) {
    // Some transports include an already-updated message alongside the delta.
    // Do not append the same chunk twice when that full text is authoritative.
    const text = previous === undefined && target.text.endsWith(delta) ? target.text : `${target.text}${delta}`;
    content[targetIndex] = { type: targetType, text: boundedText(text) };
  }
  const metadata = projected.filter((block) => block.type === "usage" || block.type === "error");
  if (metadata.length === 0) {
    metadata.push(...base.filter((block) => block.type === "usage" || block.type === "error"));
  }
  return [...content, ...metadata];
}

function toolContent(result: Record<string, unknown> | undefined): TranscriptContentBlock[] {
  if (result === undefined) return [];
  if (typeof result.content === "string") return [{ type: "text", text: boundedText(result.content) }];
  if (!Array.isArray(result.content)) return [];
  return result.content.flatMap((candidate): TranscriptContentBlock[] => {
    const block = jsonRecord(candidate);
    return block?.type === "text" && typeof block.text === "string"
      ? [{ type: "text", text: boundedText(block.text) }]
      : [];
  });
}

function persistedEntryRecords(entry: Record<string, unknown>, activeMessageId: string | undefined): NormalizedTranscriptRecord[] {
  const id = String(entry.id);
  const timestamp = typeof entry.timestamp === "string" ? entry.timestamp : new Date().toISOString();
  const parentEntryId = typeof entry.parentId === "string" ? entry.parentId : undefined;
  if (entry.type === "message") {
    const message = jsonRecord(entry.message);
    if (message === undefined) return [];
    const role = typeof message.role === "string" ? message.role : "custom";
    if (role === "toolResult" && typeof message.toolCallId === "string") {
      const record: TranscriptToolRecord = {
        recordId: `tool:${message.toolCallId}`,
        key: { entryId: id, toolCallId: message.toolCallId },
        kind: "tool",
        toolName: typeof message.toolName === "string" ? message.toolName : "tool",
        state: message.isError === true ? "error" : "success",
        source: "persisted",
        timestamp,
        ...(parentEntryId === undefined ? {} : { parentEntryId }),
        content: toolContent(message),
        ...(message.details === undefined ? {} : { details: boundedValue(message.details) }),
      };
      return [record];
    }
    if (role === "bashExecution") {
      return [{
        recordId: `timeline:${id}`,
        key: { entryId: id },
        kind: "timeline",
        event: "bash",
        label: typeof message.command === "string" ? boundedText(message.command, 4_096) : "Bash execution",
        source: "persisted",
        timestamp,
        ...(parentEntryId === undefined ? {} : { parentEntryId }),
        data: boundedObject(message),
      }];
    }
    const normalizedRole: TranscriptMessageRecord["role"] = role === "user" || role === "assistant" || role === "system" || role === "custom" ? role : "custom";
    const messageRecord: TranscriptMessageRecord = {
      recordId: `entry:${id}`,
      key: normalizedRole === "assistant" && activeMessageId !== undefined ? { entryId: id, messageId: activeMessageId } : { entryId: id },
      kind: "message",
      role: normalizedRole,
      state: message.stopReason === "error" ? "error" : "complete",
      source: "persisted",
      timestamp,
      ...(parentEntryId === undefined ? {} : { parentEntryId }),
      content: messageContent(message),
    };
    const tools: TranscriptToolRecord[] = [];
    if (Array.isArray(message.content)) {
      for (const candidate of message.content) {
        const block = jsonRecord(candidate);
        if (block?.type !== "toolCall" || typeof block.id !== "string") continue;
        tools.push({
          recordId: `tool:${block.id}`,
          key: { entryId: id, toolCallId: block.id },
          kind: "tool",
          toolName: typeof block.name === "string" ? block.name : "tool",
          state: "pending",
          source: "persisted",
          timestamp,
          ...(parentEntryId === undefined ? {} : { parentEntryId }),
          ...(jsonRecord(block.arguments) === undefined ? {} : { arguments: boundedObject(jsonRecord(block.arguments)!) }),
          content: [],
        });
      }
    }
    return [messageRecord, ...tools];
  }
  if (entry.type === "compaction" || entry.type === "branch_summary") {
    return [{
      recordId: `summary:${id}`,
      key: { entryId: id },
      kind: "summary",
      summaryKind: entry.type === "compaction" ? "compaction" : "branch",
      content: [{ type: "markdown", text: typeof entry.summary === "string" ? boundedText(entry.summary) : "Summary" }],
      source: "persisted",
      timestamp,
      ...(parentEntryId === undefined ? {} : { parentEntryId }),
    }];
  }
  const event: TranscriptTimelineRecord["event"] | undefined = entry.type === "model_change" ? "model"
    : entry.type === "thinking_level_change" ? "thinking"
      : entry.type === "session_info" ? "session-name"
        : entry.type === "label" ? "label"
          : undefined;
  return event === undefined ? [] : [{
    recordId: `timeline:${id}`,
    key: { entryId: id },
    kind: "timeline",
    event,
    source: "persisted",
    timestamp,
    ...(parentEntryId === undefined ? {} : { parentEntryId }),
    label: typeof entry.name === "string" ? entry.name : typeof entry.label === "string" ? entry.label : typeof entry.modelId === "string" ? entry.modelId : typeof entry.thinkingLevel === "string" ? entry.thinkingLevel : event,
    data: boundedObject(entry),
  }];
}

function liveTimelineRecord(event: Record<string, unknown>, sequence: number): TranscriptTimelineRecord | undefined {
  const type = typeof event.type === "string" ? event.type : "";
  const timelineEvent: TranscriptTimelineRecord["event"] | undefined = type === "queue_update" ? "queue"
    : type === "auto_retry_start" || type === "auto_retry_end" ? "retry"
      : type === "compaction_start" || type === "compaction_end" ? "compaction"
        : type === "thinking_level_changed" ? "thinking"
          : type === "session_info_changed" ? "session-name"
            : type === "extension_error" ? "extension-ui"
              : undefined;
  if (timelineEvent === undefined) return undefined;
  return {
    recordId: `live-timeline:${sequence}`,
    key: { messageId: `live-timeline:${sequence}` },
    kind: "timeline",
    event: timelineEvent,
    source: "live",
    timestamp: new Date().toISOString(),
    label: timelineLabel(type, event),
    data: boundedObject(event),
  };
}

function timelineLabel(type: string, event: Record<string, unknown>): string {
  if (type === "queue_update") {
    const steering = Array.isArray(event.steering) ? event.steering.length : 0;
    const followUp = Array.isArray(event.followUp) ? event.followUp.length : 0;
    return `Queue updated · ${steering} steering · ${followUp} follow-up`;
  }
  if (type === "auto_retry_start") return `Retry ${String(event.attempt ?? "?")} of ${String(event.maxAttempts ?? "?")}`;
  if (type === "auto_retry_end") return event.success === true ? "Retry succeeded" : "Retry stopped";
  if (type === "compaction_start") return `Compaction started · ${String(event.reason ?? "manual")}`;
  if (type === "compaction_end") return event.aborted === true ? "Compaction aborted" : "Compaction completed";
  if (type === "thinking_level_changed") return `Thinking · ${String(event.level ?? "changed")}`;
  if (type === "session_info_changed") return `Session name · ${String(event.name ?? "cleared")}`;
  return `Extension error · ${String(event.error ?? "unknown")}`;
}

function preferredActivationMode(
  info: Pick<SessionInfoResource, "managed" | "activation">,
): ActivationMode | undefined {
  const modes = info.activation.modes.filter((mode) => mode !== "preview-only");
  if (info.managed !== undefined && modes.includes("reuse")) return "reuse";
  if (modes.includes("reuse")) return "reuse";
  if (modes.includes("fork")) return "fork";
  return modes.includes("direct") ? "direct" : undefined;
}

function isPending(state: DashboardTicketState): boolean {
  return state === "queued" || state === "running";
}

function rejected(
  correlationId: string,
  code: string,
  message: string,
  retryable: boolean,
): DashboardCommandResult {
  return { correlationId, state: "rejected", error: { code, message, retryable } };
}

function errorCode(error: unknown, fallback: string): string {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : fallback;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, ms));
}
