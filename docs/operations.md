---
layout: default
title: Operations
---

# Operations

## Development shell

```console
nix develop github:harryaskham/pi-daemon
npm ci --ignore-scripts
npm test
```

## Serve

Choose three non-overlapping paths: an owner-private socket directory, daemon
state, and an allowed workload root. The Pi agent directory may be supplied
explicitly and defaults to Pi's normal configured directory.

```console
pi-daemon serve \
  --socket "$XDG_RUNTIME_DIR/pi-daemon.sock" \
  --state-dir "$HOME/.local/state/pi-daemon" \
  --agent-dir "$HOME/.pi/agent" \
  --allow-root "$HOME/work"
```

To enable the additive authenticated JSON listener, choose exactly one bearer
source. Supplying the token as a CLI value is intentionally unsupported:

```console
pi-daemon serve \
  --socket "$XDG_RUNTIME_DIR/pi-daemon.sock" \
  --state-dir "$HOME/.local/state/pi-daemon" \
  --allow-root "$HOME/work" \
  --api-bind 127.0.0.1 \
  --api-port 7463 \
  --api-token-file "$HOME/.config/pi-daemon/api-token"
```

The token file must be an owner-only regular non-symlink file. An inherited
secret descriptor (`--api-token-fd FD`) or `PI_DAEMON_BEARER_TOKEN` may be used
instead, but sources are mutually exclusive. The default bind is the literal
loopback address `127.0.0.1`. A non-loopback plaintext bind is refused unless
`--api-allow-insecure-http true` explicitly acknowledges trusted-network or TLS
reverse-proxy handling.

`GET /v1/capabilities` is implemented by the transport foundation. It advertises
HTTP but does not advertise WebSocket or RPC subprotocol support until stream
dispatch lands. Session CRUD and `/rpc`/`/apc` upgrades are reserved by the
published contract and return a typed not-implemented response until their
dependent implementation slices land; they never fall back to unauthenticated
behavior.

Optional limits:

```text
--max-sessions N
--max-concurrent-turns N
--max-session-queue-depth N
--idle-session-ttl-ms N
--max-connections N
--max-in-flight-requests-per-connection N
--max-line-bytes N
--max-event-bytes N
--max-response-bytes N
--max-outbound-bytes-per-connection N
```

The event and response limits include their complete NDJSON envelopes and
trailing LF. Each must be no greater than the aggregate per-connection outbound
byte limit. Oversized/non-serializable events become bounded `eventDropped`
records; oversized/non-serializable responses become typed errors.

The service emits structured JSON lifecycle logs to stderr. It never logs
prompts or model output. A `pi_daemon_ready` record includes the socket, host
instance, and bounded recovery counts.

## Probe and status

```console
pi-daemon probe --socket "$XDG_RUNTIME_DIR/pi-daemon.sock"

pi-daemon request --socket "$XDG_RUNTIME_DIR/pi-daemon.sock" --json \
  '{"protocolVersion":"1.0","requestId":"status-1","operation":"status","payload":{}}'

pi-daemon request --socket "$XDG_RUNTIME_DIR/pi-daemon.sock" --json \
  '{"protocolVersion":"1.0","requestId":"attach-1","operation":"attach","sessionId":"agent-a","generation":1,"payload":{}}'
```

Readiness distinguishes protocol availability from Pi model/auth availability.
Status includes counters, latency summaries, memory, resident sessions,
retained/dormant catalog counts, active and queued turns, and draining state; it
excludes prompts, results, and secrets.

## Shutdown

SIGTERM starts a 30-second drain. SIGINT uses five seconds. A protocol `drain`
command accepts `payload.timeoutMs`. New open/wake requests are rejected once
drain starts; after the deadline, queued and active turns are aborted.

Idle SDK sessions are evicted after 30 minutes by default while their durable
catalog and Pi session artifacts remain. Eviction emits `sessionDormant` and
`sessionEvicted`; re-open the same generation and policy to load the exact
resolved Pi session file again. A retained close removes the runtime manifest,
so it stays dormant across restart until explicitly reopened. Set
`--idle-session-ttl-ms 0` to disable eviction.

## Durable session catalog

Owner-private atomic catalog records live under
`state/catalog/<escaped-session-id>.json`. They retain immutable daemon ID,
optional exact unique name, generation/revision, resident/dormant state,
nonsecret normalized session spec, environment key/digest summary, current Pi
conversation identity, last-use timestamps, and the latest terminal outcome.
Raw environment values are rejected rather than serialized.

Catalog records are individually capped at 1 MiB and the retained record count
is bounded. Listing is stable by canonical session ID, defaults to 50 entries,
caps at 100, and uses opaque cursors. A dormant record can be inspected, renamed or
replaced with optimistic generation/revision checks, reopened, or deleted with
its retained manifest/journal/Pi files without first creating an SDK runtime.
Daemon status exposes only counts; the additive session API exposes bounded
resources.

## Durable command tickets

Owner-private atomic mutation tickets live under `state/tickets/`. They are
bounded to 4096 records, 1 MiB each, and seven days for terminal or
indeterminate retention by default. Ticket commands contain only the secret-free
persisted session spec; raw environment values are rejected before admission.
The wake path continues to use the bounded per-session journal and derives an
opaque ticket ID from session/idempotency scope. Authenticated API responses are
preflighted against a 2 MiB structural JSON bound; an oversized list/result
becomes a typed `outbound_record_too_large` error before JSON/Buffer allocation.

## Restart recovery

At startup, manifests reopen the resolved Pi session file recorded after the
original create/continue/open operation; the requested target is never rerun as
though it were still unresolved. Durable `queued` wakes replay only after that
exact conversation opens, while queued mutation tickets replay through their
secret-free commands. `accepted` wakes and `running` mutations become
`indeterminate` and require client reconciliation. Readiness logs expose only
queued/indeterminate/pruned counts, never ticket commands or results.

A missing/corrupt Pi file, a legacy `new`/`continue` manifest without resolved
identity, or a generation mismatch blocks replay and is reported as a recovery
failure. Corrupt, permissive, mismatched, oversized, or symlinked state fails
closed rather than being ignored.

`memory` targets are explicitly resident-only: they have a catalog identity but
no runtime manifest or durable wake journal, remain dormant after restart, and
cannot be reopened as an empty replacement conversation.
