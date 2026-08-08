#!/usr/bin/env python3
"""Record one private emulator root console and publish only fixed-enum state."""

from __future__ import annotations

import argparse
import os
import re
import socket
import time
from pathlib import Path

MAX_RAW_CONSOLE_BYTES = 4 * 1024 * 1024
MAX_PARSE_BYTES = 128 * 1024
CONNECT_DEADLINE_SECONDS = 30
PROBE_INTERVAL_SECONDS = 5
CONSOLE_COMMAND = (
    "echo pidroid_diag_begin; "
    "echo pidroid_diag_boot_completed=\"$(getprop sys.boot_completed)\"; "
    "echo pidroid_diag_adbd_state=\"$(getprop init.svc.adbd)\"; "
    "echo pidroid_diag_zygote_state=\"$(getprop init.svc.zygote)\"; "
    "if pidof system_server >/dev/null 2>&1; then "
    "echo pidroid_diag_system_server_state=running; "
    "else echo pidroid_diag_system_server_state=absent; fi; "
    "echo pidroid_diag_abi=\"$(getprop ro.product.cpu.abi)\"; "
    "echo pidroid_diag_uptime_seconds=\"$(cut -d. -f1 /proc/uptime)\"; "
    "echo pidroid_diag_end\n"
).encode()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--console-socket", required=True)
    parser.add_argument("--raw-log", required=True)
    parser.add_argument("--state", required=True)
    return parser.parse_args()


def fixed_value(text: str, name: str) -> str | None:
    matches = re.findall(rf"(?m)^pidroid_diag_{re.escape(name)}=([^\r\n]*)\r?$", text)
    return matches[-1] if matches else None


def service_state(value: str | None) -> str:
    if value is None or not value.strip():
        return "empty"
    value = value.strip()
    return value if value in {"running", "stopped", "restarting"} else "other"


def boot_completed(value: str | None) -> str:
    if value is None or not value.strip():
        return "empty"
    value = value.strip()
    return value if value in {"0", "1"} else "other"


def process_state(value: str | None) -> str:
    if value is None or not value.strip():
        return "unknown"
    value = value.strip()
    return value if value in {"running", "absent"} else "other"


def abi(value: str | None) -> str:
    if value is None or not value.strip():
        return "empty"
    return "x86_64" if value.strip() == "x86_64" else "other"


def uptime(value: str | None) -> str:
    if value is None:
        return "unknown"
    value = value.strip()
    return value if re.fullmatch(r"[0-9]{1,10}", value) else "unknown"


def write_state(path: Path, *, connected: bool, raw: bytes, raw_bytes: int, truncated: bool) -> None:
    text = raw.decode("utf-8", "replace")
    fields = {
        "schema_version": "1",
        "guest_console": "available" if connected else "unavailable",
        "guest_boot_completed": boot_completed(fixed_value(text, "boot_completed")),
        "guest_adbd_state": service_state(fixed_value(text, "adbd_state")),
        "guest_zygote_state": service_state(fixed_value(text, "zygote_state")),
        "guest_system_server_state": process_state(fixed_value(text, "system_server_state")),
        "guest_abi": abi(fixed_value(text, "abi")),
        "guest_uptime_seconds": uptime(fixed_value(text, "uptime_seconds")),
        "kernel_started": str("Linux version" in text).lower(),
        "init_started": str("Run /init" in text or " init:" in text or "init:" in text).lower(),
        "kernel_failure": str(
            re.search(r"Kernel panic|kernel panic|watchdog.*(?:lockup|BUG)|EXT4-fs error|I/O error", text, re.I)
            is not None
        ).lower(),
        "raw_console_bytes": str(raw_bytes),
        "raw_console_truncated": str(truncated).lower(),
    }
    temporary = path.with_name(path.name + ".new")
    temporary.write_text("".join(f"{key}={value}\n" for key, value in fields.items()), encoding="utf-8")
    temporary.chmod(0o600)
    os.replace(temporary, path)


def main() -> int:
    args = parse_args()
    socket_path = Path(args.console_socket)
    raw_path = Path(args.raw_log)
    state_path = Path(args.state)
    for destination in (raw_path, state_path):
        if destination.exists() or destination.is_symlink():
            raise SystemExit(f"destination already exists: {destination.name}")
        destination.parent.mkdir(parents=True, exist_ok=True)
    write_state(state_path, connected=False, raw=b"", raw_bytes=0, truncated=False)

    client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    client.settimeout(0.2)
    deadline = time.monotonic() + CONNECT_DEADLINE_SECONDS
    while True:
        try:
            client.connect(os.fspath(socket_path))
            break
        except FileNotFoundError:
            if time.monotonic() >= deadline:
                client.close()
                return 70
            time.sleep(0.01)
        except (ConnectionRefusedError, BlockingIOError):
            if time.monotonic() >= deadline:
                client.close()
                return 70
            time.sleep(0.01)

    raw_path.touch(mode=0o600)
    retained = bytearray()
    raw_bytes = 0
    truncated = False
    next_probe = time.monotonic()
    with client, raw_path.open("ab", buffering=0) as raw_output:
        while True:
            now = time.monotonic()
            if now >= next_probe:
                try:
                    client.sendall(CONSOLE_COMMAND)
                except OSError:
                    break
                next_probe = now + PROBE_INTERVAL_SECONDS
            try:
                chunk = client.recv(4096)
            except TimeoutError:
                continue
            except OSError:
                break
            if not chunk:
                break
            raw_bytes += len(chunk)
            if raw_output.tell() < MAX_RAW_CONSOLE_BYTES:
                writable = chunk[: MAX_RAW_CONSOLE_BYTES - raw_output.tell()]
                raw_output.write(writable)
                if len(writable) != len(chunk):
                    truncated = True
            else:
                truncated = True
            retained.extend(chunk)
            if len(retained) > MAX_PARSE_BYTES:
                del retained[: len(retained) - MAX_PARSE_BYTES]
            write_state(
                state_path,
                connected=True,
                raw=bytes(retained),
                raw_bytes=raw_bytes,
                truncated=truncated,
            )
    write_state(
        state_path,
        connected=True,
        raw=bytes(retained),
        raw_bytes=raw_bytes,
        truncated=truncated,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
