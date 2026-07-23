---
layout: default
title: Dash lazy session drafts
---

# Dash lazy session drafts

A Dash **session draft** is durable configuration for a new logical session that
has not yet earned runtime or prompt authority. Creating, reading, refreshing,
or cancelling an unsent draft never constructs `AgentSessionRuntime`, calls the
Pi session factory, loads provider/model/extension/tool resources, acquires a
controller, starts a process, or submits a prompt.

The machine-readable contract is
[`dashboard-session-draft.schema.json`](dashboard-session-draft.schema.json).
Browser-safe types and ETag helpers come from
`dashboard-session-draft-contract`; daemon-side persistence/execution interfaces
come from `dashboard-session-drafts`.

## Browser-safe policy

The draft spec is intentionally smaller than the trusted Session API spec:

- canonical cwd beneath a configured allowed root;
- optional bounded name;
- `persistent` or `memory` new-session persistence;
- optional provider/model/thinking selection;
- `default`, `none`, `no-builtin`, or bounded explicit tool allowlist;
- boolean discovery controls and `default`/`deny`/`approve` project trust;
- honest `unisolated` isolation.

It cannot carry raw environment, settings, extension/skill/template/theme paths,
system prompts, service bearers, or host tool-adapter capabilities. Elevated
`default` tools, approved discovery, and enabled resource kinds are accepted
only when `web.sessionDefaults.inheritRuntimePolicy` selects an owner-controlled
`web.runtimePolicy` that contains that authority. If that policy sets
`resources.inheritInstalledPackages`, materialization resolves only global Pi
packages already installed by the Pi CLI; the browser receives no package
settings or paths and cannot request installation. The daemon revalidates the
canonical cwd and policy both before atomic storage and again before
restart-time materialization.

When configured, capabilities return one browser-safe `sessionDefaults` spec:
canonical cwd, provider/model/thinking values, visible tool/resource controls,
and content-free source labels. The Pi settings path, package list, explicit
resource paths, host settings, and all secrets remain server-side. Pi settings
are owner/root-owned, non-writable bounded JSON; only `trueDefault*`/`default*`
provider, model, and thinking fields are read. No Pi runtime, provider request,
resource load, or model call occurs while resolving or displaying defaults.

## Resources and routes

Both the authenticated neutral service API and browser BFF expose the same
logical operations under their existing prefixes:

| Method/path | Meaning |
|---|---|
| `POST /session-drafts` | idempotently create one validated draft |
| `GET /session-drafts/{draftId}` | inspect current revision/state |
| `DELETE /session-drafts/{draftId}` | revision-guarded cancellation |
| `POST /session-drafts/{draftId}/send` | admit the first message once |
| `GET /session-draft-send/{ticketId}` | inspect durable first-send truth |

Browser routes retain cookie/Origin/CSRF policy. Dedicated mode keeps the daemon
service bearer in the server process and never forwards it to JavaScript.
Create and cancel carry request and idempotency keys; cancel also carries the
expected draft revision.

A draft resource has an immutable ID, monotonic revision, timestamps, safe spec,
`firstMessageStartsSession: true`, and one state:

```text
draft -> materializing -> live
                      \-> failed
                      \-> indeterminate
draft/materializing -> cancelled (only before prompt submission)
```

`materialization` and public send tickets bind the immutable managed
`sessionId` plus numeric generation. Every ticket also retains the exact
`draftRevision` admitted by its first message, so a later draft revision cannot
be confused with earlier work.

## One atomic private store

`FileDashboardSessionDraftStore` owns draft records, private first-message work,
and public tickets in one owner-only, byte/count-bounded, atomically replaced
state file. Corrupt bounded data is quarantined; insecure permissions fail
closed. Terminal records are retained for bounded reconciliation and then
pruned.

Public resources and tickets never expose the first-message content. Executors
receive it only through the injected private `DashboardSessionDraftStore`
interface. `submitSend` atomically persists:

- message and semantic fingerprint;
- a deterministic target `{sessionId,generation}` derived before side effects;
- immutable admitted draft revision;
- queued public ticket; and
- materializing draft state.

Duplicate keys join the existing ticket; semantic reuse is rejected.

## Crash and cancellation phases

The public ticket remains `queued`/`running` while private work records a finer
monotonic checkpoint:

1. `materializing` — deterministic target exists; no prompt authority crossed.
2. `ready-to-prompt` — managed session identity is durably confirmed.
3. `prompt-submitting` — prompt acceptance may already have crossed.

The materializer updates these checkpoints with compare-and-swap transitions in
the same store. Recovery returns bounded `recoverableTicketIds` for queued,
materializing, and ready-to-prompt work. A running `prompt-submitting` record is
changed to `indeterminate`; it is never blindly replayed.

Cancellation is phase-aware. Queued/materializing/ready-to-prompt work can fail
atomically with `draft_cancelled`. Cancellation racing `prompt-submitting`
becomes `draft_cancel_indeterminate`, because claiming cancellation success
would be dishonest after acceptance may have occurred.

## First send and UI

The runtime gateway consumes the persisted target and work rather than inventing
new identity. Embedded/service delivery uses the normal `Multiplexer` prepared
session policy, verifies that no existing Dashboard or RPC controller conflicts,
advances durably to `prompt-submitting`, and admits the first message through Pi
RPC's preflight boundary. Dedicated Dash delegates the same authenticated service
routes; its daemon bearer remains server-side. A dormant persistent target is
rejoined idempotently. A pre-prompt memory target lost across restart is safely
recreated at the same deterministic identity only after its matching dormant
catalog record is deleted with generation/revision guards.

A definitive preflight rejection fails the ticket and removes the empty managed
session. Unknown failure after `prompt-submitting` is indeterminate and retains
the session for reconciliation. Cancellation or controller conflict before that
boundary fails without a prompt and best-effort removes any empty materialized
session. Materializer construction and draft CRUD perform no Pi/runtime/model or
process work.

The SPA presents a draft as an ordinary empty conversation with a fixed-bottom
composer and inline “first message starts this session” notice. It reuses the
same preview first-send semantics as existing dormant sessions; no blocking
activation modal or second competing state machine is introduced.
