#!/usr/bin/env bash

# Bounded owner-private import staging for the external Pi Droid canary. The
# sourcing harness provides isolated_adb_command. Payload bytes travel only on
# stdin to app-sandboxed, no-PTY shell-v2 commands. Every remote primitive uses
# the remaining portion of one shared staging deadline.

record_external_canary_staging_result() {
  local receipt_file="$1"
  local status="$2"
  local code="$3"
  local deadline_seconds="$4"
  local bytes="${5:-}"
  local phase="${6:-}"
  local phase_field=''
  if [[ -e "$receipt_file" || -L "$receipt_file" ]]; then
    return 70
  fi
  if [[ -n "$phase" ]]; then
    case "$phase" in
      mkdir|write|chmod|stat|sha256|verification) phase_field=" phase=$phase" ;;
      *) return 70 ;;
    esac
  fi
  if [[ "$status" == 'staged' && "$bytes" =~ ^[1-9][0-9]{0,4}$ ]]; then
    printf 'status=staged code=verified mode=600 bytes=%s exact_bytes=true deadline_seconds=%s budget=shared transport=adb_shell_v2_no_pty\n' \
      "$bytes" "$deadline_seconds" > "$receipt_file"
  else
    printf 'status=failed code=%s%s app_launch=false deadline_seconds=%s budget=shared transport=adb_shell_v2_no_pty\n' \
      "$code" "$phase_field" "$deadline_seconds" > "$receipt_file"
  fi
  chmod 600 "$receipt_file"
}

fail_external_canary_staging() {
  local receipt_file="$1"
  local code="$2"
  local deadline_seconds="$3"
  local phase="${4:-}"
  local phase_field=''
  [[ -n "$phase" ]] && phase_field=" phase=$phase"
  record_external_canary_staging_result \
    "$receipt_file" failed "$code" "$deadline_seconds" '' "$phase" || true
  printf 'external_canary_staging_failed code=%s%s\n' "$code" "$phase_field" >&2
  return 70
}

external_canary_staging_now_millis() {
  local epoch_realtime="${EPOCHREALTIME:-}"
  local seconds_part=''
  local fraction_part=''
  if [[ "$epoch_realtime" =~ ^([0-9]+)\.([0-9]{6})$ ]]; then
    seconds_part="${BASH_REMATCH[1]}"
    fraction_part="${BASH_REMATCH[2]}"
    printf '%s\n' "$((10#$seconds_part * 1000 + 10#${fraction_part:0:3}))"
    return 0
  fi
  "${EXTERNAL_CANARY_PYTHON_BIN:-python3}" -c \
    'import time; print(time.monotonic_ns() // 1_000_000)' 2>/dev/null
}

external_canary_staging_duration() {
  local milliseconds="$1"
  printf '%d.%03ds' "$((milliseconds / 1000))" "$((milliseconds % 1000))"
}

# Populates external_canary_staging_timeout with a timeout command whose TERM
# grace is included in (never added after) the remaining shared deadline.
external_canary_staging_prepare_timeout() {
  local deadline_millis="$1"
  local now_millis=''
  local remaining_millis=0
  local term_grace_millis=200
  local soft_millis=0
  local remaining_duration=''
  local soft_duration=''
  local grace_duration=''

  if ! now_millis="$(external_canary_staging_now_millis)" ||
    [[ ! "$now_millis" =~ ^[0-9]+$ ]]; then
    return 70
  fi
  remaining_millis=$((deadline_millis - now_millis - 25))
  (( remaining_millis > 0 )) || return 124
  remaining_duration="$(external_canary_staging_duration "$remaining_millis")"
  if (( remaining_millis > term_grace_millis )); then
    soft_millis=$((remaining_millis - term_grace_millis))
    soft_duration="$(external_canary_staging_duration "$soft_millis")"
    grace_duration="$(external_canary_staging_duration "$term_grace_millis")"
    external_canary_staging_timeout=(
      timeout --signal=TERM --kill-after="$grace_duration" "$soft_duration"
    )
  else
    external_canary_staging_timeout=(timeout --signal=KILL "$remaining_duration")
  fi
}

external_canary_staging_status_is_timeout() {
  (( $1 == 124 || $1 == 137 ))
}

stage_external_canary_import() {
  local device_serial="${1:-}"
  local package_name="${2:-}"
  local staging_file="${3:-}"
  local artifacts_dir="${4:-}"
  local deadline_seconds="${5:-30}"
  local receipt_file="$artifacts_dir/external-canary-staging.log"
  local remote_import_file='no_backup/external-canary-import.json'
  local local_metadata=''
  local local_mode=''
  local local_size=''
  local local_uid=''
  local local_digest_output=''
  local local_digest=''
  local start_millis=''
  local deadline_millis=0
  local primitive_status=0
  local remote_mode_size=''
  local remote_digest_output=''
  local remote_digest=''
  local extra_line=''

  if [[ ! "$deadline_seconds" =~ ^[1-9][0-9]*$ ]] || (( deadline_seconds > 30 )); then
    fail_external_canary_staging "$receipt_file" adb_staging_contract_invalid 30
    return 70
  fi
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
  if ! start_millis="$(external_canary_staging_now_millis)" ||
    [[ ! "$start_millis" =~ ^[0-9]+$ ]]; then
    fail_external_canary_staging "$receipt_file" adb_staging_contract_invalid "$deadline_seconds"
    return 70
  fi
  deadline_millis=$((start_millis + deadline_seconds * 1000))

  primitive_status=0
  if external_canary_staging_prepare_timeout "$deadline_millis"; then
    if {
      "${external_canary_staging_timeout[@]}" \
        "${isolated_adb_command[@]}" -s "$device_serial" shell -T \
        run-as "$package_name" mkdir -p no_backup </dev/null > /dev/null
    } 2>/dev/null; then
      primitive_status=0
    else
      primitive_status=$?
    fi
  else
    primitive_status=$?
  fi
  if external_canary_staging_status_is_timeout "$primitive_status"; then
    fail_external_canary_staging "$receipt_file" adb_staging_timeout "$deadline_seconds" mkdir
    return 70
  elif (( primitive_status != 0 )); then
    fail_external_canary_staging "$receipt_file" adb_staging_mkdir_failed "$deadline_seconds" mkdir
    return 70
  fi

  primitive_status=0
  if external_canary_staging_prepare_timeout "$deadline_millis"; then
    if {
      "${external_canary_staging_timeout[@]}" \
        "${isolated_adb_command[@]}" -s "$device_serial" shell -T \
        run-as "$package_name" tee "$remote_import_file" \
        < "$staging_file" > /dev/null
    } 2>/dev/null; then
      primitive_status=0
    else
      primitive_status=$?
    fi
  else
    primitive_status=$?
  fi
  if external_canary_staging_status_is_timeout "$primitive_status"; then
    fail_external_canary_staging "$receipt_file" adb_staging_timeout "$deadline_seconds" write
    return 70
  elif (( primitive_status != 0 )); then
    fail_external_canary_staging "$receipt_file" adb_staging_write_failed "$deadline_seconds" write
    return 70
  fi

  primitive_status=0
  if external_canary_staging_prepare_timeout "$deadline_millis"; then
    if {
      "${external_canary_staging_timeout[@]}" \
        "${isolated_adb_command[@]}" -s "$device_serial" shell -T \
        run-as "$package_name" chmod 600 "$remote_import_file" </dev/null > /dev/null
    } 2>/dev/null; then
      primitive_status=0
    else
      primitive_status=$?
    fi
  else
    primitive_status=$?
  fi
  if external_canary_staging_status_is_timeout "$primitive_status"; then
    fail_external_canary_staging "$receipt_file" adb_staging_timeout "$deadline_seconds" chmod
    return 70
  elif (( primitive_status != 0 )); then
    fail_external_canary_staging "$receipt_file" adb_staging_chmod_failed "$deadline_seconds" chmod
    return 70
  fi

  primitive_status=0
  if external_canary_staging_prepare_timeout "$deadline_millis"; then
    if remote_mode_size="$({
      "${external_canary_staging_timeout[@]}" \
        "${isolated_adb_command[@]}" -s "$device_serial" shell -T \
        run-as "$package_name" stat -c '%a:%s' "$remote_import_file" </dev/null
    } 2>/dev/null)"; then
      primitive_status=0
    else
      primitive_status=$?
    fi
  else
    primitive_status=$?
  fi
  if external_canary_staging_status_is_timeout "$primitive_status"; then
    fail_external_canary_staging "$receipt_file" adb_staging_timeout "$deadline_seconds" stat
    return 70
  elif (( primitive_status != 0 )); then
    fail_external_canary_staging "$receipt_file" adb_staging_verification_failed "$deadline_seconds" stat
    return 70
  fi

  primitive_status=0
  if external_canary_staging_prepare_timeout "$deadline_millis"; then
    if remote_digest_output="$({
      "${external_canary_staging_timeout[@]}" \
        "${isolated_adb_command[@]}" -s "$device_serial" shell -T \
        run-as "$package_name" sha256sum "$remote_import_file" </dev/null
    } 2>/dev/null)"; then
      primitive_status=0
    else
      primitive_status=$?
    fi
  else
    primitive_status=$?
  fi
  if external_canary_staging_status_is_timeout "$primitive_status"; then
    fail_external_canary_staging "$receipt_file" adb_staging_timeout "$deadline_seconds" sha256
    return 70
  elif (( primitive_status != 0 )); then
    fail_external_canary_staging "$receipt_file" adb_staging_verification_failed "$deadline_seconds" sha256
    return 70
  fi

  remote_digest="${remote_digest_output%%[[:space:]]*}"
  if [[ "$remote_mode_size" == *$'\n'* || "$remote_digest_output" == *$'\n'* ||
        "$remote_mode_size" != "600:$local_size" || ! "$remote_digest" =~ ^[0-9a-f]{64}$ ||
        "$remote_digest" != "$local_digest" ]]; then
    fail_external_canary_staging "$receipt_file" adb_staging_verification_failed "$deadline_seconds" verification
    return 70
  fi

  record_external_canary_staging_result \
    "$receipt_file" staged verified "$deadline_seconds" "$local_size" || {
    printf '%s\n' 'external_canary_staging_failed code=adb_staging_receipt_failed' >&2
    return 70
  }
}
