# Session summary — Wake preview sessions from the composer

## Goal

Make Dash preview sessions behave like normal readable conversations: keep the transcript scrollable and the composer pinned in place, then use the first deliberate send to activate or hydrate the session and submit exactly one prompt without performing SDK/model work merely for preview.

## Bead(s)

- `bd-930d31` — Dash preview sessions: replace blocking modal with wake-on-first-send composer.

## Before state

- `LiveSessionControls` rendered an absolute action card over preview, activation-error, preview-only, and indeterminate sessions, obscuring transcript inspection.
- `ChatPane` disabled the composer for every phase except `live`/`streaming`, so an eligible dormant or external preview had no useful first-message path.
- `DashboardLiveSessionController.start()` eagerly hydrated every managed session and auto-activated reusable external sessions before any user send.
- Composer submission cleared the draft immediately even when activation or command admission failed.
- The chat grid assumed a fixed-height controls row while the controls component could emit several sibling rows, allowing the footer/composer to drift from the intended fixed bottom position.

## After state

- Preview transcript content has no blocking action modal; activation and policy status is rendered inline immediately above the composer.
- Dormant managed and external sessions stay in preview with zero channel opens/activations until first send. Resident managed sessions still attach for live events without submitting a prompt.
- External previews default to safe fork, expose explicit direct/fork selection at the composer, and run activation, hydration, then one prompt as a single first-send UI flow. Dormant managed sessions hydrate then prompt once.
- Failed or indeterminate activation never submits the prompt, disables unsafe replay, and preserves the composer draft for reconciliation or retry. Non-activatable policy states remain readable and disable only the composer.
- Later live submissions retain normal prompt, steering, follow-up, command, controller, and idempotency behavior.
- The chat grid now gives transcript the sole flexible scrolling row and keeps the footer as the final fixed row.

## Diff summary

- Code/content commit: pending final squash SHA from the reintegration receipt.
- Summary artefact commit: intentionally omitted; this file must not self-reference its own mutable SHA.
- Files touched: `web/src/dashboard-live-session.ts`, `web/src/components/ConnectedChatPane.tsx`, `web/src/components/ChatPane.tsx`, `web/src/components/Composer.tsx`, `web/src/components/LiveSessionControls.tsx`, `web/src/app.css`, `web/src/test/dashboard-live-session.test.ts`, `web/src/test/chat-pane-layout.test.ts`, `web/e2e/dash.spec.ts`.
- Tests: Dash TypeScript/Vite production build passed; 11 Vitest files / 54 tests passed; focused controller/layout tests passed 14/14; the new Playwright scenario passes discovery/type loading but browser launch on Aurora is blocked by missing `libnspr4.so`.
- Behavioural delta: preview is now cold, fully inspectable, and first-send actionable instead of modal-blocked. Prompt admission occurs only after a successful activation/hydration boundary.
- Follow-up: draft `bd-185516` tracks a reproducible Nix Playwright runtime so browser scenarios can execute on Linux workers without host packages.

## Operator-takeaway

Opening a session is once again safe and cheap: Dash paints persisted history without waking Pi, while the composer clearly tells the operator what ownership action the first send will perform and preserves uncertainty rather than replaying blindly.
