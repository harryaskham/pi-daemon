---
layout: default
title: Integration
---

# Integration

Pi Daemon is neutral infrastructure. Clients provide logical session IDs,
generations, cwd/model/resource policy, and durable idempotency keys. The
service has no Cacophony-specific request fields or credentials.

## Prerequisite: credentials for the provider you name

Opening a session validates that credentials exist for the provider named in
`model`, before any turn is attempted. A client that names one the instance has
no entry for is refused at `open`, not at `wake`:

```
ProtocolResponseError: failed to open logical session
  cause: PiAdapterError: authentication is not configured for provider: <provider>
```

The daemon reads them from the agent directory it was started with, seeded as
described in the [operator quickstart](quickstart). This is an instance-level
prerequisite rather than a request field: the service holds no client
credentials and the protocol carries none.

## JavaScript client

```js
import { PiDaemonClient } from "@harryaskham/pi-daemon";

const client = await PiDaemonClient.connect({
  socketPath: process.env.PI_DAEMON_SOCKET,
});

client.subscribe((event) => {
  if (event.event === "messageUpdate") console.log(event.data);
});
// This registers a local listener only. See the `attach` below, and
// docs/protocol.md on explicit event delivery.

await client.request({
  protocolVersion: "1.0",
  requestId: "open-1",
  operation: "open",
  sessionId: "worker-a",
  generation: 1,
  payload: {
    cwd: "/home/me/work/project",
    session: { mode: "new" },
    model: { provider: "github-copilot", id: "gpt-5-mini" },
    resources: {
      extensions: "none",
      skills: "none",
      promptTemplates: "none",
      themes: "none",
      contextFiles: "none",
      tools: "none"
    }
  }
});

// Registering a listener is not enough: event delivery is explicit, and no
// operation subscribes a connection implicitly. Without this `attach` the
// listener above never fires — measured at 0 events against a live model,
// against 14 with it. `payload` is required and empty.
await client.request({
  protocolVersion: "1.0",
  requestId: "attach-1",
  operation: "attach",
  sessionId: "worker-a",
  generation: 1,
  payload: {}
});

const response = await client.request({
  protocolVersion: "1.0",
  requestId: "wake-1",
  operation: "wake",
  sessionId: "worker-a",
  generation: 1,
  idempotencyKey: "message-019f",
  payload: { prompt: "Reply with only pong", source: "scheduler" }
});
```

## Neutral blob/file transfer

Authenticated HTTP clients use `SessionApiClient` to reserve exact bytes,
stream them, and request a daemon-owned session reference. The caller never
supplies a host path:

```js
import { createHash } from "node:crypto";
import { SessionApiClient } from "@harryaskham/pi-daemon";

const api = new SessionApiClient({
  baseUrl: process.env.PI_DAEMON_API,
  bearerToken: process.env.PI_DAEMON_BEARER
});
const bytes = Buffer.from("bounded example", "utf8");
const sha256 = createHash("sha256").update(bytes).digest("hex");
const reserved = await api.reserveBlob(
  "worker-a",
  {
    requestId: "reserve-1",
    expectedGeneration: 1,
    metadata: { name: "example.txt", mediaType: "text/plain" },
    sizeBytes: bytes.length,
    sha256
  },
  "reserve-once",
  { waitForTerminal: true }
);
const blobId = reserved.data.result.blobId;
await api.uploadBlobContent("worker-a", blobId, 1, bytes, "upload-once");
const materialized = await api.materializeBlob(
  "worker-a",
  { requestId: "materialize-1", expectedGeneration: 1, blobId },
  "materialize-once",
  { waitForTerminal: true }
);
console.log(materialized.data.result.relativeRef); // uploads/file-...
```

Treat name/MIME as untrusted, reconcile tickets before choosing fresh keys, and
disable generic sharing when capabilities advertise
`blobTransfers.available: false`. See [Neutral blob and session file
transfer](blob-transfer) for quarantine, content-addressing, cleanup, and
attachment-only download rules.

## Protocol-v2 host capabilities

A trusted host may pass `tools: { mode: "host-adapter", descriptor: ... }` in a
v2 open. The descriptor names only an owner-private Unix endpoint, a secret
session/host/generation-bound capability, six fixed filesystem operations, and
required resource limits. It carries no client-orchestrator object, bearer,
PKI, environment, arbitrary extension, or shell authority. See the
[host tool-adapter protocol](tool-adapter-protocol) and its checked v2/adapter
fixtures before implementing a consumer.

A descriptor is minted for the current Pi Daemon `hostInstanceId`, exact logical
session ID, and generation. Clients must reprovision after restart or replacement
rather than replaying a retained capability. Responses echo the accepted daemon
protocol version; adapter results echo their nonsecret identity and request keys.

## Nix consumer

```nix
{
  inputs.pi-daemon.url = "github:harryaskham/pi-daemon";
  inputs.pi-daemon.inputs.nixpkgs.follows = "nixpkgs";
}
```

Use `packages.${system}.pi-daemon` for service packaging and
`devShells.${system}.default` for development/runners. The standalone lock is a
fallback; consumers should follow their own warm nixpkgs input.

## Other languages

Use the Unix socket directly with the checked JSON schema and fixtures. Split
records strictly on LF, preserve request IDs, accept unknown fields/minor
versions, and track both host instance ID and logical session generation.
