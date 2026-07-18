---
layout: default
title: Security
---

# Security

The additive HTTP/WebSocket session API uses one opaque server-wide bearer for
the complete API trust domain; it has no per-session authorization in v1. The
bearer is authenticated before bodies, upgrades, or session existence are
observed and is never accepted in process-visible CLI arguments or emitted in
logs, status, tickets, manifests, journals, or metrics. See the [Session API
contract](session-api#authentication-and-secret-handling).

A Pi Daemon process is one operator trust domain, not a sandbox. Logical
sessions isolate state and scheduling; they do not isolate malicious JavaScript
loaded into the same Node process. The initial service therefore loads no
project code or tools.

## Enforced defaults

- authenticated JSON listener disabled unless `--api-port` is explicit
- JSON listener defaults to literal loopback and refuses implicit remote plaintext
- exactly one effective service bearer source: when no external file, fd, or environment source is configured, first launch atomically generates `STATE_DIR/api-token`
- generated bearer files are random, owner-only, complete before publication, stable across restart, and never overwrite an existing path
- bearer authorization is checked before JSON bodies, route/session disclosure, and RPC/ACP stream upgrades
- bearer material is reduced to a one-way digest after startup loading and never logged or returned
- owner-only Unix socket in a non-group/world-writable real directory
- absent daemon-owned state, socket-parent, and Pi agent directories are created as owner-only; permissive or overlapping state/credential roots fail closed
- owner-only state directories, manifests, and journals
- symlink and traversal refusal for durable state/session paths
- required canonical `--allow-root` for every logical cwd
- cwd must not overlap daemon state or Pi credential roots
- opened Pi session files remain inside that logical session's state directory
- persistent Pi managers are materialized as owner-only JSONL before durable acceptance
- restart/eviction replay requires the exact recorded Pi session ID and canonical file
- memory-only sessions never write replayable wake journals or masquerade as durable
- ACP is route/cwd/generation scoped, bounded per peer/hub, and never launches an adapter subprocess
- default Pi auth file must be an owner-only regular file
- an absent custom-agent `auth.json` may be seeded once from the bounded owner-only normal Pi auth file or an explicit required seed; it is never synchronized, overwritten, logged, or returned
- empty built-in/custom tool allowlist
- empty extensions, skills, templates, themes, context files, and append prompt
- no Cacophony node token, CA key, daemon state, or orchestration authority
- structured logs redact prompts, output/content, environment, and credentials
- accepted wake requests are never blindly replayed after a crash
- queued wake requests are never replayed into a missing, corrupt, or fresh replacement conversation
- Unix event subscriptions require explicit generation-bound `attach` and `detach`
- WebSocket RPC upgrades authenticate before subprotocol, session, cursor, or controller disclosure
- RPC readers have independent message/queue bounds; cursors are scoped to host, canonical session, and generation
- one explicit controller may mutate or answer extension UI; observers retain read-only state access
- the remote stdio client accepts bearer material only through a bounded private file, inherited fd, or environment
- client bearer bytes exist only for the authenticated handshake and never enter URL, argv, stdout, stderr, or reconnect status
- remote WebSocket use requires TLS or an operator-owned authenticated loopback proxy
- Dash uses a separate owner-only web credential; the daemon service bearer is server-to-server and never enters browser state
- Dash browser sessions are bounded, revocable, server-side records addressed by an HMAC-signed opaque `HttpOnly`, `SameSite=Strict` cookie
- Dash private routes authenticate before route matching; mutations require exact Host, Origin, and per-session CSRF validation
- the initial Dash HTTP listener is loopback-only; an HTTPS public origin sets a `Secure` `__Host-` cookie through a loopback TLS proxy
- packaged Dash assets are hash-named and regular/non-writable, with traversal/symlink rejection and a deny-by-default CSP
- Dash workspace/settings files are owner-only, atomic, bounded, revision/ETag checked, and UI overlays cannot mutate service authority
- shadow-TUI frames come from a bounded in-process cell grid; raw ANSI, OSC 52 clipboard access, image/device payloads, unsafe links, terminal queries, and unsupported controls never reach the browser
- a TUI view shares one resident runtime, extension instance, and JSONL writer; a child Pi/PTY is not a supported rendering path

Prompts and terminal results are necessarily retained in the private durable
request journal so a queued request can be replayed and a duplicate terminal
request can receive its prior result. They are not emitted in status or logs.
Protect the state directory as sensitive application data.

## Configured session authority

Authenticated clients may explicitly create an `unisolated` configured session.
The admission parser separates a secret-free persisted spec and sorted
environment-key summary from the memory-only raw overlay. Raw values never enter
the catalog or journal; after restart an env-dependent operation fails
`credentials_required` until re-provisioned. The daemon never swaps global
`process.env` or cwd. Known provider API keys use a session-scoped in-memory auth
store and the bash overlay applies only through a child-process spawn hook.

Automatic extensions, packages, skills, prompts, themes, and context discovery
remain disabled unless project trust is explicitly approved. Explicit resource
paths are themselves an authority grant. Extension/package JavaScript still
shares process memory, globals, ambient daemon environment, and provider
registries with every other in-process session.

## Separate inhabitants

Configured process/filesystem tools and reviewed extensions may share one
`unisolated` daemon only when all sessions are mutually trusted. A workload
requiring unreviewed project JavaScript or shell-grade environment, filesystem,
process, network, or credential isolation must run in a separate Pi Daemon
process/security domain until a stronger advertised backend exists.

Report vulnerabilities privately to the repository owner; do not include live
credentials, prompts, output, or private paths in a public issue.
