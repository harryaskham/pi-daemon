import type { DashboardSettingsResource, DashboardWorkspaceResource } from "@harryaskham/pi-daemon/dashboard-contract";
import { describe, expect, it } from "vitest";
import { INITIAL_LAYOUT, toDashboardLayout } from "../layout";
import { DashboardRevisionConflict, LocalDashboardPreferencesBackend } from "../preferences-backend";

function resources() {
  const workspace: DashboardWorkspaceResource = {
    workspaceId: "workspace-test",
    revision: 2,
    createdAt: "2026-07-18T12:00:00.000Z",
    updatedAt: "2026-07-18T12:00:00.000Z",
    selectedPaneId: "primary",
    layout: toDashboardLayout(INITIAL_LAYOUT),
    seenCursors: {},
  };
  const settings: DashboardSettingsResource = {
    revision: 4,
    effective: {
      theme: { name: "nord-midnight", density: "comfortable" },
      editor: { mode: "vim" },
      sidebar: { initialLimit: 100, showProject: true, groupBy: "none" },
      transcript: { expandTools: false, expandThinking: false },
      motion: { reduced: false },
      cache: { transcriptBytes: 8_000_000, transcriptEntries: 32 },
    },
    runtimeOverlay: {},
    sources: { "theme.name": "config", "editor.mode": "config" },
  };
  return { workspace, settings };
}

describe("revisioned dashboard preferences backend", () => {
  it("persists workspace revisions and joins exact idempotent retries", async () => {
    const { workspace, settings } = resources();
    const backend = new LocalDashboardPreferencesBackend(workspace, settings);
    const request = {
      requestId: "request-workspace-1",
      idempotencyKey: "workspace-save-1",
      expectedRevision: 2,
      selectedPaneId: "inspector",
      layout: workspace.layout,
      seenCursors: {},
    };
    const saved = await backend.updateWorkspace(request);
    expect(saved).toMatchObject({ revision: 3, selectedPaneId: "inspector" });
    expect(await backend.updateWorkspace(request)).toEqual(saved);
    await expect(backend.updateWorkspace({ ...request, requestId: "request-2", idempotencyKey: "stale", expectedRevision: 2 })).rejects.toBeInstanceOf(DashboardRevisionConflict);
  });

  it("patches only UI settings, reports runtime sources and resets to config", async () => {
    const { workspace, settings } = resources();
    const backend = new LocalDashboardPreferencesBackend(workspace, settings);
    const patched = await backend.patchSettings({
      requestId: "request-settings-1",
      idempotencyKey: "settings-patch-1",
      expectedRevision: 4,
      patch: {
        theme: { name: "nord-frost", density: "compact" },
        editor: { mode: "multiline" },
        motion: { reduced: true },
      },
    });
    expect(patched.effective).toMatchObject({
      theme: { name: "nord-frost", density: "compact" },
      editor: { mode: "multiline" },
      motion: { reduced: true },
    });
    expect(patched.sources["theme.name"]).toBe("runtime");
    const reset = await backend.resetSettings(patched.revision);
    expect(reset.effective).toEqual(settings.effective);
    expect(reset.runtimeOverlay).toEqual({});
    expect(reset.sources).toEqual(settings.sources);
  });

  it("rejects stale settings revisions without mutating state", async () => {
    const { workspace, settings } = resources();
    const backend = new LocalDashboardPreferencesBackend(workspace, settings);
    await expect(backend.patchSettings({
      requestId: "request-stale",
      idempotencyKey: "settings-stale",
      expectedRevision: 3,
      patch: { motion: { reduced: true } },
    })).rejects.toBeInstanceOf(DashboardRevisionConflict);
    expect(await backend.getSettings()).toEqual(settings);
  });
});
