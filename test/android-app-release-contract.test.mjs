import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";

const rootDir = fileURLToPath(new URL("../", import.meta.url));

async function source(relativePath) {
  try {
    return await readFile(path.join(rootDir, relativePath), "utf8");
  } catch (error) {
    assert.fail(`${relativePath} must exist for the Pi Droid internal release contract: ${error.code ?? error.message}`);
  }
}

test("Pi Droid app is conditional, fixed-identity, source-gated, and release signed", async () => {
  const [settings, catalog, build, manifest, activity, liveScreen] = await Promise.all([
    source("android/settings.gradle.kts"),
    source("android/gradle/libs.versions.toml"),
    source("android/app/build.gradle.kts"),
    source("android/app/src/main/AndroidManifest.xml"),
    source("android/app/src/main/kotlin/com/harryaskham/pidroid/MainActivity.kt"),
    source("android/app/src/main/kotlin/com/harryaskham/pidroid/live/LiveReadonlyScreen.kt"),
  ]);

  assert.match(settings, /piDroidAndroidApp/);
  assert.match(settings, /include\(":app"\)/);
  assert.doesNotMatch(settings, /^include\(":app"\)$/m);
  assert.match(catalog, /gradle-play-publisher[^\n]*4\.0\.0/);
  assert.match(catalog, /activity-compose[^\n]*1\.13\.0/);

  assert.match(build, /applicationId\s*=\s*"com\.harryaskham\.pidroid"/);
  assert.match(build, /namespace\s*=\s*"com\.harryaskham\.pidroid"/);
  assert.match(build, /compileSdk\s*=\s*36/);
  assert.match(build, /minSdk\s*=\s*26/);
  assert.match(build, /targetSdk\s*=\s*36/);
  assert.match(build, /versionCode\s*=\s*providers\.gradleProperty\("piDroidVersionCode"\)/);
  assert.match(build, /versionName\s*=\s*providers\.gradleProperty\("piDroidVersionName"\)/);
  assert.match(build, /resolutionStrategy\.set\(ResolutionStrategy\.IGNORE\)/);
  assert.match(build, /track\.set\("internal"\)/);
  assert.match(build, /serviceAccountCredentials\.set\(file\(/);
  assert.match(build, /PI_DROID_RELEASE_(?:KEYSTORE|KEY_ALIAS_FILE|STORE_PASSWORD_FILE|KEY_PASSWORD_FILE)/);
  assert.doesNotMatch(build, /PI_DROID_RELEASE_(?:STORE_PASSWORD|KEY_PASSWORD)"/);
  assert.match(build, /\.\.\/sdk-workspace-ui\/src\/main\/kotlin/);
  assert.match(build, /WorkspaceFixtureApp\.kt/);

  assert.match(manifest, /android\.permission\.INTERNET/);
  assert.match(manifest, /android:name="\.MainActivity"/);
  assert.match(activity, /LiveReadonlyScreen/);
  assert.match(activity, /interactiveState/);
  assert.match(activity, /handleInteraction/);
  assert.match(liveScreen, /SessionSurface/);
  assert.match(liveScreen, /HostRegistrationScreen/);
});

test("Android shells select the pinned platform-specific Java home", async () => {
  const flake = await source("flake.nix");

  assert.match(flake, /androidJavaHome\s*=/);
  assert.match(flake, /if pkgs\.stdenv\.isDarwin/);
  assert.match(flake, /Library\/Java\/JavaVirtualMachines\/zulu-21\.jdk\/Contents\/Home/);
  assert.match(flake, /else "\$\{pkgs\.jdk21\}\/lib\/openjdk"/);
  assert.equal((flake.match(/JAVA_HOME = androidJavaHome;/g) ?? []).length, 2);
});

test("release script materializes secrets privately and verifies fixed identity before upload", async () => {
  const script = await source("android/build-logic/release-internal.sh");

  assert.match(script, /set -euo pipefail/);
  assert.match(script, /umask 077/);
  assert.match(script, /mktemp -d/);
  assert.match(script, /trap ['"]cleanup/);
  assert.match(script, /sops[^\n]*--decrypt/);
  assert.match(script, /play_keystore_base64/);
  assert.match(script, /play_service_account_json/);
  assert.match(script, /base64[^\n]*--decode/);
  assert.match(script, /keytool/);
  assert.match(script, /FA:58:80:A7:C9:6D:F8:7B:B4:63:7D:18:58:7E:32:F6:CD:F6:95:06:52:34:FE:54:95:E2:4F:ED:12:1E:CE:4C/);
  assert.match(script, /com\.harryaskham\.pidroid/);
  assert.match(script, /bundletool[^\n]*validate/);
  assert.match(script, /jarsigner[^\n]*-verify/);
  assert.match(script, /publishReleaseBundle/);
  assert.match(script, /verifyInternalTrackReceipt/);
  assert.match(script, /android\.permission\.INTERNET/);
  assert.match(script, /"internetPermission": \$internet_permission/);
  assert.match(script, /--prepare-only/);
  assert.match(script, /--upload-prepared/);
  assert.doesNotMatch(script, /jarsigner[^\n]*-strict/);
  assert.match(script, /sha256sums\.txt/);
  assert.match(script, /play-internal-receipt\.json/);
  assert.match(script, /pi-droid-release\.aab/);
  assert.match(script, /mapping\.txt/);
  assert.match(script, /source "\$repo_root\/android\/build-logic\/emulator-avd-boot-profile\.sh"/);
  assert.match(script, /create_bounded_api36_test_avd pi-droid-release/);
  assert.match(script, /adb[^\n]*get-state/);
  assert.doesNotMatch(script, /adb[^\n]*wait-for-device/);
  assert.doesNotMatch(script, /echo\s+.*(?:PASSWORD|SERVICE_ACCOUNT|KEYSTORE)/i);
});

test("manual release workflow is isolated from ordinary CI and retains exact evidence", async () => {
  const [workflow, fastWorkflow] = await Promise.all([
    source(".github/workflows/android-internal.yml"),
    source(".github/workflows/android-fast.yml"),
  ]);

  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /pull_request:/);
  assert.doesNotMatch(workflow, /push:/);
  assert.match(workflow, /androidRelease/);
  assert.match(workflow, /release-internal\.sh/);
  assert.match(workflow, /--prepare-only/);
  assert.match(workflow, /--upload-prepared/);
  assert.match(workflow, /track[^\n]*internal/i);
  assert.match(workflow, /pi-droid-release\.aab/);
  assert.match(workflow, /mapping\.txt/);
  assert.match(workflow, /sha256sums\.txt/);
  assert.match(workflow, /play-internal-receipt\.json/);
  assert.match(workflow, /screenshots/);
  assert.match(workflow, /retention-days:/);
  assert.doesNotMatch(workflow, /production|beta|alpha/);
  assert.doesNotMatch(fastWorkflow, /piDroidAndroidApp|bundleRelease|publishReleaseBundle/);
});
