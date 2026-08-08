#!/usr/bin/env bash

parse_external_canary_network() {
  if (( $# != 1 )); then
    printf '%s\n' 'external canary preflight receipt network must contain valid host, port, and scheme' >&2
    return 70
  fi

  local network=''
  if ! network="$("${EXTERNAL_CANARY_PYTHON_BIN:-python3}" - "$1" 2>/dev/null <<'PY'
import json
import sys

try:
    with open(sys.argv[1], encoding="utf-8") as receipt_file:
        receipt = json.load(receipt_file)
    network = receipt["network"]
    host = network["host"]
    port = network["port"]
    scheme = network["scheme"]
    if not isinstance(receipt, dict) or not isinstance(network, dict):
        raise ValueError
    if not isinstance(host, str) or not host or any(character in host for character in "\x00\r\n"):
        raise ValueError
    if type(port) is not int:
        raise ValueError
    if not isinstance(scheme, str) or not scheme or any(character in scheme for character in "\x00\r\n"):
        raise ValueError
except (OSError, UnicodeError, json.JSONDecodeError, KeyError, TypeError, ValueError):
    raise SystemExit(70)

print(host)
print(port)
print(scheme)
PY
  )"; then
    printf '%s\n' 'external canary preflight receipt network must contain valid host, port, and scheme' >&2
    return 70
  fi
  printf '%s\n' "$network"
}

parse_external_canary_observer_attach_allowed() {
  if (( $# != 1 )); then
    printf '%s\n' 'external canary preflight receipt observerAttachAllowed must be a JSON boolean' >&2
    return 70
  fi

  local observer_attach_allowed=''
  if ! observer_attach_allowed="$("${EXTERNAL_CANARY_PYTHON_BIN:-python3}" - "$1" 2>/dev/null <<'PY'
import json
import sys

try:
    with open(sys.argv[1], encoding="utf-8") as receipt_file:
        receipt = json.load(receipt_file)
    if not isinstance(receipt, dict):
        raise ValueError
    observer_attach_allowed = receipt["observerAttachAllowed"]
    if type(observer_attach_allowed) is not bool:
        raise ValueError
except (OSError, UnicodeError, json.JSONDecodeError, KeyError, TypeError, ValueError):
    raise SystemExit(70)

print("true" if observer_attach_allowed else "false")
PY
  )"; then
    printf '%s\n' 'external canary preflight receipt observerAttachAllowed must be a JSON boolean' >&2
    return 70
  fi

  case "$observer_attach_allowed" in
    true|false)
      printf '%s\n' "$observer_attach_allowed"
      ;;
    *)
      printf '%s\n' 'external canary preflight receipt observerAttachAllowed must be a JSON boolean' >&2
      return 70
      ;;
  esac
}
