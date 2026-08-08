#!/usr/bin/env python3
"""Validate the fixed API 36 phone AVD boot-resource contract."""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

MAX_CONFIG_BYTES = 64 * 1024
MAX_CONTRACT_BYTES = 8 * 1024


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


def load_contract(path: Path) -> dict[str, str | int | bool]:
    if path.is_symlink() or not path.is_file() or path.stat().st_size > MAX_CONTRACT_BYTES:
        raise ValueError("invalid contract file")
    contract = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(contract, dict):
        raise ValueError("invalid contract object")
    api_level = contract.get("apiLevel")
    image_type = contract.get("imageType")
    abi = contract.get("abi")
    device_profile = contract.get("deviceProfile")
    if (
        contract.get("schemaVersion") != 1
        or api_level != 36
        or image_type != "default"
        or abi != "x86_64"
        or device_profile != "medium_phone"
        or contract.get("package") != f"system-images;android-{api_level};{image_type};{abi}"
        or contract.get("directory") != f"system-images/android-{api_level}/{image_type}/{abi}/"
        or contract.get("automatedTestDevice") is not False
        or contract.get("aospAtdAvailableInPinnedCatalog") is not False
        or contract.get("googleAtdAvailableInPinnedCatalog") is not False
        or contract.get("googleApisRequired") is not False
        or contract.get("googlePlayServicesRequired") is not False
        or contract.get("googlePlayStoreRequired") is not False
    ):
        raise ValueError("invalid emulator system-image contract")
    return contract


def valid_boot_profile(
    fields: dict[str, str], contract: dict[str, str | int | bool]
) -> bool:
    try:
        cpu_count = int(fields.get("hw.cpu.ncore", ""))
    except ValueError:
        return False
    ram_mib = parse_size_mib(fields.get("hw.ramSize", ""))
    heap_mib = parse_size_mib(fields.get("vm.heapSize", ""))
    image = fields.get("image.sysdir.1", "").replace("\\", "/")
    return all(
        (
            fields.get("abi.type") == contract["abi"],
            fields.get("tag.id") == contract["imageType"],
            fields.get("hw.device.name") == contract["deviceProfile"],
            image.endswith(str(contract["directory"])),
            cpu_count >= 2,
            ram_mib is not None and ram_mib >= 2048,
            heap_mib is not None and heap_mib >= 192,
        )
    )


def main() -> int:
    if len(sys.argv) == 3 and sys.argv[1] == "--print-contract":
        try:
            contract = load_contract(Path(sys.argv[2]))
        except (OSError, UnicodeError, ValueError, json.JSONDecodeError):
            raise SystemExit("invalid emulator system-image contract") from None
        print(
            "\t".join(
                str(contract[key])
                for key in ("package", "directory", "imageType", "deviceProfile", "apiLevel", "abi")
            )
        )
        return 0
    if len(sys.argv) != 3:
        raise SystemExit("usage: emulator-avd-boot-profile.py CONFIG CONTRACT")
    try:
        fields = load_config(Path(sys.argv[1]))
        contract = load_contract(Path(sys.argv[2]))
    except (OSError, UnicodeError, ValueError, json.JSONDecodeError):
        raise SystemExit("invalid emulator AVD boot profile") from None
    if not valid_boot_profile(fields, contract):
        raise SystemExit("invalid emulator AVD boot profile")
    print(
        "phase=avd_boot_profile status=verified "
        f"system_image=android_{contract['apiLevel']}_{contract['imageType']}_{contract['abi']} "
        f"device_profile={contract['deviceProfile']} "
        "ram_class=at_least_2048_mib vm_heap_class=at_least_192_mib cpu_class=multi_core"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
