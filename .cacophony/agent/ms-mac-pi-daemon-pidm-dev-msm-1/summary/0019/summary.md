# Session summary — inherit Pi CLI installed package resources

## Goal

Implement user-requested `bd-5e5121`: Pi CLI remains the sole package installer/updater, while explicitly trusted Pi Daemon sessions can consume the package extensions, skills, prompts, and themes already present in Pi's global managed cache.

## Land-ready commit

- `dae30fd` — `feat(pi): inherit installed package resources (bd-5e5121)`
- Based on canonical main `9ce675e`.

## Implementation

### Additive authority

- Added optional `SessionResourceSpec.inheritInstalledPackages` and strict parser/schema/fixture coverage.
- Default remains absent/false, so existing no-tools/no-extension startup, preview, wake, and session behavior is unchanged.
- Dashboard runtime policy may set the field server-side. Browser-safe New Session defaults deliberately omit the field, package declarations, and install paths; materialization merges the trusted host runtime policy back into the SessionSpec.

### Read-only package resolution

Added exported `installed-package-resources` module:

- Reads only global `AGENT_DIR/settings.json`; project package declarations are not inherited.
- Requires a bounded regular current-user/root-owned non-writable settings target (1 MiB).
- Validates at most 128 package declarations, strict package object keys, bounded manifest filters, and bounded source strings.
- Supports Pi's npm, git/URL, and local source declarations plus package object filters/autoload semantics.
- Maps npm declarations directly to existing `AGENT_DIR/npm/node_modules` installs; uses the Pi SDK only to locate existing git/local user installs.
- Requires every package root to exist and be owner-controlled.
- Rewrites all configured package sources to proven absolute **local** paths before calling Pi SDK package resolution. Therefore npm/git installer, updater, reconciler, subprocess, and network branches are structurally unreachable, including install-path disappearance races.
- Applies Pi package manifests/conventional directories and package filters, returning only enabled paths.
- Bounds each resource type to 512 unique absolute paths of at most 4096 bytes.
- Rechecks package roots and validates every returned resource as an owner-controlled regular file/directory before SDK activation.
- Missing/malformed/insecure packages fail before session creation with generic typed errors that disclose no source or private path and direct the operator to Pi CLI.

### Runtime integration

- `PiSessionFactory` resolves installed packages only when the persisted resource flag is true.
- Merges enabled package paths into the per-session isolated Pi SDK ResourceLoader.
- Existing `noExtensions`, `noSkills`, `noPromptTemplates`, and `noThemes` downscopes still suppress the corresponding package resource type.
- Host-tool-only sessions continue forcing extensions off.
- Package resource load diagnostics are included in fail-closed explicit resource validation.
- Pi Daemon never persists package paths/declarations in its session policy and never writes Pi settings/cache.

### Documentation/package surface

- Exported `@harryaskham/pi-daemon/installed-package-resources`.
- Updated README, changelog, PLAN, session API, Dashboard protocol/drafts, operations, security, and acceptance.
- Clarified that Pi CLI owns install/update/ref reconciliation and Pi Daemon consumes the existing installed checkout without reconciling versions.

## Validation

- Focused config/defaults/materializer/runtime/adapter/schema matrix: **58/58 passed**.
- Final adapter + resolver hardening matrix: **22/22 passed**.
- Package resolver fixtures prove:
  - package manifest/filter behavior across extensions/skills/prompts/themes;
  - managed npm and local package resolution;
  - empty lists add zero authority;
  - malformed/insecure settings fail closed;
  - missing npm package invokes neither a fake `npm` executable nor any install path;
  - installed npm resolution also invokes no fake `npm` executable.
- Clean build/npm pack/import/package/release: **11/11 passed**.
- Pages derivation passed.
- Live read-only validation against the operator's existing Pi cache resolved **20 extensions, 1 prompt, and 4 themes**; all 25 returned paths passed owner/mode/type checks.
- `git diff --check` clean.

Per hosted policy, full `npm test` and `nix flake check` remain canonical mainline gates.

## Local Collective follow-up

Before this feature, `~/collective/modules/home-manager/pi.nix` was corrected to provide a high-trust daemon config, normal `~/.pi/agent`, home CWD/model defaults, ambient resources, and legacy session inventory. That external working-tree change intentionally does **not** set `inheritInstalledPackages` yet because Collective is still locked to `9ce675e`, whose strict parser would reject the new field. After this commit lands and the Collective `pi-daemon` input advances, add `inheritInstalledPackages = true` to its runtime resource policy and run the operator-owned `cltv switch`.

## Next lifecycle

1. Reintegrate synchronously.
2. Rebase to landed main and close `bd-5e5121` under mainline validation.
3. Update the Collective runtime policy only after its Pi Daemon input includes the landed commit; do not run a system/flake switch from the agent.
