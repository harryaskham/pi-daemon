# Session summary — in-process ACP adapter at `/apc`

## Goal

Implement the operator-requested `/v1/session/{sessionRef}/apc` endpoint as upstream Agent Client Protocol (ACP) JSON-RPC 2.0 over WebSocket, reusing the resident Pi runtime and never spawning the external adapter or `pi --mode rpc`.

## Bead(s)

- `bd-e27685` — Expose an in-process ACP adapter at the session `apc` endpoint.
- Parent: `bd-55ab9e` — Deliver the full standalone Pi session host API.

## Before state

- `/apc` was a published authenticated route but returned typed `501 stream_not_implemented`.
- Full Pi RPC and bounded multi-reader attachment were landed, but no ACP initialization/session/prompt/update/permission translation existed.
- The useful MIT `svkozak/pi-acp` parity implementation still owned a `pi --mode rpc` subprocess, ambient session discovery, process environment, and direct filesystem reads that cannot be used by the daemon core.
- The landed stdio/client tree had 137 credential-free tests before the three ACP integration tests.

## After state

- `src/acp-adapter.ts` provides bounded ACP hubs and peers over the landed RFC 6455 WebSocket transport. The required subprotocol is `agent-client-protocol.v1`; bearer, route, exact ID/name, generation, and resident-runtime checks occur before the ACP SDK receives messages.
- `@agentclientprotocol/sdk` is exactly pinned at 1.2.0. Capabilities report ACP protocol/version, SDK version, in-process operation, limits, and the audited upstream parity source.
- ACP `initialize`, route-scoped `session/new`, bounded catalog `session/list`, exact `session/load`, prompt/images, cancellation, model/max-thinking configuration, current modes, message replay, available commands, and connection-only session close are implemented.
- Pi text/thinking deltas, tool starts/progress/results, queue/session metadata, retry/compaction notices, and errors become ordered ACP `session/update` notifications. Prompt completion waits for Pi `agent_settled` and queued notifications.
- One prompt may run per logical session across many ACP peers; races return a typed busy JSON-RPC error. Disconnect/cancel aborts the shared turn safely.
- Extension `select`/`confirm` UI is routed as ACP `session/request_permission` to the active prompt client and returned to Pi. Unsupported free-form input/editor is cancelled visibly.
- Images are supported; MCP servers, audio, embedded context, and extra ambient roots are unadvertised/rejected. No adapter subprocess, global env mutation, ambient session discovery, or extra filesystem diff reads were added.
- Built-in headless commands cover compact/session/name/autocompact/steering/follow-up, while Pi commands/templates/skills are advertised from the resident controller.
- `/v1/capabilities`, schema fixture, operations/security/session docs, package exports, and third-party notices now describe the active ACP adapter. The external MIT `pi-acp` design was audited at commit `49d6ec804d40b52317d873360654054c5d2387a3`; its license is retained in `THIRD_PARTY_NOTICES.md`.
- Test network harnesses use supported `::1` because host Tailscale leaked ~15,600 IPv4 CLOSE_WAIT sockets; production still defaults to and tests literal IPv4 loopback policy separately.
- Failing product tests: none. `npm test` passes 140/140 locally and independently. `nix flake check --no-build` passes. Two proxy-backed full Nix runs fetched/installed dependencies, compiled, passed all 140 tests, and completed installPhase, then the Nix daemon hung in `RemoteStore::buildPaths` during fixup with no build child/network fd; both were timeout/interrupted and the output was not registered. This is recorded infrastructure evidence, not a product bypass.

## Diff summary

- Implementation commit: `abbba26` — in-process ACP endpoint, SDK dependency, schema/capabilities, tests, docs, attribution, API routing.
- Harness/hash commit: `95c08ac` — IPv6 ACP integration harness and refreshed Nix npm dependency hash.
- Board commit: `bd72d16` — provisional PLAN completion marker.
- Summary artefact commit: intentionally omitted; this file must not self-reference its mutable commit SHA.
- Nix npm dependency hash: `sha256-Voqa2MPPpUV7xL1UspflRfnneirSUq3DIfV7lZBMbSY=`.

## Operator-takeaway

The oddly spelled `/apc` route now speaks real upstream ACP, entirely in-process and against the same durable Pi session used by Unix, REST, raw Pi RPC, and framed attachments. The full-host completion program is now down to final acceptance/release validation.
