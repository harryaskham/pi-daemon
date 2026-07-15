---
layout: default
title: Session management CLI
---

# High-level session management CLI

`pi-daemon` prints JSON for every successful high-level command. It can target
the owner-only Unix socket for compatible local operations, or the complete
bearer-authenticated API for durable catalog CRUD, tickets, Pi RPC, and ACP
endpoint discovery.

## Targets and credentials

Use one target style:

```console
# Owner-only local compatibility protocol
pi-daemon session show --socket "$XDG_RUNTIME_DIR/pi-daemon.sock" \
  --session worker-a

# Full authenticated API; URL defaults to http://127.0.0.1:7463
pi-daemon session list --url http://127.0.0.1:7463 \
  --token-file "$HOME/.config/pi-daemon/api-token"
```

API bearer values are accepted only from `--token-file`, `--token-fd`, or
`PI_DAEMON_BEARER_TOKEN`; there is no bearer-value argument. Non-loopback
plaintext requires `--allow-insecure-http true`. `--timeout-ms` bounds HTTP,
poll, WebSocket command, and Unix waits.

## Session CRUD

```console
pi-daemon session create \
  --url http://127.0.0.1:7463 --token-file "$TOKEN_FILE" \
  --session worker-a --name worker-a --cwd "$HOME/work/project" \
  --target new --provider github-copilot --model gpt-5-mini \
  --thinking medium --tools none \
  --idempotency-key create-worker-a --wait true

pi-daemon session list --url http://127.0.0.1:7463 \
  --token-file "$TOKEN_FILE" --limit 50

pi-daemon session show --url http://127.0.0.1:7463 \
  --token-file "$TOKEN_FILE" --session worker-a
```

Updates and deletes require the exact `generation` and `revision` returned by
`session show`; the CLI fetches and supplies the strong ETag before mutation:

```console
pi-daemon session update \
  --url http://127.0.0.1:7463 --token-file "$TOKEN_FILE" \
  --session worker-a --generation 1 --revision 3 \
  --cwd "$HOME/work/project" --target continue --name worker-renamed \
  --idempotency-key update-worker-a --wait true

pi-daemon session delete \
  --url http://127.0.0.1:7463 --token-file "$TOKEN_FILE" \
  --session worker-renamed --generation 2 --revision 5 \
  --idempotency-key delete-worker-a --retain false --wait true
```

For the complete typed `SessionSpec`, use an owner-only `--spec-file`. A
`--spec-json` value is accepted only when it contains no raw `env` values, so
secrets do not enter argv. The concise flags cover cwd/name/agentDir, target,
model/thinking, tool mode/include/exclude, and system prompt.

The Unix target supports resident `create`/`update` (`open`), `show` (`status`),
`delete` (`close`), prompt, and controls. Catalog list, dormant mutation,
tickets, RPC, and ACP require the API target.

## Tickets

```console
pi-daemon ticket get --url "$URL" --token-file "$TOKEN_FILE" --ticket TICKET_ID
pi-daemon ticket wait --url "$URL" --token-file "$TOKEN_FILE" \
  --ticket TICKET_ID --timeout-ms 30000 --poll-ms 100

pi-daemon ticket reconcile --url "$URL" --token-file "$TOKEN_FILE" \
  --ticket TICKET_ID --state failed --pi-entry-ids ENTRY_ID_1,ENTRY_ID_2 \
  --error-code operator_reconciled --error-message "Confirmed failed" \
  --retryable false
```

Reconciliation is explicit evidence for an indeterminate request; it does not
blindly replay provider work.

## Prompt and control

```console
pi-daemon prompt --url "$URL" --token-file "$TOKEN_FILE" \
  --session worker-a --generation 2 --message "Summarize current status"

pi-daemon control steer --url "$URL" --token-file "$TOKEN_FILE" \
  --session worker-a --generation 2 --message "Focus on tests"
pi-daemon control follow-up --url "$URL" --token-file "$TOKEN_FILE" \
  --session worker-a --generation 2 --message "Then update docs"
pi-daemon control abort --url "$URL" --token-file "$TOKEN_FILE" \
  --session worker-a --generation 2
```

API prompts use the framed Pi RPC attachment and wait for `agent_settled` with
bounded aggregate output/event retention. Unix prompts use durable `wake` and
an idempotency key.

## RPC and ACP

Use the installed stock-JSONL bridge through the main CLI:

```console
pi-daemon rpc attach --url "$URL" --session worker-a \
  --token-file "$TOKEN_FILE"
```

Or discover exact, generation-pinned endpoints without printing the bearer:

```console
pi-daemon rpc discover --url "$URL" --token-file "$TOKEN_FILE" --session worker-a
pi-daemon acp discover --url "$URL" --token-file "$TOKEN_FILE" --session worker-a
```

Discovery returns the canonical session ID, generation, residency, WebSocket
URL, required subprotocol, and `bearerRequired: true`.
