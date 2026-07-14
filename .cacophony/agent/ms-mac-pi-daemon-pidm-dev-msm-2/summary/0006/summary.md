# Session summary — Full standalone host acceptance

## Goal

Prove the completed Pi Daemon product across configured CRUD, real Pi turns, multi-reader RPC, ACP, stdio bridge, restart/replay, retained-state lifecycle, installation, security boundaries, and zero per-session/wake child processes.

## Bead(s)

- `bd-a4954f` — Prove full daemon host acceptance across CRUD, RPC, restart, and install
- Parent pending authoritative acceptance landing: `bd-55ab9e`

## Before state

- Individual protocol, durability, runtime, attach, ACP, bridge, package, and security suites were green, but no one lifecycle exercised the actual production seams together.
- The acceptance report still described the original no-tools scaffold and an old optional live-provider run.
- Pi RPC and ACP prompts called `AgentSession.prompt()` directly through controllers, bypassing the multiplexer-wide turn semaphore used by NDJSON wakes.

## Product finding and fix

The new real-runtime harness exposed a release-blocking resource-policy bug: two Pi RPC sessions could run model turns concurrently even when `maxConcurrentTurns` was 1. The controller now accepts a transport-neutral prompt scheduler; `Multiplexer.rpcController()` injects the shared semaphore. The controller still returns at Pi preflight acceptance but retains capacity until the model turn settles. Abort signals remove a queued controller prompt before it can start later. Focused tests cover both settlement-held capacity and queued abort.

## Full acceptance

`test/full-host-acceptance.test.mjs` dynamically loads the production host after patching every Node child-process entry point. It starts a deterministic IPv6-loopback OpenAI-compatible stream and one real bearer-authenticated host with production Pi SDK runtime, catalog, durability, mutation tickets, RPC hubs, ACP, and bridge.

The lifecycle proves:

- unauthorized HTTP, out-of-root cwd, unapproved packages, and denied ambient extension discovery;
- two differently configured sessions and durable REST ticket completion;
- controller/observer RPC isolation, private responses, real model streaming, cross-session event isolation, and global turn cap;
- Pi new, switch, fork, state, entries, and conversation identity transitions;
- cursor disconnect/reconnect and replay;
- ACP initialize/load on the same runtime;
- bounded remote stock-Pi JSONL bridge;
- real host restart with a host-identity replay gap and exact persistent conversation reopen;
- queued wake replay versus accepted wake indeterminate state;
- dormant env-dependent memory session, explicit reprovision/update, and retained-state deletion;
- no raw environment value or service bearer in durable state; and
- zero child-process calls through create, wake, RPC, ACP, bridge, and restart.

## Diff summary

- Code/content commit: `36dc840`
- Summary artefact commit: intentionally omitted; this file must not self-reference its own mutable SHA
- Files: `test/full-host-acceptance.test.mjs`, shared RPC scheduler/abort tests and implementation, `docs/acceptance.md`, README/PLAN/changelog release-candidate status
- Focused gate: 8/8 acceptance/controller tests
- Full Node gate: 143/143 passing in 16.0 seconds
- Full Nix gate: `nix flake check --print-build-logs` built the tracked package, ran 143/143, completed package install/fixup, and exited successfully
- Host mitigation: all new end-to-end loopback listeners use `::1`; Nix used the existing `http://127.0.0.1:54694` proxy because unrelated Tailscale IPv4 `CLOSE_WAIT` exhaustion remained on the operator host

## Operator takeaway

The repository now has a credential-free, real-SDK, one-host release acceptance—not only unit composition. All final npm and Nix gates pass, and the only product defect found by that acceptance (cross-control-plane turn-cap bypass) is fixed without weakening tests or isolation claims.
