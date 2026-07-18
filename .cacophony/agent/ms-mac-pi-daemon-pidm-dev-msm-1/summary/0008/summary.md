# Session summary — stabilize 10k inventory bootstrap under host load

## Goal

Repair the newly reported broken-on-main inventory benchmark without weakening the `<50 ms` persisted bootstrap contract, so peer full gates remain deterministic while multiple Dash agents build concurrently on the shared ms-mac host.

## Bead(s)

- `bd-e71126` — `[broken-on-main] 10k inventory bootstrap p95 exceeds 50ms under host load`.
- Regression source/owner context: `bd-93e857` inventory landed at `75d8b59`.

## Before state

- Inventory passed its own full local and Nix gates, but a peer full run measured bootstrap p95 `53.47 ms` and failed 1 of 197 tests.
- Other receipts ranged from `8.53 ms` locally to `40.21 ms` in Nix, identifying host-scheduler sensitivity in the small hot-head startup path rather than deterministic excessive index work.
- The exact test threshold remained `<50 ms`; raising, skipping, or multiplying it was explicitly forbidden.

## After state

- The bounded 101-row owner-private hot head now uses one synchronous startup critical section: `openSync` with `O_NOFOLLOW`, descriptor `fstat` owner/type/mode/size validation, bounded `readFileSync`, and JSON parsing.
- The optimization removes multiple asynchronous path-stat/read scheduling points from first paint while retaining all security checks and the byte bound.
- Full index/search-key/snapshot hydration remains deferred to the next event-loop turn, so no total-index work moved onto bootstrap.
- No contract constant, test threshold, sample count, public resource shape, or browser behavior changed.

## Validation

- Full `npm test`: 197/197 passed; bootstrap p95 `21.13 ms`, hot first page `0.51 ms`, search `26.06 ms`.
- `nix flake check --print-build-logs`: 197/197 passed; bootstrap p95 `33.00 ms`, hot first page `1.75 ms`, search `62.64 ms`; package, Pages, and installed binary checks completed.
- The original exact `<50 ms` bootstrap assertion remained unchanged.

## Diff summary

- Code commit before reintegration squash: `2f0c636`.
- Summary artefact commit: intentionally omitted; this file must not self-reference its own mutable SHA.
- File touched: `src/session-inventory.ts`.
- Behavioral delta: less scheduler-sensitive bounded hot-head I/O only; no relaxed acceptance and no API change.

## Operator-takeaway

The inventory budget now has real shared-host headroom rather than a looser test: the same secure hot head is read through one bounded descriptor operation, reducing Nix p95 to 33 ms while keeping full index hydration off the first-paint path.
