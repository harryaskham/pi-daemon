---
layout: default
title: In-process ACP adapter
---

# In-process Agent Client Protocol adapter

The operator-facing route is spelled
`/v1/session/{sessionRef}/apc`. Its wire protocol is the upstream **Agent Client
Protocol (ACP)** over JSON-RPC 2.0; Pi Daemon does not define a separate “APC”
protocol. WebSocket clients must offer `agent-client-protocol.v1` and the normal
service bearer.

Pi Daemon uses the pinned `@agentclientprotocol/sdk` and a bounded WebSocket
stream over the existing resident `PiRpcController`. It never launches the
`pi-acp` binary and never spawns `pi --mode rpc`.

## Upstream parity source

The MIT [`svkozak/pi-acp`](https://github.com/svkozak/pi-acp) adapter was audited
at commit `49d6ec804d40b52317d873360654054c5d2387a3`. Its message, tool, session,
configuration, command, cancellation, and extension-permission mappings are the
parity reference. The subprocess wrapper, ambient session discovery, global
prompt-file reads, and process environment handling are intentionally excluded.
See [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md).

## Route-scoped lifecycle

An ACP connection attaches to the durable logical session named in the URL.
After `initialize`:

- `session/new` binds that existing route-scoped session only when `cwd` matches;
- `session/load` must name that canonical session and replays its current Pi
  messages;
- `session/list` reads the bounded durable catalog;
- `session/prompt`, `session/cancel`, mode/config updates, and session
  notifications use the same in-process runtime as NDJSON and Pi RPC;
- `session/close` detaches the ACP peer; it does not delete or close the durable
  daemon session.

ACP-supplied MCP servers, additional ambient roots, audio, and embedded context
are not advertised and are rejected rather than silently ignored. Images are
translated to Pi image content. Model and thinking selectors are derived from
current Pi RPC state and available models.

## Updates, tools, and permissions

Pi text/thinking deltas become ACP agent message/thought chunks. Tool start,
progress, completion, status, kind, bounded raw input/output, and safe locations
become ACP tool-call updates. No extra filesystem reads are performed to invent
diffs.

Extension `select` and `confirm` UI requests become ACP
`session/request_permission` calls to the client that owns the active prompt.
Unsupported free-form editor/input UI is cancelled with a visible message. A
session permits one active ACP prompt across all attached clients; other clients
may inspect/list/load but receive a typed busy error if they race a turn.

Prompt completion waits for Pi `agent_settled` and for queued ACP updates to be
sent. Cancellation aborts the shared Pi turn and resolves with ACP
`stopReason: "cancelled"`.

## Bounds and failure behavior

ACP hubs, peers per hub, inbound message bytes, per-peer outbound bytes,
keepalive, and list pages are bounded. Authentication, route resolution,
generation, WebSocket handshake, and subprotocol checks occur before the ACP SDK
receives a message. Slow or malformed peers are closed independently and do not
terminate the logical session or other readers.
