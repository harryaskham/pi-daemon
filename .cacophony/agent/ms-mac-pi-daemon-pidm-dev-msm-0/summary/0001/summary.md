# Session summary — current Pi SDK compatibility foundation

## Goal

Move Pi Daemon from the obsolete Pi 0.80.3 embedding baseline to a reproducible, explicitly reviewed Pi 0.80.6 SDK contract that can support the full AgentSessionRuntime/RPC work, while keeping npm, Nix, protocol, event mapping, and rollback behavior deterministic across enterprise-registry lag.

## Bead(s)

- `bd-12c4ba` — establish a current Pi SDK acquisition and compatibility policy.
- Parent: `bd-55ab9e` — deliver the full standalone Pi session host API.

## Before state

- Failing tests: none on main; the repository compiled against Pi 0.80.3.
- Relevant metrics: Pi RPC coverage was unasserted; protocol thinking had 6 levels and rejected `max`; the adapter did not map `agent_settled` or `entry_appended`; no runtime replacement smoke existed.
- Context: the configured enterprise npm proxy exposed only 0.80.3 while public npm exposed 0.80.6. The Nix v1 npm fetcher could not build the nested published Pi shrinkwrap reliably, and the upstream shrinkwrap omitted three nested Pi package integrity values.

## After state

- Failing tests: all 54 Node tests pass. `nix flake check` compiled and passed the same 54 tests, then its final install copy hit host `ENOSPC`; an earlier full Nix package build of the same final 0.80.6 lock/hash completed before the last main rebase.
- Relevant metrics: exact Pi SDK 0.80.6; 31 compile-checked RPC commands; 19 compile-checked session event types; one real in-memory AgentSessionRuntime replacement/rebind smoke; 149 lock packages, all registry records carrying integrity and all URLs on npmjs.
- Context: `.npmrc` pins the Earendil scope/public lock host policy, Nix uses npm dependency fetcher v2 with a fixed hash, protocol/schema now accept `max`, and the adapter maps settled/entry events. The clean package install smoke explicitly uses the public registry so ambient mirror lag cannot hide artifact behavior.

## Diff summary

- Code/content commits: `d8873f2`
- Summary artefact commit: intentionally omitted; this file must not self-reference its own mutable SHA.
- Files touched: `.npmrc`, `package.json`, `package-lock.json`, `flake.nix`, `src/pi-sdk-contract.ts`, `src/pi-adapter.ts`, `src/protocol.ts`, `src/index.ts`, protocol schema/fixtures/tests, package test, `docs/pi-sdk-compatibility.md`, README/docs index, and PLAN architecture clarifications.
- Tests: +3 SDK compatibility tests; 2 existing tests extended for max thinking and new Pi events; 54/54 full Node tests green. Nix check reached install after 54/54 green and failed only on shared-store disk exhaustion.
- Behavioural delta: Pi Daemon now builds against the public runtime/RPC seam required by subsequent beads, detects upstream command/event drift at compile time, and has a documented exact upgrade/rollback path without floating versions or process-global `runRpcMode()` embedding.

## Operator-takeaway

Pi 0.80.6 is now a real, reproducible foundation rather than a documentation aspiration. The important guard is not just the version bump: future Pi releases must deliberately reconcile the exact RPC/event unions, runtime replacement behavior, lock integrities, and Nix hash before the daemon can claim compatibility.
