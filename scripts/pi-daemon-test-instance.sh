#!/usr/bin/env bash
set -euo pipefail

# A deliberately non-launchd rolling developer instance. Every path and port is
# separate from Home Manager's primary daemon-main service. Override the PI_* env
# values for another operator/node without editing this script.
INSTANCE="${PI_DAEMON_TEST_INSTANCE:-test}"
SOURCE="${PI_DAEMON_TEST_SOURCE:-$HOME/.local/share/pi-daemon-test/source}"
STATE="${PI_DAEMON_TEST_STATE:-$HOME/.local/state/pi-daemon/$INSTANCE}"
CONFIG="${PI_DAEMON_TEST_CONFIG:-$HOME/.config/pi/daemon/$INSTANCE/config.yaml}"
AGENT_DIR="${PI_DAEMON_TEST_AGENT_DIR:-$HOME/.pi/daemon-$INSTANCE}"
ALLOWED_ROOT="${PI_DAEMON_TEST_ALLOWED_ROOT:-$HOME/work}"
NORMAL_SESSIONS_ROOT="${PI_DAEMON_TEST_NORMAL_SESSIONS_ROOT:-$HOME/.pi/agent/sessions}"
API_PORT="${PI_DAEMON_TEST_API_PORT:-7473}"
WEB_PORT="${PI_DAEMON_TEST_WEB_PORT:-7474}"
REMOTE="${PI_DAEMON_TEST_REMOTE:-ssh://git@github.com/harryaskham/pi-daemon.git}"
BRANCH="${PI_DAEMON_TEST_BRANCH:-main}"
TMUX_SESSION="${PI_DAEMON_TEST_TMUX:-pi-daemon-$INSTANCE}"
CURRENT="$STATE/current"
LOG="$STATE/service.log"
LOCK="$STATE/update.lock"

usage() {
  cat <<'EOF'
usage: pi-daemon-test-instance.sh <init-config|install|update|start|stop|restart|status|logs|attach|paths>

  init-config  create a safe owner-private config if absent (never overwrite)
  install   initialize config, clone/build exact upstream main, then start
  update    fast-forward source, Nix-build/test it, atomically switch, restart if running
  start     start current immutable Nix result in a detached tmux session
  stop      bounded SIGINT stop; kill only the named tmux session if needed
  restart   stop then start
  status    show exact source/result and probe the owner-only Unix socket
  logs      tail the isolated service log
  attach    attach interactively to the non-launchd tmux supervisor
  paths     print resolved source/config/state/session values

New-node one-liner (with just installed): `just test-daemon`.
Override PI_DAEMON_TEST_ALLOWED_ROOT/API_PORT/WEB_PORT before first install.
EOF
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || {
    printf 'required command not found: %s\n' "$1" >&2
    exit 69
  }
}

is_running() {
  tmux has-session -t "$TMUX_SESSION" 2>/dev/null
}

acquire_update_lock() {
  install -d -m 700 "$STATE"
  if ! mkdir "$LOCK" 2>/dev/null; then
    printf 'another test-instance update holds %s\n' "$LOCK" >&2
    exit 75
  fi
  trap 'rmdir "$LOCK" 2>/dev/null || true' EXIT INT TERM
}

yaml_quote() {
  local value="$1"
  [[ "$value" != *$'\n'* && "$value" != *$'\r'* ]] || {
    printf 'config path contains a newline\n' >&2
    exit 65
  }
  value="${value//\'/\'\'}"
  printf "'%s'" "$value"
}

init_config() {
  if [[ -f "$CONFIG" ]]; then
    printf 'test instance config already exists: %s\n' "$CONFIG"
    return 0
  fi
  [[ "$API_PORT" =~ ^[0-9]+$ && "$API_PORT" -ge 1 && "$API_PORT" -le 65535 ]] || {
    printf 'invalid PI_DAEMON_TEST_API_PORT: %s\n' "$API_PORT" >&2
    exit 65
  }
  [[ "$WEB_PORT" =~ ^[0-9]+$ && "$WEB_PORT" -ge 1 && "$WEB_PORT" -le 65535 && "$WEB_PORT" != "$API_PORT" ]] || {
    printf 'invalid or colliding PI_DAEMON_TEST_WEB_PORT: %s\n' "$WEB_PORT" >&2
    exit 65
  }
  install -d -m 700 "$(dirname "$CONFIG")" "$STATE" "$STATE/run" "$AGENT_DIR" \
    "$AGENT_DIR/sessions" "$NORMAL_SESSIONS_ROOT" "$ALLOWED_ROOT"
  local temporary="$CONFIG.tmp.$$"
  umask 077
  cat >"$temporary" <<EOF
instance: $(yaml_quote "$INSTANCE")
stateDir: $(yaml_quote "$STATE")
socketPath: $(yaml_quote "$STATE/run/pi-daemon.sock")
agentDir: $(yaml_quote "$AGENT_DIR")
allowedRoots:
  - $(yaml_quote "$ALLOWED_ROOT")
sessionStorage:
  mode: daemon-owned
limits:
  maxSessions: 32
  maxConcurrentTurns: 4
  maxSessionQueueDepth: 16
  idleSessionTtlMs: 1800000
  maxConnections: 32
  maxInFlightRequestsPerConnection: 16
api:
  enabled: true
  bind: 127.0.0.1
  port: $API_PORT
  allowInsecureHttp: false
web:
  enabled: true
  mode: embedded
  bind: 127.0.0.1
  port: $WEB_PORT
  auth:
    sessionTtlMs: 43200000
  inventory:
    roots:
      - $(yaml_quote "$NORMAL_SESSIONS_ROOT")
      - $(yaml_quote "$AGENT_DIR/sessions")
    reconcileIntervalMs: 30000
    maxSessions: 10000
  residency:
    warmTtlMs: 1800000
    maxPinnedPerWorkspace: 8
  tui:
    enabled: true
    defaultPresentation: rich
    maxRows: 200
    maxColumns: 320
  ui:
    theme:
      name: nord-midnight
      density: comfortable
    editor:
      mode: multiline
EOF
  chmod 600 "$temporary"
  mv "$temporary" "$CONFIG"
  printf 'created test instance config: %s\n' "$CONFIG"
}

ensure_source() {
  require_command git
  if [[ ! -d "$SOURCE/.git" ]]; then
    install -d -m 700 "$(dirname "$SOURCE")"
    git clone --filter=blob:none --branch "$BRANCH" "$REMOTE" "$SOURCE"
  fi
  if [[ -n "$(git -C "$SOURCE" status --porcelain --untracked-files=no)" ]]; then
    printf 'refusing update: tracked changes exist in %s\n' "$SOURCE" >&2
    exit 73
  fi
}

update_instance() {
  require_command nix
  require_command tmux
  acquire_update_lock
  ensure_source
  local was_running=false
  if is_running; then was_running=true; fi
  git -C "$SOURCE" fetch --prune origin "$BRANCH"
  git -C "$SOURCE" switch "$BRANCH"
  git -C "$SOURCE" merge --ff-only "origin/$BRANCH"
  # Nix evaluates the exact checkout, verifies npm lock integrity, builds the SPA,
  # runs the full package gate, and atomically maintains CURRENT as a GC root.
  nix build "$SOURCE#pi-daemon" --print-build-logs --out-link "$CURRENT"
  printf 'test instance updated: commit=%s result=%s\n' \
    "$(git -C "$SOURCE" rev-parse --short=12 HEAD)" "$(readlink "$CURRENT")"
  if [[ "$was_running" == true ]]; then
    stop_instance
    start_instance
  fi
}

start_instance() {
  require_command tmux
  [[ -f "$CONFIG" ]] || {
    printf 'test instance config is missing: %s\n' "$CONFIG" >&2
    exit 66
  }
  [[ -x "$CURRENT/bin/pi-daemon" ]] || {
    printf 'test instance is not built; run install or update first\n' >&2
    exit 66
  }
  if is_running; then
    printf 'test instance already running in tmux session %s\n' "$TMUX_SESSION"
    return 0
  fi
  install -d -m 700 "$STATE" "$STATE/run"
  rm -f "$STATE/run/pi-daemon.sock"
  touch "$LOG"
  chmod 600 "$LOG"
  local command
  printf -v command 'exec %q serve --config %q --instance %q >>%q 2>&1' \
    "$CURRENT/bin/pi-daemon" "$CONFIG" "$INSTANCE" "$LOG"
  tmux new-session -d -s "$TMUX_SESSION" -c "$STATE" "$command"
  local attempt
  for attempt in {1..100}; do
    if [[ -S "$STATE/run/pi-daemon.sock" ]]; then
      printf 'test instance started: tmux=%s socket=%s\n' "$TMUX_SESSION" "$STATE/run/pi-daemon.sock"
      return 0
    fi
    if ! is_running; then
      printf 'test instance exited during startup; inspect %s\n' "$LOG" >&2
      exit 70
    fi
    sleep 0.1
  done
  printf 'test instance did not create its socket within 10 seconds\n' >&2
  stop_instance
  exit 70
}

stop_instance() {
  require_command tmux
  if ! is_running; then
    printf 'test instance is not running\n'
    return 0
  fi
  tmux send-keys -t "$TMUX_SESSION" C-c
  local attempt
  for attempt in {1..100}; do
    if ! is_running; then
      rm -f "$STATE/run/pi-daemon.sock"
      printf 'test instance stopped\n'
      return 0
    fi
    sleep 0.1
  done
  printf 'test instance exceeded graceful stop deadline; killing only tmux session %s\n' "$TMUX_SESSION" >&2
  tmux kill-session -t "$TMUX_SESSION"
  rm -f "$STATE/run/pi-daemon.sock"
}

status_instance() {
  printf 'instance=%s\nsource=%s\nconfig=%s\nstate=%s\nagent_dir=%s\nallowed_root=%s\napi_url=http://127.0.0.1:%s\ndash_url=http://127.0.0.1:%s/dash/\ntmux=%s\n' \
    "$INSTANCE" "$SOURCE" "$CONFIG" "$STATE" "$AGENT_DIR" "$ALLOWED_ROOT" "$API_PORT" "$WEB_PORT" "$TMUX_SESSION"
  if [[ -d "$SOURCE/.git" ]]; then
    printf 'source_commit=%s\n' "$(git -C "$SOURCE" rev-parse HEAD)"
  else
    printf 'source_commit=missing\n'
  fi
  if [[ -L "$CURRENT" ]]; then
    printf 'nix_result=%s\n' "$(readlink "$CURRENT")"
  else
    printf 'nix_result=missing\n'
  fi
  if is_running; then
    printf 'runtime=running\n'
    "$CURRENT/bin/pi-daemon" probe --socket "$STATE/run/pi-daemon.sock" || true
  else
    printf 'runtime=stopped\n'
  fi
}

case "${1:-}" in
  init-config)
    init_config
    ;;
  install)
    init_config
    update_instance
    start_instance
    ;;
  update)
    update_instance
    ;;
  start)
    start_instance
    ;;
  stop)
    stop_instance
    ;;
  restart)
    stop_instance
    start_instance
    ;;
  status)
    status_instance
    ;;
  logs)
    install -d -m 700 "$STATE"
    touch "$LOG"
    chmod 600 "$LOG"
    tail -n 100 -f "$LOG"
    ;;
  attach)
    require_command tmux
    exec tmux attach-session -t "$TMUX_SESSION"
    ;;
  paths)
    printf 'instance=%s\nsource=%s\nconfig=%s\nstate=%s\nagent_dir=%s\nallowed_root=%s\napi_url=http://127.0.0.1:%s\ndash_url=http://127.0.0.1:%s/dash/\ntmux=%s\n' \
      "$INSTANCE" "$SOURCE" "$CONFIG" "$STATE" "$AGENT_DIR" "$ALLOWED_ROOT" "$API_PORT" "$WEB_PORT" "$TMUX_SESSION"
    ;;
  *)
    usage >&2
    exit 64
    ;;
esac
