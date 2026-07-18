# Session summary — Normalized rich transcript and bounded semantic renderers

## Goal

Complete the production rich-transcript layer for Pi Daemon Dash: merge preview, optimistic, live, durable `entry_appended`, and replay-gap state by stable Pi identities; render every normalized record family beautifully and safely; keep large content, images, DOM, memory, and update work bounded; and preserve the already-proven first-paint and bundle budgets.

## Bead(s)

- `bd-c0df45` — Dash rich transcript: render Pi conversations and tools beautifully at streaming speed
- (parent: `bd-ba3623` — Build Pi Daemon Dash: beautiful fast browser session workspace)
- Coordinated blocker repair: `bd-e71126` — inventory bootstrap headroom; owned and landed by msm1 without weakening the 50 ms contract

## Before state

- The production shell displayed normalized messages, tools, timeline events, summaries, and custom records through a compact fixture renderer, but it had no state reducer for snapshot/live/durable reconciliation.
- Optimistic messages were appended directly to a React array, replay gaps were a visual-only demo, and session replacement did not rebind a normalized transcript store.
- Markdown was plain text, tool output was generic, image blocks had only a basic placeholder, and large record content lacked explicit per-view collapse/truncation behavior.
- Browser acceptance covered shell/navigation/editor behavior but not the complete rich record matrix or duplicate-free optimistic-to-persisted replacement.

## After state

- `transcript-store.ts` now fences state by host instance/session/generation, deduplicates by Pi message/tool/entry IDs, ranks persisted over live over optimistic sources, converts `entry_appended` to durable truth, ignores stale frames, marks replay gaps without appending, and clears gaps only through explicit reconciliation.
- Store count, aggregate bytes, and individual record bytes are bounded. A 1,200-record rapid-update test applies 120 existing-record live commits under the 16 ms p95 work budget.
- The app uses the reducer for fixture snapshot selection, optimistic prompt submission, delayed durable entry replacement, and replay-gap/reconcile transitions, proving one visible record rather than duplicate optimistic/live/persisted rows.
- Lazy rich rendering now covers user text/images, assistant safe markdown/thinking/error/usage/streaming, semantic timeline queue/retry/model/label/name events, compaction/branch summaries, hidden and visible custom entries, and generic custom tools.
- Built-in read/bash/edit/write/grep/search/find/list presentations get meaningful titles and bounded code, terminal, diff, or result previews. Large text/markdown/code/output is collapsed or truncated behind explicit controls.
- Raw HTML is rendered declaratively as text; no `dangerouslySetInnerHTML`, `eval`, or browser extension execution exists. Image sources are accepted only from object URLs or authorized `/dash/v1/` routes, with no data-URL path and no referrer.
- Final production receipt with 10,000 sessions and 1,200 mixed transcript records: 78.9 ms navigation-to-first-rows, 5.8 ms app-to-first-rows, 0.8 ms 10k search work, 4.1 ms maximum streaming commit work, 17 mounted session rows, 18 mounted transcript rows, 94,524 initial gzip bytes, and 340,952 total gzip bytes including lazy editor/rich/highlighter chunks.
- Frontend checks pass 15/15, browser acceptance passes 6/6, root `npm test` passes 214/214 (inventory bootstrap p95 23.20 ms), and `nix flake check` passes.

## Diff summary

- Code/content commits: `3065afc`, `4c1200b`, `0d88d56`, `70208d4`, `22ec8b6`, `5ac8bb7`
- Summary artefact commit: intentionally omitted; this file must not self-reference its own mutable SHA
- Files touched: `web/src/transcript-store.ts`, `web/src/components/RichTranscriptRecord.tsx`, `web/src/components/SyntaxCodeBlock.tsx`, `web/src/components/ChatPane.tsx`, `web/src/app.tsx`, `web/src/app.css`, `web/src/fixtures.ts`, `web/src/components/Workspace.tsx`, frontend tests/Playwright, `web/SPIKE.md`, `web/PLAN.md`, `CHANGELOG.md`, and visual/performance artefacts
- Tests: +5 transcript-store cases, expanded rich browser scenario, expanded security/theme source contract; no tests removed or weakened
- Validation: `npm run web:build`; `npm run web:test` (15/15); `DASH_TEST_PORT=48194 npm run web:e2e` (6/6); `npm test` (214/214); `nix flake check`; production bundle/capture scripts
- Behavioural delta: normalized transcript data now has a bounded, generation-safe browser state machine and complete rich presentation layer rather than direct array append plus generic cards.

## Embedded artefacts

- `web/artifacts/nord-midnight-reference.png` — default rich viewport with bounded image, safe markdown/code, specialized edit/bash tools, source/state badges, and information pane
- `web/artifacts/nord-midnight-sidebar-details.png` — rich viewport plus expanded session groups and focus metadata tooltip
- `web/artifacts/performance.json` — final production bundle, first-row, search, stream-work, heap, and mounted-row receipt
- `web/SPIKE.md` — updated production architecture handoff including reducer and lazy-renderer constraints

## Operator-takeaway

Dash now has a real transcript engine rather than just attractive transcript cards: it can accept persisted preview, rapid live partials, durable entry replacement, stale generations, and replay gaps without duplicate rows or unbounded browser state. The full semantic surface remains lazy, safe, and comfortably inside the original first-paint, DOM, bundle, and frame-work budgets.
