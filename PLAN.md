# Pi Daemon — implementation plan

Status: active implementation plan  
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

### Initial release

- Node 22.19+ standalone executable (`pi-daemon`).
- Unix-domain socket NDJSON protocol on Linux/macOS.
- Shared `AuthStorage` and `ModelRegistry`.
- Persistent or in-memory logical sessions.
- Operations: handshake, open, wake/prompt, status, abort, close, drain.
- Streamed Pi lifecycle/message/tool events.
- Per-session serialization and global turn semaphore.
- Durable idempotency/result journal.
- Restart-safe session manifest and explicit indeterminate handling.
- Prometheus-style metrics snapshot in protocol status output.
- Nix flake package, app, checks, formatter, and dev shell.
- GitHub CI, release artefact workflow, and Pages documentation.
- Neutral JavaScript client helper and protocol JSON schema.

### Deferred

- Windows named-pipe transport.
- Network/TLS listener.
- Arbitrary project extensions.
- Built-in bash/read/write tools.
- Cross-process tool execution.
- Cluster-wide host placement.
- Cacophony deployment and `pico-daemon` lifecycle adapter.
- Native Rust agent loop (tracked separately in Cacophony as `bd-5b0910`).

## 5. Runtime architecture

```text
client(s)
   │ NDJSON over Unix socket
   ▼
ProtocolServer ── validation / auth policy / bounded writes
   │
   ▼
Multiplexer
   ├── shared AuthStorage
   ├── shared ModelRegistry
   ├── global turn semaphore
   ├── durable RequestJournal
   └── sessions: Map<logicalSessionId, SessionSlot>
         ├── AgentSessionRuntime / AgentSession
         ├── isolated SessionManager
         ├── isolated SettingsManager
         ├── serialized command tail
         ├── per-session event sequence
         └── bounded completed-result cache
```

The service never exposes Pi SDK objects over the wire. Protocol records are
plain JSON and are stable independently of Pi's internal TypeScript API.

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

The state directory contains:

```text
state/
  host.json
  sessions/<escaped-session-id>/manifest.json
  sessions/<escaped-session-id>/pi/*.jsonl
  journal/<escaped-session-id>.jsonl
```

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

Initial service policy:

- `DefaultResourceLoader` runs with extensions, skills, prompt templates,
  themes, and context-file discovery disabled unless an explicit trusted policy
  enables an allowlisted resource.
- `noTools: "all"` is the default and only initial built-in tool profile.
- No arbitrary project extension import: extension JavaScript can access process
  memory, environment, AuthStorage, and other session resources.
- Cwd/root is canonicalized and must be under an allowlisted root.
- State/auth roots must not be inside a logical session's working root.
- Socket mode defaults to owner-only (`0600`); parent directory must not be
  group/world writable unless explicitly allowed.
- Request payloads, logs, status, and metrics never return API keys or raw auth.
- The service accepts no Cacophony node bearer, CA key, daemon state, or
  orchestration object.
- Client-specific scoped tools are future neutral adapters and must enforce
  their own capability/root boundaries.

A client requiring arbitrary extensions or bash belongs in a separate
inhabitant/security domain. Sharing provider auth is acceptable only among
operator-trusted logical sessions.

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

```text
pi-daemon serve --socket PATH --state-dir PATH [limits]
pi-daemon probe --socket PATH
pi-daemon request --socket PATH --json REQUEST
pi-daemon version
```

`serve` is the service entrypoint. `probe` performs handshake/status and exits
non-zero on incompatibility/unready state. `request` is a low-level integration
and debugging tool; it never prints secrets.

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

1. Repository contract, protocol types/schema, fake adapter, core multiplexer.
2. UDS server and CLI probe/request tools.
3. Real Pi SDK adapter with locked-down ResourceLoader and persistence.
4. Durable journal/restart/indeterminate handling.
5. Limits, metrics, structured logs, drain/signal behavior.
6. Nix packaging and service artefacts.
7. CI, release automation, Pages site, operator docs.
8. Live optional multiplex smoke and final acceptance report.
9. Cacophony consumes the stable protocol/package in its own integration bead.

## 18. Beads (provisional until Cacophony registers this friend project)

Use these lines as the local board. Mark each complete in commits and keep this
section truthful.

- [x] `PD-001` Repository standard: AGENTS, license, contributing, security,
  editor/git hygiene, package metadata, strict TypeScript config.
- [x] `PD-002` Versioned protocol types, validation, JSON schema, fixtures.
- [x] `PD-003` Core multiplexer: session factory abstraction, registry,
  concurrency, serialization, event sequencing, failure isolation.
- [ ] `PD-004` Durable manifests and idempotency journal with restart semantics.
- [ ] `PD-005` Unix-socket NDJSON server, bounded framing, client, CLI probe and
  request commands.
- [ ] `PD-006` Real Pi SDK adapter: shared auth/model registries, locked-down
  resources, persistent session managers, event mapping.
- [ ] `PD-007` Security controls: roots/socket mode/no-tools policy/redaction and
  adversarial tests.
- [ ] `PD-008` Observability, metrics/status, structured logs, drain/signals,
  memory/session eviction.
- [ ] `PD-009` Nix flake package/app/check/dev shell and reproducible npm lock.
- [ ] `PD-010` CI, Dependabot, release workflow, GitHub Pages site.
- [ ] `PD-011` Optional real-SDK concurrent-turn/zero-child-process harness and
  acceptance report.
- [ ] `PD-012` Final documentation: README, protocol, security, operations,
  integration guide; all tests/CI green and tagged-ready.
