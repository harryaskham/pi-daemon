#!/usr/bin/env bash

# Shared bounded cleanup and retained-evidence bearer scan for the disposable
# Pi Droid physical proof harnesses. Callers provide the PID/token globals and
# source isolated-adb-server.sh before this file.

physical_proof_stop_pid() {
  local pid="${1:-}"
  local initial_signal="${2:-TERM}"
  local grace_attempts="${3:-50}"
  local attempt=0
  if [[ ! "$pid" =~ ^[1-9][0-9]*$ ]] || ! kill -0 "$pid" 2>/dev/null; then
    return 0
  fi
  kill -s "$initial_signal" "$pid" 2>/dev/null || true
  while (( attempt < grace_attempts )) && kill -0 "$pid" 2>/dev/null; do
    attempt=$((attempt + 1))
    sleep 0.1
  done
  if kill -0 "$pid" 2>/dev/null; then
    kill -KILL "$pid" 2>/dev/null || true
  fi
  wait "$pid" 2>/dev/null || true
}

stop_physical_proof_owned_processes() {
  physical_proof_stop_pid "${screenrecord_pid:-}" INT 50
  screenrecord_pid=''
  physical_proof_stop_pid "${daemon_pid:-}" TERM 50
  daemon_pid=''
  # Emulator shutdown can legitimately use its documented 20-second grace.
  physical_proof_stop_pid "${emulator_pid:-}" TERM 250
  emulator_pid=''
  physical_proof_stop_pid "${emulator_console_probe_pid:-}" TERM 50
  emulator_console_probe_pid=''
  if declare -F stop_isolated_adb_server >/dev/null; then
    stop_isolated_adb_server
  fi
}

run_physical_proof_bearer_scan() {
  local scan_log="${artifacts_dir:-}/bearer-scan.log"
  local status=0
  if [[ "${physical_proof_bearer_scan_complete:-false}" == 'true' ]]; then
    return "${physical_proof_bearer_scan_status:-70}"
  fi
  if [[ -z "${artifacts_dir:-}" || ! -d "$artifacts_dir" || -e "$scan_log" || -L "$scan_log" ]]; then
    physical_proof_bearer_scan_complete='true'
    physical_proof_bearer_scan_status=70
    return 70
  fi
  if [[ "${disposable_bearer_created:-false}" != 'true' ]]; then
    printf '%s\n' 'status=not_created scanned_files=0 scanned_bytes=0 skipped_binary_files=0' > "$scan_log"
  elif [[ -z "${token_file:-}" || ! -f "$token_file" ]]; then
    printf '%s\n' 'status=scan_failed scanned_files=0 scanned_bytes=0 skipped_binary_files=0 reason=token_unavailable' > "$scan_log"
    status=70
  elif python3 "$repo_root/android/build-logic/retained-bearer-scan.py" \
    "$token_file" "$artifacts_dir" > "$scan_log"; then
    status=0
  else
    status=$?
  fi
  chmod 600 "$scan_log" 2>/dev/null || true
  physical_proof_bearer_scan_complete='true'
  physical_proof_bearer_scan_status="$status"
  return "$status"
}
