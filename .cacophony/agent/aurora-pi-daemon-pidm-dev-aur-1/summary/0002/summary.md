# Session summary — Lazy new-session Dash flow

## Goal

Deliver the browser frontend for creating a brand-new Pi Daemon session without eagerly creating a runtime: an accessible New Session action, bounded policy form, durable draft identity, safe unsent cancellation, and one first-send transition into the existing managed live composer.

## Bead(s)

- `bd-72d6fd` — Dash new-session UX: sidebar action, empty pane and first-send transition.
- Parent: `bd-e9fce1` — lazy browser creation with zero runtime/model/tool work before the first explicit message.
- Dependencies consumed: `bd-6a4170` draft contract/store, `bd-96c3e1` exact-once materializer, and `bd-930d31` preview-composer activation flow.

## Before state

- The draft CRUD/materialization backend was available, but Dash exposed no New Session action or draft pane.
- Workspace pane targets could identify sessions, but the SPA did not restore durable draft identities or attach a materialized draft directly by managed session identity.
- There was no browser form for cwd, persistence, name, model/thinking, tool allowlist, resources, trust, and isolation policy.
- The first-send materializer had no frontend consumer, cancellation path, inline ticket state, or managed-pane handoff.

## After state

- A prominent sidebar New Session button and Command-N shortcut open a purely local empty conversation draft with no network, runtime, tool, or provider side effect.
- The responsive, accessible draft pane validates bounded absolute cwd, optional name/model identity, persistence, thinking, neutral tool allowlist, resource discovery toggles, project trust, and the explicit unisolated boundary.
- Save Draft persists the server draft ID into the existing workspace target, allowing reload/restart restoration. A crash between implicit create and first send is recovered by the deterministic local target ID.
- Unsent local or persisted drafts cancel safely. Failed, pending, retryable, and indeterminate first-send states remain inline and lock unsafe blind replay.
- The first composer submission calls the durable exact-once materializer once, then replaces the draft target with a synthetic managed target and attaches `DashboardLiveSessionController` directly by session/generation. It does not refetch preview or submit the prompt again, and it adds no optimistic transcript duplicate.
- Embedded and dedicated clients share the same `DashboardBackend` draft methods; the production fixture implements matching create/cancel/send/live attach behavior.
- Root and detailed Dash plans now record all child slices as complete.

## Diff summary

- Code/content commit: pending final squash SHA from the reintegration receipt.
- Summary artefact commit: intentionally omitted; this file must not self-reference its own mutable SHA.
- Files touched: `PLAN.md`, `web/PLAN.md`, `web/src/app.tsx`, `web/src/session-draft.ts`, `web/src/components/NewSessionPane.tsx`, `Sidebar.tsx`, `ConnectedChatPane.tsx`, `dashboard-live-session.ts`, `use-dashboard-live-session.ts`, `live-fixture-backend.ts`, `app.css`, `icons.tsx`, `web/tsconfig.json`, focused unit/layout/controller tests, and `web/e2e/dash.spec.ts`.
- Tests: production Dash TypeScript/Vite build passed; 12 Vitest files / 60 tests passed; the new Playwright scenario is discovered successfully. Browser execution remains unavailable on Aurora because the downloaded Chromium lacks `libnspr4.so`, tracked by existing draft `bd-185516`.
- Behavioural delta: Dash can now retain a zero-runtime draft through workspace persistence and consume exactly one explicit first message to produce a managed live pane without a second lifecycle state machine or duplicate message.

## Operator-takeaway

New Session is now genuinely lazy: the operator may configure, save, restore, or cancel a draft without waking Pi, while the first message crosses one durable materialization/admission boundary and then hands control to the same live conversation UI used everywhere else.
