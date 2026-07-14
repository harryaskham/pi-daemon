# Changelog

All notable changes to Pi Daemon are documented here. The project follows
semantic versioning once a release tag is cut.

## 0.1.0 — unreleased

Initial standalone implementation:

- versioned, forward-tolerant NDJSON protocol and JSON schema
- one-process multiplexer with isolated, replaceable Pi `AgentSessionRuntime` sessions
- shared authentication/model registry and locked no-tools resources
- per-session ordering, global concurrency, bounded queues, and event sequencing
- resolved Pi conversation manifests and idempotency journal with exact-identity replay and indeterminate crash semantics
- owner-private resident/dormant session catalog with exact names, pagination, optimistic updates, and Pi conversation identity
- bounded durable mutation/prompt tickets, idempotent admission, restart reconciliation, and optional asynchronous wake acknowledgement
- owner-only Unix socket server and JavaScript client
- explicit generation-bound Unix event attach/detach operations
- optional loopback bearer-authenticated JSON and stream-upgrade admission boundary
- canonical cwd allowlist and state/auth path isolation
- metrics, readiness, redacted JSON logs, drain, and idle eviction
- reproducible Nix package/app/dev shell and npm package
- Linux/macOS CI, release automation, Dependabot, and GitHub Pages
- credential-free tests plus a live two-session zero-child-process acceptance harness
