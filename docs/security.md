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
- cwd must not overlap daemon state or Pi credential roots unless the operator explicitly enables the high-trust `security.allowAuthorityRootOverlap` policy; with it enabled, session tools can reach protected paths beneath the cwd
- newly managed Pi session files remain inside that logical session's owner-private state directory
- explicitly confirmed direct co-opt may retain an existing source under a configured inventory root when its directory/file are current-user-owned, real, and not group/world writable; conventional read/execute bits are preserved rather than silently chmodded
- newly persistent Pi managers are materialized as owner-only JSONL before durable acceptance
- restart/eviction replay requires the exact recorded Pi session ID and canonical file
- memory-only sessions never write replayable wake journals or masquerade as durable
- ACP is route/cwd/generation scoped, bounded per peer/hub, and never launches an adapter subprocess
- default Pi auth file must be an owner-only regular file
- an absent custom-agent `auth.json` may be seeded once from the bounded owner-only normal Pi auth file or an explicit required seed; it is never synchronized, overwritten, logged, or returned
- empty built-in/custom tool allowlist
- empty extensions, skills, templates, themes, context files, and append prompt unless an owner-private `web.runtimePolicy` names exact reviewed resources; explicit lists exclude ambient user/project discovery and failures abort activation
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
- a cookie-authenticated same-origin bootstrap reproduces the session-bound HMAC CSRF token in a no-store response header, so an ordinary browser reload restores mutation authority without putting the owner credential, cookie, or CSRF token in browser storage
- Dash private routes authenticate before route matching; mutations require exact Host, Origin, and per-session CSRF validation
- Dash plaintext listeners are loopback-only; remote deployments use an operator-owned loopback TLS proxy or native HTTPS/WSS with bounded file/fd material and TLS 1.2 minimum
- native TLS requires an exact HTTPS public origin, rejects mismatched SNI/Host/Origin, atomically rotates only a fully valid certificate/key pair, and retains the last good context on reload failure
- forwarded authority is never inferred: RFC `Forwarded` is rejected, and exact `X-Forwarded-Host`/`Proto`/`Port` evidence is accepted only from loopback after explicit trust
- HTTPS public origins emit HSTS and use a `Secure` `__Host-` browser cookie; non-loopback HTTP origins require an explicit development override and still cannot enable a remote plaintext listener
- certificate and private-key bytes are bounded, never enter YAML/argv/Nix store/status/logs, and file targets are owner-controlled with owner-only private-key mode
- content-free `/dash/healthz` still enforces Host/proxy authority and reveals no session, credential, path, certificate, or backend state
- packaged Dash assets are hash-named and regular/non-writable, with traversal/symlink rejection and a deny-by-default CSP
- Dash workspace/settings files are owner-only, atomic, bounded, revision/ETag checked, and UI overlays cannot mutate service authority
- lazy Dash session drafts use a separate owner-private atomic store; create/get/cancel perform no runtime/model/tool work, private first-message content never enters browser resources, and prompt-submitting crash/cancel races become indeterminate rather than replayed
- shadow-TUI frames come from a bounded in-process cell grid; raw ANSI, OSC 52 clipboard access, image/device payloads, unsafe links, terminal queries, and unsupported controls never reach the browser
- declarative extension views are validated and normalized before replay/browser delivery; only inert allowlisted nodes, opaque authorized-blob image references, exact view-scoped actions, and bounded string/boolean form responses are accepted—never extension JavaScript, HTML, CSS, callbacks, ambient links, or arbitrary fetches
- full session-tree reads are count/depth/text bounded and observer-safe; fork/clone/navigate/summarize require the exact channel controller and generation, while the private in-place navigation result is correlated, non-replayed, capacity-limited, and scheduled with other model work
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

## Host-scoped tool adapter

The additive protocol-v2 [host tool-adapter](tool-adapter-protocol) is a narrower
alternative to loading project code in the daemon. Its closed descriptor grants
a subset of six fixed filesystem operations through an owner-private Unix
socket. Adapter ID/version, host incarnation, logical session ID, and generation
are checked on every frame. The session cwd is the implicit root; paths are
root-relative and the runtime must fail closed on traversal, symlinks, stale
identity, oversized records, queue/time limits, and response mismatch.

The opaque capability handle is memory-only and appears on the private wire only
in `bind`. It is never an HTTP/daemon bearer, certificate, environment value, or
persisted credential, and it must not enter logs, errors, status, events,
manifests, journals, tickets, or acknowledgements. Restart changes host identity
and requires reprovisioning rather than replay. Per-invocation `abort` and
best-effort generation/session `revoke` prevent one stuck tool from requiring a
whole shared socket teardown. V1 and every v2 `tools: "none"` open retain the
existing no-tools behavior.

## Separate inhabitants

Configured process/filesystem tools and reviewed extensions may share one
`unisolated` daemon only when all sessions are mutually trusted. A workload
requiring unreviewed project JavaScript or shell-grade environment, filesystem,
process, network, or credential isolation must run in a separate Pi Daemon
process/security domain until a stronger advertised backend exists.

Report vulnerabilities privately to the repository owner; do not include live
credentials, prompts, output, or private paths in a public issue.
