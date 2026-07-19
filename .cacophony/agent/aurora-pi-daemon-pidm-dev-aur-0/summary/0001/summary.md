# Session summary — Keep shutdown signals latched through drain

## Goal

Close the repeated Nix-only bootstrap shutdown failure where an immediate or repeated supervisor SIGTERM could fall back to the platform default during daemon drain and make the child exit by signal instead of completing bounded cleanup with code zero.

## Bead(s)

- `bd-6dc8cb` — `[broken-on-main] bootstrap-cli serve exit status failing`.
- Duplicate report `bd-03b0d2` was linked and closed in favor of the existing canonical bead.

## Before state

- Current main already installed a SIGTERM/SIGINT latch before publishing the owner socket, but used one-shot listeners that were removed immediately after the first signal.
- Two Nix package-check runs failed `test/bootstrap-cli.test.mjs:95` with `exitCode === null`; the exact test passed locally, making the repeated-stop race load-sensitive.
- A second stop signal during the bounded drain could therefore take the default signal path and bypass the lifecycle result.

## After state

- The startup latch uses persistent handlers guarded by a one-time settlement flag and keeps both handlers installed until shutdown cleanup disposes them.
- Repeated stop signals during drain are absorbed rather than changing the process back to platform-default termination.
- The bootstrap regression now sends a second SIGTERM while the child is still draining and asserts both code zero and a null terminating signal.
- Focused local stress passed 10/10; the Nix package gate passed all 301 tests and completed install checks; after rebasing over the scheduler runtime commit, the exact bootstrap test passed again.

## Diff summary

- Code/content commit: `24fa7f7` (rebased content commit; final landed squash SHA will come from reintegration).
- Summary artefact commit: intentionally omitted; this file must not self-reference its own mutable SHA.
- Files touched: `src/cli.ts`, `test/bootstrap-cli.test.mjs`.
- Tests: strengthened one existing subprocess lifecycle test; no tests removed or weakened.
- Behavioural delta: a second SIGTERM/SIGINT during normal drain no longer terminates the daemon by signal or bypasses bounded transport/session cleanup.

## Operator-takeaway

Installing the first signal handler before listener publication was necessary but not sufficient: the handler must remain installed for the entire drain because supervisors can repeat stop signals. The fix is deliberately narrow and now passes the previously failing Nix package environment.
