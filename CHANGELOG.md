# Changelog

All notable changes to Pi Daemon are documented here. The project follows
semantic versioning once a release tag is cut.

## Unreleased

- add the non-enabled multi-user Dashboard authorization foundation: validated principals, constant-time bounded static credential provider, identity-bound server sessions, exact `local-owner` compatibility, and a central owner-private revisioned read/control/admin policy plus content-free audit ledger
- add optional native Dashboard HTTPS/WSS with bounded owner-controlled certificate/key file or inherited-fd sources, exact SNI/Host/Origin and loopback proxy evidence, atomic last-good rotation, HSTS/Secure cookies, content-free health, and secret-safe YAML/CLI/Home Manager deployment
- reopen retained imported Dash sessions from their exact managed JSONL directory instead of replaying the original fork target or rejecting the managed path as outside logical state, including active-branch model/thinking recovery for legacy prepared records
- add a versioned, server-validated declarative extension-view contract with inert Rich primitives, capability-scoped correlated actions/forms, mandatory TUI fallback, strict schema/fixtures/bounds, and no browser extension code or ambient network authority
- canonicalize Dash draft allowed roots and self-update install roots before containment checks so Darwin `/var` aliases do not cause false denial while later symlink targets remain unauthorized
- add a virtualized bounded full session-tree navigator with authoritative active-leaf paths, filtering/comparison, controller-gated edit/fork/clone, and capability-negotiated in-place summarize/navigation over a private non-replayed framed result
- persist separate activation recency so successful reuse/direct/fork sessions move to the top exactly once without rewriting source modification or fingerprint truth
- add owner-configurable lazy New Session defaults for home cwd, bounded Pi provider/model/thinking settings, default tools, approved discovery, and runtime-policy-capped authority without pre-send Pi work or browser path leakage

## 0.2.2 — 2026-07-22

- retain SIGTERM/SIGINT handlers until bounded serve/web shutdown completes so repeated supervisor stop signals cannot bypass cleanup

## 0.2.1 — 2026-07-22

- avoid scheduler-delay amplification in the standard 10,000-row inventory search path while retaining time-bounded event-loop yields for larger configured indexes

## 0.2.0 — 2026-07-21

Pre-1.0 breaking runtime-policy release: Dashboard activation now preserves and
executes explicitly reviewed source/runtime authority instead of always forcing
the prior no-tools/no-resource policy.

- preserve direct co-opt compatibility with normal owner-controlled Pi session directories without weakening private daemon-state modes or silently chmodding source data
- restore source-branch provider/model/thinking policy during Dash activation and send canonical provider/model IDs through browser model switching
- add owner-configured, bounded `web.runtimePolicy` authority for reviewed Dashboard extensions/resources while retaining no-tools/no-ambient-discovery defaults

## 0.1.3 — 2026-07-20

- derive the standalone RPC stdio version test from the canonical release version

## 0.1.2 — 2026-07-20

- derive package, RPC CLI, server, and self-update version expectations from the canonical release version so the exact release gate remains valid across patch bumps

## 0.1.1 — 2026-07-20

- keep remote RPC/TUI operation and attachment deadlines referenced until their public promises settle, preventing Node 22 from exiting a release test or short-lived client with unresolved work

## 0.1.0 — 2026-07-20

Initial standalone implementation:

- versioned, forward-tolerant NDJSON protocol and JSON schema
- additive protocol-v2 host/session/generation-bound neutral filesystem adapter contract with closed descriptors, bind/invoke/abort/revoke frames, strict limits, fixtures, schemas, and unchanged v1 no-tools behavior
- one-process multiplexer with isolated, replaceable Pi `AgentSessionRuntime` sessions
- shared default authentication/model registry plus bounded per-session model, tool, resource, settings, trusted extension, and memory-only environment policy
- per-session ordering, global concurrency, bounded queues, and event sequencing
- resolved Pi conversation manifests and idempotency journal with exact-identity replay and indeterminate crash semantics
- owner-private resident/dormant session catalog with exact names, pagination, optimistic updates, and Pi conversation identity
- bounded durable mutation/prompt tickets, idempotent admission, restart reconciliation, and optional asynchronous wake acknowledgement
- owner-only Unix socket server and JavaScript client
- explicit generation-bound Unix event attach/detach operations
- optional loopback bearer-authenticated JSON and stream-upgrade admission boundary
- transport-neutral full Pi 0.80.6 RPC controller with raw events, runtime replacement, and bounded extension UI
- authenticated raw/framed multi-reader Pi RPC WebSockets with private responses, explicit controller ownership, snapshots, replay cursors/gaps, and keepalive
- installed `pi-daemon-rpc` stock-JSONL stdio bridge with exact ID/name attach, bounded reconnect, gap status, and indeterminate-command protection
- high-level JSON session CLI for CRUD, tickets, prompt/control, bridge attach, and RPC/ACP discovery, with quiet successful `EPIPE` handling at both executable boundaries
- bounded in-process upstream ACP JSON-RPC translation at the operator-requested `/apc` route
- typed per-session Pi configuration with scoped settings/resources/models/auth, deny-by-default discovery, and memory-only environment overlays
- pre-allocation event/response bounds with typed overflow and connection-local slow-reader failure
- canonical cwd allowlist and state/auth path isolation
- bounded background recovery, truthful nondestructive readiness/probe status, whole-shutdown deadlines, safe idle sweep, metrics, and path-redacted lifecycle logs
- reproducible Nix package/app/dev shell, multi-instance Home Manager service module, and npm package
- checksum-verified user-local GitHub release updates with exact npm shrinkwrap installation, atomic current/rollback links, collision-safe `~/.local/bin` ownership, and an opt-in Home Manager mutable-runtime launcher retaining the immutable Nix fallback
- strict bounded per-instance YAML configuration at `~/.config/pi/daemon/<instance>/config.yaml`, with CLI/environment selection, CLI-over-file precedence, secret-path-only policy, and Home Manager support
- preview-only Dash transcript projection for bounded Pi v1/v2/v3 JSONL active branches, semantic messages/tools/custom records, opaque paging, exact fingerprints, and owner-private cache
- packaged content-hashed Dash SPA plus a loopback-only browser server wired into enabled embedded `serve` lifecycles and standalone dedicated `pi-daemon web` over `RemoteDashboardBackend`, with atomic startup/drain, separate browser state, strict CSP/static admission, digest-only web credential exchange, HMAC-signed revocable HttpOnly sessions, exact Host/Origin/CSRF policy, bounded WebSocket handoff, and atomic revisioned workspace/UI-settings persistence
- an operator-safe rolling non-launchd test-instance helper that fast-forwards exact main, Nix-builds/tests to an immutable result, atomically switches, and restarts only its isolated tmux service
- first-launch private directory bootstrap, stable generated API bearer, and non-overwriting per-instance Pi auth seeding
- off-device aarch64-linux/Attic package path that avoids native Nix-on-Droid npm crashes and QEMU-only test false failures
- bounded Linux/macOS CI, release automation, Dependabot, Docker-free Nix/Pandoc GitHub Pages, and an exact Ajv 8.20.0 security-audited schema-test dependency
- prominent secret-safe operator quickstart for Home Manager instances, session tickets, Pi RPC, and ACP
- versioned Pi Daemon Dash browser/backend contract with preview-first resources, normalized Pi transcript identities, multiplexed Rich/TUI channels, strict replay/generation semantics, language-neutral fixtures, bounds, and performance budgets
- exact-pinned Dash frontend foundation with progressive Nord Midnight shell, virtual 10k-session and mixed-transcript viewports, lazy CodeMirror/Vim composer, accessible split-tree controls, deterministic visual artifact, and measured browser/bundle receipts
- owner-safe persisted Dash inventory with immediate 10k-session hot-head bootstrap, background full-index hydration/reconcile, keyed message search without retained text, managed/external identity merging, exact shared source fingerprints, and opaque revision-bound paging
- normalized ID-based rich transcript store with replay-gap reconciliation, safe markdown/code, bounded images/output, specialized and generic tool renderers, summaries/custom state, and lazy semantic highlighting
- bounded in-process `VirtualTerminal` for Pi TUI ANSI projection, styled row deltas, Unicode/cursor/resize/input fidelity, terminal side-channel stripping, representative upstream component fixtures, and measured frame budgets
- canonical capability-gated `ShadowTuiHost` with one runtime/view/external-UI broker per generation, coalesced snapshot/delta replay, controller-only bounded semantic input, observer mirrors, deterministic browser style mapping, invalidation/disposal, and authenticated `pi-daemon-tui.v1` attachment adapter
- responsive browser TUI pane with generation/sequence-fenced snapshot and delta reduction, virtual styled rows, controller-only measured resize/key/paste input, canonical read-only mirrors, replay/conflict recovery, overlays, safe image placeholders, accessible text, persistent Rich/TUI switching, and Nord visual/performance receipts
- durable Dash session ownership with explicit direct confirmation, safe fork/import, cooperative leases, write-conflict guards, crash-safe idempotent tickets, atomic export-as-new, guarded append-back, release, and narrow normal-Pi session storage authority
- browser-safe lazy session-draft contract and owner-private atomic draft/first-send ticket store with deterministic target identity, phase-aware cancellation, resumable pre-prompt checkpoints, and no runtime work during CRUD
- revisioned persistent Dash split workspaces with mouse/keyboard resize, focus-preserving directional swaps, close promotion, shared session stores, source-aware UI settings/reset, hot semantic themes, keyboard help, and Vim/multiline completion/history
- neutral service-bearer Dash API for bounded inventory/info/transcript resources, activation/export/lease tickets, typed client methods, and capability-gated `pi-daemon-tui.v1` negotiation
- policy-preserving `InProcessDashboardBackend` with direct inventory/projection/ownership/catalog delegation, no-prompt durable hydration, renewable eviction leases, coalesced rich channels, controller arbitration, bounded replay/gaps, extension UI, and delegated TUI channels
- service-bearer `RemoteDashboardBackend` with exact neutral-resource parity, coalesced framed Rich/TUI attachments, explicit prompt-free durable hydration, renewable attachment leases, bounded cursor reconnect/gaps, controller arbitration, and no blind replay of accepted commands or semantic TUI actions
- native bounded per-session cron scheduler with all-IANA timezone/DST semantics, restart-stable jitter, wall-clock jump protection, missed/overlap policies, durable prompt-ticket admission, authenticated API/CLI/config, and prompt-redacted Dash editor/countdown/history
- hermetic Linux/Nix installed-bin checks that resolve npm links through the pinned Node runtime
- credential-free full-host acceptance across installed artifacts, configured CRUD, RPC/ACP/stdio, restart/replay, security, and zero per-session child processes
- optional live-provider two-session zero-child-process acceptance harness
