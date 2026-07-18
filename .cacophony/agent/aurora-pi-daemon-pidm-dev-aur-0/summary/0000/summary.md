# Session summary — Protocol-v2 host tool-adapter contract

## Goal

Define the product-neutral, default-off protocol-v2 contract that lets a trusted host bind one Pi Daemon logical session to a strictly bounded filesystem adapter without loading arbitrary extensions or exposing shell/process/network authority, while preserving protocol-v1 no-tools behavior exactly.

## Bead(s)

- `bd-5c06cd` — Protocol v2: define scoped neutral tool-adapter descriptor and compatibility contract.
- Parent: `bd-fc8275` — Protocol v2: host scoped neutral tool adapters without arbitrary extensions.

## Before state

- Protocol v1 accepted only `resources.tools: "none"` and rejected every non-none policy.
- There was no exported descriptor, adapter wire framing, schema, fixture, package subpath, or response/event version override for host-scoped capabilities.
- The runtime sibling could not safely implement bind, invoke, per-request abort, or generation/restart revocation without inventing protocol shapes.

## After state

- Protocol v1 parsing, fixtures, and default response/event behavior remain unchanged.
- Additive protocol v2 validates a closed `host-adapter` descriptor bound to adapter ID/version, host incarnation, session ID, generation, secret base64url capability, six fixed `fs.*` operations, and explicit byte/queue/concurrency/timeout/idempotency bounds.
- The adapter contract exports strict `bind`/`bound`, `invoke`/`result`, `abort`/`aborted`, and `revoke`/`revoked` frames. Only `bind` carries the capability; acknowledgements, results, errors, persistence, and later frames cannot echo it.
- Strict public v2 and adapter schemas, fixtures, package/Nix/Pages publication, and protocol/security/integration documentation are included.
- Full local `npm test` passed 268/268 before the final rebase. After rebasing over three concurrent main commits, the focused build, package install/import test, legacy protocol tests, and v2 contract tests passed 21/21.
- `nix flake check` reached the package test matrix but twice exposed a pre-existing startup SIGTERM race in `bootstrap-cli.test.mjs`; the exact test passes locally. That unrelated defect is filed separately as open `bd-03b0d2` and was not mixed into this security-contract commit, per root-owner direction.

## Diff summary

- Code/content commit: `bfdb514` (rebased content commit; final landed squash SHA will come from reintegration).
- Summary artefact commit: intentionally omitted; this file must not self-reference its own mutable SHA.
- Main source additions: `src/tool-adapter-protocol.ts`, `src/protocol-v2.ts`; additive version-aware response/event helper options in `src/protocol.ts`.
- Machine contracts: `protocol-v2.schema.json`, `tool-adapter.schema.json`, one v2 open fixture, and eight adapter frame fixtures.
- Public delivery: package exports/postbuild, Nix package and Pages artifacts, Pages workflow checks, README/CHANGELOG/PLAN, `SECURITY.md`, and detailed published protocol/security/integration docs.
- Tests: one focused contract suite with eight cases plus package artifact/import assertions; v1 compatibility suite remains green.
- Behavioural delta: consumers can validate and transport one exact host/session/generation-scoped filesystem capability; no runtime path is silently enabled by the legacy parser, and v2-aware dispatch has an explicit combined parser and exact envelope-version API.

## Operator-takeaway

The contract deliberately separates capability routing from arbitrary code execution: one secret appears only at bind, every subsequent frame is identity-echoed and bounded, all filesystem paths stay root-relative, and v1 remains a no-tools compatibility boundary. Runtime and root integration can now consume one frozen exported contract rather than duplicating security-sensitive wire shapes.
