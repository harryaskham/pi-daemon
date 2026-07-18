import assert from "node:assert/strict";
import test from "node:test";

import { DASH_DEFAULT_LIMITS } from "../dist/dashboard-contract.js";
import {
  DashboardNeutralApiController,
  DashboardNeutralApiError,
  normalizeDashboardNeutralError,
} from "../dist/dashboard-neutral-api.js";
import { SessionOwnershipError } from "../dist/session-ownership.js";
import { TranscriptProjectionError } from "../dist/transcript-projector.js";

const inventoryRecord = {
  inventoryId: "inventory-one",
  sourceKind: "external",
  title: "Fixture",
  createdAt: "2026-07-18T12:00:00.000Z",
  modifiedAt: "2026-07-18T12:00:00.000Z",
  messageCount: 1,
  activation: { eligible: true, modes: ["fork"] },
  presence: {
    runtime: "unmanaged",
    activation: "untouched",
    focusedPaneCount: 0,
    unread: false,
  },
};

function harness(overrides = {}) {
  const calls = [];
  const info = {
    ...inventoryRecord,
    cwd: "/work/project",
    source: {
      canonicalPath: "/sessions/one.jsonl",
      fingerprint: {
        value: "sha256:one",
        sizeBytes: 100,
        modifiedAt: "2026-07-18T12:00:00.000Z",
      },
      aliases: [],
    },
    ownership: { mode: "none" },
    diagnostics: [],
  };
  const inventory = {
    async list(query) {
      calls.push(["list", query]);
      return {
        sessions: [inventoryRecord],
        index: {
          formatVersion: 1,
          loadedAt: "2026-07-18T12:00:00.000Z",
          stale: false,
          reconciling: false,
        },
      };
    },
    async getInfo(id) {
      calls.push(["info", id]);
      return id === "inventory-one" ? info : undefined;
    },
  };
  const projector = {
    async project(request) {
      calls.push(["project", request]);
      return {
        inventoryId: request.inventoryId,
        sourceFingerprint: request.expectedFingerprint,
        records: [],
        order: "chronological",
        projection: {
          formatVersion: 1,
          cached: false,
          truncated: false,
          builtAt: "2026-07-18T12:00:00.000Z",
        },
        hydration: "not-requested",
      };
    },
  };
  const ownership = {
    async activateSession(id, request) {
      calls.push(["activate", id, request]);
      return { ticketId: "activation" };
    },
    async getActivation(id) {
      calls.push(["activation", id]);
      return { ticketId: id };
    },
    async exportSession(id, request) {
      calls.push(["export", id, request]);
      return { ticketId: "export" };
    },
    async getExport(id) {
      calls.push(["export-ticket", id]);
      return { ticketId: id };
    },
    async renewLease(sessionRef, leaseId) {
      calls.push(["lease", sessionRef, leaseId]);
      return {
        managedSessionId: sessionRef,
        inventoryId: "inventory-one",
        mode: "direct",
        status: "active",
        lease: { leaseId, expiresAt: "2026-07-18T13:00:00.000Z" },
        exportedInventoryIds: [],
      };
    },
  };
  const controller = new DashboardNeutralApiController({
    inventory,
    projector,
    ownership,
    ...overrides,
  });
  return { calls, controller, info };
}

test("negotiates neutral service resources and capability-gated TUI", async () => {
  const { controller } = harness({
    tuiAvailable: false,
    tuiUnavailableReason: "view-seam-required",
    limits: { maxIndexedSessions: 321 },
  });
  const capabilities = await controller.capabilities();
  assert.equal(capabilities.authentication, "service-bearer");
  assert.equal(capabilities.resources.ownership, true);
  assert.equal(capabilities.presentations.rich.available, true);
  assert.deepEqual(capabilities.presentations.tui, {
    available: false,
    subprotocol: "pi-daemon-tui.v1",
    unavailableReason: "view-seam-required",
  });
  assert.equal(capabilities.limits.maxIndexedSessions, 321);
  assert.equal(capabilities.limits.maxInventoryPageItems, DASH_DEFAULT_LIMITS.maxInventoryPageItems);
});

test("projects only the authenticated inventory source and exact fingerprint", async () => {
  const { calls, controller } = harness();
  const page = await controller.getTranscript(
    "inventory-one",
    { limit: 25 },
    "sha256:one",
  );
  assert.equal(page.hydration, "not-requested");
  assert.deepEqual(calls.at(-1), [
    "project",
    {
      inventoryId: "inventory-one",
      path: "/sessions/one.jsonl",
      query: { limit: 25 },
      expectedFingerprint: "sha256:one",
    },
  ]);
  await assert.rejects(
    controller.getTranscript("inventory-one", {}, "sha256:stale"),
    (error) => error instanceof DashboardNeutralApiError && error.code === "source_fingerprint_changed",
  );
  await assert.rejects(
    controller.getSessionInfo("missing"),
    (error) => error instanceof DashboardNeutralApiError && error.status === 404,
  );
});

test("delegates ownership tickets and returns a safe lease resource", async () => {
  const { calls, controller } = harness();
  const activation = { requestId: "a", idempotencyKey: "ak", mode: "fork" };
  assert.deepEqual(await controller.activateSession("inventory-one", activation), {
    ticketId: "activation",
  });
  const exporting = { requestId: "e", idempotencyKey: "ek", mode: "as-new" };
  assert.deepEqual(await controller.exportSession("managed-one", exporting), {
    ticketId: "export",
  });
  assert.deepEqual(await controller.renewLease("managed-one", "lease-one"), {
    sessionRef: "managed-one",
    leaseId: "lease-one",
    expiresAt: "2026-07-18T13:00:00.000Z",
    ownership: {
      mode: "direct",
      leaseId: "lease-one",
      sourceInventoryId: "inventory-one",
      exportedInventoryIds: [],
    },
  });
  assert.equal(calls.some(([kind]) => kind === "activate"), true);
  assert.equal(calls.some(([kind]) => kind === "export"), true);
});

test("maps projection and ownership failures to bounded HTTP classes", () => {
  assert.deepEqual(
    normalizeDashboardNeutralError(
      new TranscriptProjectionError("source_fingerprint_changed", "changed", true),
    ),
    new DashboardNeutralApiError(409, "source_fingerprint_changed", "changed", true),
  );
  const busy = normalizeDashboardNeutralError(
    new SessionOwnershipError("controller_active", "busy", true),
  );
  assert.equal(busy.status, 409);
  assert.equal(busy.retryable, true);
  const unknown = normalizeDashboardNeutralError(new Error("private path /secret"));
  assert.equal(unknown.status, 500);
  assert.equal(unknown.message.includes("secret"), false);
});
