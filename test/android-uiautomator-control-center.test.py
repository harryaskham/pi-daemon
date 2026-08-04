#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
HELPER = ROOT / "android/build-logic/uiautomator-control-center.py"
FIXTURE = ROOT / "fixtures/android/uiautomator.request-control.xml"
SPEC = importlib.util.spec_from_file_location("uiautomator_control_center", HELPER)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class ControlCenterTest(unittest.TestCase):
    def test_visible_text_climbs_to_clickable_button_bounds(self) -> None:
        self.assertEqual((819, 1734), MODULE.control_center(FIXTURE, "Request control"))

    def test_semantics_description_uses_same_clickable_bounds(self) -> None:
        self.assertEqual((819, 1734), MODULE.control_center(FIXTURE, "Request session control"))

    def test_missing_control_fails_closed(self) -> None:
        with self.assertRaisesRegex(ValueError, "control not found"):
            MODULE.control_center(FIXTURE, "Not present")


if __name__ == "__main__":
    unittest.main()
