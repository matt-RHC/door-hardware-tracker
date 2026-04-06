"""
Tests for BUG-9: Quantity normalization in api/extract-tables.py.

Covers:
  - Float division fix: modulo-based even-division check (IEEE 754 safe)
  - Pair door leaf count: fallback uses opening list door_type
  - Single door leaf count: leaf_count == door_count when all singles
  - Zero door count edge case
  - Golden PDF regression tests (SMALL, MEDIUM, LARGE)
"""
import pdfplumber
import pytest


# ── Unit tests: modulo-based division check ──

class TestQuantityDivision:
    """Verify normalize_quantities uses integer modulo, not float equality."""

    def _make_set(self, et, qty, door_count, leaf_count):
        """Create a HardwareSetDef with one hinge item."""
        return et.HardwareSetDef(
            set_id="TEST",
            generic_set_id="TEST",
            heading="Test Set",
            heading_door_count=door_count,
            heading_leaf_count=leaf_count,
            items=[
                et.HardwareItem(qty=qty, name="Hinge, Full Mortise"),
            ],
        )

    def test_exact_division_by_leaves(self, extract_tables):
        """12 hinges ÷ 4 leaves = 3 per leaf (exact division)."""
        hw = self._make_set(extract_tables, qty=12, door_count=2, leaf_count=4)
        extract_tables.normalize_quantities([hw], [])
        item = hw.items[0]
        assert item.qty == 3
        assert item.qty_source == "divided"
        assert item.qty_total == 12
        assert item.qty_door_count == 4

    def test_non_exact_division_not_divided(self, extract_tables):
        """13 hinges ÷ 4 leaves → not evenly divisible, should not divide."""
        hw = self._make_set(extract_tables, qty=13, door_count=2, leaf_count=4)
        extract_tables.normalize_quantities([hw], [])
        item = hw.items[0]
        # 13 doesn't divide evenly by 4 or 2; should remain as-is or flagged
        assert item.qty_source != "divided"

    def test_division_by_openings_when_leaves_dont_divide(self, extract_tables):
        """10 items ÷ 5 openings = 2 per opening (leaf division fails first)."""
        hw = self._make_set(extract_tables, qty=10, door_count=5, leaf_count=7)
        extract_tables.normalize_quantities([hw], [])
        item = hw.items[0]
        assert item.qty == 2
        assert item.qty_source == "divided"
        assert item.qty_door_count == 5

    def test_large_exact_division(self, extract_tables):
        """42 hinges ÷ 14 leaves = 3 per leaf (the actual BUG-9 scenario)."""
        hw = self._make_set(extract_tables, qty=42, door_count=7, leaf_count=14)
        extract_tables.normalize_quantities([hw], [])
        item = hw.items[0]
        assert item.qty == 3, f"Expected 3, got {item.qty} (BUG-9 regression)"
        assert item.qty_source == "divided"


# ── Unit tests: pair door leaf count from opening list ──

class TestPairDoorLeafCount:
    """Verify _leaf_count_from_openings detects pair doors in opening list."""

    def test_pair_doors_double_leaf_count(self, extract_tables):
        """3 pair openings → 6 leaves."""
        openings = [
            extract_tables.DoorEntry(door_number="101", hw_heading="A", door_type="PR"),
            extract_tables.DoorEntry(door_number="102", hw_heading="A", door_type="Pair"),
            extract_tables.DoorEntry(door_number="103", hw_heading="A", door_type="pair"),
        ]
        result = extract_tables._leaf_count_from_openings(
            openings, "hw_heading", "A", 3
        )
        assert result == 6

    def test_single_doors_equal_leaf_count(self, extract_tables):
        """3 single openings → 3 leaves."""
        openings = [
            extract_tables.DoorEntry(door_number="101", hw_heading="A", door_type="SGL"),
            extract_tables.DoorEntry(door_number="102", hw_heading="A", door_type="Single"),
            extract_tables.DoorEntry(door_number="103", hw_heading="A", door_type=""),
        ]
        result = extract_tables._leaf_count_from_openings(
            openings, "hw_heading", "A", 3
        )
        assert result == 3

    def test_mixed_pair_and_single(self, extract_tables):
        """2 pairs + 1 single = 5 leaves."""
        openings = [
            extract_tables.DoorEntry(door_number="101", hw_heading="B", door_type="PR"),
            extract_tables.DoorEntry(door_number="102", hw_heading="B", door_type="PR"),
            extract_tables.DoorEntry(door_number="103", hw_heading="B", door_type="SGL"),
        ]
        result = extract_tables._leaf_count_from_openings(
            openings, "hw_heading", "B", 3
        )
        assert result == 5

    def test_zero_door_count_returns_zero(self, extract_tables):
        """door_count=0 → leaf_count=0 regardless of openings."""
        openings = [
            extract_tables.DoorEntry(door_number="101", hw_heading="C", door_type="PR"),
        ]
        result = extract_tables._leaf_count_from_openings(
            openings, "hw_heading", "C", 0
        )
        assert result == 0

    def test_no_matching_openings_falls_back(self, extract_tables):
        """No openings match → falls back to door_count."""
        openings = [
            extract_tables.DoorEntry(door_number="101", hw_heading="X", door_type="PR"),
        ]
        result = extract_tables._leaf_count_from_openings(
            openings, "hw_heading", "Z", 5
        )
        assert result == 5

    def test_match_by_hw_set_field(self, extract_tables):
        """Matching via hw_set field (fallback 2 path)."""
        openings = [
            extract_tables.DoorEntry(door_number="101", hw_set="04", door_type="Pair"),
            extract_tables.DoorEntry(door_number="102", hw_set="04", door_type=""),
        ]
        result = extract_tables._leaf_count_from_openings(
            openings, "hw_set", "04", 2
        )
        assert result == 3  # 1 pair (2 leaves) + 1 single (1 leaf)


# ── Unit tests: normalize_quantities with opening list fallback ──

class TestNormalizeWithOpeningsFallback:
    """Verify normalize_quantities uses opening list pair info when heading
    door count is zero (fallback paths)."""

    def test_pair_opening_fallback_divides_correctly(self, extract_tables):
        """Set with 0 heading counts but opening list has 3 pair doors →
        qty 18 ÷ 6 leaves = 3."""
        hw = extract_tables.HardwareSetDef(
            set_id="A",
            generic_set_id="A",
            heading="Test",
            heading_door_count=0,
            heading_leaf_count=0,
            items=[
                extract_tables.HardwareItem(qty=18, name="Hinge, Full Mortise"),
            ],
        )
        openings = [
            extract_tables.DoorEntry(door_number="101", hw_heading="A", door_type="PR"),
            extract_tables.DoorEntry(door_number="102", hw_heading="A", door_type="PR"),
            extract_tables.DoorEntry(door_number="103", hw_heading="A", door_type="PR"),
        ]
        extract_tables.normalize_quantities([hw], openings)
        item = hw.items[0]
        assert item.qty == 3
        assert item.qty_source == "divided"


# ── Golden PDF regression tests ──

class TestGoldenPDFQuantities:
    """Regression tests: quantities normalized correctly for golden PDFs."""

    def test_small_pdf_no_qty_42(self, extract_tables, pipeline_results):
        """SMALL PDF: no hinge item should have qty=42 (the BUG-9 symptom)."""
        result = pipeline_results.get("SMALL")
        if result is None:
            pytest.skip("SMALL PDF not available")
        hw_sets = result[0]
        for hw_set in hw_sets:
            for item in hw_set.items:
                if "hinge" in item.name.lower():
                    assert item.qty != 42, (
                        f"BUG-9 regression: {hw_set.set_id} '{item.name}' "
                        f"still showing qty=42"
                    )

    def test_small_pdf_hinges_reasonable(self, extract_tables, pipeline_results):
        """SMALL PDF: hinge quantities should be ≤ 6 per leaf (reasonable max)."""
        result = pipeline_results.get("SMALL")
        if result is None:
            pytest.skip("SMALL PDF not available")
        hw_sets = result[0]
        for hw_set in hw_sets:
            for item in hw_set.items:
                if "hinge" in item.name.lower() and item.qty_source == "divided":
                    assert item.qty <= 6, (
                        f"{hw_set.set_id} '{item.name}' has qty={item.qty}, "
                        f"expected ≤6 per opening/leaf"
                    )

    def test_medium_pdf_quantities_normalized(self, extract_tables, pipeline_results):
        """MEDIUM PDF: all divided items should have reasonable per-unit qty."""
        result = pipeline_results.get("MEDIUM")
        if result is None:
            pytest.skip("MEDIUM PDF not available")
        hw_sets = result[0]
        for hw_set in hw_sets:
            for item in hw_set.items:
                if item.qty_source == "divided":
                    assert item.qty <= 20, (
                        f"{hw_set.set_id} '{item.name}' qty={item.qty} "
                        f"seems too high for per-unit"
                    )
                    assert item.qty_total is not None
                    assert item.qty_door_count is not None

    def test_large_mca_quantities_normalized(self, extract_tables, pipeline_results):
        """LARGE MCA PDF: all divided items should have reasonable per-unit qty."""
        result = pipeline_results.get("LARGE")
        if result is None:
            pytest.skip("LARGE MCA PDF not available")
        hw_sets = result[0]
        for hw_set in hw_sets:
            for item in hw_set.items:
                if item.qty_source == "divided":
                    assert item.qty <= 20, (
                        f"{hw_set.set_id} '{item.name}' qty={item.qty} "
                        f"seems too high for per-unit"
                    )
