---
layout: default
title: Dash session inventory
---

# Dash session inventory

`SessionInventory` is the preview-only, owner-local index behind the Dash
sidebar and information view. It merges retained Pi Daemon catalog records with
approved Pi JSONL roots without hydrating an SDK runtime or sending a model
turn. Explicit writer transitions live in the separate
[session ownership and export service](dashboard-ownership).

The implementation lives in `src/session-inventory.ts` and is exported from the
package root and `./session-inventory`. `src/source-fingerprint.ts` provides the
small shared `formatSessionSourceFingerprint()` helper used by inventory and
transcript projection.

## Configuration boundary

`resolveSessionInventoryConfig()` maps
`PiDaemonWebConfig.inventory.{roots,reconcileIntervalMs,maxSessions}` into
inventory options. Raw YAML paths are resolved only through the selected
`LoadedPiDaemonConfig.resolvePath()` function. A caller may add the selected Pi
agent session root separately; roots are deduplicated and bounded.

Operator config remains input policy. Browser-facing `DashboardLimits` and
`SessionInventoryPage` remain negotiated transport resources.

## Immediate bootstrap and full hydration

The owner-private state directory contains:

```text
STATE_DIR/web/
  inventory-v1.head.json          # newest 101 rows for immediate first-page paint
  inventory-v1.snapshot           # full HMAC-authenticated Node-major snapshot
  inventory-v1.json               # canonical portable JSON recovery index
  inventory-search-key-v1.json    # private keyed-search/snapshot key
```

Startup validates and loads only the hot head before becoming available. It then
hydrates the full snapshot on the next event-loop turn. While this is in
progress, pages truthfully report `index.reconciling: true` and `stale: true`.
The snapshot is an optimization: it is authenticated with the private search
key, bound to the Node major and inventory format, byte bounded, and discarded
on corruption or incompatibility. Canonical JSON remains the portable fallback.

`waitForFullIndex()` is a service/test barrier; ordinary bootstrap does not need
to wait. After the full snapshot is installed, request-path list/info calls use
only immutable in-memory rows and precomputed order positions.

## Reconciliation

`reconcile()` runs outside the request path and atomically replaces the complete
in-memory generation only after all validation and persistence succeeds.
`start()` performs one background reconcile and repeats on the configured
interval. Filesystem notifications are not a correctness dependency; periodic
reconcile repairs missed changes.

Each pass:

1. reads retained managed catalog records;
2. canonicalizes every configured root and rejects state-directory overlap;
3. walks only those roots with bounded depth and directory-entry count;
4. skips symlinks, foreign-owned files, unsupported files, and oversize files;
5. opens candidates with `O_NOFOLLOW`, rechecks owner/type/size on the open
   descriptor, and parses bounded UTF-8 JSONL lines;
6. merges exact canonical conversation paths with managed catalog rows;
7. preserves duplicate Pi UUIDs as distinct opaque inventory IDs and adds safe
   alias/conflict diagnostics;
8. applies explicit activation/ownership policy; and
9. publishes the authenticated snapshot, canonical index, and hot head using
   owner-private atomic writes.

If a configured root itself is missing, insecure, foreign-owned, writable by
other users, or overlaps daemon state, reconciliation fails and keeps the prior
index. A malformed individual session is skipped and counted by safe issue code
without poisoning other sessions.

## Identity and metadata

A file-backed `inventoryId` is a versioned SHA-256 identity over its canonical
path, not a filesystem path. A retained memory/managed-only row is derived from
its canonical daemon session ID. Duplicate Pi session UUIDs at different paths
therefore remain separately addressable.

Title precedence is:

1. latest explicit Pi `session_info.name`;
2. daemon catalog name;
3. first eight normalized words of the first user message; or
4. `Untitled session` plus a short opaque ID.

First-message title derivation refuses obvious credential-bearing text. The
public inventory row contains only bounded title, cwd basename/project label,
Pi/daemon identities, timestamps, counts, activation eligibility, and
orthogonal presence. `modifiedAt` remains source/catalog modification truth;
optional `activityAt` is user-visible activation recency and defaults to
`modifiedAt` for older indexes. It never contains a canonical path. The authenticated
`getInfo()` resource may include the full cwd, canonical source path,
size/mtime/device/inode, exact fingerprint, ownership, aliases, and safe
diagnostics.

## Exact source fingerprint

Inventory hashes every raw file byte while streaming and formats the digest as:

```text
sha256:<base64url SHA-256 digest>
```

`formatSessionSourceFingerprint(digest)` validates the 32-byte digest and owns
this exact encoding. The transcript projector consumes the same helper, so
`expectedFingerprint` compares exact content rather than metadata or an
implementation-specific representation. Size, mtime, device, and inode remain
additional race/conflict guards.

## Search without persisted message text

The inventory never calls Pi's convenient `SessionManager.listAll()` because
that API materializes `allMessagesText`. During background parsing it keeps only
a bounded ephemeral excerpt, transforms normalized trigrams and words into a
fixed-size keyed Bloom filter, and discards the excerpt before persistence.
The private key is generated once and never exposed to browser resources.

Exact visible metadata (title, cwd basename, project label, Pi ID, daemon ID,
name) is matched directly. Message search uses the Bloom filter, so it can admit
a false-positive candidate but never a false negative within the bounded
indexed excerpt. No full user/assistant message, tool output, system prompt,
environment value, or provider credential is retained in the index.

## Paging and request bounds

Rows are preordered by descending `activityAt` (falling back to `modifiedAt`),
then source modification time and `inventoryId`. Successful reuse/direct/fork
activation advances activity exactly once inside the durable activation work,
persists the reordered hot head/index/snapshot, and leaves the source file mtime
and fingerprint untouched. Duplicate reads of the same succeeded activation
ticket do not advance it again. Unfiltered first pages and continuation use
precomputed positions. Opaque cursors bind the index revision, normalized filter
digest, last activity time, and last inventory ID. Reusing one with different filters or a new index
generation returns a typed stale-cursor error.

Search/filter scans stop after one extra result and yield to the event loop every
512 candidates. No request performs a filesystem scan or one synchronous
O(total sessions) sort.

## Measured 10k acceptance

The test suite builds and persists 10,000 managed records, launches clean Node
processes for cold bootstrap samples, and asserts the normative contract
budgets. A representative development run measured:

| Measurement | p95 | Budget |
| --- | ---: | ---: |
| persisted hot-head bootstrap + first 100 rows | 31.58 ms | < 50 ms |
| hot in-memory first 100 rows | 0.58 ms | < 150 ms |
| indexed search page | 23.65 ms | < 100 ms |

The same test verifies the full index remains below 64 MiB. These timings are
printed as test diagnostics so regressions are visible rather than inferred.
