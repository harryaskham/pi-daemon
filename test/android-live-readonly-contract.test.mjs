import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));

async function source(relative) {
  try {
    return await readFile(path.join(root, relative), "utf8");
  } catch (error) {
    assert.fail(`${relative} must exist for the live readonly contract: ${error.code ?? error.message}`);
  }
}

test("Android manifest and network policy enable only reviewed bearer transport", async () => {
  const [manifest, policy] = await Promise.all([
    source("android/app/src/main/AndroidManifest.xml"),
    source("android/app/src/main/res/xml/network_security_config.xml"),
  ]);

  assert.match(manifest, /android\.permission\.INTERNET/);
  assert.match(manifest, /android:networkSecurityConfig="@xml\/network_security_config"/);
  assert.match(manifest, /android:usesCleartextTraffic="true"/);
  assert.match(manifest, /android:scheme="pidroid"/);
  assert.match(manifest, /android:host="pair"/);
  assert.match(manifest, /android:pathPrefix="\/v1\/"/);
  assert.match(policy, /cleartextTrafficPermitted="true"/);
  assert.match(policy, /system/);
  assert.doesNotMatch(policy, /user/);
});

test("live app preserves bounded transport protected credentials and readonly hydration", async () => {
  const [catalog, build, transport, credentials, registry, repository, activity, screen] = await Promise.all([
    source("android/gradle/libs.versions.toml"),
    source("android/app/build.gradle.kts"),
    source("android/app/src/main/kotlin/com/harryaskham/pidroid/live/OkHttpPiDaemonTransport.kt"),
    source("android/app/src/main/kotlin/com/harryaskham/pidroid/live/AndroidCredentials.kt"),
    source("android/app/src/main/kotlin/com/harryaskham/pidroid/live/AndroidHostRegistry.kt"),
    source("android/app/src/main/kotlin/com/harryaskham/pidroid/live/LiveReadonlyRepository.kt"),
    source("android/app/src/main/kotlin/com/harryaskham/pidroid/MainActivity.kt"),
    source("android/app/src/main/kotlin/com/harryaskham/pidroid/live/LiveReadonlyScreen.kt"),
  ]);

  assert.match(catalog, /okhttp[^\n]*5\.4\.0/);
  assert.match(build, /sdk-core\/src\/main\/kotlin/);
  assert.match(build, /sdk-session-ui\/src\/main\/kotlin/);
  assert.match(build, /mockwebserver/);
  assert.match(transport, /interface LiveHostTransport[^]*PiDaemonTransport/);
  assert.match(transport, /class OkHttpPiDaemonTransport[^]*LiveHostTransport/);
  assert.match(transport, /MAX_RESPONSE_BYTES/);
  assert.match(transport, /CertificateFingerprintTrustManager/);
  assert.match(transport, /Channel<String>|callbackFlow/);
  assert.doesNotMatch(transport, /println|Log\.|Authorization.*toString/);
  assert.match(credentials, /AndroidKeyStore/);
  assert.match(credentials, /noBackupFilesDir/);
  assert.match(credentials, /AES\/GCM\/NoPadding/);
  assert.doesNotMatch(credentials, /SharedPreferences[^]*bearer/);
  assert.match(registry, /HostRegistryStore/);
  assert.match(registry, /PairingPayloadCodec/);
  assert.match(repository, /client\.capabilities\(\)/);
  assert.match(repository, /client\.dashboardCapabilities\(\)/);
  assert.match(repository, /client\.listInventory\(/);
  assert.match(repository, /client\.inventoryInfo\(/);
  assert.match(repository, /\.transcript\(/);
  assert.match(repository, /SessionLifecycleProjection/);
  assert.doesNotMatch(repository, /SessionFixtureDecoder/);
  assert.match(repository, /CacheFreshness\.(?:RECONNECTING|RESYNCING|OFFLINE_CACHED)/);
  assert.match(activity, /LiveReadonlyScreen/);
  assert.match(screen, /SessionSurface/);
  assert.match(repository, /SessionRole\.OBSERVER/);
});

test("host management is multi-host, explicit, transactional, recoverable, and secret-safe", async () => {
  const [hostRegistry, repository, transport, manager, manifest, extractionRules] = await Promise.all([
    source("android/sdk-core/src/main/kotlin/com/harryaskham/pidroid/sdk/core/HostRegistry.kt"),
    source("android/app/src/main/kotlin/com/harryaskham/pidroid/live/LiveReadonlyRepository.kt"),
    source("android/app/src/main/kotlin/com/harryaskham/pidroid/live/OkHttpPiDaemonTransport.kt"),
    source("android/app/src/main/kotlin/com/harryaskham/pidroid/live/HostManagementScreen.kt"),
    source("android/app/src/main/AndroidManifest.xml"),
    source("android/app/src/main/res/xml/data_extraction_rules.xml"),
  ]);

  for (const control of ["Add another host", "Make default", "Edit", "Re-pair", "Forget", "Replace credentials"]) {
    assert.match(manager, new RegExp(control));
  }
  assert.match(manager, /AlertDialog/);
  assert.match(manager, /PasswordVisualTransformation/);
  assert.match(manager, /Host no longer registered/);
  assert.match(manager, /READY/);
  assert.match(manager, /pinned certificate/);
  assert.match(manager, /explicitly trusted tailnet/);
  assert.match(repository, /DuplicateEndpoint/);
  assert.match(repository, /selectDefaultHost/);
  assert.match(repository, /replaceHostEnvelope/);
  assert.match(transport, /invalidateHost/);
  assert.match(hostRegistry, /updateMetadata/);
  assert.match(hostRegistry, /credentials\.remove\(nextHandle\)/);

  const replacement = repository.slice(repository.indexOf("private suspend fun replaceHostPayload"), repository.indexOf("private suspend fun afterHostMutation"));
  assert.ok(replacement.indexOf("registry.replace") < replacement.indexOf("afterHostMutation"));
  const committedMutation = repository.slice(repository.indexOf("private suspend fun afterHostMutation"), repository.indexOf("private fun publishRegisteredHosts"));
  assert.ok(committedMutation.indexOf("transport.invalidateHost") < committedMutation.indexOf("refresh()"));

  const hostManagementModel = repository.slice(repository.indexOf("public sealed interface HostManagementNotice"), repository.indexOf("public data class ExternalCanaryExpectation"));
  assert.doesNotMatch(hostManagementModel, /CharArray|bearer|PairingPayload/i);
  assert.doesNotMatch(manager, /println|Log\.|rememberSaveable/);
  assert.match(manifest, /android:allowBackup="false"/);
  assert.match(extractionRules, /exclude domain="sharedpref" path="\."/);
});

test("disposable-daemon emulator proof is bounded readonly and release advances to version four", async () => {
  const [proof, adbReadiness, uiHealth, server, release] = await Promise.all([
    source("android/build-logic/live-readonly-proof.sh"),
    source("android/build-logic/emulator-adb-readiness.sh"),
    source("android/build-logic/emulator-ui-health.sh"),
    source("scripts/pi-droid-disposable-daemon.mjs"),
    source("android/release.properties"),
  ]);

  assert.match(proof, /set -euo pipefail/);
  assert.match(proof, /mktemp -d/);
  assert.match(proof, /trap 'cleanup "\$\?"' EXIT/);
  assert.match(proof, /10\.0\.2\.2/);
  assert.match(proof, /am start/);
  assert.match(proof, /source "\$repo_root\/android\/build-logic\/emulator-ui-health\.sh"/);
  assert.match(proof, /source "\$repo_root\/android\/build-logic\/physical-proof-lifecycle\.sh"/);
  assert.match(uiHealth, /uiautomator dump/);
  assert.match(proof, /emulator_abi='x86_64'/);
  assert.match(proof, /source "\$repo_root\/android\/build-logic\/emulator-adb-readiness\.sh"/);
  assert.match(proof, /emulator_device_serial="127\.0\.0\.1:\$emulator_adb_port"/);
  assert.match(proof, /wait_for_emulator_adb\s+\\\n\s+"\$emulator_pid" "\$emulator_device_serial" "\$adb_server_port" "\$emulator_diagnostics" 240/);
  assert.match(adbReadiness, /adb -H 127\.0\.0\.1 -P "\$adb_server_port" connect "\$device_serial"/);
  assert.match(adbReadiness, /adb[^\n]*get-state/);
  assert.match(adbReadiness, /max_seconds > 240/);
  assert.match(adbReadiness, /return 69/);
  assert.match(adbReadiness, /return 70/);
  assert.doesNotMatch(proof, /adb[^\n]*wait-for-device/);
  assert.match(proof, /Live readonly session/);
  assert.match(proof, /OFFLINE CACHED|Offline cached/);
  assert.match(proof, /hostInstanceId/);
  assert.match(proof, /"disposableBearerRetainedTextScan": true/);
  assert.match(proof, /"disposableBearerLeak": false/);
  assert.match(proof, /run_physical_proof_bearer_scan/);
  assert.doesNotMatch(proof, /prompt|wake|controller/i);
  assert.match(server, /new ApiServer/);
  assert.match(server, /DashboardNeutralApiController/);
  assert.match(server, /allowInsecureRemote: true/);
  assert.match(server, /hostInstanceId/);
  assert.doesNotMatch(server, /production|api-token|home\/harry/i);
  assert.match(release, /versionCode=4/);
  assert.match(release, /versionName=0\.3\.0-internal\.4/);
});
