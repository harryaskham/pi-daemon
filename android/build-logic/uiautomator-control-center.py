#!/usr/bin/env python3
"""Resolve one exact UIAutomator label to the center of its clickable bounds."""

from __future__ import annotations

import re
import sys
import xml.etree.ElementTree as ET
from pathlib import Path


def parse_bounds(value: str) -> tuple[int, int, int, int]:
    match = re.fullmatch(r"\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]", value)
    if match is None:
        raise ValueError("invalid bounds encoding")
    return tuple(int(item) for item in match.groups())


def control_center(xml_path: Path, label: str) -> tuple[int, int]:
    root = ET.parse(xml_path).getroot()
    parents = {child: parent for parent in root.iter() for child in parent}
    matches = [
        node
        for node in root.iter("node")
        if node.attrib.get("text") == label or node.attrib.get("content-desc") == label
    ]
    if not matches:
        raise ValueError(f"control not found: {label}")
    # Prefer exact visible text, then a directly clickable node. Compose may put
    # label semantics below the clickable button, so climb to its clickable ancestor.
    node = sorted(
        matches,
        key=lambda item: (
            item.attrib.get("text") != label,
            item.attrib.get("clickable") != "true",
        ),
    )[0]
    while node.attrib.get("clickable") != "true" and node in parents:
        node = parents[node]
    if node.attrib.get("clickable") != "true":
        raise ValueError(f"control has no clickable ancestor: {label}")
    if node.attrib.get("enabled") == "false" or node.attrib.get("visible-to-user") == "false":
        raise ValueError(f"control is not visible and enabled: {label}")
    try:
        left, top, right, bottom = parse_bounds(node.attrib.get("bounds", ""))
    except ValueError:
        raise ValueError(f"control has invalid bounds: {label}") from None
    viewport_nodes = [item for item in root.iter("node") if "bounds" in item.attrib]
    try:
        viewport_left, viewport_top, viewport_right, viewport_bottom = parse_bounds(viewport_nodes[0].attrib["bounds"])
    except (IndexError, ValueError):
        raise ValueError("UI hierarchy has invalid viewport bounds") from None
    if (
        left >= right
        or top >= bottom
        or left < viewport_left
        or top < viewport_top
        or right > viewport_right
        or bottom > viewport_bottom
    ):
        raise ValueError(f"control has invalid or offscreen bounds: {label}")
    return ((left + right) // 2, (top + bottom) // 2)


def main(argv: list[str]) -> int:
    if len(argv) != 3:
        print("usage: uiautomator-control-center.py XML LABEL", file=sys.stderr)
        return 64
    try:
        x, y = control_center(Path(argv[1]), argv[2])
    except (ET.ParseError, OSError, ValueError) as error:
        print(str(error), file=sys.stderr)
        return 65
    print(x, y)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
