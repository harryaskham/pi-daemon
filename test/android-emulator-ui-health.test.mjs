import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));
const classifier = path.join(root, "android/build-logic/emulator-ui-health.py");
const helper = path.join(root, "android/build-logic/emulator-ui-health.sh");
const systemUiXml = path.join(root, "fixtures/android/uiautomator.system-ui-anr.xml");
const systemUiLogcat = path.join(root, "fixtures/android/logcat.system-ui-anr.txt");
const pidroidFatalLogcat = path.join(root, "fixtures/android/logcat.pidroid-fatal.txt");

async function source(relative) {
  return readFile(path.join(root, relative), "utf8");
}

function classify(xml, logcat) {
  return execFileSync("python3", [classifier, xml, logcat], { encoding: "utf8" }).trim();
}

test("captured System UI ANR is exact and Pi Droid failures take precedence", async () => {
  const sandbox = await mkdtemp(path.join(tmpdir(), "pidroid-ui-health-"));
  try {
    const emptyLogcat = path.join(sandbox, "empty.log");
    const arbitraryLogcat = path.join(sandbox, "arbitrary.log");
    const arbitraryXml = path.join(sandbox, "arbitrary.xml");
    const crashXml = path.join(sandbox, "crash.xml");
    const nativeFatalLogcat = path.join(sandbox, "native-fatal.log");
    const oversizedLogcat = path.join(sandbox, "oversized.log");
    const spoofedXml = path.join(sandbox, "spoofed.xml");
    const capturedXml = await readFile(systemUiXml, "utf8");
    await writeFile(emptyLogcat, "");
    await writeFile(arbitraryLogcat, "08-05 12:14:18.003 1124 1367 E ActivityManager: ANR in com.example.maps\n");
    await writeFile(arbitraryXml, capturedXml.replace("System UI isn't responding", "Maps isn't responding"));
    await writeFile(crashXml, '<hierarchy><node package="android" text="Maps keeps stopping" bounds="[0,0][1080,2400]" /></hierarchy>');
    await writeFile(nativeFatalLogcat, "08-05 12:14:18.101 2488 2488 F libc: Fatal signal 6 (SIGABRT), code -1 in tid 2488, pid 2488 (com.harryaskham.pidroid)\n");
    await writeFile(oversizedLogcat, "x".repeat(1_048_577));
    await writeFile(spoofedXml, capturedXml.replaceAll('package="android"', 'package="com.example.spoof"'));

    assert.equal(classify(systemUiXml, systemUiLogcat), "system_ui_anr 768 1406");
    assert.equal(classify(systemUiXml, pidroidFatalLogcat), "pidroid_app_failure");
    assert.equal(classify(systemUiXml, nativeFatalLogcat), "pidroid_app_failure");
    assert.equal(classify(arbitraryXml, arbitraryLogcat), "other_app_failure_modal");
    assert.equal(classify(crashXml, emptyLogcat), "other_app_failure_modal");
    assert.equal(classify(spoofedXml, systemUiLogcat), "healthy");
    assert.equal(classify(systemUiXml, emptyLogcat), "other_app_failure_modal");
    assert.equal(classify(systemUiXml, oversizedLogcat), "ui_unavailable");
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("shared guard captures hashes, chooses Wait once, and fails closed without arbitrary dismissal", () => {
  const output = execFileSync("bash", ["-c", String.raw`
set -euo pipefail
helper="$1"
repo_root="$2"
system_xml="$3"
system_log="$4"
pidroid_log="$5"
sandbox="$(mktemp -d)"
trap 'rm -rf "$sandbox"' EXIT
source "$helper"
healthy_xml="$sandbox/healthy.xml"
arbitrary_xml="$sandbox/arbitrary.xml"
arbitrary_log="$sandbox/arbitrary.log"
cat > "$healthy_xml" <<'XML'
<hierarchy rotation="0"><node package="com.harryaskham.pidroid.debug" text="Readonly session Contract fixture" bounds="[0,0][1080,2400]" /></hierarchy>
XML
python3 - "$system_xml" "$arbitrary_xml" <<'PY'
from pathlib import Path
import sys
Path(sys.argv[2]).write_text(Path(sys.argv[1]).read_text().replace("System UI isn't responding", "Maps isn't responding"))
PY
printf '%s\n' '08-05 12:14:18.003 1124 1367 E ActivityManager: ANR in com.example.maps' > "$arbitrary_log"
case_number=0
current_log="$system_log"
next_xml="$healthy_xml"
ready='true'
tap_calls=0
dump_calls=0
events=''
new_case() {
  case_number=$((case_number + 1))
  private="$sandbox/private-$case_number"
  artifacts="$sandbox/artifacts-$case_number"
  events="$sandbox/events-$case_number"
  mkdir -p "$private" "$artifacts"
  : > "$events"
  tap_calls=0
  dump_calls=0
  ready='true'
  initialize_emulator_ui_health "$private" "$artifacts"
}
capture_emulator_ui_logcat() {
  printf '%s\n' logcat >> "$events"
  cp "$current_log" "$1"
}
classify_emulator_ui_health() {
  printf '%s\n' classify >> "$events"
  python3 "$repo_root/android/build-logic/emulator-ui-health.py" "$1" "$2"
}
capture_emulator_ui_screenshot() {
  printf '%s\n' screenshot >> "$events"
  printf '%s\n' 'bounded-fixture-screenshot' > "$1"
}
dump_emulator_ui_window() {
  dump_calls=$((dump_calls + 1))
  cp "$next_xml" "$1"
}
emulator_system_ui_ready() {
  [[ "$ready" == 'true' ]]
}
emulator_ui_adb() {
  if [[ "$1 $2 $3" == 'shell input tap' ]]; then
    tap_calls=$((tap_calls + 1))
    printf '%s\n' tap >> "$events"
    return 0
  fi
  return 64
}
sleep() { :; }

new_case
current_log="$system_log"
next_xml="$healthy_xml"
check_emulator_ui_health "$system_xml"
[[ "$tap_calls" == 1 ]]
[[ "$dump_calls" == 1 ]]
[[ "$emulator_system_ui_wait_used" == 'true' ]]
[[ "$emulator_system_ui_occurrences" == 1 ]]
grep -Fxq 'status=system_ui_anr' "$artifacts/system-ui-evidence/occurrence-1/evidence.txt"
grep -Eq '^xml_sha256=sha256:[0-9a-f]{64}$' "$artifacts/system-ui-evidence/occurrence-1/evidence.txt"
grep -Eq '^screenshot_sha256=sha256:[0-9a-f]{64}$' "$artifacts/system-ui-evidence/occurrence-1/evidence.txt"
grep -Eq '^safe_logcat_sha256=sha256:[0-9a-f]{64}$' "$artifacts/system-ui-evidence/occurrence-1/evidence.txt"
[[ ! -e "$artifacts/system-ui-evidence/occurrence-1/logcat.txt" ]]
printf '%s\n' 'logcat classify screenshot tap' > "$sandbox/expected-order"
head -n 4 "$events" | paste -sd ' ' | grep -Fxq "$(cat "$sandbox/expected-order")"
recurrence_status=0
check_emulator_ui_health "$system_xml" || recurrence_status=$?
[[ "$recurrence_status" == 1 ]]
[[ "$tap_calls" == 1 ]]
[[ "$emulator_system_ui_occurrences" == 2 ]]
grep -Fq 'status=system_ui_unhealthy phase=recurrence wait_used=true occurrences=2' "$artifacts/system-ui-health.log"

new_case
current_log="$pidroid_log"
next_xml="$healthy_xml"
pidroid_status=0
check_emulator_ui_health "$system_xml" || pidroid_status=$?
[[ "$pidroid_status" == 1 ]]
[[ "$tap_calls" == 0 ]]
[[ "$emulator_system_ui_occurrences" == 0 ]]
grep -Fq 'status=pidroid_app_failure phase=ui_wait wait_used=false occurrences=0' "$artifacts/system-ui-health.log"

new_case
current_log="$arbitrary_log"
next_xml="$healthy_xml"
arbitrary_status=0
check_emulator_ui_health "$arbitrary_xml" || arbitrary_status=$?
[[ "$arbitrary_status" == 1 ]]
[[ "$tap_calls" == 0 ]]
[[ "$emulator_system_ui_occurrences" == 0 ]]
grep -Fq 'status=app_failure_modal phase=ui_wait wait_used=false occurrences=0' "$artifacts/system-ui-health.log"

new_case
current_log="$system_log"
next_xml="$system_xml"
deadline_status=0
check_emulator_ui_health "$system_xml" || deadline_status=$?
[[ "$deadline_status" == 1 ]]
[[ "$tap_calls" == 1 ]]
[[ "$dump_calls" == 15 ]]
grep -Fq 'status=system_ui_unhealthy phase=recovery_deadline wait_used=true occurrences=1' "$artifacts/system-ui-health.log"

new_case
current_log="$system_log"
next_xml="$healthy_xml"
ready='false'
readiness_status=0
check_emulator_ui_health "$system_xml" || readiness_status=$?
[[ "$readiness_status" == 1 ]]
[[ "$tap_calls" == 1 ]]
[[ "$dump_calls" == 15 ]]
grep -Fq 'status=system_ui_unhealthy phase=recovery_deadline wait_used=true occurrences=1' "$artifacts/system-ui-health.log"

printf '%s\n' 'system_ui_recovery_contract=ok wait_max=1 deadline_attempts=15 arbitrary_taps=0 pidroid_taps=0'
`, "emulator-ui-health-test", helper, root, systemUiXml, systemUiLogcat, pidroidFatalLogcat], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  assert.match(output, /system_ui_recovery_contract=ok wait_max=1 deadline_attempts=15 arbitrary_taps=0 pidroid_taps=0/);
});

test("interactive and readonly harnesses run the shared guard before selectors and hash conditional evidence", async () => {
  const [guard, parser, interactive, readonly, plan] = await Promise.all([
    source("android/build-logic/emulator-ui-health.sh"),
    source("android/build-logic/emulator-ui-health.py"),
    source("android/build-logic/live-interactive-proof.sh"),
    source("android/build-logic/live-readonly-proof.sh"),
    source("PLAN.md"),
  ]);

  assert.match(parser, /PIDROID_PACKAGES[^]*com\.harryaskham\.pidroid[^]*com\.harryaskham\.pidroid\.debug/);
  assert.match(parser, /Pi Droid failures always win over any system dialog/);
  assert.match(parser, /ANR in \{re\.escape\(package\)\}/);
  assert.match(parser, /FATAL EXCEPTION:/);
  assert.match(parser, /SYSTEM_UI_PACKAGE = "com\.android\.systemui"/);
  assert.match(parser, /SYSTEM_DIALOG_PACKAGE = "android"/);
  assert.match(guard, /system_ui_wait_limit=1 recovery_attempt_limit=15 logcat_byte_limit=1048576/);
  assert.match(guard, /timeout 10 "\$\{isolated_adb_command\[@\]\}" -s "\$emulator_device_serial"/);
  assert.match(guard, /logcat -d -v threadtime -t 4096/);
  assert.match(guard, /head -c 1048576/);
  assert.match(guard, /safe_logcat_sha256=sha256:/);
  assert.match(guard, /pidof com\.android\.systemui/);
  assert.match(guard, /service check statusbar/);
  assert.match(guard, /while \(\( attempt < 15 \)\)/);
  assert.equal((guard.match(/shell input tap "\$wait_x" "\$wait_y"/g) ?? []).length, 1);
  assert.ok(guard.indexOf("pidroid_app_failure)") < guard.indexOf("system_ui_anr)"));

  for (const harness of [interactive, readonly]) {
    assert.match(harness, /source "\$repo_root\/android\/build-logic\/emulator-ui-health\.sh"/);
    assert.ok(harness.indexOf("initialize_emulator_ui_health") < harness.indexOf("emulator -avd pi-droid-live"));
    assert.ok(harness.indexOf("probe_emulator_ui_health || exit 70") < harness.indexOf('install -r "$apk"'));
    const waitBody = harness.slice(harness.indexOf("wait_ui() {"), harness.indexOf("\n}\n", harness.indexOf("wait_ui() {")));
    assert.ok(waitBody.indexOf("check_emulator_ui_health") < waitBody.indexOf("grep -Eq"));
    assert.match(harness, /"systemUiRecoveryUsed": \$emulator_system_ui_wait_used/);
    assert.match(harness, /"systemUiWaitLimit": 1/);
    assert.match(harness, /"piDroidLogcatGuard": true/);
    assert.match(harness, /system-ui-health\.log/);
    assert.match(harness, /find system-ui-evidence -type f -print \| LC_ALL=C sort/);
  }
  assert.match(plan, /`bd-6033b6`/);
});
