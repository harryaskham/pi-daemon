#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -ne 1 ]]; then
  echo "usage: $0 <nix-system>" >&2
  exit 64
fi
system="$1"
case "$system" in
  aarch64-darwin | x86_64-darwin) ;;
  *)
    echo "unsupported macOS Nix system: $system" >&2
    exit 64
    ;;
esac

for variable in RUNNER_TEMP GITHUB_RUN_ID GITHUB_RUN_ATTEMPT PI_DAEMON_NIX_CI_LOG_DIR PI_DAEMON_NIX_CI_BUILD_NONCE; do
  if [[ -z "${!variable:-}" ]]; then
    echo "$variable must be set for the isolated macOS package build" >&2
    exit 64
  fi
done
if [[ ! "$GITHUB_RUN_ID" =~ ^[1-9][0-9]*$ || ! "$GITHUB_RUN_ATTEMPT" =~ ^[1-9][0-9]*$ ]]; then
  echo "GitHub run identity must be positive decimal integers" >&2
  exit 64
fi

expected_nonce="github-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"
if [[ "$PI_DAEMON_NIX_CI_BUILD_NONCE" != "$expected_nonce" ]]; then
  echo "PI_DAEMON_NIX_CI_BUILD_NONCE does not match this GitHub run attempt" >&2
  exit 64
fi

canonical_runner_temp="$(cd "$RUNNER_TEMP" && pwd -P)"
expected_log_dir="$RUNNER_TEMP/pi-daemon-nix-macos-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"
if [[ "$PI_DAEMON_NIX_CI_LOG_DIR" != "$expected_log_dir" ]]; then
  echo "PI_DAEMON_NIX_CI_LOG_DIR must be the job-private runner directory" >&2
  exit 64
fi
mkdir -p "$PI_DAEMON_NIX_CI_LOG_DIR"
canonical_log_dir="$(cd "$PI_DAEMON_NIX_CI_LOG_DIR" && pwd -P)"
canonical_expected_log_dir="$canonical_runner_temp/pi-daemon-nix-macos-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"
if [[ "$canonical_log_dir" != "$canonical_expected_log_dir" ]]; then
  echo "job-private package directory escaped RUNNER_TEMP" >&2
  exit 64
fi

umask 077
package_root="$canonical_log_dir/package-build"
mkdir -p "$package_root"
result_link="$package_root/result"
if [[ -e "$result_link" || -L "$result_link" ]]; then
  echo "job-private package result already exists; refusing to reuse or delete it" >&2
  exit 65
fi

printf 'package_build_nonce: %s\npackage_result_link: %s\n' \
  "$PI_DAEMON_NIX_CI_BUILD_NONCE" "$result_link" > "$package_root/invocation.log"

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
exec bash "$script_dir/run-nix-ci-phase.sh" package-build \
  nix build --impure --out-link "$result_link" --print-build-logs \
  ".#checks.${system}.package"
