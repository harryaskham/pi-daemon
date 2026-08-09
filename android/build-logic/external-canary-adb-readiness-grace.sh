#!/usr/bin/env bash

# External-canary-only bounded extension of the shared 240-second ADB readiness
# wait. The caller owns the emulator, isolated ADB server, diagnostics file, and
# EXIT cleanup. This helper never launches, reconnects, or stops a process.

# The latch is source-owned rather than ambiently configurable.
external_canary_adb_readiness_grace_used='false'

record_external_canary_adb_readiness_grace() {
  local diagnostics_file="$1"
  local status="$2"
  local reason="$3"
  local initial_deadline_seconds="$4"
  local grace_deadline_seconds="$5"
  local hard_deadline_seconds="$6"
  local elapsed_seconds="$7"
  printf 'phase=adb_readiness_grace status=%s reason=%s initial_deadline_seconds=%s grace_deadline_seconds=%s hard_deadline_seconds=%s elapsed_seconds=%s reuse=emulator_adb_server_transport\n' \
    "$status" "$reason" "$initial_deadline_seconds" "$grace_deadline_seconds" \
    "$hard_deadline_seconds" "$elapsed_seconds" >> "$diagnostics_file"
}

maybe_grant_external_canary_adb_readiness_grace() {
  local initial_status="${1:-}"
  local readiness_started_seconds="${2:-}"
  local initial_deadline_seconds="${3:-}"
  local hard_deadline_seconds="${4:-}"
  local emulator_pid="${5:-}"
  local device_serial="${6:-}"
  local adb_server_port="${7:-}"
  local diagnostics_file="${8:-}"
  local console_state="${9:-}"
  local console_log="${10:-}"
  local classifier="${11:-}"
  local max_grace_seconds=0
  local elapsed_seconds=0
  local remaining_seconds=0
  local grace_deadline_seconds=0
  local classification=''
  local classification_status=0
  local grace_status=0
  local refusal_reason='initial_failure_not_timeout'

  if [[ ! "$initial_status" =~ ^[0-9]{1,3}$ ||
        ! "$readiness_started_seconds" =~ ^[0-9]+$ ||
        ! "$initial_deadline_seconds" =~ ^[1-9][0-9]*$ ||
        ! "$hard_deadline_seconds" =~ ^[1-9][0-9]*$ ||
        ! "$emulator_pid" =~ ^[1-9][0-9]*$ ||
        ! "$adb_server_port" =~ ^[0-9]+$ ||
        ! "$device_serial" =~ ^127\.0\.0\.1:[0-9]+$ ||
        ! -f "$diagnostics_file" || -L "$diagnostics_file" ||
        ! -f "$classifier" || -L "$classifier" ]] ||
    (( initial_deadline_seconds > 240 ||
       hard_deadline_seconds <= initial_deadline_seconds ||
       hard_deadline_seconds > 480 ||
       hard_deadline_seconds - initial_deadline_seconds > 240 )); then
    return 64
  fi

  elapsed_seconds=$((SECONDS - readiness_started_seconds))
  (( elapsed_seconds < 0 )) && elapsed_seconds=0
  if [[ "$external_canary_adb_readiness_grace_used" != 'false' ]]; then
    record_external_canary_adb_readiness_grace \
      "$diagnostics_file" refused already_used "$initial_deadline_seconds" 0 \
      "$hard_deadline_seconds" "$elapsed_seconds"
    return 70
  fi
  if (( initial_status != 70 )); then
    (( initial_status == 69 )) && refusal_reason='emulator_not_alive'
    record_external_canary_adb_readiness_grace \
      "$diagnostics_file" refused "$refusal_reason" "$initial_deadline_seconds" 0 \
      "$hard_deadline_seconds" "$elapsed_seconds"
    return 70
  fi
  if ! kill -0 "$emulator_pid" 2>/dev/null; then
    record_external_canary_adb_readiness_grace \
      "$diagnostics_file" refused emulator_not_alive "$initial_deadline_seconds" 0 \
      "$hard_deadline_seconds" "$elapsed_seconds"
    return 70
  fi

  classification="$(PYTHONDONTWRITEBYTECODE=1 python3 "$classifier" \
    --console-state "$console_state" --console-log "$console_log" 2>/dev/null)" || \
    classification_status="$?"
  case "$classification_status:$classification" in
    '0:decision=granted reason=adbd_compressed_apex_forward_progress') ;;
    '70:decision=refused reason=console_evidence_invalid') refusal_reason='console_evidence_invalid' ;;
    '70:decision=refused reason=console_evidence_truncated') refusal_reason='console_evidence_truncated' ;;
    '70:decision=refused reason=panic_or_fatal_marker') refusal_reason='panic_or_fatal_marker' ;;
    '70:decision=refused reason=stall_marker') refusal_reason='stall_marker' ;;
    '70:decision=refused reason=adbd_compressed_apex_progress_absent') refusal_reason='adbd_compressed_apex_progress_absent' ;;
    *) refusal_reason='console_evidence_invalid' ;;
  esac
  if [[ "$classification_status:$classification" != \
    '0:decision=granted reason=adbd_compressed_apex_forward_progress' ]]; then
    record_external_canary_adb_readiness_grace \
      "$diagnostics_file" refused "$refusal_reason" "$initial_deadline_seconds" 0 \
      "$hard_deadline_seconds" "$elapsed_seconds"
    return 70
  fi

  max_grace_seconds=$((hard_deadline_seconds - initial_deadline_seconds))
  remaining_seconds=$((hard_deadline_seconds - elapsed_seconds))
  grace_deadline_seconds="$max_grace_seconds"
  (( remaining_seconds < grace_deadline_seconds )) && grace_deadline_seconds="$remaining_seconds"
  if (( grace_deadline_seconds <= 0 )); then
    record_external_canary_adb_readiness_grace \
      "$diagnostics_file" expired hard_deadline_reached "$initial_deadline_seconds" 0 \
      "$hard_deadline_seconds" "$elapsed_seconds"
    return 70
  fi

  external_canary_adb_readiness_grace_used='true'
  record_external_canary_adb_readiness_grace \
    "$diagnostics_file" granted adbd_compressed_apex_forward_progress \
    "$initial_deadline_seconds" "$grace_deadline_seconds" "$hard_deadline_seconds" "$elapsed_seconds"
  wait_for_emulator_adb \
    "$emulator_pid" "$device_serial" "$adb_server_port" "$diagnostics_file" \
    "$grace_deadline_seconds" || grace_status="$?"
  elapsed_seconds=$((SECONDS - readiness_started_seconds))
  (( elapsed_seconds < 0 )) && elapsed_seconds=0
  case "$grace_status" in
    0)
      record_external_canary_adb_readiness_grace \
        "$diagnostics_file" completed device_ready "$initial_deadline_seconds" \
        "$grace_deadline_seconds" "$hard_deadline_seconds" "$elapsed_seconds"
      return 0
      ;;
    70)
      record_external_canary_adb_readiness_grace \
        "$diagnostics_file" expired additional_deadline_exhausted "$initial_deadline_seconds" \
        "$grace_deadline_seconds" "$hard_deadline_seconds" "$elapsed_seconds"
      ;;
    69)
      record_external_canary_adb_readiness_grace \
        "$diagnostics_file" refused emulator_not_alive "$initial_deadline_seconds" \
        "$grace_deadline_seconds" "$hard_deadline_seconds" "$elapsed_seconds"
      ;;
    *)
      record_external_canary_adb_readiness_grace \
        "$diagnostics_file" refused readiness_wait_failed "$initial_deadline_seconds" \
        "$grace_deadline_seconds" "$hard_deadline_seconds" "$elapsed_seconds"
      ;;
  esac
  return 70
}
