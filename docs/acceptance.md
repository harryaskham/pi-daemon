---
layout: default
title: Acceptance
---

# Full standalone host acceptance

Validated on 2026-07-14 with Node >=22.19, Pi SDK 0.80.6, ACP SDK 1.2.0,
and the clean npm/Nix package definitions.

## Credential-free end-to-end host

`test/full-host-acceptance.test.mjs` starts one real in-process Pi Daemon host
on IPv6 loopback with a bearer-authenticated API and a deterministic local
OpenAI-compatible streaming model. It uses the production `PiSessionFactory`,
`AgentSessionRuntime`, durability/catalog/ticket stores, HTTP/WebSocket server,
Pi RPC controller, ACP adapter, and stdio bridge—not a transport-only fake.

The test proves in one lifecycle:

- unauthorized HTTP is rejected before resource disclosure;
- two differently configured sessions are created by durable REST tickets;
- a denied project cannot auto-load an ambient extension and unapproved package
  configuration is rejected;
- out-of-root cwd admission fails safely;
- controller and observer attachments receive scoped event streams with no
  cross-session implicit subscription;
- concurrent Pi RPC prompts obey the daemon-wide turn semaphore;
- Pi new, switch, fork, state, entry, and conversation-identity transitions
  remain available through the hosted runtime;
- a disconnected reader reconnects from an opaque replay cursor;
- ACP initialize/load uses the same resident runtime;
- the framed remote bridge exposes stock Pi RPC JSONL on bounded streams;
- a real host restart emits a host-identity replay gap, reopens the exact
  persistent conversation, replays only queued work, and leaves accepted work
  indeterminate;
- an env-dependent memory session becomes dormant/unprovisioned, is explicitly
  re-provisioned by optimistic update, and can be deleted with retained state
  removed; and
- environment values and the service bearer never appear in durable state.

The test patches every Node child-process entry point before dynamically loading
Pi or Pi Daemon. Session creation, wakes, RPC, ACP, restart, and bridge work all
complete with zero child-process calls. (The installed CLI subprocess smoke is a
separate packaging test and intentionally launches the package executable.)

## Adversarial matrix

The normal `npm test` suite additionally proves:

- clean npm pack/install plus both installed binaries;
- language-neutral NDJSON, REST, Pi RPC, framed replay, ACP, and stdio fixtures;
- pre-allocation serialization bounds and typed overflow;
- malformed, unmasked, fragmented/oversized, unauthorized, and stale-generation
  WebSocket handling;
- two-reader private response routing, colliding IDs, controller release,
  observer denial, extension-UI first response, ping/pong, slow-reader isolation,
  expired/prior-host/prior-generation gaps, and replacement detach;
- per-session settings/resources/models/auth/env behavior and explicit
  unisolated trust limits;
- bounded manifest/catalog/journal/ticket recovery, queued versus accepted crash
  semantics, health degradation/reconciliation, sweep/disposal, and whole
  shutdown deadlines;
- path traversal, symlink, permissive mode, credential-root overlap, secret
  redaction, extension trust, and API/body/frame capacity failures; and
- exact Pi SDK/RPC compatibility inventories.

`npm test` is the complete credential-free Node gate. `nix flake check` builds
the pinned dependency closure, runs that suite in the package check, and verifies
the package/app/install surface. On the constrained macOS host, acceptance uses
`::1` for loopback tests to avoid unrelated Tailscale IPv4 `CLOSE_WAIT`
exhaustion.

## Optional live-provider proof

`scripts/live-sdk-smoke.mjs` remains an optional credentialed parity check. It
patches child-process entry points before loading Pi, opens two independent
no-tools sessions, runs exact `A` and `B` prompts concurrently, verifies isolated
results/events, and reports timing and the empty child-process call list.

```console
PI_DAEMON_LIVE_MODEL=github-copilot/gpt-5-mini npm run test:live
```

## Crash guarantee

Pi Daemon does not claim exactly-once provider execution across a crash in the
narrow window between provider completion and terminal journal fsync. That state
is explicitly `indeterminate`; it is queryable/reconcilable and never blindly
replayed.
