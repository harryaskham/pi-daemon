# Session summary — dedicated Dashboard remote transport parity

## Goal

Implement the server-side `RemoteDashboardBackend` used by dedicated Dash deployments so it matches the embedded backend over authenticated neutral REST plus persistent framed Rich/TUI attachments, without exposing the daemon bearer to browsers or weakening generation, controller, cursor, replay, hydration, and indeterminate-command policy.

## Bead(s)

- `bd-ad4630` — Dash remote backend: implement REST/framed-RPC parity, reconnect and channel coalescing.
- Parent: `bd-ba3623` — Pi Daemon Dash.

## Before state

- The neutral `/v1/dashboard/*` resource API and `SessionApiClient` methods were landed, but there was no `RemoteDashboardBackend` package export.
- Dedicated live channels had no persistent cursor/coalescing implementation; the existing `rpcCommand()` helper was intentionally one-shot and unsuitable.
- RPC attachment required a resident session and held no renewable residency lease, so a dedicated pane could not perform explicit prompt-free hydration or prevent idle eviction.
- Embedded and remote implementations did not share a parameterized backend conformance harness.

## After state

- `RemoteDashboardBackend` delegates capabilities, inventory/info, fingerprint-guarded transcript preview, activation/export tickets, and managed session lookup through the neutral service-bearer client.
- One framed RPC socket and one TUI socket are coalesced per session/generation. Local pane roles remain independent; observers are never auto-promoted, controller denial after reconnect reaches only the previous claimant, and close/release relinquishes upstream control.
- Opaque cursors survive bounded exponential reconnect. Cursor-expired, host-restarted, and generation-changed gaps map to the exact Dash enum; identity and snapshot getters atomically expose the fresh host boundary; events arriving during snapshot capture are delivered exactly once.
- Accepted keyed and unkeyed commands, extension replies, TUI input, resize, and control are never replayed after loss. Missing acknowledgements become indeterminate; same-key/same-payload retries retain the result, changed payload conflicts, never-sent oversized frames reject safely, and every attach/operation/reconnect queue has count/byte/time bounds.
- Framed attach supports explicit `hydrate=true`: retained durable sessions reopen through persisted catalog/config policy without a prompt and hold renewable residency leases. Omission preserves resident-only RPC behavior; memory-only sessions remain non-reopenable.
- Dedicated transcript reads intentionally page at most three bounded records per neutral response, preserving a valid combined result above 2 MiB without increasing the API/client response envelope.
- Public package/index/release exports, OpenAPI, schema, compatibility fixture, protocol/service docs, README, changelog, and the provisional Dash board are current.

## Diff summary

- Final rebased code/content commits: `6255973`, `f94256c`, `e1182b0`, `4be2352`, `da9631e`.
- Summary artefact commit: intentionally omitted; this file must not self-reference its own mutable SHA.
- Main implementation: `src/dashboard-remote-backend.ts`, `src/session-residency.ts`, `src/session-client.ts`, and `src/rpc-attachments.ts`.
- Contract/package/docs: `session-api.schema.json`, `session-api.openapi.json`, `fixtures/session-api/*`, `package.json`, `src/index.ts`, `README.md`, `CHANGELOG.md`, `docs/dashboard-protocol.md`, `docs/dashboard-service-api.md`, `docs/session-api.md`, and `web/PLAN.md`.
- Tests: shared embedded/remote resource and Rich-channel conformance; remote resource/command matrix; pane coalescing; controller arbitration; exact replay/gap/capture boundary; dynamic identity; transient/terminal/cancelled reconnect; keyed/unkeyed and TUI no-replay; operation deadlines/outbound bounds; >2 MiB paged transcript; explicit dormant hydration and lease release; schema/OpenAPI fixture compatibility; package/release export assertions.
- Final post-rebase focused validation: strict TypeScript check passed; the combined embedded backend, real browser stream router, remote backend, RPC attachment, and session API contract run passed 42/42. Remote Rich fixture p95 was about 0.02 ms, below the 50 ms local stream budget.
- Hosted CI owns the broad npm build/package/Nix gates per the active merge-queue policy. A source-only release-test invocation before building web assets failed only because `dist/dashboard/assets` was absent, not because of a contract assertion.

## Operator-takeaway

Dedicated Dash now has a real behaviorally complete backend rather than a one-shot RPC wrapper: REST stays service-bearer-only, panes share bounded persistent transports, hydration never prompts, reconnect never guesses or replays accepted work, and large valid transcript previews retain parity through safe paging. The remaining dedicated process/CLI/Home Manager lifecycle belongs to the separate packaging bead, not this transport seam.
