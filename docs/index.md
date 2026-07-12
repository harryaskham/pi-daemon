---
layout: default
title: Pi Daemon
---

# Pi Daemon

Pi Daemon multiplexes many independent, on-demand Pi SDK sessions in one
long-lived Node process. It shares authentication and model metadata while each
logical session keeps its own session manager, settings, event sequence, queue,
and durable idempotency state.

The initial service is intentionally no-tools: it does not load extensions,
skills, prompt templates, themes, context files, or built-in filesystem/process
tools. It is a neutral local service, not a Cacophony component.

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

Initial implementation is active. See the repository `PLAN.md` for the
provisional delivery board and acceptance sequence.
