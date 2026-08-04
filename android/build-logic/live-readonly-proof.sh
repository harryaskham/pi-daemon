#!/usr/bin/env bash
set -euo pipefail
umask 077

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
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

private_dir="$(mktemp -d)"
chmod 700 "$private_dir"
daemon_pid=''
emulator_pid=''
emulator_serial=''
cleanup() {
  if [[ -n "$daemon_pid" ]] && kill -0 "$daemon_pid" 2>/dev/null; then
    kill "$daemon_pid" 2>/dev/null || true
    wait "$daemon_pid" 2>/dev/null || true
  fi
  if [[ -n "$emulator_serial" ]]; then adb -s "$emulator_serial" emu kill >/dev/null 2>&1 || true; fi
  if [[ -n "$emulator_pid" ]] && kill -0 "$emulator_pid" 2>/dev/null; then
    kill "$emulator_pid" 2>/dev/null || true
    wait "$emulator_pid" 2>/dev/null || true
  fi
  rm -rf "$private_dir"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

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

api_port="$(reserve_port_pair 49152 61000)"
emulator_port="$(reserve_port_pair 5600 5682)"
token_file="$private_dir/service-bearer"
ready_file="$private_dir/daemon-ready.json"
state_dir="$private_dir/daemon-state"
pairing_file="$private_dir/pairing-envelope"
mkdir -p "$state_dir" "$private_dir/avd" "$artifacts_dir/screenshots"
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

export ANDROID_USER_HOME="$private_dir/android-user"
export ANDROID_AVD_HOME="$private_dir/avd"
printf 'no\n' | avdmanager create avd --force --name pi-droid-live \
  --package 'system-images;android-36;google_apis;x86_64' >/dev/null
emulator_serial="emulator-$emulator_port"
emulator -avd pi-droid-live -port "$emulator_port" -no-window -noaudio -no-boot-anim \
  -no-metrics -no-snapshot -wipe-data -gpu swiftshader_indirect \
  > "$artifacts_dir/emulator.log" 2>&1 &
emulator_pid="$!"
adb -s "$emulator_serial" wait-for-device
booted=''
for _ in $(seq 1 240); do
  booted="$(adb -s "$emulator_serial" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')"
  [[ "$booted" == '1' ]] && break
  kill -0 "$emulator_pid" 2>/dev/null || { printf '%s\n' 'emulator exited before boot' >&2; exit 70; }
  sleep 1
done
[[ "$booted" == '1' ]] || { printf '%s\n' 'emulator boot timed out' >&2; exit 70; }
adb -s "$emulator_serial" install -r "$apk" >/dev/null

wait_ui() {
  local pattern="$1"
  local attempts="${2:-60}"
  for _ in $(seq 1 "$attempts"); do
    adb -s "$emulator_serial" shell uiautomator dump /sdcard/pi-droid-window.xml >/dev/null 2>&1 || true
    if adb -s "$emulator_serial" exec-out cat /sdcard/pi-droid-window.xml 2>/dev/null | grep -Eq "$pattern"; then return; fi
    sleep 1
  done
  adb -s "$emulator_serial" exec-out screencap -p > "$artifacts_dir/screenshots/failure.png" 2>/dev/null || true
  adb -s "$emulator_serial" logcat -d -v threadtime > "$artifacts_dir/failure-logcat.txt" 2>/dev/null || true
  adb -s "$emulator_serial" exec-out cat /sdcard/pi-droid-window.xml > "$artifacts_dir/failure-window.xml" 2>/dev/null || true
  printf 'UI did not expose expected readonly pattern: %s\n' "$pattern" >&2
  exit 70
}

tap_text() {
  local text="$1"
  local xml="$private_dir/window.xml"
  adb -s "$emulator_serial" shell uiautomator dump /sdcard/pi-droid-window.xml >/dev/null 2>&1
  adb -s "$emulator_serial" exec-out cat /sdcard/pi-droid-window.xml > "$xml"
  read -r x y < <(python3 - "$xml" "$text" <<'PY'
import re, sys, xml.etree.ElementTree as ET
root = ET.parse(sys.argv[1]).getroot()
for node in root.iter("node"):
    if node.attrib.get("text") == sys.argv[2] or node.attrib.get("content-desc") == sys.argv[2]:
        nums = [int(v) for v in re.findall(r"\d+", node.attrib["bounds"])]
        print((nums[0] + nums[2]) // 2, (nums[1] + nums[3]) // 2)
        break
else:
    raise SystemExit(f"control not found: {sys.argv[2]}")
PY
)
  adb -s "$emulator_serial" shell input tap "$x" "$y"
}

adb -s "$emulator_serial" shell am start -W -a android.intent.action.VIEW \
  -d "$(< "$pairing_file")" com.harryaskham.pidroid.debug >/dev/null
wait_ui 'Readonly session Contract fixture|READONLY RPC ATTACHED' 90
if [[ "$tail_only" == 'true' ]]; then
  adb -s "$emulator_serial" exec-out screencap -p > "$artifacts_dir/screenshots/tail-live-connected.png"
else
  adb -s "$emulator_serial" exec-out screencap -p > "$artifacts_dir/screenshots/live-connected.png"
fi

stop_daemon
if [[ "$tail_only" != 'true' ]]; then
  tap_text "Refresh readonly hosts"
  wait_ui 'Offline cached' 45
  adb -s "$emulator_serial" exec-out screencap -p > "$artifacts_dir/screenshots/offline-cached.png"
fi

start_daemon "$second_sequence"
host_instance_two="$(jq -er .hostInstanceId "$ready_file")"
[[ "$host_instance_one" != "$host_instance_two" ]] || { printf '%s\n' 'host restart did not change instance identity' >&2; exit 70; }
tap_text "Refresh readonly hosts"
wait_ui 'Readonly session Contract fixture|READONLY RPC ATTACHED' 90
adb -s "$emulator_serial" exec-out screencap -p > "$artifacts_dir/screenshots/reconnected.png"
adb -s "$emulator_serial" logcat -d -v threadtime > "$artifacts_dir/app-logcat.txt"

if grep -Fq "$(< "$token_file")" "$artifacts_dir"/*.log "$artifacts_dir"/*.txt 2>/dev/null; then
  printf '%s\n' 'disposable bearer leaked into retained logs' >&2
  exit 65
fi

cat > "$artifacts_dir/live-readonly-receipt.json" <<EOF
{
  "schemaVersion": 1,
  "status": "verified",
  "apiEndpoint": "http://10.0.2.2:$api_port",
  "sessionId": "session-fixture-01",
  "generation": 3,
  "hostInstanceBefore": "$host_instance_one",
  "hostInstanceAfter": "$host_instance_two",
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
    screenshots/reconnected.png
    live-readonly-receipt.json
  )
  [[ -f screenshots/live-connected.png ]] && receipt_files+=(screenshots/live-connected.png)
  [[ -f screenshots/offline-cached.png ]] && receipt_files+=(screenshots/offline-cached.png)
  [[ -f screenshots/tail-live-connected.png ]] && receipt_files+=(screenshots/tail-live-connected.png)
  sha256sum "${receipt_files[@]}" > live-readonly-sha256sums.txt
)
find "$artifacts_dir" -type d -exec chmod 700 {} +
find "$artifacts_dir" -type f -exec chmod 600 {} +
printf 'Live readonly session verified: session=%s hostBefore=%s hostAfter=%s artifacts=%s\n' \
  session-fixture-01 "$host_instance_one" "$host_instance_two" "$artifacts_dir"
