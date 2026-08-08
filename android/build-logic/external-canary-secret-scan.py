#!/usr/bin/env python3
"""Bounded exact and structured-pattern leak scan for external canary evidence."""

from __future__ import annotations

import argparse
import os
import re
import stat
import sys
from pathlib import Path

from external_canary_token import BearerFormatError, MAX_RAW_TOKEN_BYTES, parse_http_bearer

MAX_FILE_BYTES = 16 * 1_024 * 1_024
MAX_ROOT_BYTES = 64 * 1_024 * 1_024
MAX_STREAM_BYTES = 32 * 1_024 * 1_024
EXCLUDED_FILENAMES = frozenset({"external-canary-evidence-scan.log"})
LEAK_PATTERNS = (
    re.compile(rb"authorization\s*[:=]\s*bearer\s+[A-Za-z0-9._~+/=\-]{8,4096}", re.IGNORECASE),
    re.compile(rb"pidroid://pair/v1/[A-Za-z0-9_-]{16,16384}"),
    re.compile(rb'"bearer"\s*:\s*"[^"\r\n]{1,4096}"', re.IGNORECASE),
)


class ScanError(Exception):
    pass


def read_token(path: Path) -> bytes:
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(path, flags)
    except OSError as error:
        raise ScanError("token_unavailable") from error
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077:
            raise ScanError("token_invalid")
        if info.st_size < 1 or info.st_size > MAX_RAW_TOKEN_BYTES:
            raise ScanError("token_invalid")
        raw_token = os.read(descriptor, MAX_RAW_TOKEN_BYTES + 1)
    except OSError as error:
        raise ScanError("token_unavailable") from error
    finally:
        os.close(descriptor)
    try:
        return parse_http_bearer(raw_token)
    except BearerFormatError as error:
        raise ScanError("token_invalid") from error


def leak_kind(token: bytes, data: bytes) -> str | None:
    if token in data:
        return "exact"
    if any(pattern.search(data) is not None for pattern in LEAK_PATTERNS):
        return "structured_pattern"
    return None


def scan_root(token: bytes, root: Path) -> tuple[str | None, int, int]:
    try:
        root_info = root.lstat()
    except OSError as error:
        raise ScanError("artifacts_unavailable") from error
    if not stat.S_ISDIR(root_info.st_mode) or stat.S_ISLNK(root_info.st_mode):
        raise ScanError("artifacts_invalid")

    scanned_files = 0
    scanned_bytes = 0
    for directory, directory_names, filenames in os.walk(root, followlinks=False):
        directory_path = Path(directory)
        for name in directory_names:
            path = directory_path / name
            if path.is_symlink():
                raise ScanError("artifact_symlink")
        for name in sorted(filenames):
            if name in EXCLUDED_FILENAMES:
                continue
            path = directory_path / name
            try:
                info = path.lstat()
            except OSError as error:
                raise ScanError("artifact_unreadable") from error
            if not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode):
                raise ScanError("artifact_invalid")
            if info.st_size > MAX_FILE_BYTES or scanned_bytes + info.st_size > MAX_ROOT_BYTES:
                raise ScanError("artifact_limit_exceeded")
            try:
                data = path.read_bytes()
            except OSError as error:
                raise ScanError("artifact_unreadable") from error
            scanned_files += 1
            scanned_bytes += len(data)
            found = leak_kind(token, data)
            if found is not None:
                return found, scanned_files, scanned_bytes
    return None, scanned_files, scanned_bytes


def scan_stream(token: bytes) -> tuple[str | None, int]:
    data = bytearray()
    while True:
        chunk = sys.stdin.buffer.read(64 * 1_024)
        if not chunk:
            break
        if len(data) + len(chunk) > MAX_STREAM_BYTES:
            raise ScanError("stream_limit_exceeded")
        data.extend(chunk)
    if not data:
        raise ScanError("stream_empty")
    found = leak_kind(token, bytes(data))
    data[:] = b"\x00" * len(data)
    return found, len(data)


def emit(status: str, scan: str, scanned_files: int, scanned_bytes: int, reason: str | None = None) -> None:
    fields = [
        f"status={status}",
        f"scan={scan}",
        f"scanned_files={scanned_files}",
        f"scanned_bytes={scanned_bytes}",
    ]
    if reason is not None:
        fields.append(f"reason={reason}")
    print(" ".join(fields))


def parse_arguments(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--token-file", required=True)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--root")
    mode.add_argument("--stream", action="store_true")
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    try:
        arguments = parse_arguments(argv)
        token = read_token(Path(arguments.token_file))
        if arguments.root is not None:
            found, scanned_files, scanned_bytes = scan_root(token, Path(arguments.root))
            scan_name = "retained_artifacts"
        else:
            found, scanned_bytes = scan_stream(token)
            scanned_files = 1
            scan_name = "app_private_stream"
        if found is not None:
            emit("leak", scan_name, scanned_files, scanned_bytes, found)
            return 65
        emit("clean", scan_name, scanned_files, scanned_bytes)
        return 0
    except (ScanError, SystemExit) as error:
        reason = str(error) if isinstance(error, ScanError) else "usage"
        emit("scan_failed", "unknown", 0, 0, reason)
        return 70
    except Exception:
        emit("scan_failed", "unknown", 0, 0, "unexpected_failure")
        return 70


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
