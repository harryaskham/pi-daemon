import { describe, expect, it } from "vitest";
import type { DashboardSessionDraftResource } from "@harryaskham/pi-daemon/dashboard-session-draft-contract";
import type { SessionResource } from "@harryaskham/pi-daemon/session-api";
import {
  defaultSessionDraftForm,
  draftIdForLocalTarget,
  draftIdFromTarget,
  draftLiveTargetId,
  draftTargetId,
  materializedDraftSession,
  validateSessionDraftForm,
} from "../session-draft";

describe("new session draft frontend model", () => {
  it("defaults to no tools, denied discovery, persistent storage and no runtime side effects", () => {
    const form = defaultSessionDraftForm("/work/project");
    expect(validateSessionDraftForm(form)).toEqual({
      spec: {
        cwd: "/work/project",
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
      errors: {},
    });
  });

  it("rejects relative cwd, split model identity and unsafe or empty allowlists", () => {
    const form = {
      ...defaultSessionDraftForm("relative/path"),
      provider: "fixture",
      toolsMode: "allowlist" as const,
      toolNames: "bad tool",
    };
    expect(validateSessionDraftForm(form).errors).toMatchObject({
      cwd: expect.any(String),
      model: expect.any(String),
      tools: expect.any(String),
    });
  });

  it("keeps local, persisted and live target identities deterministic", () => {
    expect(draftIdForLocalTarget("draft-local:fixture-01")).toBe("draft-fixture-01");
    expect(draftTargetId("draft-fixture-01")).toBe("draft:draft-fixture-01");
    expect(draftLiveTargetId("draft-fixture-01")).toBe("draft-live:draft-fixture-01");
    expect(draftIdFromTarget("draft-live:draft-fixture-01")).toBe("draft-fixture-01");
  });

  it("projects one materialized draft into a managed live pane without an optimistic message", () => {
    const now = "2026-07-19T14:40:00.000Z";
    const draft: DashboardSessionDraftResource = {
      contractVersion: "1.0",
      draftId: "draft-fixture-01",
      revision: 2,
      state: "live",
      createdAt: now,
      updatedAt: now,
      firstMessageStartsSession: true,
      spec: validateSessionDraftForm(defaultSessionDraftForm("/work/project")).spec!,
      materialization: {
        ticketId: "ticket-fixture-01",
        state: "succeeded",
        session: { sessionId: "session-fixture-01", generation: 1 },
      },
    };
    const resource: SessionResource = {
      sessionId: "session-fixture-01",
      generation: 1,
      revision: 1,
      residency: "resident",
      state: "idle",
      createdAt: now,
      updatedAt: now,
      lastUsedAt: now,
      spec: {
        cwd: "/work/project",
        target: { mode: "new" },
        tools: { mode: "none" },
        isolation: { mode: "unisolated" },
      },
      environment: { keys: [], persistence: "memory-only", provisioned: true },
      links: { self: "/session", rpc: "/rpc", apc: "/apc" },
    };
    expect(materializedDraftSession("draft-live:draft-fixture-01", draft, resource)).toMatchObject({
      inventoryId: "draft-live:draft-fixture-01",
      sessionId: "session-fixture-01",
      messageCount: 0,
      managed: { sessionId: "session-fixture-01", generation: 1 },
      presence: { runtime: "resident-idle", activation: "user-turn" },
    });
  });
});
