# Session summary — Bounded multi-reader Pi RPC attachment

## Goal

Expose each resident transport-neutral Pi RPC controller through the authenticated session API with private command responses, many bounded readers, explicit controller ownership, atomic reconnect state, and honest replay gaps.

## Bead(s)

- `bd-509428` — Implement explicit multi-reader attach with snapshot, replay, and gaps
- Parent: `bd-55ab9e` — Full standalone Pi session host API

## Before state

- The full Pi 0.80.6 controller existed in process, but `/v1/session/{ref}/rpc` returned a reserved-stream error.
- There was no WebSocket framing, controller/observer lease, response-origin routing, retained event cursor, reconnect snapshot, keepalive, or per-reader queue bound.
- Extension UI had bounded pending requests inside the controller but no transport rule for who could answer or what happened when that reader disconnected.

## After state

- Authenticated RFC 6455 upgrades select `pi-rpc.v1` (raw live-only compatibility) or `pi-daemon-rpc.v1` (framed snapshot/replay/control).
- One hub subscribes to the exact canonical session/generation controller, retains normalized bounded events, and fans them to independently bounded readers; response IDs may collide because responses return only to their issuing connection.
- Framed attach returns catalog resource, active/queued request state, Pi RPC state, leaf ID, host identity, generation, and high-water cursor before replay/live delivery.
- Opaque cursors are scoped to host/session/generation. Expired, prior-host, and prior-generation cursors emit typed `replay_gap` before a fresh snapshot.
- One explicit controller may mutate or answer extension dialogs. Observers are read-only; release/disconnect never grants randomly, and pending UI is cancelled rather than transferred.
- WebSocket text/frame, replay-event, per-hub replay, global replay, outbound queue, in-flight command, hub, and listener capacities are explicit and advertised. Ping/pong detects dead readers; malformed, unmasked, oversized, and slow readers fail connection-locally.
- Session replacement/exit detaches old readers while ordinary reader detach leaves the runtime alive. Server shutdown explicitly destroys upgraded sockets after hub disposal.
- Capabilities/schema/OpenAPI/fixtures/docs/changelog now publish the implemented RPC surface and extension UI response frame.

## Diff summary

- Code/content commits: `10d236d`, `fbc8920`
- Summary artefact commit: intentionally omitted; this file must not self-reference its own mutable SHA
- Key files: `src/rpc-attachments.ts`, `src/websocket.ts`, `src/api-server.ts`, `src/pi-rpc-controller.ts`, session API types/schema/OpenAPI/fixtures, protocol serializer compatibility, and RPC/API/package tests
- Validation: strict TypeScript build; 43 focused API/RPC/protocol/contract tests, 27 Unix/adapter/readiness regression tests, installed npm tarball/import smoke, and `git diff --check` after rebasing onto bounded readiness main
- Acceptance coverage: two clients, colliding IDs, observer denial, controller release/reacquire/disconnect, extension UI first response, disconnect/reconnect, bounded replay, expired/host/generation gaps, real host restart, generation replacement, raw mode, keepalive, malformed/oversized frames, deterministic slow-reader backpressure, and unaffected healthy reader/session

## Operator-takeaway

Pi RPC is now a real bounded authenticated service surface rather than a process-owned stdio mode: readers can reconnect safely, observers cannot mutate, controller/UI ownership is explicit, and one bad connection cannot block or terminate the shared session.
