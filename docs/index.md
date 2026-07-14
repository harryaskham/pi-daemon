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
and ACP translation while remaining a neutral service—not a Cacophony
component.

## Documentation

- [Protocol](protocol) — NDJSON operations, event flow, generations, and retry semantics
- [Operations](operations) — install, serve, probe, status, drain, and recovery
- [Security](security) — shared-process trust boundary and root policy
- [Integration](integration) — client and Nix consumer examples
- [Acceptance](acceptance) — credential-free matrix and live zero-child-process proof
- [Release](release) — tag, artifact, and rollback checklist
- [JSON Schema](protocol.schema.json) — language-neutral protocol contract
- [Source repository](https://github.com/harryaskham/pi-daemon)

## Status

The PD-001–PD-012 scaffold is implemented, but the 2026-07-14 completion audit
found the full standalone host is not release-ready. See the repository
`PLAN.md` for the evidence, registered Cacophony board IDs, dependency order,
and full-host acceptance sequence.
