#!/usr/bin/env python3
"""Exact, bounded disposable-bearer scan for retained physical-proof text."""

from __future__ import annotations

import os
import re
import stat
import sys
from pathlib import Path

MAX_TOKEN_BYTES = 4_096
MAX_TEXT_FILE_BYTES = 16 * 1_024 * 1_024
MAX_TOTAL_TEXT_BYTES = 64 * 1_024 * 1_024
BINARY_SUFFIXES = frozenset(
    {
        ".aab",
        ".apk",
        ".gif",
        ".jpeg",
        ".jpg",
        ".mp4",
        ".png",
        ".webp",
        ".zip",
    }
)
EXCLUDED_FILENAMES = frozenset({"bearer-scan.log"})


def emit(
    status: str,
    scanned_files: int,
    scanned_bytes: int,
    skipped_binary_files: int,
    reason: str | None = None,
) -> None:
    fields = [
        f"status={status}",
        f"scanned_files={scanned_files}",
        f"scanned_bytes={scanned_bytes}",
        f"skipped_binary_files={skipped_binary_files}",
    ]
    if reason is not None:
        fields.append(f"reason={reason}")
    print(" ".join(fields))


def read_token(path: Path) -> bytes:
    try:
        info = path.lstat()
    except OSError as error:
        raise ValueError("token_unavailable") from error
    if not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode) or info.st_size > MAX_TOKEN_BYTES:
        raise ValueError("token_invalid")
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(path, flags)
        try:
            token = os.read(descriptor, MAX_TOKEN_BYTES + 1)
        finally:
            os.close(descriptor)
    except OSError as error:
        raise ValueError("token_unavailable") from error
    token = token.rstrip(b"\r\n")
    if re.fullmatch(rb"[0-9a-f]{64}", token) is None:
        raise ValueError("token_invalid")
    return token


def scan(token: bytes, root: Path) -> tuple[str, int, int, int]:
    try:
        root_info = root.lstat()
    except OSError as error:
        raise ValueError("artifacts_unavailable") from error
    if not stat.S_ISDIR(root_info.st_mode) or stat.S_ISLNK(root_info.st_mode):
        raise ValueError("artifacts_invalid")

    scanned_files = 0
    scanned_bytes = 0
    skipped_binary_files = 0
    for directory, directory_names, filenames in os.walk(root, followlinks=False):
        directory_path = Path(directory)
        for name in directory_names:
            if (directory_path / name).is_symlink():
                raise ValueError("artifact_symlink")
        for name in sorted(filenames):
            path = directory_path / name
            if name in EXCLUDED_FILENAMES:
                continue
            try:
                info = path.lstat()
            except OSError as error:
                raise ValueError("artifact_unreadable") from error
            if not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode):
                raise ValueError("artifact_invalid")
            if path.suffix.lower() in BINARY_SUFFIXES:
                skipped_binary_files += 1
                continue
            if info.st_size > MAX_TEXT_FILE_BYTES or scanned_bytes + info.st_size > MAX_TOTAL_TEXT_BYTES:
                raise ValueError("text_limit_exceeded")
            try:
                data = path.read_bytes()
            except OSError as error:
                raise ValueError("artifact_unreadable") from error
            if b"\0" in data:
                skipped_binary_files += 1
                continue
            scanned_files += 1
            scanned_bytes += len(data)
            if token in data:
                return ("leak", scanned_files, scanned_bytes, skipped_binary_files)
    return ("clean", scanned_files, scanned_bytes, skipped_binary_files)


def main(argv: list[str]) -> int:
    if len(argv) != 3:
        emit("scan_failed", 0, 0, 0, "usage")
        return 70
    try:
        token = read_token(Path(argv[1]))
        status, scanned_files, scanned_bytes, skipped_binary_files = scan(token, Path(argv[2]))
    except ValueError as error:
        emit("scan_failed", 0, 0, 0, str(error))
        return 70
    emit(status, scanned_files, scanned_bytes, skipped_binary_files)
    return 0 if status == "clean" else 65


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
