# Pi Daemon

[![CI](https://github.com/harryaskham/pi-daemon/actions/workflows/ci.yml/badge.svg)](https://github.com/harryaskham/pi-daemon/actions/workflows/ci.yml)
[![Pages](https://github.com/harryaskham/pi-daemon/actions/workflows/pages.yml/badge.svg)](https://a.skh.am/pi-daemon/)

Pi Daemon is a standalone, general-purpose service that multiplexes many
on-demand [Pi](https://github.com/earendil-works/pi) SDK agent sessions inside
one long-lived Node process.

It shares process-global Pi module code, provider authentication storage, and
model metadata while retaining a separate session tree, settings instance,
command queue, events, and idempotency state for every logical session. The
implemented no-tools scaffold creates **no process per session or wake**. The
full target retains that unisolated in-process mode while adding durable session
CRUD by ID/name, an additive authenticated JSON API, multi-reader Pi RPC
attachment, an ACP adapter, and a stock-compatible RPC stdio attach client. Stronger isolation modes are
future backends rather than an in-process security claim.

Pi Daemon is not a Cacophony component. Cacophony can deploy and consume it, but
the service protocol contains no beads, Cacophony agents, messages, profiles,
or Cacophony credentials.

> **Status:** durable resident/dormant CRUD, bearer-authenticated JSON admission,
> asynchronous mutation/prompt tickets, exact Pi conversation recovery, bounded
> serialization, per-session runtime configuration, truthful bounded
> recovery/shutdown, full multi-reader Pi RPC attachment, the remote
> `pi-daemon-rpc` stdio bridge, and in-process ACP translation are implemented.
> Full credential-free install/CRUD/RPC/ACP/restart/security acceptance is green;
> the repository is a release candidate, but no release tag is cut yet.

**Start here:** [Operator quickstart](docs/quickstart.md) — run collision-free
Home Manager instances, use the authenticated session API, and attach RPC or
ACP clients without putting the service bearer in process arguments.

## Why

Starting one `pi --mode rpc` process for every logical agent or every cold wake
repeats Node startup, module loading, provider/model setup, and process
supervision. Pi's supported SDK can host multiple independent `AgentSession`
instances in one Node process. Pi Daemon turns that capability into a bounded,
durable, observable service with a neutral local protocol.

A feasibility probe created two concurrent live SDK sessions in one process,
shared `AuthStorage` and `ModelRegistry`, received independent model responses,
and observed zero `child_process` calls during session creation or no-tool
turns.

## CLI

```console
pi-daemon serve --socket /run/user/1000/pi-daemon.sock \
  --state-dir ~/.local/state/pi-daemon \
  --allow-root ~/work

# Optional authenticated JSON/WebSocket admission boundary.
# With no explicit bearer source, first launch creates and reuses the
# owner-only token at STATE_DIR/api-token:
pi-daemon serve --socket /run/user/1000/pi-daemon.sock \
  --state-dir ~/.local/state/pi-daemon --allow-root ~/work \
  --api-bind 127.0.0.1 --api-port 7463

# Equivalent service values may come from
# ~/.config/pi/daemon/INSTANCE/config.yaml; individual CLI flags override YAML.
pi-daemon serve --config ~/.config/pi/daemon/work/config.yaml --instance work

pi-daemon probe --socket /run/user/1000/pi-daemon.sock
pi-daemon request --socket /run/user/1000/pi-daemon.sock --json '{...}'
pi-daemon version

# Present a retained session as stock Pi RPC JSONL on stdin/stdout.
# PI_DAEMON_BEARER_TOKEN is memory-only; --token-file/--token-fd are preferred.
pi-daemon-rpc --url http://127.0.0.1:7463 --session exact-id-or-name \
  --token-file ~/.local/state/pi-daemon/api-token
```

On first launch, `serve` creates and validates its private state, socket, and Pi
agent directories. When a custom `--agent-dir` has no `auth.json`, it seeds once
from Pi's normal owner-private auth file if present; `--auth-seed-file` selects a
required source explicitly. Existing auth and bearer files are never overwritten
or rotated.

`serve` uses one process-global Pi `AuthStorage` and `ModelRegistry` from the
configured `--agent-dir` while creating one `AgentSessionRuntime` with isolated
session managers, settings, resource loaders, and rebound event subscriptions
per logical session. Authenticated creation supports bounded typed Pi-equivalent
model/tool/resource/settings policy and a memory-only environment overlay.
Because arbitrary extensions share the process trust domain, they require an
explicit trusted project/configuration policy; `unisolated` is not a sandbox.

The protocol is versioned UTF-8 NDJSON over an owner-only Unix socket. Host
status and handshake responses include bounded counters, recovery/degraded
state, resident-session state, nondestructive redacted adapter readiness,
uptime, and memory. Probe returns temporary failure while recovering/degraded.
Service logs omit prompts, outputs, credentials, and private paths. SIGTERM uses
a 30-second whole-shutdown deadline, SIGINT five seconds, and idle SDK sessions
are evicted after 30 minutes by default (`--idle-session-ttl-ms 0` disables it).

The language-neutral [`protocol.schema.json`](protocol.schema.json), checked
fixtures under [`fixtures/`](fixtures/), and exported TypeScript protocol types
are the compatibility contract. See the [protocol design](PLAN.md#6-protocol)
and, as implementation lands, the published [documentation site](https://a.skh.am/pi-daemon/).

## Safety defaults

The first release deliberately starts narrow:

- no built-in tools;
- no arbitrary project extensions;
- explicit canonical working roots;
- owner-only local socket;
- bounded requests, queues, sessions, turns, buffers, and drain;
- content/auth redaction in logs and status;
- no blind replay after an indeterminate accepted request;
- durable wakes replay only after the exact resolved Pi conversation reopens;
- memory sessions are resident-only and never journaled for crash replay;
- one isolated `AgentSessionRuntime`, `SessionManager`, and settings domain per logical session.

A shared process is a shared trust boundary, not a sandbox. Workloads requiring
arbitrary extensions or process/filesystem tools need a separate trust domain.
See [`SECURITY.md`](SECURITY.md).

## Development

Requirements:

- Node.js 22.19 or newer;
- npm;
- Nix with flakes (recommended).

```console
nix develop
npm ci
npm test
nix flake check
```

The Pi SDK version and npm dependency graph are pinned. Strict TypeScript is the
source language; built JavaScript and declarations are emitted under `dist/`.

## Nix consumer contract

The checked-in flake exposes `packages.default`, `packages.pi-daemon`,
`apps.default`, `apps.pi-daemon`, `apps.pi-daemon-rpc`,
`homeManagerModules.default` (`homeManagerModules.pi-daemon`), package/site/module
checks, and `devShells.default` on Linux and macOS:

```nix
inputs.pi-daemon.url = "github:harryaskham/pi-daemon";
inputs.pi-daemon.inputs.nixpkgs.follows = "nixpkgs";
```

The standalone lock follows the fleet's warm nixpkgs baseline; consumers should
use `nixpkgs.follows` so Pi Daemon shares their own evaluated package set. A
Cacophony node can therefore consume the reproducible package without copying
service source into Cacophony. The Home Manager module creates independently
named user services through systemd on Linux, launchd on Darwin, or conditional
supervisord on nix-on-droid; see [Operations](docs/operations.md#home-manager-service-instances).

## Documentation

- [`docs/quickstart.md`](docs/quickstart.md) — secure Home Manager, session API, RPC, and ACP operator quickstart
- [`PLAN.md`](PLAN.md) — architecture, protocol, rollout, and provisional beads
- [`docs/session-api.md`](docs/session-api.md) — additive session CRUD, Pi RPC attach, and `/apc` ACP contract
- [`docs/dashboard-protocol.md`](docs/dashboard-protocol.md) — Dash browser/backend contract, limits, identity, and performance budgets
- [`docs/transcript-projection.md`](docs/transcript-projection.md) — preview-only Pi JSONL active-branch projection, cache, paging, and bounds
- [`docs/session-cli.md`](docs/session-cli.md) — high-level session CRUD, tickets, prompt/control, and endpoint discovery
- [`session-api.schema.json`](session-api.schema.json) / [`session-api.openapi.json`](session-api.openapi.json) — machine-readable session API
- [`SECURITY.md`](SECURITY.md) — trust boundary and vulnerability reporting
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — development workflow
- [`CHANGELOG.md`](CHANGELOG.md) — release history
- [`docs/acceptance.md`](docs/acceptance.md) — live multiplex/zero-child-process proof
- [`docs/pi-sdk-compatibility.md`](docs/pi-sdk-compatibility.md) — exact SDK acquisition, compatibility gates, upgrades, and rollback
- [`docs/pi-rpc-host.md`](docs/pi-rpc-host.md) — in-process full Pi RPC command/event/UI semantics
- [`docs/rpc-bridge.md`](docs/rpc-bridge.md) — authenticated stock-RPC stdio client and reconnect semantics
- [`docs/acp-adapter.md`](docs/acp-adapter.md) — in-process upstream ACP translation at the `/apc` route
- [`docs/release.md`](docs/release.md) — release and rollback checklist
- `docs/` — published protocol, operations, security, and integration guides

## License

MIT. See [`LICENSE`](LICENSE).
