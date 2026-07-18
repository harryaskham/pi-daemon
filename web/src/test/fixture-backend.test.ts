import { createDashboardContractFixtures } from "@harryaskham/pi-daemon/dashboard-fixtures";
import { DASH_DEFAULT_LIMITS, DASH_PERFORMANCE_BUDGETS } from "@harryaskham/pi-daemon/dashboard-contract";
import { describe, expect, it } from "vitest";
import { LocalFixtureBackend } from "../fixture-backend";

const backend = new LocalFixtureBackend();

describe("local dashboard fixture backend", () => {
  it("models a deterministic virtualized 10k-session inventory through the public contract", async () => {
    expect(backend.sessions).toHaveLength(DASH_PERFORMANCE_BUDGETS.benchmarkSessionCount);
    const first = await backend.listSessions({ limit: DASH_DEFAULT_LIMITS.maxInventoryPageItems });
    expect(first.sessions).toHaveLength(100);
    expect(first.index).toMatchObject({ formatVersion: 1, stale: false, reconciling: false });
    expect(first.nextCursor).toBe("cursor_100");
    if (!first.nextCursor) throw new Error("fixture page should have a next cursor");
    const second = await backend.listSessions({ cursor: first.nextCursor, limit: 100 });
    expect(second.sessions[0]?.inventoryId).not.toBe(first.sessions[0]?.inventoryId);
  });

  it("keeps preview independent from hydration and pages at the public 200-record limit", async () => {
    const session = backend.sessions[29];
    expect(session).toBeDefined();
    if (!session) return;
    const transcript = await backend.getTranscript(session.inventoryId, { limit: DASH_DEFAULT_LIMITS.maxTranscriptPageRecords });
    expect(transcript.hydration).toBe("not-requested");
    expect(transcript.records).toHaveLength(200);
    expect(transcript.newerCursor).toBe("cursor_200");
  });

  it("consumes the canonical live fixture identity and opaque cursor", () => {
    const fixture = createDashboardContractFixtures();
    expect(fixture.streamEvent.event.identity).toEqual({
      hostInstanceId: "host-fixture-01",
      sessionId: "session-fixture-01",
      generation: 3,
    });
    expect(fixture.streamEvent.event.kind).toBe("session_event");
    if (fixture.streamEvent.event.kind !== "session_event") throw new Error("expected session event fixture");
    expect(fixture.streamEvent.event.cursor).toMatch(/^dash:fixture:/);
    expect(fixture.capabilities.presentations.rich.available).toBe(true);
    expect(fixture.capabilities.presentations.tui.available).toBe(false);
  });

  it("searches all 10k bounded records without returning private transcript content", async () => {
    const result = await backend.listSessions({ search: "session-09999" });
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]?.managed?.sessionId).toBe("session-09999");
    expect(JSON.stringify(result)).not.toContain("provider credential");
  });
});
