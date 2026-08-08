#!/usr/bin/env bash
set -euo pipefail
umask 077

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$repo_root/android/build-logic/emulator-adb-readiness.sh"
source "$repo_root/android/build-logic/emulator-avd-boot-profile.sh"
source "$repo_root/android/build-logic/isolated-adb-server.sh"
source "$repo_root/android/build-logic/physical-proof-lifecycle.sh"

artifacts_dir=''
deadline_seconds=240
while [[ $# -gt 0 ]]; do
  case "$1" in
    --artifacts)
      artifacts_dir="${2:-}"
      shift 2
      ;;
    --deadline-seconds)
      deadline_seconds="${2:-}"
      shift 2
      ;;
    *)
      printf 'unknown option: %s\n' "$1" >&2
      exit 64
      ;;
  esac
done
if [[ -z "$artifacts_dir" || ! "$deadline_seconds" =~ ^[1-9][0-9]*$ ]] ||
  (( deadline_seconds < 30 || deadline_seconds > 240 )); then
  printf '%s\n' 'usage: emulator-readiness-diagnostic.sh --artifacts DIR [--deadline-seconds 30..240]' >&2
  exit 64
fi
if [[ -L "$artifacts_dir" ]]; then
  printf '%s\n' 'diagnostic artifacts directory must not be a symlink' >&2
  exit 64
fi
mkdir -p "$artifacts_dir"
artifacts_dir="$(cd "$artifacts_dir" && pwd)"
if [[ -n "$(find "$artifacts_dir" -mindepth 1 -maxdepth 1 -print -quit)" ]]; then
  printf '%s\n' 'diagnostic artifacts directory must be empty' >&2
  exit 64
fi
chmod 700 "$artifacts_dir"

private_dir="$(mktemp -d)"
chmod 700 "$private_dir"
emulator_raw_log="$private_dir/emulator.log"
emulator_guest_console_socket="$private_dir/emulator-guest-console.sock"
emulator_guest_console_log="$private_dir/emulator-guest-console.log"
emulator_guest_console_state="$private_dir/emulator-guest-console.state"
emulator_readiness_evidence="$artifacts_dir/emulator-readiness-evidence.log"
emulator_diagnostics="$artifacts_dir/emulator-diagnostics.log"
cleanup_evidence="$artifacts_dir/cleanup.log"
receipt="$artifacts_dir/emulator-readiness-receipt.json"
: > "$emulator_diagnostics"

emulator_pid=''
emulator_console_probe_pid=''
emulator_port=''
emulator_adb_port=''
emulator_port_attempts=''
emulator_device_serial=''
adb_server_port=''
adb_server_port_attempts=''
adb_server_pid=''
adb_server_started='false'
adb_key_home=''
adb_public_key_payload_sha256=''
diagnostic_finalized='false'
diagnostic_status='failed'
diagnostic_classification='setup_failed'
avd_boot_profile_verified='false'
adb_state='unavailable'
boot_completed='unknown'
device_abi='unknown'
cleanup_processes='unknown'
cleanup_ports='unknown'

select_emulator_port_pair() {
  local selection=''
  local extra=''
  if ! selection="$(python3 "$repo_root/android/build-logic/select-emulator-port-pair.py" 2>/dev/null)"; then
    return 1
  fi
  read -r emulator_port emulator_adb_port emulator_port_attempts extra <<< "$selection"
  if [[ -n "$extra" || ! "$emulator_port" =~ ^[0-9]+$ ||
        ! "$emulator_adb_port" =~ ^[0-9]+$ || ! "$emulator_port_attempts" =~ ^[0-9]+$ ]] ||
    (( emulator_port < 5554 || emulator_port > 5584 || emulator_port % 2 != 0 ||
       emulator_adb_port != emulator_port + 1 || emulator_port_attempts < 1 ||
       emulator_port_attempts > 16 )); then
    return 1
  fi
  printf 'status=selected emulator_console_port=%s emulator_adb_port=%s emulator_port_attempts=%s verification=both_localhost_ports_free\n' \
    "$emulator_port" "$emulator_adb_port" "$emulator_port_attempts" >> "$emulator_diagnostics"
}

port_is_closed() {
  local port="$1"
  [[ "$port" =~ ^[0-9]+$ ]] || return 0
  ! probe_localhost_port "$port"
}

stop_diagnostic_processes() {
  physical_proof_stop_pid "${emulator_pid:-}" TERM 250
  emulator_pid=''
  physical_proof_stop_pid "${emulator_console_probe_pid:-}" TERM 50
  emulator_console_probe_pid=''
  stop_isolated_adb_server
}

finalize_diagnostic() {
  local process_status='clean'
  local port_status='closed'
  local owned_emulator_pid="${emulator_pid:-}"
  local owned_console_probe_pid="${emulator_console_probe_pid:-}"
  local owned_adb_server_pid="${adb_server_pid:-}"
  if [[ "$diagnostic_finalized" == 'true' ]]; then
    return 0
  fi
  stop_diagnostic_processes
  for owned_pid in "$owned_emulator_pid" "$owned_console_probe_pid" "$owned_adb_server_pid"; do
    if [[ "$owned_pid" =~ ^[1-9][0-9]*$ ]] && kill -0 "$owned_pid" 2>/dev/null; then
      process_status='residual'
    fi
  done
  for owned_port in "${emulator_port:-}" "${emulator_adb_port:-}" "${adb_server_port:-}"; do
    if ! port_is_closed "$owned_port"; then
      port_status='open'
    fi
  done
  cleanup_processes="$process_status"
  cleanup_ports="$port_status"
  {
    printf 'owned_processes=%s\n' "$cleanup_processes"
    printf 'owned_ports=%s\n' "$cleanup_ports"
    printf 'private_adb_key_retained=false\n'
  } > "$cleanup_evidence"
  chmod 600 "$cleanup_evidence"
  rm -rf "$private_dir"
  diagnostic_finalized='true'
  [[ "$cleanup_processes" == 'clean' && "$cleanup_ports" == 'closed' ]]
}

write_receipt() {
  cat > "$receipt" <<EOF
{
  "schemaVersion": 1,
  "status": "$diagnostic_status",
  "classification": "$diagnostic_classification",
  "deadlineSeconds": $deadline_seconds,
  "adbState": "$adb_state",
  "bootCompleted": "$boot_completed",
  "deviceAbi": "$device_abi",
  "expectedAbi": "x86_64",
  "systemImage": "$emulator_system_image_package",
  "deviceProfile": "$emulator_device_profile",
  "avdBootProfileVerified": $avd_boot_profile_verified,
  "adbServerIsolated": true,
  "adbPublicKeyPayloadSha256": "$adb_public_key_payload_sha256",
  "delayedAdbUntilBootComplete": true,
  "piServiceAccessed": false,
  "piDroidBuiltOrInstalled": false,
  "privateAdbKeyRetained": false,
  "ownedProcessesAfterCleanup": "$cleanup_processes",
  "ownedPortsAfterCleanup": "$cleanup_ports"
}
EOF
  chmod 600 "$receipt"
}

cleanup() {
  local original_status="${1:-$?}"
  trap - EXIT
  set +e
  if ! finalize_diagnostic; then
    original_status=70
  fi
  if [[ ! -e "$receipt" ]]; then
    write_receipt || original_status=70
  fi
  exit "$original_status"
}
trap 'cleanup "$?"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

{
  printf 'host_arch=%s\n' "$(uname -m)"
  printf 'expected_emulator_abi=x86_64\n'
  emulator -version 2>&1 | head -3
  emulator -accel-check 2>&1 || true
  adb version 2>&1 | head -3
} >> "$emulator_diagnostics"

start_isolated_adb_server \
  "$private_dir" \
  "$emulator_diagnostics" \
  "$repo_root/android/build-logic/select-adb-server-port.py"
isolated_adb_command=(adb -H 127.0.0.1 -P "$adb_server_port")

if ! create_bounded_api36_test_avd \
  pi-droid-readiness-diagnostic "$emulator_diagnostics"; then
  diagnostic_classification='avd_boot_profile_invalid'
  printf '%s\n' 'Android emulator AVD boot profile is unavailable or invalid' >&2
  exit 70
fi
avd_boot_profile_verified='true'
if ! select_emulator_port_pair; then
  diagnostic_classification='emulator_port_unavailable'
  printf '%s\n' 'emulator_port_unavailable: no supported localhost console/ADB pair is free' >&2
  exit 70
fi
emulator_device_serial="127.0.0.1:$emulator_adb_port"

# This runner deliberately has no Pi Daemon, APK, Gradle, npm, bearer, or app
# operation. It exercises only emulator boot and the isolated ADB transport.
# The console server waits for this owned recorder before guest boot, retaining
# early kernel evidence privately instead of attaching after a timeout.
python3 "$repo_root/android/build-logic/emulator-guest-console-recorder.py" \
  --console-socket "$emulator_guest_console_socket" \
  --raw-log "$emulator_guest_console_log" \
  --state "$emulator_guest_console_state" &
emulator_console_probe_pid="$!"
emulator -avd pi-droid-readiness-diagnostic -port "$emulator_port" \
  -no-window -noaudio -no-boot-anim -no-metrics -no-snapshot -wipe-data \
  -gpu swiftshader_indirect -delay-adb -show-kernel \
  -shell-serial "unix:$emulator_guest_console_socket,server" \
  > "$emulator_raw_log" 2>&1 &
emulator_pid="$!"

readiness_status=0
readiness_started_seconds="$SECONDS"
readiness_deadline_seconds=$((readiness_started_seconds + deadline_seconds))
wait_for_emulator_adb \
  "$emulator_pid" "$emulator_device_serial" "$adb_server_port" \
  "$emulator_diagnostics" "$deadline_seconds" || readiness_status="$?"
if (( readiness_status != 0 )); then
  if ! capture_emulator_readiness_evidence \
    "$repo_root/android/build-logic/emulator-readiness-evidence.py" \
    "$emulator_raw_log" "$emulator_guest_console_state" "$emulator_guest_console_log" \
    "$emulator_readiness_evidence" "$adb_public_key_payload_sha256"; then
    diagnostic_classification='evidence_capture_failed'
  else
    diagnostic_classification="$(sed -n 's/^classification=//p' "$emulator_readiness_evidence")"
  fi
  exit 70
fi

adb_state="$("${isolated_adb_command[@]}" -s "$emulator_device_serial" get-state 2>/dev/null || true)"
adb_state="$(sanitize_emulator_adb_state "$adb_state")"
boot_completed=''
while (( SECONDS < readiness_deadline_seconds )); do
  boot_completed="$(timeout --foreground --signal=KILL 5s \
    "${isolated_adb_command[@]}" -s "$emulator_device_serial" shell getprop sys.boot_completed \
    2>/dev/null | tr -d '\r' || true)"
  [[ "$boot_completed" == '1' ]] && break
  kill -0 "$emulator_pid" 2>/dev/null || break
  sleep 1
done
device_abi="$(timeout --foreground --signal=KILL 10s \
  "${isolated_adb_command[@]}" -s "$emulator_device_serial" shell getprop ro.product.cpu.abi \
  2>/dev/null | tr -d '\r' || true)"
if ! capture_emulator_readiness_evidence \
  "$repo_root/android/build-logic/emulator-readiness-evidence.py" \
  "$emulator_raw_log" "$emulator_guest_console_state" "$emulator_guest_console_log" \
  "$emulator_readiness_evidence" "$adb_public_key_payload_sha256"; then
  diagnostic_classification='evidence_capture_failed'
  exit 70
fi
diagnostic_classification="$(sed -n 's/^classification=//p' "$emulator_readiness_evidence")"
[[ "$diagnostic_classification" =~ ^[a-z_]+$ ]] || {
  diagnostic_classification='evidence_classification_invalid'
  exit 70
}
if [[ "$adb_state" != 'device' || "$boot_completed" != '1' || "$device_abi" != 'x86_64' ]]; then
  diagnostic_status='failed'
  if [[ "$diagnostic_classification" == 'ready' ]]; then
    diagnostic_classification='post_readiness_identity_mismatch'
  fi
  exit 70
fi

diagnostic_status='verified'
diagnostic_classification='ready'
if ! finalize_diagnostic; then
  diagnostic_status='failed'
  diagnostic_classification='cleanup_failed'
  exit 70
fi
write_receipt
printf 'Emulator readiness diagnostic verified: adb=%s boot_completed=%s abi=%s cleanup=%s/%s artifacts=%s\n' \
  "$adb_state" "$boot_completed" "$device_abi" "$cleanup_processes" "$cleanup_ports" "$artifacts_dir"
