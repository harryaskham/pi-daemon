---
layout: default
title: Integration
---

# Integration

Pi Daemon is neutral infrastructure. Clients provide logical session IDs,
generations, cwd/model/resource policy, and durable idempotency keys. The
service has no Cacophony-specific request fields or credentials.

## JavaScript client

```js
import { PiDaemonClient } from "@harryaskham/pi-daemon";

const client = await PiDaemonClient.connect({
  socketPath: process.env.PI_DAEMON_SOCKET,
});

client.subscribe((event) => {
  if (event.event === "messageUpdate") console.log(event.data);
});

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
