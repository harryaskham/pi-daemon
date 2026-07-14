# Session summary — durable asynchronous command tickets and reconciliation

## Goal

Decouple durable admission from command completion. Add bounded, restart-safe mutation tickets for authenticated session CRUD; let legacy wakes optionally acknowledge immediately as prompt tickets; expose exact ticket/idempotency lookup, terminal retrieval, and explicit indeterminate reconciliation without blind replay or secret persistence.

## Bead(s)

- `bd-7d1407` — add asynchronous durable command tickets and request reconciliation.
- Parent: `bd-55ab9e` — deliver the full standalone Pi session host API.

## Before state

- Failing tests: none on main.
- Relevant metrics: 93 tests after the runtime-identity and serialization-bound landings; authenticated POST `/v1/session` returned `501`; PUT/DELETE/ticket GET were not dispatched; NDJSON wake only returned after model completion; accepted wake records had no opaque lookup/reconciliation API; steer/follow-up keys were not deduplicated.
- Context: the existing wake journal correctly distinguished queued/accepted/terminal/indeterminate, while the catalog and bearer transport had just landed. Pi runtime identity recovery required exact persistent conversation files and prohibited durable replay for memory sessions.

## After state

- Failing tests: none.
- Relevant metrics: full `npm test` and Nix `flake check` pass with 94/94 tests; mutation tickets default to 4096 retained records, 1 MiB each, seven-day terminal/indeterminate retention; authenticated API records are structurally bounded to 2 MiB; host-local steer/follow-up dedup retains 256 keys per resident runtime.
- Context: POST/PUT/DELETE now durably return `202` tickets, exact duplicates join even after the target changes/deletes, semantic key reuse conflicts, `waitForTerminal=true` is an optional barrier, and queued/running restart states reconcile to replay/indeterminate safely. Wake `waitForTerminal=false` returns a prompt ticket immediately while preserving the legacy wait default. Ticket lookup works by opaque ID or exact method/target/idempotency scope. Reconciliation stores only bounded Pi entry IDs and safe outcome summaries, never caller result/error text. Memory sessions refuse durable wake tickets. Steer/follow-up are explicitly classified as bounded host-incarnation-local controls; abort and unsupported mutating RPC controls are never auto-replayed.

## Diff summary

- Code/content commit: `9e3899e`
- Summary artefact commit: intentionally omitted; this file must not self-reference its own mutable SHA.
- Files touched: new `src/tickets.ts`, ticket/wake fixtures and tests; authenticated API CRUD/ticket routing; durability journal lookup/reconciliation; Multiplexer wake admission/control dedup; CLI ticket recovery; protocol/session schemas/OpenAPI/docs/README/PLAN/changelog.
- Tests: full Node suite 94/94 green inside both npm and Nix; focused API, durability, multiplexer, server, protocol, catalog/runtime compatibility, package, and security coverage all pass.
- Behavioural delta: durable acknowledgement is now distinct from completion, accepted work is never blindly replayed, terminal results remain retrievable within bounds, and CRUD is functional over the bearer API rather than a reserved transport placeholder.

## Operator-takeaway

Pi Daemon now has a coherent asynchronous control plane: durable CRUD and prompt admissions return inspectable tickets, restart ambiguity is explicit and reconcilable, exact retries are safe, memory-only sessions remain honest, and every retained/API response path is bounded. The per-session configuration worker already owns replacing the temporary supported-subset SessionSpec parser with the shared prepared-configuration API, including volatile environment overlays and `credentials_required` restart handling.
