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
- Shared `ModelRuntime` and credential store.
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
- Built-in TLS termination for the neutral session API. Dash now has native
  HTTPS/WSS plus the recommended loopback reverse-proxy mode; the core bearer
  API still requires external TLS for non-loopback production exposure.
- Strong isolation for arbitrary extensions inside the shared Node heap.
- Cluster-wide host placement.
- Cacophony deployment, agent lifecycle mapping, and its `pico-daemon` adapter.
- Native Rust agent loop (tracked separately in Cacophony as `bd-5b0910`).
- **Pi Droid**, the independent first-party Android client and reusable Android
  SDK views. The detailed multi-host, canonical-cache, split/tab workspace,
  pairing, notifications, floating-window, widget/share, security, Play
  distribution, and staged delivery design is in
  [`docs/pi-droid-plan.md`](docs/pi-droid-plan.md). Staged Android implementation
  is active: encrypted signing readiness, JVM SDK/UI foundations, and Pi Droid
  preview 6 with screenshot-tested adaptive UX plus all daily-driver multi-host
  and session lifecycle support have landed their Play internal acceptance
  receipts; later Android surfaces remain separate beads.

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

- [x] `bd-ca2687` Prove regular, relative, and nested SOPS token paths across
  service and Dashboard auth, with broken, unreadable, empty, permissive, loop,
  byte-bound, and no-secret-output failure coverage.
- [x] `bd-4cc830` Publish Pi Daemon 0.3.1 from the landed Dashboard SOPS fix,
  with synchronized package/lock/source/flake/changelog versions, portable npm
  release assets, immutable tag verification, and post-publish local install.
- [x] `bd-17f1f4` Resolve configured Dashboard credential SOPS links to a
  canonical final inode with no-follow race protection while preserving owner,
  mode, regular-file, byte-bound, and generated-credential safety.
- [x] `bd-bed0ef` Expose bounded, content-free configured-session tool
  materialization provenance and effective inventory; fail closed before
  residency when caller-required stable tool IDs are unavailable, while keeping
  the neutral daemon free of Cacophony-specific authority.
- [x] `bd-2aeb03` Project the pinned Pi SDK's live active-context usage into
  Dash, refresh it on context/identity transitions, and render unavailable
  estimates as unknown instead of hard-coded zero.
- [x] `bd-6b9b42` Synchronize the unpublished alpha.2 workspace-ui API baseline
  with PR #57's additive public daily-driver surface before artifact creation.
- [x] `bd-d3772c` Remove the Pi Droid SDK lifecycle proof's check-then-bind port
  race by letting its disposable daemon request a kernel-assigned port.
- [x] `bd-1b8859` Keep intentional fake-ADB hang fixtures on a one-second shared
  deadline while giving the valid five-process staging path a realistic bound.
- [x] `bd-889018` Make the Pi Droid SDK Nix archive derive its version from the
  canonical publication properties and reject mismatched repository provenance,
  so Cacophony cannot consume a checksummed bundle under a stale alpha identity.
- [x] `bd-6f6ae1` Move explicit non-loopback plaintext Dashboard binding into
  typed transport policy with exact public authority, advisory logging, reload
  coverage, and unchanged authentication/resource bounds.
- [x] `bd-64bd2a` Add the repository-owned Caravan policy and reviewed rolling
  runtime wrapper for GitHub-native Stacks, bounded inside Cacophony's external
  sync cadence with offline config validation and no second scheduler.
- [x] Operator-directed Pi Droid preview 6 publication from the exact merged UX
  source to Play internal with signed phone/tablet/wide install smoke, immutable
  AAB/mapping/source/notes hashes, and independent pre/post version receipts.
- [ ] `bd-2cc76d` Keep accelerated emulator evidence honest with an
  Actions-executed `/dev/kvm` open/ioctl receipt and promotion from
  `android-kvm-candidate` to `android-kvm`, while keeping signed AAB build,
  validation, Play upload, and readback on the generic x86 Nix lane with no KVM
  dependency. Preserve the three failed mixed-lane receipts before exactly one
  new monotonic Internal release.
- [x] `bd-c42fff` Publish Pi Droid preview 5 from the exact reviewed
  daily-driver source to Play internal with signed install smoke, immutable
  AAB/mapping/source/notes hashes, and independent pre/post version receipts.
- [x] `bd-c02e13` Publish Pi Droid preview 4 from the exact reviewed
  host-management source to Play internal with signed install smoke, immutable
  AAB/mapping/source/notes hashes, and an independent version/track receipt.
- [x] `bd-d62946` Add daily-driver Pi Droid host management for zero/one/many
  hosts with durable default selection, non-secret metadata edits, atomic
  Keystore credential replacement and rollback, duplicate-endpoint re-pair,
  confirmed per-host forget, affected-connection invalidation, and actionable
  failed/missing-host recovery without clearing application data.
- [x] `bd-fa30dd` Retire only idle HTTP connections before an explicit Pi Droid
  readonly refresh so a same-authority daemon rollover establishes its new host
  identity in one pass without retrying requests, replaying indeterminate
  mutations, or interrupting active WebSockets.
- [x] `bd-0a39dd` Isolate each physical Pi Droid proof onto a private ADB server
  port and matching run-scoped authentication key home.
- [x] `bd-5a9f4e` Make both physical Pi Droid proof harnesses cold-boot safe with
  a shared, sanitized, process-aware ADB readiness deadline capped at 240 seconds.
- [x] `bd-bd6ca0` Constrain physical Pi Droid proof harnesses to a bounded,
  randomized scan of supported emulator console/ADB pairs with safe diagnostics.
- [x] `bd-005d84` Explicitly connect each selected emulator ADB transport through
  its isolated run server and use the loopback TCP serial for every device action.
- [x] `bd-17f134` Bound and classify isolated ADB `get-state` stdout/stderr into
  a safe diagnostic enum shared by both physical proof harnesses without leaking
  device, key, path, server, or arbitrary error text.
- [x] `bd-096781` Bind each isolated ADB server to its exact generated private-key
  file after keygen and retain only a bounded SHA-256 public-payload fingerprint
  in safe diagnostics and receipts.
- [x] `bd-bd2ed9` Latch accepted isolated ADB transports so offline, unauthorized,
  and other bounded state polls cannot trigger blind reconnects during readiness.
- [x] `bd-8e79ac` Make the isolated ADB readiness contract hermetic under Nix by
  using the active pinned Bash for its fake executables, replacing expiring sleep
  processes with owned blocking sentinels, and reporting only bounded redacted
  assertion labels when its shell fixture fails.
- [x] `bd-6033b6` Detect only the exact System UI ANR during physical Pi Droid
  proof waits, retain XML/screenshot/safe-logcat hashes, choose Wait at most once,
  require SystemUI process/readiness recovery, and give Pi Droid fatal/ANR evidence
  fail-closed precedence without dismissing arbitrary application failures.
- [x] `bd-4acb69` Correlate a persistent System UI ANR dialog with the latest exact
  package in Android's bounded structured `am_anr` event ring when the broad
  logcat tail has rolled over, while preserving Pi Droid failure precedence,
  title-and-button checks, title-only refusal, and hashed non-retained evidence.
- [x] `bd-792a59` Make every physical-proof exit stop its owned processes and scan
  retained text for the exact disposable bearer before token destruction; retain
  bounded owner-private normalized XML, screenshot, redacted logcat and safe
  identity hashes for unrelated app-failure modals without dismissing them.
- [x] `bd-0bfd83` Add a reviewed external-canary Pi Droid debug smoke path with
  owner-file-only bearer import over ADB stdin, GET-only preflight, exact
  host/session fencing, content-free evidence, idle-only observer attach, binary
  and app-private leak scans, and verified run-owned process/port cleanup.
- [x] `bd-50aa48` Return identity-matched, bounded unavailable transcript resources
  for retained quarantined or source-less sessions, preserve safe recovery and
  freshness truth, and prevent browser, SDK, Pi Droid, or canary observer attach.
- [x] `bd-4e6f17` Accept a present JSON boolean false observer eligibility in the
  external-canary harness, reject missing and wrong-type values, and continue the
  readonly proof through the explicit observer-not-requested path.
- [x] `bd-335987` Prove the exact locked Node and TypeScript dependency graph
  before the external-canary harness reads its token or spends authenticated GET
  budget, with typed local failure and zero Gradle, ADB, or emulator startup.
- [x] `bd-dd353f` Add the Cacophony-neutral Pi Droid SDK session lifecycle for
  capability-derived configured create, retained list/read/adopt, durable ticket
  reconciliation, transcript-authorized observer and TUI attach, explicit control,
  caller-owned correlation, replay-gap resync, and content-free process resume
  with loss-to-indeterminate and no blind replay; prove it against fake transports
  and one disposable real daemon without app, signing, Play, or live-host mutation.
- [x] `bd-0ce0fd` Adopt that lifecycle in the Pi Droid application with an
  adaptive persistent session catalog, daemon-authoritative configured creation,
  exact retained adoption, explicit observer-to-controller interaction, atomic
  content-free process resume, no-replay ticket/command reconciliation, and an
  opt-in bounded metadata-only foreground monitor with content-safe notifications.
- [x] `bd-8e2c2a` Polish the unreleased Pi Droid daily-driver UX beyond web Dash
  parity with secure first-run endpoint assessment, complete host recovery,
  searchable/filterable recency inventory, explicit authority/freshness/action
  states, Transcript/Tree/Terminal/Extensions navigation, dynamic dark/light
  adaptive phone/tablet/wide layouts, Back/IME/TalkBack behavior, and shared
  deterministic semantic/screenshot/contact-sheet proof without transport,
  canary, signing, token, or Play mutation.
- [x] `bd-61ac6b` Preserve a bounded owner-private incomplete occurrence when
  app-failure modal evidence capture fails, naming only the fixed failed predicate,
  safe identity class/hash, and retained-component hashes while discarding unsafe
  files and preserving Pi Droid priority and arbitrary-tap refusal.
- [x] `bd-3804d2` Accept the canonical generated base64url service bearer and
  bounded legacy HTTP Bearer-safe tokens in both external-canary readers while
  retaining owner-only no-follow reads and exact plus structured leak scans.
- [x] `bd-325025` Bound owner-private external-canary ADB stdin staging to one
  shared 30-second budget across literal shell-v2 no-PTY `mkdir`, stdin-only
  `tee`, `chmod`, `stat`, and `sha256sum` primitives, require exact remote mode,
  size, and digest verification before app launch, and retain primitive-specific
  typed redacted failures while cleanup terminates only proof-owned processes;
  after the first
  240-second readiness timeout, grant exactly one additional wait only when the
  same live emulator's private guest console proves adbd compressed-APEX
  progress without panic, fatal, or stall markers, reusing the isolated
  transport with typed diagnostics and a 480-second hard cap without repeating
  preflight, build, or launch.
- [x] `bd-1aee6e` Make the shared ADB staging deadline regression deterministic
  under slower Darwin process startup by advancing a private fake monotonic clock,
  preserving the exact chmod timeout phase without widening production limits or
  weakening owner-private staging, redaction, cleanup, or ambient ADB isolation.
- [ ] `bd-032326` Diagnose transport-connected/offline emulator starts with bounded
  guest kernel and private-console evidence, delay ADB traffic until guest boot,
  and prove isolated x86_64 readiness without invoking either physical proof.
- [ ] `bd-128d25` Replace avdmanager's under-provisioned profile-less API 36 guest
  with a validated medium-phone Google APIs x86_64 boot contract, then prove ADB,
  framework completion, matching public-key fingerprints, and clean teardown in
  one diagnostic-only smoke before either physical proof.
- [ ] `bd-2af62a` Use the pinned API 36 minimal AOSP x86_64 image through one
  flake/diagnostic/physical-proof contract because the hermetic catalog has no
  API 36 ATD, retain the bounded isolated readiness evidence, and require one
  fresh-main diagnostic before either physical proof.
- [x] `bd-988946` Make Android fast verification self-contained by exposing the
  flake-pinned Python runtime to both plain Node CI versions and executing the
  Java environment export directly in its pinned Nix shell without nested quote
  semantics that fail workflow linting.
- [x] `bd-e9e95f` Record every resolved and empty strict-lock configuration for
  the Pi Droid Android-integration JVM module so configuration-cache validation
  cannot fail before its credential-free contract tests execute.
- [x] `bd-31f515` Keep each Compose test module's Skiko native cache in its own
  build tree, place generic JVM temporary files in the Pi Droid fast job's
  private runner directory, and remove inherited displays before isolated Xvfb,
  so self-hosted ambient filesystem/display state cannot control initialization.
- [x] `bd-ed4382` Reopen retained imported Dash sessions from their exact managed
  JSONL/session directory without replaying or resolving the original fork source.
- [x] `bd-486f8c` Accept ordinary owner-controlled, non-writable Pi session
  directories for direct co-opt without weakening owner-private daemon state.
- [x] `bd-8de7f4` Restore source-branch provider/model/thinking policy during
  Dash activation and make canonical browser model switching effective.
- [x] `bd-dfdd89` Apply an explicit owner-configured trusted Dash runtime policy
  for extensions/resources while retaining no-tools/no-ambient defaults.
- [x] `bd-c39242` Add capability-gated, prompt-redacted schedule resources to
  `DashboardBackend`, remote delegation, and authenticated same-origin
  `/dash/v1/schedules` browser BFF routes.
- [x] `bd-e89a17` Add optional native HTTPS/WSS, exact SNI/Host/Origin and
  loopback proxy authority, atomic certificate rotation, HSTS/secure cookies,
  content-free health, secret-safe CLI/config/Home Manager sources, and
  downgrade/mixed-content/spoofed-forwarding acceptance.
- [x] `bd-b31a5d` Replace the single-operator Dash trust domain with the central
  identity/per-resource authorization architecture in
  `docs/dashboard-authorization.md`; never add ACL fields to v1 resources.
  - [x] `bd-07a348` Principal/provider, identity-bound browser session and
    owner-private centralized policy/audit foundation.
  - [x] `bd-fce8f4` HTTP/stream enforcement, no-existence-leak inventory paging,
    dedicated/embedded parity and exact single-owner migration.
  - [x] `bd-284b03` Revisioned grants, workspace sharing/revocation, ownership
    transfer, explicit controller handoff, audit and UI.
  - [x] `bd-9d9899` Secret-path provider configuration, migration, UX,
    exhaustive security/compatibility proof and release documentation.
- [x] `bd-5e5121` Explicitly inherit bounded global Pi package resources already
  installed by the Pi CLI, with no daemon installer/update/network authority.
- [x] `bd-41f3d2` Fix cold Linux package acceptance timeout, retain the 10k
  inventory bootstrap budget through a binary hot-head with portable fallback,
  and keep its load-sensitive percentile benchmark in explicit manual acceptance
  rather than package, Nix, or installation gates.
- [x] `bd-62ea39` Bound the clean package acceptance per stage rather than per
  platform so host load cannot fail a healthy packaging gate, while a hung child
  still fails fast and is attributed to the stage that hung. Move every residual
  wall-clock budget to opt-in manual acceptance, retaining the measurements and
  diagnostics in the standard suite. Bind the tool-adapter fixture socket from a
  short root so a long ambient `TMPDIR` cannot break the platform `sun_path`
  limit.
- [x] `bd-985309` Keep the bounded-shutdown acceptance semantic rather than
  wall-clock, so host load cannot fail it on unchanged code while a genuinely
  unbounded shutdown still fails.
- [x] `bd-600238` Negotiate the highest supported protocol version in
  `pi-daemon probe`, so protocol-v2 readiness (`configuredOpen`, `sessionDir`,
  `hostToolAdapter`) is verifiable with the shipped CLI rather than hand-crafted
  NDJSON, with `--protocol-version` to pin one explicitly and unchanged v1 wire
  behavior for existing `handshake()` callers.
- [x] `bd-b05086` Let one `serve` process enable or disable its embedded Dash
  through typed CLI overrides, preserving socket-only omission, CLI-over-YAML
  precedence, loopback-safe defaults, bearer secrecy and pre-listener failure.
- [x] `bd-94ea1d` Detect PID/listener-healthy but HTTP-dead API and dedicated
  Dash services with content-free semantic readiness, staged startup diagnostics,
  one latched exact-instance recovery, and bounded native-supervisor escalation.
- [x] `bd-72c0dd` Keep the 200-minute scheduler timer/memory soak off the
  crash-safe filesystem path already covered by durability cases, while retaining
  an explicit bounded runtime-write assertion and the exact Nix package gate.
- [x] `bd-9de467` Publish exact signed Attic closures for all four supported
  Linux/Darwin systems with target-scoped non-cancelling jobs, explicit execution
  capability checks, and a repository-pinned Attic publisher shell.
- [x] `bd-0a55be` Keep target-private publisher config in step-scoped runner
  context and gate every workflow with pinned actionlint so invalid job-level
  expressions cannot produce another zero-job run.
- [x] `bd-70271a` Remove ambient output-parser dependencies, fail closed when
  restricted cache settings are ineffective, and rehydrate each exact post-push
  closure from Attic under signature enforcement before claiming a receipt.
- [x] `bd-dda8b8` Keep the shared Linux runner untrusted, require host-declared
  exact signed reads, remove dynamic `attic use`, and expose the push token only
  after build while preserving empty-store signed hydration.
- [x] `bd-90c177` Explicitly disable `install-nix-action`'s trusted-user default
  so a fresh runner path cannot silently grant root-equivalent trust.
- [x] `bd-94a9d2` Export the exact npm fixed-output cache for release
  pre-materialization and bound only transient registry transport retries while
  preserving immediate integrity failure and the canonical recursive hash.
- [x] `bd-5e466a` Make the macOS verdict survive cold package tails: force and
  time the package/test/install build separately from the complete flake,
  retain credential-redacted cache/phase evidence, preserve failure status, and
  never cancel an in-flight Darwin verdict.
- [x] `bd-670ce8` Make the forced macOS package output job-unique and absent,
  build it normally under a private result root, and prohibit `--rebuild` or
  deletion of shared/live store roots while retaining every package phase.
- [ ] `bd-ec9d00` Keep optional Darwin verification off pull requests while
  retaining accepted-main, daily scheduled, and manual recovery coverage so an
  absent macOS runner cannot leave GitHub Stacks nonterminal.

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
   and the roughly 32-command Pi RPC surface.
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
- [x] `bd-acf2d3` — make automated npm dependency updates Nix-aware.

### Post-completion operator surfaces

- [x] `bd-597aac` — publish the pre-1.0 breaking runtime/resource policy as
  v0.2.2 after exact CI, package, checksum, and self-update acceptance.
- [x] `bd-e8cab3` — reload-unique Dash workspace/settings idempotency scopes so
  every settings category remains editable across durable browser sessions.
- [x] `bd-4e7a92` — restore cookie-authenticated Dash mutation authority after
  ordinary browser reload without storing the owner credential in JavaScript.
- [x] `bd-3aae18` — explicit default-off high-trust authority-root overlap for
  operators who run Pi sessions from their home directory.
- [x] `bd-762c22` — checksum-verified user-local GitHub release updates,
  atomic rollback, and an opt-in Home Manager mutable-runtime shim with
  immutable Nix fallback.
- [x] `bd-fc8275` — protocol-v2 host-scoped neutral tool adapters without
  arbitrary extensions or shell.
  - [x] `bd-5c06cd` — descriptor/types, validation, public schemas, fixtures,
    compatibility tests, and protocol/security/integration documentation.
  - [x] `bd-ff2f8f` — bounded runtime registry/client and fixed filesystem-tool
    injection; final server persistence/wiring and cross-session acceptance stay
    with the parent.
  - [x] `bd-b4be56` — reviewed explicit queue sizing, retry-safe hard-capacity
    refusal, and content-free live capacity/occupancy/high-water/rejection/
    saturation/per-operation telemetry across status, Session API, and Dash.
- [x] `bd-060163` — restart-safe quarantine for lost process-bound tool-adapter
  authority, typed per-session reprovision state, truthful unrelated host
  readiness, and readiness-first external-canary preflight.
- [x] `bd-b2975c` — neutral bounded streaming blob/session file transfer with
  immutable SHA-256 backing objects, exact-generation authority, quarantine,
  durable idempotent tickets, daemon-owned inbox references, cleanup, public
  schema/OpenAPI/fixtures, typed JavaScript client, and no cwd/tool authority.
- [x] `bd-ba3623` — Pi Daemon Dash: exceptionally fast, polished browser
  session workspace with embedded/dedicated backends and Rich/TUI panes;
  detailed architecture and dependency board in `web/PLAN.md`.
  - [x] `bd-3a61f7` — authenticated, bounded browser stream router over the
    transport-neutral DashboardBackend channel seam.
  - [x] `bd-ea2019` — production same-origin login/REST/WS SPA integration,
    preview-first hydration, live commands/replay/liveness, seen cursors, and
    serializable extension interactions.
  - [x] `bd-7de9ec` — final visual/performance/security/dual-mode acceptance,
    exact package gates, and uninterrupted 24-hour rolling soak (1,440/1,440).
  - [x] `bd-470f81` — server-validated versioned declarative extension views:
    inert Rich primitives, scoped correlated actions/forms, TUI fallback,
    schema/fixtures/capability negotiation, and an upstream Pi seam proposal.
  - [x] `bd-4b2415` — virtualized full Pi branch-tree navigation with filters,
    active-leaf truth, comparison, edit/fork/clone, negotiated in-place
    summarize/navigation, keyboard accessibility, and Rich/TUI handoff.
  - [x] `bd-e89a17` — optional native HTTPS/WSS and hardened remote browser
    deployment with exact public authority, loopback reverse-proxy verification,
    secret-safe file/fd inputs, atomic certificate rotation, and remote health.
  - [x] `bd-b07f4d` — durable activation recency distinct from source mtime so
    old reuse/direct/fork sessions move to the first inventory row exactly once.
  - [x] `bd-3cddd3` — owner-configurable lazy-session home/Pi-settings defaults
    and runtime-policy-capped default tools/project resources without browser
    path leakage or pre-send runtime work.
  - [x] `bd-57149a` — revisioned composer send-key policy: Enter sends by
    default, Shift-Enter newlines, and an alternate multiline Cmd/Ctrl-Enter mode.
  - [x] `bd-067a79` — bounded visible FIFO for ordinary messages sent during an
    active run, with local pre-delivery cancellation, next-boundary steering,
    exact next-turn fallback, and no indeterminate replay.
  - [x] `bd-331301` — canonical relative-path lazy-draft containment so
    filesystem-root authority admits home cwd without weakening sibling denial.
  - [x] `bd-8a9738` — discreet administrator diagnostics panel beneath Settings
    with embedded/dedicated API parity and a bounded normalized safe-event ring.
  - [x] `bd-b1d1a7` — Cacophony-integration protocol-v2 configured open with
    isolated per-session agentDir and confined deterministic sessionDir.
  - [x] `bd-1dc765` — P1 production interactivity hotfix: bounded single-pane
    transcript scrolling/composer containment, width-aware split repaint, and
    functional revisioned Settings category tabs.
  - [x] `bd-e9fce1` — lazy browser creation of a brand-new logical session with
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
- [x] `bd-68867d` — support SOPS-backed API bearer symlinks by resolving the
  chain, opening the canonical target with no-follow race protection, and
  validating the opened inode without exposing bearer paths or values.
- [x] `bd-23110a` — neutral Dash HTTP routing extracted from the core API server
  behind a small router interface, preserving auth-before-routing, shared
  response bounds, and WebSocket admission.
- [x] `bd-5fbf37` — split SessionInventory root scanning/JSONL parsing,
  persisted snapshot codecs, and bounded query/search/cursor internals into
  focused modules behind the unchanged public API and persisted formats.
- [x] `bd-1a9e5b` — fail packaged-SPA acceptances at an explicit missing-build
  precondition naming `npm run build`, rather than a misleading `/dash/` 404.
- [x] `bd-b771c1` — fingerprint `src/**` into built `dist/` and warn (without
  skipping/failing) when the build-free `test:unit` loop uses stale output.
- [x] `bd-0ab4f6` — standardize bounded stderr-first Vitest diagnostics so
  passing-test measurements remain visible under the default reporter.
- [x] `bd-8e7f56` — make every root `web:*` wrapper preserve forwarded inner
  workspace-tool flags and multiword values instead of npm consuming them.
- [x] `bd-2c6d58` — document the exact-lock refresh/check after dependency-
  changing rebases before stale `node_modules` is called broken main.
- [ ] `bd-e9f305` — supersede stale grouped dependency PRs with current low-risk
  ws, postcss, fast-uri, and nanoid patches plus an exact Nix dependency hash.
- [ ] `bd-302a62` — upgrade Pi SDK/TUI to 0.84.1 with compatibility proof and
  clear the remaining vulnerable undici/brace-expansion production subtree.
- [ ] `bd-b0b805` — evaluate ACP SDK 1.3 as an independent protocol change.
- [ ] `bd-d897a6` — evaluate TypeScript 7 and Node 26 types as an independent
  strict compiler/toolchain change.
- [ ] `bd-5761b3` — refresh Vite and browser runtime dependencies in reviewed
  slices while retaining the exact Playwright 1.60 Nix-driver contract.
- [ ] `bd-d0b2a8` — advance Playwright and its pinned Nix browser-driver closure
  together to 1.62.1 without download or revision drift.
- [x] `bd-184815` — move load-sensitive consumer process acceptance out of
  continuous package/install gates into scheduled feedback-backed triage, and
  publish the exact emulated aarch64-linux closure through signed private Attic.
- [x] `bd-8dd127` — add scoped happy-dom component tests to the standard web
  gate while retaining Node semantics for pure/source tests.
- [x] `bd-9337cf` — capability-gate supervisord `stopwaitsecs` so current
  Nix-on-Droid typed schemas evaluate while future schemas carry the timeout.
- [x] `bd-79902f` — load-proof recovery-deadline and first-launch socket waits:
  deterministic per-open and aggregate recovery cases plus a generous bootstrap
  hang bound that still fails a crashed daemon immediately.
- [x] `bd-00a448` — make first-launch CLI readiness require an exact-socket
  protocol handshake rather than socket-path existence, racing every bounded
  attempt against child exit with redacted capped diagnostics and hermetic stale,
  delayed, silent, wrong-listener, and dead-child regressions.
- [x] `bd-f786ca` — redaction-safe shared CLI exit diagnostics so a failing
  `serve` acceptance reports allow-listed structured event/error codes instead
  of a bare exit-code mismatch or a raw log dump.
- [x] `bd-ad9ef9` — remote Dashboard Rich and TUI attachment transports split
  into focused internal modules over shared transport primitives, with
  `RemoteDashboardBackend` retained as the public orchestration/export seam.
- [x] `bd-94d7df` — Rich/TUI presentation switches keep the reader's place in
  the transcript, anchored on settled distance from the bottom, with the
  browser acceptance rewritten to measure a settled anchor instead of two
  pre-hydration zeros.
- [x] `bd-acf2d3` — supported maintenance path for the pinned Nix npm
  dependency hash, plus a Nix-free fast staleness check and a dedicated flake
  check so grouped dependency updates fail actionably instead of red.
- [x] `bd-d79ef1` — Nix sources converged on the declared alejandra formatter
  and gated on it, landed as a separate inert reformat plus its check.
- [x] `bd-acd227` — source-only compile plus a focused Node test loop, with the
  full build retained as the authoritative packaging, Nix, and release gate.
- [x] `bd-7cba4b` — the Node CI lane's undeclared `openssl` dependency declared
  and provided, with a self-describing failure, plus the umask-dependent
  permission fixtures that were failing the same lane for an unrelated reason.
- [x] `bd-27c44a` — negative controls for fail-closed assertions: a checked
  permission-fixture helper, its own negative case, and the convention recorded
  in CONTRIBUTING.
- [x] `bd-95635b` — the tested ownership predicate adopted at all 43 guard call
  sites, with the census and an open-coded-guard invariant keeping it
  authoritative.
- [x] `bd-568050` — the exposure policy adopted at all 40 mode-check call sites,
  leaving no raw permission mask in `src/` outside the predicate.
- [x] `bd-a0ba53` — render Bash tool results as bounded rich cards, including
  pretty JSON, while suppressing only the duplicate live raw-result message.
  Source landed through PR #80.
- [x] `bd-467201` — accumulate live Pi reasoning deltas into the identity-stable
  transcript row, keep token usage current, and reconcile exactly with the
  persisted reasoning entry after completion or reload.
- [x] `bd-7677ba` — thread the existing transcript expansion settings into rich
  cards and preserve their component/measurement state across semantic
  live-to-persisted record replacement.
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
