# Session summary — Pi Daemon Dash protocol foundation

## Goal

Turn the newly landed Pi Daemon Dash architecture into one executable, deployment-neutral contract that lets backend, frontend, inventory, projector, server, and shadow-TUI work proceed independently without inventing incompatible resource or stream shapes.

## Bead(s)

- `bd-933f1e` — Dash foundation: version browser protocol, backend contract, and performance budgets.
- Parent: `bd-ba3623` — Pi Daemon Dash v1.

## Before state

- `web/PLAN.md` described the browser/backend boundary, but the repository had no Dash TypeScript contract, schema, OpenAPI, fixture builders, frozen fixtures, or public package exports.
- Embedded and dedicated work had no shared `DashboardBackend`, `DashboardChannel`, or `DashboardTuiChannel` seam.
- Preview, ownership, export, runtime hydration, replay identity, pane correlation, liveness/attention, and Rich/TUI availability were design prose rather than machine-checked records.
- Dash count/byte/age/single-record limits and p95 performance targets were not executable or packaged.

## After state

- `src/dashboard-contract.ts` publishes API paths/versioning, opaque cursor/fingerprint types, the three backend/channel interfaces, inventory/info/transcript/activation/export/workspace/settings resources, normalized Pi entry/message/tool identities, liveness state, rich/TUI snapshots and deltas, browser HTTP envelopes, and multiplexed stream frame unions.
- `src/dashboard-fixtures.ts` provides deterministic typed builders; 21 frozen JSON fixture files cover preview-before-hydration, reuse/direct/fork/export/indeterminate tickets, replay gap plus fresh snapshot, four liveness combinations, Rich/TUI negotiation, and two pane subscriptions sharing one session with distinct correlations.
- `dashboard-api.schema.json` and `dashboard-api.openapi.json` define strict but additive language-neutral contracts for the same-origin `/dash/v1` surface. The browser uses an HttpOnly Dash session and CSRF header; the daemon service bearer is server-to-server only and absent from browser-storable fixtures.
- Capability fixtures publish every HTTP, WebSocket, inventory, projection, replay, workspace, TUI, settings, lease, and browser-cache count/byte/age/single-record bound plus all p95 performance budgets.
- Inventory pages omit canonical paths; the authenticated information resource may include one. Transcript pages explicitly state `hydration: "not-requested"` and key records by Pi entry/message/tool identities rather than array position or rendered text.
- npm exports the contract, fixture builders, schema, and OpenAPI. Nix packages them, Pages publishes them, and `docs/dashboard-protocol.md` documents security, idempotency, replay/generation, liveness, limits, and compatibility.

## Validation

- Focused Dash contract suite: 9/9 passed.
- Full `npm test`: 173/173 passed, including clean npm pack/install/import coverage.
- `nix flake check --print-build-logs`: package and Pages checks passed; Nix reran all 173 Node tests and verified both installed binaries.
- The pre-existing Ajv advisory is tracked separately as `bd-a4347b`; this slice added no runtime dependency and did not alter the existing pin.

## Diff summary

- Code/content commits before reintegration squash: `2f66c8a` and `611315c`.
- Summary artefact commit: intentionally omitted; this file must not self-reference its own mutable SHA.
- Main additions: `src/dashboard-contract.ts`, `src/dashboard-fixtures.ts`, `dashboard-api.schema.json`, `dashboard-api.openapi.json`, `fixtures/dashboard-api/`, `test/dashboard-contract.test.mjs`, and `docs/dashboard-protocol.md`.
- Packaging/docs integration: `package.json`, `scripts/postbuild.mjs`, `flake.nix`, Pages workflow, package/release tests, index, and changelog.
- Behavioral delta: this is contract-only; no server or SPA behavior was implemented. All later Dash modes now have one named seam and one conformance corpus.

## Operator-takeaway

The critical-path Dash boundary is now concrete and security-preserving: embedded and dedicated deployments must expose the same browser protocol, preview remains independent from runtime authority, every live update is scoped by host/session/generation/cursor, and Rich/TUI implementations can evolve behind explicit capability negotiation without leaking the daemon bearer or creating a second session state machine.
