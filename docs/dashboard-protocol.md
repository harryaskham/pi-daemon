---
layout: default
title: Dash browser and backend contracts
---

# Pi Daemon Dash browser and backend contracts

Status: **Versioned contract, inventory, transcript projection, ownership,
production SPA/workspace, secure browser server, authenticated stream router,
embedded and dedicated backends, neutral remote APIs, shadow-TUI transport,
dedicated lifecycle, and full same-origin live browser integration are
implemented. Final dual-mode visual/security/performance acceptance remains.**

Pi Daemon Dash has one browser protocol and one transport-neutral backend seam.
The same compiled SPA talks to `/dash/v1` whether `DashboardServer` is embedded
inside `pi-daemon serve` or runs as the dedicated `pi-daemon web` process.
Deployment mode is deliberately absent from browser behavior.

The machine-readable and TypeScript contracts are:

- `src/dashboard-contract.ts` / package export `./dashboard-contract` — backend,
  channel, resource, frame, limit, and performance types;
- `src/dashboard-fixtures.ts` / package export `./dashboard-fixtures` — fresh,
  deterministic fixture builders for backend and frontend conformance suites;
- `src/dashboard-backend.ts` / package export `./dashboard-backend` — policy-
  preserving `InProcessDashboardBackend`, coalesced rich channels, replay,
  controller arbitration, durable hydration, and renewable residency leases;
- `src/dashboard-remote-backend.ts` / package export
  `./dashboard-remote-backend` — service-bearer REST delegation plus coalesced
  framed-RPC/TUI channels, bounded reconnect, cursor/gap recovery, and
  indeterminate accepted-command handling for dedicated mode;
- `src/dashboard-auth.ts`, `src/dashboard-store.ts`, and
  `src/dashboard-server.ts` / matching package subpaths — credential exchange,
  signed revocable browser sessions, static SPA serving, strict request
  admission, bounded WebSocket handoff, and atomic workspace/settings state;
- `src/dashboard-stream-router.ts` / package export `./dashboard-stream-router`
  — explicit backend-to-browser channel routing factory; the server remains
  fail-closed unless its lifecycle injects this handler after cookie auth;
- `web/src/browser-dashboard-client.ts` — browser-only same-origin REST and
  multiplexed `pi-daemon-dash.v1` client, including input-only login, CSRF,
  controller channels, replay/reconnect, and indeterminate lost responses;
- [`dashboard-api.schema.json`](dashboard-api.schema.json) — JSON Schema for
  HTTP resources and multiplexed WebSocket frames;
- [`dashboard-api.openapi.json`](dashboard-api.openapi.json) — same-origin HTTP
  and WebSocket route contract; and
- `fixtures/dashboard-api/` — frozen language-neutral examples.

The contract is additive to the existing owner-only NDJSON protocol and the
authenticated `/v1` session API. It does not replace Pi RPC, expose Pi SDK
objects, or introduce a second session state machine. The first concrete core
implementation is the [owner-safe persisted session inventory](dashboard-inventory),
and dedicated backends consume it through the
[neutral service-bearer Dash API](dashboard-service-api).

## Behavioral backend seam

`DashboardBackend` is the conformance boundary implemented by both deployment
modes. It exposes capabilities, inventory, authenticated information, preview
transcripts, activation/export tickets, prompt-redacted schedule CRUD/status,
managed session lookup, and rich/TUI channels. `InProcessDashboardBackend` may call transport-neutral services
without serialization; `RemoteDashboardBackend` uses the daemon REST and framed
Pi RPC APIs. Neither may bypass generation, controller, idempotency, root,
resource, or event-order policy.

`DashboardChannel` and `DashboardTuiChannel` are capability-gated peers:

- **Rich** carries normalized transcript state, raw Pi lifecycle/tool/entry
  events inside a dashboard wrapper, correlated commands, extension UI, and
  controller coordination.
- **TUI** carries bounded virtual-terminal snapshots, changed-row deltas,
  cursor/title state, resize, and input. It does not send raw ANSI or extension
  JavaScript to the browser.

A server advertises each presentation independently. The initial fixture makes
Rich available and reports TUI unavailable with
`interactive-view-seam-required`, proving clients must negotiate instead of
assuming the shadow view exists. The embedded backend advertises TUI only when
a transport-neutral coalesced TUI channel manager is injected; the same
browser protocol major remains valid.

Both Rich implementations open dormant durable sessions through the normal
catalog/runtime configuration boundary without prompting, then hold a renewable
bounded residency lease. The remote backend requests this explicitly with the
framed attachment's `hydrate=true` query; ordinary RPC attaches retain their
existing resident-only behavior. Panes for the same session/generation share
one controller subscription, upstream attachment, and replay buffer. Mutating commands remain
controller-only, read commands remain observer-safe, idempotency keys join only
semantically identical commands, and host/session/generation cursors produce an
explicit replay gap plus fresh snapshot when stale. Closing the final pane
releases controller UI, listeners, replay memory, and residency leases.

## Browser authentication boundary

The daemon service bearer is **server-to-server only**. Dedicated Dash loads it
privately; embedded Dash calls the same trusted services directly. Browser
JavaScript never receives the service bearer and never stores it in a bundle,
URL, workspace, IndexedDB, local storage, event frame, log, or error.

`POST /dash/v1/login` accepts an input-only web credential and emits an opaque
revocable browser session as `Set-Cookie`. The response body contains only
client/workspace identity, expiry, and a CSRF token. Private HTTP routes and the
WebSocket require the `HttpOnly`, same-site browser session. Mutations also
require exact Origin/Host checks and the CSRF header. Loopback is not
authentication.

The cookie itself is not represented by a TypeScript response resource or
language-neutral browser-storable fixture. Capability negotiation states
`daemonBearerExposed: false`. Authentication failures happen before private
route matching, so they do not reveal whether an inventory, ticket, workspace,
or managed session exists.

The implemented exchange stores only a digest of the configured web credential
and CSRF value. When no `web.auth.tokenFile` is configured, first launch
atomically creates and reuses an owner-only credential at `STATE_DIR/web-token`;
a configured path is held to the same owner/symlink/size checks. The browser
cookie contains a random lookup key plus an HMAC;
all client/workspace/expiry state stays server-side and is bounded and revocable.
It is `HttpOnly`, `SameSite=Strict`, scoped to `/dash/`, and uses the `__Host-`
form with `Secure` behind an HTTPS public origin. Restart intentionally revokes
all ephemeral browser sessions. The initial direct HTTP listener is
loopback-only; remote deployments terminate TLS at a loopback reverse proxy
until native TLS support lands.

`GET /dash/` and content-hashed `/dash/assets/*` are served from the packaged
SPA with a deny-by-default CSP, no-sniff/frame/referrer/permissions policy,
non-symlink regular-file checks, immutable caching only for hash-named assets,
and no SPA-injected credential or configuration. Traversal, unhashed asset
names, oversized files, and writable/untrusted files fail closed. The explicit
`?fixture=1` story is reserved for deterministic tests and visual artifacts: it
is visibly labelled, contains only generated data, opens no production channel,
and grants no authority.

## HTTP resources and envelopes

The provisional routes are fixed under `/dash/v1`:

| Route | Resource and effect |
| --- | --- |
| `POST /login`, `POST /logout` | browser session exchange/revocation |
| `GET /bootstrap` | capabilities, settings, workspace, and persisted inventory page; no hydration |
| `GET /sessions` | searchable/paged merged inventory without canonical paths |
| `GET /sessions/{inventoryId}` | authenticated full information and ownership resource; may include canonical path |
| `GET /sessions/{inventoryId}/transcript` | normalized active-branch preview; no SDK runtime required |
| `POST /sessions/{inventoryId}/activate` | idempotent reuse/direct/fork/preview-only admission |
| `GET /activation/{ticketId}` | retained activation ticket |
| `POST /sessions/{sessionRef}/export` | idempotent export-as-new or guarded append |
| `GET /export/{ticketId}` | retained export ticket |
| `GET|PUT /workspaces/{workspaceId}` | strong-ETag split-tree and seen-cursor state |
| `GET|PATCH|DELETE /settings` | effective UI settings, allowlisted overlay, and reset |
| `GET /schedules/capabilities` | effective cron/timezone and schedule validation limits |
| `GET /schedules`, `GET /schedules/{scheduleId}`, `GET /schedules/status` | bounded prompt-redacted schedule metadata and content-free status |
| `POST /schedules`, `PUT|DELETE /schedules/{scheduleId}` | CSRF-protected idempotent CRUD with exact ETag/revision preconditions; prompt is input-only |
| `GET /stream` | `pi-daemon-dash.v1` WebSocket upgrade |

Successful JSON envelopes carry:

```json
{
  "dashVersion": "1.0",
  "requestId": "req-...",
  "serverInstanceId": "dash-...",
  "clientId": "client-...",
  "workspaceId": "workspace-...",
  "ok": true,
  "data": {}
}
```

Errors replace `data` with the existing safe `ApiErrorBody` shape. Unknown minor
fields are ignored. Bodies, pages, records, and output are bounded before full
allocation or serialization. Schedule responses omit the private `prompt` and
return only `promptConfigured: true`; create requires prompt content, while an
update that omits it retains the existing owner-private value. Dedicated mode
reads that value only over the server-side service-bearer connection. Older
daemons that do not advertise `resources.schedules` produce the typed
`schedules_unavailable` capability result rather than speculative requests.

## Preview, ownership, and hydration are separate

Opening a chat pane has three independent stages:

1. **Preview** reads a fingerprint-keyed projection from durable JSONL data.
   `TranscriptPage.hydration` is literally `"not-requested"`; preview does not
   load provider auth, extensions, tools, models, or an `AgentSessionRuntime`,
   and never sends a prompt.
2. **Activation/ownership** explicitly chooses `reuse`, `direct`, `fork`, or
   `preview-only`. Direct co-opt is never implied by reading. Fingerprints are
   opaque optimistic preconditions. Frozen tickets cover queued direct,
   running fork, and succeeded reuse states.
3. **Hydration/attach** resolves a managed session and opens a generation-bound
   rich or TUI channel. Only a granted controller may mutate it.

Export remains a fourth explicit durable operation. Frozen tickets cover a
successful export-as-new and an indeterminate append-to-origin. A client never
blindly retries an indeterminate activation, command, or export with a new
idempotency key.

Inventory pages intentionally omit `canonicalPath` and raw source fingerprints.
The authenticated information resource may include a canonical path,
device/inode metadata, and bounded fingerprint. Raw search corpus, system
prompts, provider secrets, environment values, and tool output do not belong in
the inventory index.

## Normalized transcript identity

The preview and live reducer do not key records by array position or rendered
text. Every `NormalizedTranscriptRecord` has a stable `recordId` and at least
one Pi-origin identity in `key`:

- `entryId` for persisted tree entries;
- `messageId` for live/partial message identity; or
- `toolCallId` for tool start/update/end identity.

Tool records require `toolCallId`. An `entry_appended` event can therefore
replace the optimistic/live record rather than append a duplicate. Replay is
idempotent. A transcript page names its active leaf and never flattens sibling
branches into one false conversation.

Content blocks are bounded text/markdown/thinking/error, authorized image blob
references, or numeric usage. Raw base64 images and executable renderers are not
part of this contract. Unknown custom records remain visible through a bounded
fallback rather than disappearing.

## Stream identity, correlation, and replay

Every WebSocket frame carries `dashVersion`, `clientId`, `workspaceId`, and a
`correlationId`; server frames also carry request/server identity. Pane
subscriptions have distinct `subscriptionId` values. Several panes may watch
one managed session while sharing one backend channel, but their subscription
and command correlations never alias. Frozen multiplex fixtures demonstrate two
pane subscriptions to one session with separate correlation IDs.

Every live session event or TUI delta carries:

```text
hostInstanceId + sessionId + generation + sequence + opaque cursor
```

These values are truth, not display metadata. Cursors are opaque strings scoped
to that host, canonical session, and generation. Clients return them for replay
or seen acknowledgement and never parse or synthesize them.

A stale host, changed generation, or expired bounded cursor produces
`replay_gap` with `snapshotFollows: true`. The next
`subscription_ready` contains a fresh atomic snapshot and new high-water
cursor. Responses are private to the issuing subscription and are not replayed. A
correlated `extension_ui_response` frame carries only its subscription ID,
backend request ID, and bounded JSON response; it is accepted only from the
current rich-channel controller and receives a private command-result acknowledgement.
A command that lost its response across disconnect is indeterminate; clients
reconcile state/entries before deciding whether a new idempotency key is safe.

## Controller and idempotency rules

`observer` and `controller` are concurrency roles inside one authenticated Dash
operator trust domain. They are not user identities. Observers may read and
receive live output; mutating operations require explicit controller grant.
Disconnect never grants control to a random observer.

HTTP activation/export/workspace/settings mutations and reconnect-sensitive
stream commands carry bounded idempotency/correlation values. The same key and
semantic payload join retained work; reuse with a different payload conflicts.
The browser must not blind-replay a command simply because its WebSocket closed.

## Liveness and attention

`DashSessionPresence` keeps these facts orthogonal:

- runtime: unmanaged, dormant, resident-idle, running, or failed;
- activation provenance: untouched, selected, user/external/scheduled turn, or
  running at Dash startup;
- optional authoritative schedule summary;
- focused pane count;
- last settled and workspace-seen cursors; and
- unread attention.

Frozen scenarios prove that scheduled+dormant+unread, user-turn+dormant+unread,
and running-at-start are representable without overloading one boolean. Merely
listing a session does not advance the seen cursor. Dash renders schedule
filters, countdowns, and the per-session editor only when `resources.schedules`
is negotiated. A scheduled dormant session keeps its dark-magenta dot and
countdown regardless of pane focus; an unseen completion adds, rather than
replaces it with, the white unread ring. Older compatible daemons receive no
placeholder schedule controls or inferred timers.

## Workspace and settings

The server-authoritative workspace is a revisioned binary split tree of leaf
pane targets. A chat pane identifies an inventory item and Rich/TUI
presentation; an information pane identifies only the inventory item. Seen
cursors are persisted per workspace. `PUT` uses both a strong ETag and explicit
expected revision/idempotency fields.

Settings distinguish configured defaults from a mutable UI-only runtime
overlay. The overlay may change presentation preferences such as theme, editor,
sidebar, transcript expansion, reduced motion, and bounded browser cache. It
cannot change bind/auth/TLS, roots, credential references, daemon resource
limits, or trusted runtime policy.

The implemented stores use owner-only directories and atomic owner-only JSON
files under `STATE_DIR/web`. Workspace layout/seen cursors and settings overlays
have strong ETags, explicit revisions, bounded retained idempotency receipts,
strict unknown-field rejection, count/depth/record byte limits, serialized
updates, and corruption quarantine followed by safe configured defaults.
Runtime settings report the source of every effective leaf (`default`,
`config`, or `runtime`); reset removes only the runtime overlay.

## Negotiated default limits

`DASH_DEFAULT_LIMITS` is the safe initial envelope. A server returns every
effective value in capabilities; all caches must also enforce count, byte, age,
and single-record limits.

| Bound | Default |
| --- | ---: |
| HTTP body / WebSocket frame | 1 MiB each |
| per-connection outbound queue | 4 MiB |
| connections / subscriptions per connection | 64 / 32 |
| in-flight commands per connection | 8 |
| inventory / transcript page | 100 / 200 records |
| inventory roots / indexed sessions | 32 / 10,000 |
| inventory index / one record / max age / reconcile | 64 MiB / 16 KiB / 60 s / 30 s |
| search query / transcript record | 1,024 chars / 512 KiB |
| projection source / line / entries / output | 256 MiB / 1 MiB / 100,000 / 64 MiB |
| projection cache count / bytes / one entry / age | 1,024 / 256 MiB / 64 MiB / 7 d |
| image preview / authorized blob response | 256 KiB / 8 MiB |
| replay events / one event / bytes / retention | 512 / 512 KiB / 2 MiB / 5 min |
| workspaces / one workspace / panes / depth / pinned sessions | 64 / 1 MiB / 32 / 16 / 8 |
| TUI rows / columns / changed rows / delta | 200 / 320 / 200 / 512 KiB |
| settings resource | 256 KiB |
| visible lease heartbeat / expiry | 20 s / 60 s |
| browser transcript cache count / bytes / one entry / age | 64 / 64 MiB / 8 MiB / 1 d |
| browser session TTL | 12 h |

A negotiated server may reduce capacity, but it must not omit a bound. A slow
browser is disconnected instead of growing memory or blocking other readers.

## Performance acceptance budgets

`DASH_PERFORMANCE_BUDGETS` and the capabilities fixture encode the Phase 0 local
acceptance targets for 10,000 indexed sessions:

| Measurement | p95 budget |
| --- | ---: |
| persisted-index bootstrap response | < 50 ms |
| first sidebar rows | < 150 ms |
| loaded-index search page | < 100 ms |
| cached transcript viewport | < 150 ms |
| cold normal transcript useful viewport | < 500 ms |
| Pi stream delta to reducer | < 50 ms |
| shadow-TUI row delta | < 50 ms |
| normal animation/render frame work | < 16 ms |

The initial production SPA gzip budget is 1.5 MiB (`1,572,864` bytes). These are
measurement contracts, not license to do unbounded synchronous work just below
a wall-clock threshold. HTTP requests must not perform O(total sessions) scans,
and browsers must not construct O(total entries) DOM trees.

## Compatibility rules

- `1.x` additions are optional fields, enum values guarded by capabilities, or
  new frame/resource kinds older clients can ignore.
- Breaking field, identity, cursor, replay, authentication, or command semantics
  require `/dash/v2`, a new schema ID, and a new WebSocket subprotocol.
- Rich and TUI availability changes only through capability negotiation.
- Embedded and dedicated adapters run the same fixture/conformance suite.
- Raw Pi RPC may evolve independently; the browser stream stays a bounded
  dashboard protocol and translates through `DashboardSessionChannel`.
- No route, fixture, package export, or documentation may import or model
  Cacophony-specific state.
- A change is incomplete without TypeScript, schema/OpenAPI, fixtures, tests,
  and updated security/replay/generation documentation.
