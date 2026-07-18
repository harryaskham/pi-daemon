# Schedule resource contract v1

Pi Daemon defines a transport-neutral, per-session schedule resource before it
implements timer execution. The published TypeScript contract is
`@harryaskham/pi-daemon/schedule-contract`; the language-neutral contract is
[`schedule.schema.json`](../schedule.schema.json). `timerRuntime: false` is
normative in this slice: storing a resource does **not** arrange a wake.

## Resource and updates

A schedule has an immutable `scheduleId` and `sessionRef`, a monotonically
increasing `revision`, `enabled`, a five-field cron expression, IANA timezone,
prompt, policies, and UTC trigger bookkeeping. Create starts at revision zero.
A full replacement supplies the current expected revision; update and delete
fail with `revision_conflict` when it differs. This is optimistic concurrency,
not last-writer-wins. A session rename does not rewrite `sessionRef`; callers
should use an immutable daemon session ID where possible.

The accepted cron grammar is numeric POSIX five-field syntax:

```text
minute hour day-of-month month day-of-week
```

Each field accepts `*`, numbers, ascending ranges, comma lists, and `/step`.
Minute is 0–59, hour 0–23, day-of-month 1–31, month 1–12, and day-of-week 0–7
(where 0 and 7 are Sunday). Names, seconds, `?`, `L`, `W`, and macros such as
`@daily` are rejected. As in POSIX cron, when both day-of-month and day-of-week
are restricted, either matching field selects the local date.

`timezone` is checked against the host runtime's IANA database. A deployment
must expose that database/version operationally if reproducibility across hosts
matters. Fixed numeric offsets are not timezone names.

## Policies

- `overlapPolicy: skip` records a skipped occurrence while another turn is
  active.
- `queue-one` retains at most one coalesced pending occurrence. It never creates
  an unbounded queue.
- `reject` records a rejected occurrence for callers that treat overlap as an
  operational error.
- `missedWakePolicy: skip` advances without submission after downtime.
- `run-once` coalesces all missed occurrences into one admission attempt.
- `bounded-catch-up` attempts at most `maxRuns` (globally capped at 24), oldest
  first. Additional occurrences are skipped.

Jitter is a non-negative delay selected in `[0, jitterMs]`; it never advances a
wake. `maxAdmissionDelayMs` is measured from the scheduled UTC instant. Once
that deadline has elapsed, the occurrence follows missed-wake policy rather
than being silently submitted late. The timer implementation must define a
stable randomization source so restart does not repeatedly redraw jitter. No
such implementation exists in this contract slice.

## Clock and daylight-saving semantics

Cron is evaluated against civil time in `timezone`; all persisted instants are
UTC RFC 3339 values. `nextTriggerAt` is the next selected UTC instant.
`lastTrigger.scheduledFor` is the selected instant and `observedAt` is when the
host noticed it. Wall-clock jumps do not use elapsed monotonic time to invent
cron occurrences. Durations and admission deadlines should use a monotonic
clock while a process is alive, anchored to the selected UTC instant.

Examples for `30 1 * * *` in `Europe/London`:

- On the spring-forward date, a nonexistent local time has no occurrence and is
  not itself a missed wake.
- On the autumn rollback date, 01:30 occurs twice. Both UTC instants are valid
  occurrences, ordered by UTC. Overlap and catch-up bounds still apply.

Examples for `30 2 * * *` in `America/New_York` follow the same rule: the spring
02:30 gap produces no occurrence, while a repeated local time produces two.
Timezone database rule changes may alter future `nextTriggerAt`; recovery must
recompute future values but retain historical UTC instants.

## Content, secrets, and summaries

`prompt` is persisted because it is the scheduled work definition, but it is
**sensitive content**. Files are owner-only (`0700` directories, `0600` files).
Prompts must not appear in logs, metrics, capability responses, list summaries,
or error text. The store is not encrypted; operators should not place reusable
credentials, bearer tokens, API keys, or environment values in prompts.
Schedule resources have no environment or credential fields. Runtime credentials
come from the referenced session's existing provisioned configuration.

`lastTrigger.terminalTicket` is intentionally content-free: ticket ID, terminal
state (`completed`, `failed`, or `indeterminate`), update time, and an optional
bounded machine error code. It never embeds model output, prompt text, provider
errors, stack traces, or request payloads. `indeterminate` must never be blindly
replayed after a crash.

## Persistence and recovery

`FileScheduleStore` writes one atomically published envelope per resource under
`state/schedules/v1/<scheduleId>.json`. Each envelope has `formatVersion: 1` and
the contract resource. Recovery is bounded by record/count/aggregate byte
limits, validates every field, rejects insecure permissions and symlinks, and
quarantines malformed or unsupported files with a `.corrupt-...` suffix.
Recovery does not submit, catch up, or start timers. Exceeding global or
per-session capacity fails closed rather than partially scheduling resources.

Default negotiated limits are published in `scheduleCapabilities()`. Servers
may lower them, and clients must use the effective capability values.
