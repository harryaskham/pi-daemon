#!/usr/bin/env bash

# Shared by the disposable interactive and readonly emulator proof harnesses.
# The caller owns shell options and the private root. This helper only starts
# and stops an ADB server whose port, process, and authentication keys belong to
# that one proof run.

readonly ADB_SERVER_PORT_MIN=42000
readonly ADB_SERVER_PORT_MAX=42127
readonly ADB_SERVER_PORT_CANDIDATES=128

record_isolated_adb_server() {
  local diagnostics_file="$1"
  local status="$2"
  local server_port="$3"
  local attempts="$4"
  local public_key_payload_sha256="${5:-}"
  printf 'phase=adb_server status=%s server_port=%s selection_attempts=%s key_home=run_scoped server_mode=owned_nodaemon' \
    "$status" "$server_port" "$attempts" >> "$diagnostics_file"
  if [[ "$public_key_payload_sha256" =~ ^sha256:[0-9a-f]{64}$ ]]; then
    printf ' public_key_payload_sha256=%s' "$public_key_payload_sha256" >> "$diagnostics_file"
  fi
  printf '\n' >> "$diagnostics_file"
}

fingerprint_adb_public_key_payload() {
  local public_key_file="$1"
  python3 - "$public_key_file" <<'PY'
import hashlib
import re
import sys

with open(sys.argv[1], "rb") as public_key:
    contents = public_key.read(16_385)
if len(contents) > 16_384:
    raise SystemExit(1)
parts = contents.split(None, 1)
if not parts or not re.fullmatch(rb"[A-Za-z0-9+/=]{1,8192}", parts[0]):
    raise SystemExit(1)
print(f"sha256:{hashlib.sha256(parts[0]).hexdigest()}")
PY
}

probe_localhost_port() {
  local port="$1"
  python3 - "$port" <<'PY'
import socket, sys
try:
    connection = socket.create_connection(("127.0.0.1", int(sys.argv[1])), timeout=0.1)
except OSError:
    raise SystemExit(1)
connection.close()
PY
}

start_isolated_adb_server() {
  local private_root="$1"
  local diagnostics_file="$2"
  local selector="$3"
  local selection=''
  local extra=''
  local ready='false'

  adb_key_home="$private_root/android-user"
  mkdir -p "$adb_key_home" "$private_root/avd"
  chmod 700 "$adb_key_home" "$private_root/avd"

  if ! selection="$(python3 "$selector" 2>/dev/null)"; then
    record_isolated_adb_server "$diagnostics_file" unavailable none "$ADB_SERVER_PORT_CANDIDATES"
    printf 'adb_server_port_unavailable: no private localhost ADB server port is free after %s attempts\n' \
      "$ADB_SERVER_PORT_CANDIDATES" >&2
    return 70
  fi
  read -r adb_server_port adb_server_port_attempts extra <<< "$selection"
  if [[ -n "$extra" || ! "$adb_server_port" =~ ^[0-9]+$ || ! "$adb_server_port_attempts" =~ ^[0-9]+$ ]] ||
    (( adb_server_port < ADB_SERVER_PORT_MIN || adb_server_port > ADB_SERVER_PORT_MAX ||
       adb_server_port == 5037 || adb_server_port_attempts < 1 ||
       adb_server_port_attempts > ADB_SERVER_PORT_CANDIDATES )); then
    record_isolated_adb_server "$diagnostics_file" invalid none "$ADB_SERVER_PORT_CANDIDATES"
    printf '%s\n' 'isolated ADB server selector returned an invalid result' >&2
    return 70
  fi

  # Export the run-scoped Android homes before the first adb or emulator
  # process, but clear any ambient vendor-key authority while generating this
  # run's key pair. ANDROID_EMULATOR_HOME is where the emulator injects the
  # matching adbkey.pub payload.
  export ANDROID_ADB_SERVER_PORT="$adb_server_port"
  export ANDROID_USER_HOME="$adb_key_home"
  export ANDROID_EMULATOR_HOME="$adb_key_home"
  export ANDROID_AVD_HOME="$private_root/avd"
  unset ADB_VENDOR_KEYS

  if ! adb keygen "$adb_key_home/adbkey" >/dev/null 2>&1; then
    record_isolated_adb_server "$diagnostics_file" keygen_failed "$adb_server_port" "$adb_server_port_attempts"
    printf '%s\n' 'run-scoped ADB key generation failed' >&2
    return 70
  fi
  chmod 600 "$adb_key_home/adbkey" "$adb_key_home/adbkey.pub"
  adb_public_key_payload_sha256=''
  if ! adb_public_key_payload_sha256="$(fingerprint_adb_public_key_payload "$adb_key_home/adbkey.pub")"; then
    record_isolated_adb_server "$diagnostics_file" key_fingerprint_failed "$adb_server_port" "$adb_server_port_attempts"
    printf '%s\n' 'run-scoped ADB public key fingerprint failed' >&2
    return 70
  fi

  # ADB directory scans accept only *.adb_key entries. Bind the owned server
  # to the exact generated private-key file so it cannot ignore adbkey and
  # generate or select another identity. This happens after keygen and before
  # either the server or emulator starts.
  export ADB_VENDOR_KEYS="$adb_key_home/adbkey"

  # Keep the server in an owned foreground process. A selector race therefore
  # fails with our PID exiting instead of silently attaching to another job's
  # server on the same port.
  adb -P "$adb_server_port" server nodaemon \
    > "$private_root/adb-server.log" 2>&1 &
  adb_server_pid="$!"
  for _ in $(seq 1 100); do
    if ! kill -0 "$adb_server_pid" 2>/dev/null; then
      break
    fi
    if probe_localhost_port "$adb_server_port" && kill -0 "$adb_server_pid" 2>/dev/null; then
      ready='true'
      break
    fi
    sleep 0.1
  done
  if [[ "$ready" != 'true' ]]; then
    record_isolated_adb_server "$diagnostics_file" start_failed "$adb_server_port" "$adb_server_port_attempts" "$adb_public_key_payload_sha256"
    if kill -0 "$adb_server_pid" 2>/dev/null; then
      kill "$adb_server_pid" 2>/dev/null || true
    fi
    wait "$adb_server_pid" 2>/dev/null || true
    adb_server_pid=''
    printf 'isolated ADB server failed to own localhost port %s\n' "$adb_server_port" >&2
    return 70
  fi

  adb_server_started='true'
  record_isolated_adb_server "$diagnostics_file" started "$adb_server_port" "$adb_server_port_attempts" "$adb_public_key_payload_sha256"
}

stop_isolated_adb_server() {
  # Never contact the shared default server. The explicit host/port request is
  # allowed only while our foreground server PID is still alive and the port is
  # inside the proof-only range selected above.
  if [[ "${adb_server_started:-false}" == 'true' && "${adb_server_pid:-}" =~ ^[1-9][0-9]*$ ]] &&
    kill -0 "$adb_server_pid" 2>/dev/null &&
    [[ "${adb_server_port:-}" =~ ^[0-9]+$ ]] &&
    (( adb_server_port >= ADB_SERVER_PORT_MIN && adb_server_port <= ADB_SERVER_PORT_MAX && adb_server_port != 5037 )); then
    adb -H 127.0.0.1 -P "$adb_server_port" kill-server >/dev/null 2>&1 || true
  fi
  if [[ "${adb_server_pid:-}" =~ ^[1-9][0-9]*$ ]] && kill -0 "$adb_server_pid" 2>/dev/null; then
    kill "$adb_server_pid" 2>/dev/null || true
  fi
  if [[ "${adb_server_pid:-}" =~ ^[1-9][0-9]*$ ]]; then
    wait "$adb_server_pid" 2>/dev/null || true
  fi
  adb_server_pid=''
  adb_server_started='false'
}
