---
layout: default
title: Dash session ownership and export
---

# Dash session ownership and export

`SessionOwnershipService` is the explicit boundary between preview-only Pi JSONL
inventory and a managed Pi Daemon writer. Reading a transcript never acquires
ownership. Direct co-opt, fork/import, export, append-back, and release are
separate durable ticket operations.

The public modules are:

- `session-ownership` — policy, source validation, runtime activation, write
  guards, export, release, and the embedded Multiplexer adapter;
- `session-ownership-store` — bounded owner-private mappings, cooperative
  leases, and activation/export ticket recovery; and
- `source-fingerprint` — the exact shared `sha256:<base64url>` raw-content
  fingerprint used by inventory and projection.

## Storage authority

Pi Daemon may use two session storage policies:

- `pi-session-root` (recommended) derives Pi's normal cwd-encoded project
  directory below the canonical `<agentDir>/sessions` subtree. Pi Adapter now
  permits only descendants of this narrow data subtree while continuing to
  reject auth, model, extension, config, and other agent-directory siblings.
- `daemon-owned` stores each managed conversation below a path-safe encoded
  session directory inside daemon state.

Workload cwd remains independently constrained to configured allowed roots.
Inventory sources must be owner-owned regular non-symlink files under explicit
private source roots and may not overlap daemon state.

## Durable tickets and crash semantics

Every operation is scoped by kind, target, and idempotency key. Reusing a key
with the same semantic request joins the retained ticket; different content
conflicts. The owner-private `STATE_DIR/web/ownership-v1.json` contains bounded:

- inventory-to-managed-session mappings;
- exact source size/mtime/device/inode/content fingerprint and base entry IDs;
- direct/imported mode and active/released/conflict status;
- cooperative lease identity and expiry;
- exported inventory IDs; and
- queued/running/succeeded/failed/indeterminate activation and export tickets.

A restart leaves queued work replayable only when the caller repeats the same
idempotent request. Running work becomes `indeterminate` and is never submitted
again automatically.

## Activation modes

- `preview-only` succeeds without creating or hydrating a runtime.
- `reuse` returns an existing active ownership mapping or managed catalog
  session and renews its lease.
- `direct` requires the explicit `direct-co-opt-confirmed-v1` policy reference.
  It revalidates the exact inventory fingerprint, approved source/cwd roots,
  competing mappings, controller/mutation state supplied by the backend, and
  best-effort writer observation before opening the original file.
- `fork` imports the Pi tree into a new UUID/file under the configured managed
  storage root and leaves the source byte-for-byte unchanged.

A caller-supplied runtime-spec factory provides trusted model/tool/resource
policy. The ownership service overwrites only cwd, target, storage directory,
name, and the honest `unisolated` mode needed to make the activation identity
exact; it never invents provider credentials or ambient tools.

## Cooperative write guard

Stock Pi does not honor a shared cooperative lock. Direct mode therefore cannot
claim a perfect cross-process mutex. Dash combines:

- one active ownership mapping per source and managed session;
- a renewable owner-private lease;
- optional platform open-writer observation;
- exact pre-write content/stat identity checks; and
- post-write prefix/entry validation plus fingerprint refresh.

`beforeManagedWrite()` fails closed and marks `external_write_conflict` if a
direct source changed. `afterManagedWrite()` accepts only a history preserving
the recorded entry-ID prefix. `checkForExternalConflicts()` provides a bounded
periodic guard. A conflict closes the runtime best-effort, preserves both files,
and changes inventory ownership state rather than silently continuing.

## Export

`as-new` writes a new current-version Pi session with a fresh UUID and
`parentSession` metadata under the normal cwd-encoded Pi session directory. It
uses an owner-private atomic publication and updates inventory immediately.

`append-to-origin` is available only for imported sessions. It requires:

1. the origin's exact recorded fingerprint/stat identity is unchanged;
2. no known external writer;
3. the managed entries preserve the origin entries exactly as a prefix;
4. the delta is one linear parent-ID continuation; and
5. a second source revalidation immediately before atomic publication.

Any divergence returns `external_write_conflict` or
`managed_history_diverged`; it never overwrites the origin. `releaseAfterExport`
closes the managed runtime, marks ownership released, and refreshes inventory.

## Integration

`MultiplexerSessionOwnershipRuntime` maps a trusted `SessionSpec` through the
same `parseSessionConfiguration()`, catalog, generation, runtime, and close
paths as the existing REST API. Embedded and remote `DashboardBackend`
implementations call the neutral ownership service rather than reaching into
inventory records or Pi Adapter internals.

The server/controller layer remains responsible for invoking the write guard at
command boundaries and for supplying authoritative active-controller state.
