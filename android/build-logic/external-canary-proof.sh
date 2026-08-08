#!/usr/bin/env bash
set -euo pipefail
umask 077

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$repo_root/android/build-logic/emulator-adb-readiness.sh"
source "$repo_root/android/build-logic/emulator-avd-boot-profile.sh"
source "$repo_root/android/build-logic/emulator-ui-health.sh"
source "$repo_root/android/build-logic/external-canary-receipt.sh"
source "$repo_root/android/build-logic/isolated-adb-server.sh"
source "$repo_root/android/build-logic/physical-proof-lifecycle.sh"

api_url=''
token_file=''
artifacts_dir=''
allow_insecure_http='false'
while [[ $# -gt 0 ]]; do
  case "$1" in
    --api-url)
      api_url="${2:-}"
      shift 2
      ;;
    --token-file)
      token_file="${2:-}"
      shift 2
      ;;
    --artifacts)
      artifacts_dir="${2:-}"
      shift 2
      ;;
    --allow-insecure-http)
      allow_insecure_http='true'
      shift
      ;;
    *)
      printf 'unknown option: %s\n' "$1" >&2
      exit 64
      ;;
  esac
done
if [[ -z "$api_url" || -z "$token_file" || -z "$artifacts_dir" ]]; then
  printf '%s\n' \
    'usage: external-canary-proof.sh --api-url URL --token-file FILE --artifacts DIR [--allow-insecure-http]' >&2
  exit 64
fi
if [[ -e "$artifacts_dir" && ( ! -d "$artifacts_dir" || -n "$(find "$artifacts_dir" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" ) ]]; then
  printf '%s\n' 'external canary artifacts directory must be absent or empty' >&2
  exit 64
fi
artifacts_dir="$(mkdir -p "$artifacts_dir" && cd "$artifacts_dir" && pwd)"
chmod 700 "$artifacts_dir"
mkdir -p "$artifacts_dir/screenshots"

private_dir="$(mktemp -d)"
chmod 700 "$private_dir"
staging_file="$private_dir/external-canary-import.json"
emulator_raw_log="$private_dir/emulator.log"
emulator_guest_console_socket="$private_dir/emulator-guest-console.sock"
emulator_guest_console_log="$private_dir/emulator-guest-console.log"
emulator_guest_console_state="$private_dir/emulator-guest-console.state"
emulator_readiness_evidence="$artifacts_dir/emulator-readiness-evidence.log"
emulator_diagnostics="$artifacts_dir/emulator-diagnostics.log"
: > "$emulator_diagnostics"
initialize_emulator_ui_health "$private_dir" "$artifacts_dir"

package_name='com.harryaskham.pidroid.debug'
activity_name='com.harryaskham.pidroid.MainActivity'
daemon_pid=''
emulator_pid=''
emulator_console_probe_pid=''
emulator_device_serial=''
emulator_port=''
emulator_adb_port=''
emulator_port_attempts=''
adb_server_port=''
adb_server_port_attempts=''
adb_server_pid=''
adb_server_started='false'
adb_key_home=''
adb_public_key_payload_sha256=''
screenrecord_pid=''
disposable_bearer_created='false'
app_installed='false'
external_device_scan_complete='false'
external_device_scan_status=70
external_evidence_scan_complete='false'
external_evidence_scan_status=70
external_cleanup_verification_complete='false'
external_cleanup_verification_status=70
owned_emulator_pid=''
owned_console_probe_pid=''
owned_adb_server_pid=''
owned_emulator_port=''
owned_emulator_adb_port=''
owned_adb_server_port=''

run_external_canary_device_scan() {
  local scan_log="$artifacts_dir/external-canary-app-data-scan.log"
  local adb_status=0
  local scan_status=0
  if [[ "$external_device_scan_complete" == 'true' ]]; then
    return "$external_device_scan_status"
  fi
  if [[ -e "$scan_log" || -L "$scan_log" ]]; then
    external_device_scan_complete='true'
    external_device_scan_status=70
    return 70
  fi
  if [[ "$app_installed" != 'true' ]]; then
    printf '%s\n' 'status=not_installed scan=app_private_stream scanned_files=0 scanned_bytes=0' > "$scan_log"
    external_device_scan_complete='true'
    external_device_scan_status=0
    return 0
  fi
  if [[ -z "$emulator_pid" || ! "$emulator_pid" =~ ^[1-9][0-9]*$ ]] || ! kill -0 "$emulator_pid" 2>/dev/null; then
    printf '%s\n' 'status=scan_failed scan=app_private_stream scanned_files=0 scanned_bytes=0 reason=device_unavailable' > "$scan_log"
    external_device_scan_complete='true'
    external_device_scan_status=70
    return 70
  fi
  set +e
  set +o pipefail
  "${isolated_adb_command[@]}" -s "$emulator_device_serial" exec-out \
    run-as "$package_name" tar -cf - . 2> "$private_dir/app-data-tar.stderr" |
    python3 "$repo_root/android/build-logic/external-canary-secret-scan.py" \
      --token-file "$token_file" --stream > "$scan_log"
  local pipeline_status=("${PIPESTATUS[@]}")
  set -o pipefail
  set -e
  adb_status="${pipeline_status[0]:-70}"
  scan_status="${pipeline_status[1]:-70}"
  if (( adb_status != 0 || scan_status != 0 )); then
    external_device_scan_status="$scan_status"
    (( external_device_scan_status != 0 )) || external_device_scan_status=70
  else
    external_device_scan_status=0
  fi
  external_device_scan_complete='true'
  chmod 600 "$scan_log" 2>/dev/null || true
  return "$external_device_scan_status"
}

run_external_canary_evidence_scan() {
  local scan_log="$artifacts_dir/external-canary-evidence-scan.log"
  local status=0
  if [[ "$external_evidence_scan_complete" == 'true' ]]; then
    return "$external_evidence_scan_status"
  fi
  if [[ -e "$scan_log" || -L "$scan_log" ]]; then
    external_evidence_scan_complete='true'
    external_evidence_scan_status=70
    return 70
  fi
  python3 "$repo_root/android/build-logic/external-canary-secret-scan.py" \
    --token-file "$token_file" --root "$artifacts_dir" > "$scan_log" || status=$?
  chmod 600 "$scan_log" 2>/dev/null || true
  external_evidence_scan_complete='true'
  external_evidence_scan_status="$status"
  return "$status"
}

verify_external_canary_cleanup() {
  local verification_log="$artifacts_dir/external-canary-cleanup.log"
  local status=0
  local pid=''
  if [[ "$external_cleanup_verification_complete" == 'true' ]]; then
    return "$external_cleanup_verification_status"
  fi
  if [[ -e "$verification_log" || -L "$verification_log" ]]; then
    external_cleanup_verification_complete='true'
    external_cleanup_verification_status=70
    return 70
  fi
  for pid in "$owned_emulator_pid" "$owned_console_probe_pid" "$owned_adb_server_pid"; do
    if [[ "$pid" =~ ^[1-9][0-9]*$ ]] && kill -0 "$pid" 2>/dev/null; then
      status=70
    fi
  done
  if (( status == 0 )); then
    python3 - "$owned_emulator_port" "$owned_emulator_adb_port" "$owned_adb_server_port" <<'PY' || status=70
import socket, sys
for raw in sys.argv[1:]:
    if not raw:
        continue
    port = int(raw)
    with socket.socket() as probe:
        probe.settimeout(0.2)
        if probe.connect_ex(("127.0.0.1", port)) == 0:
            raise SystemExit(1)
PY
  fi
  if (( status == 0 )); then
    printf '%s\n' 'status=clean residual_processes=0 residual_ports=0 adb_server=stopped emulator=stopped' > "$verification_log"
  else
    printf '%s\n' 'status=cleanup_failed residual_processes=unknown residual_ports=unknown' > "$verification_log"
  fi
  external_cleanup_verification_complete='true'
  external_cleanup_verification_status="$status"
  return "$status"
}

cleanup() {
  local original_status="${1:-$?}"
  local operation_status=0
  local final_status="$original_status"
  trap - EXIT
  set +e
  run_external_canary_device_scan
  operation_status=$?
  (( operation_status == 0 )) || final_status="$operation_status"
  stop_physical_proof_owned_processes
  verify_external_canary_cleanup
  operation_status=$?
  (( operation_status == 0 )) || final_status="$operation_status"
  run_external_canary_evidence_scan
  operation_status=$?
  (( operation_status == 0 )) || final_status="$operation_status"
  rm -rf "$private_dir" || final_status=70
  exit "$final_status"
}
trap 'cleanup "$?"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

preflight_arguments=(
  --api-url "$api_url"
  --token-file "$token_file"
  --staging-file "$staging_file"
  --receipt-file "$artifacts_dir/external-canary-preflight.json"
)
if [[ "$allow_insecure_http" == 'true' ]]; then
  preflight_arguments+=(--allow-insecure-http)
fi
python3 "$repo_root/android/build-logic/external-canary-preflight.py" "${preflight_arguments[@]}"
preflight_network="$(parse_external_canary_network "$artifacts_dir/external-canary-preflight.json")"
mapfile -t preflight_network_fields <<< "$preflight_network"
(( ${#preflight_network_fields[@]} == 3 )) || exit 70
network_host="${preflight_network_fields[0]}"
network_port="${preflight_network_fields[1]}"
network_scheme="${preflight_network_fields[2]}"
observer_attach_allowed="$(parse_external_canary_observer_attach_allowed "$artifacts_dir/external-canary-preflight.json")"
[[ "$network_port" =~ ^[0-9]+$ && "$network_port" -ge 1 && "$network_port" -le 65535 ]] || exit 70

cd "$repo_root"
npm run build:src > "$artifacts_dir/node-build.log" 2>&1
./android/gradlew -p android --no-daemon --no-configuration-cache \
  -PpiDroidAndroidApp=true :app:assembleDebug > "$artifacts_dir/android-build.log" 2>&1
apk="$repo_root/android/app/build/outputs/apk/debug/app-debug.apk"
[[ -f "$apk" ]] || { printf '%s\n' 'debug APK missing' >&2; exit 70; }

start_isolated_adb_server \
  "$private_dir" \
  "$emulator_diagnostics" \
  "$repo_root/android/build-logic/select-adb-server-port.py"
isolated_adb_command=(adb -H 127.0.0.1 -P "$adb_server_port")
owned_adb_server_pid="$adb_server_pid"
owned_adb_server_port="$adb_server_port"

select_emulator_port_pair() {
  local selection=''
  local extra=''
  if ! selection="$(python3 "$repo_root/android/build-logic/select-emulator-port-pair.py" 2>/dev/null)"; then
    return 1
  fi
  read -r emulator_port emulator_adb_port emulator_port_attempts extra <<< "$selection"
  if [[ -n "$extra" || ! "$emulator_port" =~ ^[0-9]+$ || ! "$emulator_adb_port" =~ ^[0-9]+$ || ! "$emulator_port_attempts" =~ ^[0-9]+$ ]]; then
    return 1
  fi
  if (( emulator_port < 5554 || emulator_port > 5584 || emulator_port % 2 != 0 || emulator_adb_port != emulator_port + 1 || emulator_port_attempts < 1 || emulator_port_attempts > 16 )); then
    return 1
  fi
  printf 'status=selected emulator_console_port=%s emulator_adb_port=%s emulator_port_attempts=%s verification=both_localhost_ports_free\n' \
    "$emulator_port" "$emulator_adb_port" "$emulator_port_attempts" >> "$emulator_diagnostics"
}

if ! create_bounded_api36_test_avd pi-droid-external-canary "$emulator_diagnostics"; then
  printf '%s\n' 'Android emulator AVD boot profile is unavailable or invalid' >&2
  exit 70
fi
if ! select_emulator_port_pair; then
  printf '%s\n' 'status=emulator_port_unavailable emulator_console_port=none emulator_adb_port=none emulator_port_attempts=16' >> "$emulator_diagnostics"
  printf '%s\n' 'emulator_port_unavailable: no supported localhost console/ADB pair is free after 16 attempts' >&2
  exit 70
fi
owned_emulator_port="$emulator_port"
owned_emulator_adb_port="$emulator_adb_port"
emulator_device_serial="127.0.0.1:$emulator_adb_port"
emulator_abi='x86_64'
python3 "$repo_root/android/build-logic/emulator-guest-console-recorder.py" \
  --console-socket "$emulator_guest_console_socket" \
  --raw-log "$emulator_guest_console_log" \
  --state "$emulator_guest_console_state" &
emulator_console_probe_pid="$!"
owned_console_probe_pid="$emulator_console_probe_pid"
emulator -avd pi-droid-external-canary -port "$emulator_port" -no-window -noaudio -no-boot-anim \
  -no-metrics -no-snapshot -wipe-data -gpu swiftshader_indirect -delay-adb -show-kernel \
  -shell-serial "unix:$emulator_guest_console_socket,server" \
  > "$emulator_raw_log" 2>&1 &
emulator_pid="$!"
owned_emulator_pid="$emulator_pid"
adb_readiness_status=0
wait_for_emulator_adb \
  "$emulator_pid" "$emulator_device_serial" "$adb_server_port" "$emulator_diagnostics" 240 || \
  adb_readiness_status="$?"
if (( adb_readiness_status != 0 )); then
  if ! capture_emulator_readiness_evidence \
    "$repo_root/android/build-logic/emulator-readiness-evidence.py" \
    "$emulator_raw_log" "$emulator_guest_console_state" "$emulator_guest_console_log" \
    "$emulator_readiness_evidence" "$adb_public_key_payload_sha256"; then
    printf '%s\n' 'phase=adb_readiness_evidence status=capture_failed' >> "$emulator_diagnostics"
  fi
  printf '%s\n' 'Android emulator ADB readiness failed' >&2
  exit 70
fi
booted=''
for _ in $(seq 1 240); do
  booted="$("${isolated_adb_command[@]}" -s "$emulator_device_serial" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')"
  [[ "$booted" == '1' ]] && break
  kill -0 "$emulator_pid" 2>/dev/null || { printf '%s\n' 'emulator exited before boot' >&2; exit 70; }
  sleep 1
done
[[ "$booted" == '1' ]] || { printf '%s\n' 'emulator boot timed out' >&2; exit 70; }
probe_emulator_ui_health || exit 70
"${isolated_adb_command[@]}" -s "$emulator_device_serial" install -r "$apk" >/dev/null
app_installed='true'

wait_external_host_port() {
  local max_attempts=60
  local attempt=0
  local gate_log="$artifacts_dir/external-host-port-gate.log"
  : > "$gate_log"
  printf 'port=%s max_attempts=%s deadline_seconds=30 safe_code=external_host_unreachable\n' \
    "$network_port" "$max_attempts" >> "$gate_log"
  while (( attempt < max_attempts )); do
    attempt=$((attempt + 1))
    if "${isolated_adb_command[@]}" -s "$emulator_device_serial" shell \
      toybox nc -z -w 1 "$network_host" "$network_port" >/dev/null 2>&1; then
      printf 'status=reachable attempts=%s port=%s\n' "$attempt" "$network_port" >> "$gate_log"
      return 0
    fi
    sleep 0.5
  done
  printf 'status=external_host_unreachable attempts=%s port=%s\n' "$attempt" "$network_port" >> "$gate_log"
  return 1
}
if ! wait_external_host_port; then
  printf 'external_host_unreachable: port=%s attempts=60 deadline_seconds=30\n' "$network_port" >&2
  exit 70
fi

"${isolated_adb_command[@]}" -s "$emulator_device_serial" exec-out \
  run-as "$package_name" sh -c \
  'umask 077; mkdir -p no_backup; cat > no_backup/external-canary-import.json; chmod 600 no_backup/external-canary-import.json' \
  < "$staging_file" > /dev/null
staged_mode_size="$("${isolated_adb_command[@]}" -s "$emulator_device_serial" exec-out \
  run-as "$package_name" stat -c '%a:%s' no_backup/external-canary-import.json 2>/dev/null | tr -d '\r')"
[[ "$staged_mode_size" =~ ^600:[1-9][0-9]{0,4}$ ]] || { printf '%s\n' 'external canary staging file is not bounded owner-only data' >&2; exit 70; }
printf 'status=staged mode=600 bytes=%s transport=adb_stdin\n' "${staged_mode_size#*:}" > "$artifacts_dir/external-canary-staging.log"

canary_action='com.harryaskham.pidroid.action.EXTERNAL_CANARY_IMPORT'
if [[ "$network_scheme" == 'http' ]]; then
  canary_action='com.harryaskham.pidroid.action.EXTERNAL_CANARY_IMPORT_INSECURE_HTTP'
fi
"${isolated_adb_command[@]}" -s "$emulator_device_serial" shell am start -W \
  -a "$canary_action" -n "$package_name/$activity_name" >/dev/null

wait_ui() {
  local pattern="$1"
  local attempts="${2:-60}"
  local xml="$private_dir/window.xml"
  for _ in $(seq 1 "$attempts"); do
    : > "$xml"
    dump_emulator_ui_window "$xml" || true
    check_emulator_ui_health "$xml" || exit 70
    if grep -Eq "$pattern" "$xml"; then return; fi
    sleep 1
  done
  "${isolated_adb_command[@]}" -s "$emulator_device_serial" exec-out screencap -p \
    > "$artifacts_dir/screenshots/failure.png" 2>/dev/null || true
  cp "$xml" "$artifacts_dir/failure-window.xml" 2>/dev/null || true
  printf 'external canary UI did not expose expected content-free marker: %s\n' "$pattern" >&2
  exit 70
}
wait_ui 'EXTERNAL CANARY · READONLY' 30
wait_ui 'READONLY HYDRATION · VERIFIED' 90
case "$observer_attach_allowed" in
  true)
    wait_ui 'OBSERVER · ATTACHED TO IDLE SESSION' 30
    ;;
  false)
    wait_ui 'OBSERVER · NOT REQUESTED' 30
    ;;
  *)
    exit 70
    ;;
esac
if ! "${isolated_adb_command[@]}" -s "$emulator_device_serial" exec-out \
  run-as "$package_name" test ! -e no_backup/external-canary-import.json; then
  printf '%s\n' 'external canary one-shot staging file was not consumed' >&2
  exit 70
fi
"${isolated_adb_command[@]}" -s "$emulator_device_serial" exec-out screencap -p \
  > "$artifacts_dir/screenshots/external-canary-readonly.png"
probe_emulator_ui_health || exit 70
app_pid="$("${isolated_adb_command[@]}" -s "$emulator_device_serial" shell pidof -s "$package_name" 2>/dev/null | tr -d '\r')"
[[ "$app_pid" =~ ^[1-9][0-9]*$ ]] || { printf '%s\n' 'Pi Droid process identity unavailable' >&2; exit 70; }
"${isolated_adb_command[@]}" -s "$emulator_device_serial" logcat -d -t 2048 --pid "$app_pid" -v threadtime \
  > "$artifacts_dir/app-logcat.txt"

run_external_canary_device_scan
"${isolated_adb_command[@]}" -s "$emulator_device_serial" uninstall "$package_name" >/dev/null
app_installed='false'
stop_physical_proof_owned_processes
verify_external_canary_cleanup

cat > "$artifacts_dir/external-canary-receipt.json" <<EOF
{
  "schemaVersion": 1,
  "status": "verified",
  "apiUrl": "$api_url",
  "systemImage": "$emulator_system_image_package",
  "deviceProfile": "$emulator_device_profile",
  "avdBootProfileVerified": true,
  "emulatorConsolePort": $emulator_port,
  "emulatorAdbPort": $emulator_adb_port,
  "emulatorPortSelectionAttempts": $emulator_port_attempts,
  "adbServerPort": $adb_server_port,
  "adbServerPortSelectionAttempts": $adb_server_port_attempts,
  "adbServerIsolated": true,
  "adbKeyHomePrivate": true,
  "adbVendorKeysExactFile": true,
  "adbPublicKeyPayloadSha256": "$adb_public_key_payload_sha256",
  "adbTransportExplicitlyConnected": true,
  "hostListing": true,
  "hostReadiness": true,
  "readonlyHydration": true,
  "observerAttachAllowed": $observer_attach_allowed,
  "observerAttachOnlyWhenIdle": true,
  "mutationRequests": 0,
  "daemonRestarted": false,
  "bearerInArgv": false,
  "bearerInEnvironment": false,
  "oneShotNoBackupImportRemoved": true,
  "appPrivateExactAndPatternScan": true,
  "retainedExactAndPatternScan": true,
  "residualProcesses": 0,
  "residualPorts": 0
}
EOF
find "$artifacts_dir" -type d -exec chmod 700 {} +
find "$artifacts_dir" -type f -exec chmod 600 {} +
(
  cd "$artifacts_dir"
  while IFS= read -r -d '' evidence_file; do
    sha256sum "$evidence_file"
  done < <(
    find . -type f \
      ! -name external-canary-sha256sums.txt \
      ! -name external-canary-evidence-scan.log \
      -print0 | LC_ALL=C sort -z
  )
) > "$artifacts_dir/external-canary-sha256sums.txt"
run_external_canary_evidence_scan_status=0
run_external_canary_evidence_scan || run_external_canary_evidence_scan_status=$?
if (( run_external_canary_evidence_scan_status != 0 )); then
  rm -f "$artifacts_dir/external-canary-receipt.json" "$artifacts_dir/external-canary-sha256sums.txt"
  printf '%s\n' 'external canary retained-evidence scan failed' >&2
  exit "$run_external_canary_evidence_scan_status"
fi
printf 'External Pi Droid canary verified: readonly=true observerAllowed=%s artifacts=%s\n' \
  "$observer_attach_allowed" "$artifacts_dir"
