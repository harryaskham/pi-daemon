# Session summary — full in-process Pi RPC runtime host

## Goal

Replace the narrow daemon adapter surface with the complete supported Pi 0.80.6 RPC command/event/UI semantics while keeping the implementation in-process, transport-neutral, bounded, policy-aware, and attached to the same durable `AgentSessionRuntime` used by every other control mode.

## Bead(s)

- `bd-0052e2` — Host the full supported Pi RPC surface on `AgentSessionRuntime`.
- Parent: `bd-55ab9e` — Deliver the full standalone Pi session host API.

## Before state

- The adapter exposed only daemon prompt, steer, follow-up, and abort operations.
- Stock `runRpcMode()` could not be embedded because it owns stdin/stdout, process signal handlers, backpressure, child cleanup, and `process.exit`.
- No resident controller implemented Pi model/thinking/state/messages/compaction/retry/session/tree/name/UI commands or raw settled-era events.
- Bash/export policy, command validation, extension UI rendezvous, and exact RPC capabilities were absent.
- The integrated ticket/config/output-bound tree had 100 tests before final config reconciliation.

## After state

- `src/pi-rpc-controller.ts` implements all 31 pinned Pi 0.80.6 commands and exact stock response shapes without owning a process transport. The controller passes through raw Pi events including `agent_settled` and `entry_appended`.
- Prompt responses occur at Pi preflight acceptance. State/messages/models/max-thinking/queue modes/compaction/retry/stats/naming/new/switch/fork/clone/entries/tree/cursors/commands are implemented and conformance-tested.
- Runtime replacement continues through the durable adapter seam, rebinds extension/session listeners, and persists changed Pi identity before responding. Import remains available on the runtime even though it is not a member of Pi's stock 31-command union.
- Extension select/confirm/input/editor requests are correlated and bounded; notification/status/widget/title/editor-text outputs are routed. Pending UI requests and output listeners have explicit capacities, cancellation, timeout, and reader-failure containment.
- Malformed commands, fields, images, enums, and cursors return correlated failures before SDK dispatch. Error strings are capped and bearer/key/token/secret/password patterns are redacted.
- Bash, abort-bash, and HTML export are typed policy gates. Trusted configured sessions can execute RPC bash with their scoped child environment and shell settings; no-tools sessions fail normally. `process.env` is never mutated.
- Each real adapter creates one controller during session construction, avoiding late attach races and duplicate extension-start binding; runtime replacement reuses it. Multiplexer resolves resident controllers by exact ID/name and generation and persists RPC-driven names to catalog/manifests. Dormant sessions require explicit reopen.
- Typed discovery is exported through `PI_RPC_HOST_CAPABILITIES`; executable fixtures live in `fixtures/pi-rpc-conformance.json`; documentation is in `docs/pi-rpc-host.md`.
- Failing tests: none. `npm test` passes 105/105 on the final config/ticket/output-bound integrated tree. `nix flake check --no-build` evaluates all current derivations.

## Diff summary

- Implementation commits before squash: `cef3725` (controller), `cecba19` (contract/docs), `a3c7fd5` (resident binding/catalog naming), and `ca558bc` (configured bash policy and final permission fixture).
- Summary artefact commit: intentionally omitted; this file must not self-reference its mutable commit SHA.
- Main files: `src/pi-rpc-controller.ts`, `src/pi-adapter.ts`, `src/multiplexer.ts`, `fixtures/pi-rpc-conformance.json`, and focused adapter/controller/catalog/runtime tests.
- Package root exports the controller and declarations; npm pack checks require both artifacts.
- The `/rpc` WebSocket transport is intentionally still unadvertised: `bd-509428` owns bounded multi-reader snapshot/replay attachment over this now-complete controller.

## Operator-takeaway

Pi Daemon now has the full stock Pi RPC runtime semantics in-process, without spawning `pi --mode rpc` or surrendering process lifecycle control. The remaining RPC work is transport attachment and replay—not command/runtime implementation.
