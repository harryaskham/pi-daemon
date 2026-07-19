# Session summary — deterministic nested scheduler settlement

## Goal

Repair the pre-existing scheduler fake-clock race that let `SchedulerRuntime.settle()` return before a queue-one admission causally scheduled by a finishing ticket, making loaded Nix gates intermittently observe one admission instead of two.

## Bead(s)

- `bd-278473` — `[broken-on-main] SchedulerRuntime settle misses nested queue-one work`.
- Discovered while validating `bd-96c3e1`; that lazy-draft work remains isolated on a private backup ref and is not part of this reintegration.

## Before state

- True main intermittently failed `overlap policies are bounded and queue-one coalesces to one deferred admission` under loaded `nix flake check`.
- `settle()` awaited the current serialized tail, then snapshotted settlements. A finishing settlement could replace the tail during that await, leaving the snapshot empty and the nested queue-one admission outside the awaited boundary.
- Loaded failure: expected two admissions, observed one.

## After state

- `settle()` snapshots current settlements and tail together, then follows tail identity changes until all serialized work causally created by that snapshot is complete. It intentionally does not wait on newly admitted long-running tickets.
- The regression now requires the second admission after `settle()` alone; no compensating `reload()` is permitted.
- Validation: exact regression 20/20 consecutive passes; full scheduler runtime suite 8/8; uncached `nix flake check --print-build-logs` completed with all checks passed (345 tests in the package check).

## Diff summary

- Code/content commit: `0997b43`; final landed squash SHA will come from the reintegration receipt.
- Summary artefact commit: intentionally omitted; this file must not self-reference its own mutable SHA.
- Files touched: `src/scheduler-runtime.ts`, `test/scheduler-runtime.test.mjs`.
- Tests: strengthened one existing queue-one regression; no tests removed.
- Behavioural delta: callers can rely on `settle()` to include nested serialized work created by the settlements present when settling began, without blocking on future admissions.

## Operator-takeaway

The prior settle helper fixed direct async work but missed a tail-replacement interleaving. Settlement now follows causal tail changes to a stable boundary, removing the loaded Nix flake without timing sleeps or weaker assertions.
