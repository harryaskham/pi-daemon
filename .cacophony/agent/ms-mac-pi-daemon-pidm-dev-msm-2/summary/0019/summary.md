# Session summary — pidm-dev-msm-2

## Outcome

Landed three beads on true GitHub main. My previously claimed `bd-ea2019` was
already completed by peers while this agent was offline, so its orphaned WIP was
discarded rather than force-fitted through a conflicting rebase, and I moved to
the untouched draft pool instead of idling.

### `bd-f786ca` — redacted CLI exit diagnostics (landed in `76425f8`)

A failing `runCli(... serve ...)` assertion reported only `1 !== 0` while the
captured stderr already held the actionable structured code. Two dashboard CLI
tests did the opposite and passed `logs.join("")` into the assertion message,
which can carry bearer values, temporary roots, prompts, and model output.

- New `test/cli-exit-diagnostics.mjs`: `redactCliDiagnostics` reduces captured
  output to an allow-listed identifier-shaped summary (`event`, `level`,
  `errorCode`, `code`, `reason`, `phase`, `error.{code,status,retryable}`),
  deduplicated and bounded, with non-structured lines counted but never echoed.
  `assertCliExitCode` wraps the exit assertion with it.
- Routed six `serve` exit assertions across `api-server`, `config`, `server`,
  `dashboard-lifecycle-cli`, and `dashboard-dedicated-cli` through the helper.
- `test/cli-exit-diagnostics.test.mjs` proves codes surface while bearer, temp
  root, port, free-text message, prompt, and usage text never do.

### `bd-79902f` — load-proof recovery and bootstrap waits (landed in `76425f8`)

Filed by me after both failures blocked my own gate at host load average 15–19.

- `session recovery open is deadline bounded` ran with `openTimeoutMs: 10` and
  `totalOpenTimeoutMs: 20`, then required exactly `recovery_open_timeout`; 10 ms
  of contention let the aggregate deadline pre-empt it and report the equally
  truthful `recovery_deadline_exceeded`. Split into two deterministic cases: the
  per-open bound now runs against a 500x larger total deadline, and the aggregate
  bound is asserted separately on an injected monotonic clock. The 500 ms
  wall-clock assertion is gone; degraded health, unready host, and blocked
  subsequent open are retained.
- `waitForSocket` in the first-launch bootstrap acceptance failed after a fixed
  ten seconds, which descheduling alone can consume. Replaced with a named
  generous hang bound; a crashed daemon still fails immediately through the
  existing child-exit check.

### `bd-23110a` — extract neutral Dash routing from ApiServer (`c4d9b4c`)

`src/api-server.ts` had grown to 2,209 lines owning legacy session CRUD/tickets,
RPC, ACP, and Dash route parsing/dispatch together.

- New `src/api-dashboard-routes.ts`: `routeDashboardRequest` plus every
  dashboard-only helper (path refs, inventory/transcript query builders,
  activation/export/lease parsers, idempotency and If-Match assertions). It never
  authenticates, never writes to a socket, and never reads an unbounded body —
  the caller supplies an already-bounded JSON reader and renders the returned
  status/data/headers/requestId through the single existing envelope. Declining a
  path returns `undefined` so the caller keeps its own routing.
- New `src/api-request-contract.ts` holds the primitives both route families
  share: `ApiRequestError`, `readBoundedJson`, `assertMatchingRequestId`, and the
  `api*` value coercers. `readBoundedJson` is still re-exported from
  `api-server.js`, so the public surface is unchanged.
- `api-server.ts` drops to 1,729 lines and keeps sole ownership of admission,
  response bounds, and WebSocket upgrades; the ordering guarantee documented in
  `docs/dashboard-service-api.md` is now structural rather than conventional.
- `test/api-dashboard-routes.test.mjs` covers route declination without body
  reads, query/path parsing bounds, idempotency and request-id matching, If-Match
  revision conflicts, and neutral error normalization.

## Receipts

- `npm test`: 445/445 pass.
- `nix flake check`: exit 0.
- `npm run web:test`: 14 files / 79 tests pass.
- Repeated the two rewritten recovery tests five times: deterministic pass.

## Notes for the next session

- Remaining pi-daemon work is the draft pool (`bd-cb42b4`, `bd-acf2d3`,
  `bd-46eb52`, `bd-5fbf37`, `bd-d7de03`, `bd-2c6d58`, `bd-ad9ef9`, `bd-185516`)
  plus `bd-36428f`, still legitimately blocked on upstream `bd-adc22a`.
- `bd-5fbf37` (split `SessionInventory` internals) is the natural next refactor
  and is easier to reason about after the ApiServer split.
- `bd-185516` (Playwright under Nix) rests on Linux-specific evidence and is
  better owned by an Aurora node than by ms-mac.
- The caco MCP server failed (SSE 405) all session; the `caco` CLI was used
  directly. The beads/daemon API also flapped repeatedly, and the canonical
  daemon checkout still has this agent's branch checked out, so orphan pushes are
  rejected and its `origin/main` tracking ref lags true main.
