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

Choose non-overlapping daemon state, Pi agent, and allowed workload roots.
Repeat `--allow-root PATH` for each canonical root. Workload roots must already
exist because they are explicit authority grants. The daemon creates absent
private state, socket-parent, and agent directories before constructing the Pi
runtime.

```console
pi-daemon serve \
  --socket "$XDG_RUNTIME_DIR/pi-daemon.sock" \
  --state-dir "$HOME/.local/state/pi-daemon" \
  --agent-dir "$HOME/.pi/agent" \
  --allow-root "$HOME/work"
```

To enable the additive authenticated JSON listener, either let the daemon
create its stable default bearer file or configure exactly one external source.
Supplying bearer bytes as a CLI value is intentionally unsupported:

```console
pi-daemon serve \
  --socket "$XDG_RUNTIME_DIR/pi-daemon.sock" \
  --state-dir "$HOME/.local/state/pi-daemon" \
  --allow-root "$HOME/work" \
  --api-bind 127.0.0.1 \
  --api-port 7463
```

When no bearer source is supplied, first launch atomically generates an
owner-only bearer at `STATE_DIR/api-token`; later launches validate and reuse it.
`--api-token-file PATH` selects another generated-or-existing path. An inherited
secret descriptor (`--api-token-fd FD`) or `PI_DAEMON_BEARER_TOKEN` may be used
instead, but sources are mutually exclusive. Existing files must be owner-only,
regular, and non-symlinked and are never overwritten. The default bind is the
literal loopback address `127.0.0.1`. A non-loopback plaintext bind is refused unless
`--api-allow-insecure-http true` explicitly acknowledges trusted-network or TLS
reverse-proxy handling.

When `--agent-dir` differs from Pi's normal agent directory and has no
`auth.json`, first launch copies the normal owner-private `auth.json` once if it
exists. `--auth-seed-file PATH` names a required source explicitly. The seed is
bounded to 1 MiB, must be an owner-only regular JSON file, and never overwrites
an existing destination. Missing implicit auth leaves the service listening but
degraded so an operator can authenticate Pi later.

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

## Home Manager service instances

The flake exports `homeManagerModules.default` and the equivalent
`homeManagerModules.pi-daemon`. It can run any number of independently named
foreground daemon instances. Each instance has its own native service identity,
state/config directory, Unix socket, Pi agent/auth directory, API port, token
file, environment, roots, and logs:

```nix
{
  imports = [ inputs.pi-daemon.homeManagerModules.default ];

  services.pi-daemon.instances.work = {
    stateDir = "${config.xdg.stateHome}/pi-daemon-work";
    socketPath = "${config.xdg.runtimeDir}/pi-daemon-work.sock";
    agentDir = "${config.home.homeDirectory}/.pi-work";
    # Optional: otherwise a distinct agentDir seeds once from Pi's normal auth.
    authSeedFile = "${config.home.homeDirectory}/.pi/agent/auth.json";
    allowedRoots = [ "/srv/work" ];
    api = {
      enable = true;
      bind = "127.0.0.1";
      port = 17463;
      # Optional: otherwise stateDir/api-token is generated on first launch.
    };
    extraArgs = [ "--max-sessions" "32" "--max-concurrent-turns" "4" ];
  };
}
```

`home-manager switch` installs the package, creates native-supervisor log
parents, and enables `pi-daemon-work.service` on Linux systemd,
`com.pi-daemon.work` on Darwin launchd, or `pi-daemon-work` when a nix-on-droid
supervisord option surface is present. These identities cannot collide with
Cacophony's `cacophony.service` / `com.cacophony.lifecycle` identities.

```console
systemctl --user status pi-daemon-work
launchctl print "gui/$UID/com.pi-daemon.work"
supervisorctl status pi-daemon-work
```

Enabled instances must use unique `stateDir`, `socketPath`, stdout/stderr logs,
API ports, and effective token paths. Instance names are bounded
alphanumeric/hyphen identifiers. At least one explicit workload root and an API
port are required when those surfaces are enabled. An optional external
`tokenFile` contributes only its path to the Nix service definition, never its
bearer bytes. `extraArgs` may set resource limits but
cannot override module-managed identity, root, path, or API arguments.

## Nix-on-Droid cache bootstrap

Pi Daemon remains a Node service even though the interactive Pi CLI can be
packaged as a Bun binary. Its pinned SDK dependencies are installed by npm at
build time. Node/npm can abort with `double free or corruption` when that build
runs natively inside Nix-on-Droid, so Android devices must consume a prebuilt
`aarch64-linux` closure rather than fall back to a local build.

Build the exact locked flake package on an off-device NixOS host with
`aarch64-linux` binfmt support, then push the output closure to the private
Attic cache used by the devices:

```console
out=$(nix build --no-link --print-out-paths \
  github:harryaskham/pi-daemon/REV#packages.aarch64-linux.pi-daemon)
attic push -j1 SERVER:collective "$out"
```

The aarch64 package still builds, prunes, and runs both installed version checks
under emulation. The full Node test suite is intentionally gated on Linux
x86_64 and macOS: under QEMU, RSS can report zero and bounded subprocess tests
exceed their real-hardware deadlines. Skipping the emulated package check is not
a native-Android fallback; cache population is required before switching Astra,
SGU24, or another Nix-on-Droid consumer. A cache miss that starts `npm ci` on the
device is an operational error—stop it, prebuild the same derivation off-device,
push it, and retry the unchanged generation.

## High-level session management

`pi-daemon session`, `ticket`, `prompt`, `control`, `rpc`, and `acp` provide
bounded JSON commands over either the owner-only Unix socket or authenticated
API. Bearers remain file/fd/environment-only, mutations carry idempotency and
stale generation/revision checks, and endpoint discovery never prints token
values. See [Session management CLI](session-cli) for examples.

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
