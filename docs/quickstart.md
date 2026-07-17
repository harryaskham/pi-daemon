---
layout: default
title: Operator quickstart
---

# Operator quickstart

This quickstart runs Pi Daemon as a Home Manager user service, creates one
durable no-tools session through the authenticated API, waits for its mutation
ticket, attaches stock Pi RPC, and shows the ACP connection contract. The
service bearer is read from an owner-only file; it is never placed in Nix source
or a process argument.

Prerequisites: a flake-based Home Manager configuration, Bash, `curl`, and
`jq`. Log in with normal Pi once before starting an isolated daemon instance so
`~/.pi/agent/auth.json` exists as an owner-private regular file.

## 1. Create workload roots

Only workload authority roots are operator-owned inputs. Pi Daemon deliberately
does not create them because doing so would turn a configuration typo into a
filesystem authority grant:

```bash
install -d -m 700 "$HOME/work" "$HOME/scratch-work"
```

On first launch the daemon itself creates and validates its private state,
socket, and agent directories. A distinct empty `agentDir` seeds `auth.json`
once from Pi's normal agent directory when that source exists. The API generates
a random owner-only bearer at `stateDir/api-token` when no file, descriptor, or
environment bearer is configured. Restart reuses both files; existing auth and
bearer files are never overwritten or rotated.

## 2. Enable Home Manager instances

Add Pi Daemon to the inputs of your Home Manager flake and import its module:

```nix
inputs.pi-daemon.url = "github:harryaskham/pi-daemon";
inputs.pi-daemon.inputs.nixpkgs.follows = "nixpkgs";

# Add this beside the other modules passed to homeManagerConfiguration:
modules = [
  inputs.pi-daemon.homeManagerModules.default
  ./home.nix
];
```

Then configure one or more named instances in `home.nix`. Remove the `sandbox`
entry if you need only one. The explicit values below make every service
identity, state/persisted-configuration directory, socket, port, agent
directory, log, workload root, and bearer source collision-free:

```nix
{config, ...}: let
  home = config.home.homeDirectory;
in {
  services.pi-daemon.instances = {
    operator = {
      stateDir = "${home}/.local/state/pi-daemon/operator";
      socketPath = "${home}/.local/state/pi-daemon/operator/run/pi-daemon.sock";
      agentDir = "${home}/.pi/operator";
      allowedRoots = ["${home}/work"];
      stdoutLog = "${home}/.local/state/pi-daemon/operator/stdout.log";
      stderrLog = "${home}/.local/state/pi-daemon/operator/stderr.log";
      api = {
        enable = true;
        bind = "127.0.0.1";
        port = 7463;
      };
    };

    sandbox = {
      stateDir = "${home}/.local/state/pi-daemon/sandbox";
      socketPath = "${home}/.local/state/pi-daemon/sandbox/run/pi-daemon.sock";
      agentDir = "${home}/.pi/sandbox";
      allowedRoots = ["${home}/scratch-work"];
      stdoutLog = "${home}/.local/state/pi-daemon/sandbox/stdout.log";
      stderrLog = "${home}/.local/state/pi-daemon/sandbox/stderr.log";
      api = {
        enable = true;
        bind = "127.0.0.1";
        port = 7464;
      };
    };
  };
}
```

Each name produces an independent native service: for example,
`pi-daemon-operator.service` under Linux systemd, `com.pi-daemon.operator`
under Darwin launchd, or `pi-daemon-operator` under nix-on-droid supervisord.
The module rejects duplicate state directories, sockets, enabled API ports, or
effective bearer paths. Keep `allowedRoots` disjoint from state and agent
locations; the daemon rejects authority roots that overlap its state or
credential storage. Home Manager still creates log parents needed by native
supervisors, while the daemon owns first-launch state/socket/agent setup. Neither
Nix nor Home Manager evaluates bearer or Pi auth bytes. Set `authSeedFile` or
`api.tokenFile` only to override the safe first-launch defaults.

Apply the configuration; Home Manager enables and starts the service. The
platform-native restart commands are shown when an explicit restart is needed:

```bash
home-manager switch --flake ".#$USER@$(hostname -s)"

case "$(uname -s)" in
  Darwin)
    launchctl kickstart -k "gui/$UID/com.pi-daemon.operator"
    ;;
  Linux)
    if command -v systemctl >/dev/null; then
      systemctl --user restart pi-daemon-operator.service
    else
      supervisorctl restart pi-daemon-operator
    fi
    ;;
esac

pi-daemon probe \
  --socket "$HOME/.local/state/pi-daemon/operator/run/pi-daemon.sock"
```

A successful probe exits 0. Exit 75 means the transport is listening but model,
authentication, or recovery readiness is degraded; inspect `journalctl --user
-u pi-daemon-operator` on Linux or the configured stdout/stderr logs on Darwin
before admitting sessions.

## 3. Call the authenticated API without a bearer in argv

The helper below passes the authorization header to `curl` through a private
file descriptor. The token is not expanded into `curl`'s process arguments.
It requires Bash, `curl`, and `jq`.

```bash
set -euo pipefail

API="http://127.0.0.1:7463"
TOKEN_FILE="$HOME/.local/state/pi-daemon/operator/api-token"
SESSION_ID="quickstart"
SESSION_CWD="$HOME/work/pi-daemon-quickstart"
mkdir -p "$SESSION_CWD"

curl_api() {
  curl --fail-with-body --silent --show-error \
    --config <(printf 'header = "Authorization: Bearer %s"\n' "$(<"$TOKEN_FILE")") \
    "$@"
}

wait_ticket() {
  local ticket_id="$1" response state deadline=$((SECONDS + 60))
  while (( SECONDS < deadline )); do
    response="$(curl_api "$API/v1/ticket/$ticket_id")"
    state="$(jq -r '.data.state' <<<"$response")"
    case "$state" in
      succeeded)
        jq . <<<"$response"
        return 0
        ;;
      failed)
        jq . <<<"$response" >&2
        return 1
        ;;
      indeterminate)
        jq . <<<"$response" >&2
        return 75
        ;;
      queued|running)
        sleep 0.2
        ;;
      *)
        printf 'unexpected ticket state: %s\n' "$state" >&2
        return 1
        ;;
    esac
  done
  printf 'ticket %s did not settle within 60 seconds\n' "$ticket_id" >&2
  return 75
}
```

Check capabilities, then create a durable session. Keep the idempotency key
stable when retrying the same request; use a new key only for a new semantic
mutation.

```bash
curl_api "$API/v1/capabilities" | jq .

create_response="$(
  curl_api \
    --request POST \
    --header 'Content-Type: application/json' \
    --header 'Idempotency-Key: quickstart-create-v1' \
    --data-binary @- \
    "$API/v1/session" <<JSON
{
  "requestId": "quickstart-create-request",
  "sessionId": "$SESSION_ID",
  "spec": {
    "cwd": "$SESSION_CWD",
    "name": "operator-quickstart",
    "target": { "mode": "new" },
    "tools": { "mode": "none" },
    "isolation": { "mode": "unisolated" }
  }
}
JSON
)"

jq . <<<"$create_response"
create_ticket="$(jq -er '.data.ticketId' <<<"$create_response")"
wait_ticket "$create_ticket"

curl_api "$API/v1/session?limit=50" \
  | jq '.data.sessions[] | {sessionId, name, generation, revision, residency, state}'
```

For repeatable one-shot commands built on the same API, see the [session
management CLI](session-cli). The raw `curl` flow above remains useful for
protocol integration and troubleshooting.

`POST`, `PUT`, and `DELETE` return `202` tickets. `queued` and `running` are
nonterminal. Never blindly repeat an `indeterminate` operation; inspect retained
Pi entries and use the explicit reconciliation API described in the
[session API](session-api#idempotency-and-request-tickets).

## 4. Attach stock Pi RPC

`pi-daemon-rpc` exposes stock Pi RPC JSONL on stdin/stdout while keeping daemon
attach/reconnect status on stderr. The bridge reads the bearer file itself.
This read-only smoke requests the current Pi state and exits after the response:

```bash
printf '%s\n' '{"id":"state-1","type":"get_state"}' \
  | pi-daemon-rpc \
      --url "$API" \
      --session "$SESSION_ID" \
      --role observer \
      --token-file "$TOKEN_FILE"
```

Use the default controller role for prompts or other mutations. Only one
controller lease exists per session; observers remain read-only.

## 5. Connect an ACP client

Configure an ACP client that supports WebSocket transport with:

| Setting | Value |
| --- | --- |
| URL | `ws://127.0.0.1:7463/v1/session/quickstart/apc` |
| WebSocket subprotocol | `agent-client-protocol.v1` |
| HTTP authorization | `Bearer` value read from `~/.local/state/pi-daemon/operator/api-token` |

After the WebSocket opens, send upstream ACP JSON-RPC `initialize`, then bind the
route-scoped session with `session/load` using session ID `quickstart` and the
same absolute cwd used at creation. A client that accepts only a local stdio ACP
adapter needs a WebSocket transport integration; Pi Daemon intentionally does
not launch `pi-acp` or `pi --mode rpc`. See the [ACP adapter](acp-adapter) for
the supported messages, bounds, and permission routing.

For a non-loopback endpoint, terminate TLS and use `https://`/`wss://`. Never
send the bearer over remote plaintext HTTP.

## 6. Delete the session

Deletion requires the current strong ETag. `retainArtifacts=false` removes the
catalog record and retained Pi artifacts after the ticket succeeds.

```bash
headers="$(mktemp)"
trap 'rm -f "$headers"' EXIT
curl_api \
  --dump-header "$headers" \
  --output /dev/null \
  "$API/v1/session/$SESSION_ID"
etag="$(awk -F': ' 'tolower($1) == "etag" { sub(/\r$/, "", $2); print $2 }' "$headers")"
[[ -n "$etag" ]]

delete_response="$(curl_api \
  --request DELETE \
  --header "If-Match: $etag" \
  --header 'Idempotency-Key: quickstart-delete-v1' \
  "$API/v1/session/$SESSION_ID?retainArtifacts=false")"
jq . <<<"$delete_response"
delete_ticket="$(jq -er '.data.ticketId' <<<"$delete_response")"
wait_ticket "$delete_ticket"
```

## Trust boundary

`isolation.mode: "unisolated"` is an honest declaration, not a sandbox. Logical
sessions have separate Pi runtime state, settings, queues, and session files,
but trusted extensions and SDK code share one Node process, memory space,
module globals, and ambient environment. Put mutually untrusted workloads in
separate daemon processes, containers, or VMs. Separate Home Manager instances
use independent processes and memory, but instances under one Unix account still
share that account's filesystem and credential authority; use a stronger OS,
container, or VM boundary for mutually untrusted workloads.
