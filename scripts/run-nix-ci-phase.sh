#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -lt 2 ]]; then
  echo "usage: $0 <phase> <command> [args ...]" >&2
  exit 64
fi

phase="$1"
shift
if [[ ! "$phase" =~ ^[a-z0-9][a-z0-9._-]*$ ]]; then
  echo "invalid phase name: $phase" >&2
  exit 64
fi

log_dir="${PI_DAEMON_NIX_CI_LOG_DIR:-}"
if [[ -z "$log_dir" ]]; then
  echo "PI_DAEMON_NIX_CI_LOG_DIR must name the bounded CI log directory" >&2
  exit 64
fi
mkdir -p "$log_dir"

phase_log="$log_dir/$phase.log"
telemetry_log="$log_dir/phases.log"
started_epoch="$(date +%s)"
started_utc="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
printf 'phase=%s event=start epoch=%s utc=%s\n' \
  "$phase" "$started_epoch" "$started_utc" | tee -a "$telemetry_log"

set +e
"$@" 2>&1 | tee "$phase_log"
status="${PIPESTATUS[0]}"
set -e

finished_epoch="$(date +%s)"
finished_utc="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
duration_seconds="$((finished_epoch - started_epoch))"
if [[ "$status" -eq 0 ]]; then
  result="success"
else
  result="failure"
fi
printf 'phase=%s event=finish epoch=%s utc=%s duration_seconds=%s status=%s result=%s\n' \
  "$phase" "$finished_epoch" "$finished_utc" "$duration_seconds" "$status" "$result" \
  | tee -a "$telemetry_log"

if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  printf -- '- `%s`: **%s** in %ss (exit %s)\n' \
    "$phase" "$result" "$duration_seconds" "$status" >> "$GITHUB_STEP_SUMMARY"
fi

exit "$status"
