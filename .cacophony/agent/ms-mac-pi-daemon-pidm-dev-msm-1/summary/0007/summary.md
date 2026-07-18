# Session summary — persisted 10k-session Dash inventory

## Goal

Implement the first concrete Pi Daemon Dash data core: an owner-safe persisted `SessionInventory` that serves a useful sidebar immediately, reconciles approved Pi JSONL roots and managed catalog records in the background, supports stable search/filter/paging, and meets the contract’s ten-thousand-session performance budgets without retaining full message text or hydrating a Pi runtime.

## Bead(s)

- `bd-93e857` — Dash core: build a persisted 10k-session inventory with instant search and ordering.
- Depends on landed contract `bd-933f1e`; contributes to parent Dash epic `bd-ba3623`.

## Before state

- Dash had versioned inventory/info resource types and fixture shapes, but no inventory implementation.
- Pi’s `SessionManager.listAll()` was unsuitable for this boundary because it materializes unbounded `allMessagesText` and does not enforce Dash’s owner/root/source/index limits.
- There was no immediate persisted first-page path, background reconcile loop, managed/external merge, duplicate UUID handling, opaque revision-bound cursor, private message-search representation, or measured 10k acceptance.
- Inventory and the concurrently implemented transcript projector had not yet shared one canonical source-fingerprint formatter.

## After state

- `SessionInventory` merges retained managed catalog records with recursively discovered files under explicit owner-approved roots. Root/state overlap, writable/foreign roots, symlinks, foreign files, unsupported formats, corrupt/oversized files/lines, scan depth/count/aggregate bytes, index bytes, record bytes, and entry counts all fail safely and remain bounded.
- Request paths never scan the filesystem or synchronously sort all sessions. Rows are preordered; cursors bind revision, query digest, modification time, and opaque inventory ID; filtered scans stop after one extra result and yield every 512 candidates.
- Startup reads an owner-private public-only 101-row hot head immediately, then hydrates the full HMAC-authenticated Node-major snapshot on the next event-loop turn. Canonical portable JSON remains the recovery source; periodic reconciliation repairs missed filesystem notifications.
- Message search persists only a fixed-size keyed Bloom filter built from bounded normalized trigrams/words. Full user/assistant text, tool output, system prompts, environments, and credentials are discarded before persistence. The public hot head also omits canonical paths, full cwd, search Bloom data, and ownership internals.
- Exact title precedence, recent ordering, cwd/project metadata, source kind, managed generation/revision/residency/state, liveness, activation eligibility, aliases, duplicate Pi UUID diagnostics, and authenticated information resources are implemented.
- `resolveSessionInventoryConfig()` consumes `PiDaemonWebConfig.inventory` through `LoadedPiDaemonConfig.resolvePath()` while preserving the config/wire type boundary.
- `formatSessionSourceFingerprint()` is a small shared module that validates a 32-byte SHA-256 digest and encodes exact `sha256:<base64url>`. Inventory and transcript projection now use the same helper.
- npm/package exports, Nix/Pages documentation, changelog, and clean-pack import coverage include the inventory and fingerprint surfaces.

## Validation

- Full `npm test`: 197/197 passed on current main.
- Dash workspace: 7/7 Vitest tests passed; production Vite build completed.
- `nix flake check --print-build-logs`: package and Pages checks passed, with the Nix package rerunning 197/197 root tests and installed binary checks.
- Nix 10k diagnostics: persisted bootstrap plus first 100 rows p95 **35.52 ms** (<50 ms), hot first page **0.26 ms** (<150 ms), indexed search **39.46 ms** (<100 ms).
- Additional security/recovery acceptance covers owner-only atomic files, hot-head privacy, authenticated snapshot tamper fallback to canonical JSON, corrupt-index quarantine, missed-change periodic reconcile, exact fingerprint equality, and stale cursor rejection.
- A transient mainline npm lock/cache normalization regression was found by the final Nix gate, coordinated rather than duplicated, and fixed on main at `21f59ab` before the authoritative rerun.

## Diff summary

- Code/content commits before reintegration squash: `00d9953`, `49b7bae`.
- Summary artefact commit: intentionally omitted; this file must not self-reference its own mutable SHA.
- Main implementation: `src/session-inventory.ts`, `src/source-fingerprint.ts`, and the shared binary atomic-write primitive in `src/durability.ts`.
- Contract compatibility: authenticated `SessionInfoResource.cwd`, matching fixture/schema updates, and transcript projector adoption of the shared fingerprint helper.
- Acceptance: `test/session-inventory.test.mjs`, package/release coverage, `docs/dashboard-inventory.md`, protocol/projector docs, Pages/Nix publication, and changelog.
- No browser server, session ownership mutation, or SPA implementation was added; those remain separately sequenced consumers of this core.

## Operator-takeaway

The Dash sidebar no longer has to choose between speed and safety: it can paint a truthful first page in under the 50 ms server budget from public-only owner-private state, hydrate the complete 10k index afterward, repair missed filesystem changes periodically, and search bounded conversation signal without persisting raw messages. Inventory and transcript projection also now compare one exact raw-content fingerprint, preventing stale preview/activation races across independently implemented slices.
