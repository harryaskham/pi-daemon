# Session summary — exact-once lazy Dash first send

## Goal

Implement the runtime half of lazy browser session creation so draft CRUD remains completely inert, while the first explicit message materializes exactly one policy-validated managed session, obtains controller state, and crosses Pi RPC prompt preflight at most once across duplicates, cancellation, restart, and crash windows in both embedded and dedicated deployments.

## Bead(s)

- `bd-96c3e1` — Dash lazy first send: exact-once materialization across embedded and remote backends.
- Parent: `bd-e9fce1` — Dash new session lazy create flow.
- Sibling consumed: `bd-6a4170` — browser-safe draft contract, private store, API/BFF CRUD, schemas and docs (landed at `32c3d4b`).
- Incidental broken-main repair: `bd-278473` — deterministic nested scheduler settlement (landed separately at `fc0ed07` and closed before this stack was replayed).

## Before state

- Draft CRUD/store/API resources existed after the sibling land, but public send routes intentionally failed `draft_execution_unavailable`; queued tickets had no runtime executor.
- Production Dash had no runtime path that could checkpoint create-before-prompt separately from prompt-acceptance ambiguity.
- Duplicate sends, cancellation races, dormant-memory recreation, controller conflicts, and restart recovery were not connected to the normal Multiplexer/Pi RPC policy core.

## After state

- `DashboardSessionDraftMaterializer` implements the injected execution facade, joins duplicate keys, launches bounded recoverable work, and persists monotonic `materializing` → `ready-to-prompt` → `prompt-submitting` checkpoints before each authority boundary.
- The deterministic target is created/rejoined through prepared `Multiplexer.open`; matching dormant memory targets are revision/generation-guard deleted and recreated at the same identity before prompt authority crosses.
- Existing Dashboard/RPC controllers are checked before prompt; Pi RPC preflight is the definitive acceptance boundary. Unknown failure after `prompt-submitting` is indeterminate and never replayed.
- Pre-prompt cancellation/controller conflict/rejection terminalizes safely and best-effort removes empty sessions. Cancellation racing prompt submission becomes indeterminate.
- Embedded Dashboard service and authenticated neutral API share one materializer/store; dedicated Dash delegates those same service routes without exposing the bearer to the browser.
- Draft create/read/cancel still perform zero Pi runtime/model/tool/process work. First send acceptance proves exactly one runtime open and one Pi RPC prompt.
- Validation: `npm test` passed 356/356; final uncached `nix flake check --print-build-logs` completed with all checks passed. Focused draft/backend/lifecycle suites passed 48/48 before full gates, and the materializer suite covers 11 behavioural scenarios plus no-subprocess source enforcement.

## Diff summary

- Code/content commits: `a4cd2f1`, `69f7ca5`, `17b9d7e`, `466266a`, `5a3c143`, `3381d5e`; final landed squash SHA will come from the reintegration receipt.
- Summary artefact commit: intentionally omitted; this file must not self-reference its own mutable SHA.
- Files touched: `src/dashboard-session-materializer.ts`, `src/dashboard-service-runtime.ts`, `src/index.ts`, `package.json`, `test/dashboard-session-materializer.test.mjs`, `test/dashboard-lifecycle-cli.test.mjs`, `test/package.test.mjs`, `docs/dashboard-session-drafts.md`, and `PLAN.md`.
- Tests: added exact duplicate/runtime/prompt, crash checkpoint, cancellation race, controller conflict, prompt rejection, memory recreation, embedded service API, packaging, and bounded loaded-poll coverage; removed no tests.
- Behavioural delta: a browser draft remains configuration-only until first send, then converges on one managed session and one admitted first turn with durable public ticket truth and conservative indeterminate handling.

## Operator-takeaway

Lazy creation now has one backend state machine rather than separate embedded/dedicated shortcuts: no authority exists before send, and every side effect after send is preceded by enough durable state to resume safely or stop indeterminate without duplicating the first turn.
