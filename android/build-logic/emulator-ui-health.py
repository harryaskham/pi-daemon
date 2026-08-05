#!/usr/bin/env python3
"""Classify bounded emulator UI/logcat snapshots without exposing their content."""

from __future__ import annotations

import re
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

PIDROID_PACKAGES = (
    "com.harryaskham.pidroid",
    "com.harryaskham.pidroid.debug",
)
SYSTEM_UI_PACKAGE = "com.android.systemui"
SYSTEM_DIALOG_PACKAGE = "android"
SYSTEM_UI_TITLES = (
    "System UI isn't responding",
    "System UI isn’t responding",
)


def logcat_has_anr(logcat: str, package: str) -> bool:
    return re.search(
        rf"\bANR in {re.escape(package)}(?=$|[\s/:()])",
        logcat,
        re.MULTILINE,
    ) is not None


def logcat_has_fatal(logcat: str, package: str) -> bool:
    lines = logcat.splitlines()
    process_pattern = re.compile(rf"\bProcess: {re.escape(package)},\s*PID:\s*\d+\b")
    native_pattern = re.compile(
        rf"\bFatal signal\s+\d+\b[^\n]*\({re.escape(package)}\)(?:\s|$)",
        re.IGNORECASE,
    )
    for index, line in enumerate(lines):
        if native_pattern.search(line) is not None:
            return True
        if process_pattern.search(line) is None:
            continue
        preceding = lines[max(0, index - 8) : index + 1]
        if any("FATAL EXCEPTION:" in candidate for candidate in preceding):
            return True
    return False


def has_pidroid_failure(logcat: str) -> bool:
    return any(
        logcat_has_anr(logcat, package) or logcat_has_fatal(logcat, package)
        for package in PIDROID_PACKAGES
    )


def parse_bounds(value: str) -> tuple[int, int, int, int]:
    match = re.fullmatch(r"\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]", value)
    if match is None:
        raise ValueError("invalid bounds")
    return tuple(int(item) for item in match.groups())


def clickable_center(root: ET.Element, label: str, package: str) -> tuple[int, int] | None:
    parents = {child: parent for parent in root.iter() for child in parent}
    matches = [
        node
        for node in root.iter("node")
        if node.attrib.get("package") == package
        and (node.attrib.get("text") == label or node.attrib.get("content-desc") == label)
    ]
    if not matches:
        return None
    node = sorted(matches, key=lambda item: item.attrib.get("clickable") != "true")[0]
    while node.attrib.get("clickable") != "true" and node in parents:
        node = parents[node]
    if (
        node.attrib.get("clickable") != "true"
        or node.attrib.get("enabled") == "false"
        or node.attrib.get("visible-to-user") == "false"
    ):
        return None
    try:
        left, top, right, bottom = parse_bounds(node.attrib.get("bounds", ""))
        viewport = next(item for item in root.iter("node") if "bounds" in item.attrib)
        viewport_left, viewport_top, viewport_right, viewport_bottom = parse_bounds(viewport.attrib["bounds"])
    except (StopIteration, ValueError):
        return None
    if (
        left >= right
        or top >= bottom
        or left < viewport_left
        or top < viewport_top
        or right > viewport_right
        or bottom > viewport_bottom
    ):
        return None
    return ((left + right) // 2, (top + bottom) // 2)


def failure_modal_present(root: ET.Element) -> bool:
    titles = [
        node.attrib.get("text", "")
        for node in root.iter("node")
        if node.attrib.get("package") == SYSTEM_DIALOG_PACKAGE
    ]
    return any(
        title.endswith(" isn't responding")
        or title.endswith(" isn’t responding")
        or title.endswith(" keeps stopping")
        or title.endswith(" has stopped")
        or title.endswith(" has stopped.")
        for title in titles
    )


def classify(xml_text: str, logcat: str) -> tuple[str, tuple[int, int] | None]:
    # Pi Droid failures always win over any system dialog. This prevents a
    # coincident System UI modal from hiding a product failure.
    if has_pidroid_failure(logcat):
        return ("pidroid_app_failure", None)
    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError:
        return ("ui_unavailable", None)

    title_is_exact = any(
        node.attrib.get("package") == SYSTEM_DIALOG_PACKAGE
        and node.attrib.get("text") in SYSTEM_UI_TITLES
        for node in root.iter("node")
    )
    wait_center = clickable_center(root, "Wait", SYSTEM_DIALOG_PACKAGE)
    close_center = clickable_center(root, "Close app", SYSTEM_DIALOG_PACKAGE)
    if (
        title_is_exact
        and wait_center is not None
        and close_center is not None
        and logcat_has_anr(logcat, SYSTEM_UI_PACKAGE)
    ):
        return ("system_ui_anr", wait_center)
    if failure_modal_present(root):
        return ("other_app_failure_modal", None)
    return ("healthy", None)


def read_bounded(path: Path) -> str:
    with path.open("rb") as handle:
        content = handle.read(1_048_577)
    if len(content) > 1_048_576:
        raise ValueError("snapshot exceeds byte limit")
    return content.decode("utf-8", errors="replace")


def main(argv: list[str]) -> int:
    if len(argv) != 3:
        print("usage: emulator-ui-health.py XML LOGCAT", file=sys.stderr)
        return 64
    try:
        xml_text = read_bounded(Path(argv[1]))
        logcat = read_bounded(Path(argv[2]))
    except (OSError, ValueError):
        print("ui_unavailable")
        return 0
    state, center = classify(xml_text, logcat)
    if center is None:
        print(state)
    else:
        print(state, center[0], center[1])
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
