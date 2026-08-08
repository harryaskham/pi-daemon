#!/usr/bin/env python3
"""Classify bounded emulator UI/logcat snapshots without exposing their content."""

from __future__ import annotations

import hashlib
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
PACKAGE_PATTERN = r"[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+"
ANR_EVENT_PATTERN = re.compile(
    rf"^(?:[^\n]*\sI\s+am_anr|[^\n]*\sI/am_anr\s*\(\s*\d+\s*\))"
    rf"\s*:\s*\[\s*-?\d+\s*,\s*\d+\s*,\s*({PACKAGE_PATTERN})\s*,",
    re.MULTILINE,
)
SAFE_IDENTITY_SOURCES = frozenset({"logcat_package", "dialog_title"})
SAFE_IDENTITY_CLASSES = frozenset({"android_system", "google_system", "third_party", "unknown"})


def logcat_has_anr(logcat: str, package: str) -> bool:
    return re.search(
        rf"\bANR in {re.escape(package)}(?=$|[\s/:()])",
        logcat,
        re.MULTILINE,
    ) is not None


def anr_event_packages(anr_events: str) -> list[str]:
    return [match.group(1) for match in ANR_EVENT_PATTERN.finditer(anr_events)]


def anr_events_have_package(anr_events: str, package: str) -> bool:
    return package in anr_event_packages(anr_events)


def latest_anr_event_is(anr_events: str, package: str) -> bool:
    packages = anr_event_packages(anr_events)
    return bool(packages) and packages[-1] == package


def system_ui_anr_correlated(logcat: str, anr_events: str) -> bool:
    packages = anr_event_packages(anr_events)
    if packages:
        return latest_anr_event_is(anr_events, SYSTEM_UI_PACKAGE)
    return logcat_has_anr(logcat, SYSTEM_UI_PACKAGE)


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


def has_pidroid_failure(logcat: str, anr_events: str = "") -> bool:
    return any(
        logcat_has_anr(logcat, package)
        or anr_events_have_package(anr_events, package)
        or logcat_has_fatal(logcat, package)
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


def failure_modal_titles(root: ET.Element) -> list[str]:
    titles = [
        node.attrib.get("text", "")
        for node in root.iter("node")
        if node.attrib.get("package") == SYSTEM_DIALOG_PACKAGE
    ]
    return [
        title
        for title in titles
        if title.endswith(" isn't responding")
        or title.endswith(" isn’t responding")
        or title.endswith(" keeps stopping")
        or title.endswith(" has stopped")
        or title.endswith(" has stopped.")
    ]


def failure_modal_present(root: ET.Element) -> bool:
    return bool(failure_modal_titles(root))


def logcat_failure_packages(logcat: str) -> list[str]:
    patterns = (
        re.compile(rf"\bANR in ({PACKAGE_PATTERN})(?=$|[\s/:()])", re.MULTILINE),
        re.compile(rf"\bProcess: ({PACKAGE_PATTERN}),\s*PID:\s*\d+\b"),
        re.compile(rf"\bFatal signal\s+\d+\b[^\n]*\(({PACKAGE_PATTERN})\)(?:\s|$)", re.IGNORECASE),
    )
    packages: list[str] = []
    for pattern in patterns:
        packages.extend(match.group(1) for match in pattern.finditer(logcat))
    return packages


def safe_package_class(package: str | None) -> str:
    if package is None:
        return "unknown"
    if package.startswith("com.google.android."):
        return "google_system"
    if package == "android" or package.startswith("com.android."):
        return "android_system"
    return "third_party"


def modal_kind(title: str) -> str:
    if title.endswith(" isn't responding") or title.endswith(" isn’t responding"):
        return "not_responding"
    if title.endswith(" keeps stopping"):
        return "keeps_stopping"
    if title.endswith(" has stopped") or title.endswith(" has stopped."):
        return "has_stopped"
    return "unknown"


def app_failure_metadata(root: ET.Element, logcat: str) -> dict[str, str]:
    packages = [package for package in logcat_failure_packages(logcat) if package not in PIDROID_PACKAGES]
    titles = failure_modal_titles(root)
    if packages:
        identity_source = "logcat_package"
        identity = packages[-1]
        identity_class = safe_package_class(identity)
    else:
        identity_source = "dialog_title"
        identity = titles[0] if titles else "unknown"
        identity_class = "unknown"
    return {
        "identity_source": identity_source,
        "identity_class": identity_class,
        "identity_sha256": f"sha256:{hashlib.sha256(identity.encode('utf-8')).hexdigest()}",
        "modal_kind": modal_kind(titles[0]) if titles else "unknown",
    }


def format_app_failure_classification(metadata: dict[str, str]) -> str:
    return (
        "other_app_failure_modal "
        f"identity_source={metadata['identity_source']} "
        f"identity_class={metadata['identity_class']} "
        f"identity_sha256={metadata['identity_sha256']}"
    )


def write_app_failure_evidence(xml_text: str, logcat: str, safe_xml: Path, safe_logcat: Path) -> str:
    root = ET.fromstring(xml_text)
    state, _ = classify(xml_text, logcat)
    if state != "other_app_failure_modal":
        raise ValueError("not_app_failure_modal")
    metadata = app_failure_metadata(root, logcat)
    if (
        metadata["identity_source"] not in SAFE_IDENTITY_SOURCES
        or metadata["identity_class"] not in SAFE_IDENTITY_CLASSES
    ):
        raise ValueError("unsafe_identity")
    raw_xml = xml_text.encode("utf-8")
    raw_logcat = logcat.encode("utf-8")
    normalized = ET.Element(
        "app-failure-modal",
        {
            "schema-version": "1",
            "status": "app_failure_modal",
            "modal-kind": metadata["modal_kind"],
            "identity-source": metadata["identity_source"],
            "identity-class": metadata["identity_class"],
            "identity-sha256": metadata["identity_sha256"],
            "raw-xml-bytes": str(len(raw_xml)),
            "raw-xml-sha256": f"sha256:{hashlib.sha256(raw_xml).hexdigest()}",
            "raw-content-retained": "false",
        },
    )
    safe_xml.write_text(ET.tostring(normalized, encoding="unicode") + "\n")
    if re.search(r"\bANR in ", logcat):
        event_kind = "anr"
    elif "FATAL EXCEPTION:" in logcat or "Fatal signal" in logcat:
        event_kind = "fatal"
    else:
        event_kind = "dialog_only"
    safe_logcat.write_text(
        "\n".join(
            (
                "schema_version=1",
                "status=app_failure_modal",
                f"event_kind={event_kind}",
                f"identity_source={metadata['identity_source']}",
                f"identity_class={metadata['identity_class']}",
                f"identity_sha256={metadata['identity_sha256']}",
                f"raw_logcat_bytes={len(raw_logcat)}",
                f"raw_logcat_sha256=sha256:{hashlib.sha256(raw_logcat).hexdigest()}",
                "raw_logcat_retained=false",
            )
        )
        + "\n"
    )
    return format_app_failure_classification(metadata)


def classify(xml_text: str, logcat: str, anr_events: str = "") -> tuple[str, tuple[int, int] | None]:
    # Pi Droid failures always win over any system dialog. This prevents a
    # coincident System UI modal from hiding a product failure, including when
    # the structured event outlives the broad logcat tail.
    if has_pidroid_failure(logcat, anr_events):
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
        and system_ui_anr_correlated(logcat, anr_events)
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
    evidence_mode = len(argv) == 6 and argv[3] == "--write-app-failure-evidence"
    event_mode = len(argv) == 5 and argv[3] == "--system-anr-events"
    if len(argv) != 3 and not evidence_mode and not event_mode:
        print(
            "usage: emulator-ui-health.py XML LOGCAT "
            "[--system-anr-events EVENTS | --write-app-failure-evidence SAFE_XML SAFE_LOGCAT]",
            file=sys.stderr,
        )
        return 64
    try:
        xml_text = read_bounded(Path(argv[1]))
        logcat = read_bounded(Path(argv[2]))
        anr_events = read_bounded(Path(argv[4])) if event_mode else ""
    except (OSError, ValueError):
        print("evidence_unavailable" if evidence_mode else "ui_unavailable")
        return 70 if evidence_mode else 0
    if evidence_mode:
        try:
            print(write_app_failure_evidence(xml_text, logcat, Path(argv[4]), Path(argv[5])))
        except (OSError, ValueError, ET.ParseError):
            print("evidence_unavailable")
            return 70
        return 0
    state, center = classify(xml_text, logcat, anr_events)
    if state == "other_app_failure_modal":
        root = ET.fromstring(xml_text)
        print(format_app_failure_classification(app_failure_metadata(root, logcat)))
    elif center is None:
        print(state)
    else:
        print(state, center[0], center[1])
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
