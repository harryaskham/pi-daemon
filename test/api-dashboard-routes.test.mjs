import assert from "node:assert/strict";
import test from "node:test";

import { ApiRequestError } from "../dist/api-request-contract.js";
import {
  dashboardPathRef,
  isDashboardRoutePath,
  routeDashboardRequest,
} from "../dist/api-dashboard-routes.js";
import { DashboardNeutralApiError } from "../dist/dashboard-neutral-api.js";
import { dashboardSessionDraftEtag } from "../dist/dashboard-session-draft-contract.js";

function recordingApi(overrides = {}) {
  const calls = [];
  const record = (name, result) => async (...args) => {
    calls.push({ name, args });
    if (result instanceof Error) throw result;
    return result;
  };
  return {
    calls,
    capabilities: record("capabilities", { apiVersion: "dash.v1" }),
    diagnostics: record("diagnostics", { events: [] }),
    listSessions: record("listSessions", { sessions: [] }),
    getSessionInfo: record("getSessionInfo", { inventoryId: "inv-1" }),
    getTranscript: record("getTranscript", { records: [] }),
    activateSession: record("activateSession", { ticketId: "activation-1" }),
    getActivation: record("getActivation", { ticketId: "activation-1" }),
    exportSession: record("exportSession", { ticketId: "export-1" }),
    getExport: record("getExport", { ticketId: "export-1" }),
    renewLease: record("renewLease", { leaseId: "lease-1" }),
    createSessionDraft: record("createSessionDraft", { draftId: "draft-1", revision: 3 }),
    getSessionDraft: record("getSessionDraft", { draftId: "draft-1", revision: 3 }),
    cancelSessionDraft: record("cancelSessionDraft", { draftId: "draft-1", revision: 4 }),
    sendSessionDraft: record("sendSessionDraft", { ticketId: "send-1" }),
    getSessionDraftSend: record("getSessionDraftSend", { ticketId: "send-1" }),
    ...overrides,
  };
}

function routeRequest(method, path, { headers = {}, body } = {}) {
  let reads = 0;
  return {
    request: {
      method,
      url: new URL(`http://127.0.0.1${path}`),
      headers,
      readJson: async () => {
        reads += 1;
        return body;
      },
    },
    reads: () => reads,
  };
}

test("non-dashboard paths are declined so the caller keeps its own routing", async () => {
  const api = recordingApi();
  assert.equal(isDashboardRoutePath("/v1/session"), false);
  assert.equal(isDashboardRoutePath("/v1/dashboard/inventory"), true);
  const { request, reads } = routeRequest("GET", "/v1/session");
  assert.equal(await routeDashboardRequest(api, request), undefined);
  assert.deepEqual(api.calls, []);
  assert.equal(reads(), 0);
});

test("unmatched dashboard method/path pairs decline without reading a body", async () => {
  const api = recordingApi();
  const { request, reads } = routeRequest("PUT", "/v1/dashboard/inventory");
  assert.equal(await routeDashboardRequest(api, request), undefined);
  assert.deepEqual(api.calls, []);
  assert.equal(reads(), 0);
});

test("read routes map path and query onto the neutral API without a body", async () => {
  const api = recordingApi();
  const inventory = await routeDashboardRequest(
    api,
    routeRequest("GET", "/v1/dashboard/inventory?limit=25&unread=true&sourceKind=managed,external").request,
  );
  assert.deepEqual(inventory, { status: 200, data: { sessions: [] } });
  assert.deepEqual(api.calls.at(-1).args[0], {
    limit: 25,
    sourceKinds: ["managed", "external"],
    unread: true,
  });

  const transcript = await routeDashboardRequest(
    api,
    routeRequest(
      "GET",
      "/v1/dashboard/inventory/inv%2F1/transcript?limit=10&direction=older&fingerprint=fp-1",
    ).request,
  );
  assert.equal(transcript.status, 200);
  const [inventoryId, query, fingerprint] = api.calls.at(-1).args;
  assert.equal(inventoryId, "inv/1");
  assert.deepEqual(query, { limit: 10, direction: "older" });
  assert.equal(fingerprint, "fp-1");
});

test("invalid dashboard query parameters fail closed with typed request errors", async () => {
  const api = recordingApi();
  const cases = [
    ["/v1/dashboard/inventory?limit=0", "invalid_dashboard_limit"],
    ["/v1/dashboard/inventory?limit=101", "invalid_dashboard_limit"],
    ["/v1/dashboard/inventory?unread=yes", "invalid_dashboard_filter"],
    ["/v1/dashboard/inventory?sourceKind=", "invalid_dashboard_filter"],
    ["/v1/dashboard/inventory/inv-1/transcript?direction=sideways", "invalid_transcript_query"],
  ];
  for (const [path, code] of cases) {
    await assert.rejects(
      routeDashboardRequest(api, routeRequest("GET", path).request),
      (error) => {
        assert.ok(error instanceof ApiRequestError);
        assert.equal(error.status, 400);
        assert.equal(error.code, code);
        return true;
      },
      path,
    );
  }
  assert.deepEqual(api.calls, []);
});

test("path references are decoded, bounded, and reject embedded separators", () => {
  assert.equal(dashboardPathRef("/v1/dashboard/inventory/inv-1", "/v1/dashboard/inventory/"), "inv-1");
  assert.equal(dashboardPathRef("/v1/dashboard/inventory/a%2Fb", "/v1/dashboard/inventory/"), "a/b");
  assert.equal(dashboardPathRef("/v1/dashboard/inventory/a/b", "/v1/dashboard/inventory/"), undefined);
  assert.equal(dashboardPathRef("/v1/dashboard/inventory/", "/v1/dashboard/inventory/"), undefined);
  assert.equal(dashboardPathRef("/v1/session/x", "/v1/dashboard/inventory/"), undefined);
  assert.throws(
    () => dashboardPathRef("/v1/dashboard/inventory/%E0%A4%A", "/v1/dashboard/inventory/"),
    (error) =>
      error instanceof ApiRequestError &&
      error.status === 400 &&
      error.code === "invalid_dashboard_reference",
  );
  assert.throws(
    () => dashboardPathRef(`/v1/dashboard/inventory/${"a".repeat(257)}`, "/v1/dashboard/inventory/"),
    (error) => error instanceof ApiRequestError && error.code === "invalid_dashboard_reference",
  );
});

test("activation requires a matching request id and idempotency key", async () => {
  const api = recordingApi();
  const body = {
    requestId: "req-1",
    idempotencyKey: "idem-1",
    mode: "fork",
  };
  const accepted = await routeDashboardRequest(
    api,
    routeRequest("POST", "/v1/dashboard/inventory/inv-1/activate", {
      headers: { "x-request-id": "req-1", "idempotency-key": "idem-1" },
      body,
    }).request,
  );
  assert.deepEqual(accepted, {
    status: 202,
    data: { ticketId: "activation-1" },
    headers: { Location: "/v1/dashboard/activation/activation-1" },
    requestId: "req-1",
  });
  assert.deepEqual(api.calls.at(-1).args, ["inv-1", { ...body, mode: "fork" }]);

  await assert.rejects(
    routeDashboardRequest(
      api,
      routeRequest("POST", "/v1/dashboard/inventory/inv-1/activate", {
        headers: { "x-request-id": "other", "idempotency-key": "idem-1" },
        body,
      }).request,
    ),
    (error) => error instanceof ApiRequestError && error.code === "request_id_mismatch",
  );
  await assert.rejects(
    routeDashboardRequest(
      api,
      routeRequest("POST", "/v1/dashboard/inventory/inv-1/activate", {
        headers: { "idempotency-key": "other" },
        body,
      }).request,
    ),
    (error) => error instanceof ApiRequestError && error.code === "idempotency_key_mismatch",
  );
  await assert.rejects(
    routeDashboardRequest(
      api,
      routeRequest("POST", "/v1/dashboard/inventory/inv-1/activate", { body }).request,
    ),
    (error) => error instanceof ApiRequestError && error.code === "idempotency_key_required",
  );
  await assert.rejects(
    routeDashboardRequest(
      api,
      routeRequest("POST", "/v1/dashboard/inventory/inv-1/activate", {
        headers: { "idempotency-key": "idem-1" },
        body: { ...body, mode: "co-opt" },
      }).request,
    ),
    (error) => error instanceof ApiRequestError && error.code === "invalid_activation_mode",
  );
});

test("export accepts both durable modes and rejects a non-boolean release flag", async () => {
  const api = recordingApi();
  const headers = { "idempotency-key": "idem-2" };
  for (const mode of ["as-new", "append-to-origin"]) {
    const result = await routeDashboardRequest(
      api,
      routeRequest("POST", "/v1/dashboard/session/sess-1/export", {
        headers,
        body: { requestId: "req-2", idempotencyKey: "idem-2", mode, releaseAfterExport: true },
      }).request,
    );
    assert.equal(result.status, 202);
    assert.equal(result.headers.Location, "/v1/dashboard/export/export-1");
  }
  await assert.rejects(
    routeDashboardRequest(
      api,
      routeRequest("POST", "/v1/dashboard/session/sess-1/export", {
        headers,
        body: { requestId: "req-2", idempotencyKey: "idem-2", mode: "as-new", releaseAfterExport: "yes" },
      }).request,
    ),
    (error) => error instanceof ApiRequestError && error.code === "invalid_export_request",
  );
});

test("draft mutations enforce the current revision through If-Match", async () => {
  const api = recordingApi();
  const headers = {
    "x-request-id": "req-3",
    "idempotency-key": "idem-3",
    "if-match": dashboardSessionDraftEtag("draft-1", 3),
  };
  const body = { requestId: "req-3", idempotencyKey: "idem-3", expectedRevision: 3 };
  const cancelled = await routeDashboardRequest(
    api,
    routeRequest("DELETE", "/v1/dashboard/session-drafts/draft-1", { headers, body }).request,
  );
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.headers.ETag, dashboardSessionDraftEtag("draft-1", 4));

  await assert.rejects(
    routeDashboardRequest(
      api,
      routeRequest("DELETE", "/v1/dashboard/session-drafts/draft-1", {
        headers: { ...headers, "if-match": dashboardSessionDraftEtag("draft-1", 2) },
        body,
      }).request,
    ),
    (error) => {
      assert.ok(error instanceof ApiRequestError);
      assert.equal(error.status, 412);
      assert.equal(error.code, "draft_revision_conflict");
      return true;
    },
  );
});

test("neutral API failures are normalized into typed request errors", async () => {
  const api = recordingApi({
    getSessionInfo: async () => {
      throw new DashboardNeutralApiError(409, "source_fingerprint_changed", "changed", true);
    },
  });
  await assert.rejects(
    routeDashboardRequest(api, routeRequest("GET", "/v1/dashboard/inventory/inv-1").request),
    (error) => {
      assert.ok(error instanceof ApiRequestError);
      assert.equal(error.status, 409);
      assert.equal(error.code, "source_fingerprint_changed");
      assert.equal(error.retryable, true);
      return true;
    },
  );
});
