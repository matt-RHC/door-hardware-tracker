"""
Golden file extraction tests.

Each test loads a real (anonymized) PDF from tests/golden_files/,
runs extraction, and compares against the expected JSON in tests/expected/.

To add a new golden test:
  1. Place the PDF in tests/golden_files/ (e.g., sample-s4h.pdf)
  2. Run: python tests/create_expected.py sample-s4h.pdf
     This extracts and writes tests/expected/sample-s4h.json
  3. Manually verify and correct the JSON (this becomes the source of truth)
  4. Add a test function below following the pattern

Naming convention:
  test_extract_<source>  — e.g., test_extract_comsense, test_extract_s4h
"""

import pytest
from pathlib import Path

GOLDEN_DIR = Path(__file__).parent / "golden_files"


def _golden_pdfs() -> list[str]:
    """Discover all golden PDFs for parametrized tests."""
    if not GOLDEN_DIR.exists():
        return []
    return sorted(f.name for f in GOLDEN_DIR.glob("*.pdf"))


# ---------------------------------------------------------------------------
# Parametrized test: runs against every golden file that has an expected JSON
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("pdf_name", _golden_pdfs() or ["no_golden_files"])
def test_extraction_accuracy(pdf_name, extract, load_expected, compare, assert_accuracy):
    """Test that extraction meets accuracy thresholds for each golden file."""
    if pdf_name == "no_golden_files":
        pytest.skip("No golden PDF files found in tests/golden_files/")

    result = extract(pdf_name)
    assert result["success"], f"Extraction failed: {result.get('error', 'unknown')}"

    expected = load_expected(pdf_name)
    accuracy = compare(result, expected)

    print(f"\n--- {pdf_name} ---")
    print(accuracy.summary())

    assert_accuracy(accuracy)


# ---------------------------------------------------------------------------
# Parametrized test: page classification
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("pdf_name", _golden_pdfs() or ["no_golden_files"])
def test_page_classification(pdf_name, classify):
    """Test that page classification identifies at least some content pages."""
    if pdf_name == "no_golden_files":
        pytest.skip("No golden PDF files found in tests/golden_files/")

    result = classify(pdf_name)
    assert result["success"]
    assert result["total_pages"] > 0

    summary = result["summary"]
    content_pages = summary["door_schedule_pages"] + summary["hardware_set_pages"]

    # A valid submittal should have at least some door schedule or hardware set pages
    assert content_pages > 0, (
        f"No content pages detected. Classification summary: {summary}"
    )


# ---------------------------------------------------------------------------
# Structural tests (no golden files required)
# ---------------------------------------------------------------------------


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
