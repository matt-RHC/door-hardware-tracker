"""
Filter-matrix tests for NON_HARDWARE_PATTERN.

Context: the 2026-04-17 Radius DC extraction regression
(run 5fd76705-b97a-49e9-888e-ddf4f0a34597) emitted 127 phantom structural
rows (51 "Door" + 76 "Frame") across 22-27 hardware sets, triggering 249
invariant violations. Root cause: hardware-set table column headers for
door-type / frame-type codes tokenized into the literal strings "Door"
and "Frame" and slipped past NON_HARDWARE_PATTERN as if they were real
hardware items. The TS buildPerOpeningItems helper then amplified them
into duplicated structural rows on every opening.

These tests pin the fix (the "|^(Door|Frame)\\s*$" alternation) so that:
  (a) bare "Door" / "Frame" (with optional surrounding whitespace, any
      case) are always filtered, and
  (b) legitimate hardware items that merely START with "Door" or "Frame"
      (e.g. "Door Sweep", "Frame Anchor") are NEVER filtered.
"""
import pytest

from extract_tables import NON_HARDWARE_PATTERN


@pytest.mark.parametrize("text", [
    "Door",
    "Frame",
    " Door ",
    " Frame ",
    "door",
    "frame",
    "DOOR",
    "FRAME",
    "Door\t",
    "\tFrame",
])
def test_filters_bare_door_frame_tokens(text):
    """Bare 'Door' / 'Frame' (any case, any surrounding whitespace) must
    be rejected as non-hardware."""
    assert NON_HARDWARE_PATTERN.search(text) is not None, (
        f"Expected bare token {text!r} to be filtered by NON_HARDWARE_PATTERN"
    )


@pytest.mark.parametrize("text", [
    "Door Sweep",
    "Door Silencer",
    "Door Viewer",
    "Door Stop",
    "Door Holder",
    "Door Closer",
    "Door Bottom",
    "Door Seal",
    "Frame Anchor",
    "Frame Silencer",
    "Frame Gasket",
    "Doorstop",
    "Framework",
])
def test_does_not_filter_real_hardware(text):
    """Legitimate hardware items that start with 'Door' or 'Frame' must
    pass through untouched. The \\s*$ anchor on the new branch is what
    keeps these safe — it requires end-of-string after the bare word."""
    assert NON_HARDWARE_PATTERN.search(text) is None, (
        f"Real hardware item {text!r} was incorrectly filtered by "
        f"NON_HARDWARE_PATTERN"
    )
