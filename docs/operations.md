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

Optional limits:

```text
--max-sessions N
--max-concurrent-turns N
--max-session-queue-depth N
--idle-session-ttl-ms N
```

The service emits structured JSON lifecycle logs to stderr. It never logs
prompts or model output. A `pi_daemon_ready` record includes the socket, host
instance, and bounded recovery counts.

## Probe and status

```console
pi-daemon probe --socket "$XDG_RUNTIME_DIR/pi-daemon.sock"

pi-daemon request --socket "$XDG_RUNTIME_DIR/pi-daemon.sock" --json \
  '{"protocolVersion":"1.0","requestId":"status-1","operation":"status","payload":{}}'
```

Readiness distinguishes protocol availability from Pi model/auth availability.
Status includes counters, latency summaries, memory, resident sessions, active
and queued turns, and draining state; it excludes prompts, results, and secrets.

## Shutdown

SIGTERM starts a 30-second drain. SIGINT uses five seconds. A protocol `drain`
command accepts `payload.timeoutMs`. New open/wake requests are rejected once
drain starts; after the deadline, queued and active turns are aborted.

Idle SDK sessions are evicted after 30 minutes by default while their durable
manifest/session artifacts remain. Re-open the same generation to load it
again. Set `--idle-session-ttl-ms 0` to disable eviction.

## Restart recovery

At startup, manifests are reopened before the socket becomes ready. Durable
`queued` wakes replay; `accepted` wakes become `indeterminate` and require
client reconciliation. Corrupt, permissive, mismatched, or symlinked state
fails closed rather than being ignored.
