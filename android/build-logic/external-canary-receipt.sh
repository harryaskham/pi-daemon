#!/usr/bin/env bash

parse_external_canary_observer_attach_allowed() {
  if (( $# != 1 )); then
    printf '%s\n' 'external canary preflight receipt observerAttachAllowed must be a JSON boolean' >&2
    return 70
  fi

  local observer_attach_allowed=''
  if ! observer_attach_allowed="$(jq -r '
    if type != "object" then error("invalid receipt")
    elif (has("observerAttachAllowed") | not) then error("missing observerAttachAllowed")
    elif (.observerAttachAllowed | type) != "boolean" then error("invalid observerAttachAllowed")
    else .observerAttachAllowed
    end
  ' "$1" 2>/dev/null)"; then
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
