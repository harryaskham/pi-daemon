#!/usr/bin/env bash
set -euo pipefail

umask 077

: "${RUNNER_TEMP:?RUNNER_TEMP must be set}"
: "${GITHUB_ENV:?GITHUB_ENV must be set}"

identity_dir="$RUNNER_TEMP/pi-droid-sops-identity"
mkdir -p "$identity_dir"
chmod 700 "$identity_dir"

reject_unsafe_path() {
  local value="$1"
  if [[ "$value" == *$'\n'* || "$value" == *$'\r'* ]]; then
    printf '%s\n' 'the configured SOPS identity path is invalid' >&2
    exit 66
  fi
}

require_readable_file() {
  local value="$1"
  reject_unsafe_path "$value"
  if [[ ! -f "$value" || ! -r "$value" ]]; then
    printf '%s\n' 'the configured SOPS identity must name a readable file' >&2
    exit 66
  fi
}

materialize_content() {
  local content="$1"
  local target="$2"
  printf '%s' "$content" > "$target"
  chmod 600 "$target"
}

export_identity_files() {
  local age_file="$1"
  local ssh_file="$2"
  {
    printf 'PI_DROID_SOPS_AGE_KEY_FILE=%s\n' "$age_file"
    printf 'PI_DROID_SOPS_SSH_PRIVATE_KEY_FILE=%s\n' "$ssh_file"
  } >> "$GITHUB_ENV"
}

if [[ -n "${PI_DROID_SOPS_AGE_KEY:-}" ]]; then
  age_file="$identity_dir/age-identity.txt"
  materialize_content "$PI_DROID_SOPS_AGE_KEY" "$age_file"
  export_identity_files "$age_file" ''
elif [[ -n "${PI_DROID_SOPS_SSH_PRIVATE_KEY:-}" ]]; then
  ssh_file="$identity_dir/ssh-private-key"
  materialize_content "$PI_DROID_SOPS_SSH_PRIVATE_KEY" "$ssh_file"
  export_identity_files '' "$ssh_file"
elif [[ -n "${PI_DROID_SOPS_AGE_KEY_FILE:-}" ]]; then
  require_readable_file "$PI_DROID_SOPS_AGE_KEY_FILE"
  export_identity_files "$PI_DROID_SOPS_AGE_KEY_FILE" ''
elif [[ -n "${PI_DROID_SOPS_SSH_PRIVATE_KEY_FILE:-}" ]]; then
  require_readable_file "$PI_DROID_SOPS_SSH_PRIVATE_KEY_FILE"
  export_identity_files '' "$PI_DROID_SOPS_SSH_PRIVATE_KEY_FILE"
else
  printf '%s\n' 'SOPS age or SSH identity content or readable file must be configured for google-play-internal' >&2
  exit 78
fi
