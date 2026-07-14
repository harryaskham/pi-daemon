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
- bounded in-process upstream ACP JSON-RPC translation at the operator-requested `/apc` route
- typed per-session Pi configuration with scoped settings/resources/models/auth, deny-by-default discovery, and memory-only environment overlays
- pre-allocation event/response bounds with typed overflow and connection-local slow-reader failure
- canonical cwd allowlist and state/auth path isolation
- bounded background recovery, truthful nondestructive readiness/probe status, whole-shutdown deadlines, safe idle sweep, metrics, and path-redacted lifecycle logs
- reproducible Nix package/app/dev shell and npm package
- Linux/macOS CI, release automation, Dependabot, and GitHub Pages
- credential-free tests plus a live two-session zero-child-process acceptance harness
