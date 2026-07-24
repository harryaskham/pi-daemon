# Session summary — Linux package/inventory gate repair

## Goal

Fix operator-reported Linux Nix failures under `bd-41f3d2` without weakening package acceptance or the normative 10k inventory performance budget:

- clean npm pack/install/CLI test exceeded its aggregate 180-second Node test timeout on a cold Linux Nix builder;
- persisted 10k inventory bootstrap measured p95 69.40 ms against the unchanged 50 ms budget.

## Land-ready commit

- `e9c08fc` — `fix(linux): harden package and inventory gates (bd-41f3d2)`
- Based on Pi Daemon main `722c110`.

## Implementation

### Package acceptance deadline

- Every npm/tar/build/install child remains individually bounded at 120 seconds.
- The complete clean package test performs two TypeScript/SPA builds, pack metadata inspection, isolated install/staging, export imports, and both bin-link executions.
- Its aggregate test deadline is now 300 seconds on Linux and remains 180 seconds elsewhere, preventing aggregate cold-cache duration from being mislabeled as one hung child.
- No artifact, install, import, bin, schema, export, or release assertion was removed.

### Inventory hot-head

- Added `STATE_DIR/web/inventory-v1.head.snapshot`, a bounded owner-only Node-major V8 snapshot containing only the newest 101 browser-safe inventory rows.
- Reconcile/activity publication writes the binary head before the existing portable `inventory-v1.head.json` fallback.
- Startup synchronously validates and deserializes the binary head before availability, then schedules full HMAC-authenticated 10k snapshot hydration on the next event-loop turn as before.
- Missing or Node-major-incompatible binary heads fall back to portable JSON without quarantine.
- Malformed/oversized/insecure binary heads are quarantined and fail safely through the existing stale/corruption state.
- The binary head retains record-count/byte bounds and deep hot-head validation; it contains no canonical path or search bloom.
- Full HMAC snapshot and canonical JSON index behavior remain unchanged.
- The normative `persistedIndexBootstrapP95Ms < 50` contract was not changed.

## Validation

- strict TypeScript: passed
- complete inventory + package + release focused run: **21/21 passed**
- clean package acceptance: **12.17 s** locally
- 10k inventory: bootstrap p95 **1.98 ms**, hot first-page p95 **0.05 ms**, search p95 **12.64 ms**
- binary mode/privacy, incompatible-Node JSON fallback, no-quarantine compatibility, malformed binary+JSON corruption quarantine, full snapshot fallback, activity rewrite, and root/index safety tests: passed
- `git diff --check`: clean

The exact `aarch64-linux` Nix derivation was requested from Darwin, but Nix reported no `aarch64-linux` builder/platform is configured. Canonical Linux/Nix mainline validation remains required; no passing Linux result is claimed locally.

## Lifecycle

Reintegrate synchronously, rebase to landed main, and close `bd-41f3d2` only under required mainline validation.
