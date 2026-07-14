# Session summary — authenticated API admission and explicit attach

## Goal

Implement the first secure transport layer behind the additive session API contract: a configurable loopback JSON listener guarded by one service-wide bearer, safe token sourcing and upgrade admission, and explicit generation-bound event attachment on the existing owner-only Unix protocol.

## Bead(s)

- `bd-6148e1` — Add bearer-authenticated API transport and explicit session attach.
- Parent: `bd-55ab9e` — Deliver the full standalone Pi session host API.

## Before state

- The daemon exposed only an owner-only Unix NDJSON socket; there was no optional HTTP admission boundary or service bearer.
- Every successful session-addressed Unix command implicitly subscribed its connection to future events, including status/open/wake paths, and subscriptions were not generation-bound.
- API token files, inherited descriptors, environment sources, non-loopback policy, request-body bounds, and upgrade denial had no implementation tests.
- Current main had 54 Node tests after the Pi SDK 0.80.6 compatibility slice.

## After state

- `src/api-auth.ts` loads exactly one bearer from an owner-only non-symlink file, inherited descriptor, or `PI_DAEMON_BEARER_TOKEN`; the authenticator retains only a SHA-256 digest and compares fixed-length digests safely.
- `src/api-server.ts` provides an optional literal-loopback HTTP listener, authenticated `/v1/capabilities`, bounded JSON admission, fail-closed route and WebSocket-upgrade handling, connection/header/request limits, and an explicit opt-in for non-loopback plaintext.
- CLI wiring enables the listener only with `--api-port`, accepts no token value in argv, cleans up the Unix socket on startup failure, and logs only the bound host/port.
- Unix `attach` and `detach` operations are explicit, generation-bound, fixture-backed, and advertised by handshake. Status/open/wake/failed commands no longer subscribe implicitly; close clears every attachment before an ID/generation can be reused.
- Capabilities advertise only currently implemented HTTP support. Contract-reserved CRUD and `/rpc`/`/apc` upgrades authenticate first and return typed not-implemented errors until dependent slices land.
- Failing tests: none. `npm test` passes 66/66. `nix flake check --no-build` evaluates all current derivations; a redundant full Nix copy was intentionally not launched after the peer's same-closure build reported host `/nix/store` exhaustion.

## Diff summary

- Code/content commit: `042c87d` (final landed squash SHA will come from the reintegration receipt).
- Summary artefact commit: intentionally omitted; this file must not self-reference its own mutable SHA.
- Files touched: 22 implementation, protocol, fixture, package-test, documentation, and board files before this summary.
- Tests: +12 net new repository tests, including token-source permissions, exact bearer checks, disclosure denial, body bounds, CLI startup/cleanup, upgrade authentication, explicit attach/detach, and close/reuse subscription cleanup.
- Behavioural delta: operators can opt into a bearer-authenticated loopback JSON boundary today, while stream and CRUD clients receive honest capability/typed-reservation responses rather than unauthenticated or simulated behavior.

## Operator-takeaway

The daemon now has a real, fail-closed network admission boundary without importing Cacophony auth concepts, and its Unix event stream no longer grants accidental long-lived observation rights merely because a caller issued status or another session command.
