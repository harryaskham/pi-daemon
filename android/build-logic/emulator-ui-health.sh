#!/usr/bin/env bash
# Shared fail-closed emulator UI health guard for the physical proof harnesses.
# The sourcing harness provides isolated_adb_command and emulator_device_serial.

initialize_emulator_ui_health() {
  local private_root="${1:-}"
  local artifacts_root="${2:-}"
  if [[ -z "$private_root" || -z "$artifacts_root" || ! -d "$private_root" || ! -d "$artifacts_root" ]]; then
    return 64
  fi
  emulator_ui_health_private_dir="$private_root/emulator-ui-health"
  emulator_ui_health_artifacts_dir="$artifacts_root/system-ui-evidence"
  emulator_ui_health_diagnostics="$artifacts_root/system-ui-health.log"
  emulator_system_ui_wait_used='false'
  emulator_system_ui_occurrences=0
  mkdir -p "$emulator_ui_health_private_dir"
  chmod 700 "$emulator_ui_health_private_dir"
  : > "$emulator_ui_health_diagnostics"
  chmod 600 "$emulator_ui_health_diagnostics"
  printf '%s\n' 'status=initialized system_ui_wait_limit=1 recovery_attempt_limit=15 logcat_byte_limit=1048576' \
    >> "$emulator_ui_health_diagnostics"
}

emulator_ui_adb() {
  timeout 10 "${isolated_adb_command[@]}" -s "$emulator_device_serial" "$@"
}

dump_emulator_ui_window() {
  local destination="$1"
  emulator_ui_adb shell uiautomator dump /sdcard/pi-droid-window.xml >/dev/null 2>&1 || true
  emulator_ui_adb exec-out cat /sdcard/pi-droid-window.xml > "$destination" 2>/dev/null
}

capture_emulator_ui_logcat() {
  local destination="$1"
  local adb_status=0
  local head_status=0
  local pipeline_status=()
  set +e
  timeout 10 "${isolated_adb_command[@]}" -s "$emulator_device_serial" \
    logcat -d -v threadtime -t 4096 2>/dev/null | \
    LC_ALL=C head -c 1048576 > "$destination"
  pipeline_status=("${PIPESTATUS[@]}")
  adb_status="${pipeline_status[0]}"
  head_status="${pipeline_status[1]}"
  set -e
  (( head_status == 0 && (adb_status == 0 || adb_status == 141) ))
}

capture_emulator_ui_screenshot() {
  local destination="$1"
  emulator_ui_adb exec-out screencap -p > "$destination" 2>/dev/null
}

classify_emulator_ui_health() {
  local xml="$1"
  local logcat="$2"
  python3 "$repo_root/android/build-logic/emulator-ui-health.py" "$xml" "$logcat"
}

emulator_system_ui_ready() {
  local process_ids=''
  local statusbar=''
  process_ids="$(emulator_ui_adb shell pidof com.android.systemui 2>/dev/null | tr -d '\r')" || return 1
  [[ "$process_ids" =~ ^[0-9]+([[:space:]][0-9]+)*$ ]] || return 1
  statusbar="$(emulator_ui_adb shell service check statusbar 2>/dev/null | tr -d '\r')" || return 1
  [[ "$statusbar" == 'Service statusbar: found' ]]
}

record_emulator_ui_health_failure() {
  local status="$1"
  local phase="$2"
  printf 'status=%s phase=%s wait_used=%s occurrences=%s\n' \
    "$status" "$phase" "$emulator_system_ui_wait_used" "$emulator_system_ui_occurrences" \
    >> "$emulator_ui_health_diagnostics"
  printf '%s\n' "$status" >&2
}

capture_system_ui_anr_evidence() {
  local xml="$1"
  local logcat="$2"
  local occurrence="$3"
  local evidence_dir="$emulator_ui_health_artifacts_dir/occurrence-$occurrence"
  local screenshot="$evidence_dir/screenshot.png"
  local copied_xml="$evidence_dir/window.xml"
  local evidence="$evidence_dir/evidence.txt"
  local xml_sha256=''
  local screenshot_sha256=''
  local logcat_sha256=''
  mkdir -p "$evidence_dir"
  chmod 700 "$emulator_ui_health_artifacts_dir" "$evidence_dir"
  cp "$xml" "$copied_xml" || return 1
  capture_emulator_ui_screenshot "$screenshot" || return 1
  [[ -s "$copied_xml" && -s "$screenshot" && -s "$logcat" ]] || return 1
  xml_sha256="$(sha256sum "$copied_xml" | cut -d ' ' -f 1)"
  screenshot_sha256="$(sha256sum "$screenshot" | cut -d ' ' -f 1)"
  logcat_sha256="$(sha256sum "$logcat" | cut -d ' ' -f 1)"
  [[ "$xml_sha256" =~ ^[0-9a-f]{64}$ ]] || return 1
  [[ "$screenshot_sha256" =~ ^[0-9a-f]{64}$ ]] || return 1
  [[ "$logcat_sha256" =~ ^[0-9a-f]{64}$ ]] || return 1
  {
    printf '%s\n' 'status=system_ui_anr'
    printf 'occurrence=%s\n' "$occurrence"
    printf 'xml_sha256=sha256:%s\n' "$xml_sha256"
    printf 'screenshot_sha256=sha256:%s\n' "$screenshot_sha256"
    printf 'safe_logcat_sha256=sha256:%s\n' "$logcat_sha256"
  } > "$evidence"
  chmod 600 "$copied_xml" "$screenshot" "$evidence"
  printf 'status=evidence_captured occurrence=%s wait_used=%s xml_sha256=sha256:%s screenshot_sha256=sha256:%s safe_logcat_sha256=sha256:%s\n' \
    "$occurrence" "$emulator_system_ui_wait_used" "$xml_sha256" "$screenshot_sha256" "$logcat_sha256" \
    >> "$emulator_ui_health_diagnostics"
}

scan_emulator_ui_health() {
  local xml="$1"
  local logcat="$emulator_ui_health_private_dir/logcat.txt"
  local classification=''
  : > "$logcat"
  if ! capture_emulator_ui_logcat "$logcat"; then
    printf '%s\n' 'system_ui_unhealthy'
    return 0
  fi
  classification="$(classify_emulator_ui_health "$xml" "$logcat" 2>/dev/null || printf '%s\n' 'ui_unavailable')"
  case "$classification" in
    healthy|ui_unavailable|pidroid_app_failure|other_app_failure_modal)
      printf '%s\n' "$classification"
      ;;
    system_ui_anr\ [0-9]*\ [0-9]*)
      printf '%s\n' "$classification"
      ;;
    *)
      printf '%s\n' 'system_ui_unhealthy'
      ;;
  esac
}

recover_system_ui_anr() {
  local initial_xml="$1"
  local wait_x="$2"
  local wait_y="$3"
  local recovery_xml="$emulator_ui_health_private_dir/recovery-window.xml"
  local classification=''
  local state=''
  local x=''
  local y=''
  local saw_clear='false'
  local attempt=0

  if [[ "$emulator_system_ui_wait_used" == 'true' ]]; then
    record_emulator_ui_health_failure system_ui_unhealthy recurrence
    return 1
  fi
  emulator_system_ui_wait_used='true'
  printf 'status=wait_selected occurrence=%s wait_count=1 recovery_attempt_limit=15\n' \
    "$emulator_system_ui_occurrences" >> "$emulator_ui_health_diagnostics"
  if ! emulator_ui_adb shell input tap "$wait_x" "$wait_y" >/dev/null 2>&1; then
    record_emulator_ui_health_failure system_ui_unhealthy wait_input_failed
    return 1
  fi

  while (( attempt < 15 )); do
    attempt=$((attempt + 1))
    sleep 1
    : > "$recovery_xml"
    dump_emulator_ui_window "$recovery_xml" || true
    classification="$(scan_emulator_ui_health "$recovery_xml")"
    read -r state x y <<< "$classification"
    case "$state" in
      pidroid_app_failure)
        record_emulator_ui_health_failure pidroid_app_failure recovery
        return 1
        ;;
      other_app_failure_modal)
        record_emulator_ui_health_failure app_failure_modal recovery
        return 1
        ;;
      system_ui_unhealthy)
        record_emulator_ui_health_failure system_ui_unhealthy recovery_scan
        return 1
        ;;
      system_ui_anr)
        if [[ "$saw_clear" == 'true' ]]; then
          emulator_system_ui_occurrences=$((emulator_system_ui_occurrences + 1))
          capture_system_ui_anr_evidence \
            "$recovery_xml" "$emulator_ui_health_private_dir/logcat.txt" "$emulator_system_ui_occurrences" || true
          record_emulator_ui_health_failure system_ui_unhealthy recurrence
          return 1
        fi
        ;;
      healthy)
        saw_clear='true'
        if emulator_system_ui_ready; then
          printf 'status=recovered occurrence=%s wait_count=1 attempts=%s modal_cleared=true process_ready=true statusbar_ready=true\n' \
            "$emulator_system_ui_occurrences" "$attempt" >> "$emulator_ui_health_diagnostics"
          return 0
        fi
        ;;
      ui_unavailable)
        ;;
      *)
        record_emulator_ui_health_failure system_ui_unhealthy recovery_classification
        return 1
        ;;
    esac
  done
  record_emulator_ui_health_failure system_ui_unhealthy recovery_deadline
  return 1
}

check_emulator_ui_health() {
  local xml="$1"
  local classification=''
  local state=''
  local wait_x=''
  local wait_y=''
  classification="$(scan_emulator_ui_health "$xml")"
  read -r state wait_x wait_y <<< "$classification"
  case "$state" in
    healthy|ui_unavailable)
      return 0
      ;;
    pidroid_app_failure)
      record_emulator_ui_health_failure pidroid_app_failure ui_wait
      return 1
      ;;
    other_app_failure_modal)
      record_emulator_ui_health_failure app_failure_modal ui_wait
      return 1
      ;;
    system_ui_unhealthy)
      record_emulator_ui_health_failure system_ui_unhealthy health_scan
      return 1
      ;;
    system_ui_anr)
      emulator_system_ui_occurrences=$((emulator_system_ui_occurrences + 1))
      if ! capture_system_ui_anr_evidence \
        "$xml" "$emulator_ui_health_private_dir/logcat.txt" "$emulator_system_ui_occurrences"; then
        record_emulator_ui_health_failure system_ui_unhealthy evidence_capture
        return 1
      fi
      recover_system_ui_anr "$xml" "$wait_x" "$wait_y"
      ;;
    *)
      record_emulator_ui_health_failure system_ui_unhealthy classification
      return 1
      ;;
  esac
}

probe_emulator_ui_health() {
  local xml="$emulator_ui_health_private_dir/probe-window.xml"
  : > "$xml"
  dump_emulator_ui_window "$xml" || true
  check_emulator_ui_health "$xml"
}
