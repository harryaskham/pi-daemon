# Session summary — No-runtime Dash session drafts

## Goal

Land the policy, persistence, transport, and browser-contract foundation for creating a brand-new Dash session lazily: draft CRUD must be durable and useful in embedded or dedicated mode while performing zero Pi runtime/model/tool work before the user explicitly sends the first message.

## Bead(s)

- `bd-6a4170` — Dash lazy session drafts: contract, bounded persistence and no-runtime CRUD.
- Parent: `bd-e9fce1` — Dash new session: lazy create flow with no runtime work before first message.
- Siblings: `bd-96c3e1` — exact-once first-send materializer; `bd-72d6fd` — browser new-session UX; existing `bd-930d31` preview-composer dependency landed during this session.

## Before state

- Production Dash had inventory/preview/activation/export routes but no resource for an unsent brand-new session.
- Ordinary Session API creation immediately opened `AgentSessionRuntime`, so wiring it directly to a New Session button would violate lazy/no-model/no-tool requirements.
- There was no durable draft revision, deterministic target session identity, private first-message work record, recoverable pre-prompt checkpoint, or phase-aware cancellation contract shared by embedded and dedicated backends.

## After state

- Added a browser-safe draft spec that excludes environment, settings, resource paths, system prompts, approve-trust, service credentials, and host capabilities while retaining bounded cwd/name/persistence/model/thinking/tool/resource choices.
- Added one owner-private, atomically replaced, count/byte-bounded store for draft resources and private first-send tickets, with strict recovery/quarantine, idempotent create/cancel/send, optimistic revisions, rollback on failed writes, deterministic target session identity, and bounded terminal retention.
- Private first-send phases distinguish `materializing`, `ready-to-prompt`, and `prompt-submitting`; recovery exposes bounded recoverable ticket IDs and makes only prompt-submitting work indeterminate. Cancellation before prompt authority fails safely; cancellation racing prompt submission becomes indeterminate and is never replayed.
- Added neutral service API and cookie-BFF create/get/delete/send/ticket routes, ETag/idempotency/CSRF/auth separation, typed SessionApiClient/BrowserDashboardClient methods, embedded/remote backend seams, optional injected `DashboardSessionDraftExecution`, capabilities, fixtures, schemas/OpenAPI, package/Nix/Pages publication, and security/operator docs.
- Draft CRUD composition tests prove no additional factory open or RPC command. Public resources/tickets never expose the private first message.
- Full `npm test` passed 345/345 after rebasing onto the landed preview-composer flow. Full `nix flake check` passed package, Pages, module, and install checks. Web unit suite passed 48/48; focused contract/store/server/backend matrices were also green.

## Diff summary

- Code/content commit: `9f452ab` (rebased content commit; final landed squash SHA will come from reintegration).
- Summary artefact commit: intentionally omitted; this file must not self-reference its own mutable SHA.
- Core additions: `src/dashboard-session-drafts.ts`, browser-safe `src/dashboard-session-draft-contract.ts`, `dashboard-session-draft.schema.json`, five language-neutral fixtures, two focused contract/store suites, and authenticated service/BFF routes.
- Updated shared surfaces: Dashboard contract/backends/neutral API/server/service runtime, Session API/client, browser client/live fixtures, schemas/OpenAPI, package/Nix/Pages artifacts, README/SECURITY/docs/PLAN/web plan, and package/conformance tests.
- Tests added or strengthened: durable restart/corruption/capacity/idempotency/CAS/rollback/cancel races, deterministic session binding, private prompt secrecy, no-runtime backend CRUD, embedded/remote/BFF/API/client routes, capability negotiation, schemas/OpenAPI, and clean package imports.
- Behavioural delta: Dash can now persist and cancel a validated empty new-session draft without touching Pi; the sibling materializer has a frozen injected store/execution seam for exactly-once first send.

## Operator-takeaway

The important boundary is now mechanical rather than aspirational: creating or viewing a draft cannot open Pi, and prompt authority is crossed only after durable deterministic-session and private phase checkpoints. Embedded and dedicated modes consume the same contract, while the first-message content stays owner-private and crash/cancel ambiguity is represented honestly as indeterminate.
