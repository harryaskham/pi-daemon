---
title: Pi Daemon Dash v1 acceptance
---

# Pi Daemon Dash v1 acceptance

This is the release receipt for `bd-7de9ec`. It records measured production
artifacts and live embedded/dedicated behavior rather than fixture-only claims.
The final wall-clock soak is intentionally tracked separately at the end.

## Exact candidate

- Main candidate: `7f5280b` (`bd-ea2019` live browser integration).
- Rolling embedded instance: `http://127.0.0.1:7474/dash/`.
- API: `http://127.0.0.1:7473`, with the bearer read only from the owner-private
  test token file.
- Nix result: `/nix/store/nap958namyrcmgm8v45nsxxkhawjklmz-pi-daemon-0.1.0`.
- Primary launchd API on 7463 remained untouched throughout acceptance.

## Browser and backend evidence

The packaged production SPA presents an input-only web-credential screen. The
credential is exchanged through same-origin `POST /dash/v1/login`; browser code
receives an opaque `HttpOnly`, `SameSite=Strict` cookie and keeps only the CSRF
token in memory. The service bearer never enters JavaScript, the URL, browser
storage, static assets, logs, or workspace records.

Authenticated embedded acceptance loaded 100 bounded real inventory rows with a
continuation cursor, no `FIXTURE`/`Local fixture` marker, and a real persisted Pi
active-branch transcript. Double-clicking an unmanaged session painted preview
records while the status remained `not hydrated`; an immediate service session
listing remained empty, proving that preview submitted no model turn and opened
no runtime.

A separate live `pi-daemon web` process on port 7475 connected to the same API
through `RemoteDashboardBackend`, authenticated its own browser credential,
rendered the same non-fixture production inventory, and then stopped without a
listener leak. This proves the same SPA/BFF behavior in embedded and dedicated
modes without in-process coupling.

## Performance and bundle receipts

Machine-readable values are checked in at
[`../web/artifacts/performance.json`](../web/artifacts/performance.json).

| Measure | Result | Contract | Outcome |
| --- | ---: | ---: | --- |
| Navigation to first rows, p95 | 11.1 ms | <150 ms | pass |
| App-ready to first rows, p95 | 1.3 ms | <150 ms | pass |
| 10k in-app search work | 0.3 ms | <100 ms | pass |
| Max stream/workspace/TUI commit | 1.9 ms | <16 ms | pass |
| Initial production gzip | 123,722 bytes | <1.5 MiB | pass |
| Complete production gzip | 370,748 bytes | <1.5 MiB | pass |

The inventory implementation independently passes persisted 10,000-session hot
bootstrap, bounded search, stale-index, reconcile, tamper and cache limits. The
browser virtualizes both session and transcript rows; retained TUI state remains
a 64-entry/32 MiB LRU with a 512 KiB per-frame contract.

## Automated gates

- Web unit: 42/42.
- Playwright: 11/11, including production login with no fixture paint.
- Combined Node suite before the final browser slice: 325/325 on macOS and Nix.
- Final browser slice: `TMPDIR=/tmp npm test` 325/325 and `nix flake check` green.
- `npm audit`: zero known vulnerabilities.
- Clean npm pack/import, Pages, release invariants, Home Manager module,
  installed binaries, embedded lifecycle, dedicated lifecycle and browser
  credential tests all pass.

The macOS default temporary directory can exceed Unix `sun_path` after the long
managed checkout prefix; adapter socket acceptance therefore uses canonical
fixture roots and the explicit `/tmp` test environment. Product socket path,
owner, mode and symlink checks remain strict and were not weakened.

## Security and failure-state evidence

Acceptance covers exact Host/Origin/CSRF checks, CSP and immutable hash assets,
input-only credentials, traversal/symlink/writable-file refusal, malformed and
oversized HTTP/WebSocket frames, connection capacity, slow clients, replay
gaps, stale generation/host identity, controller conflicts, idempotency
conflicts, indeterminate accepted commands, external-write conflicts, bounded
preview caches, settings/workspace revisions, reduced motion, forced colors,
keyboard navigation, Vim/IME input, and screen-reader-labelled dialogs.

The current Pi SDK still lacks the supported host-safe
`InteractiveSessionView` factory. TUI capability therefore fails closed in
production instead of starting a child Pi, PTY, second extension binding or
second JSONL writer. The complete canonical `ShadowTuiHost`, authenticated TUI
adapter, browser grid and component fixtures pass their frame, replay,
controller, accessibility and performance gates and become available only when
that public seam is injected.

## Wall-clock soak

The initial acceptance harness deliberately performed a fresh credential
exchange every minute. After 374 successful logins it reached the configured
browser-session capacity and received bounded 503 responses—correct fail-closed
product behavior, but not representative of a browser that reuses its HttpOnly
cookie. That exploratory receipt is retained owner-privately as
`dashboard-soak-capacity-finding.jsonl`; no credential or session content was
recorded.

The cookie-reuse harness then ran from `2026-07-19T09:07:03Z` through an
external default-tmux server teardown at approximately 13:05Z with zero product
failures. The daemon and soak tmux sessions disappeared together without a
daemon drain/crash record, so this was operator/process-supervisor interruption,
not an availability result. The helper now uses its own named tmux socket so an
unrelated default `tmux kill-server` cannot remove the test service.

The final uninterrupted 24-hour owner-private rolling soak started at
`2026-07-19T14:28:50Z` against the exact embedded test BFF on dedicated tmux
sockets. It reuses one cookie like the production SPA, re-authenticates once
after an intentional daemon restart/401, and every minute requests the packaged
SPA plus bootstrap, real inventory and settings. It records only timestamps,
bounded status, latency and row counts—never credentials or session content—
under `~/.local/state/pi-daemon/test/soak/`.

`bd-7de9ec` remains open until the summary is written after
`2026-07-20T14:28:50Z` with zero unexplained failures. Deterministic replay,
restart, cache, scheduler and fake-clock long-soak tests are already green; the
wall-clock receipt is the final unwaived gate.
