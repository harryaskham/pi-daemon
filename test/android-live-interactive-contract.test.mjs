import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));

async function source(relative) {
  try {
    return await readFile(path.join(root, relative), "utf8");
  } catch (error) {
    assert.fail(`${relative} must exist for the live interactive contract: ${error.code ?? error.message}`);
  }
}

test("interactive app delegates exact authority correlation tree and TUI state to canonical SDK models", async () => {
  const [catalog, appLock, machine, repository, repositoryTest, screen, activity, transport, transportTest, commands, rich] = await Promise.all([
    source("android/gradle/libs.versions.toml"),
    source("android/app/gradle.lockfile"),
    source("android/app/src/main/kotlin/com/harryaskham/pidroid/live/LiveInteractiveSession.kt"),
    source("android/app/src/main/kotlin/com/harryaskham/pidroid/live/LiveReadonlyRepository.kt"),
    source("android/app/src/test/kotlin/com/harryaskham/pidroid/live/LiveReadonlyRepositoryTest.kt"),
    source("android/app/src/main/kotlin/com/harryaskham/pidroid/live/LiveReadonlyScreen.kt"),
    source("android/app/src/main/kotlin/com/harryaskham/pidroid/MainActivity.kt"),
    source("android/app/src/main/kotlin/com/harryaskham/pidroid/live/OkHttpPiDaemonTransport.kt"),
    source("android/app/src/test/kotlin/com/harryaskham/pidroid/live/OkHttpPiDaemonTransportTest.kt"),
    source("android/sdk-core/src/main/kotlin/com/harryaskham/pidroid/sdk/core/InteractiveCommands.kt"),
    source("android/sdk-session-ui/src/main/kotlin/com/harryaskham/pidroid/sessionui/RichInteractiveModels.kt"),
  ]);

  assert.match(catalog, /kotlinx-coroutines-test-android = \{ module = "org\.jetbrains\.kotlinx:kotlinx-coroutines-test", version\.ref = "kotlinx-coroutines" \}/);
  assert.match(appLock, /org\.jetbrains\.kotlinx:kotlinx-coroutines-test-jvm:1\.11\.0=debugUnitTestCompileClasspath,debugUnitTestRuntimeClasspath/);
  assert.match(appLock, /org\.jetbrains\.kotlinx:kotlinx-coroutines-test:1\.11\.0=debugUnitTestCompileClasspath,debugUnitTestRuntimeClasspath/);
  assert.doesNotMatch(appLock, /org\.jetbrains\.kotlinx:kotlinx-coroutines-[^:\n]+:1\.9\.0=/);
  assert.match(machine, /InteractiveSessionController/);
  assert.match(machine, /CorrelationId\(idempotencyKey\)/);
  assert.match(machine, /CommandLifecycle\.INDETERMINATE|controller\.onDisconnect\(\)/);
  assert.match(machine, /SessionTreeSnapshot/);
  assert.match(machine, /TuiFrameDecoder/);
  assert.match(machine, /TuiFrameReducer/);
  assert.doesNotMatch(machine, /canReplay\([^)]*\)\s*=\s*true|blind.?replay/i);
  assert.match(repository, /SessionRole\.OBSERVER/);
  assert.match(repository, /interactiveCommands: Set<PiRpcCommandType>/);
  assert.match(repository, /supportedCommands = selected\.interactiveCommands/);
  assert.equal((repository.match(/client\.capabilities\(\)/g) ?? []).length, 1);
  assert.match(repository, /fun connectInteractiveObserver\(\)/);
  assert.match(repository, /interactiveConnectMutex\.withLock/);
  assert.match(repository, /interactive_credential_failed/);
  assert.match(repository, /interactive_capabilities_failed/);
  assert.match(repository, /observer_connect_failed/);
  assert.match(repository, /interactive_tui_open_failed/);
  assert.match(repository, /requestControl\(\)/);
  assert.match(repository, /requireActiveInteractive\(\)/);
  assert.match(repository, /UUID\.randomUUID\(\)/);
  assert.match(repository, /interactive_send_indeterminate/);
  assert.match(repository, /publishInteractive\(active, "transport_lost"\)/);
  assert.match(repository, /INTERACTIVE_SAFE_CODE\s*=\s*Regex\("\^\[a-z\]\[a-z0-9_\]\{0,127\}\$"\)/);
  assert.match(repository, /code\.takeIf\(INTERACTIVE_SAFE_CODE::matches\) \?: "interactive_failed"/);
  assert.match(repository, /LiveReadonlyFailure\("interactive_attach_failed"\)/);
  assert.match(repository, /publishInteractive\(active, "interactive_send_indeterminate"\)/);
  assert.match(repository, /throw LiveReadonlyFailure\("interactive_send_indeterminate"\)/);
  assert.match(repository, /safeCode == "interactive_failed"[^\n]*existing\.code != "interactive_failed"/);
  assert.match(transport, /DEFAULT_WEBSOCKET_PING_INTERVAL: Duration = Duration\.ofSeconds\(5\)/);
  assert.match(transport, /\.pingInterval\(webSocketPingInterval\)/);
  assert.match(transport, /closed\.compareAndSet\(false, true\)/);
  assert.match(transport, /override fun onClosing\(/);
  assert.match(transport, /acknowledgePeerClosing\(webSocket, code, reason, incomingCloser\)/);
  assert.match(transport, /webSocket\.close\(code, reason\.take\(WEBSOCKET_CLOSE_REASON_CHARS\)\)/);
  assert.match(transport, /retryOnConnectionFailure\(false\)/);
  assert.match(transportTest, /peer closing helper acknowledges bounded reason and closes incoming exactly once/);
  assert.match(transportTest, /acknowledgePeerClosing\(socket, 1_001, "x"\.repeat\(200\), closer\)/);
  assert.match(transportTest, /assertEquals\(1, socket\.closeCalls\)/);
  assert.match(transportTest, /assertEquals\(123, socket\.closeReason\?\.length\)/);
  assert.match(transportTest, /MockWebServer graceful close race completes safely within bound/);
  assert.match(transportTest, /if \(failure == null\)/);
  assert.match(transportTest, /result\.getOrThrow\(\)\.isEmpty\(\)/);
  assert.match(transportTest, /serverSocket\.close\(1_001, "server shutdown"\)/);
  assert.match(transportTest, /connection refusal closes incoming with typed safe failure/);
  assert.match(transportTest, /fun `MockWebServer graceful close race completes safely within bound`\(\) =\n    runBlocking \{/);
  assert.match(transportTest, /fun `connection refusal closes incoming with typed safe failure`\(\) =\n    runBlocking \{/);
  assert.match(repositoryTest, /fun `interactive repository requests control sends one unique prompt and marks lost response indeterminate`\(\) =\n    runBlocking \{/);
  assert.ok((transportTest.match(/withTimeout\(15_000\)/g) ?? []).length >= 2);
  assert.match(transportTest, /assertEquals\("websocket_failed", \(failure as TransportFailure\)\.code\)/);
  assert.match(screen, /RichInteractiveSessionSurface/);
  assert.match(screen, /SessionTreeSurface/);
  assert.match(screen, /TuiSurface/);
  assert.match(screen, /Reconnect interactive session/);
  assert.match(screen, /ACTION RECEIVED · CONNECTING/);
  assert.match(screen, /OBSERVER · READY/);
  assert.match(screen, /Connect interactive observer/);
  assert.match(screen, /enabled = interaction !is LiveInteractiveAppState\.Connecting/);
  assert.match(screen, /INTERACTIVE ERROR · PREFLIGHT_ERROR/);
  assert.match(screen, /InteractiveControllerRole\.REQUESTING/);
  assert.match(activity, /connectInteractiveObserver/);
  assert.match(activity, /handleInteraction/);
  assert.match(activity, /is CommandAdmissionException -> error\.code/);
  assert.match(activity, /fun safeInteractiveFailureCode/);
  assert.match(activity, /INTERACTIVE_FAILURE_CODE/);
  assert.doesNotMatch(activity, /host_unavailable_\$\{error::class/);
  assert.match(commands, /fun getTree\(\)/);
  assert.match(rich, /fun requesting\(/);
  assert.match(rich, /fun lost\(/);
});

test("emulator port selector randomizes a bounded supported scan and checks both localhost ports", () => {
  const selectorPath = path.join(root, "android/build-logic/select-emulator-port-pair.py");
  const result = execFileSync("python3", ["-c", String.raw`
import importlib.util
import sys

spec = importlib.util.spec_from_file_location("emulator_port_selector", sys.argv[1])
selector = importlib.util.module_from_spec(spec)
spec.loader.exec_module(selector)

assert selector.EMULATOR_CONSOLE_PORTS == tuple(range(5554, 5585, 2))
shuffle_calls = []
seen = []
def reverse(candidates):
    shuffle_calls.append(tuple(candidates))
    candidates.reverse()
def available_only_at_5554(console_port):
    seen.append(console_port)
    return console_port == 5554
selection = selector.select_emulator_port_pair(
    pair_is_available=available_only_at_5554,
    shuffle=reverse,
)
assert selection == (5554, 5555, 16)
assert shuffle_calls == [tuple(range(5554, 5585, 2))]
assert seen == list(range(5584, 5553, -2))

class FakeSocket:
    def __init__(self, blocked_port=None):
        self.blocked_port = blocked_port
        self.closed = False
    def bind(self, address):
        binds.append(address)
        if address[1] == self.blocked_port:
            raise OSError("occupied")
    def close(self):
        self.closed = True

binds = []
sockets = []
def free_factory(*_args):
    candidate = FakeSocket()
    sockets.append(candidate)
    return candidate
assert selector.localhost_port_pair_is_available(5554, socket_factory=free_factory)
assert binds == [("127.0.0.1", 5554), ("127.0.0.1", 5555)]
assert all(candidate.closed for candidate in sockets)

binds = []
sockets = []
def occupied_adb_factory(*_args):
    candidate = FakeSocket(blocked_port=5555)
    sockets.append(candidate)
    return candidate
assert not selector.localhost_port_pair_is_available(5554, socket_factory=occupied_adb_factory)
assert binds == [("127.0.0.1", 5554), ("127.0.0.1", 5555)]
assert all(candidate.closed for candidate in sockets)

try:
    selector.select_emulator_port_pair(
        pair_is_available=lambda _port: False,
        shuffle=lambda _candidates: None,
    )
except selector.EmulatorPortUnavailable as error:
    assert str(error) == "emulator_port_unavailable"
    assert error.attempts == 16
else:
    raise AssertionError("exhausted selection must fail closed")

print("ok")
`, selectorPath], {
    encoding: "utf8",
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
  });
  assert.equal(result.trim(), "ok");
});

test("ADB server port selector is private, bounded, collision aware, and exhaustible", () => {
  const selectorPath = path.join(root, "android/build-logic/select-adb-server-port.py");
  const result = execFileSync("python3", ["-c", String.raw`
import importlib.util
import sys

spec = importlib.util.spec_from_file_location("adb_server_port_selector", sys.argv[1])
selector = importlib.util.module_from_spec(spec)
spec.loader.exec_module(selector)

assert selector.ADB_SERVER_PORTS == tuple(range(42000, 42128))
assert 5037 not in selector.ADB_SERVER_PORTS
assert all(port < 5554 or port > 5585 for port in selector.ADB_SERVER_PORTS)
seen = []
def reverse(candidates):
    candidates.reverse()
def available_only_at_42000(port):
    seen.append(port)
    return port == 42000
selection = selector.select_adb_server_port(
    port_is_available=available_only_at_42000,
    shuffle=reverse,
)
assert selection == (42000, 128)
assert seen == list(range(42127, 41999, -1))

claimed = set()
def unclaimed(port):
    return port not in claimed
first = selector.select_adb_server_port(
    port_is_available=unclaimed,
    shuffle=lambda _candidates: None,
)
claimed.add(first.port)
second = selector.select_adb_server_port(
    port_is_available=unclaimed,
    shuffle=lambda _candidates: None,
)
assert first == (42000, 1)
assert second == (42001, 2)
assert first.port != second.port

class FakeSocket:
    def __init__(self, blocked=False):
        self.blocked = blocked
        self.closed = False
    def bind(self, address):
        binds.append(address)
        if self.blocked:
            raise OSError("occupied")
    def close(self):
        self.closed = True

binds = []
free = FakeSocket()
assert selector.localhost_port_is_available(42000, socket_factory=lambda *_args: free)
assert binds == [("127.0.0.1", 42000)]
assert free.closed
binds = []
occupied = FakeSocket(blocked=True)
assert not selector.localhost_port_is_available(42000, socket_factory=lambda *_args: occupied)
assert binds == [("127.0.0.1", 42000)]
assert occupied.closed

try:
    selector.select_adb_server_port(
        port_is_available=lambda _port: False,
        shuffle=lambda _candidates: None,
    )
except selector.AdbServerPortUnavailable as error:
    assert str(error) == "adb_server_port_unavailable"
    assert error.attempts == 128
else:
    raise AssertionError("exhausted ADB server selection must fail closed")

print("ok")
`, selectorPath], {
    encoding: "utf8",
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
  });
  assert.equal(result.trim(), "ok");
});

test("isolated ADB launcher exports private authority before launch and cleans up only its server", () => {
  const helperPath = path.join(root, "android/build-logic/isolated-adb-server.sh");
  const selectorPath = path.join(root, "android/build-logic/select-adb-server-port.py");
  const output = execFileSync("bash", ["-c", String.raw`
set -euo pipefail
umask 077
helper="$1"
selector="$2"
sandbox="$(mktemp -d)"
private_root="$sandbox/private"
bin_dir="$sandbox/bin"
diagnostics="$sandbox/diagnostics.log"
adb_log="$sandbox/adb.log"
mkdir -p "$private_root" "$bin_dir"
cat > "$bin_dir/adb" <<'ADB'
#!/usr/bin/env bash
set -euo pipefail
{
  printf 'port=%s user=%s emulator=%s avd=%s keys=%s args=' \
    "$ANDROID_ADB_SERVER_PORT" \
    "$ANDROID_USER_HOME" \
    "$ANDROID_EMULATOR_HOME" \
    "$ANDROID_AVD_HOME" \
    "$ADB_VENDOR_KEYS"
  printf '%q ' "$@"
  printf '\n'
} >> "$FAKE_ADB_LOG"
if [[ "$1" == 'keygen' ]]; then
  printf '%s\n' private > "$2"
  printf '%s\n' public > "$2.pub"
  exit 0
fi
port=''
previous=''
for argument in "$@"; do
  if [[ "$previous" == '-P' ]]; then
    port="$argument"
  fi
  previous="$argument"
done
if [[ " $* " == *' server nodaemon '* ]]; then
  exec python3 - "$port" <<'PY'
import socket, sys
server = socket.socket()
server.bind(("127.0.0.1", int(sys.argv[1])))
server.listen()
while True:
    connection, _ = server.accept()
    connection.close()
PY
fi
if [[ " $* " == *' kill-server '* ]]; then
  exit 0
fi
exit 64
ADB
chmod 700 "$bin_dir/adb"
export PATH="$bin_dir:$PATH"
export FAKE_ADB_LOG="$adb_log"
source "$helper"
adb_server_port=''
adb_server_port_attempts=''
adb_server_pid=''
adb_server_started='false'
adb_key_home=''
cleanup() {
  stop_isolated_adb_server || true
  rm -rf "$sandbox"
}
trap cleanup EXIT
start_isolated_adb_server "$private_root" "$diagnostics" "$selector"
[[ "$adb_server_started" == 'true' ]]
[[ "$ANDROID_ADB_SERVER_PORT" == "$adb_server_port" ]]
[[ "$ANDROID_USER_HOME" == "$private_root/android-user" ]]
[[ "$ANDROID_EMULATOR_HOME" == "$private_root/android-user" ]]
[[ "$ANDROID_AVD_HOME" == "$private_root/avd" ]]
[[ "$ADB_VENDOR_KEYS" == "$private_root/android-user" ]]
[[ "$(stat -c '%a' "$private_root/android-user")" == '700' ]]
[[ "$(stat -c '%a' "$private_root/avd")" == '700' ]]
[[ "$(stat -c '%a' "$private_root/android-user/adbkey")" == '600' ]]
[[ "$(stat -c '%a' "$private_root/android-user/adbkey.pub")" == '600' ]]
grep -Fq "port=$adb_server_port user=$private_root/android-user emulator=$private_root/android-user avd=$private_root/avd keys=$private_root/android-user args=keygen" "$adb_log"
grep -Fq "port=$adb_server_port user=$private_root/android-user emulator=$private_root/android-user avd=$private_root/avd keys=$private_root/android-user args=-P $adb_server_port server nodaemon" "$adb_log"
owned_pid="$adb_server_pid"
stop_isolated_adb_server
! kill -0 "$owned_pid" 2>/dev/null
grep -Fq "args=-H 127.0.0.1 -P $adb_server_port kill-server" "$adb_log"
! grep -Eq '(^|[^0-9])5037([^0-9]|$)|reconnect' "$adb_log"
rm -rf "$private_root"
[[ ! -e "$private_root" ]]
cat "$diagnostics"
printf '%s\n' 'fake_adb_contract=ok private_key_cleanup=ok'
`, "isolated-adb-test", helperPath, selectorPath], { encoding: "utf8" });

  assert.match(output, /phase=adb_server status=started server_port=42[0-9]{3} selection_attempts=[0-9]+/);
  assert.match(output, /key_home=run_scoped server_mode=owned_nodaemon/);
  assert.match(output, /fake_adb_contract=ok private_key_cleanup=ok/);
});

test("shared emulator ADB readiness is deadline bounded, sanitized, and process aware", () => {
  const helperPath = path.join(root, "android/build-logic/emulator-adb-readiness.sh");
  const output = execFileSync("bash", ["-c", String.raw`
set -euo pipefail
umask 077
source "$1"
diagnostics="$(mktemp)"
ready_pid=''
timeout_pid=''
cleanup() {
  for pid in "$ready_pid" "$timeout_pid"; do
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
    fi
  done
  rm -f "$diagnostics"
}
trap cleanup EXIT

poll_emulator_adb_state() { printf '%s\n' 'device'; }
sleep 5 &
ready_pid=$!
wait_for_emulator_adb "$ready_pid" 'emulator-sensitive-serial' "$diagnostics" 2
kill "$ready_pid"
wait "$ready_pid" 2>/dev/null || true
ready_pid=''

(exit 0) &
dead_pid=$!
wait "$dead_pid"
exit_status=0
wait_for_emulator_adb "$dead_pid" 'emulator-sensitive-serial' "$diagnostics" 2 || exit_status=$?
[[ "$exit_status" == 69 ]]

poll_emulator_adb_state() { printf '%s\n' 'offline'; }
sleep 5 &
timeout_pid=$!
invalid_status=0
wait_for_emulator_adb "$timeout_pid" 'emulator-sensitive-serial' "$diagnostics" 241 || invalid_status=$?
[[ "$invalid_status" == 64 ]]
timeout_status=0
wait_for_emulator_adb "$timeout_pid" 'emulator-sensitive-serial' "$diagnostics" 2 || timeout_status=$?
kill "$timeout_pid"
wait "$timeout_pid" 2>/dev/null || true
timeout_pid=''
[[ "$timeout_status" == 70 ]]
cat "$diagnostics"
`, "adb-readiness-test", helperPath], { encoding: "utf8" });

  assert.match(output, /status=ready attempts=1 deadline_seconds=2[^\n]*adb_state=device/);
  assert.match(output, /status=emulator_exited attempts=0 deadline_seconds=2[^\n]*adb_state=unavailable/);
  assert.match(output, /status=polling attempts=[12] deadline_seconds=2[^\n]*adb_state=offline/);
  assert.match(output, /status=timed_out attempts=[12] deadline_seconds=2[^\n]*adb_state=offline/);
  assert.doesNotMatch(output, /sensitive|serial|token/);
});

test("disposable interactive proof uses private identity bounded cleanup and physical evidence", async () => {
  const [proof, readonlyProof, adbReadiness, isolatedAdb, adbSelector, selector, selectorFixture, server] = await Promise.all([
    source("android/build-logic/live-interactive-proof.sh"),
    source("android/build-logic/live-readonly-proof.sh"),
    source("android/build-logic/emulator-adb-readiness.sh"),
    source("android/build-logic/isolated-adb-server.sh"),
    source("android/build-logic/select-adb-server-port.py"),
    source("android/build-logic/uiautomator-control-center.py"),
    source("fixtures/android/uiautomator.request-control.xml"),
    source("scripts/pi-droid-disposable-daemon.mjs"),
  ]);

  assert.match(proof, /set -euo pipefail/);
  assert.match(proof, /umask 077/);
  assert.match(proof, /mktemp -d/);
  assert.match(proof, /trap cleanup EXIT/);
  assert.match(proof, /reserve_port_pair/);
  for (const harness of [proof, readonlyProof]) {
    assert.match(harness, /select-emulator-port-pair\.py/);
    assert.match(harness, /source "\$repo_root\/android\/build-logic\/isolated-adb-server\.sh"/);
    assert.match(harness, /select-adb-server-port\.py/);
    assert.match(harness, /start_isolated_adb_server/);
    assert.match(harness, /stop_isolated_adb_server/);
    assert.ok(harness.indexOf("start_isolated_adb_server") < harness.indexOf("avdmanager create avd"));
    assert.ok(harness.indexOf("start_isolated_adb_server") < harness.indexOf("emulator -avd pi-droid-live"));
    assert.ok(harness.indexOf("stop_isolated_adb_server") < harness.indexOf('rm -rf "$private_dir"'));
    assert.doesNotMatch(harness, /reserve_port_pair 5600 5682/);
    assert.match(harness, /emulator_port < 5554 \|\| emulator_port > 5584/);
    assert.match(harness, /emulator_adb_port != emulator_port \+ 1/);
    assert.match(harness, /emulator_port_attempts > 16/);
    assert.match(harness, /verification=both_localhost_ports_free/);
    assert.match(harness, /status=emulator_port_unavailable/);
    assert.match(harness, /emulator_console_port=none emulator_adb_port=none emulator_port_attempts=16/);
    assert.match(harness, /"emulatorConsolePort": \$emulator_port/);
    assert.match(harness, /"emulatorAdbPort": \$emulator_adb_port/);
    assert.match(harness, /"emulatorPortSelectionAttempts": \$emulator_port_attempts/);
    assert.match(harness, /"adbServerPort": \$adb_server_port/);
    assert.match(harness, /"adbServerPortSelectionAttempts": \$adb_server_port_attempts/);
    assert.match(harness, /"adbServerIsolated": true/);
    assert.match(harness, /"adbKeyHomePrivate": true/);
    assert.ok(harness.indexOf("if ! select_emulator_port_pair") < harness.indexOf("emulator -avd pi-droid-live"));
    assert.match(harness, /source "\$repo_root\/android\/build-logic\/emulator-adb-readiness\.sh"/);
    assert.match(harness, /wait_for_emulator_adb "\$emulator_pid" "\$emulator_serial" "\$emulator_diagnostics" 240/);
    const readinessGate = harness.slice(
      harness.indexOf("adb_readiness_status=0"),
      harness.indexOf("booted=''", harness.indexOf("adb_readiness_status=0")),
    );
    assert.doesNotMatch(readinessGate, /seq 1 120/);
    assert.match(readinessGate, /adb_readiness_status == 69/);
    assert.match(readinessGate, /adb_readiness_status == 70/);
    assert.match(harness, /for _ in \$\(seq 1 240\); do/);
    assert.doesNotMatch(harness, /adb\s+(?:kill-server|reconnect)\b/);
  }
  assert.match(adbSelector, /ADB_SERVER_PORTS = tuple\(range\(42000, 42128\)\)/);
  assert.match(adbSelector, /random\.SystemRandom\(\)\.shuffle/);
  assert.match(isolatedAdb, /export ANDROID_ADB_SERVER_PORT="\$adb_server_port"/);
  assert.match(isolatedAdb, /export ANDROID_USER_HOME="\$adb_key_home"/);
  assert.match(isolatedAdb, /export ANDROID_EMULATOR_HOME="\$adb_key_home"/);
  assert.match(isolatedAdb, /export ANDROID_AVD_HOME="\$private_root\/avd"/);
  assert.match(isolatedAdb, /export ADB_VENDOR_KEYS="\$adb_key_home"/);
  const isolatedStart = isolatedAdb.slice(
    isolatedAdb.indexOf("start_isolated_adb_server() {"),
    isolatedAdb.indexOf("\n}\n\nstop_isolated_adb_server()"),
  );
  assert.ok(isolatedStart.indexOf("export ANDROID_ADB_SERVER_PORT") < isolatedStart.indexOf("adb keygen"));
  assert.ok(isolatedStart.indexOf("export ADB_VENDOR_KEYS") < isolatedStart.indexOf("server nodaemon"));
  assert.match(isolatedStart, /adb -P "\$adb_server_port" server nodaemon/);
  assert.match(isolatedStart, /kill -0 "\$adb_server_pid"/);
  assert.match(isolatedAdb, /adb -H 127\.0\.0\.1 -P "\$adb_server_port" kill-server/);
  assert.match(isolatedAdb, /adb_server_port != 5037/);
  assert.doesNotMatch(isolatedAdb, /adb\s+(?:kill-server|reconnect)\b/);
  assert.doesNotMatch(isolatedAdb, /(?:ANDROID_ADB_SERVER_PORT|\b-P\s+)["']?5037/);
  assert.match(adbReadiness, /max_seconds > 240/);
  assert.match(adbReadiness, /timeout --foreground --signal=KILL "\$\{poll_timeout_seconds\}s" adb -s "\$emulator_serial" get-state/);
  assert.match(adbReadiness, /next_report_seconds=\$\(\(now_seconds \+ 30\)\)/);
  assert.match(adbReadiness, /status=%s attempts=%s deadline_seconds=%s elapsed_seconds=%s remaining_seconds=%s adb_state=%s/);
  assert.ok((adbReadiness.match(/kill -0 "\$emulator_pid"/g) ?? []).length >= 2);
  assert.doesNotMatch(adbReadiness, /adb\s+(?:kill-server|reconnect|wait-for-device)\b/);
  const recordStart = adbReadiness.indexOf("record_emulator_adb_readiness() {");
  const recordEnd = adbReadiness.indexOf("\n}\n\n", recordStart);
  const diagnosticRecorder = adbReadiness.slice(recordStart, recordEnd);
  assert.doesNotMatch(diagnosticRecorder, /serial|token|raw_state/);
  assert.match(proof, /emulator_abi='x86_64'/);
  assert.match(adbReadiness, /adb[^\n]*get-state/);
  assert.doesNotMatch(proof, /adb[^\n]*wait-for-device/);
  assert.match(proof, /openssl rand -hex 32/);
  const gateStart = proof.indexOf("wait_emulator_host_port()");
  const gateEnd = proof.indexOf("\n}\n\n", gateStart);
  const hostPortGate = proof.slice(gateStart, gateEnd);
  assert.ok(gateStart >= 0 && gateEnd > gateStart);
  assert.match(hostPortGate, /max_attempts=60/);
  assert.match(hostPortGate, /deadline_seconds=30/);
  assert.match(hostPortGate, /toybox nc -z -w 1 10\.0\.2\.2/);
  assert.match(hostPortGate, /sleep 0\.5/);
  assert.match(hostPortGate, /host_port_unreachable/);
  assert.doesNotMatch(hostPortGate, /token|bearer|authorization|https?:\/\//i);
  assert.ok(proof.indexOf("\nif ! wait_emulator_host_port") < proof.indexOf("shell am start"));
  assert.match(proof, /--interactive/);
  assert.match(proof, /tap_text "Request control"/);
  assert.match(proof, /tap_text "Connect interactive observer"/);
  assert.match(proof, /ACTION RECEIVED · CONNECTING\|OBSERVER · READY\|INTERACTIVE ERROR · PREFLIGHT_ERROR/);
  assert.match(proof, /wait_ui 'OBSERVER · READY'/);
  assert.match(proof, /wait_ui 'REQUESTING\|CONTROLLER'/);
  assert.ok(proof.indexOf('wait_ui \'OBSERVER · READY\'') < proof.indexOf('tap_text "Request control"'));
  assert.match(proof, /uiautomator-control-center\.py/);
  assert.match(selector, /clickable ancestor/);
  assert.match(selector, /item\.attrib\.get\("text"\) != label/);
  assert.match(selector, /control has no clickable ancestor/);
  assert.match(selectorFixture, /text="Request control"/);
  assert.match(selectorFixture, /content-desc="Request session control"/);
  assert.match(selectorFixture, /clickable="true"[^>]*bounds="\[626,1682\]\[1012,1787\]"/);
  assert.match(proof, /hold-until-disconnect/);
  assert.match(proof, /PROMPT INDETERMINATE/);
  const promptSucceeded = proof.indexOf('screenshots/prompt-succeeded.png');
  const dismissIme = proof.indexOf('keyevent KEYCODE_BACK');
  const waitForTree = proof.indexOf('wait_control "Show tree presentation" 30');
  const tapTree = proof.indexOf('shell input tap "$tree_x" "$tree_y"');
  assert.ok(promptSucceeded >= 0 && promptSucceeded < dismissIme);
  assert.ok(dismissIme < waitForTree && waitForTree < tapTree);
  assert.match(proof, /tree_control_occluded/);
  assert.match(proof, /tree-control-occluded\.xml/);
  assert.match(proof, /tree-control-occluded\.png/);
  assert.match(proof, /tree-control-occluded-sha256sums\.txt/);
  assert.match(proof, /Show tree presentation/);
  assert.match(proof, /Show tui presentation/);
  assert.match(proof, /screenrecord/);
  assert.match(proof, /screencap/);
  assert.match(proof, /reconnected-controller-phone\.png/);
  assert.match(proof, /reconnected-controller-tablet\.png/);
  assert.match(proof, /live-interactive-sha256sums\.txt/);
  assert.match(proof, /emulator-host-port-gate\.log/);
  assert.match(proof, /"hostPortGate": true/);
  assert.match(proof, /blindReplay\": false/);
  assert.doesNotMatch(proof, /(?:7463|8080|3000)/);
  assert.match(server, /options\.interactive/);
  assert.match(server, /ShadowTuiAttachmentManager/);
  assert.match(server, /command\.type === "prompt"/);
  assert.match(server, /command\.type === "get_tree"/);
  assert.match(server, /request_control/);
  assert.match(server, /control_granted/);
  assert.match(server, /controlGrant: rpcProbe\.controlGrant/);
  assert.match(server, /hold-until-disconnect/);
});
