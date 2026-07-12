# Pi Daemon

[![CI](https://github.com/harryaskham/pi-daemon/actions/workflows/ci.yml/badge.svg)](https://github.com/harryaskham/pi-daemon/actions/workflows/ci.yml)
[![Pages](https://github.com/harryaskham/pi-daemon/actions/workflows/pages.yml/badge.svg)](https://harryaskham.github.io/pi-daemon/)

Pi Daemon is a standalone, general-purpose service that multiplexes many
on-demand [Pi](https://github.com/earendil-works/pi) SDK agent sessions inside
one long-lived Node process.

It shares process-global Pi module code, provider authentication storage, and
model metadata while retaining a separate session tree, settings instance,
command queue, events, and idempotency state for every logical session. The
initial no-tools profile creates **no process per session or wake**.

Pi Daemon is not a Cacophony component. Cacophony can deploy and consume it, but
the service protocol contains no beads, Cacophony agents, messages, profiles,
or Cacophony credentials.

> **Status:** active initial implementation. The architecture and provisional
> delivery board are in [`PLAN.md`](PLAN.md).

## Why

Starting one `pi --mode rpc` process for every logical agent or every cold wake
repeats Node startup, module loading, provider/model setup, and process
supervision. Pi's supported SDK can host multiple independent `AgentSession`
instances in one Node process. Pi Daemon turns that capability into a bounded,
durable, observable service with a neutral local protocol.

A feasibility probe created two concurrent live SDK sessions in one process,
shared `AuthStorage` and `ModelRegistry`, received independent model responses,
and observed zero `child_process` calls during session creation or no-tool
turns.

## CLI

```console
pi-daemon serve --socket /run/user/1000/pi-daemon.sock \
  --state-dir ~/.local/state/pi-daemon \
  --allow-root ~/work

pi-daemon probe --socket /run/user/1000/pi-daemon.sock
pi-daemon request --socket /run/user/1000/pi-daemon.sock --json '{...}'
pi-daemon version
```

`serve` uses one process-global Pi `AuthStorage` and `ModelRegistry` from the
configured `--agent-dir` while creating isolated session managers, settings,
resource loaders, and event subscriptions per logical session. The initial
adapter enforces an empty tool/resource profile; project extensions, skills,
prompt templates, themes, context files, and built-in tools are not loaded.

The protocol is versioned UTF-8 NDJSON over an owner-only Unix socket. The
language-neutral [`protocol.schema.json`](protocol.schema.json), checked
fixtures under [`fixtures/`](fixtures/), and exported TypeScript protocol types
are the compatibility contract. See the [protocol design](PLAN.md#6-protocol)
and, as implementation lands, the published
[documentation site](https://harryaskham.github.io/pi-daemon/).

## Safety defaults

The first release deliberately starts narrow:

- no built-in tools;
- no arbitrary project extensions;
- explicit canonical working roots;
- owner-only local socket;
- bounded requests, queues, sessions, turns, buffers, and drain;
- content/auth redaction in logs and status;
- no blind replay after an indeterminate accepted request;
- one isolated `SessionManager` and settings domain per logical session.

A shared process is a shared trust boundary, not a sandbox. Workloads requiring
arbitrary extensions or process/filesystem tools need a separate trust domain.
See [`SECURITY.md`](SECURITY.md).

## Development

Requirements:

- Node.js 22.19 or newer;
- npm;
- Nix with flakes (recommended).

```console
nix develop
npm ci
npm test
nix flake check
```

The Pi SDK version and npm dependency graph are pinned. Strict TypeScript is the
source language; built JavaScript and declarations are emitted under `dist/`.

## Nix consumer contract

The checked-in flake exposes `packages.default`, `packages.pi-daemon`,
`apps.default`, `checks.package`, and `devShells.default` on Linux and macOS:

```nix
inputs.pi-daemon.url = "github:harryaskham/pi-daemon";
inputs.pi-daemon.inputs.nixpkgs.follows = "nixpkgs";
```

The standalone lock follows the fleet's warm nixpkgs baseline; consumers should
use `nixpkgs.follows` so Pi Daemon shares their own evaluated package set. A
Cacophony node can therefore consume the reproducible package without copying
service source into Cacophony.

## Documentation

- [`PLAN.md`](PLAN.md) — architecture, protocol, rollout, and provisional beads
- [`SECURITY.md`](SECURITY.md) — trust boundary and vulnerability reporting
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — development workflow
- `docs/` — published protocol, operations, security, and integration guides

## License

MIT. See [`LICENSE`](LICENSE).
