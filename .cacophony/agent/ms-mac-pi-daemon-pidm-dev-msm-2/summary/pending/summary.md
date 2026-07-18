# Session summary — Canonical capability-gated Shadow TUI host

## Goal

Implement the daemon-side canonical Shadow TUI host and authenticated channel adapters around the accepted `VirtualTerminal` and public `DashboardTuiChannel` contract—one runtime/view/external-UI broker per session generation, controller-only input and dimensions, observer mirrors, bounded snapshots/deltas/replay, and dedicated-mode parity—while refusing to instantiate Pi's unsafe current process-owning `InteractiveMode` until the documented public view factory exists.

## Bead(s)

- `bd-da9e31` — Dash TUI core: host one injected VirtualTerminal view per session and stream bounded grids
- (parent: `bd-ba3623` — Build Pi Daemon Dash: beautiful fast browser session workspace)

## Before state

- `VirtualTerminal` already proved bounded ANSI/Unicode/grid projection, cursor/title/input/resize, Pi component rendering, side-channel stripping, and frame performance.
- The browser `TuiGrid`/frame store already enforced identity, generation, contiguous sequence, frame bounds, controller-only input, observer mirrors, and replay-gap recovery.
- `InProcessDashboardBackend` and the neutral API exposed injected TUI manager seams, but only `UnavailableDashboardTuiAttachments` existed; no canonical server host owned view/broker/replay state.
- Pi 0.80.6 still lacked the proposed host-safe `createInteractiveSessionView` facade. Current `InteractiveMode` hardcodes `ProcessTerminal`, process lifecycle/tool resolution, private render state, and duplicate extension binding, so product use remained forbidden.

## After state

- `ShadowTuiHost` implements the embedded TUI manager seam and requires an injected public-shape view factory, runtime resolver, and external extension-UI broker. It never imports or constructs `InteractiveMode`, `ProcessTerminal`, private `doRender`, or `bindExtensions`.
- Exactly one `(hostInstanceId, sessionId, generation)` hub owns one runtime reference, `VirtualTerminal`, interactive view, broker binding, replay buffer, controller, and peer set. Concurrent opens join the same pending/active hub; generation invalidation tears down broker/view/peers before replacement.
- VirtualTerminal now publishes frame-pending notifications for writes, resize, title, and progress. The host coalesces them through one immediate boundary; the first forced frame is the snapshot and later publications use an independent contiguous dashboard sequence/cursor.
- Full/delta mapping drops terminal-only columns and href metadata, preserves the bounded style vocabulary, and converts ANSI indexed/RGB colors to deterministic lowercase browser hex. Cursor, title, dimensions, identity, and generation are preserved exactly.
- One controller owns resize and semantic key/text/paste input; observers receive canonical frames and cannot mutate. Unsupported/meta keys fail closed, Ctrl letters map to C0, special/Alt keys map deterministically, text is one terminal-bounded event, and paste chunks only at UTF-8 boundaries under browser and 16 KiB terminal ceilings.
- Replay returns retained contiguous deltas or an explicit typed gap followed by the authoritative snapshot. Controller events stay orthogonal to terminal rows. Last close, host disposal, generation replacement, view-requested exit, and initialization failure all unbind/stop/discard bounded state.
- `ShadowTuiAttachmentManager` exposes the same channel over authenticated `/v1/dashboard/session/{sessionRef}/tui` with `pi-daemon-tui.v1`. It validates role/generation/dimensions/input, bounds both directions, orders normal snapshot/replay and gap→snapshot correctly, acknowledges commands, streams delta/control frames, and closes the underlying channel on every socket/error path.
- `InProcessDashboardBackend` now forwards lifecycle invalidation/disposal to injected TUI managers and continues to own renewable residency leases around delegated channels.
- Product capability remains honestly unavailable unless a host-safe view factory is injected. The implemented host substrate is ready for the upstream facade without a private fallback.
- New root/package exports `./shadow-tui-host` and `./shadow-tui-attachments` are documented and clean-package tested.
- Focused host/VirtualTerminal/attachment/package/release checks pass 34/34; rapid publication p95 is about 0.21 ms in the loaded full run; full `npm test` passes 259/259 and `nix flake check` passes.

## Diff summary

- Code/content commits: `aa76ec0`, `0cc85a3`
- Summary artefact commit: intentionally omitted; this file must not self-reference its own mutable SHA
- Files touched: new `src/shadow-tui-host.ts`, `src/shadow-tui-attachments.ts`, and `test/shadow-tui-host.test.mjs`; `src/virtual-terminal.ts`, `src/dashboard-backend.ts`, `src/index.ts`, `package.json`; RPC attachment/package/release tests; `docs/shadow-tui.md`; `web/PLAN.md`; and `CHANGELOG.md`
- Tests: +5 canonical host scenarios, +1 authenticated neutral WebSocket scenario, expanded package/release coverage; no tests removed or weakened
- Validation: `npm run check`; focused host/VirtualTerminal/RPC attachment/package/release tests (34/34); clean npm pack/import; `npm test` (259/259); `nix flake check`
- Behavioural delta: Pi Daemon now has one complete, bounded, transport-neutral server host/channel substrate for shadow TUI, but advertises it only when the required public InteractiveSessionView factory is supplied.

## Operator-takeaway

The hard part of Shadow TUI ownership is now explicit and implemented without compromising Pi Daemon's one-runtime/one-writer boundary. Embedded and dedicated panes can share one canonical, replayable, controller-fenced grid and external extension UI broker; the final activation switch remains correctly gated on a small upstream public view facade rather than a hidden `InteractiveMode` hack or child Pi process.
