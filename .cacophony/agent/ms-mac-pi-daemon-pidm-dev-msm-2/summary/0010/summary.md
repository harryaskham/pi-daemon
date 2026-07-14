# Session summary — Bounded self-hosted ticket latency

## Goal

Repair the remaining Node 24 CI failure after the Linux package and Docker-free Pages changes landed, without weakening the API's durable-ticket behavior or making the test unbounded.

## Bead(s)

- `bd-ba50b5` — Fix Linux package-bin acceptance and make Pages Docker-free with Nix

## Before state

- The authoritative Linux Nix job and Pages deployment passed on `c730499`.
- The self-hosted Node 24 job completed 143 of 144 tests and failed `authenticated CRUD mutations return durable deduplicated tickets and terminal resources` after its two-second polling deadline; the mutation took about 3.8 seconds while sibling jobs were active.
- Node 22.19 completed the same suite successfully.

## After state

- The mutation-ticket polling deadline remains finite but is now 15 seconds, above the observed self-hosted tail.
- Polling backs off from 2 ms to 10 ms, reducing needless scheduler pressure while preserving prompt terminal detection.
- The four focused API mutation/ticket tests pass locally, including durable deduplication, restart failure, degraded-state reconciliation, and wake reconciliation.

## Diff summary

- Code/content commit: pending final squash SHA from reintegration receipt
- Summary artefact commit: intentionally omitted; this file must not self-reference its own mutable SHA
- File touched: `test/api-server.test.mjs`
- Tests: no tests added or removed; one shared bounded polling helper was hardened.
- Behavioural delta: production code is unchanged. Self-hosted CI tolerates bounded CPU contention instead of treating a multi-second durable mutation as a product failure.

## Operator-takeaway

The original Linux package and Pages fixes are green; the only remaining failure was a test-local two-second assumption under a contended Node 24 runner. The widened finite deadline addresses that observed tail without hiding stuck tickets.
