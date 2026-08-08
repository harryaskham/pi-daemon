import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));

async function source(relative) {
  return readFile(path.join(root, relative), "utf8");
}

test("readiness evidence discriminates offline transport without retaining key bytes", () => {
  const classifier = path.join(root, "android/build-logic/emulator-readiness-evidence.py");
  const output = execFileSync("python3", ["-c", String.raw`
import hashlib
import importlib.util
import pathlib
import socket
import sys
import tempfile
import threading

classifier_path = pathlib.Path(sys.argv[1])
spec = importlib.util.spec_from_file_location("emulator_readiness_evidence", classifier_path)
classifier = importlib.util.module_from_spec(spec)
spec.loader.exec_module(classifier)

public_payload = "cHVibGljLWZpeHR1cmUta2V5"
expected = "sha256:" + hashlib.sha256(public_payload.encode()).hexdigest()
mismatch = "sha256:" + hashlib.sha256(b"different-public-key").hexdigest()
private_marker = "SENSITIVE_PRIVATE_KEY_BYTES_MUST_NOT_SURVIVE"

with tempfile.TemporaryDirectory() as temporary:
    root = pathlib.Path(temporary)
    emulator_log = root / "emulator.log"
    emulator_log.write_text(
        "INFO | Sending adb public key [" + public_payload + " fixture@host]\n"
        "[    0.000000] Linux version fixture\n"
        "[    1.000000] init: starting service 'adbd' " + private_marker + "\n"
    )

    def run_case(name, expected_fingerprint, reply, *, adb_state="offline", extra_log=""):
        case_log = root / f"{name}.log"
        case_log.write_text(emulator_log.read_text() + extra_log)
        socket_path = root / f"{name}.sock"
        thread = None
        if reply is not None:
            server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            server.bind(str(socket_path))
            server.listen(1)
            def serve():
                try:
                    connection, _ = server.accept()
                    with connection:
                        connection.recv(65536)
                        connection.sendall(reply.encode())
                finally:
                    server.close()
            thread = threading.Thread(target=serve, daemon=True)
            thread.start()
        destination = root / f"{name}.evidence"
        original_argv = sys.argv
        try:
            sys.argv = [
                str(classifier_path),
                "--emulator-log", str(case_log),
                "--console-socket", str(socket_path),
                "--output", str(destination),
                "--expected-public-key-fingerprint", expected_fingerprint,
                "--connect-state", "already_connected",
                "--adb-state", adb_state,
            ]
            assert classifier.main() == 0
        finally:
            sys.argv = original_argv
        if thread is not None:
            thread.join(timeout=2)
            assert not thread.is_alive()
        retained = destination.read_text()
        assert len(retained.encode()) < 160_000
        assert public_payload not in retained
        assert private_marker not in retained
        assert "fixture@host" not in retained
        assert "private_adb" not in retained.lower()
        return retained

    ready_console = """
root:/ # echo pidroid_diag_begin; echo commands
pidroid_diag_begin
pidroid_diag_boot_completed=1
pidroid_diag_adbd_state=running
pidroid_diag_zygote_state=running
pidroid_diag_system_server_state=running
pidroid_diag_abi=x86_64
pidroid_diag_uptime_seconds=151
pidroid_diag_end
"""
    handshake = run_case("handshake", expected, ready_console)
    assert "classification=adbd_transport_handshake_stalled\n" in handshake
    assert "public_key_fingerprint_match=true\n" in handshake
    assert "guest_boot_completed=1\n" in handshake
    assert "guest_adbd_state=running\n" in handshake

    auth = run_case("auth", mismatch, ready_console)
    assert "classification=adbd_auth_key_mismatch\n" in auth
    assert "public_key_fingerprint_match=false\n" in auth

    boot_console = ready_console.replace("boot_completed=1", "boot_completed=0").replace("adbd_state=running", "adbd_state=stopped")
    boot = run_case("boot", expected, boot_console)
    assert "classification=guest_boot_incomplete\n" in boot
    assert "guest_boot_completed=0\n" in boot
    assert "guest_adbd_state=stopped\n" in boot

    framework_console = ready_console.replace("boot_completed=1", "boot_completed=0").replace(
        "system_server_state=running", "system_server_state=absent"
    )
    framework = run_case(
        "framework",
        expected,
        framework_console,
        adb_state="device",
        extra_log=("init: Control message: Could not find 'aidl/activity' for ctl.interface_start\n" * 3),
    )
    assert "classification=guest_framework_boot_stalled\n" in framework
    assert "guest_system_server_state=absent\n" in framework
    assert "activity_manager_missing_events=3\n" in framework

    panic = run_case("panic", expected, None, extra_log="[  42.0] Kernel panic - not syncing: fixture\n")
    assert "classification=guest_kernel_failure\n" in panic
    assert "guest_console=unavailable\n" in panic

print("fixture=ok transport_connected_offline=classified private_key_bytes=absent bounded=true")
`, classifier], {
    encoding: "utf8",
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
  });
  assert.match(output, /fixture=ok transport_connected_offline=classified private_key_bytes=absent bounded=true/);
});

test("pre-boot console recorder retains kernel progress and only fixed-enum state", () => {
  const recorder = path.join(root, "android/build-logic/emulator-guest-console-recorder.py");
  const classifier = path.join(root, "android/build-logic/emulator-readiness-evidence.py");
  const output = execFileSync("python3", ["-c", String.raw`
import hashlib
import pathlib
import socket
import subprocess
import sys
import tempfile
import time

recorder, classifier = map(pathlib.Path, sys.argv[1:])
public_payload = "cmVjb3JkZXItcHVibGljLWtleQ=="
expected = "sha256:" + hashlib.sha256(public_payload.encode()).hexdigest()
private_marker = "SENSITIVE_PRIVATE_KEY_BYTES_MUST_NOT_SURVIVE"
with tempfile.TemporaryDirectory() as temporary:
    root = pathlib.Path(temporary)
    console_socket = root / "console.sock"
    raw_console = root / "console.log"
    state = root / "console.state"
    emulator_log = root / "emulator.log"
    evidence = root / "evidence.log"
    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    server.bind(str(console_socket))
    server.listen(1)
    process = subprocess.Popen([
        sys.executable, str(recorder),
        "--console-socket", str(console_socket),
        "--raw-log", str(raw_console),
        "--state", str(state),
    ])
    connection, _ = server.accept()
    with connection:
        connection.sendall((
            "[    0.000000] Linux version fixture\n"
            "[    1.000000] Run /init as init process\n"
            "[    2.000000] init: starting service 'adbd' " + private_marker + "\n"
        ).encode())
        command = connection.recv(65536)
        assert b"getprop sys.boot_completed" in command
        connection.sendall(b"""
pidroid_diag_begin
pidroid_diag_boot_completed=1
pidroid_diag_adbd_state=running
pidroid_diag_zygote_state=running
pidroid_diag_system_server_state=running
pidroid_diag_abi=x86_64
pidroid_diag_uptime_seconds=147
pidroid_diag_end
""")
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            if state.exists() and "guest_boot_completed=1\n" in state.read_text():
                break
            time.sleep(0.02)
        else:
            raise AssertionError("recorder did not publish boot-complete state")
    server.close()
    assert process.wait(timeout=3) == 0
    state_text = state.read_text()
    assert "guest_console=available\n" in state_text
    assert "guest_adbd_state=running\n" in state_text
    assert "guest_system_server_state=running\n" in state_text
    assert "guest_abi=x86_64\n" in state_text
    assert "kernel_started=true\n" in state_text
    assert "init_started=true\n" in state_text
    emulator_log.write_text("INFO | Sending adb public key [" + public_payload + " fixture@host]\n")
    subprocess.check_call([
        sys.executable, str(classifier),
        "--emulator-log", str(emulator_log),
        "--console-state", str(state),
        "--console-log", str(raw_console),
        "--output", str(evidence),
        "--expected-public-key-fingerprint", expected,
        "--connect-state", "already_connected",
        "--adb-state", "offline",
    ])
    retained = evidence.read_text()
    assert "classification=adbd_transport_handshake_stalled\n" in retained
    assert "guest_boot_completed=1\n" in retained
    assert "Linux version fixture" in retained
    assert "Run /init as init process" in retained
    assert public_payload not in retained
    assert private_marker not in retained
print("recorder=ok preboot_kernel=retained fixed_state=ok private_key_bytes=absent")
`, recorder, classifier], {
    encoding: "utf8",
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
  });
  assert.match(output, /recorder=ok preboot_kernel=retained fixed_state=ok private_key_bytes=absent/);
});

test("API 36 AVD boot profile rejects the 32 MiB generic fallback", () => {
  const verifier = path.join(root, "android/build-logic/emulator-avd-boot-profile.py");
  const contract = path.join(root, "android/build-logic/emulator-system-image.json");
  const output = execFileSync("python3", ["-c", String.raw`
import pathlib
import subprocess
import sys
import tempfile

verifier = pathlib.Path(sys.argv[1])
contract = pathlib.Path(sys.argv[2])
printed = subprocess.run(
    [sys.executable, str(verifier), "--print-contract", str(contract)],
    check=False,
    text=True,
    stdout=subprocess.PIPE,
    stderr=subprocess.PIPE,
)
assert printed.returncode == 0
assert printed.stdout == (
    "system-images;android-36;default;x86_64\t"
    "system-images/android-36/default/x86_64/\tdefault\tmedium_phone\t36\tx86_64\n"
)
assert printed.stderr == ""
base = {
    "abi.type": "x86_64",
    "tag.id": "default",
    "hw.device.name": "medium_phone",
    "image.sysdir.1": "system-images/android-36/default/x86_64/",
    "hw.cpu.ncore": "4",
    "hw.ramSize": "2G",
    "vm.heapSize": "228M",
}
with tempfile.TemporaryDirectory() as temporary:
    root = pathlib.Path(temporary)
    def run_case(name, updates):
        fields = dict(base)
        fields.update(updates)
        config = root / (name + ".ini")
        config.write_text("".join(f"{key}={value}\n" for key, value in fields.items()))
        return subprocess.run(
            [sys.executable, str(verifier), str(config), str(contract)],
            check=False,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )

    valid = run_case("valid", {})
    assert valid.returncode == 0
    assert valid.stdout == (
        "phase=avd_boot_profile status=verified "
        "system_image=android_36_default_x86_64 device_profile=medium_phone "
        "ram_class=at_least_2048_mib vm_heap_class=at_least_192_mib cpu_class=multi_core\n"
    )
    assert valid.stderr == ""
    for name, updates in (
        ("generic_heap", {"vm.heapSize": "32M"}),
        ("profile_missing", {"hw.device.name": ""}),
        ("wrong_image", {"tag.id": "google_apis"}),
        ("low_ram", {"hw.ramSize": "1536M"}),
        ("single_core", {"hw.cpu.ncore": "1"}),
    ):
        rejected = run_case(name, updates)
        assert rejected.returncode != 0
        assert rejected.stdout == ""
        assert rejected.stderr == "invalid emulator AVD boot profile\n"
print("avd_profile=ok generic_32_mib_heap=rejected phone_228_mib_heap=verified")
`, verifier, contract], { encoding: "utf8", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
  assert.match(output, /avd_profile=ok generic_32_mib_heap=rejected phone_228_mib_heap=verified/);
});

test("pinned API 36 image is minimal AOSP and Pi Droid needs no Google runtime", async () => {
  const [contractText, flake, appBuild, appLock, versionCatalog, manifest, release] = await Promise.all([
    source("android/build-logic/emulator-system-image.json"),
    source("flake.nix"),
    source("android/app/build.gradle.kts"),
    source("android/app/gradle.lockfile"),
    source("android/gradle/libs.versions.toml"),
    source("android/app/src/main/AndroidManifest.xml"),
    source("android/build-logic/release-internal.sh"),
  ]);
  const contract = JSON.parse(contractText);
  assert.deepEqual(contract, {
    schemaVersion: 1,
    apiLevel: 36,
    imageType: "default",
    abi: "x86_64",
    package: "system-images;android-36;default;x86_64",
    directory: "system-images/android-36/default/x86_64/",
    deviceProfile: "medium_phone",
    automatedTestDevice: false,
    aospAtdAvailableInPinnedCatalog: false,
    googleAtdAvailableInPinnedCatalog: false,
    googleApisRequired: false,
    googlePlayServicesRequired: false,
    googlePlayStoreRequired: false,
  });
  assert.match(flake, /androidenv\/repo\.json/);
  assert.match(flake, /!builtins\.hasAttr "aosp_atd" androidApiImageCatalog/);
  assert.match(flake, /!builtins\.hasAttr "google_atd" androidApiImageCatalog/);
  assert.match(flake, /systemImageTypes = \[androidEmulatorSystemImage\.imageType\]/);
  assert.match(flake, /android-test-system-image-closure/);
  assert.match(flake, /builtins\.head androidReleaseSdk\."system-images"/);
  assert.doesNotMatch(appBuild, /com\.google\.android\.gms|com\.google\.firebase|play-services|firebase-/i);
  assert.doesNotMatch(appLock, /com\.google\.android\.gms|com\.google\.firebase|play-services|firebase-/i);
  assert.doesNotMatch(versionCatalog, /module\s*=\s*"com\.google\.android\.gms|module\s*=\s*"com\.google\.firebase/i);
  assert.doesNotMatch(manifest, /<uses-library[^>]+com\.google|com\.google\.android\.gms/i);
  assert.match(release, /create_bounded_api36_test_avd pi-droid-release/);
});

test("diagnostic runner is bounded, isolated, app-free, and uses delayed ADB", async () => {
  const [runner, interactive, readonly, readiness, profile] = await Promise.all([
    source("android/build-logic/emulator-readiness-diagnostic.sh"),
    source("android/build-logic/live-interactive-proof.sh"),
    source("android/build-logic/live-readonly-proof.sh"),
    source("android/build-logic/emulator-adb-readiness.sh"),
    source("android/build-logic/emulator-avd-boot-profile.sh"),
  ]);

  assert.match(runner, /deadline_seconds=240/);
  assert.match(runner, /deadline_seconds < 30 \|\| deadline_seconds > 240/);
  assert.match(runner, /start_isolated_adb_server/);
  assert.match(runner, /create_bounded_api36_test_avd/);
  assert.match(runner, /"deviceProfile": "\$emulator_device_profile"/);
  assert.match(runner, /"avdBootProfileVerified": \$avd_boot_profile_verified/);
  assert.match(runner, /avd_boot_profile_verified='true'/);
  assert.match(runner, /wait_for_emulator_adb/);
  assert.match(runner, /-delay-adb -show-kernel/);
  assert.match(runner, /emulator-guest-console-recorder\.py/);
  assert.match(runner, /-shell-serial "unix:\$emulator_guest_console_socket,server"/);
  assert.doesNotMatch(runner, /emulator_guest_console_socket,server,nowait/);
  assert.match(runner, /capture_emulator_readiness_evidence/);
  assert.match(runner, /readiness_deadline_seconds=\$\(\(readiness_started_seconds \+ deadline_seconds\)\)/);
  assert.match(runner, /while \(\( SECONDS < readiness_deadline_seconds \)\); do/);
  assert.match(runner, /boot_completed.*!= '1'/s);
  assert.match(runner, /device_abi.*!= 'x86_64'/s);
  assert.match(runner, /privateAdbKeyRetained": false/);
  assert.match(runner, /piServiceAccessed": false/);
  assert.match(runner, /piDroidBuiltOrInstalled": false/);
  assert.match(runner, /finalize_diagnostic/);
  assert.match(runner, /owned_processes=%s/);
  assert.match(runner, /owned_ports=%s/);
  assert.doesNotMatch(runner, /npm\s|gradlew|assemble|install -r|service-bearer|token-file|pi-droid-disposable-daemon|shell am start/);

  assert.match(profile, /avdmanager create avd --force/);
  assert.match(profile, /--device "\$emulator_device_profile"/);
  assert.match(profile, /--package "\$emulator_system_image_package"/);
  assert.match(profile, /emulator-system-image\.json/);
  assert.match(profile, /emulator-avd-boot-profile\.py/);
  assert.match(profile, /phase=avd_boot_profile status=invalid/);

  for (const harness of [interactive, readonly]) {
    assert.match(harness, /create_bounded_api36_test_avd/);
    assert.match(harness, /"deviceProfile": "\$emulator_device_profile"/);
    assert.match(harness, /"avdBootProfileVerified": true/);
    assert.match(harness, /-delay-adb -show-kernel/);
    assert.match(harness, /emulator-guest-console-recorder\.py/);
    assert.match(harness, /-shell-serial "unix:\$emulator_guest_console_socket,server"/);
    assert.doesNotMatch(harness, /emulator_guest_console_socket,server,nowait/);
    assert.match(harness, /capture_emulator_readiness_evidence/);
    assert.match(harness, /emulator-readiness-evidence\.log/);
    assert.match(harness, /wait_for_emulator_adb\s+\\\n\s+"\$emulator_pid" "\$emulator_device_serial" "\$adb_server_port" "\$emulator_diagnostics" 240/);
    assert.doesNotMatch(harness, /adb\s+(?:kill-server|reconnect)\b/);
  }
  assert.match(readiness, /emulator_adb_last_connect_state/);
  assert.match(readiness, /emulator_adb_last_state/);
  assert.match(readiness, /--expected-public-key-fingerprint/);
});
