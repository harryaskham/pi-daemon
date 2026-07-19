# Session summary — host-scoped neutral tool adapters

## Goal

Deliver the standalone Pi Daemon side of safe tool-bearing logical sessions without importing client-orchestrator concepts or granting ambient shell, extension, environment, or filesystem authority. The work split a high-risk protocol/runtime feature into independently reviewed contract and runtime slices, then integrated host/session/generation binding, secret-safe durability, restart behavior, compatibility, and cross-platform acceptance.

## Bead(s)

- `bd-fc8275` — Protocol v2: host-scoped neutral tool adapters without arbitrary extensions.
- `bd-5c06cd` — Protocol v2 descriptor, schemas, fixtures, validation, and compatibility documentation (landed child).
- `bd-ff2f8f` — Bounded runtime registry/client, fixed filesystem tools, and Pi factory injection (landed child).
- `bd-f786ca` — Draft reflection follow-up for redacted `runCli` failure diagnostics.

## Before state

- Protocol v1 accepted only `tools: "none"`; every other resource tool policy failed as unsupported.
- `SessionAdapter` and `PiSessionFactory` had no transport for a scoped host capability.
- A persistent open command would have had no safe way to distinguish a tool-bearing generation after restart without retaining the capability itself.
- There was no fixed neutral operation contract, bounded adapter wire protocol, targeted per-request abort, or confused-deputy response validation.

## After state

- Protocol v1 remains byte-shape-compatible and no-tools by default. Protocol v2 adds a closed descriptor for six fixed root-relative filesystem operations only.
- The adapter connection is owner-private Unix-only, session-scoped, long-lived, generation/host bound, bounded for bytes/queue/concurrency/time/idempotency, and revoked on dispose or EOF.
- Pi receives only provider-safe custom filesystem tools granted by the descriptor; built-ins, shell, extensions, process, network, remove, and ambient environment remain unavailable.
- Capability handles, endpoints, and bindings never enter manifests, logs, status, events, tickets, or errors. Durability keeps only a nonsecret policy marker and requires reprovisioning after restart rather than silently downgrading to no-tools.
- V1 handshakes preserve their historical bounded shape; v2 handshakes add only compact version/tool-adapter availability metadata.
- Temporary roots in runtime/Pi adapter fixtures are canonicalized before descriptor construction, preserving strict owner/mode/no-follow socket checks across Linux and macOS path aliases.
- Validation: `npm test` passed 324/324 tests; `nix flake check --print-build-logs` completed with all checks passed.

## Diff summary

- Code/content commits: `b7dbfca`, `690107a`, `2a75e5e`, `475a335`; child mainline commits `85ea4e7` and `2f2267b`; final landed squash SHA will come from the reintegration receipt.
- Summary artefact commit: intentionally omitted; this file must not self-reference its own mutable SHA.
- Files touched by the root integration: `src/cli.ts`, `src/client.ts`, `src/durability.ts`, `src/multiplexer.ts`, `src/server.ts`, `test/durability.test.mjs`, `test/multiplexer.test.mjs`, `test/server.test.mjs`, `test/tool-adapter-runtime.test.mjs`, `test/pi-adapter.test.mjs`, and `PLAN.md`.
- Tests: added protocol-version echo, binding mismatch, secret persistence, restart reprovisioning, queued-wake failure, v1 handshake compatibility, and cross-platform canonical-path coverage; removed no tests.
- Behavioural delta: trusted clients can explicitly open a protocol-v2 session with one scoped neutral adapter capability, while every v1/no-descriptor path retains the prior locked no-tools behavior.

## Operator-takeaway

Pi Daemon now has a product-neutral tool seam rather than an arbitrary extension escape hatch: authority is explicit, root-relative, fixed-operation, session/generation/host bound, memory-only, and revocable. The compatibility and restart rules fail closed, and both the full Node suite and Nix package gate are green.
