#!/usr/bin/env bash

# Shared by the disposable interactive and readonly emulator proof harnesses.
# The caller owns shell options, process cleanup, and the final user-facing error.

poll_emulator_adb_state() {
  local emulator_serial="$1"
  local poll_timeout_seconds="$2"
  timeout --foreground --signal=KILL "${poll_timeout_seconds}s" adb -s "$emulator_serial" get-state 2>/dev/null
}

sanitize_emulator_adb_state() {
  case "$1" in
    device|offline|bootloader|recovery|sideload|unauthorized|unknown)
      printf '%s\n' "$1"
      ;;
    '')
      printf '%s\n' 'unavailable'
      ;;
    *)
      printf '%s\n' 'other'
      ;;
  esac
}

record_emulator_adb_readiness() {
  local diagnostics_file="$1"
  local status="$2"
  local attempts="$3"
  local deadline_seconds="$4"
  local elapsed_seconds="$5"
  local remaining_seconds="$6"
  local adb_state="$7"
  printf 'phase=adb_readiness status=%s attempts=%s deadline_seconds=%s elapsed_seconds=%s remaining_seconds=%s adb_state=%s\n' \
    "$status" "$attempts" "$deadline_seconds" "$elapsed_seconds" "$remaining_seconds" "$adb_state" \
    >> "$diagnostics_file"
}

wait_for_emulator_adb() {
  local emulator_pid="$1"
  local emulator_serial="$2"
  local diagnostics_file="$3"
  local max_seconds="${4:-240}"
  if [[ ! "$emulator_pid" =~ ^[1-9][0-9]*$ || ! "$max_seconds" =~ ^[1-9][0-9]*$ ]] || (( max_seconds > 240 )); then
    return 64
  fi

  local started_seconds="$SECONDS"
  local deadline_at_seconds=$((started_seconds + max_seconds))
  local next_report_seconds="$started_seconds"
  local attempts=0
  local raw_state=''
  local adb_state='unavailable'
  local now_seconds="$started_seconds"
  local elapsed_seconds=0
  local remaining_seconds="$max_seconds"
  local poll_timeout_seconds=0

  while (( SECONDS < deadline_at_seconds )); do
    now_seconds="$SECONDS"
    elapsed_seconds=$((now_seconds - started_seconds))
    remaining_seconds=$((deadline_at_seconds - now_seconds))
    if ! kill -0 "$emulator_pid" 2>/dev/null; then
      record_emulator_adb_readiness "$diagnostics_file" emulator_exited "$attempts" "$max_seconds" \
        "$elapsed_seconds" "$remaining_seconds" "$adb_state"
      return 69
    fi

    attempts=$((attempts + 1))
    poll_timeout_seconds=5
    if (( remaining_seconds < poll_timeout_seconds )); then
      poll_timeout_seconds="$remaining_seconds"
    fi
    raw_state="$(poll_emulator_adb_state "$emulator_serial" "$poll_timeout_seconds" || true)"
    adb_state="$(sanitize_emulator_adb_state "$raw_state")"

    now_seconds="$SECONDS"
    elapsed_seconds=$((now_seconds - started_seconds))
    remaining_seconds=$((deadline_at_seconds - now_seconds))
    if (( remaining_seconds < 0 )); then
      remaining_seconds=0
    fi
    if ! kill -0 "$emulator_pid" 2>/dev/null; then
      record_emulator_adb_readiness "$diagnostics_file" emulator_exited "$attempts" "$max_seconds" \
        "$elapsed_seconds" "$remaining_seconds" "$adb_state"
      return 69
    fi
    if [[ "$adb_state" == 'device' ]]; then
      record_emulator_adb_readiness "$diagnostics_file" ready "$attempts" "$max_seconds" \
        "$elapsed_seconds" "$remaining_seconds" "$adb_state"
      return 0
    fi
    if (( now_seconds >= next_report_seconds )); then
      record_emulator_adb_readiness "$diagnostics_file" polling "$attempts" "$max_seconds" \
        "$elapsed_seconds" "$remaining_seconds" "$adb_state"
      next_report_seconds=$((now_seconds + 30))
    fi
    if (( now_seconds < deadline_at_seconds )); then
      sleep 1
    fi
  done

  now_seconds="$SECONDS"
  elapsed_seconds=$((now_seconds - started_seconds))
  record_emulator_adb_readiness "$diagnostics_file" timed_out "$attempts" "$max_seconds" \
    "$elapsed_seconds" 0 "$adb_state"
  return 70
}
