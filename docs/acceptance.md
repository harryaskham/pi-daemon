---
layout: default
title: Acceptance
---

# Initial acceptance report

Validated 2026-07-12 on macOS with Node v26.4.0, Pi SDK 0.80.3, and
`github-copilot/gpt-5-mini`.

## Live SDK multiplex proof

The optional `scripts/live-sdk-smoke.mjs` harness patches
`child_process.spawn`, `spawnSync`, `exec`, `execSync`, `execFile`,
`execFileSync`, and `fork` **before dynamically importing the Pi SDK or Pi
Daemon adapter**. Any attempted child process throws immediately and is
recorded.

The harness starts the full owner-local service path: `FileDurabilityStore`,
`Multiplexer`, `PiSessionFactory`, `ProtocolServer`, and two independent
`PiDaemonClient` Unix-socket connections. Two distinct no-tools in-memory SDK
sessions share one `AuthStorage` and `ModelRegistry`, journal their wakes, and
run exact `A` and `B` prompts concurrently.

Observed result:

```json
{
  "ok": true,
  "transport": "unix-ndjson",
  "durableJournal": true,
  "sessions": 2,
  "results": { "a": "A", "b": "B" },
  "eventCounts": { "a": 15, "b": 15 },
  "childProcessCalls": [],
  "openDurationMs": 32.08,
  "concurrentTurnDurationMs": 4828.06
}
```

Run it only in a credentialed operator environment:

```console
PI_DAEMON_LIVE_MODEL=github-copilot/gpt-5-mini npm run test:live
```

## Credential-free acceptance matrix

The normal `npm test` suite proves:

- concurrent logical sessions and global turn semaphore behavior
- per-session serialization and monotonic event sequencing
- live duplicate wake joining and terminal duplicate cache hits
- generation/policy conflicts and bounded session/turn capacity
- one-session failure/abort containment
- queued restart replay and accepted-to-indeterminate conversion
- owner-only atomic manifests/journals and terminal retention compaction
- path traversal, symlink, permissive mode, and authority-root refusal
- empty Pi tool/resource profile and distinct session/settings/resource state
- real SDK no-tools session construction without a model turn
- bounded Unix NDJSON framing, connection isolation, and typed errors
- drain timeout abort, idle eviction, metrics, and structured-log redaction
- language-neutral fixture/schema compatibility

The project does not claim exactly-once provider execution across a crash in the
narrow window between provider completion and terminal journal fsync. That
state is explicitly `indeterminate` and automatic replay is refused.
