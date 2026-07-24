import assert from "node:assert/strict";
import test from "node:test";

import {
  DASHBOARD_DIAGNOSTICS_MAX_EVENTS,
  DashboardDiagnosticsService,
} from "../dist/dashboard-diagnostics.js";

function config(overrides = {}) {
  return {
    instance: "daemon-main",
    path: "/private/config.json",
    explicitPath: true,
    present: true,
    config: {
      web: {
        sessionDefaults: { cwd: "~", inheritRuntimePolicy: true },
        runtimePolicy: {
          tools: { mode: "default" },
          resources: { inheritInstalledPackages: true },
        },
      },
      ...overrides,
    },
    resolvePath(value) { return value; },
  };
}

test("diagnostics expose bounded policy status and normalized request failures only", () => {
  let tick = 0;
  const diagnostics = new DashboardDiagnosticsService({
    loadedConfig: config(),
    allowedRootCount: 2,
    maxEvents: 4,
    now: () => new Date(1_700_000_000_000 + tick++ * 1_000),
  });
  diagnostics.recordApiFailure({
    method: "POST",
    path: "/v1/dashboard/session-drafts/credential-like-secret/send",
    status: 422,
    code: "draft_cwd_not_allowed",
  });
  diagnostics.recordApiFailure({
    method: "GET",
    path: "/v1/dashboard/inventory/private-session-name/transcript",
    status: 500,
    code: "unsafe CODE with raw data",
  });
  diagnostics.recordApiFailure({
    method: "DELETE",
    path: "/dash/v1/session-drafts/private-browser-id",
    status: 409,
    code: "draft_authority_denied",
  });
  diagnostics.recordApiFailure({
    method: "GET",
    path: "/v1/session/not-dashboard",
    status: 500,
    code: "ignored",
  });

  const snapshot = diagnostics.snapshot();
  assert.deepEqual(snapshot.status, {
    instance: "daemon-main",
    configLoaded: true,
    webConfigured: true,
    sessionDefaultsConfigured: true,
    runtimePolicyConfigured: true,
    installedPackagesConfigured: true,
    allowedRootCount: 2,
  });
  assert.equal(snapshot.limits.rawLogsExposed, false);
  assert.equal(snapshot.events.length, 4);
  assert.equal(snapshot.events[1].route, "POST /v1/dashboard/session-drafts/:id/send");
  assert.equal(snapshot.events[1].message.includes("credential"), false);
  assert.equal(snapshot.events[2].route, "GET /v1/dashboard/inventory/:id/transcript");
  assert.equal(snapshot.events[2].code, "dashboard_error");
  assert.equal(snapshot.events[3].route, "DELETE /dash/v1/session-drafts/:id");
  const serialized = JSON.stringify(snapshot);
  assert.equal(serialized.includes("credential-like-secret"), false);
  assert.equal(serialized.includes("private-session-name"), false);
  assert.equal(serialized.includes("/private/config.json"), false);
});

test("diagnostic event ring remains bounded and ignores its own read endpoint", () => {
  const diagnostics = new DashboardDiagnosticsService({
    loadedConfig: config({ web: undefined }),
    allowedRootCount: 1,
  });
  for (let index = 0; index < DASHBOARD_DIAGNOSTICS_MAX_EVENTS + 20; index += 1) {
    diagnostics.recordApiFailure({
      method: "POST",
      path: "/v1/dashboard/session-drafts",
      status: 400,
      code: "invalid_session_draft",
    });
  }
  diagnostics.recordApiFailure({
    method: "GET",
    path: "/v1/dashboard/diagnostics",
    status: 500,
    code: "diagnostics_failure",
  });
  const snapshot = diagnostics.snapshot();
  assert.equal(snapshot.events.length, DASHBOARD_DIAGNOSTICS_MAX_EVENTS);
  assert.equal(snapshot.events.some((event) => event.code === "diagnostics_failure"), false);
  assert.equal(snapshot.status.webConfigured, false);
  assert.equal(snapshot.status.runtimePolicyConfigured, false);
});
