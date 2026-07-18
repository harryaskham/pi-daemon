# Session summary — Measured Nord Midnight Dash foundation

## Goal

Prove and retain a production-representative browser foundation for Pi Daemon Dash: a beautiful semantic Nord Midnight shell that paints quickly, stays bounded with 10,000 sessions and long mixed transcripts, supports real CodeMirror/Vim input and accessible split interactions, consumes the newly landed public dashboard contract, and leaves exact dependency, performance, visual, security, and architecture evidence for the follow-on product slices.

## Bead(s)

- `bd-493121` — Dash frontend spike: prove a beautiful 60fps SPA stack and Nord Midnight visual system
- (parent: `bd-ba3623` — Build Pi Daemon Dash: beautiful fast browser session workspace)
- Related security finding: `bd-a4347b` — upgrade the pre-existing vulnerable Ajv test dependency; deliberately not bundled into this frontend slice

## Before state

- No `web/` implementation, frontend workspace, browser build, browser tests, semantic theme, visual baseline, or frontend performance receipt existed.
- The ready-wave protocol and configuration slices were being implemented in parallel, so the spike began behind a private fixture seam and needed to rebase onto their exact exported types without duplicating backend state.
- The repository had no proof that a 10,000-session browser could paint bounded rows, search quickly, stream inside a frame budget, provide Vim/IME behavior, or preserve directional split focus.
- `npm audit` exposed one pre-existing moderate Ajv advisory only after workspace installation; the frontend graph added no Ajv copy.

## After state

- `web/` is an exact-pinned React 19/Vite 8 TypeScript workspace with TanStack Virtual, a dynamically loaded CodeMirror 6 + Vim composer, a first-party split-tree reducer, Playwright/Vitest acceptance, and no CDN or runtime build dependency.
- The production UI includes virtual session/transcript viewports, chat/tool/timeline rendering over `NormalizedTranscriptRecord`, chat and information panes, semantic liveness, controller/hydration fences, five deliberate visual states, settings, context chips, mouse/keyboard split resizing, Ctrl directional focus/swaps, responsive/reduced-motion/contrast policies, and owner-truthful `trusted · unisolated` messaging.
- The private fixture backend now implements the public `DashboardBackend` inventory/transcript methods and consumes canonical limits, budgets, cursor brands, normalized records, liveness, presentation capabilities, and stream identity fixtures through the package export names.
- Production capture with 10,000 sessions measured 123.0 ms navigation-to-first-rows, 33.0 ms module-ready-to-first-rows, under 1 ms in-app search work, 8.1 ms maximum streaming commit work, 17 mounted session rows, and 15 mounted transcript rows.
- The Vite manifest reports 89,063 initial gzip bytes and 331,122 complete gzip bytes including the 241,711-byte lazy editor chunk, against the 1.5 MiB budget.
- Root Node tests pass 179/179, browser acceptance passes 3/3, frontend unit tests pass 7/7, and `nix flake check` passes with the refreshed npm dependency hash and a temporary server-only workspace-symlink removal until the lifecycle packaging bead embeds compiled assets.

## Diff summary

- Code/content commits: `e7ebe07`, `8fcff56`, `f4d85ec`
- Summary artefact commit: intentionally omitted; this file must not self-reference its own mutable SHA
- Files touched: root `package.json`, `package-lock.json`, `flake.nix`, `.gitignore`, `CHANGELOG.md`; `web/PLAN.md`; and the new `web/` workspace, components, fixture adapter, model, reducers, theme, tests, scripts, design decision, PNG baseline, and JSON receipt
- Tests: +7 focused frontend unit assertions, +3 production-browser acceptance scenarios, no tests removed or weakened
- Validation: `npm run web:build`; `npm run web:test`; `DASH_TEST_PORT=48182 npm run web:e2e`; `npm test` (179/179); `nix flake check`; `npm ls ajv --all`; production bundle and Playwright capture scripts
- Behavioural delta: the server runtime remains unchanged, but the repository now contains the reusable, measured SPA foundation and public-contract consumption path that unblocks the production shell, rich transcript, workspace, TUI pane, live integration, and final packaging beads.

## Embedded artefacts

- `web/artifacts/nord-midnight-reference.png` — deterministic 1440×960 high-fidelity visual baseline showing the virtual sidebar, mixed transcript/tool state, composer, context, focused split, and information/policy pane
- `web/artifacts/performance.json` — machine-readable production asset sizes, first-row/search/frame-work timings, heap sample, and mounted-row counts
- `web/SPIKE.md` — exact dependency/license decision, measured architecture rationale, security receipt, and downstream compatibility rules

## Operator-takeaway

This is not a throwaway mock: the checked-in UI is already bounded, contract-shaped, visually reviewable, keyboard/IME aware, exact-pinned, Nix-safe, and fast enough to meet the first-row and frame-work budgets. Follow-on agents can replace the local backend with embedded or remote adapters without rewriting the visual system, split reducer, normalized renderer, or progressive first-paint path.
