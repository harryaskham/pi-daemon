import { describe, expect, it, vi } from "vitest";
import { DashboardLiveSessionController } from "../dashboard-live-session";
import { liveComposerPresentation } from "../components/ChatPane";
import { contextUsageFromSessionStats } from "../session-stats";
import { LiveFixtureDashboardBackend } from "../live-fixture-backend";

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error("timed out waiting for live session state");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("Dashboard live session controller", () => {
  it("paints preview before no-prompt hydration and loads channel metadata", async () => {
    const backend = new LiveFixtureDashboardBackend();
    const session = backend.sessions[0];
    expect(session).toBeDefined();
    if (!session) return;
    const controller = new DashboardLiveSessionController(backend, session.inventoryId, {
      ticketPollMs: 1,
      maxTicketPolls: 4,
    });
    const phases: string[] = [];
    controller.subscribe((state) => phases.push(state.phase));
    await controller.start();
    await waitFor(() => controller.state.availableCommands !== undefined);
    expect(phases).toContain("preview");
    expect(controller.state.phase).toBe("live");
    expect(controller.state.role).toBe("controller");
    expect(controller.state.transcript?.records.length).toBeGreaterThan(0);
    expect(controller.state.managedSession?.sessionId).toBe(session.sessionId);
    expect(contextUsageFromSessionStats(controller.state.sessionStats)).toMatchObject({
      tokens: expect.any(Number),
      contextWindow: 200_000,
      percent: expect.any(Number),
    });
    expect(controller.state.availableCommands).toMatchObject({ commands: expect.arrayContaining(["/model", "/compact"]) });
    expect(controller.state.availableModels).toMatchObject({ models: expect.arrayContaining(["gpt-5.6"]) });

    const reconnectStats: Array<unknown> = [];
    const unsubscribe = controller.subscribe((state) => reconnectStats.push(state.sessionStats));
    await controller.reconnect();
    await waitFor(() => contextUsageFromSessionStats(controller.state.sessionStats) !== undefined);
    expect(reconnectStats).toContain(null);
    unsubscribe();
    await controller.stop();
  });

  it("keeps an unavailable quarantined transcript readonly without observer attach", async () => {
    const backend = new LiveFixtureDashboardBackend();
    const session = backend.sessions[0]!;
    const available = await backend.getTranscript(session.inventoryId, { limit: 200 });
    const withoutFingerprint = { ...available };
    delete withoutFingerprint.sourceFingerprint;
    vi.spyOn(backend, "getTranscript").mockResolvedValue({
      ...withoutFingerprint,
      records: [],
      availability: {
        state: "unavailable",
        reasonCode: "session_quarantined",
        retryable: true,
        observerAttachAllowed: false,
      },
      freshness: {
        state: "unavailable",
        observedAt: "2026-07-18T12:00:00.000Z",
      },
      quarantine: {
        state: "reprovision_required",
        code: "tool_adapter_reprovision_required",
        retryable: true,
      },
    });
    const attach = vi.spyOn(backend, "openSessionChannel");
    const controller = new DashboardLiveSessionController(backend, session.inventoryId);
    await controller.start();
    expect(controller.state.phase).toBe("preview-only");
    expect(controller.state.transcript?.records).toEqual([]);
    expect(controller.state.transcriptAvailability?.state).toBe("unavailable");
    expect(controller.state.transcriptFreshness?.state).toBe("unavailable");
    expect(attach).not.toHaveBeenCalled();
    await controller.stop();
  });

  it("merges live and durable events without duplicate transcript rows", async () => {
    const backend = new LiveFixtureDashboardBackend();
    const session = backend.sessions[0]!;
    const controller = new DashboardLiveSessionController(backend, session.inventoryId);
    await controller.start();
    await waitFor(() => contextUsageFromSessionStats(controller.state.sessionStats) !== undefined);
    const before = controller.state.transcript?.records.length ?? 0;
    const contextBefore = contextUsageFromSessionStats(controller.state.sessionStats)?.percent;
    expect(contextBefore).toEqual(expect.any(Number));
    const result = await controller.command("prompt", { message: "exercise live merge" }, "prompt-once");
    expect(result.state).toBe("streaming");
    expect(controller.state.phase).toBe("streaming");
    await waitFor(() => controller.state.phase === "live" && controller.state.unread);
    await waitFor(() => contextUsageFromSessionStats(controller.state.sessionStats)?.percent === Number(contextBefore) + 1);
    const records = controller.state.transcript?.records ?? [];
    expect(records.length).toBe(before + 2);
    expect(records.filter((record) => record.kind === "message" && record.content.some((block) => "text" in block && block.text.includes("Completed fixture response")))).toHaveLength(1);
    controller.markSeen();
    expect(controller.state.unread).toBe(false);

    const contextAfterTurn = contextUsageFromSessionStats(controller.state.sessionStats)?.percent;
    await controller.command("set_model", { provider: "github-copilot", modelId: "gpt-5-mini" });
    expect(controller.state.rpcState.model).toBe("gpt-5-mini");
    await waitFor(() => contextUsageFromSessionStats(controller.state.sessionStats)?.percent === Number(contextAfterTurn) - 2);
    await controller.stop();
  });

  it("queues active-turn messages as cancellable FIFO steering input", async () => {
    const backend = new LiveFixtureDashboardBackend();
    const session = backend.sessions[0]!;
    const controller = new DashboardLiveSessionController(backend, session.inventoryId);
    await controller.start();
    await controller.command("prompt", { message: "exercise one steering boundary" });
    expect(controller.state.phase).toBe("streaming");

    const first = await controller.submit("prompt", { message: "steer this first" }, "steer-first");
    const duplicate = await controller.submit("prompt", { message: "steer this first" }, "steer-first");
    const second = await controller.submit("prompt", { message: "cancel this second" }, "steer-second");
    expect(first).toMatchObject({ state: "completed", data: { disposition: "queued" } });
    expect(duplicate).toMatchObject({ state: "completed", data: { disposition: "queued" } });
    expect(second.state).toBe("completed");
    expect(controller.state.pendingSteeringMessages.map((message) => message.preview)).toEqual([
      "steer this first",
      "cancel this second",
    ]);
    expect(liveComposerPresentation(controller.state)).toMatchObject({
      disabled: false,
      submitLabel: "Queue steer",
      status: "2 steering messages waiting in FIFO order",
    });

    const cancelledId = controller.state.pendingSteeringMessages[1]?.queueId;
    expect(cancelledId).toBeDefined();
    expect(controller.cancelQueuedSteeringMessage(cancelledId!)).toBe(true);
    expect(controller.cancelQueuedSteeringMessage(cancelledId!)).toBe(false);
    expect((await controller.submit("prompt", { message: "different" }, "steer-first")).state).toBe("rejected");

    await waitFor(() => controller.state.pendingSteeringMessages.length === 0);
    const transcript = JSON.stringify(controller.state.transcript?.records ?? []);
    expect(transcript).not.toContain("cancel this second");
    await controller.stop();
  });

  it("submits a FIFO steering message as the next turn when the active run settles first", async () => {
    const backend = new LiveFixtureDashboardBackend();
    const session = backend.sessions[0]!;
    const controller = new DashboardLiveSessionController(backend, session.inventoryId);
    await controller.start();
    await controller.command("prompt", { message: "turn without a tool boundary" });
    await controller.submit("prompt", { message: "queued next turn one" }, "next-turn-one");
    await controller.submit("prompt", { message: "queued next turn two" }, "next-turn-two");

    await waitFor(() => {
      const transcript = JSON.stringify(controller.state.transcript?.records ?? []);
      return transcript.includes("Completed fixture response to: queued next turn one") &&
        transcript.includes("Completed fixture response to: queued next turn two") &&
        controller.state.pendingSteeringMessages.length === 0;
    });
    const transcript = JSON.stringify(controller.state.transcript?.records ?? []);
    expect(transcript.indexOf("queued next turn one")).toBeLessThan(transcript.indexOf("queued next turn two"));
    await controller.stop();
  });

  it("normalizes raw Pi message, tool and durable entry events by stable identity", async () => {
    const backend = new LiveFixtureDashboardBackend();
    const session = backend.sessions[0]!;
    const controller = new DashboardLiveSessionController(backend, session.inventoryId);
    await controller.start();
    await controller.command("prompt", { message: "exercise raw Pi events" });
    const records = controller.state.transcript?.records ?? [];
    const rawMessages = records.filter((record) => record.kind === "message" && record.content.some((block) => "text" in block && block.text.includes("Raw Pi stream")));
    expect(rawMessages).toHaveLength(1);
    expect(rawMessages[0]).toMatchObject({ source: "persisted", state: "complete" });
    expect(records.find((record) => record.kind === "tool" && record.key.toolCallId === "raw-tool")).toMatchObject({ state: "success", source: "live" });
    expect(records.some((record) => record.kind === "message" && record.content.some((block) => "text" in block && block.text.includes("raw tool duplicate")))).toBe(false);
    await controller.stop();
  });

  it("surfaces extension UI and clears it after controller response", async () => {
    const backend = new LiveFixtureDashboardBackend();
    const session = backend.sessions[0]!;
    const controller = new DashboardLiveSessionController(backend, session.inventoryId);
    await controller.start();
    await controller.command("prompt", { message: "request extension confirmation" });
    await waitFor(() => controller.state.extensionRequests.length === 1);
    expect(controller.state.extensionRequests[0]).toMatchObject({
      requestId: "fixture-extension",
      method: "confirm",
    });
    await controller.answerExtensionUi("fixture-extension", { confirmed: true });
    expect(controller.state.extensionRequests).toEqual([]);
    await controller.stop();
  });

  it("accepts validated declarative extension views and correlates scoped action responses", async () => {
    const backend = new LiveFixtureDashboardBackend();
    const session = backend.sessions[0]!;
    const controller = new DashboardLiveSessionController(backend, session.inventoryId);
    await controller.start();
    await controller.command("prompt", { message: "show declarative extension view" });
    await waitFor(() => controller.state.extensionViews.length === 1);
    const event = controller.state.extensionViews[0];
    expect(event).toMatchObject({
      requestId: "fixture-extension-view",
      provenance: { validation: "validated", browserCodeExecution: false },
      view: { protocol: "pi-declarative-view", version: "1.0", viewId: "review-fixture-01" },
    });
    await controller.answerExtensionUi("fixture-extension-view", {
      protocol: "pi-declarative-view",
      version: "1.0",
      viewId: "review-fixture-01",
      revision: 2,
      actionId: "continue",
    });
    expect(controller.state.extensionViews).toEqual([]);
    await controller.stop();
  });

  it("projects fire-and-forget extension notifications, status, widgets, title and editor text", async () => {
    const backend = new LiveFixtureDashboardBackend();
    const session = backend.sessions[0]!;
    const controller = new DashboardLiveSessionController(backend, session.inventoryId);
    await controller.start();
    await controller.command("prompt", { message: "exercise extension surfaces" });
    await waitFor(() => controller.state.extensionNotifications.length === 1);
    expect(controller.state.extensionNotifications[0]).toMatchObject({ message: "Fixture notification", type: "warning" });
    expect(controller.state.extensionStatuses).toEqual({ fixture: "Extension active" });
    expect(controller.state.extensionWidgets.fixture?.lines).toEqual(["Fixture widget", "bounded line"]);
    expect(controller.state.extensionTitle).toBe("Fixture extension title");
    expect(controller.state.extensionEditorText).toBe("prefilled extension text");
    await controller.stop();
  });

  it("loads bounded branch truth, compares paths, and prefills edit-resubmit only after a successful fork", async () => {
    const backend = new LiveFixtureDashboardBackend();
    const session = backend.sessions[0]!;
    const controller = new DashboardLiveSessionController(backend, session.inventoryId);
    await controller.start();
    await controller.loadTree();
    expect(controller.state.treePhase).toBe("ready");
    expect(controller.state.tree?.entries).toHaveLength(5);
    expect(controller.state.tree?.activePathIds).toEqual(["tree-root", "tree-active", "tree-active-leaf"]);
    controller.selectTreeEntry("tree-left");
    controller.compareTreeEntry("tree-active-leaf");
    expect(controller.state.treeSelectedEntryId).toBe("tree-left");
    expect(controller.state.treeCompareEntryId).toBe("tree-active-leaf");
    const navigated = await controller.navigateTreeEntry("tree-left", {
      summarize: true,
      customInstructions: "Summarize the abandoned experiment",
      label: "experiment-summary",
    });
    expect(navigated).toMatchObject({ state: "completed", data: { summaryEntryId: "tree-summary-new" } });
    expect(controller.state.treeEditorText).toBe("Try the abandoned approach");
    controller.clearTreeEditorText();
    const result = await controller.forkTreeEntry("tree-left", true);
    expect(result.state).toBe("completed");
    expect(controller.state.treeEditorText).toBe("Try the abandoned approach");
    expect(controller.state.treePhase).toBe("ready");
    controller.clearTreeEditorText();
    expect(controller.state.treeEditorText).toBeUndefined();
    expect((await controller.cloneTree()).state).toBe("completed");
    await controller.stop();
  });

  it("coalesces controller authority across panes and never replays control", async () => {
    const backend = new LiveFixtureDashboardBackend();
    const session = backend.sessions[0]!;
    const first = new DashboardLiveSessionController(backend, session.inventoryId);
    const second = new DashboardLiveSessionController(backend, session.inventoryId);
    await first.start();
    await second.start();
    expect(first.state.role).toBe("controller");
    expect(second.state.role).toBe("observer");
    expect((await second.requestControl()).state).toBe("rejected");
    expect((await first.releaseControl()).state).toBe("completed");
    expect((await second.requestControl()).state).toBe("completed");
    expect(second.state.role).toBe("controller");
    await first.stop();
    await second.stop();
  });

  it("keeps dormant managed preview cold until first send hydrates and wakes it", async () => {
    const backend = new LiveFixtureDashboardBackend();
    const session = backend.sessions[1]!;
    expect(session.managed?.residency).toBe("dormant");
    const baseOpen = backend.openSessionChannel.bind(backend);
    let opens = 0;
    backend.openSessionChannel = async (options) => {
      opens += 1;
      return baseOpen(options);
    };
    const controller = new DashboardLiveSessionController(backend, session.inventoryId, {
      ticketPollMs: 1,
      maxTicketPolls: 4,
    });
    await controller.start();
    expect(controller.state.phase).toBe("preview");
    expect(controller.state.selectedActivationMode).toBe("reuse");
    expect(opens).toBe(0);
    expect(liveComposerPresentation(controller.state)).toMatchObject({
      disabled: false,
      submitLabel: "Activate & send",
    });

    const result = await controller.submit(
      "prompt",
      { message: "wake the dormant fixture" },
      "wake-dormant-once",
    );
    expect(result.state).toBe("streaming");
    expect(opens).toBe(1);
    expect(controller.state.managedSession?.sessionId).toBe(session.sessionId);
    await controller.stop();
  });

  it("activates an external preview with safe fork and submits the first prompt once", async () => {
    const backend = new LiveFixtureDashboardBackend();
    const session = backend.sessions[11]!;
    const baseActivate = backend.activateSession.bind(backend);
    const baseOpen = backend.openSessionChannel.bind(backend);
    const activationModes: string[] = [];
    const activationRequests: Parameters<typeof backend.activateSession>[1][] = [];
    let opens = 0;
    backend.activateSession = async (inventoryId, request) => {
      activationModes.push(request.mode);
      activationRequests.push(request);
      return baseActivate(inventoryId, request);
    };
    backend.openSessionChannel = async (options) => {
      opens += 1;
      return baseOpen(options);
    };
    const controller = new DashboardLiveSessionController(backend, session.inventoryId, {
      ticketPollMs: 1,
      maxTicketPolls: 4,
    });
    await controller.start();
    expect(controller.state.phase).toBe("activation-choice");
    expect(controller.state.selectedActivationMode).toBe("fork");
    expect(activationModes).toEqual([]);
    expect(opens).toBe(0);

    const result = await controller.submit(
      "prompt",
      { message: "activate and wake once" },
      "external-first-send",
    );
    expect(result.state).toBe("streaming");
    expect(activationModes).toEqual(["fork"]);
    expect(activationRequests[0]?.expectedFingerprint).toBe(controller.state.previewFingerprint);
    expect(activationRequests[0]?.policyRef).toBeUndefined();
    expect(opens).toBe(1);
    await controller.stop();
  });

  it("binds an explicit direct co-opt choice to the current preview and confirmation policy", async () => {
    const backend = new LiveFixtureDashboardBackend();
    const session = backend.sessions[11]!;
    const baseActivate = backend.activateSession.bind(backend);
    let activationRequest: Parameters<typeof backend.activateSession>[1] | undefined;
    backend.activateSession = async (inventoryId, request) => {
      activationRequest = request;
      return baseActivate(inventoryId, request);
    };
    const controller = new DashboardLiveSessionController(backend, session.inventoryId, {
      ticketPollMs: 1,
      maxTicketPolls: 4,
    });
    await controller.start();
    expect(controller.state.phase).toBe("activation-choice");
    expect(controller.state.selectedActivationMode).toBe("fork");
    controller.selectActivationMode("direct");
    await controller.submit("prompt", { message: "direct once" }, "direct-first-send");
    expect(activationRequest?.mode).toBe("direct");
    expect(activationRequest?.expectedFingerprint).toBe(controller.state.previewFingerprint);
    expect(activationRequest?.policyRef).toBe("direct-co-opt-confirmed-v1");
    await controller.stop();
  });

  it("keeps failed and indeterminate first-send activation inline without prompt replay", async () => {
    for (const terminal of ["failed", "indeterminate"] as const) {
      const backend = new LiveFixtureDashboardBackend();
      const session = backend.sessions[11]!;
      let opens = 0;
      backend.openSessionChannel = async () => {
        opens += 1;
        throw new Error("must not hydrate after terminal activation");
      };
      backend.activateSession = async (inventoryId, request) => ({
        ticketId: `${terminal}-activation`,
        requestId: request.requestId,
        idempotencyKey: request.idempotencyKey,
        inventoryId,
        mode: request.mode,
        state: terminal,
        submittedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        ...(terminal === "failed"
          ? { error: { code: "fixture_activation_failed", message: "Fixture activation failed", retryable: true } }
          : {}),
      });
      const controller = new DashboardLiveSessionController(backend, session.inventoryId, {
        ticketPollMs: 1,
        maxTicketPolls: 2,
      });
      await controller.start();
      const result = await controller.submit(
        "prompt",
        { message: "must not replay" },
        `${terminal}-first-send`,
      );
      expect(result.state).toBe(terminal === "failed" ? "rejected" : "indeterminate");
      expect(controller.state.phase).toBe(terminal === "failed" ? "error" : "indeterminate");
      expect(liveComposerPresentation(controller.state)).toMatchObject({ disabled: true });
      expect(opens).toBe(0);
      await controller.stop();
    }
  });

  it("keeps non-activatable policy states readable and disables only the composer", async () => {
    const backend = new LiveFixtureDashboardBackend();
    const session = backend.sessions[11]!;
    const baseGetInfo = backend.getSessionInfo.bind(backend);
    let activations = 0;
    backend.getSessionInfo = async (inventoryId) => ({
      ...(await baseGetInfo(inventoryId)),
      activation: { eligible: false, modes: ["preview-only"], reasonCode: "policy_denied" },
    });
    backend.activateSession = async () => {
      activations += 1;
      throw new Error("must not activate");
    };
    const controller = new DashboardLiveSessionController(backend, session.inventoryId);
    await controller.start();
    expect(controller.state.phase).toBe("preview-only");
    expect(controller.state.transcript?.records.length).toBeGreaterThan(0);
    expect(liveComposerPresentation(controller.state)).toMatchObject({
      disabled: true,
      submitLabel: "Preview only",
    });
    expect((await controller.submit("prompt", { message: "denied" })).state).toBe("rejected");
    expect(activations).toBe(0);
    await controller.stop();
  });

  it("attaches a materialized draft directly without preview lookup or prompt replay", async () => {
    const backend = new LiveFixtureDashboardBackend();
    const draft = await backend.createSessionDraft({
      requestId: "draft-create-controller",
      idempotencyKey: "draft-create-controller-key",
      draftId: "draft-controller-01",
      spec: {
        cwd: "/work/controller-draft",
        persistence: "persistent",
        tools: { mode: "none" },
        resources: {
          noExtensions: true,
          noSkills: true,
          noPromptTemplates: true,
          noThemes: true,
          noContextFiles: true,
          projectTrust: "deny",
        },
        isolation: { mode: "unisolated" },
      },
    });
    const ticket = await backend.sendSessionDraft(draft.draftId, {
      requestId: "draft-send-controller",
      idempotencyKey: "draft-send-controller-key",
      expectedRevision: draft.revision,
      message: "first message already admitted",
    });
    expect(ticket.session).toBeDefined();
    if (ticket.session === undefined) return;
    backend.getTranscript = async () => {
      throw new Error("materialized draft must not request preview transcript");
    };
    backend.getSessionInfo = async () => {
      throw new Error("materialized draft must not request inventory info");
    };
    const controller = new DashboardLiveSessionController(
      backend,
      `draft-live:${draft.draftId}`,
      { initialManaged: ticket.session },
    );
    await controller.start();
    expect(controller.state.phase).toBe("live");
    expect(controller.state.managedSession?.sessionId).toBe(ticket.session.sessionId);
    expect(controller.state.transcript?.records.some((record) => record.source === "optimistic")).toBe(false);
    await controller.stop();
  });

  it("offers direct/fork activation choices and preserves indeterminate export", async () => {
    const backend = new LiveFixtureDashboardBackend();
    const session = backend.sessions[11]!;
    const baseGetInfo = backend.getSessionInfo.bind(backend);
    backend.getSessionInfo = async (inventoryId) => {
      const info = await baseGetInfo(inventoryId);
      const { managed: _managed, ...preview } = info;
      return {
        ...preview,
        sourceKind: "external",
        activation: { eligible: true, modes: ["direct", "fork", "preview-only"] },
      };
    };
    const controller = new DashboardLiveSessionController(backend, session.inventoryId, {
      ticketPollMs: 1,
      maxTicketPolls: 4,
    });
    await controller.start();
    expect(controller.state.phase).toBe("activation-choice");
    expect(controller.state.activationModes).toEqual(["direct", "fork", "preview-only"]);
    await controller.activate("fork");
    expect(controller.state.phase).toBe("live");
    await controller.exportSession("append-to-origin");
    expect(controller.state.exportTicket?.state).toBe("indeterminate");
    expect(controller.state.phase).toBe("indeterminate");
    await controller.stop();
  });
});
