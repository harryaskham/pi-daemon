#!/usr/bin/env bash
set -euo pipefail

if [[ $# -eq 0 ]]; then
  printf '%s\n' 'usage: run-with-xvfb.sh COMMAND [ARG...]' >&2
  exit 64
fi

if [[ -n "${DISPLAY:-}" ]]; then
  exec "$@"
fi

if ! command -v Xvfb >/dev/null 2>&1; then
  printf '%s\n' 'Pi Droid Compose tests require Xvfb when DISPLAY is unset; enter nix develop .#android.' >&2
  exit 69
fi

runtime_dir="$(mktemp -d)"
display_file="$runtime_dir/display"
xvfb_pid=''
cleanup() {
  if [[ -n "$xvfb_pid" ]] && kill -0 "$xvfb_pid" 2>/dev/null; then
    kill "$xvfb_pid" 2>/dev/null || true
    wait "$xvfb_pid" 2>/dev/null || true
  fi
  rm -rf "$runtime_dir"
}
trap cleanup EXIT INT TERM

exec 3>"$display_file"
Xvfb -displayfd 3 -screen 0 "${PI_DROID_XVFB_SCREEN:-1920x1080x24}" -nolisten tcp >/dev/null 2>&1 &
xvfb_pid="$!"
exec 3>&-

for _ in $(seq 1 100); do
  if [[ -s "$display_file" ]]; then
    break
  fi
  if ! kill -0 "$xvfb_pid" 2>/dev/null; then
    wait "$xvfb_pid" || true
    printf '%s\n' 'Xvfb exited before assigning a display.' >&2
    exit 70
  fi
  sleep 0.05
done

if [[ ! -s "$display_file" ]]; then
  printf '%s\n' 'Timed out waiting for Xvfb to assign a display.' >&2
  exit 70
fi

display_number="$(tr -d '[:space:]' < "$display_file")"
if [[ ! "$display_number" =~ ^[0-9]+$ ]]; then
  printf 'Xvfb returned an invalid display number: %q\n' "$display_number" >&2
  exit 70
fi

export DISPLAY=":$display_number"
"$@"
