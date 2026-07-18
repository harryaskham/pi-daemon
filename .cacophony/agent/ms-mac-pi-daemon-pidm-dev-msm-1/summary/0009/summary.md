# Session summary — finish inventory bootstrap headroom repair

## Goal

Eliminate the remaining host-load-sensitive work from the 10k inventory bootstrap after c458c6c still measured 51.82 ms in a peer’s loaded full suite, while preserving the exact `<50 ms` contract and every paging/filter/isolation behavior.

## Bead(s)

- `bd-e71126` — reopened `[broken-on-main] 10k inventory bootstrap p95 exceeds 50ms under host load`.
- Source implementation: `bd-93e857`.

## Before state

- c458c6c consolidated secure hot-head file I/O and passed owner npm/Nix at 21.13/33.00 ms, but two peer loaded full runs still measured 53.47 and 51.82 ms.
- The default first-page call still ran generic query normalization, query hashing, cursor/filter traversal, and `structuredClone` for every row after loading the bounded hot head.
- The exact test threshold remained `<50 ms` and could not be relaxed, skipped, or multiplied.

## After state

- The no-cursor/no-filter first-page path is explicit and bounded: it slices the already ordered hot rows directly with a module-precomputed empty-query digest.
- Public rows are copied with a small typed manual clone of only the nested managed/activation/presence fields instead of generic structured cloning.
- Filtered search, source/runtime/unread filters, modified-time filters, cursors, revision/query binding, event-loop yielding, and all public shapes remain unchanged.
- No test threshold, sample window, contract constant, or resource limit changed.

## Validation

- Two consecutive loaded `npm test` runs: 214/214 both.
  - Run 1 inventory p95: bootstrap 14.40 ms, hot page 0.24 ms, search 36.31 ms.
  - Run 2 inventory p95: bootstrap 9.13 ms, hot page 0.05 ms, search 30.94 ms.
- `nix flake check --print-build-logs`: 214/214; bootstrap 2.63 ms, hot page 0.04 ms, search 16.00 ms; package, web build, Pages, and installed binaries passed.
- Focused pre-gate result: bootstrap 7.97 ms.

## Diff summary

- Code commit before reintegration squash: `2918c5b`.
- Summary artefact commit: intentionally omitted.
- File touched: `src/session-inventory.ts`.
- Behavioral delta: remove generic dispatch work from the bounded default page only; no semantic or acceptance relaxation.

## Operator-takeaway

The full-suite variance is now fixed by real hot-path removal, not benchmark accommodation: repeated loaded runs have 35–41 ms of margin and Nix has over 47 ms of margin against the unchanged 50 ms budget.
