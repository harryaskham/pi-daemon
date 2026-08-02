---
layout: default
title: Operations
---

# Operations

## Development shell

```console
nix develop github:harryaskham/pi-daemon
npm ci --ignore-scripts
npm test
```

## User-local release updates

A release-managed install can advance independently of a full nix-darwin or
Home Manager rebuild:

```console
pi-daemon self-update status
pi-daemon self-update check
pi-daemon update
```

`update` is shorthand for `self-update run`. It reads GitHub's latest release,
downloads the published npm artifact and SHA-256 sidecar, verifies both the
release checksum and the artifact's exact `npm-shrinkwrap.json` integrity, and
runs npm with lifecycle scripts disabled. Versions live under the owner-private
`~/.local/share/pi-daemon/versions/`; `current` and
`~/.local/bin/pi-daemon` are switched atomically. Existing non-managed files or
symlinks at that bin path fail closed. The command never restarts services or
moves daemon state, credentials, sockets, or workspaces.

For Home Manager services, opt into the stable mutable-runtime shim once:

```nix
services.pi-daemon.mutableRuntime.enable = true;
home.sessionPath = [ "$HOME/.local/bin" ]; # makes the same managed CLI win interactively
```

After activating, `type -a pi-daemon` should list
`~/.local/bin/pi-daemon`; a pre-existing shell may need `rehash` (zsh) or
`hash -r` (bash). The service launcher itself uses the exact configured path and
does not depend on interactive PATH ordering.

That one declarative activation installs a Nix-store launcher which chooses the
executable owner-local `~/.local/bin/pi-daemon` when present and always retains
the configured immutable package as fallback. Subsequent release updates need
no system rebuild; explicitly restart the selected service after reviewing the
new version, for example:

```console
launchctl kickstart -k "gui/$UID/com.pi-daemon.work"   # macOS
systemctl --user restart pi-daemon-work                 # Linux
```

Use `pi-daemon self-update rollback` and restart to atomically select the one
retained previous release. `status` is offline; `check` and `run` require public
GitHub plus `npm` on `PATH`. Custom test/install roots are available through
`--install-root` and `--bin-dir`; production services should use the defaults.

## Serve

Native schedules start with `serve` after catalog/import recovery and before
the authenticated API is published. Schedule CRUD recomputes the single
bounded timer owner immediately. During shutdown, new timer admission stops
before accepted turns drain. Operators can inspect content-free state with
`pi-daemon schedule status`; prompt definitions remain in owner-only files and
should be supplied through `--file`/`--prompt-file`, never argv. See
[Schedules](schedules.md) and the [accuracy receipt](scheduler-acceptance.md).
External timers remain valid API clients and should use unique idempotency keys.

Choose non-overlapping daemon state, Pi agent, and allowed workload roots.
Repeat `--allow-root PATH` for each canonical root. Workload roots must already
exist because they are explicit authority grants. The daemon creates absent
private state, socket-parent, and agent directories before constructing the Pi
runtime.

```console
pi-daemon serve \
  --socket "$XDG_RUNTIME_DIR/pi-daemon.sock" \
  --state-dir "$HOME/.local/state/pi-daemon" \
  --agent-dir "$HOME/.pi/agent" \
  --allow-root "$HOME/work"
```

### Instance YAML configuration

Flag-only startup remains supported. The equivalent bounded YAML convention is:

```text
~/.config/pi/daemon/<instance>/config.yaml
```

`--config PATH` selects a file first, then `PI_DAEMON_CONFIG`; otherwise the
validated `--instance` / `PI_DAEMON_INSTANCE` / `default` name selects the path
above. A missing implicit default file preserves flag-only behavior, while a
missing explicitly selected file is an error. Individual CLI options override
YAML fields.

```yaml
instance: work
stateDir: ~/.local/state/pi-daemon/work
socketPath: ~/.local/state/pi-daemon/work/run/pi-daemon.sock
agentDir: ~/.pi/agent
allowedRoots:
  - ~/work
sessionStorage:
  mode: pi-session-root
limits:
  maxSessions: 32
  maxConcurrentTurns: 4
  idleSessionTtlMs: 1800000
api:
  enabled: true
  bind: 127.0.0.1
  port: 17463
  tokenFile: ~/.config/pi/daemon/work/api-token
web:
  enabled: true
  mode: embedded
  bind: 127.0.0.1
  port: 17464
  tui:
    enabled: true
    defaultPresentation: rich
    maxRows: 200
    maxColumns: 320
  runtimePolicy:
    # Used only when an activated source has no model/thinking selection.
    model:
      provider: github-copilot
      id: gpt-5.6-sol
      thinkingLevel: high
    tools:
      mode: allowlist
      include: [self_set_model]
    resources:
      # Select the reviewed extension module, not the ambient/global package.
      extensions:
        - /opt/pi-extensions/agent-utils/m.js
      projectTrust: approve
      noContextFiles: true
      # Pi CLI owns installation/update; daemon resolves existing global installs only.
      inheritInstalledPackages: true
    settings:
      agentUtils: { modelShortcut: true }
  sessionDefaults:
    cwd: ~
    piSettingsFile: ~/.pi/agent/settings.json
    inheritRuntimePolicy: true
  ui:
    theme: { name: nord-midnight }
```

For a mutually trusted, single-user daemon, the most permissive supported
profile is `tools.mode: default`, `resources.projectTrust: approve`, all five
`no*` resource flags set to `false`, and
`sessionDefaults.inheritRuntimePolicy: true`. Point
`sessionDefaults.piSettingsFile` at `~/.pi/agent/settings.json` and set the
instance `agentDir` to `~/.pi/agent` when normal user extensions, skills,
prompts, and themes should be discoverable. Set
`runtimePolicy.resources.inheritInstalledPackages: true` to load the global Pi
package declarations from that agent directory. This explicitly grants
shared-process authority: every enabled tool or extension can reach the daemon
process and other mutually trusted sessions.

Pi Daemon remains a package **consumer**, never an installer. It reads a bounded,
owner-controlled `AGENT_DIR/settings.json`, validates at most 128 global package
declarations and their filters, requires every npm/git/local package to already
exist in Pi's managed cache, then applies the package manifest/filter to bounded
extension, skill, prompt, and theme paths. Missing packages or invalid resources
fail activation with a content-free error telling the operator to use `pi
install`/`pi update --extensions`; Pi Daemon consumes the installed checkout and
does not reconcile its version/ref. This path invokes no package-manager command,
child process, update, reconciliation, or network request. Project-local package
declarations are not inherited. `settings.packages` remains prohibited inside
daemon YAML; the boolean authority flag is the only supported bridge to Pi's
installed global package set.

Relative YAML paths resolve from the configuration file; `~/` resolves from the
service home. The file is byte/depth/property bounded, rejects duplicate or
unknown service fields and YAML alias expansion, and must resolve to a regular
current-user/root-owned file that is not group/world writable. Home Manager
symlinks to immutable Nix-store targets are supported.

That root exemption is policy, not an accident, and it is not uniform. Paths
holding material the system provisions *for* the service accept a
current-user or root owner: configuration, TLS material, installed package
resources, and session defaults, where a root-owned Nix store path or system
file is a normal deployment. Paths holding material the service owns as its
own secret accept the current user only: the API bearer token, the Pi auth
seed, Dashboard credentials and descriptors, the authorization store, and
durable session state. A root-owned secret is not a deployment shape; it means
something else wrote it. `test/path-ownership.test.mjs` pins which modules
apply which policy, so a change to that split is a visible diff.

Mode is a second axis rather than the same policy restated. Ownership answers
who may have authored the material; mode answers who else may read or write it.
Secrets require both strict — owner-only and `0o077`. Provisioned configuration
relaxes the owner and keeps the writer strict — current-user-or-root and
`0o022`. Session state does the opposite, requiring the current user to have
written the path while tolerating that others may read it, which is why the two
axes cannot be derived from one another. A third shape carries no mode at all:
checks deciding authority to *act* on a path, such as refusing to replace a
socket the process does not own or skipping foreign entries during a scan, take
no view on who may read it. Configuration contains
only non-secret values and secret **paths**: literal tokens, passwords, bearers,
and API keys are rejected from the forward-compatible `web.ui` map. Runtime web
preferences are a separate allowlisted overlay under `STATE_DIR/web`; they
cannot change bind/auth/root/credential/resource authority. `web.runtimePolicy`
is the only Dashboard activation resource authority: it is read from the
owner-controlled service configuration, rejects literal secret-bearing fields,
and accepts only the bounded session model/tool/resource/settings subset. It is
not writable from the browser. Reviewed `git:`/`npm:` package references may appear in explicit resource
lists, but they select every matching package resource; prefer absolute paths to
individual reviewed modules when a package contains unrelated tools. Filesystem
extension/skill/template/theme paths must be absolute. `settings.packages` is
rejected on this shared-host surface so
it cannot re-enable ambient package discovery. With no policy, activation remains no-tools and loads no ambient extensions,
packages, context files, or project resources. Optional `web.sessionDefaults`
can select a canonical default cwd, read only provider/model/thinking defaults
from one owner-controlled bounded Pi settings JSON file, and copy the effective
runtime policy into browser-safe lazy-draft defaults. The settings path and all
unrelated settings/package values stay server-side. `inheritRuntimePolicy`
requires an explicit policy; draft creation and restart-time materialization
both reject any browser policy above it. A direct or
fork activation first restores the latest model and thinking level on the
source session's active branch; the configured model is a fallback for sources
without those entries. `sessionStorage` is used by the ownership service. A
present, enabled `web` block in `embedded` mode
starts the packaged browser BFF with the in-process backend; omitting the block
preserves the socket/API-only service lifecycle. Dedicated mode runs as a
separate `pi-daemon web` process over the authenticated neutral API and uses an
independent browser state directory and credential.

Sessions whose cwd is the whole home directory contain the usual daemon state
and Pi credential locations. They are rejected by default. A high-trust
operator who accepts that any enabled session tools can reach those nested
paths may opt in explicitly:

```yaml
security:
  allowAuthorityRootOverlap: true
```

The equivalent CLI flag is `--allow-authority-root-overlap true`; Home Manager
instances use `allowAuthorityRootOverlap = true`. This changes only the overlap
fence—cwd must still be inside an explicit canonical `allowedRoots` entry, and
all owner/mode/symlink checks remain enforced.

To enable the additive authenticated JSON listener, either set `api.enabled`
in YAML or pass `--api-port` (optionally make enablement explicit with
`--api-enabled true`), then let the daemon create its stable default bearer file
or configure exactly one external source. `--api-enabled false` lets a supervisor
or Home Manager instance explicitly override an enabling YAML file.
Supplying bearer bytes as a CLI value is intentionally unsupported:

```console
pi-daemon serve \
  --socket "$XDG_RUNTIME_DIR/pi-daemon.sock" \
  --state-dir "$HOME/.local/state/pi-daemon" \
  --allow-root "$HOME/work" \
  --api-bind 127.0.0.1 \
  --api-port 7463
```

When no bearer source is supplied, first launch atomically generates an
owner-only bearer at `STATE_DIR/api-token`; later launches validate and reuse it.
`--api-token-file PATH` selects another generated-or-existing path. An inherited
secret descriptor (`--api-token-fd FD`) or `PI_DAEMON_BEARER_TOKEN` may be used
instead, but sources are mutually exclusive. Existing files must be owner-only,
regular, and non-symlinked and are never overwritten. The default bind is the
literal loopback address `127.0.0.1`. A non-loopback plaintext bind is refused unless
`--api-allow-insecure-http true` explicitly acknowledges trusted-network or TLS
reverse-proxy handling.

A supervisor can also enable the embedded Dashboard on the same `serve`
process without generating a Pi Daemon YAML file:

```console
pi-daemon serve \
  --socket "$XDG_RUNTIME_DIR/pi-daemon.sock" \
  --state-dir "$HOME/.local/state/pi-daemon" \
  --allow-root "$HOME/work" \
  --api-enabled true --api-bind 127.0.0.1 --api-port 7463 \
  --web-enabled true --web-bind 127.0.0.1 --web-port 7464
```

The web options are typed overrides, not a second service: the embedded
Dashboard uses the same multiplexer, retained-session catalog, schedules and
logical-session inventory as the Unix/API host. Precedence is explicit CLI over
YAML over the existing defaults. `--web-enabled false` disables an enabling
YAML block; unlike `--api-port`, `--web-port` alone does not enable a browser
listener. With YAML omitted, web bind defaults to literal loopback and web port
to `7464` after `--web-enabled true`. `serve` rejects an enabling override when
YAML requests `web.mode: dedicated`; dedicated mode remains the separate
`pi-daemon web` command and is never spawned implicitly.

Bind, port, public-origin, proxy and TLS overrides pass through the same
Dashboard validation as YAML and `pi-daemon web`, before the owner socket or any
HTTP listener is published. Plaintext web remains loopback-only. API bearer
sources and mutual exclusion are unchanged: bearer bytes are never accepted on
argv, generated API and browser tokens remain owner-only regular files, and
startup/status output reports only listener addresses and safe lifecycle state.

Consumers should capability-gate these flags by pinning a Pi Daemon source
revision that contains `bd-b05086`, or a release whose notes advertise embedded
web CLI overrides. Do not infer support merely from protocol-v2 configured-open
capabilities: service-launch CLI capability and session protocol capability are
distinct contracts.

When `--agent-dir` differs from Pi's normal agent directory and has no
`auth.json`, first launch copies the normal owner-private `auth.json` once if it
exists. `--auth-seed-file PATH` names a required source explicitly. The seed is
bounded to 1 MiB, must be an owner-only regular JSON file, and never overwrites
an existing destination. Missing implicit auth leaves the service listening but
degraded so an operator can authenticate Pi later.

`GET /v1/capabilities` advertises HTTP, WebSocket, both Pi RPC subprotocols,
the pinned in-process RPC host contract, controller/observer roles, replay, and
all active attachment limits. Durable session CRUD, ticket lookup/reconciliation,
and `/rpc` are implemented behind the same bearer boundary. `/apc` serves
upstream Agent Client Protocol JSON-RPC over the required
`agent-client-protocol.v1` WebSocket subprotocol. It uses the same resident Pi
runtime, bearer, generation, and bounded peer transport; it never spawns
`pi-acp` or `pi --mode rpc`.

Optional limits:

```text
--max-sessions N
--max-concurrent-turns N
--max-session-queue-depth N
--idle-session-ttl-ms N
--recovery-open-timeout-ms N
--recovery-total-timeout-ms N
--max-connections N
--max-in-flight-requests-per-connection N
--max-line-bytes N
--max-event-bytes N
--max-response-bytes N
--max-outbound-bytes-per-connection N
```

The event and response limits include their complete NDJSON envelopes and
trailing LF. Each must be no greater than the aggregate per-connection outbound
byte limit. Oversized/non-serializable events become bounded `eventDropped`
records; oversized/non-serializable responses become typed errors.

Pi RPC attachment defaults separately bound hubs (32), replay events (512),
replay bytes per hub (2 MiB), aggregate replay capacity (64 MiB), text messages
(1 MiB), per-reader outbound bytes (4 MiB), and in-flight commands per reader
(8). A 30-second ping/pong keepalive detects
dead readers. These effective values are returned by `/v1/capabilities`; a slow
reader is closed without blocking its session, controller, or other readers.

## Remote stock-RPC client

`pi-daemon-rpc --session ID_OR_EXACT_NAME` translates stock Pi RPC JSONL on
stdin/stdout to the framed WebSocket API. Supply `--url`, plus exactly one of
`--token-file`, `--token-fd`, or `PI_DAEMON_BEARER_TOKEN`. Reconnect attempts,
handshake time, pending/in-flight commands, bytes, replay, terminal response
drain, and output flush are bounded. Attach/reconnect/gap status is JSONL on
stderr; bearer values and daemon framing never appear on either output stream.
See [Remote RPC stdio bridge](rpc-bridge).

Both `pi-daemon` and `pi-daemon-rpc` install their stdout/stderr error policy
before command output. `EPIPE` means an early-closing Unix pipeline consumer and
terminates quietly with status 0; unrelated stream errors remain fatal.

The service emits structured JSON lifecycle logs to stderr. It never logs
prompts, model output, credentials, or private state/agent/workload paths.
`pi_daemon_startup_stage` emits `started` before each potentially long recovery,
schedule, Dashboard-runtime, and listener boundary, then `completed` with a
bounded elapsed time. If startup takes minutes, the last started stage identifies
the delay without exposing a path or configuration value.
`pi_daemon_listening_degraded` means the transport is available but recovery or
provider readiness is incomplete/degraded; `pi_daemon_ready` is emitted only
when all bounded recovery work settles without an indeterminate/failure state.

## Home Manager service instances

The flake exports `homeManagerModules.default` and the equivalent
`homeManagerModules.pi-daemon`. It can run any number of independently named
foreground daemon instances. Each instance has its own native service identity,
state/config directory, Unix socket, Pi agent/auth directory, API port, token
file, environment, roots, and logs:

```nix
{
  imports = [ inputs.pi-daemon.homeManagerModules.default ];

  services.pi-daemon.instances.work = {
    # Optional; module-managed values below remain explicit CLI overrides.
    configFile = "${config.xdg.configHome}/pi/daemon/work/config.yaml";
    stateDir = "${config.xdg.stateHome}/pi-daemon-work";
    socketPath = "${config.xdg.runtimeDir}/pi-daemon-work.sock";
    agentDir = "${config.home.homeDirectory}/.pi-work";
    # Optional: otherwise a distinct agentDir seeds once from Pi's normal auth.
    authSeedFile = "${config.home.homeDirectory}/.pi/agent/auth.json";
    allowedRoots = [ "/srv/work" ];
    api = {
      enable = true;
      bind = "127.0.0.1";
      port = 17463;
      # Optional: otherwise stateDir/api-token is generated on first launch.
    };
    extraArgs = [ "--max-sessions" "32" "--max-concurrent-turns" "4" ];
  };
}
```

Home Manager can generate the non-secret policy file directly. For example,
`xdg.configFile."pi/daemon/work/config.yaml".text` may contain the `web:` block
above, while the instance sets `configFile` to that generated path,
`agentDir = "${config.home.homeDirectory}/.pi/agent"`, and
`dedicatedWeb = { enable = true; port = 17465; };`. The module passes only paths
and non-secret policy through launchd/systemd; Pi settings contents and auth are
read at runtime. Module evaluation tests force both the config-file path and
separate dedicated-web service identity.

`home-manager switch` installs the package, creates native-supervisor log
parents, and enables `pi-daemon-work.service` on Linux systemd,
`com.pi-daemon.work` on Darwin launchd, or `pi-daemon-work` when a nix-on-droid
supervisord option surface is present. These identities cannot collide with
Cacophony's `cacophony.service` / `com.cacophony.lifecycle` identities.

```console
systemctl --user status pi-daemon-work
launchctl print "gui/$UID/com.pi-daemon.work"
supervisorctl status pi-daemon-work
```

An API-enabled instance also enables `pi-daemon-watchdog-work` /
`com.pi-daemon.watchdog.work` by default. This is a separate, small Node process,
so it can detect a daemon event loop that still owns a PID and listening socket
but emits no HTTP response. Every interval it expects the API root's exact
unauthenticated `401`; for dedicated Dash it then expects content-free
`/dash/readyz` `204`, which makes one fresh authenticated backend capability
request rather than trusting the cached startup capability.

The defaults probe every 30 seconds with a 5-second deadline. A semantic response
over 2 seconds is **degraded latency**, not a restart trigger. Two consecutive
hard failures trigger one recovery of only the generated instance service. The
watchdog persists the attempt before invoking the supervisor in
`STATE_DIR/watchdog-v1.json`; it will not try again while the component remains
unhealthy. Any later semantic success clears that latch and starts a new failure
epoch. This makes disk/load pressure visible without producing a restart storm
or doubling backend load: when the API is slow or failed, the dependent Dash
probe is skipped.

Systemd and supervisord use their exact service names and a bounded 30-second
TERM stop timeout. Launchd first records the exact job PID, sends TERM to the
exact `gui/$UID/com.pi-daemon[.web].NAME` target, and polls both semantic health
and that PID. An exited or changed PID proves graceful drain; the watchdog leaves
a load-delayed replacement alone even if it has not bound yet. Only the same
stuck PID may receive one recorded `kickstart -k` escalation. Probe and recovery
records contain component, phase, latency,
status/error code, supervisor, duration, and whether escalation occurred—never
URLs, bearer values, response bodies, or private paths. Tune or disable this
per instance only when another external semantic supervisor owns the same duty:

```nix
services.pi-daemon.instances.work.watchdog = {
  enable = true;
  intervalMs = 30000;
  probeTimeoutMs = 5000;
  degradedAfterMs = 2000;
  failureThreshold = 2;
  gracefulTimeoutMs = 30000;
};
```

Inspect the independent service and its persisted decision instead of inferring
health from the daemon PID:

```console
systemctl --user status pi-daemon-watchdog-work
launchctl print "gui/$UID/com.pi-daemon.watchdog.work"
supervisorctl status pi-daemon-watchdog-work
```

Enabled instances must use unique explicit `configFile`, `stateDir`,
`socketPath`, stdout/stderr logs, API ports, and effective token paths. Every
service receives `--instance NAME`; an optional `configFile` receives
`--config PATH`, while module-managed identity/root/path/API values remain later
CLI overrides. Instance names are bounded
alphanumeric/hyphen identifiers. At least one explicit workload root and an API
port are required when those surfaces are enabled. An optional external
`tokenFile` contributes only its path to the Nix service definition, never its
bearer bytes. `extraArgs` may set resource limits but
cannot override module-managed identity, root, path, or API arguments.

## Rolling non-launchd test instance

`scripts/pi-daemon-test-instance.sh` maintains an operator-owned test instance
without creating or modifying a launchd/systemd unit. It keeps a separate Git
checkout, Nix GC root, config, state, Pi agent directory, socket, tmux session,
log, API bearer, and Dash web credential. `update` fast-forwards only to
`origin/main`, refuses tracked source changes, runs the exact Nix package/test
gate, atomically switches to the immutable result, and restarts only its named
tmux session after a successful build. A failed build leaves the running result
unchanged.

From a fresh checkout on any Nix-capable developer node, the complete first-run
recipe is:

```console
nix develop -c just test-daemon
```

It creates an owner-private node-local config only when absent, creates the
explicit development workload/session roots, clones or fast-forwards exact
`origin/main`, runs the full Nix package/test gate, atomically switches the GC
root, and starts only the isolated tmux service. It never installs a native
service or touches another daemon instance. The equivalent lower-level commands
are:

```console
scripts/pi-daemon-test-instance.sh init-config
scripts/pi-daemon-test-instance.sh install
scripts/pi-daemon-test-instance.sh update
scripts/pi-daemon-test-instance.sh status
scripts/pi-daemon-test-instance.sh logs
scripts/pi-daemon-test-instance.sh stop
```

Set `PI_DAEMON_TEST_ALLOWED_ROOT`, `PI_DAEMON_TEST_API_PORT`, and
`PI_DAEMON_TEST_WEB_PORT` before the first command when node defaults would
collide. `PI_DAEMON_TEST_INSTANCE` gives every runner separate state/config,
agent, socket, tmux session **and tmux server socket** names, so unrelated
`tmux kill-server` commands cannot stop it. `PI_DAEMON_TEST_REMOTE` can select an HTTPS or
other authenticated Git remote when SSH is unavailable. Existing configs are
never overwritten.

Default paths are `~/.local/share/pi-daemon-test/source`,
`~/.local/state/pi-daemon/test`, and
`~/.config/pi/daemon/test/config.yaml`; environment variables named at the top
of the script override them. The config must still provide explicit isolated
values. The ms-mac developer instance uses socket
`~/.local/state/pi-daemon/test/run/pi-daemon.sock`, API `127.0.0.1:7473`, and
embedded Dash endpoint `127.0.0.1:7474`, while the Home Manager primary remains
on API port 7463. No token is placed in the script, argv, Git, browser URL, or
output: service bootstrap creates `STATE_DIR/api-token`, and the DashboardServer
factory creates `STATE_DIR/web-token` only when its legacy single-owner lifecycle
is enabled. An explicit identity provider reads separate owner-only credential
sources and does not create a fallback web token.

An enabled embedded `web` block starts the same packaged content-hashed SPA and
browser BFF after the owner socket and authenticated API are ready. Open
`http://127.0.0.1:7474/dash/` for the ms-mac rolling instance. The browser
credential is exchanged only through the same-origin login and becomes an
opaque `HttpOnly`, `SameSite=Strict` cookie; the daemon service bearer never
reaches JavaScript. Startup is atomic across all listeners and shutdown shares
the daemon's existing whole deadline.

For a dedicated deployment, set `web.mode: dedicated`, keep the service API
enabled, and run:

```console
pi-daemon web --config ~/.config/pi/daemon/work/config.yaml --instance work
```

The command defaults to API `127.0.0.1:7463` and browser port 7465, reads the
service bearer from the configured API token file (or an inherited descriptor/
environment source), keeps it server-side inside `RemoteDashboardBackend`, and
stores browser credentials/workspaces under `STATE_DIR/dedicated-web`. CLI
`--api-url`, `--api-token-file`/`--api-token-fd`, `--web-state-dir`,
`--web-bind`, `--web-port`, and `--public-origin` provide bounded supervisor
overrides. Home Manager `instances.<name>.dedicatedWeb` emits a second ordered
systemd/launchd/supervisord service, validates API/Dash port and state/log
collisions, and passes only token paths—not bytes—through argv.

Production remote Dash can stay on loopback behind an HTTPS reverse proxy or
use native HTTPS/WSS. Native mode requires an exact HTTPS `web.publicOrigin`
and one certificate/private-key file or inherited descriptor source each:

```yaml
web:
  mode: dedicated
  bind: 0.0.0.0
  port: 7465
  publicOrigin: https://dash.example.test
  tls:
    certFile: /run/secrets/pi-daemon-dash-cert
    keyFile: /run/secrets/pi-daemon-dash-key
    reloadIntervalMs: 30000
```

Home Manager exposes the same paths at
`dedicatedWeb.tls.certFile`/`keyFile`; use runtime secret-manager paths such as
SOPS outputs, never PEM literals. Valid file-backed pairs rotate atomically and
a failed/partial rotation retains the last working context. The content-free
`GET|HEAD /dash/healthz` probe returns 204 only after exact Host and configured
proxy-authority checks and proves only the browser listener. `/dash/readyz`
performs the same authority checks and additionally returns 204 only after a
fresh dedicated API capability request; it returns an empty 503 while the API is
unavailable. Reverse proxies may set
`dedicatedWeb.trustProxyHeaders = true`; supplied forwarded host/protocol/port
must then exactly match `publicOrigin` and arrive from loopback. See
[Dashboard transport security](dashboard-transport-security) for downgrade,
SNI, HSTS, cookie, file-mode, and failure semantics.

## Dashboard identities and single-owner migration

The SPA **Access & controller** dialog and `/dash/v1/authorization/...` BFF
routes are the only supported grant, revocation, ownership-transfer,
workspace-selection and controller-handoff surfaces. They require exact CSRF and
revision headers and never accept a service bearer.

With no identity provider configured, Dash behaves exactly as before: it creates
or reuses `STATE_DIR/web-token`, authenticates `local-owner`, and gives that
principal the implicit administrator role. Multi-user activation is explicit
and static. Identity metadata may be placed directly in the strict daemon YAML,
but credentials may only be read from an owner-only regular file or an inherited
descriptor:

```yaml
web:
  auth:
    sessionTtlMs: 43200000
    identityProvider:
      type: static
      identities:
        - identityId: operator
          globalRole: administrator
          displayName: Primary operator
          credentialFile: /run/pi-daemon-secrets/dash-operator
        - identityId: reviewer
          globalRole: member
          displayName: Reviewer
          credentialFd: 9
```

The provider is bounded to 128 unique identities and requires at least one global
administrator. Every identity requires exactly one unique `credentialFile` or
`credentialFd`; credentials must be independent high-entropy tokens, not user
passwords. Literal `credential`, `password`, token, bearer, or secret fields are
unknown and fail startup. Credential files are bounded, owner-owned, mode 0600,
regular, and non-symlink. Descriptors must be inherited descriptors numbered 3
or higher and reference an owner-only regular file; they are consumed and closed
at startup. Credential bytes are hashed at startup and never enter YAML, argv,
Nix store values, status, logs, cookies, browser storage, or provider metadata.

A strict non-secret provider document can instead be selected from YAML with
`web.auth.identityProviderFile` or from either executable with:

```console
pi-daemon serve ... --web-identity-provider-file /etc/pi-daemon/identities.yaml
pi-daemon web ... --web-identity-provider-file /etc/pi-daemon/identities.yaml
```

Relative credential paths in an inline provider are relative to the daemon
config; paths in a provider document are relative to that document. The CLI
argument contains only the provider-document path. Home Manager offers
`instances.<name>.dashboardAuth.identityProviderFile` or a typed
`dashboardAuth.identities` list. The latter emits only identity metadata and
runtime credential paths to a generated Nix-store JSON document and passes its
path to the embedded or dedicated process. For example:

```nix
services.pi-daemon.instances.work.dashboardAuth.identities = [
  {
    identityId = "operator";
    globalRole = "administrator";
    displayName = "Primary operator";
    credentialFile = config.sops.secrets.pi-daemon-dash-operator.path;
  }
];
```

Do not also configure legacy `web.auth.tokenFile`; the three provider sources
(`tokenFile`, inline provider, provider file) are mutually exclusive. The daemon
service bearer remains an independent server-to-server credential and is never
accepted at Dash login.

To migrate an existing installation, stop Dash, back up its owner-private state,
configure at least one administrator identity, and restart with the same Dash
state directory. Restart revokes old browser cookies. The old `local-owner`
workspace/policies remain durable; a configured global administrator can list
and open them, then use **Access & controller** to transfer ownership and grant
members. The old generated `web-token` is no longer accepted while the provider
is enabled; retain it only for a deliberate rollback, then remove it after the
migration window. Removing the provider and restarting restores exact
single-owner behavior. Moving between embedded and dedicated mode is a separate
offline state-directory migration—provider configuration does not copy state.

## Supported-system closure cache and Nix-on-Droid bootstrap

Pi Daemon remains a Node service even though the interactive Pi CLI can be
packaged as a Bun binary. Its pinned SDK dependencies are installed by npm at
build time. Node/npm can abort with `double free or corruption` when that build
runs natively inside Nix-on-Droid, so Android devices must consume a prebuilt
`aarch64-linux` closure rather than fall back to a local build. The same signed
cache also avoids rebuilding the large pinned SDK/npm closure on ordinary Linux
and Darwin consumers.

`.github/workflows/closure-cache.yml` is the normal publisher. Every accepted
`main` revision (or explicit workflow dispatch) starts a fail-independent matrix
for all systems exported by the flake:

| target | runner labels | execution requirement |
| --- | --- | --- |
| `aarch64-linux` | `self-hosted, nix, x86_64-linux` | `extra-platforms` plus enabled aarch64 binfmt |
| `x86_64-linux` | `self-hosted, nix, x86_64-linux` | native |
| `aarch64-darwin` | `self-hosted, macos` | native on the normal Apple Silicon publisher |
| `x86_64-darwin` | `self-hosted, macos` | native or declared `extra-platforms` execution (normally Rosetta) |

Concurrency is target-scoped and never cancels an active publisher, so a slow
Darwin closure neither blocks nor cancels Linux and a later landing cannot leave
a target half-published. Each job verifies `builtins.currentSystem`; a non-native
target must appear in effective `extra-platforms`, and Linux ARM additionally
requires a live binfmt registration. A mislabelled or unprepared runner fails
before authentication/build with the target and missing capability rather than
silently publishing its host system.

The flake's dedicated `devShells.<system>.closurePublisher` includes
`pkgs.attic-client` from the repository-pinned nixpkgs input. Every workflow
Attic operation runs as `nix develop .#closurePublisher --command attic ...`;
publisher correctness never depends on a mutable host `PATH`, host install, or
ad-hoc package bootstrap. It authenticates in a target-specific isolated
`XDG_CONFIG_HOME`, checks the destination cache, and runs `attic use` before the
build. That adds the private signed substituter without removing
`cache.nixos.org`; `require-sigs` remains enabled, so a bad or untrusted
non-content-addressed closure fails instead of falling back to unsigned input.
It builds exact `.#packages.$TARGET_SYSTEM.pi-daemon`, requires exactly one Nix
store output, records its closure size, executes both installed version commands
on the configured execution path, and passes only that captured output to
`attic push -j1`. Target-labelled logs are retained for 14 days.

The protected GitHub environment remains named `pi-daemon-aarch64-cache` for
credential compatibility even though the publisher is now multi-platform. Set:

- environment variable `PI_DAEMON_ATTIC_ENDPOINT`: the Attic API endpoint,
  including `https://` (or a trusted-network `http://` endpoint);
- environment variable `PI_DAEMON_ATTIC_CACHE`: the existing simple cache name;
- environment secret `PI_DAEMON_ATTIC_TOKEN`: a least-privilege token with pull
  and push access to that cache.

The consumer-acceptance feedback webhook/token is unrelated and is not read by
this workflow. Bootstrap the Attic cache once with an administrator outside
GitHub Actions: create the cache, configure visibility/retention, record the
public signing key from `attic cache info SERVER:CACHE`, and issue the scoped CI
token. Configure consumers with the substitution URL and exact public key in
`trusted-public-keys` while retaining `https://cache.nixos.org/`; publisher
tokens must never be placed on consumers. Publishers need Nix and the declared
target execution support; the workflow supplies its pinned Attic client through
the declared publisher shell. Workflow credentials are removed by an `always()` step, and logs never retain
the token or private Attic config.

For deliberate manual recovery, use the same sequence on a host capable of
executing the exact target:

```console
TARGET_SYSTEM=aarch64-linux
attic login --set-default SERVER https://attic.example.invalid PULL_PUSH_TOKEN
attic cache info SERVER:collective
attic use SERVER:collective
out=$(nix build --no-link --print-out-paths --option require-sigs true \
  "github:harryaskham/pi-daemon/REV#packages.$TARGET_SYSTEM.pi-daemon")
"$out/bin/pi-daemon" version
"$out/bin/pi-daemon-rpc" --version
attic push -j1 SERVER:collective "$out"
```

The aarch64-linux package still builds, prunes, and runs both installed version
checks under emulation. Its full Node test suite remains intentionally gated on
native Linux x86_64 and macOS: under QEMU, RSS can report zero and bounded
subprocess tests exceed their real-hardware deadlines. The separate scheduled
consumer acceptance is also not part of package installation. Cache population
is required before switching Astra, SGU24, or another Nix-on-Droid consumer. A
cache miss that starts `npm ci` on a device is an operational error—stop it,
prebuild the same derivation off-device, push it, and retry the unchanged
generation.

## High-level session management

`pi-daemon session`, `ticket`, `prompt`, `control`, `rpc`, and `acp` provide
bounded JSON commands over either the owner-only Unix socket or authenticated
API. Bearers remain file/fd/environment-only, mutations carry idempotency and
stale generation/revision checks, and endpoint discovery never prints token
values. See [Session management CLI](session-cli) for examples.

## Dashboard diagnostics

The sidebar exposes a discreet **Diagnostics** button immediately below
**Settings** when `resources.diagnostics` is advertised. It is available only
to a global Dash administrator and shows effective config/default/policy flags,
allowed-root count, installed-package inheritance status, and the bounded recent
service-failure ring. **Refresh** performs an authenticated no-store read;
**Copy safe report** copies exactly the already-redacted snapshot.

This is deliberately not a launch-log browser. If process startup fails before
the diagnostics runtime exists, inspect the owner-only launchd/systemd stderr
file locally. Never publish or paste that raw file without review. The browser
endpoint cannot select paths or read files and never returns prompts, model
output, identifiers from request paths, credentials, environment values, request
bodies, or bearer material.

## Probe and status

```console
pi-daemon probe --socket "$XDG_RUNTIME_DIR/pi-daemon.sock" --timeout-ms 5000

# Pin one version to inspect exactly what a peer speaking it would be told.
pi-daemon probe --socket "$XDG_RUNTIME_DIR/pi-daemon.sock" --protocol-version 1.0

pi-daemon request --socket "$XDG_RUNTIME_DIR/pi-daemon.sock" --json \
  '{"protocolVersion":"1.0","requestId":"status-1","operation":"status","payload":{}}'

pi-daemon request --socket "$XDG_RUNTIME_DIR/pi-daemon.sock" --json \
  '{"protocolVersion":"1.0","requestId":"attach-1","operation":"attach","sessionId":"agent-a","generation":1,"payload":{}}'
```

Readiness distinguishes protocol availability from Pi model/auth and recovery
availability. Probe exits `0` only for `host.ready: true`, `75` for a successful
but recovering/degraded handshake, and nonzero for transport/protocol failure.
Both connect and handshake are deadline bounded.

Probe negotiates the highest supported protocol version by default and reports
the version it asked for as `requestedProtocolVersion`. This matters for
integration: a host advertises `configuredOpen`, `sessionDir`,
`hostToolAdapter`, `hostToolOperationCount`, and `supportedProtocolVersions`
only when the request declares a 2.x version, so a v1 probe cannot distinguish a
v1-only host from a fully v2-capable one. Use `--protocol-version` to pin one
version when you need to see exactly what a peer speaking it would be told. A
host that cannot answer a 2.x handshake still yields a truthful v1 result.

Status retains safe recovery
phase, pending replay/mutation counts, indeterminate counts, failure-code counts,
metrics, memory, resident/retained sessions, turns, and draining state; it
excludes prompts, results, credentials, error text, and private paths.

## Shutdown

SIGTERM starts a 30-second whole-process shutdown deadline. SIGINT uses five
seconds. Transports stop admission first, active/queued turns are drained or
aborted, and adapter/extension disposal is raced against the remaining deadline.
A hung adapter is reported and abandoned rather than blocking process exit. In
direct CLI signal mode, an unreferenced hard-exit watchdog terminates only if
abandoned extension/runtime handles survive beyond the whole deadline. A
protocol `drain` command still accepts `payload.timeoutMs`.

Idle SDK sessions are evicted after 30 minutes by default while their durable
catalog and Pi session artifacts remain. Eviction emits `sessionDormant` and
`sessionEvicted`; re-open the same generation and policy to load the exact
resolved Pi session file again. A retained close removes the runtime manifest,
so it stays dormant across restart until explicitly reopened. Sweeps are
non-overlapping; disposal failure/timeout marks only that session failed and is
retained as a safe metric/code rather than becoming an unhandled rejection. Set
`--idle-session-ttl-ms 0` to disable eviction.

## Durable session catalog

Owner-private atomic catalog records live under
`state/catalog/<escaped-session-id>.json`. They retain immutable daemon ID,
optional exact unique name, generation/revision, resident/dormant state,
nonsecret normalized session spec, environment key/digest summary, current Pi
conversation identity, last-use timestamps, and the latest terminal outcome.
Raw environment values are rejected rather than serialized.

Catalog records are individually capped at 1 MiB, aggregate startup input is
capped at 256 MiB, and the retained record count is bounded. Listing is stable by canonical session ID, defaults to 50 entries,
caps at 100, and uses opaque cursors. A dormant record can be inspected, renamed or
replaced with optimistic generation/revision checks, reopened, or deleted with
its retained manifest/journal/Pi files without first creating an SDK runtime.
Daemon status exposes only counts; the additive session API exposes bounded
resources.

## Durable command tickets

Owner-private atomic mutation tickets live under `state/tickets/`. They are
bounded to 4096 records, 1 MiB each, 256 MiB aggregate recovery input, and seven
days for terminal or indeterminate retention by default. Ticket commands contain
only the persisted session spec plus environment key/digest summary; raw values
stay in the first host's volatile prepared runtime context. A queued
environment-dependent ticket found after restart fails `credentials_required`
rather than replaying with missing or host-global credentials.
The wake path continues to use the bounded per-session journal and derives an
opaque ticket ID from session/idempotency scope. Authenticated API responses are
preflighted against a 2 MiB structural JSON bound; an oversized list/result
becomes a typed `outbound_record_too_large` error before JSON/Buffer allocation.

## Restart recovery

At startup, manifest/catalog/journal counts, individual records, aggregate
bytes, per-session opens, and the total open phase are bounded. Manifests reopen
the resolved Pi session file recorded after the original create/continue/open
operation; the requested target is never rerun as though it were still
unresolved. A retained imported/forked session is reopened with the exact
managed JSONL and its containing session directory; recovery never resolves or
replays the original source fork. Legacy prepared records that predate persisted
model policy recover the latest provider/model/thinking selection from that
managed conversation's active branch. Full secret-free runtime configuration is reconstructed. Durable
`queued` wakes then replay in the background while the transport listens, and
queued mutation tickets replay through their secret-free commands. `accepted` wakes and `running` mutations become
`indeterminate` and require client reconciliation. Readiness logs expose only
queued/indeterminate/pruned counts, never ticket commands or results.

A missing/corrupt Pi file, a legacy `new`/`continue` manifest without resolved
identity, or a generation mismatch blocks replay and is reported as a recovery
failure. Corrupt, permissive, mismatched, oversized, or symlinked state fails
closed rather than being ignored.

`memory` targets are explicitly resident-only: they have a catalog identity but
no runtime manifest or durable wake journal, remain dormant after restart, and
cannot be reopened as an empty replacement conversation.
