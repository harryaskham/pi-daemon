# Session summary — bounded recovery, shutdown, and truthful readiness

## Goal

Make startup/recovery, health/probe, idle maintenance, and signal shutdown bounded and truthful. Preserve exact Pi identity and ticket semantics while integrating the landed full per-session configuration and RPC layers, without exposing private paths, auth errors, credentials, prompts, or results.

## Bead(s)

- `bd-1877d3` — bound recovery and shutdown and make readiness truthful.
- Parent: `bd-55ab9e` — deliver the full standalone Pi session host API.

## Before state

- Failing tests: none on main.
- Relevant metrics: 116 tests after RPC/configuration landed. Startup awaited every queued model turn before listening but set the internal ready bit before per-session recovery completed. Host status did not retain recovery failures/indeterminate counters. Probe returned 0 for any successful handshake and had no response deadline. Auth readiness destructively drained errors and exposed `agentDir`/raw messages. Idle sweep promises could reject unhandled; adapter/extension disposal and signal shutdown could hang beyond the advertised deadline.
- Context: durable ticket/configuration/RPC foundations were complete, including exact conversation identity and memory-only env policy, but their recovery state was not unified into host readiness.

## After state

- Failing tests: none.
- Relevant metrics: full npm and Nix gates pass 117/117. Durable manifest/catalog/journal/ticket recovery is bounded by count, record/file bytes, and 256 MiB aggregate input; runtime opens default to 30 seconds each and 120 seconds total. Adapter disposal defaults to five seconds. Probe defaults to five seconds and exits 75 for a successful degraded/recovering handshake. Terminal/indeterminate mutation and wake reconciliation updates live health counters.
- Context: exact session opens remain synchronous and deadline-bounded; queued wake and mutation execution is backgrounded while transports listen. Public readiness remains false through pending replay, provider/model unavailability, recovery failures, or indeterminate work. Full persisted runtime configuration is reconstructed on restart, legacy catalog/tickets migrate safely, raw environment values remain volatile, and missing overlays fail `credentials_required`.

## Diff summary

- Code/content commit: `fad42db`
- Summary artefact commit: intentionally omitted; this file must not self-reference its own mutable SHA.
- Files touched: Multiplexer recovery/health/open/disposal, CLI lifecycle/probe/shutdown/fatal handling, bounded client requests, Pi readiness and cancellation, durability/catalog/ticket recovery bounds, API prepared configuration/ticket recovery health, docs/README/PLAN/changelog, and focused tests.
- Tests: full Node suite 117/117 green; Nix flake check/package/install also passes 117/117. The first Nix attempt hit one transient loopback `EADDRNOTAVAIL` under parallel tests; a bounded retry for transient local connect exhaustion was added and the authoritative rerun passed.
- Behavioural delta: listening and ready are distinct; degraded state is durable and redacted; recovery no longer waits for model completion; retries/reconciliation can restore readiness; provider outage is probe-visible; hung sessions/extensions cannot block sweep or whole-process shutdown; fatal logs omit private roots.

## Operator-takeaway

Pi Daemon now starts and stops on explicit deadlines and tells the truth about whether it is merely listening, still recovering, degraded, or fully ready. Health is safe to expose operationally, every retained state family has count/byte bounds, queued work continues in the background, and the configuration/ticket handoff preserves only secret-free policy and environment summaries.
