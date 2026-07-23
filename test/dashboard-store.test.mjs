import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  DashboardSettingsStore,
  DashboardStoreError,
  DashboardWorkspaceStore,
  settingsEtag,
  workspaceEtag,
} from "../dist/dashboard-store.js";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "pi-daemon-web-store-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const stateDir = join(root, "state");
  return { root, stateDir };
}

function workspaceUpdate(resource, overrides = {}) {
  return {
    requestId: "request-workspace-01",
    idempotencyKey: "idempotency-workspace-01",
    expectedRevision: resource.revision,
    selectedPaneId: "pane-main",
    layout: {
      type: "leaf",
      paneId: "pane-main",
      content: { type: "chat", inventoryId: "inventory-01", presentation: "rich" },
    },
    seenCursors: { "inventory-01": "cursor-01" },
    ...overrides,
  };
}

test("workspace store atomically persists revisions, strong ETags and retained idempotency", async (t) => {
  const { stateDir } = await fixture(t);
  let now = new Date("2026-07-18T12:00:00.000Z");
  const store = new DashboardWorkspaceStore({ stateDir, now: () => now });
  const initial = await store.getOrCreate("workspace-01");
  assert.equal(initial.revision, 0);
  assert.equal(initial.layout.type, "leaf");
  assert.equal(initial.selectedPaneId, "pane-main");
  assert.equal(workspaceEtag(initial), '"workspace:workspace-01:0"');

  now = new Date("2026-07-18T12:00:01.000Z");
  const request = workspaceUpdate(initial);
  const updated = await store.update("workspace-01", request, workspaceEtag(initial));
  assert.equal(updated.revision, 1);
  assert.equal(updated.updatedAt, now.toISOString());
  assert.deepEqual(updated.seenCursors, { "inventory-01": "cursor-01" });
  assert.deepEqual(
    await store.update("workspace-01", request, workspaceEtag(initial)),
    updated,
  );
  await assert.rejects(
    store.update(
      "workspace-01",
      { ...request, layout: { type: "leaf", paneId: "pane-other" }, selectedPaneId: "pane-other" },
      workspaceEtag(initial),
    ),
    (error) => error instanceof DashboardStoreError && error.code === "idempotency_conflict",
  );
  await assert.rejects(
    store.update(
      "workspace-01",
      workspaceUpdate(updated, { idempotencyKey: "idempotency-workspace-02" }),
      workspaceEtag(initial),
    ),
    (error) => error instanceof DashboardStoreError && error.code === "revision_conflict",
  );

  const file = join(stateDir, "web", "workspaces", "workspace-01.json");
  assert.equal((await stat(join(stateDir, "web"))).mode & 0o777, 0o700);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.doesNotMatch(await readFile(file, "utf8"), /credential|authorization|cookie/i);
  const restarted = new DashboardWorkspaceStore({ stateDir });
  assert.deepEqual(await restarted.getOrCreate("workspace-01"), updated);
});

test("workspace validation rejects ambiguous trees and enforces count/depth/bytes", async (t) => {
  const { stateDir } = await fixture(t);
  const store = new DashboardWorkspaceStore({
    stateDir,
    limits: { maxWorkspacePanes: 2, maxLayoutDepth: 2, maxWorkspaceBytes: 2048, maxWorkspaces: 1 },
  });
  const initial = await store.getOrCreate("workspace-01");
  const duplicate = {
    type: "split",
    direction: "horizontal",
    ratio: 0.5,
    first: { type: "leaf", paneId: "pane-same" },
    second: { type: "leaf", paneId: "pane-same" },
  };
  await assert.rejects(
    store.update(
      "workspace-01",
      workspaceUpdate(initial, {
        idempotencyKey: "idempotency-duplicate",
        selectedPaneId: "pane-same",
        layout: duplicate,
      }),
      workspaceEtag(initial),
    ),
    (error) => error instanceof DashboardStoreError && error.code === "invalid_request",
  );
  const deep = {
    type: "split",
    direction: "vertical",
    ratio: 0.5,
    first: { type: "leaf", paneId: "pane-one" },
    second: {
      type: "split",
      direction: "horizontal",
      ratio: 0.5,
      first: { type: "leaf", paneId: "pane-two" },
      second: { type: "leaf", paneId: "pane-three" },
    },
  };
  await assert.rejects(
    store.update(
      "workspace-01",
      workspaceUpdate(initial, {
        idempotencyKey: "idempotency-deep",
        selectedPaneId: "pane-one",
        layout: deep,
      }),
      workspaceEtag(initial),
    ),
    (error) => error instanceof DashboardStoreError && error.code === "invalid_request",
  );
  await assert.rejects(
    store.update(
      "workspace-01",
      workspaceUpdate(initial, {
        idempotencyKey: "idempotency-selected",
        selectedPaneId: "missing-pane",
      }),
      workspaceEtag(initial),
    ),
    /selected pane/,
  );
  await assert.rejects(
    store.getOrCreate("workspace-02"),
    (error) => error instanceof DashboardStoreError && error.code === "workspace_capacity",
  );
  await assert.rejects(
    store.update(
      "workspace-02",
      workspaceUpdate(initial, { idempotencyKey: "idempotency-capacity" }),
      '"workspace:workspace-02:0"',
    ),
    (error) => error instanceof DashboardStoreError && error.code === "workspace_capacity",
  );
});

test("workspace corruption is quarantined while insecure state fails closed", async (t) => {
  const { stateDir } = await fixture(t);
  const store = new DashboardWorkspaceStore({ stateDir });
  await store.getOrCreate("workspace-corrupt");
  const directory = join(stateDir, "web", "workspaces");
  const path = join(directory, "workspace-corrupt.json");
  await writeFile(path, "{broken", { mode: 0o600 });
  const recovered = await store.getOrCreate("workspace-corrupt");
  assert.equal(recovered.revision, 0);
  assert.equal((await readdir(directory)).some((name) => name.includes(".corrupt-")), true);

  await chmod(path, 0o666);
  await assert.rejects(store.getOrCreate("workspace-corrupt"), /owner-only/);
  await rm(path);
  const target = join(directory, "target.json");
  await writeFile(target, "{}", { mode: 0o600 });
  await symlink(target, path);
  await assert.rejects(store.getOrCreate("workspace-corrupt"), /symbolic links/);
});

test("settings overlay is strictly UI-only with configured/runtime source reporting and reset", async (t) => {
  const { stateDir } = await fixture(t);
  const store = new DashboardSettingsStore({
    stateDir,
    configuredUi: {
      theme: { name: "nord-midnight", density: "compact" },
      sidebar: { showProject: false },
    },
  });
  const initial = await store.get();
  assert.equal(initial.revision, 0);
  assert.equal(initial.effective.theme.density, "compact");
  assert.equal(initial.effective.sidebar.showProject, false);
  assert.equal(initial.sources["theme.density"], "config");
  assert.equal(initial.sources["editor.mode"], "default");
  assert.equal(initial.effective.editor.submitKey, "enter");
  assert.equal(initial.sources["editor.submitKey"], "default");

  const request = {
    requestId: "request-settings-01",
    idempotencyKey: "idempotency-settings-01",
    expectedRevision: 0,
    patch: {
      editor: { mode: "vim", submitKey: "mod-enter" },
      motion: { reduced: true },
      cache: { transcriptEntries: 8 },
    },
  };
  const updated = await store.patch(request, settingsEtag(initial));
  assert.equal(updated.revision, 1);
  assert.equal(updated.effective.editor.mode, "vim");
  assert.equal(updated.effective.editor.submitKey, "mod-enter");
  assert.equal(updated.effective.motion.reduced, true);
  assert.equal(updated.effective.theme.density, "compact");
  assert.equal(updated.sources["editor.mode"], "runtime");
  assert.equal(updated.sources["editor.submitKey"], "runtime");
  assert.deepEqual(await store.patch(request, settingsEtag(initial)), updated);

  await assert.rejects(
    store.patch(
      {
        ...request,
        idempotencyKey: "idempotency-unsafe",
        expectedRevision: 1,
        patch: { bind: "0.0.0.0" },
      },
      settingsEtag(updated),
    ),
    (error) => error instanceof DashboardStoreError && error.code === "invalid_request",
  );
  await assert.rejects(
    store.patch(
      {
        ...request,
        idempotencyKey: "idempotency-cache",
        expectedRevision: 1,
        patch: { cache: { transcriptBytes: Number.MAX_SAFE_INTEGER } },
      },
      settingsEtag(updated),
    ),
    (error) => error instanceof DashboardStoreError && error.code === "invalid_settings",
  );

  const reset = await store.reset({
    expectedRevision: 1,
    idempotencyKey: "idempotency-reset-01",
    ifMatch: settingsEtag(updated),
  });
  assert.equal(reset.revision, 2);
  assert.deepEqual(reset.runtimeOverlay, {});
  assert.equal(reset.effective.editor.mode, "multiline");
  assert.equal(reset.effective.editor.submitKey, "enter");
  assert.equal(reset.effective.theme.density, "compact");
  assert.equal(reset.sources["editor.mode"], "default");
  assert.equal(reset.sources["theme.density"], "config");

  const restarted = new DashboardSettingsStore({
    stateDir,
    configuredUi: { theme: { density: "compact" } },
  });
  const restartedResource = await restarted.get();
  assert.equal(restartedResource.revision, reset.revision);
  assert.deepEqual(restartedResource.runtimeOverlay, {});
  assert.equal(restartedResource.effective.theme.density, "compact");
  assert.equal(restartedResource.sources["theme.density"], "config");
});

test("settings corruption recovers to configured defaults but permissive files fail closed", async (t) => {
  const { stateDir } = await fixture(t);
  const store = new DashboardSettingsStore({ stateDir, configuredUi: { editor: { mode: "vim" } } });
  const initial = await store.get();
  const updated = await store.patch(
    {
      requestId: "request-settings",
      idempotencyKey: "idempotency-settings",
      expectedRevision: initial.revision,
      patch: { motion: { reduced: true } },
    },
    settingsEtag(initial),
  );
  assert.equal(updated.revision, 1);
  await writeFile(store.settingsPath, "not-json", { mode: 0o600 });
  const recovered = await store.get();
  assert.equal(recovered.revision, 0);
  assert.equal(recovered.effective.editor.mode, "vim");
  assert.deepEqual(recovered.runtimeOverlay, {});
  assert.equal((await readdir(join(stateDir, "web"))).some((name) => name.includes(".corrupt-")), true);

  await writeFile(store.settingsPath, JSON.stringify({}), { mode: 0o600 });
  await chmod(store.settingsPath, 0o644);
  await assert.rejects(store.get(), /owner-only/);
});
