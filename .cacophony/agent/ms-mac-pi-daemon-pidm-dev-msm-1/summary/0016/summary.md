# Session summary — Dashboard HTTP/stream authorization enforcement

## Goal

Complete `bd-fce8f4` by applying the identity and central policy foundation from `bd-07a348` to every browser-controlled Dashboard HTTP and WebSocket boundary in both embedded and dedicated modes. Preserve exact `local-owner` behavior, keep multi-user configuration unavailable, prevent resource-existence leaks, and keep the daemon service bearer strictly machine-only.

## Bead

- `bd-fce8f4` — Dash auth enforcement: identity-bound HTTP, stream and no-leak policy.
- Parent: `bd-b31a5d`.
- Next blocked slices: `bd-284b03` (grant/sharing/transfer administration) and `bd-9d9899` (configuration, migration UX and exhaustive acceptance).

## Before state

- Browser sessions carried validated principals and the owner-private policy ledger implemented read/control/admin roles, but the BFF and stream router did not consult it.
- Any authenticated browser could still call inventory, transcript, activation, ticket, draft, schedule, export, Rich, and TUI backend methods.
- Inventory returned the backend's all-session cursor; WebSocket channels retained only client/workspace identity and local controller state.
- The dedicated backend correctly used a machine service bearer, but browser authorization had not yet been enforced before protected operations.

## After state

- Added `DashboardAuthorizationEnforcer`, shared by HTTP and the official Rich/TUI router while remaining outside `DashboardBackend`. Embedded and remote backends still receive no browser principal, cookie, grant, or identity header.
- Session policies use a deterministic canonical reference: managed session ID, otherwise Pi session ID, otherwise canonical inventory alias. Managed-session operations authorize before opening the machine backend; inventory alias resolution uses only a bounded identity-free info lookup and never returns metadata on denial.
- Inventory paging now performs hard-bounded scan-ahead and stores random cursors server-side. Cursors are bound to principal and query fingerprint, have bounded count/lifetime/buffer, never expose the backend cursor or skipped records, and are emitted only when scan-ahead has already found another authorized record. An unauthorized-only horizon therefore cannot become a cardinality oracle.
- Direct session, ticket, draft, export, workspace, and schedule lookups use the same content-free `not_found` response for absent and unauthorized IDs. Resource policies are registered for newly created workspaces, drafts, draft-send tickets, activation/export tickets, exported sessions when present, and schedules.
- Multi-user login replaces the untrusted requested workspace ID with a stable domain-separated identity-derived opaque workspace. This prevents login from probing or claiming another identity's workspace. Single-owner login retains the exact requested workspace behavior.
- HTTP role enforcement is complete: inventory/info/transcript and observer access require read; draft mutation, activation reuse, ordinary schedule inspection and controller operations require control; direct/fork activation, export, persistent schedule mutation and session-bound autonomous work require admin. Aggregate scheduler status and global settings mutation require a global administrator.
- WebSocket handshake requires workspace read. Observer/controller opens require read/control. Every Rich/TUI command, control request, extension response, TUI input/resize, and emitted event revalidates provider-backed browser session state and current resource policy. Revocation closes the subscription, releasing controller and residency leases.
- Authorization event admission is bounded to 64 queued events per subscription; overflow tears down rather than creating an unbounded promise/event chain. TUI semantic input additionally requires the actual controller channel role.
- `DashboardBrowserAuth.revalidate` provides a server-only full-session recheck without exposing principal authority to browser responses.
- Added the internal `draft-ticket` resource kind and package/export coverage for the enforcer.
- Updated threat model, protocol, security, README, changelog, root plan, and detailed web plan. Multi-user configuration remains deliberately unavailable until the next administration and final acceptance slices land.

## Tests and validation

- Implementation commit: `451b0e5` (rebased on current `origin/main`).
- Post-rebase strict TypeScript and focused identity/authorization/enforcer/server/embedded/remote/stream/dedicated-CLI suite: **72/72 passed**.
- New tests prove single-owner visibility, principal/query-bound cursors, unauthorized-only no-cursor behavior, fixed scan bounds, absent/unauthorized parity, pre-backend managed authorization, cross-principal HTTP denial, ticket/draft/export/schedule isolation, derived workspaces, settings/status administrator gates, live policy revocation, provider revocation, controller-only TUI input, and backend lease teardown.
- Clean build/npm-pack/package/release checks: **11/11 passed**.
- Exact `aarch64-darwin` Pages derivation passed with the updated authorization documentation.
- Complete `npm test` and `nix flake check` remain canonical hosted validation gates per repository policy.

## Operator takeaway

The old all-powerful browser backend is no longer reachable through the supported Dashboard server or stream router. The existing single-token operator sees the same resources and workspace, but every request now traverses the policy layer. Multiple identities are still impossible to configure through YAML/CLI/Home Manager until grant administration, migration, revocation UI, and final security acceptance are complete.
