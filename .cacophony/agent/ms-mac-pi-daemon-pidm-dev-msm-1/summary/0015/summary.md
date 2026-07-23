# Session summary — multi-user authorization foundation

## Goal

Hydrate and safely decompose `bd-b31a5d` rather than retrofitting scattered ACL properties into Dash v1, then land the first independently secure foundation slice: explicit principals, a credential-provider contract, identity-bound server sessions, and one owner-private resource-policy/audit ledger. Preserve exact single-operator behavior and make it impossible to enable a partially enforced multi-user runtime.

## Bead(s)

- `bd-b31a5d` — parent multi-user identity/per-session authorization epic, decomposed and returned to the blocked parent board.
- `bd-07a348` — principal/provider and central authorization foundation (this slice).
- `bd-fce8f4` — dependent HTTP/WebSocket/no-existence-leak enforcement slice.
- `bd-284b03` — dependent grants/workspace/controller administration slice.
- `bd-9d9899` — dependent configuration, migration, UX and exhaustive acceptance slice.
- `bd-e89a17` — native TLS had already landed as `1c7cbbf`; its stale post-restart in-progress record was annotated so the implementation is not duplicated.

## Before state

- Dash browser authentication compared one configured credential digest and issued a bounded HttpOnly session carrying only client/workspace/expiry state. Every authenticated browser was in the same operator trust domain.
- There was no stable browser principal or credential-provider seam.
- Session ownership meant Pi JSONL writer ownership, not user authorization. Workspaces, inventory, drafts, tickets, schedules and channels had no coherent cross-resource authorization model.
- The multi-user epic required a separate threat model, migration and exhaustive no-existence-leak tests, but intentionally prohibited ad hoc v1 ACL fields.

## After state

- `DashboardIdentityProvider` resolves input-only high-entropy proof to a validated stable principal and revalidates an existing server-side identity by ID. `StaticDashboardIdentityProvider` bounds identities/tokens/display names, rejects duplicate IDs and token digests, requires an administrator, retains SHA-256 token digests only, and compares every configured digest for every attempt.
- Existing `web.auth.tokenFile` behavior remains exact through the deterministic `local-owner` administrator compatibility provider. No new YAML/CLI/Home Manager multi-user switch exists.
- `DashboardBrowserAuth` now binds the provider principal to server-only session state. Cookies and login/bootstrap responses remain identity-authority-free. Provider removal or any role/display-principal change invalidates subsequent cookie authentication; explicit per-identity revocation is available for the later enforcement layer.
- `DashboardAuthorizationService` is the sole future resource-policy source. It keeps session/workspace/draft/activation-ticket/export-ticket/schedule policies separate from v1 protocol resources, with one owner and ordered `read`/`control`/`admin` grants.
- The ledger is owner-private, strict-schema, bounded by hard policy/grant/audit/byte limits, revision/ETag checked, serialized and atomically published. Inaccessible and absent resources use one content-free 404. Corrupt, insecure, symlinked or oversized state fails closed without quarantine/reset.
- Pre-publication write failure restores the prior in-memory state and blocks concurrent readers behind the mutation. Post-rename durability ambiguity is explicitly indeterminate and poisons the authorizer until restart revalidates disk, preventing split-brain authority.
- Ownership/grant/revoke/transfer changes retain bounded content-free audit events with monotonic sequence and explicit dropped-event count. Global administrators may read the global retained window; resource administrators may read only that resource.
- `docs/dashboard-authorization.md` is the normative threat model, role/resource matrix, migration contract, enforcement map and delivery board. Root/web Plans, protocol, security, README, Pages, changelog and package/release exports point to it.

## Diff summary

- Implementation commit: `7bd4b3e`.
- Summary artefact commit: intentionally omitted; this file must not self-reference its mutable SHA.
- New public modules: `src/dashboard-identity.ts` and `src/dashboard-authorization.ts`; additive package subpath/root exports included.
- Compatibility integration: `src/dashboard-auth.ts`.
- Tests: `test/dashboard-identity.test.mjs` and `test/dashboard-authorization.test.mjs`, plus clean package/release export and Pages assertions.
- Validation on current main: strict TypeScript check passed; focused identity/auth/ledger tests passed 14/14; the clean build/package/release matrix passed 11/11; the exact aarch64-darwin Pages derivation published the new threat-model document. Hosted CI owns the complete npm/Nix gates.

## Operator-takeaway

The epic now has an ordered, auditable security architecture instead of incidental ACL fields. The first slice is useful but deliberately dormant: existing operators see exactly the same `local-owner` login, while the next slice can enforce one central role decision across embedded and dedicated HTTP/stream paths. There is no state in which multiple identities can authenticate into the old all-powerful browser backend.
