#!/usr/bin/env bash
set -euo pipefail

umask 077

: "${RUNNER_TEMP:?RUNNER_TEMP must be set}"
: "${GITHUB_ENV:?GITHUB_ENV must be set}"

required_names=(
  PI_DROID_RELEASE_KEYSTORE_BASE64
  PI_DROID_RELEASE_KEY_ALIAS
  PI_DROID_RELEASE_STORE_PASSWORD
  PI_DROID_RELEASE_KEY_PASSWORD
  PI_DROID_GOOGLE_PLAY_SERVICE_ACCOUNT_JSON
)
for name in "${required_names[@]}"; do
  if [[ -z "${!name:-}" ]]; then
    printf 'required Play release secret is missing: %s\n' "$name" >&2
    exit 78
  fi
done

secret_dir="$RUNNER_TEMP/pi-droid-play-release-secrets"
mkdir -p "$secret_dir"
chmod 700 "$secret_dir"

keystore_file="$secret_dir/pi-droid-release.p12"
alias_file="$secret_dir/key-alias.txt"
store_password_file="$secret_dir/store-password.txt"
key_password_file="$secret_dir/key-password.txt"
service_account_file="$secret_dir/play-service-account.json"

if base64 --help 2>&1 | grep -q -- '--decode'; then
  printf '%s' "$PI_DROID_RELEASE_KEYSTORE_BASE64" | base64 --decode > "$keystore_file"
else
  printf '%s' "$PI_DROID_RELEASE_KEYSTORE_BASE64" | base64 -D > "$keystore_file"
fi
if [[ ! -s "$keystore_file" ]]; then
  printf '%s\n' 'the configured Play release keystore content is invalid' >&2
  exit 65
fi
printf '%s' "$PI_DROID_RELEASE_KEY_ALIAS" > "$alias_file"
printf '%s' "$PI_DROID_RELEASE_STORE_PASSWORD" > "$store_password_file"
printf '%s' "$PI_DROID_RELEASE_KEY_PASSWORD" > "$key_password_file"
printf '%s' "$PI_DROID_GOOGLE_PLAY_SERVICE_ACCOUNT_JSON" > "$service_account_file"
chmod 600 "$keystore_file" "$alias_file" "$store_password_file" "$key_password_file" "$service_account_file"

{
  printf 'PI_DROID_RELEASE_KEYSTORE=%s\n' "$keystore_file"
  printf 'PI_DROID_RELEASE_KEY_ALIAS_FILE=%s\n' "$alias_file"
  printf 'PI_DROID_RELEASE_STORE_PASSWORD_FILE=%s\n' "$store_password_file"
  printf 'PI_DROID_RELEASE_KEY_PASSWORD_FILE=%s\n' "$key_password_file"
  printf 'PI_DROID_PLAY_SERVICE_ACCOUNT_FILE=%s\n' "$service_account_file"
} >> "$GITHUB_ENV"
