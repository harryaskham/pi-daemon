import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));

test("external canary readiness grace is evidence-gated, one-time, hard-bounded, and cleanup-safe", () => {
  const helper = path.join(root, "android/build-logic/external-canary-adb-readiness-grace.sh");
  const classifier = path.join(root, "android/build-logic/external-canary-readiness-grace.py");
  const output = execFileSync("bash", ["-c", String.raw`
set -Eeuo pipefail
umask 077
helper="$1"
classifier="$2"
source "$helper"

sandbox="$(mktemp -d)"
owned_fifo="$sandbox/owned.fifo"
unrelated_fifo="$sandbox/unrelated.fifo"
mkfifo "$owned_fifo" "$unrelated_fifo"
command cat "$owned_fifo" >/dev/null &
emulator_pid=$!
command cat "$unrelated_fifo" >/dev/null &
unrelated_pid=$!
cleanup() {
  local pid=''
  trap - EXIT
  for pid in "$emulator_pid" "$unrelated_pid"; do
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
    fi
  done
  rm -rf "$sandbox"
  printf '%s\n' 'fixture_cleanup=completed owned_processes=stopped private_files=removed'
}
trap cleanup EXIT

wait_calls="$sandbox/wait.calls"
: > "$wait_calls"
fixture_wait_mode='unexpected'
wait_for_emulator_adb() {
  printf 'wait_call pid=%s serial=%s server=%s deadline=%s mode=%s\n' \
    "$1" "$2" "$3" "$5" "$fixture_wait_mode" >> "$wait_calls"
  [[ "$1" == "$emulator_pid" ]]
  [[ "$2" == '127.0.0.1:5567' ]]
  [[ "$3" == '42001' ]]
  [[ "$5" =~ ^[12]$ ]]
  case "$fixture_wait_mode" in
    ready) return 0 ;;
    expire)
      SECONDS=$((SECONDS + $5))
      return 70
      ;;
    *) return 64 ;;
  esac
}

write_console_evidence() {
  local fixture_root="$1"
  local evidence_kind="$2"
  local console_log="$fixture_root/console.log"
  local console_state="$fixture_root/console.state"
  case "$evidence_kind" in
    progress)
      cat > "$console_log" <<'EOF'
[    0.000000] Linux version fixture
[    1.000000] Run /init as init process
[  113.000000] apexd: Processing compressed APEX /system/apex/com.android.adbd.capex
[  114.000000] apexd: Decompressing /system/apex/com.android.adbd.capex
sensitive-token=SHOULD_NOT_REACH_TYPED_DIAGNOSTICS
EOF
      ;;
    no-progress)
      cat > "$console_log" <<'EOF'
[    0.000000] Linux version fixture
[    1.000000] Run /init as init process
[  113.000000] apexd: Processing compressed APEX /system/apex/com.android.runtime.capex
EOF
      ;;
    panic)
      cat > "$console_log" <<'EOF'
[    0.000000] Linux version fixture
[    1.000000] Run /init as init process
[  113.000000] apexd: Decompressing /system/apex/com.android.adbd.capex
[  114.000000] Kernel panic - not syncing: fixture
EOF
      ;;
    stall)
      cat > "$console_log" <<'EOF'
[    0.000000] Linux version fixture
[    1.000000] Run /init as init process
[  113.000000] apexd: Decompressing /system/apex/com.android.adbd.capex
[  114.000000] adbd userspace stalled
EOF
      ;;
    *) return 64 ;;
  esac
  chmod 600 "$console_log"
  local console_bytes
  console_bytes="$(wc -c < "$console_log" | tr -d ' ')"
  cat > "$console_state" <<EOF
schema_version=1
guest_console=available
kernel_started=true
init_started=true
kernel_failure=false
raw_console_bytes=$console_bytes
raw_console_truncated=false
EOF
  chmod 600 "$console_state"
}

run_fixture() {
  local name="$1"
  local evidence_kind="$2"
  local wait_mode="$3"
  local started_offset="$4"
  local expected_status="$5"
  local expected_calls="$6"
  local fixture_root="$sandbox/$name"
  local diagnostics="$fixture_root/diagnostics.log"
  local calls_before=0
  local calls_after=0
  local readiness_started_seconds=0
  local status=0
  local target_pid="$emulator_pid"
  mkdir -m 700 "$fixture_root"
  : > "$diagnostics"
  chmod 600 "$diagnostics"
  write_console_evidence "$fixture_root" "$evidence_kind"
  external_canary_adb_readiness_grace_used='false'
  fixture_wait_mode="$wait_mode"
  calls_before="$(wc -l < "$wait_calls" | tr -d ' ')"
  if [[ "$name" == 'hard-bound-expired' ]]; then
    SECONDS=4
    readiness_started_seconds=0
  else
    readiness_started_seconds=$((SECONDS - started_offset))
  fi
  if [[ "$name" == 'emulator-dead' ]]; then
    target_pid=2147483647
  fi
  maybe_grant_external_canary_adb_readiness_grace \
    70 "$readiness_started_seconds" 2 4 \
    "$target_pid" '127.0.0.1:5567' 42001 "$diagnostics" \
    "$fixture_root/console.state" "$fixture_root/console.log" "$classifier" || status=$?
  calls_after="$(wc -l < "$wait_calls" | tr -d ' ')"
  [[ "$status" == "$expected_status" ]]
  [[ "$((calls_after - calls_before))" == "$expected_calls" ]]
  kill -0 "$unrelated_pid" 2>/dev/null
  printf 'fixture=%s result=%s wait_calls=%s unrelated_process=alive grace_used=%s\n' \
    "$name" "$status" "$((calls_after - calls_before))" \
    "$external_canary_adb_readiness_grace_used"
  sed "s/^/fixture=$name diagnostic=/" "$diagnostics"

  if [[ "$name" == 'progress-ready' ]]; then
    local repeated_status=0
    maybe_grant_external_canary_adb_readiness_grace \
      70 "$readiness_started_seconds" 2 4 \
      "$emulator_pid" '127.0.0.1:5567' 42001 "$diagnostics" \
      "$fixture_root/console.state" "$fixture_root/console.log" "$classifier" || repeated_status=$?
    calls_after="$(wc -l < "$wait_calls" | tr -d ' ')"
    [[ "$repeated_status" == 70 ]]
    [[ "$((calls_after - calls_before))" == 1 ]]
    printf 'fixture=%s repeated_result=%s repeated_wait_calls=0\n' "$name" "$repeated_status"
    tail -n 1 "$diagnostics" | sed "s/^/fixture=$name repeated_diagnostic=/"
  fi
}

run_fixture progress-ready progress ready 0 0 1
run_fixture no-progress no-progress unexpected 0 70 0
run_fixture emulator-dead progress unexpected 0 70 0
run_fixture panic-refused panic unexpected 0 70 0
run_fixture stall-refused stall unexpected 0 70 0
run_fixture grace-expired progress expire 0 70 1
run_fixture hard-bound-expired progress unexpected 4 70 0

kill -0 "$emulator_pid" 2>/dev/null
kill -0 "$unrelated_pid" 2>/dev/null
cat "$wait_calls"
printf '%s\n' 'fixture_processes=alive_before_outer_cleanup'
`, "readiness-grace-fixture", helper, classifier], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
  });

  assert.match(output, /fixture=progress-ready result=0 wait_calls=1 unrelated_process=alive grace_used=true/);
  assert.match(output, /fixture=progress-ready diagnostic=phase=adb_readiness_grace status=granted reason=adbd_compressed_apex_forward_progress initial_deadline_seconds=2 grace_deadline_seconds=2 hard_deadline_seconds=4/);
  assert.match(output, /fixture=progress-ready diagnostic=phase=adb_readiness_grace status=completed reason=device_ready/);
  assert.match(output, /fixture=progress-ready repeated_result=70 repeated_wait_calls=0/);
  assert.match(output, /fixture=progress-ready repeated_diagnostic=phase=adb_readiness_grace status=refused reason=already_used/);
  assert.match(output, /fixture=no-progress result=70 wait_calls=0 unrelated_process=alive grace_used=false/);
  assert.match(output, /fixture=no-progress diagnostic=phase=adb_readiness_grace status=refused reason=adbd_compressed_apex_progress_absent/);
  assert.match(output, /fixture=emulator-dead result=70 wait_calls=0 unrelated_process=alive grace_used=false/);
  assert.match(output, /fixture=emulator-dead diagnostic=phase=adb_readiness_grace status=refused reason=emulator_not_alive/);
  assert.match(output, /fixture=panic-refused diagnostic=phase=adb_readiness_grace status=refused reason=panic_or_fatal_marker/);
  assert.match(output, /fixture=stall-refused diagnostic=phase=adb_readiness_grace status=refused reason=stall_marker/);
  assert.match(output, /fixture=grace-expired result=70 wait_calls=1 unrelated_process=alive grace_used=true/);
  assert.match(output, /fixture=grace-expired diagnostic=phase=adb_readiness_grace status=expired reason=additional_deadline_exhausted initial_deadline_seconds=2 grace_deadline_seconds=2 hard_deadline_seconds=4/);
  assert.match(output, /fixture=hard-bound-expired result=70 wait_calls=0 unrelated_process=alive grace_used=false/);
  assert.match(output, /fixture=hard-bound-expired diagnostic=phase=adb_readiness_grace status=expired reason=hard_deadline_reached initial_deadline_seconds=2 grace_deadline_seconds=0 hard_deadline_seconds=4/);
  assert.match(output, /wait_call pid=[1-9][0-9]* serial=127\.0\.0\.1:5567 server=42001 deadline=2 mode=ready/);
  assert.match(output, /wait_call pid=[1-9][0-9]* serial=127\.0\.0\.1:5567 server=42001 deadline=2 mode=expire/);
  assert.match(output, /fixture_processes=alive_before_outer_cleanup/);
  assert.match(output, /fixture_cleanup=completed owned_processes=stopped private_files=removed/);
  assert.doesNotMatch(output, /SHOULD_NOT_REACH|sensitive-token|5037|kill-server|reconnect|wait-for-device/);
});
