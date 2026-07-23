---
layout: default
title: Pi RPC runtime host
---

# In-process Pi RPC runtime host

Pi Daemon implements the complete Pi 0.80.6 RPC command union against the
resident `AgentSessionRuntime`. It does **not** invoke `runRpcMode()` because that
helper owns process stdin/stdout, signal handlers, child cleanup, backpressure,
and `process.exit`. The daemon controller is transport-neutral: authenticated
WebSocket and stdio bridge layers carry its typed responses and raw events
without creating another Pi process or session state machine.

The executable contract is [`fixtures/pi-rpc-conformance.json`](../fixtures/pi-rpc-conformance.json).
It contains all 31 pinned command types, including `max` thinking, durable entry
cursors, session replacement, and extension UI methods. Compile-time exact-union
checks prevent an SDK upgrade from silently adding or removing commands/events.

## Semantics

- `prompt` responds after Pi preflight accepts, queues, or handles the input;
  later completion/failure is represented by raw Pi events.
- `agent_settled`, `entry_appended`, message/tool lifecycle events, queue changes,
  retry, and compaction events are passed through without translating their Pi
  payload shape.
- state, messages, models, thinking, queue modes, compaction/retry controls,
  session statistics, names, entries/tree cursors, fork/clone/new/switch, and
  command discovery follow stock Pi RPC response shapes.
- new/switch/fork/clone use the hosted runtime replacement seam. Extension/event
  bindings move to `runtime.session`, and the new Pi conversation identity is
  persisted before the command response returns.
- import remains a supported runtime operation even though Pi 0.80.6 does not
  define an `import` member in its stock 31-command RPC union.
- in-place branch navigation remains outside that stock union: the controller
  exposes a bounded direct `navigateTree` method only to the authenticated
  `pi-daemon-rpc.v1` tree-navigation frame used by Dash; summary generation
  still passes through the daemon-wide turn scheduler.

Commands are structurally validated before dispatch. Request IDs, strings,
images, enum values, and the pending extension-UI map are bounded. One output
listener throwing cannot disrupt the runtime or other readers.

## Policy-gated commands

The controller reports typed capabilities. `bash`, `abort_bash`, and
`export_html` are present in the Pi protocol but require explicit host-policy
callbacks. The initial no-tools/no-ambient-filesystem profile returns a normal
Pi RPC failure response for them; it never silently grants process or arbitrary
write authority. A later trusted configuration may enable them through scoped
policy.

## Extension UI

Pi extension dialog methods (`select`, `confirm`, `input`, and `editor`) become
correlated `extension_ui_request` records. Responses resolve only the matching
bounded pending request; cancellation, abort signals, and timeouts return the
stock default. Notification/status/widget/title/editor-text calls are
fire-and-forget outputs. TUI-only component factories and theme switching remain
degraded exactly as in stock headless RPC mode.

## Transport status

This slice supplies the resident controller and capabilities, not an
unbounded stream transport. The additive `/v1/session/{ref}/rpc` attachment
layer must use the bounded serializer, explicit reader/controller roles,
snapshot/live boundary, replay cursor, and gap semantics before advertising
`pi-rpc.v1` on `/v1/capabilities`.
