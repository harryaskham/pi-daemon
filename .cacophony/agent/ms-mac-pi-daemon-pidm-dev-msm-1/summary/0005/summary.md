# Session summary — high-level session management CLI

## Goal

Add an ergonomic, secret-safe `pi-daemon` command surface for session CRUD, durable tickets, prompt/control, RPC bridge attachment, and RPC/ACP endpoint discovery without replacing the existing low-level Unix protocol or stock JSONL bridge.

## Bead(s)

- `bd-68e03a` — Add a high-level Pi Daemon session management CLI.

## Before state

- `pi-daemon` exposed only `serve`, `probe`, `request`, and `version`.
- Operators needed handwritten curl/WebSocket clients for authenticated catalog CRUD and tickets.
- Prompt/control required low-level NDJSON or a separately invoked `pi-daemon-rpc` binary.
- Session configuration had no high-level typed flags/file path, ticket waits/reconciliation had no CLI, and RPC/ACP exact endpoint discovery was manual.
- `serve` accepted only one `--allow-root`, blocking Home Manager configurations with multiple workload roots.

## After state

- New top-level commands:
  - `session list|show|create|update|delete`
  - `ticket get|wait|reconcile`
  - one-shot settled `prompt`
  - `control steer|follow-up|abort`
  - `rpc attach|discover`
  - `acp discover`
- `src/session-client.ts` provides a bounded bearer-authenticated REST client, terminal ticket polling, and framed Pi RPC one-shot commands with aggregate byte/event/time limits.
- `src/session-cli.ts` maps high-level commands onto the correct existing control plane:
  - full catalog CRUD/tickets through authenticated REST;
  - compatible open/status/wake/control/close through owner-only Unix NDJSON;
  - prompt/control over framed Pi RPC for API targets;
  - stock RPC stdio bridge delegation for `rpc attach`.
- Successful output is compact bounded JSON by default. Ticket waits exit `1` for failed and `75` for indeterminate terminal states.
- API mutations use exact generation/revision, fetched strong ETags, request IDs, and idempotency keys. Reconciliation requires retained Pi entry evidence rather than client-supplied result content.
- API credentials remain file/fd/environment-only. Discovery never prints token values. Remote plaintext remains explicit opt-in.
- Full `SessionSpec` is accepted from a bounded owner-only non-symlink `--spec-file`; argv `--spec-json` rejects raw `env` values. Concise typed flags cover cwd/name/agentDir, target, model/thinking, tools, and system prompt.
- `serve` now accepts repeatable `--allow-root PATH`, passing every canonical root to `PiSessionFactory`; the Home Manager module can emit one flag per list entry.
- `docs/session-cli.md` is the published operator reference. The concise quickstart remains curl/`pi-daemon-rpc` first and links forward without duplicating command docs.
- Installed package smoke asserts high-level help is present; package root exports `SessionApiClient` and session CLI declarations.

## Validation

- Focused CLI/API/package: 21/21 independently green before final refinements.
- Local full npm suite: 152/152 green.
- Final clean Nix flake check: package and Pages checks pass; its exact `npm test` run passes **153/153**, followed by install/fixup and both installed wrapper checks (`pi-daemon` and `pi-daemon-rpc` version).

## Diff summary

- Code commit before squash: `96f3ded` — REST/RPC session client, high-level command dispatcher, repeatable roots, docs, package and integration tests.
- Summary artefact commit: intentionally omitted; this file must not self-reference its mutable commit SHA.
- Main files: `src/session-client.ts`, `src/session-cli.ts`, `src/cli.ts`, `docs/session-cli.md`, and `test/session-cli.test.mjs`.

## Operator takeaway

Operators can now perform normal Pi Daemon lifecycle work without composing protocol frames or curl bodies, while advanced users retain the exact raw Unix, REST, Pi RPC, ACP, and stdio surfaces underneath.
