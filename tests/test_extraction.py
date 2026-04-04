"""
Extraction model and validation tests.

Structural tests for Pydantic models, door number validation, and quantity ranges.
These tests do not require golden PDF files.

# TODO: Golden file accuracy tests need:
#   1. tests/golden_files/ directory with anonymized PDFs
#   2. tests/expected/ directory with verified JSON baselines
#   3. conftest.py fixtures: extract, load_expected, compare, assert_accuracy, classify
#   See tests/create_expected.py for the baseline generator tool.
"""

import pytest


class TestExtractionModels:
    """Test that Pydantic models serialize correctly."""

    def test_extraction_result_default(self):
        import extract_tables as mod

        result = mod.ExtractionResult(success=False, error="test error")
        d = result.model_dump()
        assert d["success"] is False
        assert d["error"] == "test error"
        assert d["openings"] == []
        assert d["hardware_sets"] == []
        assert d["confidence"] == "high"

    def test_hardware_item_qty_metadata(self):
        import extract_tables as mod

        item = mod.HardwareItem(
            qty=3, qty_total=9, qty_door_count=3,
            qty_source="divided", name="Hinge",
        )
        d = item.model_dump()
        assert d["qty"] == 3
        assert d["qty_total"] == 9
        assert d["qty_source"] == "divided"


class TestDoorNumberValidation:
    """Test door number pattern consensus logic."""

    def test_consistent_pattern(self):
        import extract_tables as mod

        doors = [
            mod.DoorEntry(door_number="101-01"),
            mod.DoorEntry(door_number="101-02"),
            mod.DoorEntry(door_number="102-01"),
            mod.DoorEntry(door_number="102-03A"),
        ]
        confirmed, flagged = mod.validate_door_number_consistency(doors)
        # All follow a similar pattern, should mostly pass
        assert len(confirmed) >= 3

    def test_outlier_flagged(self):
        import extract_tables as mod

        doors = [
            mod.DoorEntry(door_number="101-01"),
            mod.DoorEntry(door_number="101-02"),
            mod.DoorEntry(door_number="102-01"),
            mod.DoorEntry(door_number="102-02"),
            mod.DoorEntry(door_number="N/A"),  # outlier
        ]
        confirmed, flagged = mod.validate_door_number_consistency(doors)
        flagged_nums = [f.door.door_number for f in flagged]
        assert "N/A" in flagged_nums


class TestQuantityRanges:
    """Test category-aware quantity validation ranges."""

    def test_hinge_range(self):
        import extract_tables as mod

        low, high = mod.EXPECTED_QTY_RANGES["hinge"]
        assert low == 2
        assert high == 5

    def test_lockset_range(self):
        import extract_tables as mod

        low, high = mod.EXPECTED_QTY_RANGES["lockset"]
        assert low == 1
        assert high == 1
