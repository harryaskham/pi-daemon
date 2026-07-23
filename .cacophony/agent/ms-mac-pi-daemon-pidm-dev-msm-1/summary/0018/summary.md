# Session summary — multi-user provider activation and final acceptance

## Goal

Complete final ordered child `bd-9d9899` and therefore implementation of parent epic `bd-b31a5d`: expose strict secret-safe identity-provider configuration across YAML, CLI, and Home Manager; finish accessible login/current-identity UX and migration/operator documentation; prove single-owner compatibility and adversarial embedded/dedicated security acceptance.

## Land-ready commit

- `89f89d9` — `feat(dash): activate multi-user providers (bd-9d9899)`
- Based on current `origin/main` / landed administration slice `91e7af6`.

## Implementation

### Strict provider configuration

- Added `PiDaemonWebIdentityProviderConfig` / `PiDaemonWebIdentityConfig` and strict `web.auth.identityProvider` parsing.
- Added `web.auth.identityProviderFile` and `--web-identity-provider-file` to both `serve` and `web`.
- Provider documents are strict YAML/JSON, bounded to 256 KiB, duplicate-key/alias rejecting, regular, current-user/root-owned, and not group/world writable.
- Static providers are bounded to 1–128 unique identities and require at least one global administrator.
- Every identity requires exactly one unique `credentialFile` or `credentialFd`; literal credential/password/token/secret fields are unknown and rejected.
- Credential files are bounded, current-user owned, owner-only, regular, and non-symlink.
- Credential descriptors must be inherited FDs >=3 backed by owner-only regular files; they are bounded, consumed, and closed at startup.
- Only SHA-256 credential digests remain in the runtime provider. No provider/source document contains credential bytes.
- Added package export `dashboard-identity-config`.

### Explicit mode switch and compatibility

- `createDashboardServerFromConfig` now atomically constructs either:
  - exact legacy `local-owner` single-owner mode from configured/generated `web-token`; or
  - multi-user mode from the configured provider.
- Provider mode never creates a fallback `web-token` and never accepts the stale legacy token.
- Browser-supplied workspace IDs are ignored in multi-user mode; the server derives one stable opaque workspace from the authenticated principal.
- Authentication sources are mutually exclusive and fail closed.
- The service bearer remains separate and is still used only by the dedicated remote backend.
- Legacy policies/workspaces survive an in-place provider restart. A configured global administrator can list/open them and transfer ownership through existing revisioned APIs.
- Removing the provider is the explicit rollback to exact single-owner behavior.

### Home Manager

- Added `instances.<name>.dashboardAuth.identityProviderFile`.
- Added typed `dashboardAuth.identities` submodules with ID, global role, optional display name, and runtime credential path.
- Home Manager generates a non-secret provider JSON in the Nix store containing metadata and runtime secret paths only, then passes only that provider path to the embedded or dedicated process.
- Added assertions for mutually exclusive provider sources, unique identity IDs/credential paths, and at least one administrator.
- Protected the provider CLI flag from `extraArgs` override.

### Login/share UX and protocol

- Login copy now requests an operator-issued identity credential while explaining the unchanged single-owner credential and no browser persistence.
- Bootstrap additively returns the current authenticated principal ID/role/display name as informational data; requests cannot reuse it as authority.
- Production workspace chrome shows an accessible signed-in-as label.
- The existing accessible **Access & controller** dialog remains the only grant, revocation, ownership, workspace selection, audit, and handoff UI.
- Updated strict schema for the additive bootstrap identity summary.

### Migration, security, and operator docs

Updated README, changelog, operations, protocol, authorization threat model, security, acceptance, root PLAN, and web PLAN with:

- inline/provider-file/CLI/Home Manager examples;
- exact secret source and bound requirements;
- no-secret YAML/argv/Nix/status/log/browser guarantees;
- legacy state migration and rollback procedure;
- embedded/dedicated state-directory warning;
- complete enforcement/no-existence-leak/controller/bearer acceptance map.

## Acceptance coverage

Focused Node matrix: **100/100 passed** across:

- config parsing and CLI override;
- auth, identity provider and file/FD loading;
- authorization persistence, restart, corruption, rollback, bounds and idempotency;
- principal/query-bound paging and absent/unauthorized work-shape parity;
- administration and controller release-before-grant/no-restore;
- schema/OpenAPI/fixture secret scans;
- server embedded/dedicated provider activation;
- legacy `local-owner` state restart migration;
- cross-session/workspace/draft/ticket/export/schedule denial and revocation;
- live stream/provider revocation;
- dedicated CLI machine-bearer/browser-identity separation and secret-free logs;
- embedded and remote backend/channel conformance.

Other gates:

- strict root TypeScript: passed
- strict web TypeScript/build: passed
- web Vitest: **78/78 passed**
- clean build/npm pack/import/package/release: **11/11 passed**
- exact `aarch64-darwin` Home Manager derivation: passed
- exact `aarch64-darwin` Pages derivation: passed
- `git diff --check`: clean

Per hosted validation policy, complete `npm test` and `nix flake check` remain canonical mainline CI gates.

## Security conclusions

- Multi-user is exposed only after all central enforcement and administration slices landed.
- No ACL fields were added to v1 resources; the owner-private central ledger remains sole authority.
- No credential bytes enter config values, argv, Nix store, logs, status, cookies, browser storage, fixtures, or neutral service requests.
- No browser identity becomes or receives the daemon service bearer.
- Provider/role changes invalidate cookies and close active channels.
- Absent and unauthorized resources share bounded response and backend work shapes; resource audit withholds global sequence gaps.
- Identity, provider file, credential, policy, grant, idempotency, audit, session, connection, queue, frame, response, and storage sizes are bounded.

## Next lifecycle actions

1. Reintegrate synchronously.
2. Rebase checkout to the landed canonical main.
3. Close `bd-9d9899` under required mainline validation.
4. Close parent epic `bd-b31a5d` under mainline validation.
5. Continue only with the next MSM0-filed assigned bead; do not claim unrelated work.
