---
layout: default
title: Session configuration and isolation
---

# Session configuration and isolation

The authenticated session API accepts a typed `SessionSpec` that maps supported
Pi CLI concepts onto one in-process `AgentSessionRuntime`. It never accepts a
shell command line and never implements per-session configuration by swapping
`process.cwd()` or `process.env`.

`parseSessionConfiguration()` is the transport-neutral admission boundary. It:

- rejects unknown fields and unsupported isolation modes;
- bounds environment entries/value bytes/aggregate bytes, resource lists,
  settings depth/properties/string bytes, prompts, flags, tools, and models;
- resolves cwd, agent, session, and explicit resource paths to absolute paths;
- returns `persistedSpec`, a sorted secret-free `environmentSummary`, the
  memory-only `environmentOverlay`, prepared runtime options, and prepared open
  options; and
- reports stable `invalid`, `unsupported`, `too_large`, or
  `credentials_required` status classes without echoing environment values.

Only `persistedSpec` and `environmentSummary` may enter the catalog, journal, log,
status, or metrics. A retained session with memory-only environment keys becomes
unprovisioned after restart. A queued operation that still needs those values
fails `credentials_required`; it is never replayed with silently missing or
host-global values.

## Runtime mapping

For configured sessions the host creates cwd-bound Pi services with isolated
`SettingsManager`, `ResourceLoader`, `SessionManager`, event subscription, tool
selection, and extension flag values. Model and scoped-model patterns use Pi's
public resolvers. A session-specific `agentDir` gets its own credential store and
`ModelRuntime`; otherwise the reviewed host defaults are reused.

Explicit extension, skill, prompt, and theme paths are loaded only from the
prepared absolute paths. Automatic project/global discovery and context files
remain disabled unless `projectTrust: "approve"` is explicit. Package settings
also require that explicit approval. Legacy Unix `open` requests retain the
locked no-tools loader exactly as before.

Tool modes map as follows:

- `default` — Pi's default built-ins and explicitly loaded extension tools;
- `none` — no tools;
- `no-builtin` — extension/custom tools only;
- `allowlist` — only named tools;
- `exclude` — applied after the selected mode/allowlist;
- `required` — stable tool IDs that must be active after Pi finishes loading the
  reviewed resources. A missing required tool fails session open with
  `required_tools_unavailable` before the generation becomes resident. Required
  tools cannot be combined with `mode: none`, named in `exclude`, or omitted
  from an `allowlist`.

`materialization` is optional nonsecret caller provenance for the already
resolved policy. Its `materializationGeneration` is deliberately distinct from
the Pi Daemon session `generation`: changing either the source generation or its
optional digest changes the retained policy digest, so an old generation cannot
silently reuse a newly resolved profile. Optional authorization source/scope and
`ownershipGeneration` strings are status receipts, not new authority. Ownership,
materialization, and Pi Daemon session generations stay distinctly named and
never contain credentials,
environment values, or filesystem paths.

Session resources expose `toolMaterialization` as bounded, content-free runtime
truth:

- `materialized` reports active stable IDs and registry entries only while the
  runtime is resident;
- `not-resident` never fabricates an inventory for a dormant generation;
- `unavailable` distinguishes a resident generation whose adapter cannot supply
  runtime inventory;
- each entry reports a source class (`builtin`, `explicit-extension`,
  `inherited-package`, `host-adapter`, `sdk`, or `unknown`), policy disposition,
  resident/dormant availability, required status, and a fixed omission reason;
- `truncated` is explicit when the versioned capability's bounded inventory
  limit was reached; required/requested names take precedence in that bound;
- no tool descriptions, extension paths, package paths, prompts, settings, or
  environment values appear in this status.

The same object is available from the session API and Dashboard session-info
runtime. Dashboard clients therefore distinguish a real empty tool set from a
runtime that was never hydrated or is no longer resident.

## Execution lifetime and concurrency

A configured logical session keeps its `AgentSessionRuntime`, conversation,
settings, resource loader, and cwd-bound policy across requests, RPC attachments,
and idle residency until it is replaced, closed, or evicted and durably reopened.
It admits one active model turn per logical session. The host-wide
`maxConcurrentTurns` semaphore (default 4) allows separate sessions to run turns
in parallel without sharing their session managers or command queues.

The built-in `bash` tool and Pi RPC `bash` command execute child invocations in
the configured cwd when tool policy and controller authority permit them. The
filesystem and conversation persist, but Pi Daemon does not provide a persistent
shell or PTY: shell-local state such as `cd`, functions, and unexported variables
does not implicitly carry into a later invocation. The public contract likewise
does not promise that multiple commands or model-selected tool calls run in
parallel inside one session; clients should use independent logical sessions
when they need explicit concurrent turns.

## Environment behavior

The overlay is not a virtual shell environment for arbitrary JavaScript. The
initial unisolated implementation applies it only through explicit public SDK
seams:

- a selected provider's known API-key environment variable becomes a
  session-scoped credential-store overlay; and
- the built-in `bash` tool is replaced with the public Pi bash definition using
  a spawn hook that merges the overlay into that child process only.

The shared credential store, ambient daemon environment, and other sessions are not
mutated. OAuth, ADC/profile credentials, custom provider command interpolation,
extension `pi.exec()`, and arbitrary extension reads of `process.env` retain
normal process-wide behavior unless a future Pi injection seam or stronger
isolation backend says otherwise.

## Trust statement

`isolation.mode: "unisolated"` is the only implemented mode. Session queues and
SDK state are isolated; JavaScript authority is not. Trusted extensions can
read or mutate module globals, daemon environment, provider registries, and
process memory. Load arbitrary extension/package code only for mutually trusted
sessions. Future process, container, VM, or tool-routing modes must advertise
the exact filesystem, process, network, credential, extension, and provider
boundaries they enforce rather than overloading `unisolated`.
