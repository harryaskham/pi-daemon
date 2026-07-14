# Session summary — durable resident/dormant session catalog

## Goal

Implement the durable session catalog needed by both the legacy NDJSON multiplexer and additive JSON API so retained sessions remain discoverable, safely mutable, reopenable, and deletable after idle eviction or restart without loading an SDK runtime or persisting raw environment secrets.

## Bead(s)

- `bd-df7ba9` — implement a durable resident and dormant session catalog with CRUD.
- Parent: `bd-55ab9e` — deliver the full standalone Pi session host API.

## Before state

- Failing tests: none on main.
- Relevant metrics: host status listed only resident `SessionSlot` objects; idle eviction silently removed a slot; `close` returned false for evicted sessions; authenticated `/v1/session` reads were not implemented; retained name, revision, residency, Pi conversation identity, and last terminal outcome had no durable resource.
- Context: manifests/journals supported wake recovery but were not a bounded CRUD catalog. The bearer/explicit-attach foundation landed concurrently and reserved mutation tickets/stream dispatch for later beads.

## After state

- Failing tests: none; full `npm test` passes 72/72.
- Relevant metrics: catalog default capacity 4096 records; 1 MiB per record; list default 50/max 100; opaque stable cursors; exact immutable ID and optional unique name; generation/revision optimistic checks; resident/dormant counts in host status; five catalog/integration tests plus one authenticated API read test.
- Context: owner-private atomic files under `state/catalog/` retain a secret-free normalized spec, environment keys/digest only, residency/runtime state, Pi session ID/file, and safe last terminal summary. Restart marks stale resident objects dormant before manifest reopen; Multiplexer open/reopen, terminal turns, eviction, retained close, dormant update, and permanent deletion keep catalog state synchronized.

## Diff summary

- Code/content commits: `466a50c`
- Summary artefact commit: intentionally omitted; this file must not self-reference its own mutable SHA.
- Files touched: new `src/session-catalog.ts` and `test/session-catalog.test.mjs`; catalog wiring in multiplexer, CLI, Pi adapter identity, durability helper exports, additive API GET list/detail, session resource/schema/fixtures, API tests, protocol/operations/session API docs, and changelog.
- Tests: +5 catalog/core integration tests and +1 authenticated API catalog read test; 72/72 full Node tests green.
- Behavioural delta: dormant sessions are now durable first-class resources. Authenticated callers can list/page and inspect them with strong revision ETags; core callers can update/delete dormant records with generation/revision preconditions; legacy status remains resident-only while host aggregate reports retained/dormant counts.

## Operator-takeaway

Eviction no longer makes an agent disappear. The daemon now has one bounded, secret-safe catalog that spans process restarts and both control modes, while asynchronous POST/PUT/DELETE ticket dispatch remains cleanly isolated for the next ticket implementation bead.
