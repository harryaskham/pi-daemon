# Changelog

All notable changes to Pi Daemon are documented here. The project follows
semantic versioning once a release tag is cut.

## 0.1.0 — unreleased

Initial standalone implementation:

- versioned, forward-tolerant NDJSON protocol and JSON schema
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
- high-level JSON session CLI for CRUD, tickets, prompt/control, bridge attach, and RPC/ACP discovery
- bounded in-process upstream ACP JSON-RPC translation at the operator-requested `/apc` route
- typed per-session Pi configuration with scoped settings/resources/models/auth, deny-by-default discovery, and memory-only environment overlays
- pre-allocation event/response bounds with typed overflow and connection-local slow-reader failure
- canonical cwd allowlist and state/auth path isolation
- bounded background recovery, truthful nondestructive readiness/probe status, whole-shutdown deadlines, safe idle sweep, metrics, and path-redacted lifecycle logs
- reproducible Nix package/app/dev shell, multi-instance Home Manager service module, and npm package
- strict bounded per-instance YAML configuration at `~/.config/pi/daemon/<instance>/config.yaml`, with CLI/environment selection, CLI-over-file precedence, secret-path-only policy, and Home Manager support
- preview-only Dash transcript projection for bounded Pi v1/v2/v3 JSONL active branches, semantic messages/tools/custom records, opaque paging, exact fingerprints, and owner-private cache
- packaged content-hashed Dash SPA plus a loopback-only browser server with strict CSP/static admission, digest-only web credential exchange, HMAC-signed revocable HttpOnly sessions, exact Host/Origin/CSRF policy, bounded WebSocket handoff, and atomic revisioned workspace/UI-settings persistence
- an operator-safe rolling non-launchd test-instance helper that fast-forwards exact main, Nix-builds/tests to an immutable result, atomically switches, and restarts only its isolated tmux service
- first-launch private directory bootstrap, stable generated API bearer, and non-overwriting per-instance Pi auth seeding
- off-device aarch64-linux/Attic package path that avoids native Nix-on-Droid npm crashes and QEMU-only test false failures
- bounded Linux/macOS CI, release automation, Dependabot, and Docker-free Nix/Pandoc GitHub Pages
- prominent secret-safe operator quickstart for Home Manager instances, session tickets, Pi RPC, and ACP
- versioned Pi Daemon Dash browser/backend contract with preview-first resources, normalized Pi transcript identities, multiplexed Rich/TUI channels, strict replay/generation semantics, language-neutral fixtures, bounds, and performance budgets
- exact-pinned Dash frontend foundation with progressive Nord Midnight shell, virtual 10k-session and mixed-transcript viewports, lazy CodeMirror/Vim composer, accessible split-tree controls, deterministic visual artifact, and measured browser/bundle receipts
- owner-safe persisted Dash inventory with immediate 10k-session hot-head bootstrap, background full-index hydration/reconcile, keyed message search without retained text, managed/external identity merging, exact shared source fingerprints, and opaque revision-bound paging
- normalized ID-based rich transcript store with replay-gap reconciliation, safe markdown/code, bounded images/output, specialized and generic tool renderers, summaries/custom state, and lazy semantic highlighting
- bounded in-process `VirtualTerminal` for Pi TUI ANSI projection, styled row deltas, Unicode/cursor/resize/input fidelity, terminal side-channel stripping, representative upstream component fixtures, and measured frame budgets
- hermetic Linux/Nix installed-bin checks that resolve npm links through the pinned Node runtime
- credential-free full-host acceptance across installed artifacts, configured CRUD, RPC/ACP/stdio, restart/replay, security, and zero per-session child processes
- optional live-provider two-session zero-child-process acceptance harness
