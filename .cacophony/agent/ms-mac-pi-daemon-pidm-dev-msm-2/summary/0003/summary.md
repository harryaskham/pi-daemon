# Session summary — Pre-allocation protocol bounds

## Goal

Close the release-blocking memory-bound gap where an SDK event or response was fully JSON-serialized and copied into a buffer before the advertised outbound limit was checked, while preserving healthy connections and unrelated session delivery.

## Bead(s)

- `bd-07980c` — Bound protocol event and response serialization before allocation
- Parent: `bd-55ab9e` — Full standalone Pi session host API

## Before state

- `ConnectionWriter.send()` called `JSON.stringify` and `Buffer.from` on complete records before checking the per-connection byte limit.
- Individual event and response records had no separate configurable limits.
- Oversized or cyclic/non-serializable SDK data could disrupt a connection after unbounded allocation.
- The aggregate queue check did not include both socket writable bytes and queued bytes.

## After state

- A plain-JSON preparation pass measures escaped UTF-8 bytes, rejects unsupported/cyclic/accessor/custom-serialization values, and builds a bounded normalized copy before final JSON or Buffer allocation.
- Event, response, and aggregate outbound limits are distinct, advertised in handshake, constrained consistently, and configurable through `pi-daemon serve`.
- Oversized responses become typed `outbound_record_too_large` errors; non-serializable responses become `outbound_not_serializable`.
- Oversized/non-serializable SDK events become bounded same-sequence `eventDropped` records, preserving the connection and other sessions.
- A checked fixture and adversarial tests cover giant strings before `JSON.stringify`, bigint/cycles/accessors/custom `toJSON`, event replacement, response errors, connection survival, and CLI limit wiring.

## Diff summary

- Code/content commit: `cd1a727`
- Summary artefact commit: intentionally omitted; this file must not self-reference its own mutable SHA
- Files touched: `src/protocol.ts`, `src/server.ts`, `src/cli.ts`, `test/protocol.test.mjs`, `test/server.test.mjs`, `test/api-server.test.mjs`, `fixtures/event-dropped.event.json`, `docs/protocol.md`, `docs/operations.md`
- Tests: +5 focused adversarial/limit tests plus CLI transport-limit assertions
- Validation: strict TypeScript build; 30 focused protocol/server/API tests after rebasing onto runtime-identity main; `git diff --check`
- Behavioural delta: one pathological outbound record can no longer allocate beyond its record budget or tear down delivery for otherwise healthy sessions.

## Operator-takeaway

The outbound limits now apply before expensive serialization and buffer creation, not after; malformed or oversized SDK output degrades into explicit bounded protocol records instead of becoming a process-memory or cross-session availability hazard.
