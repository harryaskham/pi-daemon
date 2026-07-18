# Dash frontend stack decision — bd-493121

Status: selected and promoted through production shell, rich transcript, and revisioned workspace milestones (`bd-cc87cb`, `bd-c0df45`, `bd-5f9ca1`)

Reference captures:

- [`artifacts/nord-midnight-reference.png`](artifacts/nord-midnight-reference.png) — default shell
- [`artifacts/nord-midnight-sidebar-details.png`](artifacts/nord-midnight-sidebar-details.png) — expandable source/state filters and keyboard-focus metadata tooltip
- [`artifacts/nord-frost-settings.png`](artifacts/nord-frost-settings.png) — source-aware revisioned settings and hot semantic theme switch
- [`artifacts/nord-midnight-workspace-split.png`](artifacts/nord-midnight-workspace-split.png) — persisted nested split, pane controls, and promoted empty sibling

Machine-readable receipt: [`artifacts/performance.json`](artifacts/performance.json)

## Decision

Use an exact-pinned React 19 + Vite 8 TypeScript workspace for the self-contained Dash SPA. Use TanStack Virtual for the session and transcript viewports, CodeMirror 6 with the maintained Replit Vim binding for the composer, semantic CSS custom properties for Nord Midnight, and a small first-party binary split-tree reducer rather than a layout framework.

The spike is production structure, not a disposable mock:

- `src/fixture-backend.ts` is typed against the public `DashboardBackend` inventory/transcript methods from `@harryaskham/pi-daemon/dashboard-contract`.
- Public capability, limit, cursor, inventory, transcript, presence, and stream fixtures come from `dashboard-contract` / `dashboard-fixtures`; frontend-only fields remain explicitly named view fixtures.
- A tiny progressive bootstrap paints bounded session rows first. The 10,000-record fixture index and interactive workspace are expanded in a transition after first paint.
- Only viewport rows are mounted. A normal 1440×960 capture held 17 of 10,000 session rows and 18 rich transcript rows in the DOM.
- The editor is a dynamic chunk. First rows do not wait for CodeMirror/Vim parsing.
- Embedded and dedicated deployments are absent from SPA logic. Replacing `LocalFixtureBackend` with either real adapter does not change components or reducers.

## Exact dependency selection

| Package | Pin | License | Selection evidence |
| --- | ---: | --- | --- |
| `react`, `react-dom` | `19.2.7` | MIT | Concurrent transitions keep full-index expansion outside first paint; stable component/a11y ecosystem. |
| `vite` | `8.1.4` | MIT | Produces a content-hashed static SPA and manifest with no runtime build process or CDN. |
| `@vitejs/plugin-react` | `6.0.3` | MIT | Exact React transform integration for the static build. |
| `@tanstack/react-virtual` | `3.14.5` | MIT | Dynamic-height transcript and fixed-height 10k sidebar mount bounded viewport rows. |
| CodeMirror packages | exact `6.x` pins | MIT | IME-safe multiline editor, lazy Markdown support, accessible contenteditable surface. |
| `@replit/codemirror-vim` | `6.3.0` | MIT | Real modal Vim behavior instead of a partial custom emulation. |
| `lucide-react` | `1.24.0` | ISC | Tree-shaken, consistent accessible icon geometry; no font or network asset. |
| `@playwright/test` | `1.61.1` | Apache-2.0 | Production-build keyboard, state, virtualization, responsive visual, and timing evidence. |
| `vitest` | `4.1.10` | MIT | Fast pure split-tree and contract-fixture checks. |

All direct npm dependencies are exact, lockfile-pinned, and local. There is no runtime CDN, fetched font, inline script, `eval`, or arbitrary extension code.

## Measured result

The checked-in receipt was produced from a Vite production build and Playwright Chromium 149 at 1440×960 with 10,000 deterministic sessions and a 1,200-record mixed transcript fixture.

| Measure | Result | Budget | Outcome |
| --- | ---: | ---: | --- |
| Navigation to first bounded rows, 20-run p95 | 67.6 ms | <150 ms | pass |
| App/module-ready to first rows, 20-run p95 | 3.7 ms | <150 ms | pass |
| In-app 10k search work | 1.9 ms | <100 ms | pass |
| Streaming/resize commit work, max observed | 3.8 ms | <16 ms | pass |
| Mounted session rows | 17 / 10,000 | not O(total) | pass |
| Mounted transcript rows | 18 / 1,200 | not O(total) | pass |
| Initial production gzip | 98,477 bytes | <1.5 MiB | pass |
| Complete production asset gzip, including lazy editor and rich renderer | 345,290 bytes | <1.5 MiB | pass |

`animationFrameCadenceP95Ms` in the receipt is display cadence (about 16.7 ms at 60 Hz), not JavaScript work. `streamFrameWorkMaxMs` is the measured React commit path compared with the 16 ms frame-work budget.

## Interaction and visual proof

The reference artifact contains the reusable shell, virtual session list, normalized rich transcript, bounded image placeholder, safe markdown/code, specialized edit/bash tool states, controller/hydration fence, split chat and information panes, CodeMirror composer, context chips, and owner-truthful `trusted · unisolated` policy. Runtime controls expose deterministic `ready`, `streaming`, `skeleton`, `empty`, and `error` states for visual regression.

Focused browser acceptance proves:

- 10k sidebar and long transcript DOM bounds;
- search, functional expandable state/source filters, and all deliberate visual states;
- hover/focus metadata tooltip, information-pane selection, loading/error recovery, and mobile drawer controls;
- revisioned settings patch/reset with effective source badges and hot Nord theme switching;
- nested split creation, mouse/keyboard resize, close-and-promote, eight-pane bound, and persisted revision receipts;
- `Ctrl-h/j/k/l` spatial focus and focus-preserving `Ctrl-Shift-h/j/k/l` target swaps outside the editor;
- shared session transcript-store reuse across panes;
- CodeMirror/Vim lazy loading, command completion, 50-entry history, multiline paste, and IME-shaped Unicode input without pane-focus leakage;
- discoverable keyboard help and screen-reader-labelled dialogs/controls; and
- narrow responsive structure in CSS with reduced-motion and increased-contrast policies.

## Architecture handoff

Follow-on shell, transcript, workspace, and live-integration beads should preserve these seams:

1. Consume `SessionInventoryPage` and `TranscriptPage` as public data; do not import server implementation state.
2. Keep preview `hydration: "not-requested"` and reconcile live records by Pi IDs, never rendered text or array position.
3. Fence every live subscription by `hostInstanceId + sessionId + generation` and return opaque cursors unchanged.
4. Keep rich and TUI presentations capability-gated peers. This spike does not fabricate TUI availability.
5. Route snapshot/live/`entry_appended`/gap transitions through `transcript-store.ts`; persisted records outrank live and optimistic records by Pi identities, stale host/generation frames are ignored, and gaps never append duplicates.
6. Retain progressive first paint and byte/count-bounded viewport caches when replacing fixtures with the embedded and remote backends.
7. Keep CodeMirror/Vim and rich markdown/syntax rendering out of the first-row dependency graph; their lazy chunks are intentionally measurable.
8. Keep colors and visual states in `theme.css`. Component CSS may consume semantic tokens but must not introduce literal presentation colors.
9. Persist layout and UI settings only through public revisioned workspace/settings resources. Coalesce drag updates, use expected revisions and idempotency keys, and reconcile conflicts from server truth.
10. Reuse one transcript/session store for duplicate pane targets; a visual split must never create a second runtime or channel.
11. Until `bd-31ee8f` packages compiled assets, Nix deliberately removes npm's private-workspace source symlink during server-only installation; that later bead must copy the Vite manifest/assets into the final artifact rather than preserving a source-tree link.

## Security receipt

The SPA adds no service bearer handling and does not persist credentials. Fixture records are content-safe and contain no prompts or provider output from real sessions. The capture server is a bounded loopback-only build script with canonical path containment and no child process.

`npm audit` remains nonzero only for the repository's pre-existing direct test dependency `ajv@8.17.1` under GHSA-2g4f-4pwh-qvx6. The frontend dependency graph adds no second Ajv copy (`npm ls ajv --all` shows the single root copy). The unrelated upgrade is tracked separately as `bd-a4347b` rather than hidden inside this slice.
