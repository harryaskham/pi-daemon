import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
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
const systemUiEvents = path.join(root, "fixtures/android/logcat-events.system-ui-anr.txt");
const pidroidFatalLogcat = path.join(root, "fixtures/android/logcat.pidroid-fatal.txt");

async function source(relative) {
  return readFile(path.join(root, relative), "utf8");
}

function classify(xml, logcat, anrEvents) {
  const args = [classifier, xml, logcat];
  if (anrEvents !== undefined) args.push("--system-anr-events", anrEvents);
  return execFileSync("python3", args, { encoding: "utf8" }).trim();
}

test("captured System UI ANR is exact and Pi Droid failures take precedence", async () => {
  const sandbox = await mkdtemp(path.join(tmpdir(), "pidroid-ui-health-"));
  try {
    const emptyLogcat = path.join(sandbox, "empty.log");
    const emptyEvents = path.join(sandbox, "empty-events.log");
    const arbitraryLogcat = path.join(sandbox, "arbitrary.log");
    const arbitraryXml = path.join(sandbox, "arbitrary.xml");
    const crashXml = path.join(sandbox, "crash.xml");
    const googleLogcat = path.join(sandbox, "google.log");
    const missingCloseXml = path.join(sandbox, "missing-close.xml");
    const missingTitleXml = path.join(sandbox, "missing-title.xml");
    const missingWaitXml = path.join(sandbox, "missing-wait.xml");
    const nativeFatalLogcat = path.join(sandbox, "native-fatal.log");
    const pidroidEvents = path.join(sandbox, "pidroid-events.log");
    const pidroidThenSystemUiEvents = path.join(sandbox, "pidroid-then-system-ui-events.log");
    const staleSystemUiEvents = path.join(sandbox, "stale-system-ui-events.log");
    const oversizedEvents = path.join(sandbox, "oversized-events.log");
    const oversizedLogcat = path.join(sandbox, "oversized.log");
    const spoofedXml = path.join(sandbox, "spoofed.xml");
    const capturedXml = await readFile(systemUiXml, "utf8");
    const capturedEvents = await readFile(systemUiEvents, "utf8");
    await writeFile(emptyLogcat, "");
    await writeFile(emptyEvents, "");
    await writeFile(arbitraryLogcat, "08-05 12:14:18.003 1124 1367 E ActivityManager: ANR in com.example.maps\n08-05 12:14:18.004 raw sensitive-token=S3CR3T path=/private/modal\n");
    await writeFile(arbitraryXml, capturedXml.replace("System UI isn't responding", "Maps isn't responding"));
    await writeFile(crashXml, '<hierarchy><node package="android" text="Maps keeps stopping" bounds="[0,0][1080,2400]" /></hierarchy>');
    await writeFile(googleLogcat, "08-05 12:14:18.003 1124 1367 E ActivityManager: ANR in com.google.android.gms\n");
    await writeFile(missingCloseXml, capturedXml.replace("Close app", "Dismiss"));
    await writeFile(missingTitleXml, capturedXml.replace("System UI isn't responding", ""));
    await writeFile(missingWaitXml, capturedXml.replace("Wait", "Dismiss"));
    await writeFile(nativeFatalLogcat, "08-05 12:14:18.101 2488 2488 F libc: Fatal signal 6 (SIGABRT), code -1 in tid 2488, pid 2488 (com.harryaskham.pidroid)\n");
    await writeFile(pidroidEvents, capturedEvents.replaceAll("com.android.systemui", "com.harryaskham.pidroid.debug"));
    await writeFile(pidroidThenSystemUiEvents, `${await readFile(pidroidEvents, "utf8")}${capturedEvents}`);
    await writeFile(staleSystemUiEvents, `${capturedEvents}08-05 12:14:19.003  1124  1367 I am_anr  : [0,1777,com.example.maps,0,input dispatch timed out]\n`);
    await writeFile(oversizedEvents, "x".repeat(1_048_577));
    await writeFile(oversizedLogcat, "x".repeat(1_048_577));
    await writeFile(spoofedXml, capturedXml.replaceAll('package="android"', 'package="com.example.spoof"'));

    const mapsIdentity = createHash("sha256").update("com.example.maps").digest("hex");
    const googleIdentity = createHash("sha256").update("com.google.android.gms").digest("hex");
    const mapsTitleIdentity = createHash("sha256").update("Maps keeps stopping").digest("hex");
    const systemTitleIdentity = createHash("sha256").update("System UI isn't responding").digest("hex");
    const appFailureClassification = `other_app_failure_modal identity_source=logcat_package identity_class=third_party identity_sha256=sha256:${mapsIdentity}`;
    assert.equal(classify(systemUiXml, systemUiLogcat), "system_ui_anr 768 1406");
    assert.equal(classify(systemUiXml, emptyLogcat, systemUiEvents), "system_ui_anr 768 1406");
    assert.equal(classify(systemUiXml, pidroidFatalLogcat, systemUiEvents), "pidroid_app_failure");
    assert.equal(classify(systemUiXml, nativeFatalLogcat, systemUiEvents), "pidroid_app_failure");
    assert.equal(classify(systemUiXml, emptyLogcat, pidroidEvents), "pidroid_app_failure");
    assert.equal(classify(systemUiXml, emptyLogcat, pidroidThenSystemUiEvents), "pidroid_app_failure");
    assert.equal(classify(arbitraryXml, arbitraryLogcat), appFailureClassification);
    assert.equal(classify(arbitraryXml, googleLogcat), `other_app_failure_modal identity_source=logcat_package identity_class=google_system identity_sha256=sha256:${googleIdentity}`);
    assert.equal(classify(crashXml, emptyLogcat), `other_app_failure_modal identity_source=dialog_title identity_class=unknown identity_sha256=sha256:${mapsTitleIdentity}`);
    assert.equal(classify(spoofedXml, systemUiLogcat, systemUiEvents), "healthy");
    assert.equal(classify(systemUiXml, emptyLogcat, emptyEvents), `other_app_failure_modal identity_source=dialog_title identity_class=unknown identity_sha256=sha256:${systemTitleIdentity}`);
    assert.match(classify(systemUiXml, systemUiLogcat, staleSystemUiEvents), /^other_app_failure_modal /);
    assert.match(classify(missingCloseXml, emptyLogcat, systemUiEvents), /^other_app_failure_modal /);
    assert.equal(classify(missingTitleXml, emptyLogcat, systemUiEvents), "healthy");
    assert.match(classify(missingWaitXml, emptyLogcat, systemUiEvents), /^other_app_failure_modal /);
    assert.equal(classify(systemUiXml, oversizedLogcat, systemUiEvents), "ui_unavailable");
    assert.equal(classify(systemUiXml, emptyLogcat, oversizedEvents), "ui_unavailable");

    const safeXml = path.join(sandbox, "safe-window.xml");
    const safeLogcat = path.join(sandbox, "safe-logcat.txt");
    const evidenceOutput = execFileSync(
      "python3",
      [classifier, arbitraryXml, arbitraryLogcat, "--write-app-failure-evidence", safeXml, safeLogcat],
      { encoding: "utf8" },
    ).trim();
    assert.equal(evidenceOutput, appFailureClassification);
    const [normalizedXml, normalizedLogcat] = await Promise.all([
      readFile(safeXml, "utf8"),
      readFile(safeLogcat, "utf8"),
    ]);
    assert.match(normalizedXml, new RegExp(`status="app_failure_modal"[^>]*modal-kind="not_responding"[^>]*identity-source="logcat_package"[^>]*identity-class="third_party"[^>]*identity-sha256="sha256:${mapsIdentity}"`));
    assert.match(normalizedXml, /raw-content-retained="false"/);
    assert.match(normalizedLogcat, /status=app_failure_modal\nevent_kind=anr\nidentity_source=logcat_package\nidentity_class=third_party/);
    assert.match(normalizedLogcat, new RegExp(`identity_sha256=sha256:${mapsIdentity}`));
    for (const safeEvidence of [normalizedXml, normalizedLogcat]) {
      assert.doesNotMatch(safeEvidence, /Maps|com\.example\.maps|S3CR3T|private\/modal|sensitive-token/);
    }
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
system_events="$6"
sandbox="$(mktemp -d)"
trap 'rm -rf "$sandbox"' EXIT
source "$helper"
healthy_xml="$sandbox/healthy.xml"
arbitrary_xml="$sandbox/arbitrary.xml"
arbitrary_log="$sandbox/arbitrary.log"
empty_log="$sandbox/empty.log"
empty_events="$sandbox/empty-events.log"
pidroid_events="$sandbox/pidroid-events.log"
: > "$empty_log"
: > "$empty_events"
sed 's/com\.android\.systemui/com.harryaskham.pidroid.debug/g' "$system_events" > "$pidroid_events"
cat > "$healthy_xml" <<'XML'
<hierarchy rotation="0"><node package="com.harryaskham.pidroid.debug" text="Readonly session Contract fixture" bounds="[0,0][1080,2400]" /></hierarchy>
XML
python3 - "$system_xml" "$arbitrary_xml" <<'PY'
from pathlib import Path
import sys
Path(sys.argv[2]).write_text(Path(sys.argv[1]).read_text().replace("System UI isn't responding", "Maps isn't responding"))
PY
{
  printf '%s\n' '08-05 12:14:18.003 1124 1367 E ActivityManager: ANR in com.example.maps'
  printf '%s\n' '08-05 12:14:18.004 raw sensitive-token=S3CR3T path=/private/modal'
} > "$arbitrary_log"
case_number=0
current_log="$system_log"
current_events="$empty_events"
next_xml="$healthy_xml"
ready='true'
tap_calls=0
dump_calls=0
oversized_screenshot='false'
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
  current_events="$empty_events"
  oversized_screenshot='false'
  initialize_emulator_ui_health "$private" "$artifacts"
}
capture_emulator_ui_logcat() {
  printf '%s\n' logcat >> "$events"
  cp "$current_log" "$1"
}
capture_emulator_ui_anr_events() {
  printf '%s\n' anr_events >> "$events"
  cp "$current_events" "$1"
}
classify_emulator_ui_health() {
  printf '%s\n' classify >> "$events"
  python3 "$repo_root/android/build-logic/emulator-ui-health.py" \
    "$1" "$2" --system-anr-events "$3"
}
capture_emulator_ui_screenshot() {
  printf '%s\n' screenshot >> "$events"
  if [[ "$oversized_screenshot" == 'true' ]]; then
    truncate -s 16777217 "$1"
  else
    printf '%s\n' 'bounded-fixture-screenshot' > "$1"
  fi
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
grep -Eq '^anr_events_sha256=sha256:[0-9a-f]{64}$' "$artifacts/system-ui-evidence/occurrence-1/evidence.txt"
[[ ! -e "$artifacts/system-ui-evidence/occurrence-1/logcat.txt" ]]
[[ ! -e "$artifacts/system-ui-evidence/occurrence-1/anr-events.txt" ]]
printf '%s\n' 'logcat anr_events classify screenshot tap' > "$sandbox/expected-order"
head -n 5 "$events" | paste -sd ' ' | grep -Fxq "$(cat "$sandbox/expected-order")"
recurrence_status=0
check_emulator_ui_health "$system_xml" || recurrence_status=$?
[[ "$recurrence_status" == 1 ]]
[[ "$tap_calls" == 1 ]]
[[ "$emulator_system_ui_occurrences" == 2 ]]
grep -Fq 'status=system_ui_unhealthy phase=recurrence wait_used=true occurrences=2' "$artifacts/system-ui-health.log"

new_case
current_log="$empty_log"
current_events="$system_events"
next_xml="$healthy_xml"
check_emulator_ui_health "$system_xml"
[[ "$tap_calls" == 1 ]]
[[ "$dump_calls" == 1 ]]
[[ "$emulator_system_ui_occurrences" == 1 ]]
grep -Eq '^anr_events_sha256=sha256:[0-9a-f]{64}$' "$artifacts/system-ui-evidence/occurrence-1/evidence.txt"

new_case
current_log="$empty_log"
current_events="$pidroid_events"
next_xml="$healthy_xml"
pidroid_event_status=0
check_emulator_ui_health "$system_xml" || pidroid_event_status=$?
[[ "$pidroid_event_status" == 1 ]]
[[ "$tap_calls" == 0 ]]
grep -Fq 'status=pidroid_app_failure phase=ui_wait wait_used=false occurrences=0' "$artifacts/system-ui-health.log"

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
[[ "$emulator_app_failure_occurrences" == 1 ]]
grep -Fq 'status=app_failure_modal phase=ui_wait wait_used=false occurrences=0 app_failure_occurrences=1' "$artifacts/system-ui-health.log"
grep -Fxq 'status=app_failure_modal' "$artifacts/app-failure-evidence/occurrence-1/evidence.txt"
grep -Fxq 'identity_source=logcat_package' "$artifacts/app-failure-evidence/occurrence-1/evidence.txt"
grep -Fxq 'identity_class=third_party' "$artifacts/app-failure-evidence/occurrence-1/evidence.txt"
grep -Eq '^identity_sha256=sha256:[0-9a-f]{64}$' "$artifacts/app-failure-evidence/occurrence-1/evidence.txt"
grep -Eq '^xml_sha256=sha256:[0-9a-f]{64}$' "$artifacts/app-failure-evidence/occurrence-1/evidence.txt"
grep -Eq '^screenshot_sha256=sha256:[0-9a-f]{64}$' "$artifacts/app-failure-evidence/occurrence-1/evidence.txt"
grep -Eq '^safe_logcat_sha256=sha256:[0-9a-f]{64}$' "$artifacts/app-failure-evidence/occurrence-1/evidence.txt"
grep -Fq 'raw-content-retained="false"' "$artifacts/app-failure-evidence/occurrence-1/window.xml"
grep -Fxq 'raw_logcat_retained=false' "$artifacts/app-failure-evidence/occurrence-1/safe-logcat.txt"
! grep -ERq 'Maps|com\.example\.maps|S3CR3T|private/modal|sensitive-token' "$artifacts/app-failure-evidence"
[[ "$(stat -c '%a' "$artifacts/app-failure-evidence/occurrence-1")" == 700 ]]
[[ "$(stat -c '%a' "$artifacts/app-failure-evidence/occurrence-1/window.xml")" == 600 ]]
[[ "$(stat -c '%a' "$artifacts/app-failure-evidence/occurrence-1/screenshot.png")" == 600 ]]
[[ "$(stat -c '%a' "$artifacts/app-failure-evidence/occurrence-1/safe-logcat.txt")" == 600 ]]

new_case
current_log="$arbitrary_log"
next_xml="$healthy_xml"
oversized_screenshot='true'
oversized_status=0
check_emulator_ui_health "$arbitrary_xml" || oversized_status=$?
[[ "$oversized_status" == 1 ]]
[[ "$tap_calls" == 0 ]]
[[ ! -e "$artifacts/app-failure-evidence/occurrence-1" ]]
grep -Fq 'status=system_ui_unhealthy phase=app_failure_evidence wait_used=false occurrences=0 app_failure_occurrences=1' "$artifacts/system-ui-health.log"

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
`, "emulator-ui-health-test", helper, root, systemUiXml, systemUiLogcat, pidroidFatalLogcat, systemUiEvents], {
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
  assert.match(parser, /identity_source=\{metadata\['identity_source'\]\}/);
  assert.match(parser, /raw-content-retained/);
  assert.match(parser, /raw_logcat_retained=false/);
  assert.match(guard, /system_ui_wait_limit=1 recovery_attempt_limit=15 logcat_byte_limit=1048576 anr_event_byte_limit=1048576/);
  assert.match(guard, /app_failure_screenshot_byte_limit=16777216/);
  assert.match(guard, /logcat -b events -d -v threadtime 'am_anr:I' '\*:S'/);
  assert.match(guard, /--system-anr-events/);
  assert.match(parser, /latest_anr_event_is/);
  assert.match(guard, /capture_app_failure_modal_evidence/);
  assert.match(guard, /app-failure-evidence/);
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
    assert.match(harness, /source "\$repo_root\/android\/build-logic\/physical-proof-lifecycle\.sh"/);
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
