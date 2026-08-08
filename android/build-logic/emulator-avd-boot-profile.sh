#!/usr/bin/env bash

# Create the exact fresh API 36 Google APIs x86_64 AVD used by the diagnostic
# and physical proof harnesses. The explicit phone profile is a boot contract:
# avdmanager's profile-less fallback has a 32 MiB VM heap, which is too small
# for API 36 system_server to register ActivityManager reliably.

create_api36_google_apis_x86_64_avd() {
  local avd_name="$1"
  local diagnostics_file="$2"
  local config_file=''

  if [[ ! "$avd_name" =~ ^[a-z0-9-]{1,64}$ || -z "${ANDROID_AVD_HOME:-}" ||
        ! -f "$diagnostics_file" || -L "$diagnostics_file" ]]; then
    return 64
  fi
  if ! printf 'no\n' | avdmanager create avd --force \
    --name "$avd_name" \
    --device medium_phone \
    --package 'system-images;android-36;google_apis;x86_64' >/dev/null 2>&1; then
    printf '%s\n' 'phase=avd_boot_profile status=create_failed' >> "$diagnostics_file"
    return 70
  fi

  config_file="$ANDROID_AVD_HOME/$avd_name.avd/config.ini"
  if ! python3 "$repo_root/android/build-logic/emulator-avd-boot-profile.py" \
    "$config_file" >> "$diagnostics_file" 2>/dev/null; then
    printf '%s\n' 'phase=avd_boot_profile status=invalid' >> "$diagnostics_file"
    return 70
  fi
}
