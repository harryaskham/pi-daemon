import { describe, expect, it, vi } from "vitest";
import { cronHumanPreview, scheduleCountdown, scheduleWrite, validateScheduleDraft, type ScheduleDraft } from "../schedule";
import type { ScheduleCapabilities } from "@harryaskham/pi-daemon/schedule-contract";

const capabilities: ScheduleCapabilities = {
  contractVersion: "1.0",
  persistence: true,
  timerRuntime: false,
  cronSyntax: "posix-five-field",
  timezoneDatabase: "runtime-iana",
  optimisticConcurrency: "expected-revision",
  overlapPolicies: ["skip", "queue-one", "reject"],
  missedWakePolicies: ["skip", "run-once", "bounded-catch-up"],
  promptHandling: "owner-private-sensitive-content",
  terminalTicketSummary: "content-free",
  clock: "wall-clock-utc-instants",
  limits: { maxSchedules: 10, maxSchedulesPerSession: 3, maxPromptBytes: 20, maxRecordBytes: 1000, maxRecoveryBytes: 10000, maxCatchUpRuns: 4, maxJitterMs: 10_000, maxAdmissionDelayMs: 20_000 },
};

function draft(patch: Partial<ScheduleDraft> = {}): ScheduleDraft {
  return { scheduleId: "daily", sessionRef: "session-1", enabled: true, cron: "0 9 * * 1-5", timezone: "UTC", prompt: "Review work", promptConfigured: false, modelProvider: "", modelId: "", thinkingLevel: "inherit", overlapPolicy: "skip", missedWakeMode: "skip", maxCatchUpRuns: 1, jitterSeconds: 0, maxAdmissionDelaySeconds: 10, ...patch };
}

describe("schedule editor model", () => {
  it("produces concise human previews and stable countdown boundaries", () => {
    expect(cronHumanPreview("0 9 * * 1-5")).toBe("Weekdays at 09:00");
    expect(scheduleCountdown("2026-01-01T00:00:30.000Z", Date.parse("2026-01-01T00:00:00.000Z"))).toBe("<1m");
    expect(scheduleCountdown("2026-01-01T02:00:00.000Z", Date.parse("2026-01-01T00:00:00.000Z"))).toBe("2h");
  });

  it("validates negotiated sensitive-content and policy bounds before mutation", () => {
    expect(validateScheduleDraft(draft(), capabilities)).toEqual({});
    const errors = validateScheduleDraft(draft({ cron: "61 25 * * *", timezone: "Not/A_Real_Zone", prompt: "x".repeat(21), modelProvider: "provider", jitterSeconds: 11, missedWakeMode: "bounded-catch-up", maxCatchUpRuns: 5 }), capabilities);
    expect(errors).toMatchObject({ cron: expect.any(String), timezone: expect.any(String), prompt: expect.any(String), model: expect.any(String), jitter: expect.any(String), catchUp: expect.any(String) });
  });

  it("retains configured prompts without returning or resubmitting their content", () => {
    expect(scheduleWrite(draft({ prompt: "", promptConfigured: true }))).not.toHaveProperty("prompt");
    expect(scheduleWrite(draft({ prompt: "replacement", promptConfigured: true }))).toHaveProperty("prompt", "replacement");
  });

  it("does not depend on focus or wall-clock timers to format authoritative instants", () => {
    vi.stubGlobal("document", { visibilityState: "hidden" });
    expect(scheduleCountdown("2026-01-02T00:00:00.000Z", Date.parse("2026-01-01T00:00:00.000Z"))).toBe("1d");
    vi.unstubAllGlobals();
  });
});
