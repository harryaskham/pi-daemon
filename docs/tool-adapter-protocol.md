---
layout: default
title: Host tool-adapter protocol
---

# Host tool-adapter protocol

Protocol v2 adds one default-off way to give a logical session a small,
product-neutral filesystem capability without loading project extensions or
exposing a shell inside Pi Daemon. Protocol v1 is unchanged: every v1 resource
field, including `tools`, must still be `"none"`.

The public machine contracts are
[`protocol-v2.schema.json`](protocol-v2.schema.json) for daemon records and
[`tool-adapter.schema.json`](tool-adapter.schema.json) for the descriptor and
adapter frames. TypeScript consumers may import `protocol-v2` and
`tool-adapter-protocol` from the package.

## Trust boundary

The adapter is an operator-owned service on a private filesystem Unix socket. A
v2 client passes a closed `HostToolAdapterDescriptor` when it opens the session.
The descriptor grants only the listed operations to one exact host incarnation,
logical session ID, and generation. The session `cwd` from `open` is the implicit
filesystem root; the descriptor cannot nominate another root.

This is capability routing, not a sandbox. The adapter and daemon still share an
operator trust domain. The contract deliberately has no bearer, PKI, environment,
network, process, package, extension, remove, or arbitrary method field.

```json
{
  "protocolVersion": "2.0",
  "requestId": "req-open-v2-1",
  "operation": "open",
  "sessionId": "agent-a",
  "generation": 2,
  "payload": {
    "cwd": "/workspace/agent-a",
    "session": { "mode": "new" },
    "resources": {
      "extensions": "none",
      "skills": "none",
      "promptTemplates": "none",
      "themes": "none",
      "contextFiles": "none",
      "tools": {
        "mode": "host-adapter",
        "descriptor": {
          "protocolVersion": "1.0",
          "adapterId": "owner-filesystem",
          "adapterVersion": "1.2.0",
          "endpoint": {
            "transport": "unix",
            "path": "/run/user/1000/pi-tools.sock"
          },
          "binding": {
            "hostInstanceId": "host-019f",
            "sessionId": "agent-a",
            "generation": 2,
            "capabilityHandle": "<base64url capability>"
          },
          "operations": [
            "fs.list",
            "fs.stat",
            "fs.read",
            "fs.search",
            "fs.write",
            "fs.edit"
          ],
          "limits": {
            "maxRequestBytes": 1048576,
            "maxResponseBytes": 1048576,
            "maxConcurrentRequests": 4,
            "maxQueuedRequests": 16,
            "requestTimeoutMs": 30000,
            "maxIdempotencyKeys": 256,
            "idempotencyTtlMs": 3600000
          }
        }
      }
    }
  }
}
```

Nested adapter-policy objects are intentionally closed even though outer daemon
command envelopes remain minor-version forward tolerant. This prevents a client
from smuggling an ignored token, environment map, or alternate authority into a
security-sensitive descriptor.

## Descriptor validation

- `protocolVersion` is the adapter wire contract version, currently exactly
  `1.0`. It is independent from daemon protocol v2.
- `adapterId` is a 1–128 character neutral identifier and `adapterVersion` is a
  bounded semantic version. Both are echoed on every frame.
- `endpoint.transport` is exactly `unix`. `endpoint.path` is a canonical absolute
  filesystem path and at most 100 UTF-8 bytes, so it fits the supported Unix
  socket path limits. The runtime additionally requires an owner-private socket
  and directory before connecting.
- `binding.hostInstanceId`, `sessionId`, and `generation` must match the accepting
  host and v2 open envelope exactly. Restart changes host identity; replacement
  changes generation. Either change invalidates the descriptor.
- `binding.capabilityHandle` is 32–512 base64url characters. Pi Daemon treats it
  as a secret. It is memory-only, appears on the wire only in the initial
  `bind` frame, and must never enter logs, errors, status, events, manifests,
  journals, tickets, or responses. A restarted host requires reprovisioning; it
  does not replay a retained handle.
- `operations` is a unique, non-empty subset of the six constants below.
- Every limit is required. There are no environment- or implementation-derived
  authority defaults.

The checked hard ranges are:

| Limit | Minimum | Maximum |
|---|---:|---:|
| request bytes | 2 KiB | 4 MiB |
| response bytes | 1 KiB | 4 MiB |
| concurrent requests | 1 | 64 |
| queued requests | 0 | 256 |
| request timeout | 100 ms | 120 s |
| retained idempotency keys | 1 | 4,096 |
| idempotency retention | 1 s | 24 h |

The numeric range check is not sufficient by itself: descriptor admission also
serializes the normalized mandatory `bind` and `bound` frames and rejects limits
that cannot contain them. Thus a legal descriptor can always complete its own
handshake even when identity and capability fields approach their maxima.

## Fixed operations

All paths are UTF-8, root-relative POSIX paths. Empty, absolute, backslash,
control-character, non-canonical, and `..` paths fail before adapter dispatch.
The runtime resolves each path beneath the canonical session cwd and refuses
symlinks or any result that escapes that root. No request transmits an absolute
root.

| Operation | Request payload | Successful data |
|---|---|---|
| `fs.list` | `path`, optional `maxEntries` | bounded `entries` (`name`, file/directory `type`, optional size/time) and `truncated` |
| `fs.stat` | `path` | file/directory `type`, `size`, optional modification time |
| `fs.read` | `path`, optional byte `offset` / `maxBytes` | UTF-8 `content`, `bytesRead`, `eof` |
| `fs.search` | `path`, literal `query`, optional `maxResults` | bounded root-relative line/column/text matches and `truncated` |
| `fs.write` | `path`, UTF-8 `content`, optional `create`, `overwrite`, `expectedDigest` | `created`, `bytesWritten`, resulting SHA-256 `digest` |
| `fs.edit` | `path`, ordered exact `oldText`/`newText` edits, optional `expectedDigest` | replacement count and resulting SHA-256 `digest` |

`fs.search` is literal data matching, not a regex or command language.
`expectedDigest` is an optimistic-concurrency guard. An edit must fail rather
than guess when an exact old-text match is absent or ambiguous. The adapter must
not return symlink/device authority as an ordinary file result.

## Bind, invoke, abort, and revoke

One runtime connection carries a single bound capability. Frames are bounded
NDJSON and use these distinct `kind` values; lifecycle kinds never expand
`NeutralToolOperation`:

1. `bind` carries adapter identity, host/session/generation identity, the secret
   capability handle, operations, and limits.
2. `bound` echoes the nonsecret identity, operations, and limits exactly. It
   never echoes the capability handle.
3. `invoke` carries the same nonsecret identity, `requestId`, `idempotencyKey`,
   one granted operation, and its typed payload.
4. `result` echoes identity, both request keys, and operation. It contains
   either bounded typed `data` or `{code,message,retryable}`. Error text and
   content are bounded and must not contain the capability.
5. `abort` carries its own `requestId` and the in-flight `targetRequestId`.
   `aborted` echoes both plus `aborted`; a failed acknowledgement may include the
   same bounded error body. Neither frame carries a capability or idempotency key.
6. `revoke` and `revoked` carry only the nonsecret identity. Revoke is
   best-effort during close, generation replacement, or disposal; closing the
   private socket is the final revocation backstop.

Every acknowledgement and result is rejected unless adapter ID/version and
host/session/generation match the descriptor. `bound` must also echo the exact
operation order and every limit. Results for ungranted operations, mismatched
request or idempotency keys, late generations, stale host instances, duplicate
semantic keys, oversized frames, and unexpected fields fail closed.

## Daemon envelope versions

Handshake advertises `supportedVersions: ["1.0", "2.0"]`. A response or error
echoes the exact accepted request version when dispatch has it. Host-originated
events for a session carry the protocol version recorded by that session's
successful open. Existing helper calls default to `1.0`, preserving v1 output;
v2-aware dispatch must pass the explicit accepted version. A v2 descriptor must
never be accepted and answered silently as v1.
