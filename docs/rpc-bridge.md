# Remote Pi RPC stdio bridge

`pi-daemon-rpc` presents one retained daemon session as stock Pi RPC JSONL on
stdin/stdout. It lets existing clients that launch `pi --mode rpc` attach to a
long-lived in-process session without creating a Pi child process per session or
wake.

```console
pi-daemon-rpc \
  --url http://127.0.0.1:7463 \
  --session exact-session-id-or-name \
  --token-file ~/.config/pi-daemon/api-token
```

The API listener and session must already exist. The bridge is a client only; it
does not create or own the daemon session.

## Streams

- **stdin:** stock Pi 0.80.6 RPC commands and `extension_ui_response` values,
  one bounded UTF-8 JSON value per line;
- **stdout:** only stock Pi RPC responses and raw session/extension events, one
  value per line;
- **stderr:** bounded `pi_daemon_rpc_status` JSONL records for attach,
  reconnect, control, replay-gap, and fatal lifecycle state.

Daemon-specific framed records never leak onto stdout. This keeps pico-style
and other generic Pi RPC subprocess clients compatible without importing or
modeling any client application's types.

## Authentication

Exactly one bearer source is required:

- `--token-file PATH`: owner-owned, owner-only, regular non-symlink file;
- `--token-fd FD`: inherited regular-file descriptor at least 3; or
- `PI_DAEMON_BEARER_TOKEN`: memory-only environment fallback.

Bearer values are never accepted as command-line arguments, URL credentials,
or output. File size, token syntax, and header size are checked before connect.
The bridge uses `Authorization: Bearer ...` only during the WebSocket handshake.
Use TLS (`https://`, translated to `wss://`) or an authenticated loopback proxy
for remote hosts. The client refuses to transmit a bearer over non-loopback
plaintext unless `--allow-insecure-http` is explicit, matching the daemon's
opt-in plaintext policy.

## Framing and correlation

The bridge always uses `pi-daemon-rpc.v1` internally, even though its stdio
surface is stock RPC. Input commands are wrapped as `kind: command`; extension
UI responses use their dedicated frame. Responses are unwrapped only to the
originating process. Events are unwrapped and their opaque replay cursor is
retained. At most eight commands are in flight by default, and pending count,
input bytes, message bytes, output bytes, handshake time, and terminal drain are
all bounded.

The requested role defaults to `controller`. `--role observer` is useful for
read-only commands. A busy controller lease fails closed rather than silently
running mutating commands as an observer.

## Reconnect, gaps, and indeterminate commands

A transport disconnect triggers bounded exponential reconnect. The latest
opaque cursor is included on the next attach. Retained events after that cursor
are emitted on stdout before live events.

If the host restarted, the session generation changed, or replay retention
expired, stderr receives:

```json
{"type":"pi_daemon_rpc_status","event":"replay_gap","reason":"host_restarted","snapshotFollows":true}
```

The fresh attach snapshot is consumed by the bridge and a new cursor becomes
authoritative. No synthetic daemon frame is written to stock stdout. Operators
that require a lossless transcript must treat `replay_gap` as a resync signal.

Commands that were sent but lacked a response when the connection disappeared
are **never replayed blindly**. Each receives a correlated stock-shaped failure
with `error: "connection_lost_indeterminate"`. Commands still queued locally
and never sent may proceed after reconnect.

When stdin ends, the bridge waits for sent commands up to
`--terminal-timeout-ms` (five minutes by default), flushes bounded stdout, then
closes cleanly. SIGINT/SIGTERM, invalid JSON/UTF-8, output overflow, exhausted
reconnects, or terminal timeout close the attachment and return nonzero.

## Installation

Both npm and Nix artifacts include the executable:

```console
npm exec -- pi-daemon-rpc --version
nix run github:harryaskham/pi-daemon#pi-daemon-rpc -- --version
```

The reusable transport is exported as
`@harryaskham/pi-daemon/rpc-bridge` (`RpcStdioBridge`). It owns no daemon
process, session runtime, or global signal handler; only the executable wrapper
installs temporary SIGINT/SIGTERM handlers.
