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
  const [settings, catalog, build, manifest, activity, liveScreen, hostManagement, releaseNotes, releaseProperties] = await Promise.all([
    source("android/settings.gradle.kts"),
    source("android/gradle/libs.versions.toml"),
    source("android/app/build.gradle.kts"),
    source("android/app/src/main/AndroidManifest.xml"),
    source("android/app/src/main/kotlin/com/harryaskham/pidroid/MainActivity.kt"),
    source("android/app/src/main/kotlin/com/harryaskham/pidroid/live/LiveReadonlyScreen.kt"),
    source("android/app/src/main/kotlin/com/harryaskham/pidroid/live/HostManagementScreen.kt"),
    source("android/app/src/main/play/release-notes/en-US/internal.txt"),
    source("android/release.properties"),
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
  assert.match(build, /piDroidVersionCode"\)\.getOrElse\("6"\)/);
  assert.match(build, /piDroidVersionName"\)\.getOrElse\("0\.3\.0-internal\.6"\)/);
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
  assert.match(liveScreen, /HostManagementScreen/);
  assert.match(hostManagement, /HostRegistrationScreen/);
  assert.match(releaseNotes, /screenshot-tested phone, tablet, and wide polish/);
  assert.match(releaseNotes, /onboarding and host\/session hierarchy/);
  assert.match(releaseNotes, /loading, empty, error, retry, offline, and accessibility states/);
  assert.match(releaseNotes, /crash-safe multi-host edit, re-pair, and forget/);
  assert.match(releaseNotes, /create\/adopt sessions/);
  assert.match(releaseNotes, /observer, control, wake, and stream lifecycle/);
  assert.match(releaseNotes, /process-death resume that restores accepted work as indeterminate without replay/);
  assert.ok(releaseNotes.length <= 500, "Play internal release notes must remain within the locale limit");
  assert.match(releaseProperties, /^versionCode=6$/m);
  assert.match(releaseProperties, /^versionName=0\.3\.0-internal\.6$/m);
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
  assert.match(script, /source "\$repo_root\/android\/build-logic\/emulator-adb-readiness\.sh"/);
  assert.match(script, /source "\$repo_root\/android\/build-logic\/emulator-avd-boot-profile\.sh"/);
  assert.match(script, /source "\$repo_root\/android\/build-logic\/emulator-ui-health\.sh"/);
  assert.match(script, /source "\$repo_root\/android\/build-logic\/isolated-adb-server\.sh"/);
  assert.match(script, /create_bounded_api36_test_avd pi-droid-release/);
  assert.match(script, /select-emulator-port-pair\.py/);
  assert.match(script, /start_isolated_adb_server/);
  assert.match(script, /wait_for_emulator_adb[^]*240/);
  assert.match(script, /emulator_serial="127\.0\.0\.1:\$emulator_adb_port"/);
  assert.match(script, /initialize_emulator_ui_health/);
  assert.match(script, /probe_emulator_ui_health/);
  assert.match(script, /check_emulator_ui_health/);
  assert.match(script, /system-ui-health\.log/);
  assert.match(script, /-delay-adb/);
  assert.doesNotMatch(script, /range\(5600, 5683/);
  assert.doesNotMatch(script, /adb[^\n]*wait-for-device/);
  assert.doesNotMatch(script, /echo\s+.*(?:PASSWORD|SERVICE_ACCOUNT|KEYSTORE)/i);
});

test("manual release workflow is isolated from ordinary CI and retains exact evidence", async () => {
  const [workflow, fastWorkflow] = await Promise.all([
    source(".github/workflows/android-internal.yml"),
    source(".github/workflows/android-fast.yml"),
  ]);

  const nix = workflow.indexOf("cachix/install-nix-action@v31");
  const credential = workflow.indexOf("name: Verify Play credential-file preflight");
  const java = workflow.indexOf("name: Expose pinned Java to Gradle action");
  const gradle = workflow.indexOf("gradle/actions/setup-gradle@v5");
  assert.ok(nix >= 0 && nix < credential && credential < java && java < gradle);

  assert.match(workflow, /PI_DROID_SOPS_AGE_KEY_FILE: \$\{\{ secrets\.PI_DROID_SOPS_AGE_KEY_FILE \}\}/);
  assert.match(
    workflow,
    /PI_DROID_SOPS_SSH_PRIVATE_KEY_FILE: \$\{\{ secrets\.PI_DROID_SOPS_SSH_PRIVATE_KEY_FILE \}\}/,
  );
  const credentialPreflight = workflow.slice(credential, java);
  assert.match(credentialPreflight, /credential_file=''/);
  assert.match(credentialPreflight, /-n "\$\{PI_DROID_SOPS_AGE_KEY_FILE:-\}"/);
  assert.match(credentialPreflight, /credential_file="\$PI_DROID_SOPS_AGE_KEY_FILE"/);
  assert.match(credentialPreflight, /-n "\$\{PI_DROID_SOPS_SSH_PRIVATE_KEY_FILE:-\}"/);
  assert.match(credentialPreflight, /credential_file="\$PI_DROID_SOPS_SSH_PRIVATE_KEY_FILE"/);
  assert.match(credentialPreflight, /! -f "\$credential_file"/);
  assert.match(credentialPreflight, /! -r "\$credential_file"/);
  assert.doesNotMatch(
    credentialPreflight,
    /(?:echo|printf)[^\n]*\$(?:credential_file|PI_DROID_SOPS_[A-Z_]+)/,
  );

  const exposeJava = workflow.slice(java, gradle);
  assert.match(exposeJava, /shell: nix develop \.#androidRelease --command bash -euo pipefail \{0\}/);
  assert.match(exposeJava, /gradle_user_home="\$RUNNER_TEMP\/gradle-user-home"/);
  assert.match(exposeJava, /printf "JAVA_HOME=%s\\n" "\$JAVA_HOME" >> "\$GITHUB_ENV"/);
  assert.match(exposeJava, /printf "GRADLE_USER_HOME=%s\\n" "\$gradle_user_home" >> "\$GITHUB_ENV"/);
  assert.match(exposeJava, /dirname "\$\(command -v java\)" >> "\$GITHUB_PATH"/);
  assert.doesNotMatch(workflow, /actions\/setup-java/);

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
