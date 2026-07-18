---
layout: default
title: Protocol
---

# Protocol

Pi Daemon uses UTF-8 NDJSON over an owner-only Unix socket. Every line is one
JSON object. The default maximum line is 1 MiB. Protocol major mismatch closes
the connection; unknown outer-envelope fields and newer minor versions are
accepted.

The canonical v1 machine-readable contract is
[`protocol.schema.json`](protocol.schema.json). The additive v2 contract is
[`protocol-v2.schema.json`](protocol-v2.schema.json); its closed host-scoped
filesystem capability is specified separately in the
[host tool-adapter protocol](tool-adapter-protocol) and
[`tool-adapter.schema.json`](tool-adapter.schema.json). V1 remains exactly
no-tools.

This local protocol is one of two additive control modes. Authenticated session
CRUD, multi-reader raw/framed Pi RPC attachment, and the operator-requested
`/apc` route carrying upstream ACP are specified in the [Session API](session-api).
Both modes must resolve through one logical-session runtime and generation; the
HTTP/WebSocket API does not wrap or replace this durable Unix protocol.

## Command envelope

```json
{
  "protocolVersion": "1.0",
  "requestId": "request-unique-on-this-connection",
  "operation": "wake",
  "sessionId": "logical-agent-a",
  "generation": 3,
  "idempotencyKey": "source-correlation-id",
  "payload": { "prompt": "Reply with only pong" }
}
```

Responses have `kind: "response"`, the request ID, host instance ID, and either
`ok: true` with `data` or `ok: false` with a typed error. Events have
`kind: "event"`, logical session/generation, and a monotonic per-session
sequence. A client must discard events from stale host instances or session
generations. Handshake `host.ready` is true only after bounded background wake
and mutation replay has settled without recovery failures/indeterminate work and
the adapter reports usable authenticated models. `host.recovery` exposes only
safe phase/count/code summaries. A listening but recovering/degraded host still
serves status/reconciliation and may admit unaffected sessions, but probe returns
temporary failure.

## Operations

- `handshake` — version, capabilities, limits, readiness, metrics, and memory
- `open` — create/reopen one logical session generation
- `wake` — submit a durable idempotent model turn
- `steer` / `followUp` — use Pi's streaming queue controls
- `status` — host aggregate or one resident session
- `abort` — abort the current turn for a session generation
- `attach` — explicitly subscribe this connection to one current session generation
- `detach` — remove that exact generation-bound subscription
- `close` — dispose a logical session and optionally remove retained artifacts
- `drain` — stop admission and wait a bounded interval before aborting turns

`open` accepts session modes `memory`, `new`, `continue`, and `open`. The v1
resource policy is all `none`; an optional explicit system prompt is the only
loaded content resource. Protocol v2 retains those defaults but may carry one
closed, generation- and host-bound `host-adapter` descriptor for the six fixed
filesystem-neutral operations. It never enables shell, process, network,
package, extension, remove, or arbitrary method authority.

Event delivery is explicit. `open`, `wake`, `status`, `abort`, successful
commands, and failed commands never subscribe a connection implicitly. A client
must send `attach` with the current `sessionId` and `generation` before it
expects events, and `detach` removes only that exact generation. Replacing a
session generation makes an older attachment inert until the client attaches to
the new generation.

Successful opens create/update the same durable catalog used by the Session API.
Idle eviction and retained close produce `sessionDormant`; eviction additionally
produces `sessionEvicted`. Permanent deletion produces `sessionDeleted`, and a
dormant optimistic update produces `sessionUpdated`. These events retain daemon
session ID/generation identity and never expose raw environment values. Legacy
`status(sessionId)` remains resident-only; bounded retained/dormant discovery is
the Session API/catalog surface.

## Durable wake states

A wake is journaled before submission:

1. `queued` — durable and safe to replay after restart
2. `accepted` — marked before entering the Pi SDK call
3. `completed` or `failed` — terminal result/error cached for duplicate keys
4. `indeterminate` — an `accepted` request observed after host restart

An accepted request is never replayed automatically. Pi does not expose a
transactional provider prompt ID, so a crash between provider completion and
terminal journal fsync is reported as indeterminate rather than risking a
duplicate turn.

The same idempotency key with different semantic payload is rejected. Live
duplicates join one promise; terminal duplicates receive the cached terminal
record. `wake.payload.waitForTerminal` defaults to `true` for compatibility.
Set it to `false` to return a durable `prompt` ticket after queued admission;
inspect that ticket through the authenticated Session API instead of holding the
NDJSON request open.

`steer` and `followUp` are explicitly host-incarnation-local controls: Pi does
not provide a transactional control ID that can prove whether they crossed a
crash boundary. The daemon joins identical live/retained-in-process keys and
rejects semantic key reuse, with a bounded 256-key cache per resident runtime,
but never claims restart-safe replay. A client that loses the host incarnation
must inspect Pi entries/state before issuing a fresh control key. `abort` is
idempotent host-local cancellation and is never replayed. Extension and other
mutating Pi RPC commands are classified by the RPC parity layer before they are
admitted; commands without durable semantics must not be auto-retried.

## Versioned response and event envelopes

Handshake advertises the exact supported versions. Existing response/error/event
builders default to `1.0`, preserving v1 output. V2-aware dispatch passes the
accepted command's exact version to response and error builders, and records the
successful open version so later host-originated session events use that same
version. A parsed `2.x` command must never receive a silent `1.0` envelope.

## Backpressure

The server bounds connections, in-flight commands, input lines, individual
event records, individual response records, and total queued outbound bytes.
Outbound records pass a plain-JSON structural byte measurement before
`JSON.stringify` or `Buffer` allocation. Oversized response data is replaced by
a typed `outbound_record_too_large` error; non-serializable response data becomes
`outbound_not_serializable`. An oversized or non-serializable SDK event is
replaced at the same sequence by an `eventDropped` event carrying only the safe
error code, configured limit, and original event name. This preserves the
connection and delivery for other sessions instead of letting one event consume
the process or connection budget.

The multiplexer bounds resident sessions, global concurrent turns, and
per-session queued turns. Each durable journal record is capped at 1 MiB, so an
oversized prompt is rejected before acceptance and an oversized terminal result
leaves the accepted request safely indeterminate instead of growing retained
state without limit. Slow readers whose aggregate queue exceeds its separate
bound are disconnected rather than allowed to grow process memory without
limit.
