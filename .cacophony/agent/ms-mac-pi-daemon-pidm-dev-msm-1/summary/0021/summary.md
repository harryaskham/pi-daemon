# Session summary — isolate credential-degraded retained sessions

## Goal

Restore native Pi-Daemon agent admission on ms-mac when deleted or stale retained sessions require memory-only credential/tool-adapter reprovisioning. Those per-session conditions must remain visible and fail closed for their own generation without marking the entire healthy host unready.

## Bead(s)

- `bd-cf2802` — Keep Pi Daemon ready when stale retained sessions need reprovisioning.
- Cross-project collaborators: Cacophony `bd-0fd58f` owns scoped MCP token refresh/rebind and pending-turn recovery; `bd-3a0a4e` owns operator interrupt/stop/decommission UI.

## Before state

- ms-mac Pi Daemon 0.3.2 was reachable, not draining, adapter/model ready with 481 models and zero pending mutations/replays/indeterminates.
- Five retained configured sessions failed restart recovery with `credentials_required`; four older adapter sessions were quarantined `tool_adapter_reprovision_required`.
- Recovery phase became `degraded`, and `status.ready` required phase `ready`, so every unrelated new configured session was rejected `pi_daemon_host_not_ready`.
- Operators had deleted the original stale Cacophony agents; no new agent could be admitted despite healthy process-global infrastructure.

## After state

- A retained configured session missing memory-only credentials is now placed in typed `credentials_required` / `reprovision_required` quarantine rather than the global recovery failure list.
- Catalog recovery schema accepts that bounded nonsecret code.
- Recovery remains `ready` when only per-session reprovision quarantines exist, while the affected session remains dormant and explicitly annotated.
- A new healthy configured session can open independently; credentials are not replayed, fabricated or weakened.
- Genuine recovery failures, accepted/indeterminate work and mutation recovery failures retain existing global degraded behavior.

## Diff summary

- Commit: `3d85ee8` — `bd-cf2802: isolate credential-degraded sessions`.
- Files: `src/multiplexer.ts`, `src/session-api.ts`, `src/session-catalog.ts`, `test/session-catalog.test.mjs`.
- Validation: exact lock refresh via `npm ci --ignore-scripts`; strict TypeScript build; targeted credential-degraded recovery test 1/1 passed; `git diff --check` passed.
- Hosted required CI owns final validation.

## Operator-takeaway

Stale retained conversations no longer have to be deleted to recover host admission. They stay quarantined and recoverable, while healthy new configured agents can start. This removes the host-wide deadlock without compromising credentials or replay safety.
