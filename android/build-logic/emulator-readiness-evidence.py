#!/usr/bin/env python3
"""Retain bounded, secret-safe evidence for an emulator ADB readiness failure."""

from __future__ import annotations

import argparse
import hashlib
import os
import re
import socket
import stat
from pathlib import Path

MAX_LOG_INPUT_BYTES = 4 * 1024 * 1024
MAX_RETAINED_LINES = 256
MAX_RETAINED_LINE_BYTES = 512
MAX_CONSOLE_BYTES = 64 * 1024
SHA256_FINGERPRINT = re.compile(r"sha256:[0-9a-f]{64}\Z")
PUBLIC_KEY_PATTERNS = (
    re.compile(r"Sending adb public key \[([A-Za-z0-9+/=]+)(?:[ \]])"),
    re.compile(r"androidboot\.qemu\.adb\.pubkey=([A-Za-z0-9+/=]+)(?:[ \]]|$)"),
)
SAFE_LOG_MARKERS = (
    "Linux version",
    "Kernel command line",
    "Run /init",
    " init:",
    "init:",
    "adbd",
    "Boot completed",
    "full startup",
    "Kernel panic",
    "kernel panic",
    "watchdog",
    "EXT4-fs error",
    "I/O error",
    "Sending adb public key",
    "androidboot.qemu.adb.pubkey",
)
PRIVATE_KEY_MARKERS = (
    "BEGIN PRIVATE KEY",
    "BEGIN RSA PRIVATE KEY",
    "SENSITIVE_PRIVATE_KEY",
)
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
    parser.add_argument("--emulator-log", required=True)
    console = parser.add_mutually_exclusive_group(required=True)
    console.add_argument("--console-socket")
    console.add_argument("--console-state")
    parser.add_argument("--console-log")
    parser.add_argument("--output", required=True)
    parser.add_argument("--expected-public-key-fingerprint", required=True)
    parser.add_argument(
        "--connect-state",
        required=True,
        choices=("refused", "connected", "already_connected", "failed", "unavailable", "other"),
    )
    parser.add_argument(
        "--adb-state",
        required=True,
        choices=(
            "device",
            "offline",
            "bootloader",
            "recovery",
            "sideload",
            "unauthorized",
            "unknown",
            "not_found",
            "unavailable",
            "other",
        ),
    )
    return parser.parse_args()


def bounded_log(path: Path) -> tuple[str, int, bool]:
    size = path.stat().st_size
    with path.open("rb") as source:
        if size <= MAX_LOG_INPUT_BYTES:
            payload = source.read(MAX_LOG_INPUT_BYTES + 1)
            truncated = len(payload) > MAX_LOG_INPUT_BYTES
            payload = payload[:MAX_LOG_INPUT_BYTES]
        else:
            half = MAX_LOG_INPUT_BYTES // 2
            head = source.read(half)
            source.seek(max(0, size - half))
            payload = head + b"\n[bounded_middle_omitted]\n" + source.read(half)
            truncated = True
    return payload.decode("utf-8", "replace"), size, truncated


def public_key_fingerprints(text: str) -> list[str]:
    fingerprints: set[str] = set()
    for pattern in PUBLIC_KEY_PATTERNS:
        for match in pattern.finditer(text):
            fingerprints.add(f"sha256:{hashlib.sha256(match.group(1).encode()).hexdigest()}")
    return sorted(fingerprints)


def sanitize_log_line(line: str) -> str | None:
    if "pidroid_diag_" in line or not any(marker in line for marker in SAFE_LOG_MARKERS):
        return None
    if any(marker in line for marker in PRIVATE_KEY_MARKERS):
        return "redacted_sensitive_emulator_log_line=true"
    line = re.sub(
        r"(Sending adb public key \[)[A-Za-z0-9+/=]+(?: [^\]]*)?(\])",
        r"\1<redacted-public-key>\2",
        line,
    )
    line = re.sub(
        r"(androidboot\.qemu\.adb\.pubkey=)[A-Za-z0-9+/=]+(?: [^ ]*)?",
        r"\1<redacted-public-key>",
        line,
    )
    line = re.sub(r"(?:/home|/tmp)/[^\s]+", "<host-path>", line)
    line = re.sub(r"[A-Za-z0-9+/=]{256,}", "<redacted-long-payload>", line)
    encoded = line.encode("utf-8", "replace")[:MAX_RETAINED_LINE_BYTES]
    return encoded.decode("utf-8", "ignore")


def sanitized_log_lines(text: str) -> list[str]:
    retained = [sanitized for line in text.splitlines() if (sanitized := sanitize_log_line(line))]
    if len(retained) <= MAX_RETAINED_LINES:
        return retained
    half = MAX_RETAINED_LINES // 2
    return retained[:half] + ["bounded_log_lines_omitted=true"] + retained[-half:]


def normalize_service_state(value: str | None) -> str:
    if value is None or not value.strip():
        return "empty"
    value = value.strip()
    return value if value in {"running", "stopped", "restarting"} else "other"


def normalize_boot_completed(value: str | None) -> str:
    if value is None or not value.strip():
        return "empty"
    value = value.strip()
    return value if value in {"0", "1"} else "other"


def normalize_process_state(value: str | None) -> str:
    if value is None or not value.strip():
        return "unknown"
    value = value.strip()
    return value if value in {"running", "absent"} else "other"


def normalize_abi(value: str | None) -> str:
    if value is None or not value.strip():
        return "empty"
    return "x86_64" if value.strip() == "x86_64" else "other"


def normalize_uptime(value: str | None) -> str:
    if value is None:
        return "unknown"
    value = value.strip()
    return value if re.fullmatch(r"[0-9]{1,10}", value) else "unknown"


def unavailable_console() -> dict[str, str]:
    return {
        "guest_console": "unavailable",
        "guest_boot_completed": "unknown",
        "guest_adbd_state": "unknown",
        "guest_zygote_state": "unknown",
        "guest_system_server_state": "unknown",
        "guest_abi": "unknown",
        "guest_uptime_seconds": "unknown",
    }


def console_state(path: Path) -> dict[str, str]:
    result = unavailable_console()
    try:
        if path.is_symlink() or not path.is_file() or path.stat().st_size > 4096:
            return result
        fields = dict(
            line.split("=", 1)
            for line in path.read_text(encoding="utf-8").splitlines()
            if "=" in line
        )
    except (OSError, UnicodeError, ValueError):
        return result
    if fields.get("guest_console") != "available":
        return result
    result.update(
        guest_console="available",
        guest_boot_completed=normalize_boot_completed(fields.get("guest_boot_completed")),
        guest_adbd_state=normalize_service_state(fields.get("guest_adbd_state")),
        guest_zygote_state=normalize_service_state(fields.get("guest_zygote_state")),
        guest_system_server_state=normalize_process_state(fields.get("guest_system_server_state")),
        guest_abi=normalize_abi(fields.get("guest_abi")),
        guest_uptime_seconds=normalize_uptime(fields.get("guest_uptime_seconds")),
    )
    return result


def console_probe(path: Path) -> dict[str, str]:
    result = unavailable_console()
    try:
        mode = path.stat().st_mode
        if not stat.S_ISSOCK(mode):
            return result
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
            client.settimeout(2.0)
            client.connect(os.fspath(path))
            client.sendall(CONSOLE_COMMAND)
            chunks: list[bytes] = []
            size = 0
            while size < MAX_CONSOLE_BYTES:
                try:
                    chunk = client.recv(min(4096, MAX_CONSOLE_BYTES - size))
                except TimeoutError:
                    break
                if not chunk:
                    break
                chunks.append(chunk)
                size += len(chunk)
                if re.search(rb"(?m)^pidroid_diag_end\r?$", b"".join(chunks)):
                    break
    except (OSError, TimeoutError):
        return result

    text = b"".join(chunks).decode("utf-8", "replace")
    begin = re.search(r"(?m)^pidroid_diag_begin\r?$", text)
    end = re.search(r"(?m)^pidroid_diag_end\r?$", text)
    if not begin or not end or end.start() <= begin.end():
        return result
    body = text[begin.end() : end.start()]

    def field(name: str) -> str | None:
        match = re.search(rf"(?m)^pidroid_diag_{re.escape(name)}=([^\r\n]*)\r?$", body)
        return match.group(1) if match else None

    result.update(
        guest_console="available",
        guest_boot_completed=normalize_boot_completed(field("boot_completed")),
        guest_adbd_state=normalize_service_state(field("adbd_state")),
        guest_zygote_state=normalize_service_state(field("zygote_state")),
        guest_system_server_state=normalize_process_state(field("system_server_state")),
        guest_abi=normalize_abi(field("abi")),
        guest_uptime_seconds=normalize_uptime(field("uptime_seconds")),
    )
    return result


def classify(
    *,
    adb_state: str,
    expected_fingerprint: str,
    observed_fingerprints: list[str],
    console: dict[str, str],
    text: str,
    activity_manager_missing_events: int,
) -> str:
    fingerprint_match = expected_fingerprint in observed_fingerprints
    if observed_fingerprints and not fingerprint_match:
        return "adbd_auth_key_mismatch"
    if adb_state == "unauthorized":
        return "adbd_auth_rejected"
    if adb_state == "device":
        if console["guest_boot_completed"] == "1":
            return "ready"
        if console["guest_system_server_state"] == "absent" or activity_manager_missing_events >= 3:
            return "guest_framework_boot_stalled"
        if console["guest_console"] == "available":
            return "guest_boot_incomplete"
        return "device_ready_boot_indeterminate"
    if console["guest_console"] == "available":
        if console["guest_boot_completed"] == "1" and console["guest_adbd_state"] == "running":
            return "adbd_transport_handshake_stalled" if fingerprint_match else "adbd_auth_indeterminate"
        return "guest_boot_incomplete"
    if re.search(r"Kernel panic|kernel panic|watchdog.*(?:lockup|BUG)|EXT4-fs error|I/O error", text, re.I):
        return "guest_kernel_failure"
    if "Linux version" in text or "Run /init" in text:
        return "guest_userspace_stalled"
    return "guest_boot_indeterminate"


def main() -> int:
    args = parse_args()
    expected = args.expected_public_key_fingerprint
    if not SHA256_FINGERPRINT.fullmatch(expected):
        raise SystemExit("invalid expected public-key fingerprint")

    source = Path(args.emulator_log)
    destination = Path(args.output)
    if not source.is_file() or source.is_symlink():
        raise SystemExit("emulator log must be a regular file")
    if destination.exists() or destination.is_symlink():
        raise SystemExit("output must not already exist")
    destination.parent.mkdir(parents=True, exist_ok=True)

    text, source_bytes, input_truncated = bounded_log(source)
    console_source_bytes = 0
    console_input_truncated = False
    if args.console_log:
        console_log = Path(args.console_log)
        if console_log.is_symlink() or not console_log.is_file():
            raise SystemExit("console log must be a regular file")
        console_text, console_source_bytes, console_input_truncated = bounded_log(console_log)
        text = text + "\n" + console_text
    fingerprints = public_key_fingerprints(text)
    retained_lines = sanitized_log_lines(text)
    console = (
        console_state(Path(args.console_state))
        if args.console_state
        else console_probe(Path(args.console_socket))
    )
    activity_manager_missing_events = min(
        999,
        len(re.findall(r"Could not find ['\"]aidl/activity['\"]", text)),
    )
    classification = classify(
        adb_state=args.adb_state,
        expected_fingerprint=expected,
        observed_fingerprints=fingerprints,
        console=console,
        text=text,
        activity_manager_missing_events=activity_manager_missing_events,
    )
    fingerprint_match = expected in fingerprints
    transport_connected = args.connect_state in {"connected", "already_connected"}
    observed = fingerprints[0] if len(fingerprints) == 1 else ("multiple" if fingerprints else "unavailable")

    fields = [
        "schema_version=1",
        f"classification={classification}",
        f"connect_state={args.connect_state}",
        f"adb_state={args.adb_state}",
        f"transport_connected={str(transport_connected).lower()}",
        f"expected_public_key_fingerprint={expected}",
        f"emulator_public_key_fingerprint={observed}",
        f"public_key_fingerprint_match={str(fingerprint_match).lower()}",
        f"activity_manager_missing_events={activity_manager_missing_events}",
        *[f"{key}={value}" for key, value in console.items()],
        f"source_log_bytes={source_bytes}",
        f"source_log_truncated={str(input_truncated).lower()}",
        f"console_log_bytes={console_source_bytes}",
        f"console_log_truncated={str(console_input_truncated).lower()}",
        f"retained_log_lines={len(retained_lines)}",
        "sanitized_emulator_log_begin",
        *retained_lines,
        "sanitized_emulator_log_end",
    ]
    payload = "\n".join(fields) + "\n"
    if any(marker in payload for marker in PRIVATE_KEY_MARKERS):
        raise SystemExit("private-key marker reached retained evidence")
    destination.write_text(payload, encoding="utf-8")
    destination.chmod(0o600)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
