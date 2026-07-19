# Pi Daemon — implementation plan

Status: v0.1.0 no-tools scaffold implemented; full standalone host audited and not yet release-ready
Repository: `git@github.com:harryaskham/pi-daemon.git`  
Initial owner: `ms-mac-cacophony-caco-dev-msm-2`  
Architecture decision: Cacophony `decision-019f539c-e3ae-7f82-859d-c2db8eedd21d`

## 1. Purpose

Pi Daemon is a standalone, general-purpose multiplexer for the supported
`@earendil-works/pi-coding-agent` SDK. One long-lived Node process owns many
independent Pi `AgentSessionRuntime` instances and runs turns on demand.

The daemon is intentionally not coupled to Cacophony. It does not know about
beads, Cacophony agents, messages, profiles, bearer tokens, or daemon state.
Cacophony will later deploy one Pi Daemon per node and consume the neutral local
protocol, but that integration lives in Cacophony rather than this service.

The immediate efficiency target is **zero process creation per logical session
or wake** for the supported minimal tool profile. One supervised Pi Daemon
process replaces repeated `pico --resume` / `pi --mode rpc` process creation,
while preserving one distinct Pi session tree per logical agent.

## 2. Verified feasibility

Using Pi 0.80.3 in one Node 26 process:

- two distinct `AgentSession` instances were created concurrently;
- both shared one `AuthStorage` and one `ModelRegistry`;
- each used an isolated `SessionManager` and settings instance;
- two concurrent live `github-copilot/gpt-5-mini` turns returned independent
  `A` and `B` responses;
- instrumentation installed before importing Pi observed no calls to
  `child_process.spawn`, `exec`, `execFile`, or `fork` during session creation
  or either no-tool turn.

This proves the supported SDK can provide the core multiplexing behavior. The
remaining work is protocol, durability, supervision, security policy,
backpressure, packaging, and operational quality.

## 3. Product principles

1. **General-purpose first.** The protocol speaks in logical sessions, prompts,
   events, and capabilities. Client-specific orchestration stays outside.
2. **One process, many sessions.** Process-global module code, provider auth,
   and model metadata are shared. Conversation/session state is never shared.
3. **No ambient authority.** A client supplies an explicit working root,
   resource policy, and any scoped tool capabilities for each logical session.
4. **Safe by default.** Initial release supports `tools: none`. Arbitrary bash,
   filesystem tools, and unreviewed extensions are disabled.
5. **Durability before retries.** Request acceptance is persisted before a turn
   starts. Duplicate request IDs never create two live turns.
6. **Bounded everything.** Connections, request lines, event queues, active
   sessions, concurrent turns, retained results, and memory-facing buffers have
   explicit limits.
7. **Observable state.** Health distinguishes process liveness, protocol
   readiness, model/auth readiness, and logical-session readiness.
8. **Additive evolution.** Versioned, forward-tolerant protocol messages allow
   Cacophony and other clients to evolve independently.

## 4. Scope

### Implemented v0.1 scaffold

PD-001 through PD-012 implemented and tested a deliberately narrow substrate:

- Node 22.19+ standalone executable source (`pi-daemon`).
- Owner-only Unix-domain socket NDJSON protocol on Linux/macOS.
- Shared `AuthStorage` and `ModelRegistry`.
- Persistent or in-memory logical session slots.
- Operations: handshake, open, wake/prompt, steer, follow-up, status, abort,
  close, and drain.
- Streamed Pi lifecycle/message/tool events.
- Per-session serialization and a global turn semaphore.
- Durable wake idempotency/result journal with explicit indeterminate handling.
- Metrics/status snapshots, structured logs, Nix packaging, GitHub workflows,
  Pages documentation, a JavaScript client, and a protocol JSON schema.

This is useful evidence, but it is **not** the complete daemon-host product and
must not be tagged as the full v0.1 release. In particular, the installed npm
binary and clean tarball are currently broken, durable `new`/`memory` sessions
do not preserve Pi conversation identity across restart, and the protocol does
not yet provide durable CRUD or an attachable full Pi runtime.

### Audited full-host target

The completed product adds, without removing the existing NDJSON mode:

- durable session CRUD by immutable ID or unique name, including resident and
  dormant sessions;
- an authenticated JSON API on a configurable bind address, initially protected
  by one server-wide bearer token;
- `/session/{id-or-name}/rpc`, exposing stock Pi RPC command/event semantics
  against an in-process `AgentSessionRuntime`, with multiple readers;
- `/session/{id-or-name}/apc`, preserving the operator-requested route spelling
  while translating the upstream Agent Client Protocol (ACP / `pi-acp`);
- durable asynchronous admission tickets and terminal/indeterminate request
  reconciliation;
- Pi CLI-equivalent typed session creation: cwd/session target, model/thinking,
  tools, resources, settings, trust, extensions, prompts, skills, packages,
  images, and an explicitly bounded environment policy;
- a Pi-RPC-compatible stdio bridge first, followed by a standalone attach TUI or
  stock-Pi `/connect <session>` extension where the upstream UI seam permits it;
- explicit isolation capabilities. `unisolated` in-process execution is the
  honest default; stronger tool-routing, container, or VM modes are additive.

### Still deferred or downstream

- Windows named-pipe transport.
- Built-in TLS termination (non-loopback HTTP may use a documented TLS reverse
  proxy; plaintext non-loopback binding must require an explicit insecure opt-in).
- Strong isolation for arbitrary extensions inside the shared Node heap.
- Cluster-wide host placement.
- Cacophony deployment, agent lifecycle mapping, and its `pico-daemon` adapter.
- Native Rust agent loop (tracked separately in Cacophony as `bd-5b0910`).

## 5. Runtime architecture

```text
NDJSON/UDS clients     JSON CRUD clients     RPC readers     ACP clients
        │                      │                   │              │
        └──────────── transport/auth/protocol adapters ──────────┘
                                   │
                                   ▼
                    SessionRegistry / RuntimeController
                      ├── durable catalog + request tickets
                      ├── global turn semaphore
                      ├── shared host auth/model defaults
                      └── sessions: Map<daemonSessionId, SessionSlot>
                            ├── AgentSessionRuntime / active AgentSession
                            ├── scoped auth/model/resource/settings bundle
                            ├── Pi SessionManager + conversation identity
                            ├── serialized command tail
                            ├── bounded event replay + attach fan-out
                            └── terminal result cache
```

The service never exposes live Pi SDK objects over the wire. Protocol records
are plain JSON and remain stable independently of Pi's internal TypeScript API.
Shared host auth/model defaults are an optimization, not a requirement that all
sessions use one configuration; a trusted session spec may request its own
scoped SDK services.

Identity is deliberately not one overloaded string. A session has an immutable
daemon session ID, an optional mutable unique name, a daemon generation for
configuration/runtime replacement, a current Pi conversation/session-file ID,
a host/runtime incarnation, and an attach event sequence cursor. Pi
new/switch/fork/clone may change conversation identity without silently changing
the daemon ID; PUT replacement increments daemon generation when policy requires
it.

## 6. Protocol

Transport is UTF-8 NDJSON. Each line is one object and is bounded (initially
1 MiB). Unknown fields are ignored. Unknown operation names receive a typed
error. Protocol major-version mismatch is fatal; minor additions are
forward-compatible.

### Common envelope

Client command:

```json
{
  "protocolVersion": "1.0",
  "requestId": "req-...",
  "operation": "wake",
  "sessionId": "logical-agent-a",
  "generation": 3,
  "idempotencyKey": "message-or-heartbeat-correlation-id",
  "payload": {}
}
```

Server response/event:

```json
{
  "protocolVersion": "1.0",
  "kind": "response",
  "requestId": "req-...",
  "sessionId": "logical-agent-a",
  "hostInstanceId": "...",
  "sequence": 42,
  "ok": true,
  "data": {}
}
```

### Operations

- `handshake`: versions, host instance, capabilities, limits, package/runtime
  versions, draining state.
- `open`: logical session ID, cwd/root, session target, model/thinking policy,
  resource policy, persistence policy.
- `wake`: prompt and optional images/source metadata.
- `steer` / `followUp`: streaming-session queue controls.
- `status`: one session or host aggregate.
- `abort`: cancel the current logical session turn.
- `close`: dispose a logical session; optionally retain durable JSONL.
- `drain`: supervisor-only stop-admission and bounded turn drain.

### Events

- `opened`, `openFailed`
- `promptAccepted`, `preflightRejected`
- `agentStart`, `messageUpdate`, `toolStart`, `toolUpdate`, `toolEnd`, `agentEnd`
- `requestFailed`
- `sessionIdle`, `sessionClosed`
- `hostDraining`

Every event carries host instance, logical session, generation, and a monotonic
per-session sequence number. Clients discard events from stale generations.

## 7. Logical session lifecycle

```text
absent -> opening -> idle -> running -> idle -> closing -> absent
                    │       │
                    └---- failed / indeterminate
```

- `open` is idempotent for the same session generation and equivalent policy.
- A changed cwd/resource policy/model envelope requires a generation increment.
- One session may have at most one active model turn.
- Steering/follow-up uses Pi's supported queue semantics.
- Closing one session cannot stop or mutate another.
- Idle session eviction disposes in-memory SDK state but retains the JSONL target
  and manifest for a later warm-ish reopen.

## 8. Durability and idempotency

The scaffold layout is:

```text
state/
  host.json
  sessions/<escaped-session-id>/manifest.json
  sessions/<escaped-session-id>/pi/*.jsonl
  journal/<escaped-session-id>.jsonl
```

The full catalog extends each session with a nonsecret normalized spec, daemon
ID/name/generation, active Pi conversation identity, resident/dormant state,
host incarnation, bounded request ticket/result metadata, and attach cursor
retention. Raw env values, bearer tokens, provider credentials, and API keys are
never persisted; manifests carry secret references or `credentials-required`
state instead.

Request journal states:

- `queued`: persisted but not submitted to Pi; safe to replay after restart.
- `accepted`: submitted/accepted by Pi; a crash makes terminal status
  `indeterminate` until session evidence is reconciled. Never blind-replay.
- `completed`: terminal response cached; duplicate calls return it.
- `failed`: terminal preflight/runtime error cached according to retry policy.

The daemon fsyncs/atomically renames manifests and appends journal transitions.
A duplicate live request joins the existing promise. A duplicate terminal
request receives the cached terminal record. Bounded retention prunes only
terminal entries after age/count thresholds.

Pi does not currently expose a transactionally durable prompt id, so the daemon
must not claim impossible exactly-once semantics across a host crash between
provider completion and journal completion. The protocol reports that narrow
window as `indeterminate`; clients reconcile session history before deciding.
This preserves at-most-once automatic submission rather than silently creating
a duplicate model turn.

## 9. Concurrency and backpressure

- Global `maxConcurrentTurns` semaphore (default 4).
- `maxSessions` (default 128).
- Per-session serialized command queue (default depth 32).
- Maximum connected clients (default 64).
- Maximum NDJSON line (default 1 MiB).
- Bounded outbound queue per connection; slow clients are disconnected with a
  typed overflow reason rather than growing memory indefinitely.
- Queue wait and turn duration are measured separately.
- Host drain rejects new open/wake requests and waits a bounded interval before
  aborting/reclassifying remaining accepted requests.

## 10. Security and isolation

A shared Node process is a shared trust boundary, not a sandbox.

The implemented scaffold policy is no-tools and locked resources:

- `DefaultResourceLoader` discovery is disabled and `noTools: "all"` is enforced.
- Cwd/root is canonicalized under an allowlisted root and may not overlap daemon
  state or Pi credential roots.
- The Unix socket is owner-only (`0600`) and its directory may not be
  group/world writable.
- Request payloads, logs, status, and metrics must not expose API keys or raw
  credentials.

The full-host target broadens capability without pretending that in-process
configuration is a sandbox:

- the existing owner-only NDJSON socket remains a supported control mode;
- the additive API defaults to loopback, uses one configured server bearer, and
  authenticates HTTP and stream upgrades before reading bodies;
- the bearer comes from an owner-private token file, file descriptor, or runtime
  secret environment, never a CLI argument, manifest, status response, or log;
- all authenticated callers initially share one service trust domain. Explicit
  attach/detach still controls event routing; status or failed commands must
  never subscribe a connection implicitly;
- `isolation: "unisolated"` means extensions, SDK code, tools, module globals,
  `process.env`, and process cwd share one Node trust domain. The daemon never
  swaps process-wide environment or cwd around concurrent turns;
- per-session provider credentials/env use scoped SDK auth where supported, and
  built-in tool env uses scoped operations/spawn hooks. Raw secrets are not
  written into session manifests or journals; after restart a session may report
  `credentials-required` until secrets are reprovisioned;
- arbitrary extensions/packages are loaded only under explicit trusted policy.
  Shell-grade env/config isolation requires a future process/container/VM or an
  upstream Pi isolation seam;
- the service accepts no Cacophony node bearer, CA key, daemon state, bead,
  profile, or orchestration object.

Sharing provider auth is acceptable only among operator-trusted logical
sessions. Stronger isolation modes must state which of filesystem, process,
network, credential, extension, and provider state they actually isolate.

## 11. Failure containment and supervision

- Unhandled session errors transition only that `SessionSlot` to failed.
- Process-level uncaught exceptions are logged structurally and exit non-zero so
  the external supervisor restarts the host.
- `hostInstanceId` changes on restart; stale events cannot mutate current client
  state.
- Session manifests are reopened lazily from disk.
- Health reports: alive, protocol-ready, auth/model availability, draining,
  session counts, queue depth, and last fatal/restart evidence.
- SIGTERM enters drain mode; SIGINT does the same with a shorter deadline.
- Socket replacement is atomic and stale socket cleanup checks ownership.

## 12. Observability

Structured JSON logs include operation, request/session IDs, state transition,
queue wait, turn duration, result class, and error code. Prompt text, model
output, auth, and environment are omitted by default.

Status metrics:

- host uptime/version/runtime/Pi version
- total/resident/running/failed sessions
- queued/running/completed/failed/indeterminate requests
- global semaphore utilization
- cold/warm open latency
- queue and turn latency histograms
- dedup joins/hits
- evictions
- host generation/restart count
- RSS/heap usage

## 13. CLI

Implemented scaffold commands:

```text
pi-daemon serve --socket PATH --state-dir PATH [limits]
pi-daemon probe --socket PATH
pi-daemon request --socket PATH --json REQUEST
pi-daemon version
```

Planned additive host/client inputs:

```text
pi-daemon serve --bind HOST:PORT --bearer-token-file PATH [--socket PATH] ...
pi-daemon-rpc --endpoint URL --session ID_OR_NAME [--token-file PATH]
pi-daemon attach --endpoint URL --session ID_OR_NAME
```

`serve` remains the service entrypoint and may expose both control modes.
Bearer secrets are never accepted as argv values. `probe` performs
handshake/status and exits non-zero on incompatibility, unavailable auth/model,
or degraded recovery. `request` is a low-level integration/debugging tool and
never prints secrets. `pi-daemon-rpc` is the stock Pi RPC JSONL stdio bridge;
`attach` is the eventual operator TUI/extension-facing client.

## 14. Packaging and Nix

- Node engine: `>=22.19`.
- Exact compatible Pi SDK dependency pinned in lockfile.
- TypeScript strict build with declaration output.
- Nix flake exposes:
  - `packages.default` / `packages.pi-daemon`
  - `apps.default`
  - `checks` running build/tests/protocol fixtures
  - `devShells.default`
  - formatter
- Package installs a runnable `pi-daemon` executable and contains no Cacophony
  runtime dependency.
- Reproducible npm dependency hash is pinned.

Cacophony can later consume the flake as an input and configure the service
under `services.pi-daemon`; that work is intentionally out of this repository.

## 15. Test strategy

### Unit

- protocol validation and forward compatibility
- semaphore and per-session serialization
- open policy equivalence/generation checks
- idempotency join/hit/terminal retention
- journal and manifest atomicity
- state transitions and failure isolation
- path/root/socket security
- drain and bounded queues

### Integration (fake SDK adapter)

- two concurrent logical sessions
- duplicate wake creates one adapter call
- global concurrency cap
- one session failure does not affect another
- restart with queued/accepted/completed journal states
- UDS request/response/event framing
- slow/malformed/oversized client behavior

### Optional live SDK

Opt-in test creates two real no-tool Pi sessions in one process, performs
concurrent minimal turns, and instruments child-process APIs. It is never part
of credential-free CI.

### End-to-end consumer

A later Cacophony integration test launches the Nix package as a service,
creates multiple logical `pico-daemon` agents, wakes them, and proves no new
process appears per wake.

## 16. CI, release, and Pages

- PR/push CI: `npm ci`, strict build, Node tests, `nix flake check`.
- Dependency updates through Dependabot.
- Tag release builds the Nix package and attaches npm tarball/checksum to GitHub
  release; npm registry publication remains opt-in.
- GitHub Pages publishes a static product/protocol/security/operations site.
- Branch protection should require build/test and Nix checks.

## 17. Delivery sequence

### Completed scaffold sequence

1. Repository contract, protocol types/schema, fake adapter, core multiplexer.
2. UDS server and CLI probe/request tools.
3. Real Pi SDK adapter with locked-down `ResourceLoader` and persistence.
4. Durable wake journal/restart/indeterminate handling.
5. Limits, metrics, structured logs, drain/signal behavior.
6. Nix packaging source and service artefacts.
7. CI, release automation, Pages site, operator docs.
8. Live optional multiplex smoke and scaffold acceptance report.

### Audited full-host sequence

1. Land the additive protocol/API contract and fix clean installed packaging.
2. Acquire the current supported Pi SDK and make `AgentSessionRuntime` the slot
   core, preserving real conversation identity across restart/replacement.
3. Add the durable session catalog, CRUD, and asynchronous request tickets.
4. Add bearer-authenticated JSON transport while retaining NDJSON equivalence.
5. Implement transport-neutral full Pi RPC dispatch and explicit multi-reader
   attach with snapshot/replay/gap semantics.
6. Add CLI-equivalent trusted runtime configuration and secret-safe env policy.
7. Add the ACP adapter at `/apc` and a Pi-RPC-compatible stdio bridge/attach
   client; treat a polished stock-Pi `/connect` extension as a later client UX
   layer if upstream Pi cannot safely host a remote runtime.
8. Harden output serialization, recovery, health, and shutdown; then run full
   install/restart/security/live acceptance.
9. Only after the standalone contracts are stable does Cacophony implement its
   own shared-host lifecycle adapter.

## Provisional Beads work board

- [x] `bd-c39242` Add capability-gated, prompt-redacted schedule resources to
  `DashboardBackend`, remote delegation, and authenticated same-origin
  `/dash/v1/schedules` browser BFF routes.

## 18. Completed scaffold board (historical PD identifiers)

These items are implemented. “Complete” here means the original no-tools
scaffold acceptance passed, not that the newly clarified full host is complete.

- [x] `PD-001` Repository standard: AGENTS, license, contributing, security,
  editor/git hygiene, package metadata, strict TypeScript config.
- [x] `PD-002` Versioned protocol types, validation, JSON schema, fixtures.
- [x] `PD-003` Core multiplexer: session factory abstraction, registry,
  concurrency, serialization, event sequencing, failure isolation.
- [x] `PD-004` Durable manifests and wake idempotency journal.
- [x] `PD-005` Unix-socket NDJSON server, bounded input framing, client, CLI
  probe/request source.
- [x] `PD-006` Narrow real Pi SDK adapter with shared auth/model registries,
  locked resources, session managers, and event mapping.
- [x] `PD-007` Scaffold root/socket/no-tools/redaction controls and tests.
- [x] `PD-008` Scaffold metrics/status, structured logs, drain, and idle eviction.
- [x] `PD-009` Nix flake package/app/check/dev shell and reproducible npm lock.
- [x] `PD-010` CI, Dependabot, release workflow source, GitHub Pages site.
- [x] `PD-011` Optional concurrent real-SDK zero-child-process harness.
- [x] `PD-012` Scaffold README/protocol/security/operations/integration docs.

## 19. Completion audit — 2026-07-14

Three coordinated agents reviewed the standalone source, the current Pi 0.80.6
SDK/RPC/extension contracts, installed package behavior, and Cacophony's current
consumer code. The evidence changes the release assessment from “tagged-ready”
to “substantial scaffold, full host incomplete.”

### Release-blocking findings

1. **No complete attach/CRUD product surface.** The current protocol has nine
   high-level operations, implicitly subscribes connections after successful
   session requests, and returns `wake` only after the model turn. The target
   needs durable CRUD, explicit attach, asynchronous admission, request lookup,
   and the roughly 31-command Pi RPC surface.
2. **Conversation recovery is not sound.** `new` manifests recreate a new Pi
   session file after restart and `memory` manifests recreate empty history;
   queued wakes can therefore replay into the wrong context.
3. **Durable sessions disappear when evicted.** Host status only lists resident
   slots, eviction emits no public lifecycle event, and `close` cannot delete an
   evicted retained session because it returns before touching durability.
4. **The SDK integration uses the wrong abstraction.** `createAgentSession()`
   cannot implement Pi's new/resume/switch/fork/clone/import replacement
   lifecycle. `AgentSessionRuntime` is the supported host seam and requires
   rebinding subscriptions/extensions after replacement. Stock `runRpcMode()`
   is not embeddable per session because it owns process stdio, signals, and
   exit; the daemon needs its own transport-neutral RPC controller using public
   RPC types.
5. **Access and streaming are incomplete.** The owner-only UDS has no bearer
   mode. Handshake reveals resident IDs/generations and status can implicitly
   subscribe another connection. The clarified first auth boundary is one
   service bearer, not per-session tokens, but attach must remain explicit.
6. **Outbound bounds apply too late.** `ConnectionWriter` serializes a complete
   SDK event/response before checking queued-byte limits, so large model/tool
   payloads allocate outside the advertised bound.
7. **Recovery and health can wedge or lie.** Startup awaits all replayed queued
   model turns before listening, recovery failures are only transient log data,
   probe does not evaluate model/auth/degraded readiness, idle-sweep rejection
   is unhandled, readiness drains auth errors, and adapter disposal can outlive
   shutdown deadlines.
8. **The npm distribution is not runnable from a clean pack.** The installed
   bin symlink fails the non-canonical entrypoint equality check and exits with
   no output; a clean `npm pack` can omit `dist` because no prepack build exists.
9. **Pi compatibility is behind the required seam.** The exact 0.80.3 pin lacks
   current `agent_settled`, `entry_appended`, `waitForIdle`, `max` thinking, and
   mature runtime behavior. A reproducible 0.80.6-or-newer acquisition and
   compatibility policy is required before full RPC work.
10. **Per-session shell equivalence has a hard trust limit.** Arbitrary
    extensions and SDK/provider registries can read or mutate process globals.
    Concurrent in-process sessions cannot safely emulate independent
    `process.env`/cwd by swapping globals. The API must expose honest
    `unisolated` semantics, scoped provider/tool env where supported, and defer
    shell-grade isolation to a real boundary.

### Cacophony crosswalk and exclusion

Current Cacophony source has configuration/supervision substrate and a low-level
UDS client, but its agent lifecycle still routes `pico`/`pico-on-demand` through
per-agent processes and sockets. Cacophony must separately implement shared-host
session create/open mapping, persist daemon session ID/name/generation/host and
attach cursor, map profile/model/cwd/resource policy, send messages through
asynchronous admission, bridge its WebSocket view to daemon RPC, replace
process/tmux health with session health, and close/delete on lifecycle.

Those changes belong in Cacophony. Pi Daemon may contain neutral compatibility
fixtures and consumer acceptance only; it must never import Cacophony beads,
profiles, tokens, PKI, lifecycle state, or Rust client types.

## 20. Target control surfaces

All surfaces call one `SessionRegistry`/runtime controller and must be behaviorally
equivalent where their concepts overlap:

- **Existing NDJSON control plane:** retained for compatibility; grows explicit
  attach/detach, durable ticket/status/result, catalog, and capability commands.
- **JSON CRUD API:** `POST /session`, `GET /session`, and
  `GET|PUT|DELETE /session/{id-or-name}` on a configurable authenticated bind.
- **Pi RPC stream:** `/session/{id-or-name}/rpc`; raw Pi prompt responses preserve
  preflight-acceptance timing while high-level durable wake/send returns a
  daemon ticket. Events broadcast to bounded readers; responses return only to
  the issuing attachment. Daemon snapshot/cursor framing supplements raw Pi
  events, which have no host/generation/sequence identity.
- **ACP adapter:** `/session/{id-or-name}/apc`, as requested. Documentation must
  explain that the ecosystem protocol is ACP and the reference `pi-acp` adapter
  currently spawns `pi --mode rpc`; Pi Daemon ports or bridges that translation
  without spawning Pi.
- **Client bridge:** a `pi-daemon-rpc`-style stdio bridge provides stock Pi RPC
  JSONL to existing pico/ACP-style clients. A stock-Pi `/connect` package is a
  later UX layer unless an upstream remote-runtime seam can provide transcript
  and command parity safely.

## 21. Registered remaining board

The Cacophony board is now authoritative; dependencies on each bead encode the
implementation order. This list is a human-readable crosswalk.

### Foundation / release blockers

- [x] `bd-55ab9e` — parent epic: full standalone Pi session host API.
- [x] `bd-e2e717` — additive CRUD/RPC/ACP contract, schemas, fixtures, and
  control-mode equivalence.
- [x] `bd-3a3104` — clean npm pack plus installed-bin execution correctness.
- [x] `bd-12c4ba` — current Pi SDK acquisition and compatibility policy.
- [x] `bd-6148e1` — configurable bearer-authenticated API transport and explicit
  session attachment (depends on the contract).
- [x] `bd-143f05` — preserve real Pi conversation identity across restart and
  runtime replacement (depends on current SDK).

### Core host behavior

- [x] `bd-df7ba9` — durable resident/dormant catalog and session CRUD.
- [x] `bd-7d1407` — asynchronous durable command tickets and reconciliation.
- [x] `bd-0052e2` — full transport-neutral Pi RPC on `AgentSessionRuntime`.
- [x] `bd-ab1b91` — trusted Pi CLI-equivalent per-session configuration and
  honest `unisolated` env/isolation policy.
- [x] `bd-509428` — explicit multi-reader attach, atomic snapshot/live boundary,
  replay cursor, gap, reconnect, and extension-UI routing.

### Adapters, clients, and hardening

- [x] `bd-e27685` — in-process ACP translation at the requested `/apc` path.
- [x] `bd-d87daa` — Pi-RPC stdio bridge and remote attach client; a stock Pi
  `/connect` extension remains deferred until a real remote-session seam exists.
- [x] `bd-07980c` — pre-allocation bounds for events/responses and safe overflow.
- [x] `bd-1877d3` — bounded recovery/shutdown and truthful redacted readiness.
- [x] `bd-a4954f` — full install/CRUD/RPC/restart/security/live acceptance.
- [x] `bd-691be8` — multi-instance Home Manager service module for systemd,
  launchd, and conditional supervisord.
- [x] `bd-fb3b32` — version/tag/changelog/package/Nix release invariants.
- [x] `bd-e53e76` — self-hosted CI runner policy (operational maintenance).
- [ ] `bd-acf2d3` — draft: make automated npm dependency updates Nix-aware.

### Post-completion operator surfaces

- [x] `bd-fc8275` — protocol-v2 host-scoped neutral tool adapters without
  arbitrary extensions or shell.
  - [x] `bd-5c06cd` — descriptor/types, validation, public schemas, fixtures,
    compatibility tests, and protocol/security/integration documentation.
  - [x] `bd-ff2f8f` — bounded runtime registry/client and fixed filesystem-tool
    injection; final server persistence/wiring and cross-session acceptance stay
    with the parent.
- [ ] `bd-ba3623` — Pi Daemon Dash: exceptionally fast, polished browser
  session workspace with embedded/dedicated backends and Rich/TUI panes;
  detailed architecture and dependency board in `web/PLAN.md`.
  - [x] `bd-3a61f7` — authenticated, bounded browser stream router over the
    transport-neutral DashboardBackend channel seam.
  - [x] `bd-ea2019` — production same-origin login/REST/WS SPA integration,
    preview-first hydration, live commands/replay/liveness, seen cursors, and
    serializable extension interactions.
  - [ ] `bd-e9fce1` — lazy browser creation of a brand-new logical session with
    zero runtime/model/tool work before the first explicit message.
    - [x] `bd-6a4170` — browser-safe contract, owner-private atomic draft/send
      ticket store, authenticated neutral/BFF CRUD, schemas, fixtures, and docs.
    - [x] `bd-96c3e1` — embedded/remote exact-once first-send materializer with
      durable private crash checkpoints and no blind prompt replay.
    - [x] `bd-72d6fd` — accessible sidebar/form/empty-pane UX reusing the
      preview-composer first-send flow from `bd-930d31`.
- [x] `bd-71cfa2` — concise GitHub Pages quickstart for collision-free Home
  Manager instances, authenticated session tickets, Pi RPC, ACP, and the
  `unisolated` trust boundary.
- [x] `bd-367ec5` — first-launch private service directories, stable generated
  API bearer, and non-overwriting per-instance Pi auth seeding.
- [x] `bd-df5f19` — prebuild/cache aarch64-linux packages off-device so
  Nix-on-Droid never falls back to its native npm double-free path.
- [ ] `bd-4e10da` — future neutral persisted per-session cron/prompt scheduler
  and durable wakes; detailed alongside Dash in `web/PLAN.md`.
  - [x] `bd-6d96bb` — v1 schedule resource/schema/fixtures, bounded owner-private
    persistence recovery, optimistic revisions, clock/DST and secrecy contract.
  - [x] `bd-72aac0` — bearer-authenticated schedule CRUD/status/capabilities,
    ETag/idempotency CLI, and owner-private YAML/import prompt references.
  - [x] `bd-cb3036` — bounded durable timer loop, stable jitter, missed-wake and
    overlap policy, and idempotent durable prompt-ticket admission.
  - [x] `bd-c39242` — prompt-redacted deployment-neutral schedule resources and
    authenticated cookie-BFF routes without exposing the service bearer.
  - [x] `bd-edbc79` — capability-gated Dash schedule editor, countdowns,
    terminal history, validation, and dormant/unread visual semantics.
  - [x] `bd-aa4260` — native lifecycle integration plus all-IANA timezone/DST,
    wall-clock, restart, overlap, security, compatibility, and soak acceptance.
  - [x] `bd-f86c45` — deterministic injected-clock callbacks and scheduler
    admission settlement under loaded full-suite execution.

All standalone delivery and acceptance blockers are landed. Cutting the first
release tag is an explicit operator action under `docs/release.md`; the remaining
draft dependency-maintenance item is not a product-completion blocker.
