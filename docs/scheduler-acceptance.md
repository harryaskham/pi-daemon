---
title: Scheduler acceptance and accuracy
---

# Scheduler acceptance and accuracy

This is the release-gate receipt for the native v1 per-session scheduler. The
candidate runs `SchedulerRuntime` in the normal `pi-daemon serve` lifecycle,
uses the same durable wake journal as API clients, and reports
`timerRuntime: true`. External systemd/launchd timer clients remain supported.

## Measured clock and timezone gate

The deterministic acceptance clock produced zero timing error for 200
consecutive minute boundaries: 199–200 expected admissions (the range depends
only on whether the initial boundary is selected), at most one armed timer,
zero retained active admissions, and zero queued overlaps after settlement.
The timer wake is only a hint; every decision rereads wall time.

The runtime's complete ICU timezone inventory was exercised on Node's 418 IANA
zones. For every zone, bounded cron searches around both the March and October
DST seasons produced strictly ordered UTC instants. Explicit Europe/London
fixtures prove that nonexistent 01:30 is skipped and repeated 01:30 is selected
twice, in UTC order. The complete scheduler test took 17.61 seconds on the
acceptance host; the all-zone DST portion took 13.40 seconds and the accelerated
200-minute soak took 3.61 seconds.

A backward wall-clock/restart fixture records the selected instant, moves the
clock behind it, reconstructs the runtime, and proves no second admission. The
durable `lastTrigger.scheduledFor` is the lower bound when future state is
recomputed, preventing a clock correction from repeating decided work.

## Durability and policy matrix

Automated acceptance covers:

- crash after the conservative decision is persisted but before an admission
  response; restart advances and never blind-replays possibly accepted work;
- queued/running settlement tracking plus completed, failed, and indeterminate
  content-free terminal summaries;
- stable restart-safe jitter and admission-delay handling;
- downtime `skip`, `run-once`, and oldest-first bounded catch-up (maximum 24);
- overlap `skip`, `reject`, and one coalesced queued occurrence, with no
  concurrent same-session scheduler turn;
- disabled and deleted schedules, deleted sessions, and sessions that cannot be
  safely reprovisioned failing closed;
- dormant durable sessions being hydrated through the normal retained-session
  policy before admission, without a separate runtime or process;
- malformed, oversized, unsupported, symlinked, and insecurely permissioned
  schedule records being rejected or quarantined under aggregate recovery
  bounds; and
- shutdown stopping timer admission before draining already accepted work.

The accelerated soak continuously rewrites one bounded resource rather than
retaining per-occurrence objects. Timer count stays at one, overlap state
returns to zero, terminal settlement promises are removed, and the store stays
at one resource. This is the deterministic heap-growth gate; the repository's
separate rolling Dash wall-clock soak remains documented in
[Dash acceptance](dashboard-acceptance.md).

## API, Dash, compatibility, and secrecy

Authenticated service capabilities, schedule status, and both embedded and
dedicated Dash now expose the native timer capability and authoritative next
wake. Every API or embedded Dash mutation synchronously asks the timer owner to
recompute; returned revisions/ETags reflect runtime bookkeeping. Older daemons
that omit schedule capabilities still degrade to the typed
`schedules_unavailable` state without probing private routes.

Browser resources never include prompt text. Live acceptance on the rolling
loopback BFF at port 7474 created a temporary memory session, resolved it through
real inventory, and rendered the capability-gated information-pane Scheduler
editor through an authenticated cookie. The empty editor exposed the complete
cron/timezone/prompt/policy form without a service bearer and the session was
then deleted without submitting a prompt. Dash unit/server acceptance covers
create/edit/enable/disable, validation, dark-magenta countdowns, terminal
history, dormant/running colors, and independent unread attention. Service and
web bearers, prompt text, model output, provider errors, environment values,
and ticket payloads remain absent from status and logs.

Release gates are `npm test`, clean npm package/import and installed module
exports, Pi SDK compatibility, Nix package/site/Home Manager checks, and
`nix flake check`. No release tag is cut automatically.
