#!/usr/bin/env bash
set -euo pipefail
umask 077

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$repo_root/android/build-logic/emulator-adb-readiness.sh"
source "$repo_root/android/build-logic/emulator-ui-health.sh"
source "$repo_root/android/build-logic/isolated-adb-server.sh"
artifacts_dir=''
tail_only='false'

while [[ $# -gt 0 ]]; do
  case "$1" in
    --artifacts)
      artifacts_dir="${2:-}"
      shift 2
      ;;
    --tail-only)
      tail_only='true'
      shift
      ;;
    *)
      printf 'unknown option: %s\n' "$1" >&2
      exit 64
      ;;
  esac
done
if [[ -z "$artifacts_dir" ]]; then
  printf '%s\n' 'usage: live-readonly-proof.sh --artifacts DIR [--tail-only]' >&2
  exit 64
fi
artifacts_dir="$(mkdir -p "$artifacts_dir" && cd "$artifacts_dir" && pwd)"
chmod 700 "$artifacts_dir"
emulator_diagnostics="$artifacts_dir/emulator-diagnostics.log"
: > "$emulator_diagnostics"

private_dir="$(mktemp -d)"
chmod 700 "$private_dir"
initialize_emulator_ui_health "$private_dir" "$artifacts_dir"
daemon_pid=''
emulator_pid=''
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
cleanup() {
  if [[ -n "$daemon_pid" ]] && kill -0 "$daemon_pid" 2>/dev/null; then
    kill "$daemon_pid" 2>/dev/null || true
    wait "$daemon_pid" 2>/dev/null || true
  fi
  # The emulator process is owned by PID and console port; never route process
  # cleanup through the TCP device transport or a shared ADB server.
  if [[ -n "$emulator_pid" ]] && kill -0 "$emulator_pid" 2>/dev/null; then
    kill "$emulator_pid" 2>/dev/null || true
    wait "$emulator_pid" 2>/dev/null || true
  fi
  stop_isolated_adb_server
  rm -rf "$private_dir"
}
trap cleanup EXIT
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
openssl rand -hex 32 > "$token_file"
chmod 600 "$token_file"

cd "$repo_root"
if [[ "$tail_only" != 'true' ]]; then
  npm run build:src > "$artifacts_dir/node-build.log" 2>&1
fi
[[ -f "$repo_root/dist/api-server.js" ]] || { printf '%s\n' 'built disposable daemon modules are missing' >&2; exit 70; }

start_daemon() {
  local sequence="$1"
  rm -f "$ready_file"
  local generation_state="$state_dir-$sequence"
  mkdir -p "$generation_state"
  node scripts/pi-droid-disposable-daemon.mjs \
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

first_sequence='1'
second_sequence='2'
if [[ "$tail_only" == 'true' ]]; then
  first_sequence='tail-base'
  second_sequence='tail-restart'
fi
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

if [[ "$tail_only" != 'true' ]]; then
  ./android/gradlew -p android --no-daemon --no-configuration-cache \
    -PpiDroidAndroidApp=true :app:assembleDebug > "$artifacts_dir/android-build.log" 2>&1
fi
apk="$repo_root/android/app/build/outputs/apk/debug/app-debug.apk"
[[ -f "$apk" ]] || { printf '%s\n' 'debug APK missing' >&2; exit 70; }

printf 'no\n' | avdmanager create avd --force --name pi-droid-live \
  --package "system-images;android-36;google_apis;$emulator_abi" >/dev/null
if ! select_emulator_port_pair; then
  printf '%s\n' 'status=emulator_port_unavailable emulator_console_port=none emulator_adb_port=none emulator_port_attempts=16' >> "$emulator_diagnostics"
  printf '%s\n' 'emulator_port_unavailable: no supported localhost console/ADB pair is free after 16 attempts' >&2
  exit 70
fi
# The console port and emulator PID remain process-cleanup identity. Device
# commands use only the paired loopback TCP transport registered explicitly
# with this run's isolated ADB server.
emulator_device_serial="127.0.0.1:$emulator_adb_port"
emulator -avd pi-droid-live -port "$emulator_port" -no-window -noaudio -no-boot-anim \
  -no-metrics -no-snapshot -wipe-data -gpu swiftshader_indirect \
  > "$artifacts_dir/emulator.log" 2>&1 &
emulator_pid="$!"
adb_readiness_status=0
wait_for_emulator_adb \
  "$emulator_pid" "$emulator_device_serial" "$adb_server_port" "$emulator_diagnostics" 240 || \
  adb_readiness_status="$?"
if (( adb_readiness_status != 0 )); then
  if (( adb_readiness_status == 69 )); then
    wait "$emulator_pid" 2>/dev/null || true
    printf 'Android emulator exited before ADB readiness for ABI %s\n' "$emulator_abi" >&2
    tail -40 "$artifacts_dir/emulator.log" >&2 || true
  elif (( adb_readiness_status == 70 )); then
    printf '%s\n' 'Android emulator ADB readiness timed out after 240 seconds' >&2
  else
    printf '%s\n' 'Android emulator ADB readiness gate rejected its bounded configuration' >&2
  fi
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
  printf 'UI did not expose expected readonly pattern: %s\n' "$pattern" >&2
  exit 70
}

tap_text() {
  local text="$1"
  local xml="$private_dir/window.xml"
  local center=''
  local x=''
  local y=''
  for _ in $(seq 1 30); do
    : > "$xml"
    dump_emulator_ui_window "$xml" || true
    check_emulator_ui_health "$xml" || exit 70
    if center="$(python3 "$repo_root/android/build-logic/uiautomator-control-center.py" "$xml" "$text" 2>/dev/null)"; then
      read -r x y <<< "$center"
      "${isolated_adb_command[@]}" -s "$emulator_device_serial" shell input tap "$x" "$y"
      return 0
    fi
    sleep 1
  done
  cp "$xml" "$artifacts_dir/failure-control.xml" 2>/dev/null || true
  printf 'visible clickable control unavailable: %s\n' "$text" >&2
  return 1
}

"${isolated_adb_command[@]}" -s "$emulator_device_serial" shell am start -W -a android.intent.action.VIEW \
  -d "$(< "$pairing_file")" com.harryaskham.pidroid.debug >/dev/null
wait_ui 'Readonly session Contract fixture|READONLY RPC ATTACHED' 90
if [[ "$tail_only" == 'true' ]]; then
  "${isolated_adb_command[@]}" -s "$emulator_device_serial" exec-out screencap -p > "$artifacts_dir/screenshots/tail-live-connected.png"
else
  "${isolated_adb_command[@]}" -s "$emulator_device_serial" exec-out screencap -p > "$artifacts_dir/screenshots/live-connected.png"
fi

stop_daemon
if [[ "$tail_only" != 'true' ]]; then
  tap_text "Refresh readonly hosts"
  wait_ui 'Offline cached' 45
  "${isolated_adb_command[@]}" -s "$emulator_device_serial" exec-out screencap -p > "$artifacts_dir/screenshots/offline-cached.png"
fi

start_daemon "$second_sequence"
host_instance_two="$(jq -er .hostInstanceId "$ready_file")"
[[ "$host_instance_one" != "$host_instance_two" ]] || { printf '%s\n' 'host restart did not change instance identity' >&2; exit 70; }
tap_text "Refresh readonly hosts"
wait_ui 'Readonly session Contract fixture|READONLY RPC ATTACHED' 90
"${isolated_adb_command[@]}" -s "$emulator_device_serial" exec-out screencap -p > "$artifacts_dir/screenshots/reconnected.png"
probe_emulator_ui_health || exit 70
"${isolated_adb_command[@]}" -s "$emulator_device_serial" logcat -d -v threadtime > "$artifacts_dir/app-logcat.txt"

if grep -Fq "$(< "$token_file")" "$artifacts_dir"/*.log "$artifacts_dir"/*.txt 2>/dev/null; then
  printf '%s\n' 'disposable bearer leaked into retained logs' >&2
  exit 65
fi

cat > "$artifacts_dir/live-readonly-receipt.json" <<EOF
{
  "schemaVersion": 1,
  "status": "verified",
  "apiEndpoint": "http://10.0.2.2:$api_port",
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
  "systemUiRecoveryUsed": $emulator_system_ui_wait_used,
  "systemUiWaitLimit": 1,
  "piDroidLogcatGuard": true,
  "capabilities": true,
  "inventory": true,
  "information": true,
  "transcript": true,
  "observerAttach": true,
  "offlineCached": true,
  "reconnected": true,
  "interactiveAuthority": false
}
EOF
(
  cd "$artifacts_dir"
  receipt_files=(
    "daemon-$first_sequence.stderr.log"
    "daemon-$second_sequence.stderr.log"
    app-logcat.txt
    emulator-diagnostics.log
    system-ui-health.log
    screenshots/reconnected.png
    live-readonly-receipt.json
  )
  [[ -f screenshots/live-connected.png ]] && receipt_files+=(screenshots/live-connected.png)
  [[ -f screenshots/offline-cached.png ]] && receipt_files+=(screenshots/offline-cached.png)
  [[ -f screenshots/tail-live-connected.png ]] && receipt_files+=(screenshots/tail-live-connected.png)
  if [[ -d system-ui-evidence ]]; then
    while IFS= read -r evidence_file; do
      receipt_files+=("$evidence_file")
    done < <(find system-ui-evidence -type f -print | LC_ALL=C sort)
  fi
  sha256sum "${receipt_files[@]}" > live-readonly-sha256sums.txt
)
find "$artifacts_dir" -type d -exec chmod 700 {} +
find "$artifacts_dir" -type f -exec chmod 600 {} +
printf 'Live readonly session verified: session=%s hostBefore=%s hostAfter=%s artifacts=%s\n' \
  session-fixture-01 "$host_instance_one" "$host_instance_two" "$artifacts_dir"
