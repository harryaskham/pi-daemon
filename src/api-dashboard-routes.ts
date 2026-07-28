import type { IncomingHttpHeaders, IncomingMessage } from "node:http";

import {
  asDashboardCursor,
  asDashboardFingerprint,
  type ActivationRequest,
  type DashboardLeaseRequest,
  type SessionExportRequest,
  type SessionInventoryQuery,
  type TranscriptQuery,
} from "./dashboard-contract.js";
import { dashboardSessionDraftEtag } from "./dashboard-session-draft-contract.js";
import {
  validateDashboardSessionDraftCancelRequest,
  validateDashboardSessionDraftCreateRequest,
  validateDashboardSessionDraftSendRequest,
} from "./dashboard-session-drafts.js";
import {
  normalizeDashboardNeutralError,
  type DashboardNeutralApi,
} from "./dashboard-neutral-api.js";
import {
  ApiRequestError,
  apiRecord,
  apiString,
  assertMatchingRequestId,
} from "./api-request-contract.js";

/**
 * Neutral Dashboard HTTP route parsing and dispatch (bd-23110a).
 *
 * `api-server.ts` keeps sole ownership of service-bearer admission,
 * bounded bodies and responses, the shared response envelope, and WebSocket
 * upgrades. This module only decides which authenticated `/v1/dashboard/*`
 * resource a request names, validates its parameters, and calls the neutral
 * API. It never authenticates, never writes to the socket, and never reads an
 * unbounded body: the caller supplies an already-bounded JSON reader.
 *
 * Route matching returns `undefined` for a non-dashboard path so the caller can
 * continue its own routing, exactly as the inlined implementation did.
 */

/** Result of a matched Dashboard route, shaped by the caller into an envelope. */
export interface DashboardRouteResult {
  readonly status: number;
  readonly data: unknown;
  readonly headers?: Record<string, string>;
  /** Response request id override taken from a validated mutation body. */
  readonly requestId?: string;
}

/** Caller-supplied request view; `readJson` must already be byte-bounded. */
export interface DashboardRouteRequest {
  readonly method: string | undefined;
  readonly url: URL;
  readonly headers: IncomingHttpHeaders;
  readJson(): Promise<unknown>;
}

/** True when the path names a neutral Dashboard resource at all. */
export function isDashboardRoutePath(pathname: string): boolean {
  return pathname.startsWith("/v1/dashboard/");
}

/**
 * Route one authenticated Dashboard request.
 *
 * Returns `undefined` when the path/method pair is not a Dashboard route, so
 * the caller falls through to its remaining routes. Neutral API failures are
 * normalized into `ApiRequestError` so the caller's single error envelope stays
 * the only place that renders failures.
 */
export async function routeDashboardRequest(
  api: DashboardNeutralApi,
  request: DashboardRouteRequest,
): Promise<DashboardRouteResult | undefined> {
  const { method, url, headers } = request;
  if (!isDashboardRoutePath(url.pathname)) return undefined;
  try {
    if (method === "GET") {
      if (url.pathname === "/v1/dashboard/capabilities") {
        return { status: 200, data: await api.capabilities() };
      }
      if (url.pathname === "/v1/dashboard/diagnostics") {
        return { status: 200, data: await api.diagnostics() };
      }
      if (url.pathname === "/v1/dashboard/inventory") {
        return { status: 200, data: await api.listSessions(dashboardInventoryQuery(url)) };
      }
      const transcriptRef = dashboardPathRef(url.pathname, "/v1/dashboard/inventory/", "/transcript");
      if (transcriptRef !== undefined) {
        const query = dashboardTranscriptQuery(url);
        const fingerprint = optionalFingerprint(url.searchParams.get("fingerprint"));
        return { status: 200, data: await api.getTranscript(transcriptRef, query, fingerprint) };
      }
      const inventoryRef = dashboardPathRef(url.pathname, "/v1/dashboard/inventory/");
      if (inventoryRef !== undefined) {
        return { status: 200, data: await api.getSessionInfo(inventoryRef) };
      }
      const activationTicket = dashboardPathRef(url.pathname, "/v1/dashboard/activation/");
      if (activationTicket !== undefined) {
        return { status: 200, data: await api.getActivation(activationTicket) };
      }
      const exportTicket = dashboardPathRef(url.pathname, "/v1/dashboard/export/");
      if (exportTicket !== undefined) {
        return { status: 200, data: await api.getExport(exportTicket) };
      }
      const draftSendTicket = dashboardPathRef(url.pathname, "/v1/dashboard/session-draft-send/");
      if (draftSendTicket !== undefined) {
        return { status: 200, data: await api.getSessionDraftSend(draftSendTicket) };
      }
      const draftRef = dashboardPathRef(url.pathname, "/v1/dashboard/session-drafts/");
      if (draftRef !== undefined) {
        return { status: 200, data: await api.getSessionDraft(draftRef) };
      }
    }

    if (method === "POST") {
      if (url.pathname === "/v1/dashboard/session-drafts") {
        const body = validateDashboardSessionDraftCreateRequest(await request.readJson());
        assertMatchingRequestId(headers["x-request-id"], body.requestId);
        assertDashboardIdempotency(headers, body.idempotencyKey);
        const draft = await api.createSessionDraft(body);
        return {
          status: 201,
          data: draft,
          headers: {
            Location: `/v1/dashboard/session-drafts/${encodeURIComponent(draft.draftId)}`,
            ETag: dashboardSessionDraftEtag(draft.draftId, draft.revision),
          },
          requestId: body.requestId,
        };
      }
      const draftSendRef = dashboardPathRef(url.pathname, "/v1/dashboard/session-drafts/", "/send");
      if (draftSendRef !== undefined) {
        const body = validateDashboardSessionDraftSendRequest(await request.readJson());
        assertMatchingRequestId(headers["x-request-id"], body.requestId);
        assertDashboardIdempotency(headers, body.idempotencyKey);
        assertDashboardDraftIfMatch(headers["if-match"], draftSendRef, body.expectedRevision);
        const ticket = await api.sendSessionDraft(draftSendRef, body);
        return {
          status: 202,
          data: ticket,
          headers: {
            Location: `/v1/dashboard/session-draft-send/${encodeURIComponent(ticket.ticketId)}`,
          },
          requestId: body.requestId,
        };
      }
      const activateRef = dashboardPathRef(url.pathname, "/v1/dashboard/inventory/", "/activate");
      if (activateRef !== undefined) {
        const body = parseDashboardActivation(await request.readJson());
        assertMatchingRequestId(headers["x-request-id"], body.requestId);
        assertDashboardIdempotency(headers, body.idempotencyKey);
        const ticket = await api.activateSession(activateRef, body);
        return {
          status: 202,
          data: ticket,
          headers: { Location: `/v1/dashboard/activation/${encodeURIComponent(ticket.ticketId)}` },
          requestId: body.requestId,
        };
      }
      const exportRef = dashboardPathRef(url.pathname, "/v1/dashboard/session/", "/export");
      if (exportRef !== undefined) {
        const body = parseDashboardExport(await request.readJson());
        assertMatchingRequestId(headers["x-request-id"], body.requestId);
        assertDashboardIdempotency(headers, body.idempotencyKey);
        const ticket = await api.exportSession(exportRef, body);
        return {
          status: 202,
          data: ticket,
          headers: { Location: `/v1/dashboard/export/${encodeURIComponent(ticket.ticketId)}` },
          requestId: body.requestId,
        };
      }
      const leaseRef = dashboardPathRef(url.pathname, "/v1/dashboard/session/", "/lease");
      if (leaseRef !== undefined) {
        const body = parseDashboardLease(await request.readJson());
        assertMatchingRequestId(headers["x-request-id"], body.requestId);
        return {
          status: 200,
          data: await api.renewLease(leaseRef, body.leaseId),
          headers: {},
          requestId: body.requestId,
        };
      }
    }

    if (method === "DELETE") {
      const draftRef = dashboardPathRef(url.pathname, "/v1/dashboard/session-drafts/");
      if (draftRef !== undefined) {
        const body = validateDashboardSessionDraftCancelRequest(await request.readJson());
        assertMatchingRequestId(headers["x-request-id"], body.requestId);
        assertDashboardIdempotency(headers, body.idempotencyKey);
        assertDashboardDraftIfMatch(headers["if-match"], draftRef, body.expectedRevision);
        const draft = await api.cancelSessionDraft(draftRef, body);
        return {
          status: 200,
          data: draft,
          headers: { ETag: dashboardSessionDraftEtag(draft.draftId, draft.revision) },
          requestId: body.requestId,
        };
      }
    }

    return undefined;
  } catch (error) {
    if (error instanceof ApiRequestError) throw error;
    const normalized = normalizeDashboardNeutralError(error);
    throw new ApiRequestError(
      normalized.status,
      normalized.code,
      normalized.message,
      normalized.retryable,
    );
  }
}

/** Convenience adapter for callers holding a raw Node request. */
export function dashboardRouteRequest(
  request: IncomingMessage,
  url: URL,
  readJson: () => Promise<unknown>,
): DashboardRouteRequest {
  return { method: request.method, url, headers: request.headers, readJson };
}

export function dashboardPathRef(
  pathname: string,
  prefix: string,
  suffix = "",
): string | undefined {
  if (!pathname.startsWith(prefix) || (suffix !== "" && !pathname.endsWith(suffix))) {
    return undefined;
  }
  const end = suffix === "" ? pathname.length : pathname.length - suffix.length;
  const encoded = pathname.slice(prefix.length, end);
  if (encoded.length === 0 || encoded.includes("/")) return undefined;
  try {
    const value = decodeURIComponent(encoded);
    if (value.length === 0 || value.length > 256 || value.includes("\u0000")) {
      throw new Error("invalid dashboard reference");
    }
    return value;
  } catch {
    throw new ApiRequestError(
      400,
      "invalid_dashboard_reference",
      "dashboard resource reference is invalid",
    );
  }
}

function dashboardInventoryQuery(url: URL): SessionInventoryQuery {
  const limit = optionalBoundedInteger(url.searchParams.get("limit"), 1, 100);
  const cursor = optionalCursor(url.searchParams.get("cursor"));
  const search = optionalQueryString(url.searchParams.get("search"), 1024);
  const sourceKinds = optionalCsv(url.searchParams.get("sourceKind"));
  const runtime = optionalCsv(url.searchParams.get("runtime"));
  const unread = optionalBooleanQuery(url.searchParams.get("unread"));
  const modifiedAfter = optionalQueryString(url.searchParams.get("modifiedAfter"), 64);
  return {
    ...(limit === undefined ? {} : { limit }),
    ...(cursor === undefined ? {} : { cursor }),
    ...(search === undefined ? {} : { search }),
    ...(sourceKinds === undefined
      ? {}
      : {
          sourceKinds: sourceKinds as NonNullable<SessionInventoryQuery["sourceKinds"]>,
        }),
    ...(runtime === undefined
      ? {}
      : { runtime: runtime as NonNullable<SessionInventoryQuery["runtime"]> }),
    ...(unread === undefined ? {} : { unread }),
    ...(modifiedAfter === undefined ? {} : { modifiedAfter }),
  };
}

function dashboardTranscriptQuery(url: URL): TranscriptQuery {
  const limit = optionalBoundedInteger(url.searchParams.get("limit"), 1, 200);
  const cursor = optionalCursor(url.searchParams.get("cursor"));
  const direction = url.searchParams.get("direction");
  if (direction !== null && direction !== "older" && direction !== "newer") {
    throw new ApiRequestError(400, "invalid_transcript_query", "transcript direction is invalid");
  }
  const leafId = optionalQueryString(url.searchParams.get("leafId"), 256);
  return {
    ...(limit === undefined ? {} : { limit }),
    ...(cursor === undefined ? {} : { cursor }),
    ...(direction === null ? {} : { direction }),
    ...(leafId === undefined ? {} : { leafId }),
  };
}

function parseDashboardActivation(value: unknown): ActivationRequest {
  const body = apiRecord(value, "dashboard activation request");
  const mode = apiString(body.mode, "mode", 32);
  if (!["reuse", "direct", "fork", "preview-only"].includes(mode)) {
    throw new ApiRequestError(400, "invalid_activation_mode", "activation mode is invalid");
  }
  return {
    requestId: apiString(body.requestId, "requestId", 128),
    idempotencyKey: apiString(body.idempotencyKey, "idempotencyKey", 512),
    mode: mode as ActivationRequest["mode"],
    ...(body.expectedFingerprint === undefined
      ? {}
      : {
          expectedFingerprint: asDashboardFingerprint(
            apiString(body.expectedFingerprint, "expectedFingerprint", 512),
          ),
        }),
    ...(body.desiredSessionName === undefined
      ? {}
      : { desiredSessionName: apiString(body.desiredSessionName, "desiredSessionName", 128) }),
    ...(body.policyRef === undefined
      ? {}
      : { policyRef: apiString(body.policyRef, "policyRef", 256) }),
  };
}

function parseDashboardExport(value: unknown): SessionExportRequest {
  const body = apiRecord(value, "dashboard export request");
  const mode = apiString(body.mode, "mode", 32);
  if (mode !== "as-new" && mode !== "append-to-origin") {
    throw new ApiRequestError(400, "invalid_export_mode", "export mode is invalid");
  }
  if (body.releaseAfterExport !== undefined && typeof body.releaseAfterExport !== "boolean") {
    throw new ApiRequestError(400, "invalid_export_request", "releaseAfterExport is invalid");
  }
  return {
    requestId: apiString(body.requestId, "requestId", 128),
    idempotencyKey: apiString(body.idempotencyKey, "idempotencyKey", 512),
    mode,
    ...(body.expectedSourceFingerprint === undefined
      ? {}
      : {
          expectedSourceFingerprint: asDashboardFingerprint(
            apiString(body.expectedSourceFingerprint, "expectedSourceFingerprint", 512),
          ),
        }),
    ...(body.releaseAfterExport === undefined
      ? {}
      : { releaseAfterExport: body.releaseAfterExport }),
  };
}

function parseDashboardLease(value: unknown): DashboardLeaseRequest {
  const body = apiRecord(value, "dashboard lease request");
  return {
    requestId: apiString(body.requestId, "requestId", 128),
    leaseId: apiString(body.leaseId, "leaseId", 256),
  };
}

function assertDashboardIdempotency(headers: IncomingHttpHeaders, bodyKey: string): void {
  const header = requiredIdempotencyKey(headers["idempotency-key"]);
  if (header !== bodyKey) {
    throw new ApiRequestError(
      400,
      "idempotency_key_mismatch",
      "Idempotency-Key must match the request body",
    );
  }
}

function assertDashboardDraftIfMatch(
  value: string | string[] | undefined,
  draftId: string,
  revision: number,
): void {
  if (typeof value !== "string" || value !== dashboardSessionDraftEtag(draftId, revision)) {
    throw new ApiRequestError(
      412,
      "draft_revision_conflict",
      "If-Match does not match the current draft revision",
    );
  }
}

function requiredIdempotencyKey(value: string | string[] | undefined): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) {
    throw new ApiRequestError(
      400,
      "idempotency_key_required",
      "Idempotency-Key header is required",
    );
  }
  return value;
}

function optionalCursor(value: string | null) {
  return value === null ? undefined : asDashboardCursor(apiString(value, "cursor", 1024));
}

function optionalFingerprint(value: string | null) {
  return value === null
    ? undefined
    : asDashboardFingerprint(apiString(value, "fingerprint", 512));
}

function optionalQueryString(value: string | null, max: number): string | undefined {
  return value === null ? undefined : apiString(value, "query", max, true);
}

function optionalCsv(value: string | null): string[] | undefined {
  if (value === null) return undefined;
  const values = value.split(",");
  if (
    values.length === 0 ||
    values.length > 16 ||
    values.some((entry) => entry.length === 0 || entry.length > 64)
  ) {
    throw new ApiRequestError(400, "invalid_dashboard_filter", "dashboard filter is invalid");
  }
  return values;
}

function optionalBooleanQuery(value: string | null): boolean | undefined {
  if (value === null) return undefined;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new ApiRequestError(400, "invalid_dashboard_filter", "boolean filter is invalid");
}

function optionalBoundedInteger(
  value: string | null,
  minimum: number,
  maximum: number,
): number | undefined {
  if (value === null) return undefined;
  const parsed = /^\d+$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new ApiRequestError(400, "invalid_dashboard_limit", "dashboard limit is invalid");
  }
  return parsed;
}
