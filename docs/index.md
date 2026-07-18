---
layout: default
title: Pi Daemon
---

# Pi Daemon

Pi Daemon multiplexes many independent, on-demand Pi SDK sessions in one
long-lived Node process. It shares authentication and model metadata while each
logical session keeps its own session manager, settings, event sequence, queue,
and durable idempotency state.

The implemented scaffold is intentionally no-tools: it does not load
extensions, skills, prompt templates, themes, context files, or built-in
filesystem/process tools. The full target adds trusted per-session Pi runtime
configuration, durable CRUD, authenticated JSON control, Pi RPC attachment,
a stock-compatible remote stdio bridge, and ACP translation while remaining a
neutral service—not a Cacophony component.

## Documentation

- **[Operator quickstart](quickstart)** — run collision-free Home Manager instances, create/delete sessions, wait on tickets, and attach RPC or ACP clients
- [Protocol](protocol) — NDJSON operations, event flow, generations, and retry semantics
- [Session API](session-api) — additive CRUD, multi-reader Pi RPC attach, and `/apc` ACP contract
- [Dash browser/backend protocol](dashboard-protocol) — preview-first resources, normalized transcripts, multiplexed Rich/TUI channels, replay, limits, and performance budgets
- [Dash transcript projection](transcript-projection) — bounded no-hydration JSONL branch rendering, cache, paging, and fingerprints
- [Dash session inventory](dashboard-inventory) — owner-safe persisted 10k-session index, keyed search, opaque paging, and measured bootstrap
- [Dash shadow TUI](shadow-tui) — bounded in-process virtual terminal, control stripping, performance proof, and the minimal Pi view seam
- [Session configuration](session-configuration) — Pi CLI mapping, environment handling, resources, tools, and honest isolation limits
- [Operations](operations) — install, serve, probe, status, drain, and recovery
- [Session management CLI](session-cli) — JSON CRUD, tickets, prompts/controls, and endpoint discovery
- [Security](security) — shared-process trust boundary and root policy
- [Integration](integration) — client and Nix consumer examples
- [Acceptance](acceptance) — credential-free matrix and live zero-child-process proof
- [Pi SDK compatibility](pi-sdk-compatibility) — exact acquisition, public API gates, upgrades, and rollback
- [Pi RPC runtime host](pi-rpc-host) — full in-process command/event/UI semantics and policy gates
- [Remote RPC stdio bridge](rpc-bridge) — authentication, stock JSONL translation, reconnect, gap, and terminal semantics
- [ACP adapter](acp-adapter) — bounded in-process Agent Client Protocol at the `/apc` route
- [Release](release) — tag, artifact, and rollback checklist
- [NDJSON JSON Schema](protocol.schema.json) — language-neutral local protocol contract
- [Session API JSON Schema](session-api.schema.json) and [OpenAPI](session-api.openapi.json)
- [Dash API JSON Schema](dashboard-api.schema.json) and [OpenAPI](dashboard-api.openapi.json)
- [Source repository](https://github.com/harryaskham/pi-daemon)

## Status

The 2026-07-14 completion audit and every dependent implementation slice are
landed. Full credential-free npm and Nix acceptance passes across installed
artifacts, configured CRUD, Pi RPC, ACP, stdio bridge, restart/replay, security,
and bounded shutdown. The repository is a release candidate; cutting a tag
remains an explicit operator action under the release checklist.
