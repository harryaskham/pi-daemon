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
  emulator_app_failure_artifacts_dir="$artifacts_root/app-failure-evidence"
  emulator_ui_health_diagnostics="$artifacts_root/system-ui-health.log"
  emulator_system_ui_wait_used='false'
  emulator_system_ui_occurrences=0
  emulator_app_failure_occurrences=0
  mkdir -p "$emulator_ui_health_private_dir"
  chmod 700 "$emulator_ui_health_private_dir"
  : > "$emulator_ui_health_diagnostics"
  chmod 600 "$emulator_ui_health_diagnostics"
  printf '%s\n' 'status=initialized system_ui_wait_limit=1 recovery_attempt_limit=15 logcat_byte_limit=1048576 anr_event_byte_limit=1048576 app_failure_xml_byte_limit=16384 app_failure_logcat_byte_limit=4096 app_failure_screenshot_byte_limit=16777216' \
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

capture_emulator_ui_anr_events() {
  local destination="$1"
  local adb_status=0
  local head_status=0
  local pipeline_status=()
  set +e
  timeout 10 "${isolated_adb_command[@]}" -s "$emulator_device_serial" \
    logcat -b events -d -v threadtime 'am_anr:I' '*:S' 2>/dev/null | \
    LC_ALL=C head -c 1048576 > "$destination"
  pipeline_status=("${PIPESTATUS[@]}")
  adb_status="${pipeline_status[0]}"
  head_status="${pipeline_status[1]}"
  set -e
  (( head_status == 0 && (adb_status == 0 || adb_status == 141) ))
}

capture_emulator_ui_screenshot() {
  local destination="$1"
  local adb_status=0
  local head_status=0
  local pipeline_status=()
  set +e
  emulator_ui_adb exec-out screencap -p 2>/dev/null | \
    LC_ALL=C head -c 16777217 > "$destination"
  pipeline_status=("${PIPESTATUS[@]}")
  adb_status="${pipeline_status[0]}"
  head_status="${pipeline_status[1]}"
  set -e
  (( head_status == 0 && (adb_status == 0 || adb_status == 141) ))
}

classify_emulator_ui_health() {
  local xml="$1"
  local logcat="$2"
  local anr_events="$3"
  python3 "$repo_root/android/build-logic/emulator-ui-health.py" \
    "$xml" "$logcat" --system-anr-events "$anr_events"
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
  printf 'status=%s phase=%s wait_used=%s occurrences=%s app_failure_occurrences=%s\n' \
    "$status" "$phase" "$emulator_system_ui_wait_used" "$emulator_system_ui_occurrences" \
    "$emulator_app_failure_occurrences" >> "$emulator_ui_health_diagnostics"
  printf '%s\n' "$status" >&2
}

emit_bounded_app_failure_evidence_file() {
  local label="$1"
  local file="$2"
  local byte_limit="$3"
  local bytes=''
  local digest=''
  local status='unavailable'
  if [[ -f "$file" && ! -L "$file" ]]; then
    if ! bytes="$(wc -c < "$file" 2>/dev/null | tr -d ' ')" || [[ ! "$bytes" =~ ^[0-9]+$ ]]; then
      status='discarded_size_unavailable'
      rm -f -- "$file"
    elif (( bytes == 0 )); then
      status='discarded_empty'
      rm -f -- "$file"
    elif (( bytes > byte_limit )); then
      status='discarded_size_limit'
      rm -f -- "$file"
    elif ! digest="$(sha256sum "$file" 2>/dev/null | cut -d ' ' -f 1)" || [[ ! "$digest" =~ ^[0-9a-f]{64}$ ]]; then
      status='discarded_hash_unavailable'
      rm -f -- "$file"
    elif chmod 600 "$file"; then
      status='retained'
    else
      status='discarded_permission_failure'
      rm -f -- "$file"
    fi
  else
    rm -f -- "$file"
  fi
  printf '%s_status=%s\n' "$label" "$status"
  if [[ "$status" == 'retained' ]]; then
    printf '%s_bytes=%s\n' "$label" "$bytes"
    printf '%s_sha256=sha256:%s\n' "$label" "$digest"
  fi
}

retain_incomplete_app_failure_evidence() {
  local predicate="$1"
  local occurrence="$2"
  local identity_source_field="$3"
  local identity_class_field="$4"
  local identity_sha256_field="$5"
  local evidence_dir="$6"
  local safe_xml="$7"
  local screenshot="$8"
  local safe_logcat="$9"
  local evidence="${10}"
  if [[ ! "$predicate" =~ ^(normalization|classification_mismatch|normalized_xml_missing|normalized_logcat_missing|screenshot_capture|screenshot_missing|content_size_unavailable|normalized_xml_size_limit|screenshot_size_limit|normalized_logcat_size_limit|content_hash)$ ]]; then
    predicate='internal_contract'
  fi
  {
    printf '%s\n' 'status=app_failure_evidence_incomplete'
    printf 'occurrence=%s\n' "$occurrence"
    printf 'capture_predicate=%s\n' "$predicate"
    printf '%s\n' "$identity_source_field" "$identity_class_field" "$identity_sha256_field"
    emit_bounded_app_failure_evidence_file normalized_xml "$safe_xml" 16384
    emit_bounded_app_failure_evidence_file screenshot "$screenshot" 16777216
    emit_bounded_app_failure_evidence_file safe_logcat "$safe_logcat" 4096
  } > "$evidence" || {
    rm -rf -- "$evidence_dir"
    return 1
  }
  if ! chmod 600 "$evidence"; then
    rm -rf -- "$evidence_dir"
    return 1
  fi
  printf 'status=app_failure_evidence_incomplete occurrence=%s capture_predicate=%s %s %s %s\n' \
    "$occurrence" "$predicate" "$identity_source_field" "$identity_class_field" \
    "$identity_sha256_field" >> "$emulator_ui_health_diagnostics"
}

capture_system_ui_anr_evidence() {
  local xml="$1"
  local logcat="$2"
  local anr_events="$3"
  local occurrence="$4"
  local evidence_dir="$emulator_ui_health_artifacts_dir/occurrence-$occurrence"
  local screenshot="$evidence_dir/screenshot.png"
  local copied_xml="$evidence_dir/window.xml"
  local evidence="$evidence_dir/evidence.txt"
  local xml_sha256=''
  local screenshot_sha256=''
  local logcat_sha256=''
  local anr_events_sha256=''
  mkdir -p "$evidence_dir"
  chmod 700 "$emulator_ui_health_artifacts_dir" "$evidence_dir"
  cp "$xml" "$copied_xml" || return 1
  capture_emulator_ui_screenshot "$screenshot" || return 1
  [[ -s "$copied_xml" && -s "$screenshot" && -f "$logcat" && -f "$anr_events" ]] || return 1
  xml_sha256="$(sha256sum "$copied_xml" | cut -d ' ' -f 1)"
  screenshot_sha256="$(sha256sum "$screenshot" | cut -d ' ' -f 1)"
  logcat_sha256="$(sha256sum "$logcat" | cut -d ' ' -f 1)"
  anr_events_sha256="$(sha256sum "$anr_events" | cut -d ' ' -f 1)"
  [[ "$xml_sha256" =~ ^[0-9a-f]{64}$ ]] || return 1
  [[ "$screenshot_sha256" =~ ^[0-9a-f]{64}$ ]] || return 1
  [[ "$logcat_sha256" =~ ^[0-9a-f]{64}$ ]] || return 1
  [[ "$anr_events_sha256" =~ ^[0-9a-f]{64}$ ]] || return 1
  {
    printf '%s\n' 'status=system_ui_anr'
    printf 'occurrence=%s\n' "$occurrence"
    printf 'xml_sha256=sha256:%s\n' "$xml_sha256"
    printf 'screenshot_sha256=sha256:%s\n' "$screenshot_sha256"
    printf 'safe_logcat_sha256=sha256:%s\n' "$logcat_sha256"
    printf 'anr_events_sha256=sha256:%s\n' "$anr_events_sha256"
  } > "$evidence"
  chmod 600 "$copied_xml" "$screenshot" "$evidence"
  printf 'status=evidence_captured occurrence=%s wait_used=%s xml_sha256=sha256:%s screenshot_sha256=sha256:%s safe_logcat_sha256=sha256:%s anr_events_sha256=sha256:%s\n' \
    "$occurrence" "$emulator_system_ui_wait_used" "$xml_sha256" "$screenshot_sha256" "$logcat_sha256" \
    "$anr_events_sha256" >> "$emulator_ui_health_diagnostics"
}

capture_app_failure_modal_evidence() {
  local xml="$1"
  local logcat="$2"
  local occurrence="$3"
  local identity_source_field="$4"
  local identity_class_field="$5"
  local identity_sha256_field="$6"
  local evidence_dir="$emulator_app_failure_artifacts_dir/occurrence-$occurrence"
  local screenshot="$evidence_dir/screenshot.png"
  local safe_xml="$evidence_dir/window.xml"
  local safe_logcat="$evidence_dir/safe-logcat.txt"
  local evidence="$evidence_dir/evidence.txt"
  local safe_classification=''
  local xml_bytes=''
  local screenshot_bytes=''
  local logcat_bytes=''
  local xml_sha256=''
  local screenshot_sha256=''
  local safe_logcat_sha256=''
  [[ "$identity_source_field" =~ ^identity_source=(logcat_package|dialog_title)$ ]] || return 1
  [[ "$identity_class_field" =~ ^identity_class=(android_system|google_system|third_party|unknown)$ ]] || return 1
  [[ "$identity_sha256_field" =~ ^identity_sha256=sha256:[0-9a-f]{64}$ ]] || return 1
  mkdir -p "$evidence_dir"
  chmod 700 "$emulator_app_failure_artifacts_dir" "$evidence_dir"
  if ! safe_classification="$(python3 "$repo_root/android/build-logic/emulator-ui-health.py" \
    "$xml" "$logcat" --write-app-failure-evidence "$safe_xml" "$safe_logcat" 2>/dev/null)"; then
    retain_incomplete_app_failure_evidence normalization "$occurrence" \
      "$identity_source_field" "$identity_class_field" "$identity_sha256_field" \
      "$evidence_dir" "$safe_xml" "$screenshot" "$safe_logcat" "$evidence" || true
    return 1
  fi
  if [[ "$safe_classification" != "other_app_failure_modal $identity_source_field $identity_class_field $identity_sha256_field" ]]; then
    retain_incomplete_app_failure_evidence classification_mismatch "$occurrence" \
      "$identity_source_field" "$identity_class_field" "$identity_sha256_field" \
      "$evidence_dir" "$safe_xml" "$screenshot" "$safe_logcat" "$evidence" || true
    return 1
  fi
  if [[ ! -s "$safe_xml" ]]; then
    retain_incomplete_app_failure_evidence normalized_xml_missing "$occurrence" \
      "$identity_source_field" "$identity_class_field" "$identity_sha256_field" \
      "$evidence_dir" "$safe_xml" "$screenshot" "$safe_logcat" "$evidence" || true
    return 1
  fi
  if [[ ! -s "$safe_logcat" ]]; then
    retain_incomplete_app_failure_evidence normalized_logcat_missing "$occurrence" \
      "$identity_source_field" "$identity_class_field" "$identity_sha256_field" \
      "$evidence_dir" "$safe_xml" "$screenshot" "$safe_logcat" "$evidence" || true
    return 1
  fi
  if ! capture_emulator_ui_screenshot "$screenshot"; then
    rm -f -- "$screenshot"
    retain_incomplete_app_failure_evidence screenshot_capture "$occurrence" \
      "$identity_source_field" "$identity_class_field" "$identity_sha256_field" \
      "$evidence_dir" "$safe_xml" "$screenshot" "$safe_logcat" "$evidence" || true
    return 1
  fi
  if [[ ! -s "$screenshot" ]]; then
    retain_incomplete_app_failure_evidence screenshot_missing "$occurrence" \
      "$identity_source_field" "$identity_class_field" "$identity_sha256_field" \
      "$evidence_dir" "$safe_xml" "$screenshot" "$safe_logcat" "$evidence" || true
    return 1
  fi
  if ! xml_bytes="$(wc -c < "$safe_xml" 2>/dev/null | tr -d ' ')" ||
    ! screenshot_bytes="$(wc -c < "$screenshot" 2>/dev/null | tr -d ' ')" ||
    ! logcat_bytes="$(wc -c < "$safe_logcat" 2>/dev/null | tr -d ' ')" ||
    [[ ! "$xml_bytes" =~ ^[0-9]+$ || ! "$screenshot_bytes" =~ ^[0-9]+$ || ! "$logcat_bytes" =~ ^[0-9]+$ ]]; then
    retain_incomplete_app_failure_evidence content_size_unavailable "$occurrence" \
      "$identity_source_field" "$identity_class_field" "$identity_sha256_field" \
      "$evidence_dir" "$safe_xml" "$screenshot" "$safe_logcat" "$evidence" || true
    return 1
  fi
  if (( xml_bytes > 16384 )); then
    retain_incomplete_app_failure_evidence normalized_xml_size_limit "$occurrence" \
      "$identity_source_field" "$identity_class_field" "$identity_sha256_field" \
      "$evidence_dir" "$safe_xml" "$screenshot" "$safe_logcat" "$evidence" || true
    return 1
  fi
  if (( screenshot_bytes > 16777216 )); then
    retain_incomplete_app_failure_evidence screenshot_size_limit "$occurrence" \
      "$identity_source_field" "$identity_class_field" "$identity_sha256_field" \
      "$evidence_dir" "$safe_xml" "$screenshot" "$safe_logcat" "$evidence" || true
    return 1
  fi
  if (( logcat_bytes > 4096 )); then
    retain_incomplete_app_failure_evidence normalized_logcat_size_limit "$occurrence" \
      "$identity_source_field" "$identity_class_field" "$identity_sha256_field" \
      "$evidence_dir" "$safe_xml" "$screenshot" "$safe_logcat" "$evidence" || true
    return 1
  fi
  if ! xml_sha256="$(sha256sum "$safe_xml" 2>/dev/null | cut -d ' ' -f 1)" ||
    ! screenshot_sha256="$(sha256sum "$screenshot" 2>/dev/null | cut -d ' ' -f 1)" ||
    ! safe_logcat_sha256="$(sha256sum "$safe_logcat" 2>/dev/null | cut -d ' ' -f 1)" ||
    [[ ! "$xml_sha256" =~ ^[0-9a-f]{64}$ ||
       ! "$screenshot_sha256" =~ ^[0-9a-f]{64}$ ||
       ! "$safe_logcat_sha256" =~ ^[0-9a-f]{64}$ ]]; then
    retain_incomplete_app_failure_evidence content_hash "$occurrence" \
      "$identity_source_field" "$identity_class_field" "$identity_sha256_field" \
      "$evidence_dir" "$safe_xml" "$screenshot" "$safe_logcat" "$evidence" || true
    return 1
  fi
  {
    printf '%s\n' 'status=app_failure_modal'
    printf 'occurrence=%s\n' "$occurrence"
    printf '%s\n' "$identity_source_field" "$identity_class_field" "$identity_sha256_field"
    printf 'xml_sha256=sha256:%s\n' "$xml_sha256"
    printf 'screenshot_sha256=sha256:%s\n' "$screenshot_sha256"
    printf 'safe_logcat_sha256=sha256:%s\n' "$safe_logcat_sha256"
  } > "$evidence"
  chmod 600 "$safe_xml" "$screenshot" "$safe_logcat" "$evidence"
  printf 'status=app_failure_evidence_captured occurrence=%s %s %s %s xml_sha256=sha256:%s screenshot_sha256=sha256:%s safe_logcat_sha256=sha256:%s\n' \
    "$occurrence" "$identity_source_field" "$identity_class_field" "$identity_sha256_field" \
    "$xml_sha256" "$screenshot_sha256" "$safe_logcat_sha256" >> "$emulator_ui_health_diagnostics"
}

scan_emulator_ui_health() {
  local xml="$1"
  local logcat="$emulator_ui_health_private_dir/logcat.txt"
  local anr_events="$emulator_ui_health_private_dir/anr-events.txt"
  local classification=''
  : > "$logcat"
  : > "$anr_events"
  if ! capture_emulator_ui_logcat "$logcat"; then
    printf '%s\n' 'system_ui_unhealthy'
    return 0
  fi
  # The structured events ring is sparse and outlives the broad 4,096-record
  # tail. Failure to read it does not weaken the original logcat correlation;
  # an empty file keeps title-only recovery refused.
  capture_emulator_ui_anr_events "$anr_events" || : > "$anr_events"
  classification="$(classify_emulator_ui_health "$xml" "$logcat" "$anr_events" 2>/dev/null || printf '%s\n' 'ui_unavailable')"
  case "$classification" in
    healthy|ui_unavailable|pidroid_app_failure)
      printf '%s\n' "$classification"
      ;;
    other_app_failure_modal\ identity_source=*\ identity_class=*\ identity_sha256=sha256:*)
      local state=''
      local identity_source_field=''
      local identity_class_field=''
      local identity_sha256_field=''
      local extra=''
      read -r state identity_source_field identity_class_field identity_sha256_field extra <<< "$classification"
      if [[ -z "$extra" && "$identity_source_field" =~ ^identity_source=(logcat_package|dialog_title)$ &&
            "$identity_class_field" =~ ^identity_class=(android_system|google_system|third_party|unknown)$ &&
            "$identity_sha256_field" =~ ^identity_sha256=sha256:[0-9a-f]{64}$ ]]; then
        printf '%s\n' "$classification"
      else
        printf '%s\n' 'system_ui_unhealthy'
      fi
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
  local identity_sha256_field=''
  local extra=''
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
    read -r state x y identity_sha256_field extra <<< "$classification"
    case "$state" in
      pidroid_app_failure)
        record_emulator_ui_health_failure pidroid_app_failure recovery
        return 1
        ;;
      other_app_failure_modal)
        emulator_app_failure_occurrences=$((emulator_app_failure_occurrences + 1))
        if ! capture_app_failure_modal_evidence \
          "$recovery_xml" "$emulator_ui_health_private_dir/logcat.txt" "$emulator_app_failure_occurrences" \
          "$x" "$y" "$identity_sha256_field"; then
          record_emulator_ui_health_failure system_ui_unhealthy app_failure_evidence
          return 1
        fi
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
            "$recovery_xml" "$emulator_ui_health_private_dir/logcat.txt" \
            "$emulator_ui_health_private_dir/anr-events.txt" "$emulator_system_ui_occurrences" || true
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
  local identity_sha256_field=''
  local extra=''
  classification="$(scan_emulator_ui_health "$xml")"
  read -r state wait_x wait_y identity_sha256_field extra <<< "$classification"
  case "$state" in
    healthy|ui_unavailable)
      return 0
      ;;
    pidroid_app_failure)
      record_emulator_ui_health_failure pidroid_app_failure ui_wait
      return 1
      ;;
    other_app_failure_modal)
      emulator_app_failure_occurrences=$((emulator_app_failure_occurrences + 1))
      if ! capture_app_failure_modal_evidence \
        "$xml" "$emulator_ui_health_private_dir/logcat.txt" "$emulator_app_failure_occurrences" \
        "$wait_x" "$wait_y" "$identity_sha256_field"; then
        record_emulator_ui_health_failure system_ui_unhealthy app_failure_evidence
        return 1
      fi
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
        "$xml" "$emulator_ui_health_private_dir/logcat.txt" \
        "$emulator_ui_health_private_dir/anr-events.txt" "$emulator_system_ui_occurrences"; then
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
