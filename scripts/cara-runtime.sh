#!/usr/bin/env bash
# Execute the available system Cara without source/version/digest admission.
#
# Production callers retain this reviewed checkout-relative wrapper so loader
# sanitization, launchability selection, and missing-runtime diagnostics remain
# deterministic. Cara itself is a rolling system dependency: upgrades never
# require a Cacophony pin edit.
#
# Selection is launchability-only (bd-cc2a33, umbrella cacophony-config
# bd-36349b): a candidate that cannot be executed at all is not a candidate, so
# an unlaunchable `cara` earlier on PATH never shadows a launchable one and is
# never exec'd into an empty-stdout protocol failure. Version remains
# diagnostic and never selects or rejects an otherwise launchable executable.
#
# `--resolve` performs the same selection without executing the requested Cara
# operation: it prints the selected absolute path on stdout and exits 69 when
# no candidate can launch, so a caller can explicitly skip queue mutation with
# a typed actionable result instead of reporting a silent success.
set -euo pipefail

source_mode="system"
resolve_only=0
while (($#)); do
  case "$1" in
    --source)
      (($# >= 2)) || { echo "cara-runtime: --source requires a value" >&2; exit 64; }
      source_mode="$2"
      shift 2
      ;;
    --source=*)
      source_mode="${1#*=}"
      shift
      ;;
    --resolve)
      resolve_only=1
      shift
      ;;
    --)
      shift
      break
      ;;
    *)
      break
      ;;
  esac
done

# `installed` and `auto` remain compatibility spellings while config rolls.
case "$source_mode" in
  system|installed|auto) ;;
  *)
    echo "cara-runtime: unsupported production source '$source_mode'; use the system Cara executable" >&2
    exit 64
    ;;
esac

clean_env=(env -u NIX_LD -u NIX_LD_LIBRARY_PATH -u LD_LIBRARY_PATH)
probe_prefix=()
if command -v timeout >/dev/null 2>&1; then
  probe_prefix=(timeout 20s)
fi

# Diagnostics are uploaded as CI artifacts and echoed into notifications, so
# they are normalized to one line, stripped of the operator home prefix, and
# masked for provider/agent token shapes before they leave this process.
#
# Redaction is deliberately pure Bash: this wrapper runs during the trusted
# scheduler's pre-devshell phase, where a runner may expose only a minimal PATH,
# and a missing `sed`/`tr` must never downgrade masking or turn a runtime
# diagnostic into an unrelated tooling failure.
redact() {
  local text="$1"
  text="${text//$'\n'/ }"
  text="${text//$'\r'/ }"
  text="${text//$'\t'/ }"
  if [[ -n "${HOME:-}" && "$HOME" != "/" ]]; then
    text="${text//"$HOME"/'~'}"
  fi
  text="${text//[[:cntrl:]]/}"
  local masked="" rest="$text" match prefix head
  while [[ "$rest" =~ (gh[pousr]_|github_pat_|caco-agent:)[A-Za-z0-9._+/=-]+ ]]; do
    match="${BASH_REMATCH[0]}"
    prefix="${BASH_REMATCH[1]}"
    head="${rest%%"$match"*}"
    masked="$masked$head$prefix<redacted>"
    rest="${rest#*"$match"}"
  done
  text="$masked$rest"
  if ((${#text} > 200)); then
    text="${text:0:200}..."
  fi
  printf '%s' "$text"
}

json_string() {
  local text="$1"
  text="${text//\\/\\\\}"
  text="${text//\"/\\\"}"
  printf '"%s"' "$text"
}

resolve_path() {
  local path="$1" resolved
  resolved="$(readlink -f "$path" 2>/dev/null || true)"
  if [[ -n "$resolved" ]]; then
    printf '%s' "$resolved"
  elif command -v python3 >/dev/null 2>&1; then
    python3 -c 'import os, sys; print(os.path.realpath(sys.argv[1]), end="")' "$path"
  else
    local directory base
    directory="$(cd "$(dirname "$path")" && pwd -P)" || return 1
    base="$(basename "$path")"
    printf '%s/%s' "$directory" "$base"
  fi
}

# Candidate order is explicit reviewed binding first, then ordinary PATH
# discovery. An explicit binding is authoritative: a bound-but-unlaunchable
# path fails closed instead of silently selecting a different executable.
selection=""
candidates=()
selected="${CACO_CARA_BIN:-}"
if [[ -n "$selected" ]]; then
  selection="explicit_binding"
  candidates=("$selected")
else
  selection="path_discovery"
  IFS=':' read -r -a path_entries <<<"${PATH:-}"
  for entry in "${path_entries[@]}"; do
    [[ -n "$entry" ]] || entry="."
    candidates+=("$entry/cara")
  done
fi

candidate_json=""
append_candidate_json() {
  local path="$1" state="$2" probe_exit="$3" detail="$4" entry
  entry="{\"path\":$(json_string "$(redact "$path")"),\"origin\":$(json_string "$selection")"
  entry="$entry,\"state\":$(json_string "$state"),\"probe_exit\":$probe_exit"
  entry="$entry,\"detail\":$(json_string "$(redact "$detail")")}"
  if [[ -n "$candidate_json" ]]; then
    candidate_json="$candidate_json,$entry"
  else
    candidate_json="$entry"
  fi
}

seen_paths=""
resolved=""
version="unavailable"
version_probe_rc=-1
rejections=()

for candidate in "${candidates[@]}"; do
  if [[ ! -e "$candidate" ]]; then
    if [[ "$selection" == explicit_binding ]]; then
      append_candidate_json "$candidate" missing -1 "explicit CACO_CARA_BIN path does not exist"
      rejections+=("$(redact "$candidate") (missing)")
    fi
    continue
  fi
  if [[ ! -x "$candidate" || -d "$candidate" ]]; then
    append_candidate_json "$candidate" not_executable -1 "candidate is not an executable file"
    rejections+=("$(redact "$candidate") (not_executable)")
    continue
  fi
  candidate_resolved="$(resolve_path "$candidate" 2>/dev/null || true)"
  if [[ -z "$candidate_resolved" || ! -x "$candidate_resolved" ]]; then
    append_candidate_json "$candidate" not_executable -1 "candidate resolved to a non-executable path"
    rejections+=("$(redact "$candidate") (not_executable)")
    continue
  fi
  case ":$seen_paths:" in
    *":$candidate_resolved:"*) continue ;;
  esac
  seen_paths="$seen_paths:$candidate_resolved"

  # Launchability probe. `--version` output is diagnostic, but a candidate the
  # kernel/loader refuses to execute (126/127) is rejected outright so the real
  # operation is never handed to a binary that cannot run.
  set +e
  probe_output="$("${probe_prefix[@]}" "${clean_env[@]}" "$candidate_resolved" --version 2>&1)"
  probe_rc=$?
  set -e
  if [[ "$probe_rc" -eq 126 || "$probe_rc" -eq 127 ]]; then
    append_candidate_json "$candidate_resolved" unlaunchable "$probe_rc" "$probe_output"
    rejections+=("$(redact "$candidate_resolved") (unlaunchable, probe_exit=$probe_rc)")
    continue
  fi
  if [[ "$probe_rc" -eq 0 ]]; then
    version="${probe_output%%$'\n'*}"
    version="${version//$'\t'/ }"
    [[ -n "$version" ]] || version="unreported"
  else
    version="unavailable"
  fi
  resolved="$candidate_resolved"
  version_probe_rc="$probe_rc"
  append_candidate_json "$candidate_resolved" launchable "$probe_rc" "selected"
  break
done

state="launchable"
reason="launchable system Cara selected"
required_action=""
if [[ -z "$resolved" ]]; then
  if ((${#rejections[@]} == 0)); then
    state="absent"
    reason="no system Cara candidate was found"
  else
    state="unlaunchable"
    reason="no system Cara candidate could be launched"
  fi
  required_action="install a launchable cara on PATH or set CACO_CARA_BIN to a launchable executable"
fi

if [[ -n "${CACO_CARA_RESOLUTION_RECEIPT:-}" ]]; then
  receipt="$CACO_CARA_RESOLUTION_RECEIPT"
  binary_json=null
  [[ -z "$resolved" ]] || binary_json="$(json_string "$(redact "$resolved")")"
  {
    printf '{"schema_version":1,"phase":"runtime_resolution","source":"system"'
    printf ',"state":%s' "$(json_string "$state")"
    printf ',"reason":%s' "$(json_string "$reason")"
    printf ',"required_action":%s' "$(json_string "$required_action")"
    printf ',"selection":%s' "$(json_string "$selection")"
    printf ',"binary":%s' "$binary_json"
    printf ',"version":%s' "$(json_string "$(redact "$version")")"
    printf ',"version_probe_exit":%s' "$version_probe_rc"
    printf ',"candidates":[%s]' "$candidate_json"
    printf ',"generated_at":%s' "$(json_string "$(date -u +%Y-%m-%dT%H:%M:%SZ)")"
    printf '}\n'
  } > "$receipt.tmp"
  mv "$receipt.tmp" "$receipt"
fi

if [[ -n "${CACO_CARA_RESOLUTION_ENV:-}" ]]; then
  # Shell-sourceable twin of the JSON receipt for reviewed callers that run
  # before any JSON tool is guaranteed on the runner. Values are redacted and
  # `printf %q`-quoted, so sourcing cannot expand or execute candidate text.
  env_receipt="$CACO_CARA_RESOLUTION_ENV"
  {
    printf 'CACO_CARA_RESOLUTION_STATE=%q\n' "$state"
    printf 'CACO_CARA_RESOLUTION_REASON=%q\n' "$(redact "$reason")"
    printf 'CACO_CARA_RESOLUTION_REQUIRED_ACTION=%q\n' "$(redact "$required_action")"
    printf 'CACO_CARA_RESOLUTION_SELECTION=%q\n' "$selection"
    printf 'CACO_CARA_RESOLUTION_BINARY=%q\n' "$resolved"
    printf 'CACO_CARA_RESOLUTION_VERSION=%q\n' "$(redact "$version")"
    printf 'CACO_CARA_RESOLUTION_VERSION_PROBE_EXIT=%q\n' "$version_probe_rc"
    printf 'CACO_CARA_RESOLUTION_REJECTED_COUNT=%q\n' "${#rejections[@]}"
  } > "$env_receipt.tmp"
  mv "$env_receipt.tmp" "$env_receipt"
fi

if [[ -z "$resolved" ]]; then
  echo "cara-runtime: system Cara is missing or not executable; set CACO_CARA_BIN or install cara on PATH" >&2
  for rejection in ${rejections[@]+"${rejections[@]}"}; do
    echo "cara-runtime: rejected candidate $rejection" >&2
  done
  exit 69
fi

if ((resolve_only)); then
  printf '%s\n' "$resolved"
  exit 0
fi

if [[ -n "${CACO_CARA_LAUNCH_MARKER:-}" ]]; then
  : > "$CACO_CARA_LAUNCH_MARKER"
fi
printf 'caco-cara-runtime-receipt source=system binary=%q version=%q version_probe_rc=%s\n' \
  "$resolved" "$version" "$version_probe_rc" >&2
exec "${clean_env[@]}" "$resolved" "$@"
