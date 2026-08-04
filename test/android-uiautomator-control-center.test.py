#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import tempfile
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

    def test_zero_and_offscreen_bounds_fail_closed(self) -> None:
        source = FIXTURE.read_text()
        for bounds in ("[0,0][0,0]", "[626,1672][1200,1798]", "[-10,10][50,50]"):
            with self.subTest(bounds=bounds), tempfile.TemporaryDirectory() as directory:
                fixture = Path(directory) / "window.xml"
                fixture.write_text(source.replace("[626,1682][1012,1787]", bounds))
                with self.assertRaisesRegex(ValueError, "invalid or offscreen bounds"):
                    MODULE.control_center(fixture, "Request control")

    def test_hidden_or_disabled_control_fails_closed(self) -> None:
        source = FIXTURE.read_text()
        variants = (
            source.replace('clickable="true" enabled="true"', 'clickable="true" enabled="true" visible-to-user="false"'),
            source.replace('clickable="true" enabled="true"', 'clickable="true" enabled="false"'),
        )
        for index, variant in enumerate(variants):
            with self.subTest(index=index), tempfile.TemporaryDirectory() as directory:
                fixture = Path(directory) / "window.xml"
                fixture.write_text(variant)
                with self.assertRaisesRegex(ValueError, "not visible and enabled"):
                    MODULE.control_center(fixture, "Request control")


if __name__ == "__main__":
    unittest.main()
