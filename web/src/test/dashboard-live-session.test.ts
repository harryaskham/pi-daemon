import { describe, expect, it } from "vitest";
import { DashboardLiveSessionController } from "../dashboard-live-session";
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
    expect(controller.state.sessionStats).toMatchObject({ messages: expect.any(Number) });
    expect(controller.state.availableCommands).toMatchObject({ commands: expect.arrayContaining(["/model", "/compact"]) });
    expect(controller.state.availableModels).toMatchObject({ models: expect.arrayContaining(["gpt-5.6"]) });
    await controller.stop();
  });

  it("merges live and durable events without duplicate transcript rows", async () => {
    const backend = new LiveFixtureDashboardBackend();
    const session = backend.sessions[0]!;
    const controller = new DashboardLiveSessionController(backend, session.inventoryId);
    await controller.start();
    const before = controller.state.transcript?.records.length ?? 0;
    const result = await controller.command("prompt", { message: "exercise live merge" }, "prompt-once");
    expect(result.state).toBe("streaming");
    expect(controller.state.phase).toBe("streaming");
    await waitFor(() => controller.state.phase === "live" && controller.state.unread);
    const records = controller.state.transcript?.records ?? [];
    expect(records.length).toBe(before + 2);
    expect(records.filter((record) => record.kind === "message" && record.content.some((block) => "text" in block && block.text.includes("Completed fixture response")))).toHaveLength(1);
    controller.markSeen();
    expect(controller.state.unread).toBe(false);

    await controller.command("set_model", { modelId: "gpt-5-mini" });
    expect(controller.state.rpcState.model).toBe("gpt-5-mini");
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
