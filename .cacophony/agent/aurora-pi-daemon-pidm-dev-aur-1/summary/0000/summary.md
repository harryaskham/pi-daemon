# Session summary — Bounded host tool-adapter runtime

## Goal

Implement the product-neutral runtime half of protocol-v2 host-scoped tools: one session-bound, owner-private Unix socket client that exposes only six fixed filesystem operations to Pi, enforces capability and resource boundaries, and preserves the exact no-tools behavior for every session without a validated adapter descriptor.

## Bead(s)

- `bd-ff2f8f` — Implement bounded host tool-adapter runtime registry and per-session Pi injection.
- Parent: `bd-fc8275` — Protocol v2 host-scoped neutral tool adapters without arbitrary extensions.
- Contract sibling: `bd-5c06cd` — Protocol-v2 descriptor, frames, schemas, and compatibility contract.

## Before state

- Pi Daemon protocol v1 and the existing legacy SDK path allowed no custom host adapter; `PiSessionFactory` used `noTools: "all"` and an empty custom-tool set.
- There was no long-lived session-scoped adapter client, bind/invoke/abort/revoke lifecycle, fixed neutral filesystem tool registry, or Pi SDK injection seam.
- No focused runtime tests covered owner-private socket checks, identity echo, capability reflection, root-confined paths, bounded multiplexing, per-request abort, or adapter disposal.

## After state

- `HostToolAdapterRegistry` and `HostToolAdapterSession` maintain one generation-scoped Unix connection, perform canonical bind/revoke lifecycle, and multiplex bounded requests under descriptor concurrency, queue, request, response, timeout, and idempotency limits.
- Every outbound and inbound frame crosses the shared `parseHostToolAdapterMessage()` boundary; adapter, host, session, generation, request, idempotency, operation, and contract echoes are verified before use.
- Capability material appears only in the bind frame and is rejected if reflected by any response. Runtime errors and public session state never expose the descriptor or endpoint.
- Root-relative POSIX paths are validated by the shared contract and then checked locally for traversal, missing parents, and symlinks. Same-path writes/edits serialize through Pi's file mutation queue while read/list/stat/search operations retain bounded parallelism.
- Pi exposes only provider-safe `fs_list`, `fs_stat`, `fs_read`, `fs_search`, `fs_write`, and `fs_edit` names granted by the descriptor. Adapter sessions use `noTools: "builtin"`; no-adapter v1/v2 sessions retain `noTools: "all"`, no custom tools, and the original active-tool assertion.
- Model-visible tool output is capped at Pi's 50 KiB / 2,000-line limits and details contain metadata only, even when a valid adapter response is larger.
- Focused contract/runtime/Pi adapter validation passes 32/32 tests, including a real Pi SDK no-turn activation check.

## Diff summary

- Code/content commits: pending final squash SHA from the reintegration receipt.
- Summary artefact commit: intentionally omitted; this file must not self-reference its own mutable SHA.
- Files touched: `src/tool-adapter-runtime.ts`, `src/pi-adapter.ts`, `src/index.ts`, `test/tool-adapter-runtime.test.mjs`, `test/pi-adapter.test.mjs`.
- Tests: added 10 focused runtime scenarios plus Pi factory and real SDK adapter activation coverage; focused combined result 32 passing, 0 failing.
- Behavioural delta: validated protocol-v2 descriptors can activate only their fixed root-confined filesystem tools through an isolated host adapter connection. Legacy and descriptor-free sessions are behaviorally unchanged and remain no-tools.

## Operator-takeaway

The daemon gains useful project filesystem authority without loading project extensions or granting shell/process/network access: authority is explicit, secret, generation-bound, bounded at every transport/tool boundary, and revoked with the logical session.
