# Session summary — Policy-preserving embedded DashboardBackend

## Goal

Implement the embedded deployment's exact `DashboardBackend` seam by composing Pi Daemon's existing inventory, transcript projection, ownership, catalog, runtime, RPC controller, scheduler, and TUI-channel authorities directly—removing transport overhead without creating a second session state machine or bypassing generation, idempotency, controller, path, durability, replay, or eviction policy.

## Bead(s)

- `bd-e1e692` — Dash embedded backend: bind direct services without bypassing daemon policy
- (parent: `bd-ba3623` — Build Pi Daemon Dash: beautiful fast browser session workspace)

## Before state

- The public `DashboardBackend`, Rich/TUI channel, capability, resource, cursor, ticket, and frame contracts existed and were consumed by fixtures/browser code, but no in-process implementation was exported.
- `DashboardServer` required an injected backend while inventory, projector, ownership, catalog, Multiplexer, and RPC controller services worked independently.
- Dormant RPC attachment still required an explicit normal runtime reopen, idle eviction had no renewable visible-pane lease, and embedded Rich panes had no shared controller/replay hub.
- Browser TUI and neutral service API work were proceeding independently behind the unchanged contract.

## After state

- `InProcessDashboardBackend` implements every existing interface method and is exported from root plus `./dashboard-backend`. Inventory/info, exact-fingerprint preview projection, activation/export durable tickets, and managed resources delegate to their owning services without duplicating validation.
- Dormant durable sessions hydrate through persisted catalog configuration and normal `Multiplexer.open`, including generation, fork-source, and provisioned-environment checks. A focused test proves hydration performs a second runtime open and zero prompt submissions.
- Rich panes for one session/generation share one `PiRpcController` subscription, synchronous snapshot/high-water boundary, bounded replay, and controller authority. Observers remain read-only; controller release cancels pending extension UI.
- Commands are generation-fenced and serialized. Payloads cannot spoof type/correlation identity. Semantic idempotency keys join exact duplicates once, reject changed content, preserve each caller's correlation ID, and retain bounded results.
- Pi output becomes bounded session/extension events with contiguous cursors. Invalid host/generation, expired/ahead, and evicted cursors yield explicit typed replay gaps plus the fresh snapshot. Nonserializable output becomes a safe replacement event.
- Multiplexer now owns bounded renewable session residency leases. Active leases defer idle eviction; expiry, close, generation replacement, channel/backend disposal, and global disposal release state.
- TUI is capability-gated and delegated to an injected transport-neutral canonical manager. The backend validates returned presentation/identity, renews and releases its lease on all paths, and preserves controller-only input plus read-only observer semantics expected by the landed browser TUI frame store.
- Effective capabilities publish actual replay/subscription/event/lease limits and advertise TUI availability only when a manager is injected.
- Documentation and clean-package/release checks include the backend while preserving independently landed `DashboardNeutralApi`, `pi-daemon-tui.v1`, browser TUI, ownership, and server exports.
- Focused backend/multiplexer/neutral/package/release checks pass; full `npm test` passes 253/253 and `nix flake check` passes on current main with the audited Ajv upgrade.

## Diff summary

- Code/content commits: `2edf678`, `314dafa`
- Summary artefact commit: intentionally omitted; this file must not self-reference its own mutable SHA
- Files touched: new `src/dashboard-backend.ts`; `src/multiplexer.ts`; `src/index.ts`; `package.json`; new `test/dashboard-backend.test.mjs`; multiplexer/package/release tests; `docs/dashboard-protocol.md`; `web/PLAN.md`; and `CHANGELOG.md`
- Tests: +5 embedded backend conformance scenarios, +1 renewable residency lease scenario, expanded package/release coverage; no tests removed or weakened
- Validation: `npm run check`; focused embedded/multiplexer/neutral/package/release tests; clean npm pack/import; `npm test` (253/253); `nix flake check`
- Behavioural delta: embedded Dash can now use a real direct backend whose only shortcut is omission of wire serialization; catalog, ownership, runtime, scheduler, controller, cursor, TUI, and eviction policy remain authoritative.

## Operator-takeaway

Embedded Dash is no longer a planned shortcut or mock adapter. It now exercises the same public contract as dedicated mode while preserving daemon truth: multiple Rich panes coalesce safely, dormant sessions hydrate without prompting, replay and controller state are bounded and explicit, and the canonical TUI manager can plug in without browser-specific server state.
