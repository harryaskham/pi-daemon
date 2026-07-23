import { createHash } from "node:crypto";

import type { PiDaemonWebRuntimePolicyConfig } from "./config.js";
import { assertDashboardSessionDraftWithinRuntimePolicy } from "./dashboard-session-defaults.js";
import type { RpcResponse } from "@earendil-works/pi-coding-agent";

import {
  DashboardSessionDraftError,
  dashboardSessionDraftSpecToSessionSpec,
  type DashboardSessionDraftExecution,
  type DashboardSessionDraftIdentity,
  type DashboardSessionDraftRecovery,
  type DashboardSessionDraftResource,
  type DashboardSessionDraftSendRequest,
  type DashboardSessionDraftSendTicket,
  type DashboardSessionDraftSendWork,
  type DashboardSessionDraftSpec,
  type DashboardSessionDraftStore,
} from "./dashboard-session-drafts.js";
import {
  Multiplexer,
  MultiplexerError,
} from "./multiplexer.js";
import type { PiRpcController } from "./pi-rpc-controller.js";
import { PROTOCOL_VERSION, type ProtocolCommand } from "./protocol.js";
import type { ApiErrorBody } from "./session-api.js";
import {
  parseSessionConfiguration,
  sessionOpenPayloadFromSpec,
} from "./session-config.js";
import { sessionSpecDigest } from "./session-catalog.js";

export interface DashboardSessionDraftMaterializeInput {
  ticketId: string;
  requestId: string;
  draftId: string;
  draftRevision: number;
  targetSession: DashboardSessionDraftIdentity;
  spec: DashboardSessionDraftSpec;
  signal: AbortSignal;
}

export interface DashboardSessionDraftPromptInput {
  ticketId: string;
  requestId: string;
  session: DashboardSessionDraftIdentity;
  message: string;
  signal: AbortSignal;
}

export type DashboardSessionDraftPromptAdmission =
  | { accepted: true }
  | { accepted: false; error: ApiErrorBody };

export interface DashboardSessionDraftPromptController {
  admit(input: DashboardSessionDraftPromptInput): Promise<DashboardSessionDraftPromptAdmission>;
  release(): Promise<void> | void;
}

/** Runtime authority is injected so the durable controller is transport-neutral. */
export interface DashboardSessionDraftRuntimeGateway {
  materialize(input: DashboardSessionDraftMaterializeInput): Promise<DashboardSessionDraftIdentity>;
  acquirePromptController(
    session: DashboardSessionDraftIdentity,
    signal: AbortSignal,
  ): Promise<DashboardSessionDraftPromptController>;
  discard(session: DashboardSessionDraftIdentity): Promise<void>;
}

export interface DashboardSessionDraftMaterializerOptions {
  store: DashboardSessionDraftStore;
  runtime: DashboardSessionDraftRuntimeGateway;
}

/**
 * Durable first-send state machine. Store checkpoints always precede side
 * effects; only the private prompt-submitting phase is non-replayable.
 */
export class DashboardSessionDraftMaterializer implements DashboardSessionDraftExecution {
  readonly #store: DashboardSessionDraftStore;
  readonly #runtime: DashboardSessionDraftRuntimeGateway;
  readonly #runs = new Map<string, Promise<DashboardSessionDraftSendTicket>>();
  readonly #aborts = new Map<string, AbortController>();
  #recovered = false;
  #draining = false;

  constructor(options: DashboardSessionDraftMaterializerOptions) {
    this.#store = options.store;
    this.#runtime = options.runtime;
  }

  async recover(): Promise<DashboardSessionDraftRecovery> {
    if (this.#recovered) {
      throw new DashboardSessionDraftMaterializerError(
        "draft_materializer_already_recovered",
        "dashboard session draft materializer is already recovered",
      );
    }
    const recovery = await this.#store.recover();
    this.#recovered = true;
    for (const ticketId of recovery.recoverableTicketIds) this.#launch(ticketId);
    return structuredClone(recovery);
  }

  async submitSend(
    draftId: string,
    request: DashboardSessionDraftSendRequest,
  ): Promise<DashboardSessionDraftSendTicket> {
    this.#assertReady();
    if (this.#draining) {
      throw new DashboardSessionDraftMaterializerError(
        "draft_materializer_draining",
        "dashboard session draft materializer is draining",
        true,
      );
    }
    const ticket = await this.#store.submitSend(draftId, request);
    if (ticket.state === "queued" || ticket.state === "running") {
      this.#launch(ticket.ticketId);
    }
    return structuredClone(ticket);
  }

  getSend(ticketId: string): Promise<DashboardSessionDraftSendTicket | undefined> {
    this.#assertReady();
    return this.#store.getSend(ticketId);
  }

  async wait(ticketId: string): Promise<DashboardSessionDraftSendTicket | undefined> {
    this.#assertReady();
    const run = this.#runs.get(ticketId);
    if (run !== undefined) return structuredClone(await run);
    return this.#store.getSend(ticketId);
  }

  beginDrain(): void {
    if (this.#draining) return;
    this.#draining = true;
    for (const abort of this.#aborts.values()) abort.abort();
  }

  async settle(): Promise<void> {
    while (this.#runs.size > 0) {
      await Promise.allSettled([...this.#runs.values()]);
    }
  }

  get pendingRuns(): number {
    return this.#runs.size;
  }

  #launch(ticketId: string): void {
    if (this.#runs.has(ticketId)) return;
    const abort = new AbortController();
    this.#aborts.set(ticketId, abort);
    const run = this.#execute(ticketId, abort.signal).finally(() => {
      this.#runs.delete(ticketId);
      this.#aborts.delete(ticketId);
    });
    this.#runs.set(ticketId, run);
    void run.catch(() => {});
  }

  async #execute(
    ticketId: string,
    signal: AbortSignal,
  ): Promise<DashboardSessionDraftSendTicket> {
    let work = await this.#requiredWork(ticketId);
    if (isTerminal(work.ticket)) return work.ticket;
    if (work.ticket.state === "queued") {
      await this.#store.transitionSend(ticketId, {
        expectedState: "queued",
        state: "running",
        phase: "materializing",
      });
      work = await this.#requiredWork(ticketId);
    }

    let materialized: DashboardSessionDraftIdentity | undefined = work.ticket.session;
    try {
      signal.throwIfAborted();
      const draft = await this.#requiredDraft(work.ticket.draftId);
      materialized = await this.#runtime.materialize({
        ticketId,
        requestId: work.ticket.requestId,
        draftId: work.ticket.draftId,
        draftRevision: work.ticket.draftRevision,
        targetSession: work.targetSession,
        spec: draft.spec,
        signal,
      });
      assertSessionIdentity(materialized, work.targetSession);

      if (work.phase === "materializing" || work.ticket.session === undefined) {
        await this.#store.transitionSend(ticketId, {
          expectedState: "running",
          state: "running",
          phase: "ready-to-prompt",
          session: materialized,
        });
        work = await this.#requiredWork(ticketId);
      }

      signal.throwIfAborted();
      const controller = await this.#runtime.acquirePromptController(materialized, signal);
      try {
        await this.#store.transitionSend(ticketId, {
          expectedState: "running",
          state: "running",
          phase: "prompt-submitting",
          session: materialized,
        });
        const admission = await controller.admit({
          ticketId,
          requestId: firstPromptRequestId(ticketId),
          session: materialized,
          message: work.message,
          signal,
        });
        if (!admission.accepted) {
          const failed = await this.#terminalTransition(
            ticketId,
            "failed",
            admission.error,
            materialized,
          );
          await this.#runtime.discard(materialized).catch(() => {});
          return failed;
        }
        return await this.#store.transitionSend(ticketId, {
          expectedState: "running",
          state: "succeeded",
          phase: "prompt-submitting",
          session: materialized,
        });
      } finally {
        await controller.release();
      }
    } catch (error) {
      const latest = await this.#store.getSendWork(ticketId);
      if (latest === undefined) throw error;
      if (isTerminal(latest.ticket)) {
        if (
          latest.ticket.state === "failed" &&
          latest.ticket.error?.code === "draft_cancelled" &&
          materialized !== undefined
        ) {
          await this.#runtime.discard(materialized).catch(() => {});
        }
        return latest.ticket;
      }
      const ambiguous = latest.phase === "prompt-submitting";
      const terminal = await this.#terminalTransition(
        ticketId,
        ambiguous ? "indeterminate" : "failed",
        safeMaterializerError(error, ambiguous),
        materialized,
      );
      if (!ambiguous && materialized !== undefined) {
        await this.#runtime.discard(materialized).catch(() => {});
      }
      return terminal;
    }
  }

  async #terminalTransition(
    ticketId: string,
    state: "failed" | "indeterminate",
    error: ApiErrorBody,
    session: DashboardSessionDraftIdentity | undefined,
  ): Promise<DashboardSessionDraftSendTicket> {
    try {
      return await this.#store.transitionSend(ticketId, {
        expectedState: "running",
        state,
        ...(session === undefined ? {} : { session }),
        error,
      });
    } catch (transitionError) {
      if (
        transitionError instanceof DashboardSessionDraftError &&
        transitionError.code === "draft_ticket_state_conflict"
      ) {
        const current = await this.#store.getSend(ticketId);
        if (current !== undefined && isTerminal(current)) return current;
      }
      throw transitionError;
    }
  }

  async #requiredWork(ticketId: string): Promise<DashboardSessionDraftSendWork> {
    const work = await this.#store.getSendWork(ticketId);
    if (work === undefined) {
      throw new DashboardSessionDraftMaterializerError(
        "draft_ticket_not_found",
        "dashboard session draft send ticket does not exist",
      );
    }
    return work;
  }

  async #requiredDraft(draftId: string): Promise<DashboardSessionDraftResource> {
    const draft = await this.#store.get(draftId);
    if (draft === undefined) {
      throw new DashboardSessionDraftMaterializerError(
        "draft_not_found",
        "dashboard session draft does not exist",
      );
    }
    return draft;
  }

  #assertReady(): void {
    if (!this.#recovered) {
      throw new DashboardSessionDraftMaterializerError(
        "draft_materializer_not_ready",
        "dashboard session draft materializer is not recovered",
      );
    }
  }
}

export class DashboardSessionDraftMaterializerError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, message: string, retryable = false) {
    super(message);
    this.name = "DashboardSessionDraftMaterializerError";
    this.code = code;
    this.retryable = retryable;
  }
}

export interface MultiplexerDashboardSessionDraftRuntimeOptions {
  multiplexer: Multiplexer;
  hasController?: (sessionId: string) => boolean | Promise<boolean>;
  runtimePolicy?: PiDaemonWebRuntimePolicyConfig;
  enforceRuntimePolicy?: boolean;
}

/** Embedded/service runtime adapter; construction itself performs no Pi work. */
export class MultiplexerDashboardSessionDraftRuntime
  implements DashboardSessionDraftRuntimeGateway {
  readonly #multiplexer: Multiplexer;
  readonly #hasController:
    | ((sessionId: string) => boolean | Promise<boolean>)
    | undefined;
  readonly #runtimePolicy: PiDaemonWebRuntimePolicyConfig | undefined;
  readonly #enforceRuntimePolicy: boolean;

  constructor(options: MultiplexerDashboardSessionDraftRuntimeOptions) {
    this.#multiplexer = options.multiplexer;
    this.#hasController = options.hasController;
    this.#runtimePolicy = options.runtimePolicy;
    this.#enforceRuntimePolicy = options.enforceRuntimePolicy ?? false;
  }

  async materialize(
    input: DashboardSessionDraftMaterializeInput,
  ): Promise<DashboardSessionDraftIdentity> {
    input.signal.throwIfAborted();
    if (this.#enforceRuntimePolicy) {
      assertDashboardSessionDraftWithinRuntimePolicy(input.spec, this.#runtimePolicy);
    }
    const prepared = parseSessionConfiguration(
      dashboardSessionDraftSpecToSessionSpec(input.spec, this.#runtimePolicy),
    );
    const retained = await this.#multiplexer.retainedSession(input.targetSession.sessionId);
    if (retained !== undefined && retained.generation === input.targetSession.generation) {
      const expectedDigest = sessionSpecDigest(prepared.persistedSpec);
      if (retained.policyDigest !== expectedDigest) {
        throw new DashboardSessionDraftMaterializerError(
          "draft_session_policy_conflict",
          "materialized session policy differs from the admitted draft",
        );
      }
      if (retained.spec.target.mode === "memory") {
        try {
          const live = this.#multiplexer.status(retained.sessionId);
          if (live.generation === retained.generation) return input.targetSession;
        } catch (error) {
          if (!(error instanceof MultiplexerError) || error.code !== "session_not_found") {
            throw error;
          }
        }
        await this.#multiplexer.deleteRetainedSession(retained.sessionId, {
          requestId: `draft-reset-${stableId(input.ticketId)}`,
          expectedGeneration: retained.generation,
          expectedRevision: retained.revision,
        });
      }
    }

    const command: Extract<ProtocolCommand, { operation: "open" }> = {
      protocolVersion: PROTOCOL_VERSION,
      requestId: `draft-open-${stableId(input.ticketId)}`,
      operation: "open",
      sessionId: input.targetSession.sessionId,
      generation: input.targetSession.generation,
      payload: sessionOpenPayloadFromSpec(prepared.persistedSpec),
    };
    await this.#multiplexer.open(command, {
      signal: input.signal,
      runtimeOptions: prepared.runtimeOptions,
      environmentSummary: prepared.environmentSummary,
      catalogSpec: prepared.persistedSpec,
    });
    return structuredClone(input.targetSession);
  }

  async acquirePromptController(
    session: DashboardSessionDraftIdentity,
    signal: AbortSignal,
  ): Promise<DashboardSessionDraftPromptController> {
    signal.throwIfAborted();
    if (await this.#hasController?.(session.sessionId)) {
      throw new DashboardSessionDraftMaterializerError(
        "controller_busy",
        "another controller already owns the materialized session",
        true,
      );
    }
    const controller = await this.#multiplexer.rpcController(
      session.sessionId,
      session.generation,
    );
    return promptController(controller);
  }

  async discard(session: DashboardSessionDraftIdentity): Promise<void> {
    await this.#multiplexer.close({
      protocolVersion: PROTOCOL_VERSION,
      requestId: `draft-discard-${stableId(`${session.sessionId}:${session.generation}`)}`,
      operation: "close",
      sessionId: session.sessionId,
      generation: session.generation,
      payload: { retainSession: false },
    });
  }
}

function promptController(controller: PiRpcController): DashboardSessionDraftPromptController {
  return {
    async admit(input) {
      input.signal.throwIfAborted();
      let aborting = false;
      const onAbort = (): void => {
        if (aborting) return;
        aborting = true;
        void controller.handle({
          id: `draft-abort-${stableId(input.ticketId)}`,
          type: "abort",
        });
      };
      input.signal.addEventListener("abort", onAbort, { once: true });
      try {
        const response: RpcResponse = await controller.handle({
          id: input.requestId,
          type: "prompt",
          message: input.message,
        });
        return response.success
          ? { accepted: true }
          : {
              accepted: false,
              error: {
                code: "draft_prompt_rejected",
                message: "dashboard session draft first message was rejected",
                retryable: false,
              },
            };
      } finally {
        input.signal.removeEventListener("abort", onAbort);
      }
    },
    release() {},
  };
}

function safeMaterializerError(error: unknown, ambiguous: boolean): ApiErrorBody {
  if (ambiguous) {
    return {
      code: "draft_send_indeterminate",
      message: "draft first-send acceptance is indeterminate",
      retryable: false,
    };
  }
  if (error instanceof DashboardSessionDraftMaterializerError) {
    return { code: error.code, message: error.message, retryable: error.retryable };
  }
  if (error instanceof MultiplexerError) {
    return {
      code: safeCode(error.code, "draft_runtime_failed"),
      message: "dashboard session draft runtime operation failed",
      retryable: error.retryable,
    };
  }
  if (error instanceof DOMException && error.name === "AbortError") {
    return {
      code: "draft_materializer_draining",
      message: "dashboard session draft materialization was interrupted",
      retryable: true,
    };
  }
  return {
    code: "draft_materialization_failed",
    message: "dashboard session draft materialization failed",
    retryable: false,
  };
}

function assertSessionIdentity(
  actual: DashboardSessionDraftIdentity,
  expected: DashboardSessionDraftIdentity,
): void {
  if (
    actual.sessionId !== expected.sessionId ||
    actual.generation !== expected.generation
  ) {
    throw new DashboardSessionDraftMaterializerError(
      "draft_session_identity_conflict",
      "materialized session identity differs from the admitted draft",
    );
  }
}

function isTerminal(ticket: DashboardSessionDraftSendTicket): boolean {
  return ["succeeded", "failed", "indeterminate"].includes(ticket.state);
}

function firstPromptRequestId(ticketId: string): string {
  return `draft-first-${stableId(ticketId)}`;
}

function stableId(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 40);
}

function safeCode(value: string, fallback: string): string {
  return /^[a-z][a-z0-9_]{0,127}$/u.test(value) ? value : fallback;
}
