#!/usr/bin/env bash

# Shared by the disposable interactive and readonly emulator proof harnesses.
# The caller owns shell options, process cleanup, and the final user-facing error.

connect_emulator_adb_transport() {
  local device_serial="$1"
  local adb_server_port="$2"
  local command_timeout_seconds="$3"
  timeout --foreground --signal=KILL "${command_timeout_seconds}s" \
    adb -H 127.0.0.1 -P "$adb_server_port" connect "$device_serial" 2>&1
}

poll_emulator_adb_state() {
  local device_serial="$1"
  local adb_server_port="$2"
  local command_timeout_seconds="$3"
  # ADB reports transport state on either stream. Bound the untrusted text here;
  # callers reduce it to a fixed enum before writing any diagnostics.
  timeout --foreground --signal=KILL "${command_timeout_seconds}s" \
    adb -H 127.0.0.1 -P "$adb_server_port" -s "$device_serial" get-state 2>&1 |
    LC_ALL=C head -c 4096
}

sanitize_emulator_adb_connect_state() {
  case "$1" in
    *'Connection refused'*|*'connection refused'*)
      printf '%s\n' 'refused'
      ;;
    *'already connected to '*)
      printf '%s\n' 'already_connected'
      ;;
    *'connected to '*)
      printf '%s\n' 'connected'
      ;;
    *'failed to connect'*|*'cannot connect'*|*'unable to connect'*)
      printf '%s\n' 'failed'
      ;;
    '')
      printf '%s\n' 'unavailable'
      ;;
    *)
      printf '%s\n' 'other'
      ;;
  esac
}

sanitize_emulator_adb_state() {
  local raw_state="$1"
  local loopback_not_found_pattern="^(error:|adb:)[[:space:]]device[[:space:]]'127\\.0\\.0\\.1:[0-9]+'[[:space:]]not[[:space:]]found\\.?$"
  case "$raw_state" in
    device|offline|bootloader|recovery|sideload|unauthorized|unknown|not_found)
      printf '%s\n' "$raw_state"
      ;;
    'error: device offline'|'error: device offline.'|'adb: device offline'|'adb: device offline.')
      printf '%s\n' 'offline'
      ;;
    'error: device unauthorized'|'error: device unauthorized.'|'adb: device unauthorized'|'adb: device unauthorized.')
      printf '%s\n' 'unauthorized'
      ;;
    'error: device not found'|'error: device not found.'|'adb: device not found'|'adb: device not found.'|\
      'error: no devices/emulators found'|'adb: no devices/emulators found')
      printf '%s\n' 'not_found'
      ;;
    ''|unavailable)
      printf '%s\n' 'unavailable'
      ;;
    *)
      if [[ "$raw_state" =~ $loopback_not_found_pattern ]]; then
        printf '%s\n' 'not_found'
      else
        printf '%s\n' 'other'
      fi
      ;;
  esac
}

record_emulator_adb_readiness() {
  local diagnostics_file="$1"
  local status="$2"
  local attempts="$3"
  local connect_attempts="$4"
  local deadline_seconds="$5"
  local elapsed_seconds="$6"
  local remaining_seconds="$7"
  local connect_state="$8"
  local adb_state="$9"
  printf 'phase=adb_readiness status=%s attempts=%s connect_attempts=%s deadline_seconds=%s elapsed_seconds=%s remaining_seconds=%s connect_state=%s adb_state=%s\n' \
    "$status" "$attempts" "$connect_attempts" "$deadline_seconds" "$elapsed_seconds" \
    "$remaining_seconds" "$connect_state" "$adb_state" >> "$diagnostics_file"
}

wait_for_emulator_adb() {
  local emulator_pid="$1"
  local device_serial="$2"
  local adb_server_port="$3"
  local diagnostics_file="$4"
  local max_seconds="${5:-240}"
  local device_adb_port=''
  if [[ "$device_serial" =~ ^127\.0\.0\.1:([0-9]+)$ ]]; then
    device_adb_port="${BASH_REMATCH[1]}"
  fi
  if [[ ! "$emulator_pid" =~ ^[1-9][0-9]*$ || ! "$adb_server_port" =~ ^[0-9]+$ ||
        ! "$device_adb_port" =~ ^[0-9]+$ || ! "$max_seconds" =~ ^[1-9][0-9]*$ ]] ||
    (( adb_server_port < 42000 || adb_server_port > 42127 || adb_server_port == 5037 ||
       device_adb_port < 5555 || device_adb_port > 5585 || device_adb_port % 2 != 1 ||
       max_seconds > 240 )); then
    return 64
  fi

  local started_seconds="$SECONDS"
  local deadline_at_seconds=$((started_seconds + max_seconds))
  local next_report_seconds="$started_seconds"
  local attempts=0
  local connect_attempts=0
  local raw_connect_state=''
  local connect_state='unavailable'
  local raw_state=''
  local adb_state='unavailable'
  local last_reported_connect_state=''
  local last_reported_adb_state=''
  local now_seconds="$started_seconds"
  local elapsed_seconds=0
  local remaining_seconds="$max_seconds"
  local command_timeout_seconds=0

  while (( SECONDS < deadline_at_seconds )); do
    now_seconds="$SECONDS"
    elapsed_seconds=$((now_seconds - started_seconds))
    remaining_seconds=$((deadline_at_seconds - now_seconds))
    if ! kill -0 "$emulator_pid" 2>/dev/null; then
      record_emulator_adb_readiness "$diagnostics_file" emulator_exited "$attempts" "$connect_attempts" \
        "$max_seconds" "$elapsed_seconds" "$remaining_seconds" "$connect_state" "$adb_state"
      return 69
    fi

    attempts=$((attempts + 1))
    connect_attempts=$((connect_attempts + 1))
    command_timeout_seconds=5
    if (( remaining_seconds < command_timeout_seconds )); then
      command_timeout_seconds="$remaining_seconds"
    fi
    raw_connect_state="$(connect_emulator_adb_transport \
      "$device_serial" "$adb_server_port" "$command_timeout_seconds" || true)"
    connect_state="$(sanitize_emulator_adb_connect_state "$raw_connect_state")"

    now_seconds="$SECONDS"
    elapsed_seconds=$((now_seconds - started_seconds))
    remaining_seconds=$((deadline_at_seconds - now_seconds))
    if (( remaining_seconds < 0 )); then
      remaining_seconds=0
    fi
    if ! kill -0 "$emulator_pid" 2>/dev/null; then
      record_emulator_adb_readiness "$diagnostics_file" emulator_exited "$attempts" "$connect_attempts" \
        "$max_seconds" "$elapsed_seconds" "$remaining_seconds" "$connect_state" "$adb_state"
      return 69
    fi
    if (( remaining_seconds == 0 )); then
      break
    fi

    command_timeout_seconds=5
    if (( remaining_seconds < command_timeout_seconds )); then
      command_timeout_seconds="$remaining_seconds"
    fi
    raw_state="$(poll_emulator_adb_state \
      "$device_serial" "$adb_server_port" "$command_timeout_seconds" || true)"
    adb_state="$(sanitize_emulator_adb_state "$raw_state")"

    now_seconds="$SECONDS"
    elapsed_seconds=$((now_seconds - started_seconds))
    remaining_seconds=$((deadline_at_seconds - now_seconds))
    if (( remaining_seconds < 0 )); then
      remaining_seconds=0
    fi
    if ! kill -0 "$emulator_pid" 2>/dev/null; then
      record_emulator_adb_readiness "$diagnostics_file" emulator_exited "$attempts" "$connect_attempts" \
        "$max_seconds" "$elapsed_seconds" "$remaining_seconds" "$connect_state" "$adb_state"
      return 69
    fi
    if [[ "$adb_state" == 'device' ]]; then
      record_emulator_adb_readiness "$diagnostics_file" ready "$attempts" "$connect_attempts" \
        "$max_seconds" "$elapsed_seconds" "$remaining_seconds" "$connect_state" "$adb_state"
      return 0
    fi
    if (( now_seconds >= next_report_seconds )) ||
      [[ "$connect_state" != "$last_reported_connect_state" || "$adb_state" != "$last_reported_adb_state" ]]; then
      record_emulator_adb_readiness "$diagnostics_file" polling "$attempts" "$connect_attempts" \
        "$max_seconds" "$elapsed_seconds" "$remaining_seconds" "$connect_state" "$adb_state"
      next_report_seconds=$((now_seconds + 30))
      last_reported_connect_state="$connect_state"
      last_reported_adb_state="$adb_state"
    fi
    if (( now_seconds < deadline_at_seconds )); then
      sleep 1
    fi
  done

  now_seconds="$SECONDS"
  elapsed_seconds=$((now_seconds - started_seconds))
  record_emulator_adb_readiness "$diagnostics_file" timed_out "$attempts" "$connect_attempts" \
    "$max_seconds" "$elapsed_seconds" 0 "$connect_state" "$adb_state"
  return 70
}
