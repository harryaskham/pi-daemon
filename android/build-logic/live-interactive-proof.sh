#!/usr/bin/env bash
set -euo pipefail
umask 077

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$repo_root/android/build-logic/emulator-adb-readiness.sh"
source "$repo_root/android/build-logic/emulator-avd-boot-profile.sh"
source "$repo_root/android/build-logic/emulator-ui-health.sh"
source "$repo_root/android/build-logic/isolated-adb-server.sh"
source "$repo_root/android/build-logic/physical-proof-lifecycle.sh"
artifacts_dir=''

while [[ $# -gt 0 ]]; do
  case "$1" in
    --artifacts)
      artifacts_dir="${2:-}"
      shift 2
      ;;
    *)
      printf 'unknown option: %s\n' "$1" >&2
      exit 64
      ;;
  esac
done
if [[ -z "$artifacts_dir" ]]; then
  printf '%s\n' 'usage: live-interactive-proof.sh --artifacts DIR' >&2
  exit 64
fi
artifacts_dir="$(mkdir -p "$artifacts_dir" && cd "$artifacts_dir" && pwd)"
chmod 700 "$artifacts_dir"
emulator_diagnostics="$artifacts_dir/emulator-diagnostics.log"
: > "$emulator_diagnostics"

private_dir="$(mktemp -d)"
chmod 700 "$private_dir"
emulator_raw_log="$private_dir/emulator.log"
emulator_guest_console_socket="$private_dir/emulator-guest-console.sock"
emulator_guest_console_log="$private_dir/emulator-guest-console.log"
emulator_guest_console_state="$private_dir/emulator-guest-console.state"
emulator_readiness_evidence="$artifacts_dir/emulator-readiness-evidence.log"
initialize_emulator_ui_health "$private_dir" "$artifacts_dir"
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
token_file=''
disposable_bearer_created='false'
physical_proof_bearer_scan_complete='false'
physical_proof_bearer_scan_status=70
cleanup() {
  local original_status="${1:-$?}"
  local scan_status=0
  local final_status="$original_status"
  trap - EXIT
  set +e
  stop_physical_proof_owned_processes
  run_physical_proof_bearer_scan
  scan_status=$?
  if (( scan_status != 0 )); then
    final_status="$scan_status"
  fi
  rm -rf "$private_dir" || final_status=70
  exit "$final_status"
}
trap 'cleanup "$?"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

start_isolated_adb_server \
  "$private_dir" \
  "$emulator_diagnostics" \
  "$repo_root/android/build-logic/select-adb-server-port.py"
isolated_adb_command=(adb -H 127.0.0.1 -P "$adb_server_port")

reserve_port_pair() {
  local start="${1:-49152}"
  local end="${2:-61000}"
  python3 - "$start" "$end" <<'PY'
import socket, sys
for port in range(int(sys.argv[1]), int(sys.argv[2]), 2):
    sockets = []
    try:
        for candidate in (port, port + 1):
            sock = socket.socket()
            sock.bind(("127.0.0.1", candidate))
            sockets.append(sock)
    except OSError:
        pass
    else:
        print(port)
        break
    finally:
        for sock in sockets:
            sock.close()
else:
    raise SystemExit("no free port pair")
PY
}

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

api_port="$(reserve_port_pair 49152 61000)"
token_file="$private_dir/service-bearer"
ready_file="$private_dir/daemon-ready.json"
state_dir="$private_dir/daemon-state"
pairing_file="$private_dir/pairing-envelope"
mkdir -p "$state_dir" "$artifacts_dir/screenshots"
emulator_abi='x86_64'
{
  printf 'host_arch=%s\n' "$(uname -m)"
  printf 'expected_emulator_abi=%s\n' "$emulator_abi"
  printf 'emulator_binary=%s\n' "$(command -v emulator)"
  emulator -version 2>&1 | head -3
  emulator -accel-check 2>&1 || true
  printf 'adb_binary=%s\n' "$(command -v adb)"
  adb version 2>&1 | head -3
} >> "$emulator_diagnostics"
openssl rand -hex 32 > "$token_file"
chmod 600 "$token_file"
disposable_bearer_created='true'

cd "$repo_root"
npm run build:src > "$artifacts_dir/node-build.log" 2>&1
[[ -f "$repo_root/dist/api-server.js" ]] || { printf '%s\n' 'built disposable daemon modules are missing' >&2; exit 70; }

start_daemon() {
  local sequence="$1"
  rm -f "$ready_file"
  local generation_state="$state_dir-$sequence"
  mkdir -p "$generation_state"
  node scripts/pi-droid-disposable-daemon.mjs \
    --interactive \
    --port "$api_port" \
    --token-file "$token_file" \
    --ready-file "$ready_file" \
    --state-dir "$generation_state" \
    > "$artifacts_dir/daemon-$sequence.stdout.log" \
    2> "$artifacts_dir/daemon-$sequence.stderr.log" &
  daemon_pid="$!"
  for _ in $(seq 1 120); do
    [[ -s "$ready_file" ]] && return
    if ! kill -0 "$daemon_pid" 2>/dev/null; then
      printf 'disposable Pi Daemon exited before readiness (generation %s)\n' "$sequence" >&2
      exit 70
    fi
    sleep 0.25
  done
  printf 'disposable Pi Daemon readiness timed out (generation %s)\n' "$sequence" >&2
  exit 70
}

stop_daemon() {
  kill "$daemon_pid"
  wait "$daemon_pid"
  daemon_pid=''
}

first_sequence='interactive-base'
second_sequence='interactive-restart'
start_daemon "$first_sequence"
host_instance_one="$(jq -er .hostInstanceId "$ready_file")"

python3 - "$token_file" "$pairing_file" "$api_port" <<'PY'
import base64, json, os, pathlib, sys
raw = pathlib.Path(sys.argv[1]).read_text().strip()
payload = {
    "version": 1,
    "apiUrl": f"http://10.0.2.2:{sys.argv[3]}",
    "displayName": "Disposable Pi Daemon",
    "bearer": raw,
}
encoded = base64.urlsafe_b64encode(json.dumps(payload, separators=(",", ":")).encode()).decode().rstrip("=")
path = pathlib.Path(sys.argv[2])
path.write_text(f"pidroid://pair/v1/{encoded}")
os.chmod(path, 0o600)
PY

./android/gradlew -p android --no-daemon --no-configuration-cache \
  -PpiDroidAndroidApp=true :app:assembleDebug > "$artifacts_dir/android-build.log" 2>&1
apk="$repo_root/android/app/build/outputs/apk/debug/app-debug.apk"
[[ -f "$apk" ]] || { printf '%s\n' 'debug APK missing' >&2; exit 70; }

if ! create_api36_google_apis_x86_64_avd pi-droid-live "$emulator_diagnostics"; then
  printf '%s\n' 'Android emulator AVD boot profile is unavailable or invalid' >&2
  exit 70
fi
if ! select_emulator_port_pair; then
  printf '%s\n' 'status=emulator_port_unavailable emulator_console_port=none emulator_adb_port=none emulator_port_attempts=16' >> "$emulator_diagnostics"
  printf '%s\n' 'emulator_port_unavailable: no supported localhost console/ADB pair is free after 16 attempts' >&2
  exit 70
fi
# The console port and emulator PID remain process-cleanup identity. Device
# commands use only the paired loopback TCP transport registered explicitly
# with this run's isolated ADB server.
emulator_device_serial="127.0.0.1:$emulator_adb_port"
# Hold emulator-to-adbd traffic until guest boot completion. Emulator 36.6 can
# otherwise expose the TCP bridge early enough for an accepted transport to
# remain offline indefinitely. Kernel and private root-console output provide
# bounded timeout discrimination without broad reconnects.
python3 "$repo_root/android/build-logic/emulator-guest-console-recorder.py" \
  --console-socket "$emulator_guest_console_socket" \
  --raw-log "$emulator_guest_console_log" \
  --state "$emulator_guest_console_state" &
emulator_console_probe_pid="$!"
emulator -avd pi-droid-live -port "$emulator_port" -no-window -noaudio -no-boot-anim \
  -no-metrics -no-snapshot -wipe-data -gpu swiftshader_indirect -delay-adb -show-kernel \
  -shell-serial "unix:$emulator_guest_console_socket,server" \
  > "$emulator_raw_log" 2>&1 &
emulator_pid="$!"
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
  if (( adb_readiness_status == 69 )); then
    wait "$emulator_pid" 2>/dev/null || true
    printf 'Android emulator exited before ADB readiness for ABI %s\n' "$emulator_abi" >&2
  elif (( adb_readiness_status == 70 )); then
    printf '%s\n' 'Android emulator ADB readiness timed out after 240 seconds' >&2
  else
    printf '%s\n' 'Android emulator ADB readiness gate rejected its bounded configuration' >&2
  fi
  [[ ! -f "$emulator_readiness_evidence" ]] || tail -40 "$emulator_readiness_evidence" >&2 || true
  exit 70
fi
{
  printf 'adb_state=%s\n' "$("${isolated_adb_command[@]}" -s "$emulator_device_serial" get-state 2>&1 || true)"
  printf 'device_abi=%s\n' "$("${isolated_adb_command[@]}" -s "$emulator_device_serial" shell getprop ro.product.cpu.abi 2>&1 | tr -d '\r' || true)"
} >> "$artifacts_dir/emulator-diagnostics.log"
booted=''
for _ in $(seq 1 240); do
  booted="$("${isolated_adb_command[@]}" -s "$emulator_device_serial" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')"
  [[ "$booted" == '1' ]] && break
  kill -0 "$emulator_pid" 2>/dev/null || { printf '%s\n' 'emulator exited before boot' >&2; exit 70; }
  sleep 1
done
if [[ "$booted" != '1' ]]; then
  {
    printf 'boot_completed=%s\n' "$booted"
    printf 'boot_animation=%s\n' "$("${isolated_adb_command[@]}" -s "$emulator_device_serial" shell getprop init.svc.bootanim 2>&1 | tr -d '\r' || true)"
  } >> "$artifacts_dir/emulator-diagnostics.log"
  printf '%s\n' 'emulator boot timed out' >&2
  exit 70
fi
printf 'boot_completed=1\n' >> "$artifacts_dir/emulator-diagnostics.log"
probe_emulator_ui_health || exit 70
"${isolated_adb_command[@]}" -s "$emulator_device_serial" install -r "$apk" >/dev/null
"${isolated_adb_command[@]}" -s "$emulator_device_serial" shell wm size 1080x2400 >/dev/null
"${isolated_adb_command[@]}" -s "$emulator_device_serial" shell wm density 420 >/dev/null
"${isolated_adb_command[@]}" -s "$emulator_device_serial" shell screenrecord --time-limit 180 /sdcard/pi-droid-interactive.mp4 \
  > "$artifacts_dir/screenrecord.log" 2>&1 &
screenrecord_pid="$!"

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
  "${isolated_adb_command[@]}" -s "$emulator_device_serial" exec-out screencap -p > "$artifacts_dir/screenshots/failure.png" 2>/dev/null || true
  "${isolated_adb_command[@]}" -s "$emulator_device_serial" logcat -d -v threadtime > "$artifacts_dir/failure-logcat.txt" 2>/dev/null || true
  cp "$xml" "$artifacts_dir/failure-window.xml" 2>/dev/null || true
  printf 'UI did not expose expected interactive pattern: %s\n' "$pattern" >&2
  exit 70
}

wait_control() {
  local text="$1"
  local attempts="${2:-30}"
  local xml="$private_dir/window.xml"
  local center=''
  for _ in $(seq 1 "$attempts"); do
    : > "$xml"
    dump_emulator_ui_window "$xml" || true
    check_emulator_ui_health "$xml" || exit 70
    if center="$(python3 "$repo_root/android/build-logic/uiautomator-control-center.py" "$xml" "$text" 2>/dev/null)"; then
      printf '%s\n' "$center"
      return 0
    fi
    sleep 1
  done
  cp "$xml" "$artifacts_dir/failure-control.xml" 2>/dev/null || true
  printf 'visible clickable control unavailable: %s\n' "$text" >&2
  return 1
}

tap_text() {
  local text="$1"
  local x y
  read -r x y < <(wait_control "$text")
  "${isolated_adb_command[@]}" -s "$emulator_device_serial" shell input tap "$x" "$y"
}

wait_emulator_host_port() {
  local max_attempts=60
  local attempt=0
  local gate_log="$artifacts_dir/emulator-host-port-gate.log"
  : > "$gate_log"
  printf 'port=%s max_attempts=%s deadline_seconds=30 safe_code=host_port_unreachable\n' \
    "$api_port" "$max_attempts" >> "$gate_log"
  while (( attempt < max_attempts )); do
    attempt=$((attempt + 1))
    if "${isolated_adb_command[@]}" -s "$emulator_device_serial" shell toybox nc -z -w 1 10.0.2.2 "$api_port" >/dev/null 2>&1; then
      printf 'status=reachable attempts=%s port=%s\n' "$attempt" "$api_port" >> "$gate_log"
      return 0
    fi
    sleep 0.5
  done
  printf 'status=host_port_unreachable attempts=%s port=%s\n' "$attempt" "$api_port" >> "$gate_log"
  return 1
}

if ! wait_emulator_host_port; then
  printf 'host_port_unreachable: port=%s attempts=60 deadline_seconds=30\n' "$api_port" >&2
  exit 70
fi

"${isolated_adb_command[@]}" -s "$emulator_device_serial" shell am start -W -a android.intent.action.VIEW \
  -d "$(< "$pairing_file")" com.harryaskham.pidroid.debug >/dev/null
wait_ui 'Readonly session Contract fixture|READONLY RPC ATTACHED' 90
"${isolated_adb_command[@]}" -s "$emulator_device_serial" exec-out screencap -p > "$artifacts_dir/screenshots/readonly-hydrated.png"

tap_text "Connect interactive observer"
wait_ui 'ACTION RECEIVED · CONNECTING|OBSERVER · READY|INTERACTIVE ERROR · PREFLIGHT_ERROR · [A-Z][A-Z0-9_]{0,127}' 15
wait_ui 'OBSERVER · READY' 45
"${isolated_adb_command[@]}" -s "$emulator_device_serial" exec-out screencap -p > "$artifacts_dir/screenshots/observer-ready.png"
tap_text "Request control"
wait_ui 'REQUESTING|CONTROLLER' 45
wait_ui 'CONTROLLER|Controller authority active' 45
"${isolated_adb_command[@]}" -s "$emulator_device_serial" exec-out screencap -p > "$artifacts_dir/screenshots/controller-granted.png"

tap_text "Session prompt composer"
"${isolated_adb_command[@]}" -s "$emulator_device_serial" shell input text interactive-proof
tap_text "Send prompt"
wait_ui 'PROMPT SUCCEEDED|Command prompt succeeded' 45
"${isolated_adb_command[@]}" -s "$emulator_device_serial" exec-out screencap -p > "$artifacts_dir/screenshots/prompt-succeeded.png"
"${isolated_adb_command[@]}" -s "$emulator_device_serial" shell input keyevent KEYCODE_BACK
sleep 1
tree_center=''
if ! tree_center="$(wait_control "Show tree presentation" 30)"; then
  "${isolated_adb_command[@]}" -s "$emulator_device_serial" exec-out screencap -p > "$artifacts_dir/screenshots/tree-control-occluded.png" 2>/dev/null || true
  cp "$private_dir/window.xml" "$artifacts_dir/tree-control-occluded.xml" 2>/dev/null || true
  (
    cd "$artifacts_dir"
    sha256sum screenshots/tree-control-occluded.png tree-control-occluded.xml > tree-control-occluded-sha256sums.txt 2>/dev/null || true
  )
  printf '%s\n' 'tree_control_occluded' >&2
  exit 70
fi
read -r tree_x tree_y <<< "$tree_center"
"${isolated_adb_command[@]}" -s "$emulator_device_serial" shell input tap "$tree_x" "$tree_y"
wait_ui 'Branch tree' 30
"${isolated_adb_command[@]}" -s "$emulator_device_serial" exec-out screencap -p > "$artifacts_dir/screenshots/tree-live.png"
tap_text "Show tui presentation"
wait_ui 'Pi Droid interactive|OBSERVER · INPUT INERT' 30
"${isolated_adb_command[@]}" -s "$emulator_device_serial" exec-out screencap -p > "$artifacts_dir/screenshots/tui-live.png"

tap_text "Show rich presentation"
tap_text "Session prompt composer"
"${isolated_adb_command[@]}" -s "$emulator_device_serial" shell input text hold-until-disconnect
tap_text "Send prompt"
wait_ui 'PROMPT IN_FLIGHT|Command prompt in_flight' 30
stop_daemon
wait_ui 'PROMPT INDETERMINATE|Command prompt indeterminate' 45
"${isolated_adb_command[@]}" -s "$emulator_device_serial" exec-out screencap -p > "$artifacts_dir/screenshots/indeterminate-no-replay.png"

start_daemon "$second_sequence"
host_instance_two="$(jq -er .hostInstanceId "$ready_file")"
[[ "$host_instance_one" != "$host_instance_two" ]] || { printf '%s\n' 'host restart did not change instance identity' >&2; exit 70; }
tap_text "Refresh readonly hosts"
wait_ui 'Readonly session Contract fixture|READONLY RPC ATTACHED' 90
tap_text "Reconnect interactive session"
wait_ui 'OBSERVER · READY' 45
tap_text "Request control"
wait_ui 'REQUESTING|CONTROLLER' 45
wait_ui 'CONTROLLER|Controller authority active' 45
tap_text "Session prompt composer"
"${isolated_adb_command[@]}" -s "$emulator_device_serial" shell input text restart-reconciled
tap_text "Send prompt"
wait_ui 'PROMPT SUCCEEDED|Command prompt succeeded' 45
"${isolated_adb_command[@]}" -s "$emulator_device_serial" exec-out screencap -p > "$artifacts_dir/screenshots/reconnected-controller-phone.png"
"${isolated_adb_command[@]}" -s "$emulator_device_serial" shell wm size 1600x2560 >/dev/null
"${isolated_adb_command[@]}" -s "$emulator_device_serial" shell wm density 240 >/dev/null
sleep 2
wait_ui 'CONTROLLER|Controller authority active' 30
"${isolated_adb_command[@]}" -s "$emulator_device_serial" exec-out screencap -p > "$artifacts_dir/screenshots/reconnected-controller-tablet.png"
probe_emulator_ui_health || exit 70
"${isolated_adb_command[@]}" -s "$emulator_device_serial" logcat -d -v threadtime > "$artifacts_dir/app-logcat.txt"

if [[ -n "$screenrecord_pid" ]] && kill -0 "$screenrecord_pid" 2>/dev/null; then
  kill -INT "$screenrecord_pid" 2>/dev/null || true
  wait "$screenrecord_pid" 2>/dev/null || true
fi
screenrecord_pid=''
"${isolated_adb_command[@]}" -s "$emulator_device_serial" pull /sdcard/pi-droid-interactive.mp4 "$artifacts_dir/pi-droid-interactive.mp4" >/dev/null

# Finalize every run-owned writer before hashing and scanning retained evidence.
stop_physical_proof_owned_processes
cat > "$artifacts_dir/live-interactive-receipt.json" <<EOF
{
  "schemaVersion": 1,
  "status": "verified",
  "apiEndpoint": "http://10.0.2.2:$api_port",
  "systemImage": "system-images;android-36;google_apis;x86_64",
  "deviceProfile": "medium_phone",
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
  "adbDeviceSerialTcp": true,
  "sessionId": "session-fixture-01",
  "generation": 3,
  "hostInstanceBefore": "$host_instance_one",
  "hostInstanceAfter": "$host_instance_two",
  "hostPortGate": true,
  "systemUiRecoveryUsed": $emulator_system_ui_wait_used,
  "systemUiWaitLimit": 1,
  "piDroidLogcatGuard": true,
  "disposableBearerRetainedTextScan": true,
  "disposableBearerLeak": false,
  "observerReadyBeforeControl": true,
  "observerDeniedUntilGrant": true,
  "controllerGranted": true,
  "uniquePromptSucceeded": true,
  "treeRendered": true,
  "tuiRendered": true,
  "missingAcknowledgementIndeterminate": true,
  "blindReplay": false,
  "reconnected": true,
  "postRestartPromptSucceeded": true
}
EOF
(
  cd "$artifacts_dir"
  receipt_files=(
    "daemon-$first_sequence.stderr.log"
    "daemon-$second_sequence.stderr.log"
    app-logcat.txt
    emulator-diagnostics.log
    emulator-host-port-gate.log
    system-ui-health.log
    pi-droid-interactive.mp4
    screenshots/readonly-hydrated.png
    screenshots/observer-ready.png
    screenshots/controller-granted.png
    screenshots/prompt-succeeded.png
    screenshots/tree-live.png
    screenshots/tui-live.png
    screenshots/indeterminate-no-replay.png
    screenshots/reconnected-controller-phone.png
    screenshots/reconnected-controller-tablet.png
    live-interactive-receipt.json
  )
  if [[ -d system-ui-evidence ]]; then
    while IFS= read -r evidence_file; do
      receipt_files+=("$evidence_file")
    done < <(find system-ui-evidence -type f -print | LC_ALL=C sort)
  fi
  sha256sum "${receipt_files[@]}" > live-interactive-sha256sums.txt
)
bearer_scan_status=0
run_physical_proof_bearer_scan || bearer_scan_status=$?
if (( bearer_scan_status != 0 )); then
  rm -f "$artifacts_dir/live-interactive-receipt.json" "$artifacts_dir/live-interactive-sha256sums.txt"
  printf '%s\n' 'disposable bearer retained-evidence scan failed' >&2
  exit "$bearer_scan_status"
fi
find "$artifacts_dir" -type d -exec chmod 700 {} +
find "$artifacts_dir" -type f -exec chmod 600 {} +
printf 'Live interactive session verified: session=%s hostBefore=%s hostAfter=%s artifacts=%s\n' \
  session-fixture-01 "$host_instance_one" "$host_instance_two" "$artifacts_dir"
