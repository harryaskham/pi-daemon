---
layout: default
title: Pi SDK compatibility
---

# Pi SDK compatibility policy

Pi Daemon embeds Pi through the public `@earendil-works/pi-coding-agent` SDK. It
does not import Pi source-tree internals and does not run stock `runRpcMode()`
inside hosted sessions: that helper owns process stdin/stdout, signal handlers,
and exit, so it is one-process/one-session infrastructure rather than an
embeddable dispatcher.

## Supported baseline

The current exact baseline is **Pi 0.80.6**. This is the first audited release
for the full host because its public SDK provides:

- `AgentSessionRuntime` and `createAgentSessionRuntime()` for new, switch, fork,
  clone, import, and runtime replacement;
- `createAgentSessionServices()` and `createAgentSessionFromServices()` for
  rebuilding cwd-bound per-session services;
- `AgentSession.isIdle`, `waitForIdle()`, `agent_settled`, and `entry_appended`;
- the current 31-command `RpcCommand` union and `RpcResponse` types;
- the `max` thinking level.

`src/pi-sdk-contract.ts` intentionally compiles the reviewed RPC command and
session-event unions against the installed SDK. An upstream addition/removal is
a deliberate compatibility event, not something dependency automation may land
silently. `fixtures/pi-rpc-command-types.json` is the language-neutral reviewed
command inventory, and `test/pi-sdk-compatibility.test.mjs` exercises real
in-memory `AgentSessionRuntime` replacement without a provider turn.

## Reproducible acquisition

`package.json` pins an exact SDK version and `package-lock.json` pins every
transitive tarball and integrity digest. The project `.npmrc` routes the
`@earendil-works` scope to the public npm registry and disables ambient registry
host rewriting. This matters when an enterprise npm mirror lags the public Pi
release: `npm ci` must consume the reviewed lock rather than silently resolving
an older package from the ambient registry.

Pi 0.80.6's published shrinkwrap omits integrity fields for three nested Pi
workspace packages. npm accepts those records, but Nix's `prefetch-npm-deps`
correctly rejects non-git dependencies without integrity. The checked lock adds
the public registry SHA-512 values for `pi-agent-core`, `pi-ai`, and `pi-tui`.
The compatibility test prevents a later lock regeneration from dropping them.
`flake.nix` selects `npmDepsFetcherVersion = 2` because the older Nix fetcher
does not populate npm's offline cache correctly for those nested shrinkwrap
entries; downgrading the fetcher makes `npm ci` request uncached Pi tarballs.

## Upgrade procedure

1. Read the Pi release notes plus complete SDK, RPC, extension, settings,
   session-format, and security documentation for the candidate version.
2. Confirm the exact package exists independently of the ambient mirror:

   ```console
   npm view @earendil-works/pi-coding-agent@VERSION version dist.integrity \
     --registry=https://registry.npmjs.org
   ```

3. Update the exact dependency and regenerate only from the public registry:

   ```console
   npm install --package-lock-only --ignore-scripts --save-exact \
     @earendil-works/pi-coding-agent@VERSION \
     --registry=https://registry.npmjs.org
   ```

4. Restore any missing published nested-package integrity fields from each
   package's `npm view ... dist.integrity` output. Run `npm ci --ignore-scripts`;
   the Pi lock-integrity compatibility test must pass.
5. Update `PI_SDK_COMPATIBILITY_VERSION`, the RPC command fixture, required event
   mapping, protocol thinking levels, and compatibility assertions together.
   Review every union difference; never weaken the exact assertion merely to
   make compilation pass.
6. Keep `npmDepsFetcherVersion = 2`, refresh `flake.nix` `npmDepsHash` from the
   fixed-output mismatch, and run the focused SDK compatibility test. The
   repository's final queue/CI then owns the complete Node and Nix gates.
7. When provider/session behavior changed, run the optional credentialed live
   multiplex acceptance and preserve the zero-Pi-child-process assertion.

## Runtime policy

Each logical host slot uses `AgentSessionRuntime`. Runtime replacement recreates
locked cwd-bound services, rebinds extension/session listeners to
`runtime.session`, and durably records the new Pi ID/file before returning; stale
`AgentSession`, `SessionManager`, resource loader, or extension objects do not
survive a replacement. If rebinding or identity persistence fails, the adapter
remains invalidated rather than serving the disposed conversation. The raw
`/rpc` surface preserves Pi command/event shapes, but a daemon-owned
transport-neutral controller performs dispatch and routing.

Per-session configuration is a snapshot built from supported public SDK inputs.
The default `unisolated` mode does not promise independent `process.env`, cwd,
module globals, provider registries, or arbitrary extension code inside one Node
heap. Never swap process-wide env/cwd around concurrent turns. Provider secrets
use scoped auth data where supported, tool env uses scoped operations/spawn
hooks, and raw secrets are not persisted in daemon manifests.

## Rollback

Rollback means reverting the exact SDK version, lockfile, compatibility version
and command fixture, event/thinking mappings, and Nix dependency hash in one
change. Do not float a semver range or move a published Pi Daemon tag. Durable
Pi session files must remain readable by the rollback version; if Pi changed its
session format incompatibly, stop admission and require an explicit migration
or forward fix rather than opening files with an unverified older SDK.
