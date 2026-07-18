# Session summary — Revisioned split workspaces, settings, and composer controls

## Goal

Turn the visual split/editor/settings spike into the production Dash workspace layer: persist a bounded binary pane tree and selected focus through revisioned public resources, provide complete mouse and keyboard alternatives, share session state across duplicate panes, make UI settings source-aware and resettable, and finish the real Vim/multiline composer experience without regressing the measured shell or rich transcript.

## Bead(s)

- `bd-5f9ca1` — Dash workspace: persistent mouse-resizable splits, keyboard swaps, settings and Vim composer
- (parent: `bd-ba3623` — Build Pi Daemon Dash: beautiful fast browser session workspace)
- Reflection draft: `bd-2c6d58` — document clean-install check after dependency-changing rebases

## Before state

- The shell started with one hardcoded two-pane layout and supported divider drag, arrow resize, and Ctrl directional focus/swap, but users could not create or close panes and layout changes were not persisted.
- Workspace state was local React state rather than `DashboardWorkspaceResource`; revision, ETag-equivalent conflict, idempotency, debounce/coalescing, and server-truth recovery behavior were absent.
- The settings modal displayed one theme and hardcoded revision/source prose. Density, Vim, and reduced motion were local booleans with no `DashboardSettingsResource` patch/reset semantics.
- CodeMirror had multiline and Vim input plus send, but no bounded prompt history, command completion, or discoverable keyboard guide.
- Browser acceptance covered six scenarios and frontend checks covered fifteen cases.

## After state

- Binary layout helpers now create horizontal/vertical splits while retaining populated content left/top, close panes by promoting siblings, collect pane IDs, clamp ratios, and round-trip exactly through the public `DashboardLayoutNode` shape.
- Every pane has accessible split/close controls with an eight-pane UI bound. Mouse drag and separator-arrow resize update the same measured layout path; Ctrl-hjkl focus and Ctrl-Shift-hjkl swaps retain the moved pane's focus.
- A typed local `DashboardPreferencesBackend` exercises the same public workspace/settings resources used by the server: expected revisions, idempotency-key join/refusal, serial saves, drag coalescing, optimistic dirty/saving/synced state, stale-conflict reload, and reset to configured truth.
- Duplicate panes targeting one session visibly reuse the same normalized transcript store rather than creating a second session channel/runtime.
- Settings now hot-switch Nord Midnight/Frost semantic themes, density, Vim/multiline mode, and reduced motion; each field shows default/config/runtime provenance, revision/sync state, and server-style runtime-overlay reset.
- CodeMirror now provides bounded 50-entry Alt-Up/Down history, slash-command completion with Tab/click, multiline paste, native IME behavior, real Vim mode, and one shared submit path. A labelled keyboard dialog documents pane, divider, editor, settings, and help shortcuts.
- Four visual baselines cover the default rich shell, metadata filters, Nord Frost revisioned settings, and a synced nested split with visible pane controls.
- A 20-run production-browser receipt reports 67.6 ms navigation-to-first-rows p95, 3.7 ms app-to-first-rows p95, 1.9 ms 10k search work, 3.8 ms maximum stream/resize commit work, 98,477 initial gzip bytes, and 345,290 complete gzip bytes.
- Frontend checks pass 20/20; Playwright acceptance passes 9/9; clean-install root `npm test` passes 239/239 (inventory bootstrap p95 3.11 ms); and `nix flake check` passes on the combined VirtualTerminal, ownership, and workspace main.

## Diff summary

- Code/content commits: `10351f2`, `a48ba04`
- Summary artefact commit: intentionally omitted; this file must not self-reference its own mutable SHA
- Files touched: `web/src/layout.ts`, `web/src/components/Workspace.tsx`, `web/src/preferences-backend.ts`, `web/src/use-dashboard-preferences.ts`, `web/src/components/SettingsModal.tsx`, `web/src/components/KeyboardHelp.tsx`, `web/src/components/Composer.tsx`, `web/src/components/ChatPane.tsx`, `web/src/app.tsx`, semantic CSS/theme, frontend unit/Playwright tests, capture tooling, `web/SPIKE.md`, `web/PLAN.md`, `CHANGELOG.md`, and four visual/performance artefacts
- Tests: +6 revisioned preference/layout cases and +3 browser workspace/settings/editor scenarios; no tests removed or weakened
- Validation: `npm ci --ignore-scripts`; `npm run web:test` (20/20); `DASH_TEST_PORT=48206 npm run web:e2e` (9/9); `npm test` (239/239); `nix flake check`; 20-run production bundle/capture measurement
- Behavioural delta: workspace geometry, selected pane, UI preferences, and editor behavior now flow through bounded, conflict-aware public resource seams instead of isolated local toggles.

## Embedded artefacts

- `web/artifacts/nord-midnight-reference.png` — default rich workspace baseline
- `web/artifacts/nord-midnight-sidebar-details.png` — session groups and focus metadata baseline
- `web/artifacts/nord-frost-settings.png` — hot-switched theme, source badges, runtime revision, and reset controls
- `web/artifacts/nord-midnight-workspace-split.png` — synced nested split with pane controls and promoted empty sibling
- `web/artifacts/performance.json` — 20-run first-row samples/p95 plus bundle, search, frame-work, heap, and DOM receipts
- `web/SPIKE.md` — updated persistence, shared-store, editor, and downstream integration constraints

## Operator-takeaway

Dash panes and settings are now real revisioned product state rather than visual-only local React controls. Follow-on TUI and live-integration work can wire presentation/channel data into stable split/focus APIs while preserving one shared session store, conflict-safe persistence, complete mouse/keyboard accessibility, and the existing performance envelope.
