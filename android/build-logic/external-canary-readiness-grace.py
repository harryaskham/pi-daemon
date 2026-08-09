#!/usr/bin/env python3
"""Classify whether one external-canary ADB readiness grace is safe."""

from __future__ import annotations

import argparse
import os
import re
import stat
from pathlib import Path

MAX_CONSOLE_BYTES = 4 * 1024 * 1024
MAX_STATE_BYTES = 4096
PROGRESS_PATTERN = re.compile(
    r"(?im)^.*\bapexd\b[^\r\n]{0,256}\b(?:Processing|Decompressing)\b"
    r"[^\r\n]{0,256}(?:/system/apex/)?com\.android\.adbd\.capex(?:[\s\"']|$)"
)
FATAL_PATTERN = re.compile(
    r"Kernel panic|watchdog[^\r\n]*(?:lockup|\bBUG\b)|EXT4-fs error|"
    r"(?:^|[\s:])I/O error|FATAL EXCEPTION|Fatal signal",
    re.I | re.M,
)
STALL_PATTERN = re.compile(
    r"\b(?:boot|userspace|system_server|adbd)[^\r\n]{0,96}\b(?:stalled|stuck|hung)\b|"
    r"\bANR in (?:system_server|com\.android\.systemui)\b|"
    r"watchdog[^\r\n]*(?:blocked|timeout)",
    re.I,
)
ACTIVITY_MANAGER_MISSING_PATTERN = re.compile(r"Could not find ['\"]aidl/activity['\"]")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--console-state", required=True)
    parser.add_argument("--console-log", required=True)
    return parser.parse_args()


def private_regular_file(path: Path, maximum_bytes: int) -> tuple[int, bytes]:
    descriptor = os.open(path, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW)
    try:
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode):
            raise ValueError("not_regular")
        if metadata.st_uid != os.geteuid() or stat.S_IMODE(metadata.st_mode) != 0o600:
            raise ValueError("not_private")
        if metadata.st_size < 1 or metadata.st_size > maximum_bytes:
            raise ValueError("size_invalid")
        chunks: list[bytes] = []
        remaining = metadata.st_size
        while remaining:
            chunk = os.read(descriptor, min(65536, remaining))
            if not chunk:
                raise ValueError("read_incomplete")
            chunks.append(chunk)
            remaining -= len(chunk)
        return metadata.st_size, b"".join(chunks)
    finally:
        os.close(descriptor)


def fixed_state(payload: bytes) -> dict[str, str]:
    text = payload.decode("utf-8", "strict")
    fields: dict[str, str] = {}
    for line in text.splitlines():
        if "=" not in line:
            raise ValueError("state_malformed")
        key, value = line.split("=", 1)
        if not re.fullmatch(r"[a-z_]{1,64}", key) or key in fields:
            raise ValueError("state_malformed")
        if not re.fullmatch(r"[A-Za-z0-9_]{0,32}", value):
            raise ValueError("state_malformed")
        fields[key] = value
    return fields


def decision(state_path: Path, console_path: Path) -> tuple[str, str]:
    try:
        _, state_payload = private_regular_file(state_path, MAX_STATE_BYTES)
        console_size, console_payload = private_regular_file(console_path, MAX_CONSOLE_BYTES)
        state = fixed_state(state_payload)
    except (OSError, UnicodeError, ValueError):
        return "refused", "console_evidence_invalid"

    if (
        state.get("schema_version") != "1"
        or state.get("guest_console") != "available"
        or state.get("kernel_started") != "true"
        or state.get("init_started") != "true"
    ):
        return "refused", "console_evidence_invalid"
    if state.get("raw_console_truncated") != "false":
        return "refused", "console_evidence_truncated"
    raw_bytes = state.get("raw_console_bytes", "")
    if not re.fullmatch(r"[1-9][0-9]{0,9}", raw_bytes) or int(raw_bytes) != console_size:
        return "refused", "console_evidence_invalid"

    text = console_payload.decode("utf-8", "replace")
    if state.get("kernel_failure") != "false" or FATAL_PATTERN.search(text):
        return "refused", "panic_or_fatal_marker"
    if STALL_PATTERN.search(text) or len(ACTIVITY_MANAGER_MISSING_PATTERN.findall(text)) >= 3:
        return "refused", "stall_marker"
    if not PROGRESS_PATTERN.search(text):
        return "refused", "adbd_compressed_apex_progress_absent"
    return "granted", "adbd_compressed_apex_forward_progress"


def main() -> int:
    args = parse_args()
    status, reason = decision(Path(args.console_state), Path(args.console_log))
    print(f"decision={status} reason={reason}")
    return 0 if status == "granted" else 70


if __name__ == "__main__":
    raise SystemExit(main())
