# Session summary — neutral service-bearer Dash API

## Goal

Expose the implemented Dash inventory, preview, ownership/export/lease, and TUI capability surfaces through one versioned service-bearer API that a dedicated remote `DashboardBackend` can consume without browser credentials, arbitrary paths, Cacophony state, or policy bypass.

## Bead(s)

- `bd-246c6e` — Dash neutral API: expose inventory, preview, ownership/export and TUI capabilities to remote backends.
- Depends on landed contract, inventory, projector, and ownership slices.

## Before state

- The browser BFF had `/dash/v1` routes, but a dedicated Dash server had no neutral authenticated route/client family for backend services.
- `SessionApiClient` supported session CRUD/tickets and Pi RPC only.
- TUI transport had a browser contract and virtual terminal proof but no service-level capability/subprotocol negotiation point.
- Session API schema/OpenAPI did not publish Dash inventory, transcript, ownership, lease, or export envelopes.

## After state

- `DashboardNeutralApiController` delegates exact `SessionInventory`, `TranscriptProjector`, and `SessionOwnershipService` resources, resolves transcript paths only through authenticated inventory info, enforces fingerprint equality, and maps safe bounded errors.
- `ApiServer` optionally exposes `/v1/dashboard/*` inventory/info/transcript, activation ticket, export ticket, and lease routes. The existing service bearer authenticates before route lookup, path/session existence, or body reads. Mutation headers must match body request/idempotency keys.
- Root `/v1/capabilities` advertises neutral Dash capabilities only when configured. Effective limits and Rich/TUI availability are explicit.
- `/v1/dashboard/session/{sessionRef}/tui` negotiates exactly `pi-daemon-tui.v1`; missing protocol is 426 and an unavailable injected attachment manager is a typed 501. No second Pi process or implicit renderer is created.
- `SessionApiClient` has typed capabilities/list/info/transcript/activation/export/lease methods and authenticated bounded TUI connect support.
- `session-api.schema.json`, `dashboard-api.schema.json`, OpenAPI, typed fixture builders, seven valid service envelopes, and two invalid fixtures cover the public wire. Every path is part of `SESSION_API_PATHS` compatibility tests.
- Package exports publish `dashboard-neutral-api` and `dashboard-tui-attachments`; README, session API, protocol, Pages index, and dedicated neutral API documentation describe the security split and client contract.

## Validation

- Focused HTTP/controller/schema/OpenAPI/fixture/client acceptance: 24/24 passed before final gates; package/release checks also passed.
- Final post-rebase `npm test`: 245/245 passed, including production web build, browser TUI/workspace, clean npm pack/import, ownership, and neutral API admission.
- Final `nix flake check --print-build-logs`: 245/245 passed; package, web build, Pages, and installed binary checks completed.
- Acceptance includes unauthenticated non-disclosure, query parsing/bounds, info/transcript delegation, exact fingerprint conflict, header/body idempotency match, response request identity, activation/export locations, lease renewal, typed client calls, TUI 426/501 negotiation, valid/invalid schemas, and all OpenAPI refs/paths.

## Diff summary

- Final rebased code commit: `adfcad4`.
- Summary artefact commit: intentionally omitted.
- Main files: `src/dashboard-neutral-api.ts`, `src/dashboard-tui-attachments.ts`, `src/api-server.ts`, `src/session-client.ts`, session/dashboard schemas and OpenAPI, fixtures, tests, package exports, and `docs/dashboard-service-api.md`.
- No browser BFF route or `DashboardBackend` interface changed; the embedded backend continues to implement the existing interface directly.

## Operator-takeaway

Dedicated Dash now has a complete neutral server-to-server contract over the same trusted services as embedded mode, while the browser remains unable to see the daemon bearer: every path is authenticated, bounded, fingerprint/generation/idempotency-aware, and TUI stays honestly unavailable until a real injected view host is supplied.
