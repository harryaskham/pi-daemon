#!/usr/bin/env bash
set -euo pipefail
umask 077

EXPECTED_PACKAGE='com.harryaskham.pidroid'
EXPECTED_TRACK='internal'
EXPECTED_CERT_SHA256='FA:58:80:A7:C9:6D:F8:7B:B4:63:7D:18:58:7E:32:F6:CD:F6:95:06:52:34:FE:54:95:E2:4F:ED:12:1E:CE:4C'

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$repo_root/android/build-logic/emulator-adb-readiness.sh"
source "$repo_root/android/build-logic/emulator-avd-boot-profile.sh"
source "$repo_root/android/build-logic/emulator-ui-health.sh"
source "$repo_root/android/build-logic/isolated-adb-server.sh"
version_code=''
version_name=''
artifacts_dir=''
prepare_only='false'
upload_prepared='false'

usage() {
  printf '%s\n' 'usage: release-internal.sh --version-code N --version-name NAME --artifacts DIR [--prepare-only|--upload-prepared]' >&2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version-code)
      version_code="${2:-}"
      shift 2
      ;;
    --version-name)
      version_name="${2:-}"
      shift 2
      ;;
    --artifacts)
      artifacts_dir="${2:-}"
      shift 2
      ;;
    --prepare-only)
      prepare_only='true'
      shift
      ;;
    --upload-prepared)
      upload_prepared='true'
      shift
      ;;
    *)
      usage
      exit 64
      ;;
  esac
done

if [[ "$prepare_only" == 'true' && "$upload_prepared" == 'true' ]]; then
  printf '%s\n' 'prepare-only and upload-prepared are mutually exclusive' >&2
  exit 64
fi
if [[ ! "$version_code" =~ ^[1-9][0-9]*$ ]]; then
  printf '%s\n' 'version code must be a positive integer' >&2
  exit 64
fi
if [[ ! "$version_name" =~ ^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$ ]]; then
  printf '%s\n' 'version name must be a bounded release identifier' >&2
  exit 64
fi
if [[ -z "$artifacts_dir" ]]; then
  usage
  exit 64
fi
artifacts_dir="$(mkdir -p "$artifacts_dir" && cd "$artifacts_dir" && pwd)"
chmod 700 "$artifacts_dir"
mkdir -p "$artifacts_dir/screenshots"

private_dir="$(mktemp -d)"
chmod 700 "$private_dir"
emulator_pid=''
emulator_serial=''
emulator_port=''
emulator_adb_port=''
emulator_port_attempts=''
adb_server_port=''
adb_server_port_attempts=''
adb_server_pid=''
adb_server_started='false'
adb_key_home=''
adb_public_key_payload_sha256=''
declare -a isolated_adb_command=()
cleanup() {
  if [[ -n "$emulator_serial" && "${#isolated_adb_command[@]}" -gt 0 ]]; then
    "${isolated_adb_command[@]}" -s "$emulator_serial" emu kill >/dev/null 2>&1 || true
  fi
  if [[ -n "$emulator_pid" ]] && kill -0 "$emulator_pid" 2>/dev/null; then
    kill "$emulator_pid" 2>/dev/null || true
    wait "$emulator_pid" 2>/dev/null || true
  fi
  stop_isolated_adb_server
  rm -rf "$private_dir"
}
trap 'cleanup' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

require_private_file() {
  local name="$1"
  local path="$2"
  if [[ ! -f "$path" || ! -r "$path" ]]; then
    printf '%s must name a readable file\n' "$name" >&2
    exit 66
  fi
  local mode owner
  mode="$(stat -Lc '%a' "$path")"
  owner="$(stat -Lc '%u' "$path")"
  if (( 8#$mode & 077 )); then
    printf '%s must not be group/world accessible\n' "$name" >&2
    exit 77
  fi
  if [[ "$owner" != "$(id -u)" ]]; then
    printf '%s must be owned by the release user\n' "$name" >&2
    exit 77
  fi
}

direct_keystore_file="${PI_DROID_RELEASE_KEYSTORE:-}"
direct_alias_file="${PI_DROID_RELEASE_KEY_ALIAS_FILE:-}"
direct_store_password_file="${PI_DROID_RELEASE_STORE_PASSWORD_FILE:-}"
direct_key_password_file="${PI_DROID_RELEASE_KEY_PASSWORD_FILE:-}"
direct_service_account_file="${PI_DROID_PLAY_SERVICE_ACCOUNT_FILE:-}"
direct_secret_files=(
  "$direct_keystore_file"
  "$direct_alias_file"
  "$direct_store_password_file"
  "$direct_key_password_file"
  "$direct_service_account_file"
)
direct_secret_count=0
for direct_file in "${direct_secret_files[@]}"; do
  if [[ -n "$direct_file" ]]; then
    direct_secret_count=$((direct_secret_count + 1))
  fi
done

if (( direct_secret_count > 0 && direct_secret_count < ${#direct_secret_files[@]} )); then
  printf '%s\n' 'direct Play release files must be configured as one complete set' >&2
  exit 78
fi

if (( direct_secret_count == ${#direct_secret_files[@]} )); then
  keystore_file="$direct_keystore_file"
  alias_file="$direct_alias_file"
  store_password_file="$direct_store_password_file"
  key_password_file="$direct_key_password_file"
  service_account_file="$direct_service_account_file"
  require_private_file PI_DROID_RELEASE_KEYSTORE "$keystore_file"
  require_private_file PI_DROID_RELEASE_KEY_ALIAS_FILE "$alias_file"
  require_private_file PI_DROID_RELEASE_STORE_PASSWORD_FILE "$store_password_file"
  require_private_file PI_DROID_RELEASE_KEY_PASSWORD_FILE "$key_password_file"
  require_private_file PI_DROID_PLAY_SERVICE_ACCOUNT_FILE "$service_account_file"
else
  age_key_file="${PI_DROID_SOPS_AGE_KEY_FILE:-}"
  if [[ -n "$age_key_file" ]]; then
    require_private_file PI_DROID_SOPS_AGE_KEY_FILE "$age_key_file"
  elif [[ -n "${PI_DROID_SOPS_SSH_PRIVATE_KEY_FILE:-}" ]]; then
    require_private_file PI_DROID_SOPS_SSH_PRIVATE_KEY_FILE "$PI_DROID_SOPS_SSH_PRIVATE_KEY_FILE"
    age_key_file="$private_dir/age-identity.txt"
    ssh-to-age -private-key -i "$PI_DROID_SOPS_SSH_PRIVATE_KEY_FILE" > "$age_key_file"
    chmod 600 "$age_key_file"
  else
    printf '%s\n' 'set the complete direct Play release file set or a SOPS age/SSH identity file' >&2
    exit 78
  fi

  secret_json="$private_dir/release-secrets.json"
  SOPS_AGE_KEY_FILE="$age_key_file" \
    sops --decrypt --input-type yaml --output-type json \
    "$repo_root/secrets/android-play-upload.sops.yaml" > "$secret_json"
  chmod 600 "$secret_json"

  keystore_file="$private_dir/pi-droid-release.p12"
  alias_file="$private_dir/key-alias.txt"
  store_password_file="$private_dir/store-password.txt"
  key_password_file="$private_dir/key-password.txt"
  service_account_file="$private_dir/play-service-account.json"

  jq -er '.play_keystore_base64 | strings | select(length > 0)' "$secret_json" \
    | base64 --decode > "$keystore_file"
  jq -er '.play_key_alias | strings | select(length > 0)' "$secret_json" > "$alias_file"
  jq -er '.play_store_password | strings | select(length > 0)' "$secret_json" > "$store_password_file"
  jq -er '.play_key_password | strings | select(length > 0)' "$secret_json" > "$key_password_file"
  jq -er '.play_service_account_json | if type == "string" then . else tojson end | select(length > 0)' \
    "$secret_json" > "$service_account_file"
  chmod 600 "$keystore_file" "$alias_file" "$store_password_file" "$key_password_file" "$service_account_file"
fi

actual_cert="$({
  keytool -list -v \
    -keystore "$keystore_file" \
    -storepass:file "$store_password_file" 2>/dev/null \
    | awk '/^[[:space:]]*SHA256: / { sub(/^[[:space:]]*SHA256: /, ""); print; exit }'
} || true)"
if [[ "$actual_cert" != "$EXPECTED_CERT_SHA256" ]]; then
  printf '%s\n' 'release certificate does not match the preregistered Pi Droid certificate' >&2
  exit 65
fi
printf 'Pi Droid release certificate verified: %s\n' "$actual_cert"

export PI_DROID_RELEASE_KEYSTORE="$keystore_file"
export PI_DROID_RELEASE_KEY_ALIAS_FILE="$alias_file"
export PI_DROID_RELEASE_STORE_PASSWORD_FILE="$store_password_file"
export PI_DROID_RELEASE_KEY_PASSWORD_FILE="$key_password_file"
export PI_DROID_PLAY_SERVICE_ACCOUNT_FILE="$service_account_file"
export PI_DROID_PLAY_PACKAGE="$EXPECTED_PACKAGE"
export PI_DROID_PLAY_TRACK="$EXPECTED_TRACK"
export PI_DROID_PLAY_VERSION_CODE="$version_code"
export PI_DROID_PLAY_RECEIPT_FILE="$artifacts_dir/play-internal-receipt.json"
export ANDROID_USER_HOME="$private_dir/android-user"
export ANDROID_AVD_HOME="$private_dir/avd"
mkdir -p "$ANDROID_USER_HOME" "$ANDROID_AVD_HOME"

common_gradle_args=(
  -p "$repo_root/android"
  --no-daemon
  --no-configuration-cache
  -PpiDroidAndroidApp=true
  -PpiDroidVersionCode="$version_code"
  -PpiDroidVersionName="$version_name"
)

if [[ "$upload_prepared" == 'true' ]]; then
  release_aab="$artifacts_dir/pi-droid-release.aab"
  if [[ ! -f "$release_aab" || ! -f "$artifacts_dir/mapping.txt" || ! -f "$artifacts_dir/sha256sums.txt" ]]; then
    printf '%s\n' 'upload-prepared requires the verified AAB, mapping, and checksum receipt' >&2
    exit 66
  fi
  (
    cd "$artifacts_dir"
    sha256sum -c sha256sums.txt >/dev/null
  )
else
  "$repo_root/android/gradlew" "${common_gradle_args[@]}" :app:bundleRelease
  source_aab="$repo_root/android/app/build/outputs/bundle/release/app-release.aab"
  source_mapping="$repo_root/android/app/build/outputs/mapping/release/mapping.txt"
  if [[ ! -f "$source_aab" || ! -f "$source_mapping" ]]; then
    printf '%s\n' 'Gradle did not produce the expected release AAB and mapping' >&2
    exit 70
  fi
  cp "$source_aab" "$artifacts_dir/pi-droid-release.aab"
  cp "$source_mapping" "$artifacts_dir/mapping.txt"
  release_aab="$artifacts_dir/pi-droid-release.aab"
fi

bundletool validate --bundle="$release_aab" >/dev/null
jarsigner -verify "$release_aab" >/dev/null
bundle_manifest="$private_dir/bundle-manifest.xml"
bundletool dump manifest --bundle="$release_aab" --module=base > "$bundle_manifest"
internet_permission='false'
if grep -q 'android.permission.INTERNET' "$bundle_manifest"; then internet_permission='true'; fi
if [[ "$version_code" == '1' && "$internet_permission" != 'false' ]]; then
  printf '%s\n' 'fixture-only release version one must not request INTERNET permission' >&2
  exit 65
fi
if (( version_code >= 2 )) && [[ "$internet_permission" != 'true' ]]; then
  printf '%s\n' 'live-client release must request INTERNET permission' >&2
  exit 65
fi
bundle_package="$(bundletool dump manifest --bundle="$release_aab" --module=base --xpath=/manifest/@package)"
bundle_version_code="$(bundletool dump manifest --bundle="$release_aab" --module=base --xpath=/manifest/@android:versionCode)"
if [[ "$bundle_package" != "$EXPECTED_PACKAGE" || "$bundle_version_code" != "$version_code" ]]; then
  printf '%s\n' 'release bundle package or version code does not match the requested identity' >&2
  exit 65
fi
bundle_cert="$({
  keytool -printcert -jarfile "$release_aab" 2>/dev/null \
    | awk '/^[[:space:]]*SHA256: / { sub(/^[[:space:]]*SHA256: /, ""); print; exit }'
} || true)"
if [[ "$bundle_cert" != "$EXPECTED_CERT_SHA256" ]]; then
  printf '%s\n' 'release bundle signer does not match the preregistered certificate' >&2
  exit 65
fi
printf 'Pi Droid AAB verified: package=%s versionCode=%s track=%s\n' "$bundle_package" "$bundle_version_code" "$EXPECTED_TRACK"

if [[ "$upload_prepared" != 'true' ]]; then
  bundletool build-apks \
    --bundle="$release_aab" \
    --output="$private_dir/pi-droid.apks" \
    --mode=universal \
    --ks="$keystore_file" \
    --ks-key-alias="$(< "$alias_file")" \
    --ks-pass="file:$store_password_file" \
    --key-pass="file:$key_password_file" >/dev/null
  unzip -q "$private_dir/pi-droid.apks" universal.apk -d "$private_dir/apks"

  emulator_diagnostics="$artifacts_dir/emulator-diagnostics.log"
  : > "$emulator_diagnostics"
  if ! create_bounded_api36_test_avd pi-droid-release "$emulator_diagnostics"; then
    printf '%s\n' 'Android emulator AVD boot profile is unavailable or invalid' >&2
    exit 70
  fi
  start_isolated_adb_server \
    "$private_dir" \
    "$emulator_diagnostics" \
    "$repo_root/android/build-logic/select-adb-server-port.py"
  isolated_adb_command=(adb -H 127.0.0.1 -P "$adb_server_port")
  initialize_emulator_ui_health "$private_dir" "$artifacts_dir"
  emulator_selection=''
  emulator_selection_extra=''
  if ! emulator_selection="$(python3 "$repo_root/android/build-logic/select-emulator-port-pair.py" 2>/dev/null)"; then
    printf '%s\n' 'status=emulator_port_unavailable emulator_console_port=none emulator_adb_port=none emulator_port_attempts=16' >> "$emulator_diagnostics"
    printf '%s\n' 'emulator_port_unavailable: no supported localhost console/ADB pair is free after 16 attempts' >&2
    exit 70
  fi
  read -r emulator_port emulator_adb_port emulator_port_attempts emulator_selection_extra <<< "$emulator_selection"
  if [[ -n "$emulator_selection_extra" || ! "$emulator_port" =~ ^[0-9]+$ ||
        ! "$emulator_adb_port" =~ ^[0-9]+$ || ! "$emulator_port_attempts" =~ ^[0-9]+$ ]] ||
    (( emulator_port < 5554 || emulator_port > 5584 || emulator_port % 2 != 0 ||
       emulator_adb_port != emulator_port + 1 || emulator_port_attempts < 1 || emulator_port_attempts > 16 )); then
    printf '%s\n' 'emulator port selector returned an invalid result' >&2
    exit 70
  fi
  printf 'status=selected emulator_console_port=%s emulator_adb_port=%s emulator_port_attempts=%s verification=both_localhost_ports_free\n' \
    "$emulator_port" "$emulator_adb_port" "$emulator_port_attempts" >> "$emulator_diagnostics"
  emulator_serial="127.0.0.1:$emulator_adb_port"
  emulator_device_serial="$emulator_serial"
  emulator \
    -avd pi-droid-release \
    -port "$emulator_port" \
    -no-window \
    -noaudio \
    -no-boot-anim \
    -no-metrics \
    -no-snapshot \
    -wipe-data \
    -gpu swiftshader_indirect \
    -delay-adb \
    > "$private_dir/emulator.log" 2>&1 &
  emulator_pid="$!"

  adb_readiness_status=0
  wait_for_emulator_adb \
    "$emulator_pid" "$emulator_serial" "$adb_server_port" "$emulator_diagnostics" 240 || \
    adb_readiness_status="$?"
  if (( adb_readiness_status != 0 )); then
    if (( adb_readiness_status == 69 )); then
      wait "$emulator_pid" 2>/dev/null || true
      printf 'Android emulator exited before ADB readiness for ABI %s\n' "$emulator_abi" >&2
      tail -40 "$private_dir/emulator.log" >&2 || true
    elif (( adb_readiness_status == 70 )); then
      printf '%s\n' 'Android emulator ADB readiness timed out after 240 seconds' >&2
    else
      printf '%s\n' 'Android emulator ADB readiness gate rejected its bounded configuration' >&2
    fi
    tail -40 "$emulator_diagnostics" >&2 || true
    exit 70
  fi
  booted=''
  for _ in $(seq 1 240); do
    booted="$("${isolated_adb_command[@]}" -s "$emulator_serial" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')"
    [[ "$booted" == '1' ]] && break
    if ! kill -0 "$emulator_pid" 2>/dev/null; then
      printf '%s\n' 'Android emulator exited before boot completed' >&2
      exit 70
    fi
    sleep 1
  done
  if [[ "$booted" != '1' ]]; then
    printf '%s\n' 'Android emulator did not complete boot within 240 seconds' >&2
    exit 70
  fi
  probe_emulator_ui_health || exit 70
  "${isolated_adb_command[@]}" -s "$emulator_serial" install -r "$private_dir/apks/universal.apk" >/dev/null

capture_profile() {
  local name="$1"
  local size="$2"
  local density="$3"
  "${isolated_adb_command[@]}" -s "$emulator_serial" shell wm size "$size" >/dev/null
  "${isolated_adb_command[@]}" -s "$emulator_serial" shell wm density "$density" >/dev/null
  sleep 1
  "${isolated_adb_command[@]}" -s "$emulator_serial" shell am force-stop "$EXPECTED_PACKAGE" >/dev/null
  "${isolated_adb_command[@]}" -s "$emulator_serial" shell am start -W -n "$EXPECTED_PACKAGE/.MainActivity" >/dev/null
  local ready='false'
  local window_xml="$private_dir/pi-droid-window.xml"
  for _ in $(seq 1 60); do
    : > "$window_xml"
    dump_emulator_ui_window "$window_xml" || true
    check_emulator_ui_health "$window_xml" || exit 70
    if grep -Eq 'WORKSPACE FIXTURE|Pane Build room|Connect a trusted-tailnet Pi Daemon|Pi Daemon API URL' "$window_xml"; then
      ready='true'
      break
    fi
    sleep 1
  done
  if [[ "$ready" != 'true' ]]; then
    printf 'Pi Droid fixture did not become accessibility-ready for %s screenshot\n' "$name" >&2
    exit 70
  fi
  sleep 1
  "${isolated_adb_command[@]}" -s "$emulator_serial" exec-out screencap -p > "$artifacts_dir/screenshots/pi-droid-$name.png"
}

  capture_profile phone 1080x2400 420
  capture_profile tablet 1600x2560 240
  capture_profile wide 2208x1768 300
fi

cat > "$artifacts_dir/release-build-receipt.json" <<EOF
{
  "schemaVersion": 1,
  "status": "verified",
  "packageName": "$EXPECTED_PACKAGE",
  "track": "$EXPECTED_TRACK",
  "versionCode": $version_code,
  "versionName": "$version_name",
  "certificateSha256": "$EXPECTED_CERT_SHA256",
  "internetPermission": $internet_permission,
  "aab": "pi-droid-release.aab",
  "mapping": "mapping.txt"
}
EOF

if [[ "$prepare_only" == 'true' ]]; then
  (
    cd "$artifacts_dir"
    sha256sum \
      pi-droid-release.aab \
      mapping.txt \
      release-build-receipt.json \
      emulator-diagnostics.log \
      system-ui-health.log \
      screenshots/pi-droid-phone.png \
      screenshots/pi-droid-tablet.png \
      screenshots/pi-droid-wide.png \
      > sha256sums.txt
  )
  find "$artifacts_dir" -type d -exec chmod 700 {} +
  find "$artifacts_dir" -type f -exec chmod 600 {} +
  printf 'Pi Droid signed internal release prepared: package=%s versionCode=%s artifacts=%s\n' \
    "$EXPECTED_PACKAGE" "$version_code" "$artifacts_dir"
  exit 0
fi

"$repo_root/android/gradlew" "${common_gradle_args[@]}" :app:publishReleaseBundle
"$repo_root/android/gradlew" "${common_gradle_args[@]}" :play-receipt:verifyInternalTrackReceipt

(
  cd "$artifacts_dir"
  sha256sum \
    pi-droid-release.aab \
    mapping.txt \
    play-internal-receipt.json \
    release-build-receipt.json \
    emulator-diagnostics.log \
    system-ui-health.log \
    screenshots/pi-droid-phone.png \
    screenshots/pi-droid-tablet.png \
    screenshots/pi-droid-wide.png \
    > sha256sums.txt
)
find "$artifacts_dir" -type d -exec chmod 700 {} +
find "$artifacts_dir" -type f -exec chmod 600 {} +
printf 'Pi Droid Play internal release complete: package=%s versionCode=%s artifacts=%s\n' \
  "$EXPECTED_PACKAGE" "$version_code" "$artifacts_dir"
