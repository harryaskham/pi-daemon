# Session summary — multi-instance Home Manager services

## Goal

Expose Pi Daemon as a reusable declarative Home Manager service, modeled on Cacophony's native lifecycle surface, without colliding with Cacophony or another Pi Daemon instance. Support Linux systemd user units, Darwin launchd agents, and conditional nix-on-droid supervisord programs with explicit paths, roots, ports, credentials, and service identities.

## Bead(s)

- `bd-691be8` — Add Home Manager service module for Pi Daemon.
- Dependency landed during this slice: `bd-68e03a` high-level CLI/repeatable allow roots at `1af0875`.
- Related follow-ups filed: `bd-cb42b4` strong isolation backend; `bd-71cfa2` Pages quickstart.

## Before state

- The flake exported packages/apps/checks only. Operators could run `pi-daemon serve` manually but had no declarative systemd/launchd/supervisord integration.
- The CLI accepted one workload root, and there was no first-party high-level session management CLI.
- Session-level security remained truthfully `unisolated`; separate daemon processes had to be assembled manually for stronger trust-domain separation.

## After state

- `homeManagerModules.default` and `homeManagerModules.pi-daemon` are exported.
- `services.pi-daemon.instances.<name>` manages any number of independently named services with configurable `stateDir`, `socketPath`, `agentDir`, `allowedRoots`, non-secret environment, logs, restart delay, API bind/port/token-file policy, and bounded extra arguments.
- Native identities are collision-free: `pi-daemon-<name>.service`, `com.pi-daemon.<name>`, and supervisord `pi-daemon-<name>`.
- The module creates owner-private state/agent/socket/log directories, installs the package, keeps bearer bytes out of Nix/argv, requires explicit roots, and rejects unsafe names, duplicate state/socket/log/API-port assignments, missing API token files, and overrides of module-managed identity/path/API arguments.
- Linux uses a foreground systemd user service, Darwin uses a KeepAlive launchd agent, and nix-on-droid emits supervisord programs only when that option surface exists.
- Documentation includes a copy/paste Home Manager service example and native status commands. The parallel high-level CLI and Pages quickstart cover operational session/RPC/ACP management.

## Diff summary

- Source commits: `b7418eb`, `8250e41`, `331b9d9`.
- Summary artefact commit: intentionally omitted; this file must not self-reference its own mutable SHA.
- Validation: full npm `154/154`; full local `nix flake check` package/pages/module checks, install, and install checks passed; Darwin module derivation built; all four supported systems evaluate under `nix flake check --no-build --all-systems`; Linux systemd and conditional supervisord plus Darwin launchd shapes are forced by the module check.

## Operator takeaway

Pi Daemon can now be installed once and run as multiple non-colliding user services with separate state, sockets, API ports, Pi agent directories, roots, logs, and token files. Multiple service instances are separate OS processes/trust domains; sessions inside one instance still intentionally advertise only `isolation.mode = "unisolated"`.
