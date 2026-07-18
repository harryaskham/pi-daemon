---
layout: default
title: Dash transcript projection
---

# Bounded preview-only transcript projection

`TranscriptProjector` converts a persisted Pi JSONL session tree into the
versioned `TranscriptPage`/`NormalizedTranscriptRecord` contract used by Pi
Daemon Dash. Projection is deliberately independent of runtime hydration: it
does not construct `SessionManager`, `AgentSession`, or `AgentSessionRuntime`,
does not load provider auth, models, tools, resources, or extensions, and has no
prompt-capable dependency.

```ts
import { TranscriptProjector } from "@harryaskham/pi-daemon/transcript-projector";

const projector = new TranscriptProjector({ stateDir });
const page = await projector.project({
  inventoryId,
  path: sessionJsonl,
  expectedFingerprint,
  query: { limit: 200 },
});
```

Every returned page has `hydration: "not-requested"`. Displaying it must never
be interpreted as opening or taking ownership of the session.

## Source safety and limits

The source must be a current-user-owned regular non-symlink file that is not
group/world writable. The projector opens one file descriptor, validates its
identity and metadata, streams bounded chunks, and compares size, mtime,
device, and inode before/after the read. A concurrent source change returns a
retryable typed error rather than projecting mixed generations.

Effective defaults come from `DASH_DEFAULT_LIMITS`:

- source: 256 MiB;
- line: 1 MiB, rejected before concatenating an unbounded line;
- entries: 100,000;
- one normalized record: 512 KiB;
- projected output: 64 MiB;
- page: 200 records;
- cache: 1,024 entries / 256 MiB / 64 MiB each / seven days; and
- image preview metadata: 256 KiB before deferred-blob labeling.

UTF-8 is decoded strictly and every nonblank line must be a typed JSON object.
Malformed JSON, duplicate IDs, invalid parents, unsupported versions, insecure
paths, and bound violations return content-free `TranscriptProjectionError`
codes. Prompts, tool output, paths, and image bytes are never logged.

## Version and branch behavior

Pi v2/v3 IDs and parent links are retained exactly. Legacy v1 linear entries are
assigned deterministic content/index-derived IDs for preview, rather than Pi's
random migration IDs, so cache rebuilds and browser keys remain stable. Legacy
`hookMessage` roles normalize to `custom`.

The final appended entry is the current leaf. Projection walks its parent chain
to the root and renders only that active branch; sibling branches are never
flattened into a false conversation. An orphaned active path is rendered from
the reachable portion and marks the page truncated. Parent cycles and duplicate
IDs fail safely.

The semantic output preserves:

- user, assistant, system, and custom messages;
- assistant markdown, thinking, errors, usage, and cost;
- tool calls merged with their persisted result by `toolCallId`;
- orphan tool results through a generic tool record;
- bash execution records;
- compaction and branch summaries;
- model/thinking/name/label timeline records;
- visible and hidden custom messages; and
- custom extension state through bounded generic fallback data.

Raw base64 images are not copied into transcript pages or projection caches.
They become deterministic authorized `dash-blob:` references and bounded
metadata for the later blob-serving slice.

## Fingerprints, cache, and paging

Inventory and projector use an exact digest of the raw streamed file bytes:

```text
sha256:<base64url digest>
```

The expected inventory fingerprint is an optimistic precondition. A mismatch
means inventory is stale and projection fails retryably. Cache hits additionally
require unchanged source size and mtime. Owner-private cache files live under
`STATE_DIR/web/projections`, are atomically published, strictly revalidated on
read, and are rebuilt after corruption.

Pages remain chronological. Without a cursor the newest useful viewport is
returned first. `olderCursor` and `newerCursor` are opaque, versioned, and tied
to inventory ID plus fingerprint; callers must not parse them. A cursor from a
different source or generation fails as stale.

The implementation test projects and caches a 10,000-entry active branch under
the contract's local p95 budgets: cold useful viewport below 500 ms and cached
viewport below 150 ms. These are acceptance ceilings, not permission for
unbounded synchronous work.
