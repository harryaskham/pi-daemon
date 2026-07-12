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
