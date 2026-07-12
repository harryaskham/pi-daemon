---
layout: default
title: Protocol
---

# Protocol

Pi Daemon uses UTF-8 NDJSON over an owner-only Unix socket. Every line is one
JSON object. The default maximum line is 1 MiB. Protocol major mismatch closes
the connection; unknown fields and newer minor versions are accepted.

The canonical machine-readable contract is
[`protocol.schema.json`](protocol.schema.json).

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
generations.

## Operations

- `handshake` — version, capabilities, limits, readiness, metrics, and memory
- `open` — create/reopen one logical session generation
- `wake` — submit a durable idempotent model turn
- `steer` / `followUp` — use Pi's streaming queue controls
- `status` — host aggregate or one resident session
- `abort` — abort the current turn for a session generation
- `close` — dispose a logical session and optionally remove retained artifacts
- `drain` — stop admission and wait a bounded interval before aborting turns

`open` accepts session modes `memory`, `new`, `continue`, and `open`. The v1
resource policy is all `none`; an optional explicit system prompt is the only
loaded content resource.

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
record.

## Backpressure

The server bounds connections, in-flight commands, input lines, and outbound
bytes. The multiplexer bounds resident sessions, global concurrent turns, and
per-session queued turns. Each durable journal record is capped at 1 MiB, so an
oversized prompt is rejected before acceptance and an oversized terminal result
leaves the accepted request safely indeterminate instead of growing retained
state without limit. Slow readers are disconnected rather than allowed to grow
process memory without limit.
