#!/usr/bin/env bash
set -euo pipefail

log_dir="${PI_DAEMON_NIX_CI_LOG_DIR:-}"
if [[ -z "$log_dir" ]]; then
  echo "PI_DAEMON_NIX_CI_LOG_DIR must name the bounded CI log directory" >&2
  exit 64
fi
mkdir -p "$log_dir"
exec > >(tee "$log_dir/cache-state.log") 2>&1

sanitize_url() {
  sed -E \
    -e 's#^([A-Za-z][A-Za-z0-9+.-]*://)[^/@[:space:]]+@#\1[redacted]@#' \
    -e 's#[?#].*$##'
}

print_url_config() {
  local key="$1"
  local value
  printf '%s:\n' "$key"
  for value in $(nix config show "$key"); do
    printf '  - %s\n' "$(printf '%s' "$value" | sanitize_url)"
  done
}

system="$(nix eval --impure --raw --expr builtins.currentSystem)"
package_installable=".#checks.${system}.package"
npm_deps_installable=".#packages.${system}.npm-deps"
# The macOS workflow sets a run-attempt nonce. Impure evaluation is deliberate:
# telemetry must inspect the exact job-unique package output that the build will
# realize, not the canonical warm-store output with the nonce hidden.
package_path="$(nix eval --impure --raw "${package_installable}.outPath")"
npm_deps_path="$(nix eval --raw "${npm_deps_installable}.outPath")"

printf 'recorded_utc: %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
printf 'nix_version: %s\n' "$(nix --version)"
printf 'system: %s\n' "$system"
if nix store info >/dev/null 2>&1; then
  printf 'store_reachable: true\n'
else
  printf 'store_reachable: false\n'
  exit 1
fi
require_sigs="$(nix config show require-sigs)"
printf 'require_sigs: %s\n' "$require_sigs"
if [[ "$require_sigs" != true ]]; then
  echo "Nix signature verification must remain enabled" >&2
  exit 1
fi
print_url_config substituters
print_url_config trusted-substituters
printf 'trusted_public_key_names:\n'
for key in $(nix config show trusted-public-keys); do
  printf '  - %s\n' "${key%%:*}"
done

printf 'package_path: %s\n' "$package_path"
if nix path-info --offline "$package_path" >/dev/null 2>&1; then
  package_store_state="present"
else
  package_store_state="missing"
fi
printf 'package_store_state: %s\n' "$package_store_state"
printf 'npm_deps_path: %s\n' "$npm_deps_path"
if nix path-info --offline "$npm_deps_path" >/dev/null 2>&1; then
  printf 'npm_deps_store_state: present\n'
else
  printf 'npm_deps_store_state: missing\n'
fi

printf 'package_dry_run_begin:\n'
# The command may consult substituters whose configured URLs carry private
# query parameters. Exercise the plan but never persist its raw network output.
if nix build --impure --dry-run --no-link "$package_installable" >/dev/null 2>&1; then
  printf 'package_dry_run_end: success\n'
else
  # Preserve the observation, then let the real package command report the
  # complete evaluation/substitution failure instead of replacing it here.
  printf 'package_dry_run_end: failure\n'
fi

if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  printf 'system=%s\n' "$system" >> "$GITHUB_OUTPUT"
  printf 'package_store_state=%s\n' "$package_store_state" >> "$GITHUB_OUTPUT"
fi
