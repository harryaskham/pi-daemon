#!/usr/bin/env bash

# Load the one reviewed image/profile contract shared by the Nix closure,
# diagnostic runner, physical proofs, and release capture. The pinned nixpkgs
# catalog has no API 36 aosp_atd/google_atd image, so this selects its minimal
# AOSP `default` image. Pi Droid has no Google APIs, Play Services, or Play Store
# runtime dependency (enforced by the focused source contract).
emulator_system_image_contract="$repo_root/android/build-logic/emulator-system-image.json"
emulator_system_image_fields="$({
  python3 "$repo_root/android/build-logic/emulator-avd-boot-profile.py" \
    --print-contract "$emulator_system_image_contract"
} 2>/dev/null)" || return 70
IFS=$'\t' read -r \
  emulator_system_image_package \
  emulator_system_image_directory \
  emulator_system_image_type \
  emulator_device_profile \
  emulator_api_level \
  emulator_abi \
  emulator_system_image_extra <<< "$emulator_system_image_fields"
if [[ -n "${emulator_system_image_extra:-}" || -z "$emulator_system_image_package" ]]; then
  return 70
fi

# Create the exact fresh API 36 AOSP x86_64 AVD used by every emulator harness.
# The explicit phone profile is a boot contract: avdmanager's profile-less
# fallback has a 32 MiB VM heap, which is too small for API 36 system_server to
# register ActivityManager reliably.
create_bounded_api36_test_avd() {
  local avd_name="$1"
  local diagnostics_file="$2"
  local config_file=''

  if [[ ! "$avd_name" =~ ^[a-z0-9-]{1,64}$ || -z "${ANDROID_AVD_HOME:-}" ||
        ! -f "$diagnostics_file" || -L "$diagnostics_file" ]]; then
    return 64
  fi
  if ! printf 'no\n' | avdmanager create avd --force \
    --name "$avd_name" \
    --device "$emulator_device_profile" \
    --package "$emulator_system_image_package" >/dev/null 2>&1; then
    printf '%s\n' 'phase=avd_boot_profile status=create_failed' >> "$diagnostics_file"
    return 70
  fi

  config_file="$ANDROID_AVD_HOME/$avd_name.avd/config.ini"
  if ! python3 "$repo_root/android/build-logic/emulator-avd-boot-profile.py" \
    "$config_file" "$emulator_system_image_contract" >> "$diagnostics_file" 2>/dev/null; then
    printf '%s\n' 'phase=avd_boot_profile status=invalid' >> "$diagnostics_file"
    return 70
  fi
}
