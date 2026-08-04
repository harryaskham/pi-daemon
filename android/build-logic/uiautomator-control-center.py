#!/usr/bin/env python3
"""Resolve one exact UIAutomator label to the center of its clickable bounds."""

from __future__ import annotations

import re
import sys
import xml.etree.ElementTree as ET
from pathlib import Path


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
    values = [int(value) for value in re.findall(r"\d+", node.attrib.get("bounds", ""))]
    if len(values) != 4 or values[0] >= values[2] or values[1] >= values[3]:
        raise ValueError(f"control has invalid bounds: {label}")
    return ((values[0] + values[2]) // 2, (values[1] + values[3]) // 2)


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
