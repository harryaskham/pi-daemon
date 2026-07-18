# Session summary — Production Dash shell and accessible session navigation

## Goal

Promote the measured Dash frontend spike into the stable production SPA shell that follow-on transcript, workspace, TUI, and live-backend slices can inhabit: a responsive, accessible, contract-shaped session browser with real filters, explicit lifecycle states, rich information affordances, semantic theming, and unchanged performance bounds.

## Bead(s)

- `bd-cc87cb` — Dash SPA shell: ship the measured fast app, sidebar, info view and semantic theme foundation
- (parent: `bd-ba3623` — Build Pi Daemon Dash: beautiful fast browser session workspace)

## Before state

- `bd-493121` had landed the exact-pinned React/Vite/TanStack/CodeMirror stack, virtual session/transcript paths, split workspace, Nord Midnight theme, and one high-fidelity screenshot.
- Sidebar search worked, but the All/Running/Unread controls were visual-only, source/schedule groups were absent, metadata required a click, sidebar loading/error recovery was not represented, and narrow screens had no explicit drawer controls.
- Browser acceptance covered three core scenarios and frontend unit tests covered seven reducer/fixture cases.
- The landed npm workspace lock retained a noncanonical nested `pi-ai` bin path that a clean Nix dependency cache normalized differently, causing a package-lock consistency failure once another source change invalidated the cached package build.

## After state

- Sidebar filters are functional across all/running/unread/scheduled/managed/external records, with expandable source/state groups, bounded counts, stable virtual scrolling, and accessible pressed state.
- Hovering or keyboard-focusing an information control opens a portal-based metadata tooltip without expanding row height; clicking it opens the full information pane. Titles remain server-normalized, while project/cwd/age/liveness/unread facts are exposed without canonical paths from inventory data.
- Contract-shaped `ready`, `loading`, `empty`, `error`, retry, and background-reconciling states are explicit. The responsive shell has a focusable mobile drawer open/close path and scrim while desktop layout remains unchanged.
- A source contract test proves component/layout files contain no literal colors, and contrast checks preserve readable primary, muted, and accent pairs.
- Production capture now records 116.4 ms navigation-to-first-rows, 46.9 ms module-ready-to-first-rows, 0.5 ms 10k search work, 6.6 ms maximum streaming commit work, 90,952 initial gzip bytes, and 333,014 complete gzip bytes.
- Browser acceptance passes 5/5, frontend unit/contract checks pass 9/9, root Node tests pass 188/188, and `nix flake check` passes.
- The nested Pi lock bin is preserved in npm’s canonical `./dist/cli.js` form, matching the already refreshed Nix dependency cache and eliminating the consistency failure without changing dependencies.

## Diff summary

- Code/content commits: `bacffba`, `30fbf74`
- Summary artefact commit: intentionally omitted; this file must not self-reference its own mutable SHA
- Files touched: `web/src/components/Sidebar.tsx`, `web/src/app.tsx`, `web/src/app.css`, `web/src/test/theme.test.ts`, `web/e2e/dash.spec.ts`, `web/scripts/capture-artifacts.mjs`, `web/artifacts/*`, `web/SPIKE.md`, `web/PLAN.md`, and `package-lock.json`
- Tests: +2 browser scenarios, +2 semantic-theme assertions, no tests removed or weakened
- Validation: `npm run web:build`; `npm run web:test` (9/9); `DASH_TEST_PORT=48183 npm run web:e2e` (5/5); `npm test` (188/188); `nix flake check`; production bundle/capture scripts
- Behavioural delta: the fixture-backed SPA now behaves like a production shell at the session-navigation boundary while remaining deployment-neutral and typed only against public Dashboard contracts.

## Embedded artefacts

- `web/artifacts/nord-midnight-reference.png` — default production shell baseline
- `web/artifacts/nord-midnight-sidebar-details.png` — expanded source/state groups and keyboard-focus metadata tooltip baseline
- `web/artifacts/performance.json` — updated production asset, first-row, search, frame-work, heap, and mounted-row receipt
- `web/SPIKE.md` — promoted stack decision and production shell handoff constraints

## Operator-takeaway

The browser foundation is now an actual reusable product shell rather than a styled spike: session navigation is functional, bounded, keyboard/mobile aware, explicit under failure/reconcile states, and still comfortably inside the original first-paint and frame budgets. Rich transcript and live-backend work can attach to this host without re-solving information architecture, accessibility, theming, or performance.
