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

`GET /v1/capabilities` advertises HTTP, WebSocket, both Pi RPC subprotocols,
the pinned in-process RPC host contract, controller/observer roles, replay, and
all active attachment limits. Durable session CRUD, ticket lookup/reconciliation,
and `/rpc` are implemented behind the same bearer boundary. `/apc` serves
upstream Agent Client Protocol JSON-RPC over the required
`agent-client-protocol.v1` WebSocket subprotocol. It uses the same resident Pi
runtime, bearer, generation, and bounded peer transport; it never spawns
`pi-acp` or `pi --mode rpc`.

Optional limits:

```text
--max-sessions N
--max-concurrent-turns N
--max-session-queue-depth N
--idle-session-ttl-ms N
--recovery-open-timeout-ms N
--recovery-total-timeout-ms N
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

Pi RPC attachment defaults separately bound hubs (32), replay events (512),
replay bytes per hub (2 MiB), aggregate replay capacity (64 MiB), text messages
(1 MiB), per-reader outbound bytes (4 MiB), and in-flight commands per reader
(8). A 30-second ping/pong keepalive detects
dead readers. These effective values are returned by `/v1/capabilities`; a slow
reader is closed without blocking its session, controller, or other readers.

## Remote stock-RPC client

`pi-daemon-rpc --session ID_OR_EXACT_NAME` translates stock Pi RPC JSONL on
stdin/stdout to the framed WebSocket API. Supply `--url`, plus exactly one of
`--token-file`, `--token-fd`, or `PI_DAEMON_BEARER_TOKEN`. Reconnect attempts,
handshake time, pending/in-flight commands, bytes, replay, terminal response
drain, and output flush are bounded. Attach/reconnect/gap status is JSONL on
stderr; bearer values and daemon framing never appear on either output stream.
See [Remote RPC stdio bridge](rpc-bridge).

The service emits structured JSON lifecycle logs to stderr. It never logs
prompts, model output, credentials, or private state/agent/workload paths.
`pi_daemon_listening_degraded` means the transport is available but recovery or
provider readiness is incomplete/degraded; `pi_daemon_ready` is emitted only
when all bounded recovery work settles without an indeterminate/failure state.

## Probe and status

```console
pi-daemon probe --socket "$XDG_RUNTIME_DIR/pi-daemon.sock" --timeout-ms 5000

pi-daemon request --socket "$XDG_RUNTIME_DIR/pi-daemon.sock" --json \
  '{"protocolVersion":"1.0","requestId":"status-1","operation":"status","payload":{}}'

pi-daemon request --socket "$XDG_RUNTIME_DIR/pi-daemon.sock" --json \
  '{"protocolVersion":"1.0","requestId":"attach-1","operation":"attach","sessionId":"agent-a","generation":1,"payload":{}}'
```

Readiness distinguishes protocol availability from Pi model/auth and recovery
availability. Probe exits `0` only for `host.ready: true`, `75` for a successful
but recovering/degraded handshake, and nonzero for transport/protocol failure.
Both connect and handshake are deadline bounded. Status retains safe recovery
phase, pending replay/mutation counts, indeterminate counts, failure-code counts,
metrics, memory, resident/retained sessions, turns, and draining state; it
excludes prompts, results, credentials, error text, and private paths.

## Shutdown

SIGTERM starts a 30-second whole-process shutdown deadline. SIGINT uses five
seconds. Transports stop admission first, active/queued turns are drained or
aborted, and adapter/extension disposal is raced against the remaining deadline.
A hung adapter is reported and abandoned rather than blocking process exit. In
direct CLI signal mode, an unreferenced hard-exit watchdog terminates only if
abandoned extension/runtime handles survive beyond the whole deadline. A
protocol `drain` command still accepts `payload.timeoutMs`.

Idle SDK sessions are evicted after 30 minutes by default while their durable
catalog and Pi session artifacts remain. Eviction emits `sessionDormant` and
`sessionEvicted`; re-open the same generation and policy to load the exact
resolved Pi session file again. A retained close removes the runtime manifest,
so it stays dormant across restart until explicitly reopened. Sweeps are
non-overlapping; disposal failure/timeout marks only that session failed and is
retained as a safe metric/code rather than becoming an unhandled rejection. Set
`--idle-session-ttl-ms 0` to disable eviction.

## Durable session catalog

Owner-private atomic catalog records live under
`state/catalog/<escaped-session-id>.json`. They retain immutable daemon ID,
optional exact unique name, generation/revision, resident/dormant state,
nonsecret normalized session spec, environment key/digest summary, current Pi
conversation identity, last-use timestamps, and the latest terminal outcome.
Raw environment values are rejected rather than serialized.

Catalog records are individually capped at 1 MiB, aggregate startup input is
capped at 256 MiB, and the retained record count is bounded. Listing is stable by canonical session ID, defaults to 50 entries,
caps at 100, and uses opaque cursors. A dormant record can be inspected, renamed or
replaced with optimistic generation/revision checks, reopened, or deleted with
its retained manifest/journal/Pi files without first creating an SDK runtime.
Daemon status exposes only counts; the additive session API exposes bounded
resources.

## Durable command tickets

Owner-private atomic mutation tickets live under `state/tickets/`. They are
bounded to 4096 records, 1 MiB each, 256 MiB aggregate recovery input, and seven
days for terminal or indeterminate retention by default. Ticket commands contain
only the persisted session spec plus environment key/digest summary; raw values
stay in the first host's volatile prepared runtime context. A queued
environment-dependent ticket found after restart fails `credentials_required`
rather than replaying with missing or host-global credentials.
The wake path continues to use the bounded per-session journal and derives an
opaque ticket ID from session/idempotency scope. Authenticated API responses are
preflighted against a 2 MiB structural JSON bound; an oversized list/result
becomes a typed `outbound_record_too_large` error before JSON/Buffer allocation.

## Restart recovery

At startup, manifest/catalog/journal counts, individual records, aggregate
bytes, per-session opens, and the total open phase are bounded. Manifests reopen
the resolved Pi session file recorded after the original create/continue/open
operation; the requested target is never rerun as though it were still
unresolved. Full secret-free runtime configuration is reconstructed. Durable
`queued` wakes then replay in the background while the transport listens, and
queued mutation tickets replay through their secret-free commands. `accepted` wakes and `running` mutations become
`indeterminate` and require client reconciliation. Readiness logs expose only
queued/indeterminate/pruned counts, never ticket commands or results.

A missing/corrupt Pi file, a legacy `new`/`continue` manifest without resolved
identity, or a generation mismatch blocks replay and is reported as a recovery
failure. Corrupt, permissive, mismatched, oversized, or symlinked state fails
closed rather than being ignored.

`memory` targets are explicitly resident-only: they have a catalog identity but
no runtime manifest or durable wake journal, remain dormant after restart, and
cannot be reopened as an empty replacement conversation.
