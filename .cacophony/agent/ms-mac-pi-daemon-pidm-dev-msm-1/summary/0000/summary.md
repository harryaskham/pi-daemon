# Session summary — additive session control contract

## Goal

Define the executable protocol boundary for Pi Daemon's next implementation phase: authenticated REST session lifecycle, multi-reader Pi RPC attachment, and the operator-requested `/apc` endpoint carrying upstream ACP, while preserving the existing durable Unix NDJSON protocol as an equivalent control mode over one runtime.

## Bead(s)

- `bd-e2e717` — Specify additive session CRUD, RPC attach, and ACP API contracts.
- Parent: `bd-55ab9e` — Deliver the full standalone Pi session host API.

## Before state

- The repository exposed only the owner-local Unix NDJSON contract with nine high-level operations.
- There was no machine-readable session CRUD/OpenAPI surface, raw or framed Pi RPC attach contract, cursor/replay model, multi-reader routing rule, controller/UI policy, or ACP transport contract.
- Session creation remained limited to the initial no-tools adapter, and raw per-session environment persistence had no safe API rule.
- Contract fixtures under `fixtures/session-api/`: 0.

## After state

- `src/session-api.ts` publishes the API version, routes, all 31 Pi 0.80.6 RPC commands, session/ticket resources, framed attach records, and control-mode equivalence map.
- `session-api.schema.json` and `session-api.openapi.json` define authenticated CRUD, tickets, errors/statuses, raw/framed WebSockets, exact `/apc` ACP transport, pagination, stale checks, and secret-redacted resources.
- `docs/session-api.md` specifies one service bearer, exact ID/name resolution, generations/revisions, idempotency and indeterminate tickets, atomic snapshot/replay/live handoff, response routing, controller and extension-UI semantics, and honest `unisolated` environment limitations.
- Contract fixtures under `fixtures/session-api/`: 17.
- Failing tests: none. `npm test` passes 51/51. The Nix package check build passes its embedded 51/51 suite and completes install/fixup with the unavailable collective substituter disabled.

## Diff summary

- Code/content commit: `b7ba4b1` (final landed squash SHA will come from the reintegration receipt).
- Summary artefact commit: intentionally omitted; this file must not self-reference its own mutable SHA.
- Files touched: 33 code, schema, fixture, test, packaging, workflow, and documentation files before this summary.
- Tests: +6 focused session API contract cases; the clean-package test now verifies session API exports and remains reproducible with Nix's read-only offline cache.
- Behavioural delta: no network runtime is implemented in this slice; instead, every subsequent runtime/transport bead now has a versioned, fixture-backed compatibility target and explicit security/durability semantics.

## Operator-takeaway

The implementation can now proceed without inventing transport semantics piecemeal: Unix NDJSON, REST, raw Pi RPC, framed replayable RPC, and `/apc` ACP all converge on one logical runtime contract, with the single bearer trust domain and the limits of unisolated in-process extensions stated explicitly rather than implied.
