#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -ne 2 ]]; then
  echo "usage: prefetch-npm-deps-retry LOCKFILE OUTPUT" >&2
  exit 2
fi

lockfile="$1"
output="$2"
prefetch_bin="${PREFETCH_NPM_DEPS_BIN:-prefetch-npm-deps}"
max_attempts="${PI_DAEMON_NPM_FETCH_MAX_ATTEMPTS:-3}"
initial_backoff="${PI_DAEMON_NPM_FETCH_INITIAL_BACKOFF_SECS:-2}"

if [[ ! "$max_attempts" =~ ^[1-9][0-9]*$ ]] || [[ ! "$initial_backoff" =~ ^[0-9]+$ ]]; then
  echo "npm dependency retry bounds must be non-negative integers and max attempts must be positive" >&2
  exit 2
fi

transport_class() {
  local log="$1"
  if grep -Eiq '\[92\]|HTTP/2.*(fram|stream|protocol)|framing layer' "$log"; then
    printf '%s' "http2_framing"
  elif grep -Eiq 'timed out|timeout|connection (reset|refused)|could not resolve|temporary failure|502 Bad Gateway|503 Service Unavailable|504 Gateway Timeout' "$log"; then
    printf '%s' "transient_network"
  else
    printf '%s' ""
  fi
}

dependency_name() {
  local log="$1"
  local dependency=""
  dependency="$(grep -Eo '[A-Za-z0-9@._%+-]+-[0-9][A-Za-z0-9._%+-]*\.tgz([?][^[:space:]]*)?' "$log" | tail -n 1 || true)"
  dependency="${dependency%%\?*}"
  dependency="${dependency//\"/_}"
  if [[ -z "$dependency" ]]; then dependency="unknown"; fi
  printf '%s' "$dependency"
}

attempt=1
while [[ "$attempt" -le "$max_attempts" ]]; do
  attempt_log="${TMPDIR:-/tmp}/pi-daemon-npm-fetch-$$-${attempt}.log"
  set +e
  "$prefetch_bin" "$lockfile" "$output" 2>&1 | tee "$attempt_log"
  status="${PIPESTATUS[0]}"
  set -e

  if [[ "$status" -eq 0 ]]; then
    printf '{"event":"pi_daemon_npm_deps_fetch","state":"completed","attempt":%d,"maxAttempts":%d}\n' \
      "$attempt" "$max_attempts"
    rm -f "$attempt_log"
    exit 0
  fi

  class="$(transport_class "$attempt_log")"
  dependency="$(dependency_name "$attempt_log")"
  if [[ -z "$class" ]]; then
    rm -rf "$output"
    printf '{"event":"pi_daemon_npm_deps_fetch","state":"failed","transportClass":"non_transient","dependency":"%s","attempt":%d,"maxAttempts":%d,"cleanup":"output_removed"}\n' \
      "$dependency" "$attempt" "$max_attempts"
    rm -f "$attempt_log"
    exit "$status"
  fi

  if [[ "$attempt" -ge "$max_attempts" ]]; then
    rm -rf "$output"
    printf '{"event":"pi_daemon_npm_deps_fetch","state":"failed","transportClass":"%s","dependency":"%s","attempt":%d,"maxAttempts":%d,"cleanup":"output_removed"}\n' \
      "$class" "$dependency" "$attempt" "$max_attempts"
    rm -f "$attempt_log"
    exit "$status"
  fi

  backoff=$((initial_backoff * (1 << (attempt - 1))))
  printf '{"event":"pi_daemon_npm_deps_fetch","state":"retrying","transportClass":"%s","dependency":"%s","attempt":%d,"maxAttempts":%d,"backoffSecs":%d,"cleanup":"partial_cache_retained"}\n' \
    "$class" "$dependency" "$attempt" "$max_attempts" "$backoff"
  rm -f "$attempt_log"
  if [[ "$backoff" -gt 0 ]]; then sleep "$backoff"; fi
  attempt=$((attempt + 1))
done
