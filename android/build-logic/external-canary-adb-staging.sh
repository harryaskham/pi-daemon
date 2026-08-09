#!/usr/bin/env bash

# Bounded owner-private import staging for the external Pi Droid canary. The
# sourcing harness provides isolated_adb_command. Payload bytes travel only on
# stdin to an app-sandboxed, no-PTY shell-v2 command.

record_external_canary_staging_result() {
  local receipt_file="$1"
  local status="$2"
  local code="$3"
  local deadline_seconds="$4"
  local bytes="${5:-}"
  if [[ -e "$receipt_file" || -L "$receipt_file" ]]; then
    return 70
  fi
  if [[ "$status" == 'staged' && "$bytes" =~ ^[1-9][0-9]{0,4}$ ]]; then
    printf 'status=staged code=verified mode=600 bytes=%s exact_bytes=true deadline_seconds=%s transport=adb_shell_v2_no_pty\n' \
      "$bytes" "$deadline_seconds" > "$receipt_file"
  else
    printf 'status=failed code=%s app_launch=false deadline_seconds=%s transport=adb_shell_v2_no_pty\n' \
      "$code" "$deadline_seconds" > "$receipt_file"
  fi
  chmod 600 "$receipt_file"
}

fail_external_canary_staging() {
  local receipt_file="$1"
  local code="$2"
  local deadline_seconds="$3"
  record_external_canary_staging_result "$receipt_file" failed "$code" "$deadline_seconds" || true
  printf 'external_canary_staging_failed code=%s\n' "$code" >&2
  return 70
}

stage_external_canary_import() {
  local device_serial="${1:-}"
  local package_name="${2:-}"
  local staging_file="${3:-}"
  local artifacts_dir="${4:-}"
  local deadline_seconds="${5:-30}"
  local verification_deadline_seconds=10
  local receipt_file="$artifacts_dir/external-canary-staging.log"
  local local_metadata=''
  local local_mode=''
  local local_size=''
  local local_uid=''
  local local_digest_output=''
  local local_digest=''
  local adb_status=0
  local verification=''
  local verification_status=0
  local verification_lines=()
  local remote_mode_size=''
  local remote_digest_line=''
  local remote_digest=''
  local extra_line=''

  if [[ ! "$deadline_seconds" =~ ^[1-9][0-9]*$ ]] || (( deadline_seconds > 30 )); then
    fail_external_canary_staging "$receipt_file" adb_staging_contract_invalid 30
    return 70
  fi
  (( deadline_seconds < verification_deadline_seconds )) && verification_deadline_seconds="$deadline_seconds"
  if ! declare -p isolated_adb_command >/dev/null 2>&1 ||
    [[ ! "$device_serial" =~ ^[A-Za-z0-9._:-]{1,128}$ ]] ||
    [[ ! "$package_name" =~ ^[A-Za-z][A-Za-z0-9._]{0,255}$ ]] ||
    [[ ! -d "$artifacts_dir" || -L "$artifacts_dir" ]] ||
    [[ ! -f "$staging_file" || -L "$staging_file" ]]; then
    fail_external_canary_staging "$receipt_file" adb_staging_contract_invalid "$deadline_seconds"
    return 70
  fi
  if ! local_metadata="$(stat -c '%a:%s:%u' -- "$staging_file" 2>/dev/null)"; then
    fail_external_canary_staging "$receipt_file" adb_staging_source_invalid "$deadline_seconds"
    return 70
  fi
  IFS=: read -r local_mode local_size local_uid extra_line <<< "$local_metadata"
  if [[ -n "$extra_line" || "$local_mode" != '600' || ! "$local_size" =~ ^[1-9][0-9]{0,4}$ ||
        ! "$local_uid" =~ ^[0-9]+$ ]] || (( local_size > 24576 || local_uid != EUID )); then
    fail_external_canary_staging "$receipt_file" adb_staging_source_invalid "$deadline_seconds"
    return 70
  fi
  if ! local_digest_output="$(sha256sum -- "$staging_file" 2>/dev/null)"; then
    fail_external_canary_staging "$receipt_file" adb_staging_source_invalid "$deadline_seconds"
    return 70
  fi
  local_digest="${local_digest_output%%[[:space:]]*}"
  if [[ ! "$local_digest" =~ ^[0-9a-f]{64}$ ]]; then
    fail_external_canary_staging "$receipt_file" adb_staging_source_invalid "$deadline_seconds"
    return 70
  fi

  if {
    timeout --signal=TERM --kill-after=2s "${deadline_seconds}s" \
      "${isolated_adb_command[@]}" -s "$device_serial" shell -T \
      run-as "$package_name" sh -c \
      'umask 077; mkdir -p no_backup; cat > no_backup/external-canary-import.json; chmod 600 no_backup/external-canary-import.json' \
      < "$staging_file" > /dev/null
  } 2> /dev/null; then
    adb_status=0
  else
    adb_status=$?
  fi
  if (( adb_status == 124 || adb_status == 137 )); then
    fail_external_canary_staging "$receipt_file" adb_staging_timeout "$deadline_seconds"
    return 70
  fi
  if (( adb_status != 0 )); then
    fail_external_canary_staging "$receipt_file" adb_staging_failed "$deadline_seconds"
    return 70
  fi

  if verification="$({
    timeout --signal=TERM --kill-after=2s "${verification_deadline_seconds}s" \
      "${isolated_adb_command[@]}" -s "$device_serial" shell -T \
      run-as "$package_name" sh -c \
      'stat -c "%a:%s" no_backup/external-canary-import.json && sha256sum no_backup/external-canary-import.json'
  } 2> /dev/null)"; then
    verification_status=0
  else
    verification_status=$?
  fi
  if (( verification_status == 124 || verification_status == 137 )); then
    fail_external_canary_staging "$receipt_file" adb_staging_timeout "$deadline_seconds"
    return 70
  fi
  if (( verification_status != 0 )); then
    fail_external_canary_staging "$receipt_file" adb_staging_verification_failed "$deadline_seconds"
    return 70
  fi
  mapfile -t verification_lines <<< "$verification"
  if (( ${#verification_lines[@]} == 2 )); then
    remote_mode_size="${verification_lines[0]}"
    remote_digest_line="${verification_lines[1]}"
  fi
  remote_digest="${remote_digest_line%%[[:space:]]*}"
  if (( ${#verification_lines[@]} != 2 )) || [[ "$remote_mode_size" != "600:$local_size" ||
        ! "$remote_digest" =~ ^[0-9a-f]{64}$ || "$remote_digest" != "$local_digest" ]]; then
    fail_external_canary_staging "$receipt_file" adb_staging_verification_failed "$deadline_seconds"
    return 70
  fi

  record_external_canary_staging_result "$receipt_file" staged verified "$deadline_seconds" "$local_size" || {
    printf '%s\n' 'external_canary_staging_failed code=adb_staging_receipt_failed' >&2
    return 70
  }
}
