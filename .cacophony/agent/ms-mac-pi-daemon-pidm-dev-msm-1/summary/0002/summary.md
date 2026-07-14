# Session summary — resolved Pi conversation identity

## Goal

Fix the release-blocking durability defect where a manifest containing only the requested `new`, `continue`, or `memory` target could recreate a different Pi conversation after restart or eviction and then replay queued work into the wrong history.

## Bead(s)

- `bd-143f05` — Preserve Pi conversation identity across restart and runtime replacement.
- Parent: `bd-55ab9e` — Deliver the full standalone Pi session host API.

## Before state

- `PiSessionFactory` directly owned one `AgentSession`; it did not use Pi SDK 0.80.6 `AgentSessionRuntime` or rebind after new/switch/fork/import.
- Manifests persisted only the requested open payload. Replaying `mode: "new"` created a new Pi ID/file; replaying `memory` fabricated empty history.
- Durable queued wakes could therefore run after a different conversation had been created.
- Pi lazily reserved a persistent session path but did not create the JSONL until an assistant message existed, so even a newly accepted empty conversation had no reopenable file yet.
- The integrated catalog suite had 72 Node tests before this slice.

## After state

- Every real adapter owns an `AgentSessionRuntime` with locked cwd-bound services. Runtime replacement validates cwd/session authority before invalidation, rebinds extensions and event subscriptions to `runtime.session`, and waits for an awaited identity persistence handler.
- Persisted `SessionManager`s are materialized as owner-only JSONL and reopened before SDK session construction, preserving Pi ID/file even before the first provider turn.
- New/switch/fork/import replacement is covered with the real Pi SDK. A failed rebind or identity write leaves the adapter invalidated rather than serving a disposed/stale session.
- Catalog and manifests retain the resolved canonical Pi ID/file. Same-generation reopen translates the original policy into an exact `open` target without changing its policy digest or daemon generation.
- Idle eviction preserves the manifest and reopens exact identity. An explicit retained close removes the manifest and stays dormant across restart.
- `memory` targets are resident-only: they keep a catalog identity but write neither runtime manifest nor durable wake journal, remain dormant after restart, and cannot masquerade as an empty replacement conversation.
- Legacy `new`/`continue` manifests without resolved identity, generation mismatch, and missing/corrupt Pi files all block restoration and queued replay. Accepted requests remain indeterminate.
- Failing tests: none. `npm test` passes 80/80. `nix flake check --no-build` evaluates the current package/check derivations. A redundant full Nix copy was not launched after the already-recorded shared-store ENOSPC on this same SDK closure.

## Diff summary

- Code commits before squash: `7f8be58` (runtime-owned adapter) and `187ff8c` (durable resolved identity/recovery).
- Summary artefact commit: intentionally omitted; this file must not self-reference its mutable commit SHA.
- Main implementation files: `src/pi-adapter.ts`, `src/multiplexer.ts`, `src/durability.ts`, and `src/session-catalog.ts`.
- New real-SDK acceptance: `test/pi-runtime-durability.test.mjs` proves empty-conversation materialization, exact restart ID/file continuity, and missing/corrupt-file replay refusal.
- Expanded tests cover runtime subscription rebinding, new/switch/fork/import identity changes, failed identity persistence, cross-session path isolation, import cwd prevalidation, dormant reopen, catalog/manifest replacement updates, memory non-replay, and legacy ambiguity refusal.
- Documentation now distinguishes desired runtime generation from in-place Pi conversation identity changes and documents exact-identity restart semantics.

## Operator-takeaway

A daemon restart or idle eviction can no longer turn a logical session into a fresh Pi conversation while treating queued work as safe. Durable work runs only after the exact prior Pi conversation is reopened; otherwise recovery fails visibly and leaves the work unreplayed.
