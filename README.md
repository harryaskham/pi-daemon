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
> `pi-daemon-rpc` stdio bridge, in-process ACP translation, and the first Pi
> Daemon Dash foundation are implemented. Dash now includes a packaged
> content-hashed SPA, preview-only transcript projection, secure browser BFF,
> signed revocable cookie exchange, revisioned workspace/UI-settings stores,
> a native durable IANA-timezone scheduler with restart-safe prompt tickets and
> Dash countdown/editor/history, persisted 10k-session inventory, rich transcript rendering, durable direct/fork
> ownership and export, the neutral service-bearer Dash API, coalesced embedded
> and dedicated Rich/TUI backends with bounded reconnect, and a bounded
> in-process shadow-terminal host, authenticated browser stream routing, and a
> standalone dedicated `pi-daemon web` lifecycle over the remote backend, and
> the production same-origin browser client for input-only login, persisted
> inventory/workspace/settings, preview-first hydration, multiplexed Rich/TUI
> streams, correlated commands, replay recovery, liveness, extension UI, inert
> server-validated declarative extension views with scoped actions/TUI fallback,
> a virtualized full branch-tree navigator with compare/edit/fork/clone and
> capability-gated in-place summarize/navigation, durable activation-recency
> ordering independent of source mtime, and a polished lazy New
> Session flow that performs no Pi runtime/model/tool
> work until its exactly-once first message.
> Full credential-free install/CRUD/RPC/ACP/restart/security acceptance is green;
> the repository is a release candidate, but no release tag is cut yet.

**Start here:** [Operator quickstart](docs/quickstart.md) — run collision-free
Home Manager instances, use the authenticated session API, and attach RPC or
ACP clients without putting the service bearer in process arguments.

**Fresh-node test runner:** from a checkout, run `nix develop -c just
test-daemon`. It creates a safe node-local config if absent, Nix-builds/tests
exact main, and starts an isolated non-service tmux instance. See
[Rolling non-launchd test instance](docs/operations.md#rolling-non-launchd-test-instance).

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

# Dedicated Dash over the authenticated service API (defaults: API 7463,
# dedicated Dash 7465; the token is read from its owner-only file).
pi-daemon web --config ~/.config/pi/daemon/work/config.yaml --instance work

pi-daemon probe --socket /run/user/1000/pi-daemon.sock
pi-daemon request --socket /run/user/1000/pi-daemon.sock --json '{...}'
pi-daemon version

# Present a retained session as stock Pi RPC JSONL on stdin/stdout.
# PI_DAEMON_BEARER_TOKEN is memory-only; --token-file/--token-fd are preferred.
pi-daemon-rpc --url http://127.0.0.1:7463 --session exact-id-or-name \
  --token-file ~/.local/state/pi-daemon/api-token
```

With an enabled embedded `web` block, the same `serve` process starts the
packaged browser BFF after its owner socket/API are ready. Open `/dash/` on the
configured loopback web port (for example `http://127.0.0.1:7464/dash/`). Enter
the owner-private `STATE_DIR/web-token` (or configured `web.auth.tokenFile`)
credential in the login form; the SPA exchanges it once for an HttpOnly browser
session and never stores it. A `web.mode: dedicated` configuration is instead
served by `pi-daemon web`, which
uses the service API on 7463 and defaults its independent browser listener to
7465. Never put either service or web credentials in the URL.

Remote browser deployments may keep the listener on loopback behind an HTTPS
reverse proxy (recommended), or configure native HTTPS/WSS with an exact
`web.publicOrigin` plus bounded certificate/private-key file or inherited-fd
sources. Native TLS is required for a non-loopback bind, enforces matching SNI,
Host, Origin and optional loopback proxy evidence, emits HSTS with Secure
`__Host-` cookies, and atomically reloads valid file-backed pairs while retaining
the last good context on failure. `GET|HEAD /dash/healthz` is a content-free
no-store transport probe. Certificate/key bytes never enter YAML, argv, Nix
store values, status, or logs. See
[Dashboard transport security](docs/dashboard-transport-security.md).

Both executables treat an `EPIPE` from stdout or stderr as a normal early-closing
Unix pipeline consumer and exit quietly with status 0. Other stream errors remain
fatal and are never hidden by the closed-pipe guard.

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
Dashboard activations use the owner-configured `web.runtimePolicy` for that
bounded authority and otherwise remain no-tools/no-extensions. Direct and fork
activation restore the source active branch's provider, model, and thinking
level before the first turn; model selection never falls through to arbitrary
registry order when the source records an authenticated model.

The protocol is versioned UTF-8 NDJSON over an owner-only Unix socket. Host
status and handshake responses include bounded counters, recovery/degraded
state, resident-session state, nondestructive redacted adapter readiness,
uptime, and memory. Probe returns temporary failure while recovering/degraded.
Service logs omit prompts, outputs, credentials, and private paths. SIGTERM uses
a 30-second whole-shutdown deadline, SIGINT five seconds, and idle SDK sessions
are evicted after 30 minutes by default (`--idle-session-ttl-ms 0` disables it).

The language-neutral v1 [`protocol.schema.json`](protocol.schema.json), additive
v2 [`protocol-v2.schema.json`](protocol-v2.schema.json), scoped
[`tool-adapter.schema.json`](tool-adapter.schema.json), checked fixtures under
[`fixtures/`](fixtures/), and exported TypeScript protocol types are the
compatibility contract. See the [protocol design](PLAN.md#6-protocol)
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
An opt-in stable service shim can prefer verified atomic releases from
`~/.local/bin/pi-daemon` while retaining the immutable Nix package as fallback,
so subsequent `pi-daemon update` runs do not require a full system rebuild; see
[User-local release updates](docs/operations.md#user-local-release-updates).

## Documentation

- [`docs/quickstart.md`](docs/quickstart.md) — secure Home Manager, session API, RPC, and ACP operator quickstart
- [`PLAN.md`](PLAN.md) — architecture, protocol, rollout, and provisional beads
- [`docs/session-api.md`](docs/session-api.md) — additive session CRUD, Pi RPC attach, and `/apc` ACP contract
- [`docs/tool-adapter-protocol.md`](docs/tool-adapter-protocol.md) — protocol-v2 host/session-bound fixed filesystem capability
- [`docs/dashboard-protocol.md`](docs/dashboard-protocol.md) — Dash browser/backend contract, limits, identity, and performance budgets
- [`docs/dashboard-session-tree.md`](docs/dashboard-session-tree.md) — virtual branch navigation, active-leaf truth, compare/edit/fork/clone, and framed summarize/navigation
- [`docs/transcript-projection.md`](docs/transcript-projection.md) — preview-only Pi JSONL active-branch projection, cache, paging, and bounds
- [`docs/dashboard-ownership.md`](docs/dashboard-ownership.md) — direct/fork ownership, leases, conflict guards, export, and release
- [`docs/dashboard-session-drafts.md`](docs/dashboard-session-drafts.md) — lazy no-runtime session drafts and first-send crash semantics
- [`docs/dashboard-service-api.md`](docs/dashboard-service-api.md) — neutral service-bearer Dash API and TUI negotiation for remote backends
- [`docs/dashboard-acceptance.md`](docs/dashboard-acceptance.md) — live dual-mode browser, security, bundle/performance, and soak receipts
- [`docs/shadow-tui.md`](docs/shadow-tui.md) — in-process virtual terminal, control policy, performance proof, and Pi view seam
- [`docs/session-cli.md`](docs/session-cli.md) — high-level session CRUD, tickets, prompt/control, and endpoint discovery
- [`docs/schedules.md`](docs/schedules.md) — native durable timers, authenticated schedule CRUD/status, ETags, safe file-backed CLI/config imports, and external-timer coexistence
- [`docs/scheduler-acceptance.md`](docs/scheduler-acceptance.md) — measured all-IANA DST, clock-jump, restart, overlap, secrecy, and soak release receipt
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
