#!/usr/bin/env bash
set -euo pipefail
umask 077

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$repo_root"

if [[ "${IN_NIX_SHELL:-}" != 'impure' && "${IN_NIX_SHELL:-}" != 'pure' ]]; then
  printf '%s\n' 'install-local.sh must run inside the Pi Daemon Nix dev shell' >&2
  exit 78
fi

prefix="${PI_DAEMON_INSTALL_PREFIX:-${HOME:?HOME is required}/.local}"
if [[ "$prefix" != /* || "$prefix" == '/' ]]; then
  printf '%s\n' 'PI_DAEMON_INSTALL_PREFIX must be an absolute non-root path' >&2
  exit 64
fi

stage="$(mktemp -d "${TMPDIR:-/tmp}/pi-daemon-install.XXXXXX")"
cleanup() {
  rm -rf "$stage"
}
trap cleanup EXIT INT TERM

printf '%s\n' 'Installing locked dependencies...'
npm ci --ignore-scripts --no-audit --no-fund

printf '%s\n' 'Building and packing Pi Daemon from the current checkout...'
npm pack --pack-destination "$stage" --silent >/dev/null
shopt -s nullglob
packages=("$stage"/*.tgz)
shopt -u nullglob
if [[ "${#packages[@]}" -ne 1 ]]; then
  printf 'expected one npm package, found %s\n' "${#packages[@]}" >&2
  exit 65
fi

mkdir -p "$prefix"
printf 'Installing portable npm package under %s...\n' "$prefix"
npm install \
  --global \
  --prefix "$prefix" \
  --ignore-scripts \
  --omit=dev \
  --no-audit \
  --no-fund \
  --force \
  "${packages[0]}"

expected_version="$(node -p 'require("./package.json").version')"
daemon_bin="$prefix/bin/pi-daemon"
rpc_bin="$prefix/bin/pi-daemon-rpc"
for executable in "$daemon_bin" "$rpc_bin"; do
  if [[ ! -x "$executable" ]]; then
    printf 'installed executable is unavailable: %s\n' "$executable" >&2
    exit 66
  fi
  resolved="$(node -e 'process.stdout.write(require("node:fs").realpathSync(process.argv[1]))' "$executable")"
  if [[ "$resolved" == /nix/store/* ]]; then
    printf 'installed executable unexpectedly resolves into the Nix store: %s\n' "$executable" >&2
    exit 65
  fi
done

actual_daemon_version="$("$daemon_bin" version)"
actual_rpc_version="$("$rpc_bin" --version)"
if [[ "$actual_daemon_version" != "$expected_version" || "$actual_rpc_version" != "$expected_version" ]]; then
  printf 'installed version mismatch: expected=%s daemon=%s rpc=%s\n' \
    "$expected_version" "$actual_daemon_version" "$actual_rpc_version" >&2
  exit 65
fi

printf 'Installed Pi Daemon %s from current HEAD %s\n' \
  "$expected_version" "$(git rev-parse --short=12 HEAD)"
printf '  %s\n  %s\n' "$daemon_bin" "$rpc_bin"
printf '%s\n' 'No service was restarted.'
