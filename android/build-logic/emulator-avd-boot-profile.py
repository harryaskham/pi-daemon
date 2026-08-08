#!/usr/bin/env python3
"""Validate the fixed API 36 phone AVD boot-resource contract."""

from __future__ import annotations

import re
import sys
from pathlib import Path

MAX_CONFIG_BYTES = 64 * 1024
EXPECTED_IMAGE = "system-images/android-36/google_apis/x86_64/"


def parse_size_mib(value: str) -> int | None:
    match = re.fullmatch(r"([1-9][0-9]*)([KMG])", value)
    if match is None:
        return None
    amount = int(match.group(1))
    return amount * {"K": 1 / 1024, "M": 1, "G": 1024}[match.group(2)]


def load_config(path: Path) -> dict[str, str]:
    if path.is_symlink() or not path.is_file() or path.stat().st_size > MAX_CONFIG_BYTES:
        raise ValueError("invalid config file")
    fields: dict[str, str] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        fields[key] = value
    return fields


def valid_boot_profile(fields: dict[str, str]) -> bool:
    try:
        cpu_count = int(fields.get("hw.cpu.ncore", ""))
    except ValueError:
        return False
    ram_mib = parse_size_mib(fields.get("hw.ramSize", ""))
    heap_mib = parse_size_mib(fields.get("vm.heapSize", ""))
    image = fields.get("image.sysdir.1", "").replace("\\", "/")
    return all(
        (
            fields.get("abi.type") == "x86_64",
            fields.get("tag.id") == "google_apis",
            fields.get("hw.device.name") == "medium_phone",
            image.endswith(EXPECTED_IMAGE),
            cpu_count >= 2,
            ram_mib is not None and ram_mib >= 2048,
            heap_mib is not None and heap_mib >= 192,
        )
    )


def main() -> int:
    if len(sys.argv) != 2:
        raise SystemExit("usage: emulator-avd-boot-profile.py CONFIG")
    try:
        fields = load_config(Path(sys.argv[1]))
    except (OSError, UnicodeError, ValueError):
        raise SystemExit("invalid emulator AVD boot profile") from None
    if not valid_boot_profile(fields):
        raise SystemExit("invalid emulator AVD boot profile")
    print(
        "phase=avd_boot_profile status=verified "
        "system_image=android_36_google_apis_x86_64 device_profile=medium_phone "
        "ram_class=at_least_2048_mib vm_heap_class=at_least_192_mib cpu_class=multi_core"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
