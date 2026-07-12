# Pi Daemon agent contract

## Product boundary

Pi Daemon is a standalone, general-purpose Node service around the supported
`@earendil-works/pi-coding-agent` SDK. It must never import or model Cacophony
beads, messages, profiles, tokens, daemon state, or lifecycle internals.
Cacophony is a client, not a dependency.

## Source of truth

- `PLAN.md` is the architecture and provisional work board.
- `README.md` is the user-facing overview.
- `docs/` is the published protocol/security/operations surface.
- Protocol changes require fixtures, compatibility tests, and documentation.

## Implementation rules

- Node >=22.19 and strict TypeScript.
- Pin the Pi SDK and every npm dependency in `package-lock.json`.
- No child process creation in the initial no-tools session/wake path.
- No arbitrary extensions, bash, read, write, or ambient filesystem authority.
- Never log prompts, model output, credentials, environment values, or tokens by
  default.
- Bound line sizes, queues, sessions, turns, retained results, and shutdown.
- Preserve per-session isolation; sharing auth/model registries does not permit
  sharing SessionManager, settings, cwd, events, or idempotency state.
- Durable acceptance is explicit: queued, accepted, completed, failed, or
  indeterminate. Never blind-replay an accepted request after a crash.

## Workflow

1. Keep the provisional `PLAN.md` Beads section current.
2. Make incremental commits referencing `PD-...` lines.
3. Run focused Node tests while developing; `npm test` and `nix flake check` are
   final repository gates.
4. Direct pushes to `main` are temporarily operator-authorized for the sole
   bootstrap owner. Preserve clean history and never force-push.
5. Do not weaken tests or security policy to make a slice pass.

## Security

A shared Node process is one trust domain. Do not load unreviewed project
extensions into it. The initial service is no-tools by default and uses
canonical root checks, owner-only Unix sockets, redacted logs, and explicit
resource policy. Report any path traversal, cross-session leakage, secret
exposure, duplicate-turn, or unbounded-memory finding before continuing.
