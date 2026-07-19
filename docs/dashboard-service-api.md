---
layout: default
title: Neutral Dash service API
---

# Neutral Dash service API

The authenticated `/v1/dashboard/*` surface is the server-to-server protocol for
a dedicated `DashboardBackend`. It is separate from the same-origin
`/dash/v1/*` browser BFF:

- every neutral route uses the existing Pi Daemon service bearer;
- the bearer is loaded only by the dedicated Dash server and never reaches
  browser JavaScript, cookies, workspace state, logs, or errors;
- authentication runs before route lookup, inventory/session existence, body
  reads, or path disclosure; and
- resources reuse the exact `dashboard-contract` inventory, transcript,
  activation, export, lease, schedule-capability, and capability types used by the in-process
  backend.

The TypeScript controller is `DashboardNeutralApiController`; `ApiServer`
accepts it through the optional `dashboardApi` service. `SessionApiClient`
provides the authenticated transport and `RemoteDashboardBackend` implements the
same backend contract as embedded mode without importing in-process services.

## Routes

| Method/path | Purpose |
| --- | --- |
| `GET /v1/dashboard/capabilities` | neutral resources, effective limits, Rich availability, capability-gated TUI status, and optional schedule support for version negotiation |
| `GET /v1/dashboard/inventory` | bounded search/filter/page over public inventory rows |
| `GET /v1/dashboard/inventory/{inventoryId}` | authenticated full info, including source path/ownership diagnostics |
| `GET /v1/dashboard/inventory/{inventoryId}/transcript` | preview-only normalized projection with optional exact fingerprint precondition |
| `POST /v1/dashboard/inventory/{inventoryId}/activate` | durable preview/reuse/direct/fork activation ticket |
| `GET /v1/dashboard/activation/{ticketId}` | activation ticket |
| `POST /v1/dashboard/session/{sessionRef}/export` | durable export-as-new or guarded append-back ticket |
| `GET /v1/dashboard/export/{ticketId}` | export ticket |
| `POST /v1/dashboard/session/{sessionRef}/lease` | renew the exact cooperative ownership lease |
| `POST /v1/dashboard/session-drafts` | persist a validated new-session draft without runtime/model/tool work |
| `GET\|DELETE /v1/dashboard/session-drafts/{draftId}` | inspect or revision-cancel a durable unsent draft |
| `POST /v1/dashboard/session-drafts/{draftId}/send` | admit the exact first message through the injected materializer |
| `GET /v1/dashboard/session-draft-send/{ticketId}` | inspect queued/running/terminal/indeterminate first-send truth |
| `GET /v1/dashboard/session/{sessionRef}/tui` | capability-gated `pi-daemon-tui.v1` WebSocket |

HTTP successes use the normal session API envelope (`apiVersion`, `requestId`,
`hostInstanceId`, `ok`, `data`). Errors use safe typed `ApiErrorBody`. Unknown
minor fields remain additive.

## Admission and idempotency

Activation/export and draft create/cancel/send bodies contain `requestId` and
`idempotencyKey`. Draft cancel/send additionally require exact `If-Match` and
`expectedRevision`; every first-send ticket retains the admitted revision and
deterministic target session identity. The
HTTP `X-Request-Id` and `Idempotency-Key` headers must match when present/required;
a mismatch fails before mutation. The ownership service retains the durable
ticket and enforces semantic key reuse. A running operation interrupted by a
host crash is `indeterminate` and is never blindly resubmitted.

Direct/fork activation and export require exact inventory/managed source
fingerprints. The service returns typed conflicts for stale sources, active
controllers/mutations/writers, invalid leases, divergent history, and ownership
collisions.

## Inventory and transcript bounds

Inventory query parameters are `limit`, opaque `cursor`, bounded `search`, CSV
`sourceKind`/`runtime`, `unread`, and `modifiedAfter`. Transcript parameters are
`limit`, opaque `cursor`, `direction`, `leafId`, and `fingerprint`. The
controller resolves the authenticated inventory information resource and passes
only its canonical path plus exact current fingerprint to `TranscriptProjector`.
It never accepts an arbitrary client path.

Every effective bound is returned by neutral capabilities. Request bodies use
the existing API body limit; response serialization uses the same pre-allocation
bound as all other API records. Because one projected transcript may legitimately
exceed the per-response HTTP envelope, `RemoteDashboardBackend` intentionally
fetches at most three bounded records per neutral request and combines opaque
older/newer pages up to the caller's requested record limit. A single record
remains below the published record bound; dedicated mode therefore preserves
valid multi-megabyte transcript output without raising an unbounded client
response limit.

## Rich attach and prompt-free hydration

Dedicated Rich panes use the existing `pi-daemon-rpc.v1` attachment. The remote
backend sets `hydrate=true` explicitly: the daemon reopens a retained durable
session through its persisted catalog/configuration policy, without submitting a
prompt, and holds a renewable residency lease for the lifetime of the shared
attachment. Ordinary RPC clients that omit `hydrate` remain resident-only.

One upstream framed socket is coalesced per managed session/generation. Opaque
cursors survive bounded reconnect; a host/generation/retention mismatch is an
explicit replay gap followed by a fresh REST-backed transcript plus atomic RPC
snapshot. Responses are private and never replayed. Any command, extension UI
answer, TUI input, resize, or control operation sent before a connection loss but
missing its acknowledgement is indeterminate, not blindly resubmitted.

## TUI negotiation

The neutral TUI route uses exactly one WebSocket subprotocol:

```text
pi-daemon-tui.v1
```

When the server-side interactive view/UI-broker seam is unavailable,
capabilities advertise `tui.available: false` with a safe reason and upgrades
fail `501 tui_unavailable`. A missing/wrong subprotocol fails `426` and advertises
the required protocol. Service-bearer authentication still happens first.

The attachment implementation is injected as `DashboardTuiAttachmentManager`;
this API slice does not spawn a second Pi process or create another session
writer.

## Client methods

`SessionApiClient` provides typed methods:

- `dashboardCapabilities()`;
- `listDashboardSessions()`;
- `getDashboardSession()`;
- `getDashboardTranscript()`;
- `activateDashboardSession()` / `getDashboardActivation()`;
- `exportDashboardSession()` / `getDashboardExport()`;
- `renewDashboardLease()`;
- `createDashboardSessionDraft()` / `getDashboardSessionDraft()` /
  `cancelDashboardSessionDraft()`;
- `sendDashboardSessionDraft()` / `getDashboardSessionDraftSend()`;
- `createDashboardRpcSocket()` / `connectDashboardRpc()`; and
- `createDashboardTuiSocket()` / `connectDashboardTui()`.

The client retains the existing loopback/plaintext policy, bounded aggregate
response size, request timeout, service-bearer header, and safe error mapping.

## Machine-readable contracts

- `session-api.openapi.json` publishes every route and security response.
- `session-api.schema.json` publishes service envelopes.
- `dashboard-api.schema.json` publishes neutral capabilities and lease resources
  alongside shared Dash resources.
- `dashboard-session-draft.schema.json` publishes the browser-safe draft and
  first-send ticket contract.
- `fixtures/session-api/dashboard.*.response.json` are language-neutral examples.
