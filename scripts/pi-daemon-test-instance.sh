#!/usr/bin/env bash
set -euo pipefail

# A deliberately non-launchd rolling developer instance. Every path and port is
# separate from Home Manager's primary daemon-main service. Override the PI_* env
# values for another operator/node without editing this script.
INSTANCE="${PI_DAEMON_TEST_INSTANCE:-test}"
SOURCE="${PI_DAEMON_TEST_SOURCE:-$HOME/.local/share/pi-daemon-test/source}"
STATE="${PI_DAEMON_TEST_STATE:-$HOME/.local/state/pi-daemon/test}"
CONFIG="${PI_DAEMON_TEST_CONFIG:-$HOME/.config/pi/daemon/test/config.yaml}"
REMOTE="${PI_DAEMON_TEST_REMOTE:-ssh://git@github.com/harryaskham/pi-daemon.git}"
BRANCH="${PI_DAEMON_TEST_BRANCH:-main}"
TMUX_SESSION="${PI_DAEMON_TEST_TMUX:-pi-daemon-test}"
CURRENT="$STATE/current"
LOG="$STATE/service.log"
LOCK="$STATE/update.lock"

usage() {
  cat <<'EOF'
usage: pi-daemon-test-instance.sh <install|update|start|stop|restart|status|logs|attach|paths>

  install   clone/build exact upstream main, then start the isolated instance
  update    fast-forward source, Nix-build/test it, atomically switch, restart if running
  start     start current immutable Nix result in a detached tmux session
  stop      bounded SIGINT stop; kill only the named tmux session if needed
  restart   stop then start
  status    show exact source/result and probe the owner-only Unix socket
  logs      tail the isolated service log
  attach    attach interactively to the non-launchd tmux supervisor
  paths     print resolved source/config/state/session values
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
  printf 'instance=%s\nsource=%s\nconfig=%s\nstate=%s\ntmux=%s\n' \
    "$INSTANCE" "$SOURCE" "$CONFIG" "$STATE" "$TMUX_SESSION"
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
  install)
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
    printf 'instance=%s\nsource=%s\nconfig=%s\nstate=%s\ntmux=%s\n' \
      "$INSTANCE" "$SOURCE" "$CONFIG" "$STATE" "$TMUX_SESSION"
    ;;
  *)
    usage >&2
    exit 64
    ;;
esac
