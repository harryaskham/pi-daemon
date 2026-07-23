# Session summary — Dashboard authorization administration

## Goal

Complete `bd-284b03`, the third ordered child of `bd-b31a5d`: bounded authenticated grant and workspace administration, revocation, ownership transfer, content-free audit, and explicit controller handoff. Preserve the central-policy-only architecture, exact `local-owner` compatibility, no-existence-leak behavior, and machine-only service bearer. Keep multi-user provider configuration disabled until final slice `bd-9d9899`.

## Land-ready commit

- `7004cd0` — `feat(dash): add authorization administration (bd-284b03)`
- Rebased on current `origin/main` `2447da7`; the only conflict was `web/src/app.tsx`, where the newly landed composer submit-key props were preserved alongside the Access dialog.

## Implementation

### Durable central mutations

- Extended `DashboardAuthorizationService` with bounded actor/idempotency receipts retained in `authorization-v1.json`.
- Existing v1 state without the optional receipt array migrates in place; corruption and owner-only file checks remain fail-closed.
- Grant set, grant revoke, ownership transfer, and controller-transfer audit accept durable idempotency keys. Matching retries return the retained policy snapshot; conflicting content fails.
- Added bounded authorized-policy listing for workspace discovery.
- Resource-scoped audit uses retained-window-relative sequences and withholds global truncation/gap facts so resource administrators cannot infer inaccessible activity.
- Added content-free `controller-transferred` audit facts with only actor/resource/previous/target identity IDs.

### Browser administration API

Added additive same-origin routes and public browser-safe contract types:

- `GET /dash/v1/workspaces`
- `POST /dash/v1/workspaces/select`
- `GET /dash/v1/authorization/{session|workspace}/{id}`
- `PUT|DELETE .../grants/{identityId}`
- `POST .../transfer`
- `GET .../audit`
- `GET|POST .../controller` (session resources only)

All policy mutations require resource `admin`, same-origin CSRF, matching `X-Request-ID` and `Idempotency-Key`, exact policy ETag/body revision, bounded bodies, and provider-known target identities. Absent and unauthorized resources retain the same content-free `not_found`. The browser never sends or receives the daemon service bearer.

Workspace listing includes only authorized persisted policies and is capped at 100. Selection rebinds only the current server-side browser session after workspace-read authorization and closes its old streams. Workspace grant revocation or owner removal revokes matching cookies and peers immediately.

### Explicit controller handoff

- Added `DashboardControllerCoordinator`, shared by the official HTTP server and Rich/TUI stream router.
- Every live subscription registers a bounded participant containing only random participant ID, principal ID, presentation and dynamic controller role.
- Normal request/release operations are serialized through the coordinator.
- Administrative handoff requires resource admin, target `control` (or global administrator), exact policy ETag, and a separate controller revision ETag.
- Handoff waits for old-controller release completion before requesting target control. A failed target grant leaves no controller and never silently restores the old one.
- Successful handoff appends one durable content-free audit event and same-process retries reuse one bounded result.
- Revocation closes readers; downgrade to read releases a controller, falling back to channel close if release fails.
- The stream registration path rechecks policy after coordinator registration, closing the register-vs-revoke race before exposing subscription readiness.

### Browser UX and protocol

- Added a production accessible **Access & controller** dialog.
- It supports authorized workspace switching, session/workspace policy inspection, set/revoke grant, ownership transfer with optional retained old-owner role, active controller participant handoff, and content-free audit viewing.
- Added matching methods to `BrowserDashboardClient`; they use cookie + CSRF + exact ETags only.
- Added package exports for `dashboard-authorization-contract` and `dashboard-controller-coordinator`.
- Added five language-neutral fixtures, strict JSON Schema definitions, all routes to `DASH_API_PATHS`, and OpenAPI paths.
- Updated README, changelog, security, operations, protocol, threat model, acceptance, root plan and web plan.

## Validation

Post-rebase:

- strict root TypeScript: passed
- strict web TypeScript: passed
- focused identity/auth/enforcer/controller/contract/server/stream/embedded/remote/dedicated-CLI Node matrix: **88/88 passed**
- web Vitest matrix: **78/78 passed**
- clean build/npm-pack/import/package/release checks: **11/11 passed**
- exact `aarch64-darwin` Pages derivation: passed after final docs
- complete `npm test` and `nix flake check` remain canonical hosted validation gates per repository policy

## Security notes

- No ACL was added to a v1 resource; central policy remains the only authority.
- No browser identity enters `DashboardBackend`, remote service payloads, or bearer headers.
- Unknown identities receive one generic unavailable-target conflict only after the actor proves resource admin.
- Controller participant/resource counts, mutation receipts, audit, policies, workspaces, HTTP bodies, and UI results remain bounded.
- Failed target controller grant is fail-closed; failed durable audit after runtime transfer returns an explicit indeterminate error.
- Multi-user authentication/provider configuration is still intentionally unavailable.

## Next ordered work

After this slice lands and closes under mainline validation, claim `bd-9d9899`: secret-path provider configuration, legacy migration/operations, login/workspace UX completion, restart/revocation/no-leak parity, exhaustive security/compatibility acceptance, and release documentation. Only then close parent `bd-b31a5d` and expose multi-user configuration.
