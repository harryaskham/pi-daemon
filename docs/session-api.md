---
layout: default
title: Session API
---

# Additive session CRUD, RPC attach, and ACP API

Status: **versioned implementation contract for API 1.x**.

Pi Daemon has two additive control planes over one logical-session core:

1. the existing UTF-8 NDJSON protocol on an owner-only Unix socket; and
2. the authenticated JSON session API described here.

Neither control plane wraps a `pi` subprocess. Every resident logical session is
backed by one in-process Pi SDK runtime. A transport adapter may have different
response timing, but it must not create a second session state machine,
independent event history, or competing generation counter.

The machine-readable contracts are:

- [`protocol.schema.json`](protocol.schema.json) — existing Unix NDJSON;
- [`session-api.schema.json`](session-api.schema.json) — REST resources and
  attachment frames; and
- [`session-api.openapi.json`](session-api.openapi.json) — HTTP and WebSocket
  paths.

## Version and transport

The HTTP base path is `/v1`. JSON envelopes carry `apiVersion: "1.x"`. New minor
fields are additive; a breaking field or semantic change requires `/v2` and a
new schema identifier.

The HTTP routes may be served over a loopback TCP listener or HTTP-over-Unix
socket. The default TCP bind is loopback. The existing raw NDJSON listener
remains Unix-only and owner-only; it is never promoted to an unauthenticated TCP
listener.

Bidirectional attachments use WebSocket upgrades because Pi RPC and ACP both
send requests, responses, events, and UI interactions in both directions.
Plain REST requests are not used as an unbounded event stream. The in-process
31-command Pi RPC controller is implemented independently of transport; the
WebSocket route is advertised only after bounded multi-reader snapshot/replay
attachment lands. See the [Pi RPC runtime host](pi-rpc-host).

## Authentication and secret handling

The complete HTTP/WebSocket API uses **one opaque server-wide bearer token**:

```http
Authorization: Bearer <opaque-service-token>
```

This is one trust domain. Version 1 has no user identity, per-session token,
session lease authorization, or access-control list. A controller attachment is
a concurrency role, not an authentication boundary: any holder of the service
bearer can inspect sessions and request controller status.

The implementation must:

- obtain the bearer from an owner-only file, inherited file descriptor, or
  environment-backed secret source rather than a CLI argument visible in a
  process listing; when no external source is configured, first launch
  atomically generates and reuses the owner-only `STATE_DIR/api-token` file;
- authenticate an HTTP request or WebSocket upgrade before reading a body or
  revealing whether a session exists;
- never include the token in logs, status, metrics, errors, manifests, tickets,
  or crash diagnostics;
- compare credentials without data-dependent prefix matching; and
- require TLS or an explicitly documented trusted reverse proxy before allowing
  a bearer-authenticated non-loopback listener. Plain remote HTTP needs an
  explicit insecure-development override and must never be the default.

The owner-only legacy Unix NDJSON socket continues to use filesystem ownership
and mode as its local authentication mechanism. All `/v1` HTTP routes require
the bearer even when HTTP is carried over a Unix socket.

## Session identity, names, generations, and revisions

A session resource has:

- `sessionId` — immutable canonical identifier;
- optional `name` — mutable human-readable exact alias;
- `generation` — identity of the resident Pi runtime;
- `revision` — optimistic version of the REST resource;
- `residency` — `resident` while an SDK runtime is loaded or `dormant` while
  only durable catalog/session artifacts remain; and
- `state` — `opening`, `idle`, `running`, `failed`, or `closing`; and
- optional `lastTerminal` — safe succeeded/failed/indeterminate outcome,
  timestamp, request ID, and error code without prompt/result content.

JSON API creation starts generation at 1. Legacy NDJSON generations beginning at
0 remain readable in the catalog for compatibility. Replacing the desired runtime policy increments generation. Pi `new`,
`switch`, `fork`, or import inside the same hosted runtime changes the recorded
conversation ID/file and increments resource revision without silently changing
the daemon generation. Updating other metadata or Pi state in place likewise
does not necessarily increment generation. Every successful catalog mutation
increments revision.

`{sessionRef}` is URL-decoded exactly once and resolves as follows:

1. exact canonical `sessionId`;
2. exact, case-sensitive unique `name`; or
3. `404 session_not_found`.

Names must be unique among retained sessions and must not equal another
session's canonical ID. Prefixes, case folding, fuzzy matching, and
first-match selection are forbidden. A conflict is `409 session_name_conflict`.

`GET /v1/session/{sessionRef}` returns a strong `ETag` derived from canonical ID
and revision, with no secret material. `PUT` and `DELETE` require `If-Match`.
The body of `PUT` also names `expectedGeneration` and `expectedRevision` so
non-HTTP clients can preserve the same stale-update check.

## CLI-equivalent creation specification

`POST /v1/session` accepts a typed `SessionSpec`, not an arbitrary shell command
line. It covers the meaningful Pi CLI inputs without accepting process-oriented
flags such as `--help`, `--version`, `--mode`, or an interactive resume picker.

| Pi CLI concept | Session API field |
| --- | --- |
| cwd | `spec.cwd` |
| `--name`, `--session-id` | `spec.name`, top-level `sessionId` |
| new, `--continue`, `--session`, `--fork`, `--no-session` | `spec.target` |
| `--session-dir` | `spec.target.sessionDir` |
| `--provider`, `--model`, `--thinking`, `--models` | `spec.model` |
| `--tools`, `--exclude-tools`, `--no-tools`, `--no-builtin-tools` | `spec.tools` |
| extension/skill/prompt/theme paths and `--no-*` | `spec.resources` |
| system and appended prompts | `spec.resources.systemPrompt`, `appendSystemPrompt` |
| `--approve`, `--no-approve` | `spec.resources.projectTrust` |
| extension-defined flags | `spec.resources.extensionFlags` |
| settings overrides | `spec.settings` |
| process-like environment | input-only `spec.env` |
| execution isolation | `spec.isolation.mode` |

An interactive `--resume` picker maps to `GET /v1/session` followed by an
explicit `open` or `fork` target. Resource paths are canonicalized to absolute
paths at create/update admission so a later cwd switch does not reinterpret
them.

### Environment contract

Raw `spec.env` values are input-only. A session response contains only sorted
keys, an optional non-reversible digest, provisioning state, and persistence
class. Raw values must not be returned or written to the current plaintext
session manifest or request journal.

Version 1 permits memory-only values and implementation-defined secret
references. After restart, a session whose memory-only values cannot be
re-provisioned becomes `failed` with `credentials_required`; it is not replayed
with missing or host-global credentials.

`isolation.mode: "unisolated"` is the only initial mode. It is an explicit trust
statement, not a sandbox. Pi SDK components receive explicit cwd, settings,
resource, tool, and auth objects where supported. Arbitrary extensions can
still access process globals and share the Node trust domain. The daemon must
never simulate per-session environment by racing `process.env` replacement or
`process.chdir()` around concurrent turns. The initial implementation applies a
session overlay only to known selected-provider API-key auth and the built-in
bash child-process spawn hook; see [Session configuration](session-configuration)
for the exact supported mapping and limitations.

## REST resources

| Method and path | Meaning | Success |
| --- | --- | --- |
| `GET /v1/capabilities` | negotiate API, transport, RPC, auth, and isolation support | `200` capabilities envelope |
| `GET /v1/session` | bounded session page | `200` list envelope |
| `POST /v1/session` | create session | `202` ticket envelope |
| `GET /v1/session/{sessionRef}` | inspect by ID or exact name | `200` session envelope |
| `PUT /v1/session/{sessionRef}` | replace desired spec with stale checks | `202` ticket envelope |
| `DELETE /v1/session/{sessionRef}` | close and optionally remove artifacts | `202` ticket envelope |
| `GET /v1/ticket/{ticketId}` | inspect bounded mutation ticket | `200` ticket envelope |
| `GET /v1/ticket?method=...&target=...` | exact lookup using `Idempotency-Key` | `200` ticket envelope |
| `POST /v1/ticket/{ticketId}/reconcile` | resolve indeterminate work with retained Pi entry evidence | `200` ticket envelope |
| `GET /v1/session/{sessionRef}/rpc` | WebSocket Pi RPC attach | `101` |
| `GET /v1/session/{sessionRef}/apc` | WebSocket upstream ACP attach | `101` |
| `GET|POST /v1/dashboard/*` | neutral inventory, preview, ownership/export/lease resources for dedicated Dash backends | versioned service envelopes/tickets |
| `GET /v1/dashboard/session/{sessionRef}/tui` | capability-gated server-side TUI WebSocket (`pi-daemon-tui.v1`) | `101` or typed unavailable response |

The complete neutral route set, idempotency rules, client methods, and separation
from browser authentication are documented in the
[Neutral Dash service API](dashboard-service-api). The daemon service bearer
never crosses from the dedicated backend into browser storage.

List ordering is stable by canonical session ID and includes both resident and
dormant retained sessions. `limit` defaults to 50 and is bounded to 100.
`cursor` is opaque and tied to the filter and ordering. Clients
must not parse it. Deleted sessions do not reappear within an existing page
sequence; a stale page cursor returns a typed conflict or a new first page, as
advertised by capabilities.

Idle eviction disposes only the SDK runtime, marks the catalog record dormant,
and preserves its Pi session files. A later create/open with the same generation
and policy reopens the exact resolved conversation rather than evaluating the
original `new` or `continue` target again. DELETE can remove a dormant record and
its retained artifacts without first making it resident. A `memory` target is
resident-only and has no manifest or replayable wake journal; restart leaves its
catalog record dormant instead of fabricating an empty conversation.

`PUT` carries the full desired spec. Cwd, target, agentDir, environment,
resources, settings, or isolation changes replace the runtime and increment
generation. The implementation may apply a supported name, model, thinking,
queue, retry, or compaction change in place. A replacement while a turn is
active fails with `409 session_busy`; it never races an accepted turn.

## Envelopes, request IDs, and errors

Every JSON response has a safe envelope:

```json
{
  "apiVersion": "1.0",
  "requestId": "req-123",
  "hostInstanceId": "host-uuid",
  "ok": true,
  "data": {}
}
```

Clients may send `X-Request-Id`; mutating request bodies also carry `requestId`.
If both are present they must match. The server generates one when absent.
Errors set `ok: false` and contain `code`, safe `message`, `retryable`, and
optional redacted `details`.

| HTTP | Error class |
| --- | --- |
| `400` | malformed JSON, field, cursor, or request ID |
| `401` | missing/invalid service bearer |
| `404` | session or ticket not found |
| `409` | name, generation, busy, controller, or idempotency conflict |
| `412` | ETag/revision/generation precondition failed |
| `413` | body, environment, prompt, line, or frame bound exceeded |
| `422` | known but unsupported Pi option/resource/isolation feature |
| `426` | WebSocket upgrade/subprotocol required |
| `429` | bounded connection/session/queue/ticket capacity reached |
| `503` | host not ready or draining |

A `401` response must not distinguish an absent session from a present one.

## Idempotency and request tickets

`POST`, `PUT`, and `DELETE` require `Idempotency-Key`. The key is scoped to the
service, method, and canonical target. Reusing it with the same semantic payload
joins the retained ticket. Reusing it with a different payload returns
`409 idempotency_conflict`.

Ticket resources retain the original safe `requestId` and `idempotencyKey` so a
client can reconcile retries without inspecting mutation payloads. Besides the
ticket URL, an authenticated client can look up the exact method/canonical-target
scope with `GET /v1/ticket` and the `Idempotency-Key` header.

Mutations return `202` and a bounded retained ticket in one of these states.
Callers that need a convenience barrier may add `waitForTerminal=true`; the
response remains a ticket envelope but is held until that ticket is terminal.
The default is immediate admission and later GET/status observation.

Ticket states:

- `queued` — durably admitted but not submitted to Pi;
- `running` — runtime transition has started;
- `succeeded` — terminal result retained;
- `failed` — terminal typed failure retained; or
- `indeterminate` — submission may have occurred before a host interruption.

An indeterminate mutation is never blindly replayed. After reading retained Pi
entries through RPC, a trusted client may explicitly reconcile it by posting the
bounded entry IDs and a succeeded/failed outcome to the ticket reconciliation
route. The entry IDs are audit evidence supplied by the client; the daemon stores
only those IDs and a safe outcome summary, never client-supplied result content
or error text. It does not claim provider-transaction proof when Pi lacks one.
Otherwise the client
chooses a fresh idempotency key only after reconciliation. Ticket count, bytes,
and retention age are bounded. A pruned ticket returns `404 ticket_not_found`;
pruning never changes session state.

Legacy NDJSON `wake` retains its wait-for-terminal default. Setting
`payload.waitForTerminal` to `false` instead returns a durable `prompt` ticket
immediately; that ticket is readable through the same GET routes. Queued wakes
are replayable, accepted wakes become indeterminate after restart, and terminal
prompt results/errors remain bounded by the existing request journal policy.

## Pi RPC attachment

`GET /v1/session/{sessionRef}/rpc` requires one of two WebSocket subprotocols.

### `pi-rpc.v1`

This is live-only upstream Pi RPC compatibility. Client messages are raw Pi
`RpcCommand` objects. Server responses and events preserve Pi's raw shapes.
There are no daemon cursor/control records on this wire. A reconnecting client
uses `get_state`, `get_entries`, and `get_messages` to reconstruct state.

### `pi-daemon-rpc.v1`

This wraps the same Pi commands, responses, and events in frames. Attachments
remain resident-only by default. A trusted service client may add
`hydrate=true` to reopen a retained durable session through its persisted
catalog/configuration policy before attaching; hydration never submits a prompt,
and the attachment holds a renewable residency lease until disconnect. Invalid
hydration values fail closed. Memory-only sessions cannot be reopened after
eviction.

Frames are:

- `command` — one Pi RPC command;
- `response` — response routed only to the issuing connection;
- `extension_ui_response` — controller-only answer to a correlated extension dialog;
- `event` — broadcast event plus monotonic sequence and opaque cursor;
- `attach_ready` — host/session identity and atomic state snapshot;
- `replay_gap` — requested history is no longer available; and
- `control` — controller lease coordination.

The full v1 command inventory matches Pi 0.80.6:

```text
prompt steer follow_up abort new_session
get_state get_messages get_commands
set_model cycle_model get_available_models
set_thinking_level cycle_thinking_level
set_steering_mode set_follow_up_mode
compact set_auto_compaction set_auto_retry abort_retry
bash abort_bash get_session_stats export_html
switch_session fork clone get_fork_messages
get_entries get_tree get_last_assistant_text set_session_name
```

Protocol additions from a later Pi SDK require a fixture, compatibility test,
and additive capability advertisement before the daemon accepts them.

### Multi-reader response routing

Pi request IDs are chosen by clients and can collide across attachments.
Therefore:

- command responses go only to the connection that issued the command;
- AgentSession events fan out to all attached readers;
- each connection has its own bounded outbound queue;
- a slow reader is disconnected without blocking the runtime or other readers;
- disconnecting an observer never aborts a turn; and
- disconnecting the controller does not grant controller status implicitly to a
  random observer.

### Controller and extension UI semantics

At most one attachment is the session `controller`; others are `observer`.
This is a concurrency lease inside the single service-bearer trust domain.
Observers may issue read-only state commands. Mutating commands from an
observer receive a typed `controller_required` error.

Attachments default to `role=observer`; a raw compatibility client that needs
mutation authority must explicitly request `role=controller`. A client requests
controller status with `role=controller` during upgrade or a framed
`request_control` message. If occupied, raw Pi RPC upgrade fails with
`409 controller_busy`; framed mode may attach as observer and emit
`control_denied`. Release/disconnect permits a later explicit request.

Extension UI requests are visible to observers but only the current controller
may answer. The first valid controller response resolves the request. Observer,
duplicate, stale-generation, or unknown IDs are rejected. If the controller
disconnects, pending dialogs resolve to their fail-safe timeout/cancel default;
they are not transferred silently.

### Atomic snapshot, replay, and reconnect

For framed attach, the server establishes the event subscription and captures a
catalog resource, active/queued request state, Pi RPC state, and current leaf at
one high-water sequence under the same session event boundary.
It then emits:

1. `attach_ready` with snapshot and high-water cursor;
2. retained events strictly after the requested cursor or snapshot boundary;
3. live events with no sequence gap.

No event may occur between snapshot and live subscription without being either
represented by the snapshot or replayed.

Cursors are opaque and scoped to `hostInstanceId`, canonical session ID, and
generation. A host restart, generation replacement, or expired bounded replay
buffer emits `replay_gap` followed by a fresh `attach_ready` snapshot. Clients
must discard events from a previous host or generation. Response records are
not replayed; clients reconcile command effects through state/session entries.

### Stock stdio client

The packaged `pi-daemon-rpc` binary uses framed attach internally and exposes
only upstream Pi RPC JSONL on stdin/stdout. It unwraps private responses and
broadcast events, retains the latest cursor across bounded reconnects, and
reports attach/control/gap lifecycle as JSONL on stderr. Commands sent before a
disconnect but lacking a response are returned as correlated
`connection_lost_indeterminate` failures and are never replayed blindly. See
[Remote RPC stdio bridge](rpc-bridge) for authentication, limits, and terminal
semantics.

## `/apc`: upstream Agent Client Protocol

The v1 route is intentionally spelled `/apc` because that is the operator's
published path contract. Its payload protocol is the upstream **ACP (Agent
Client Protocol)** JSON-RPC 2.0 protocol. Implementations and docs must not
invent a separate “APC” wire protocol.

The WebSocket subprotocol is `agent-client-protocol.v1`. The client performs
ACP `initialize`, then binds the scoped logical session. `session/new` may
initialize an empty scoped runtime only when its cwd/spec agree with the REST
resource; `session/load` must resolve to the session named in the URL. ACP
prompts, cancellation, modes, plans, tool updates, permissions, and session
notifications translate to the same `AgentSessionRuntime` used by NDJSON and Pi
RPC. They never spawn `pi --mode rpc`.

The external MIT `pi-acp` adapter is the audited parity oracle, not a daemon
runtime dependency: its translation design is tracked at commit
`49d6ec804d40b52317d873360654054c5d2387a3`, while its subprocess wrapper is
excluded. Pi Daemon pins `@agentclientprotocol/sdk`, adapts JSON-RPC directly to
the resident `PiRpcController`, publishes bounded ACP capabilities, and retains
the upstream MIT notice. See the [ACP adapter](acp-adapter).

## Cross-control-plane equivalence

| Logical action | Unix NDJSON | REST | Pi RPC |
| --- | --- | --- | --- |
| create/open | `open` | `POST /v1/session` | `new_session` within attached runtime |
| inspect | `status` | `GET /v1/session/{ref}` | `get_state` |
| prompt | durable `wake` | — | `prompt` |
| steer | `steer` | — | `steer` |
| follow-up | `followUp` | — | `follow_up` |
| abort | `abort` | — | `abort` |
| attach | generation-bound `attach` | WebSocket upgrade | transport attach |
| detach | generation-bound `detach` | WebSocket close | transport detach |
| replace | next-generation `open` | `PUT /v1/session/{ref}` | `switch_session`/`new_session` |
| close | `close` | `DELETE /v1/session/{ref}` | transport disconnect does **not** close |

NDJSON `wake` is a durable terminal operation: its response follows the settled
turn and journal boundary. Pi RPC `prompt` responds after preflight acceptance
and streams the run asynchronously. These timings are deliberately different.
They still use one acceptance arbiter, one Pi runtime, one generation, and one
event source.

## Bounds and compatibility gates

The implementation must explicitly bound HTTP body bytes, environment entries
and bytes, WebSocket frame bytes, clients, sessions, tickets, replay events,
per-reader outbound bytes, in-flight commands, retained terminal results, and
drain time. Limits are returned by capabilities/status without secret values.

A protocol change is incomplete without:

1. TypeScript contract updates in `src/session-api.ts`;
2. JSON Schema and OpenAPI updates;
3. valid and invalid fixtures under `fixtures/session-api/`;
4. compatibility tests for existing Unix NDJSON, REST, raw Pi RPC, framed Pi
   RPC, and `/apc` ACP translation; and
5. documentation of durability, authentication, replay, and upgrade behavior.
