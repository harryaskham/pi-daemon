# Session summary — Dash session ownership, conflict guards, and export

## Goal

Complete the explicit write-authority layer between preview-only inventory and managed Pi runtimes: durable direct/fork activation, cooperative leases, conflict detection, safe storage policy, atomic export/append-back, and release without ever creating two silent writers or overwriting divergent history.

## Bead(s)

- `bd-fd9f22` — Dash session ownership: direct co-opt, safe fork/import, conflict detection and export.
- Depends on landed config `bd-e25765`, inventory `bd-93e857`, and projector `bd-3a8261`.

## Before state

- Dash inventory and transcript projection were read-only; activation/export contract resources had no implementation.
- There was no durable inventory-to-managed mapping, ownership lease, ownership-specific ticket journal, direct-write guard, imported-history base, or release state.
- Pi Adapter rejected every session directory below `agentDir`, including the canonical normal-Pi `sessions` data subtree.
- REST session open payload construction was private to `api-server.ts`, preventing a neutral runtime adapter from reusing exactly the same prepared session semantics.

## After state

- `FileSessionOwnershipStore` atomically persists bounded owner-private mappings, exact source versions/base IDs, managed identity, leases, conflicts, exports, and activation/export tickets. Same semantic idempotency keys join; different requests conflict. Restart preserves queued work and moves running work to indeterminate without replay.
- `SessionOwnershipService` implements `preview-only`, managed `reuse`, explicit `direct` (`direct-co-opt-confirmed-v1`), and `fork` activation through a caller-supplied trusted runtime policy. Source/cwd/root/owner/symlink/fingerprint/writer/controller/mutation checks fail closed; direct/fork activation and every export require an exact caller-observed fingerprint.
- Direct sessions have pre-write exact source checks, post-write prefix validation/fingerprint renewal, renewable leases, and periodic conflict sweeps. Conflicts preserve history, mark ownership, close runtime best-effort, and refresh inventory.
- Imported sessions use a fresh Pi UUID/file and leave the source unchanged. `as-new` exports atomically into stock Pi's cwd-encoded session directory. `append-to-origin` requires unchanged exact origin identity, exact imported prefix, a linear parent-ID delta, no known writer, and a second pre-publication revalidation. Divergence never overwrites.
- `releaseAfterExport` and explicit release reject active controllers/mutations, close the runtime, mark the mapping released, and refresh inventory.
- Storage policy supports the narrow canonical `<agentDir>/sessions/**` data subtree or path-safe per-session daemon-state directories. Pi Adapter still rejects every credential/config/extension sibling.
- `MultiplexerSessionOwnershipRuntime` routes specs through shared `parseSessionConfiguration()`, catalog generations, runtime open/close, and a newly exported `sessionOpenPayloadFromSpec()` also consumed by the REST API.
- Package exports and Pages documentation publish ownership service/store contracts; inventory docs link the explicit writer boundary.

## Validation

- Focused ownership/package/security integration passed after the final shadow-TUI merge; ownership service/store coverage is 13/13 plus Pi Adapter/package/release checks.
- Final post-rebase `npm test`: 239/239 passed, including production web build, clean npm pack/import, and ambient `PI_PACKAGE_DIR` isolation.
- Final `nix flake check --print-build-logs`: 239/239 passed; package, web build, Pages, and installed `pi-daemon`/`pi-daemon-rpc` checks completed.
- Acceptance covers persistence/mode, idempotency conflict, running-to-indeterminate recovery, one-to-one mapping, direct confirmation and duplicate join, fork source preservation, owner-private managed files, external conflict sweep, lease renewal, export-as-new metadata/mode, guarded append+release, changed-origin refusal, daemon-owned storage, Multiplexer prepared-fork propagation, active writer/controller rejection, and narrow Pi session-root authority.

## Diff summary

- Incremental store landed earlier at `b4b6298`.
- Final rebased code/test commits before reintegration: `e805f98`, `2d921b9`, `392ac29`, `94f6710`.
- Summary artefact commit: intentionally omitted.
- Main files: `src/session-ownership.ts`, `src/session-ownership-store.ts`, `src/pi-adapter.ts`, `src/session-config.ts`, tests, package exports, and `docs/dashboard-ownership.md`.
- No browser SPA or server-specific backend implementation was added; both consume the neutral ownership service in their separately assigned slices.

## Operator-takeaway

Dash can now move from fast read-only preview to one explicit managed writer and back to stock Pi without pretending that stock Pi offers a perfect lock: every risky boundary is revalidated, every mutation is durable/idempotent, divergent histories are preserved, and the safe fallback is always fork or export-as-new rather than overwrite.
