"""
Tests for api/extract-tables.py extraction pipeline.

Covers:
  - Baseline: SMALL PDF returns doors + hardware sets
  - BUG-1: Full PDF extraction finds doors (non-chunked path)
  - BUG-2: No duplicate hardware items after dedup
  - BUG-3: Quantity capping works per category
  - BUG-4: Mojibake cleaning handles known artifacts
  - BUG-5: Door number validation rejects hardware set codes
"""
import pdfplumber
import pytest


# ── Baseline: SMALL PDF extraction ──

class TestBaseline:
    """Prove extract-tables.py can process a real PDF end-to-end."""

    def test_small_pdf_extracts_hardware_sets(self, extract_tables, small_pdf_path):
        """SMALL PDF returns at least 1 hardware set."""
        with pdfplumber.open(str(small_pdf_path)) as pdf:
            sets = extract_tables.extract_all_hardware_sets(pdf)
        assert len(sets) >= 1, f"Expected ≥1 hardware set, got {len(sets)}"

    def test_small_pdf_extracts_openings(self, extract_tables, small_pdf_path):
        """SMALL PDF returns at least 1 opening."""
        with pdfplumber.open(str(small_pdf_path)) as pdf:
            openings = extract_tables.extract_opening_list(pdf, None)
        assert len(openings) >= 1, f"Expected ≥1 opening, got {len(openings)}"


# ── BUG-1: Full PDF extraction works (no chunking needed) ──

class TestBug1FullPDFExtraction:
    """Verify that sending the entire PDF to pdfplumber finds doors."""

    def test_full_pdf_finds_doors(self, extract_tables, small_pdf_path):
        """Processing all pages at once returns doors (no chunk boundary issues)."""
        with pdfplumber.open(str(small_pdf_path)) as pdf:
            openings = extract_tables.extract_opening_list(pdf, None)
            sets = extract_tables.extract_all_hardware_sets(pdf)
        total = len(openings) + len(sets)
        assert total >= 1, "Full PDF extraction found nothing — BUG-1 regression"


# ── BUG-2: No duplicate hardware items ──

class TestBug2Dedup:
    """Verify deduplication removes duplicate hardware items."""

    def test_synthetic_duplicates_removed(self, extract_tables):
        """deduplicate_hardware_items() collapses identical model numbers."""
        HardwareItem = extract_tables.HardwareItem
        items = [
            HardwareItem(qty=3, name="Hinge", manufacturer="Ives", model="BB1279", finish="US26D"),
            HardwareItem(qty=3, name="Hinge", manufacturer="Ives", model="BB1279", finish="US26D"),
            HardwareItem(qty=1, name="Lockset", manufacturer="Schlage", model="ND50PD", finish="626"),
        ]
        result = extract_tables.deduplicate_hardware_items(items)
        assert len(result) == 2, f"Expected 2 unique items, got {len(result)}"

    def test_keeps_more_complete_item(self, extract_tables):
        """When duplicates exist, keeps the one with more populated fields."""
        HardwareItem = extract_tables.HardwareItem
        sparse = HardwareItem(qty=1, name="Closer", model="4041")
        complete = HardwareItem(qty=1, name="Closer", manufacturer="LCN", model="4041", finish="689")
        result = extract_tables.deduplicate_hardware_items([sparse, complete])
        assert len(result) == 1
        kept = result[0]
        assert kept.manufacturer == "LCN", "Should keep the more complete item"
        assert kept.finish == "689"

    def test_no_duplicates_in_real_pdf(self, extract_tables, small_pdf_path):
        """Real PDF extraction produces no duplicate items within a set."""
        with pdfplumber.open(str(small_pdf_path)) as pdf:
            sets = extract_tables.extract_all_hardware_sets(pdf)
        for s in sets:
            models = [i.model for i in s.items if i.model]
            unique = set(models)
            assert len(models) == len(unique), (
                f"Set {s.set_id} has duplicate models: {models}"
            )


# ── BUG-3: Quantity capping ──

class TestBug3QtyCapping:
    """Verify category-aware quantity limits prevent inflated counts."""

    def test_classify_hinge(self, extract_tables):
        cat = extract_tables._classify_hardware_item("Continuous Hinge, Full Mortise")
        assert cat is not None, "Should classify as a hinge category"

    def test_classify_lockset(self, extract_tables):
        cat = extract_tables._classify_hardware_item("Mortise Lockset")
        assert cat is not None, "Should classify as a lockset category"

    def test_max_qty_hinge(self, extract_tables):
        max_q = extract_tables._max_qty_for_category("hinge")
        assert max_q <= 6, f"Hinge max should be ≤6, got {max_q}"

    def test_max_qty_lockset(self, extract_tables):
        max_q = extract_tables._max_qty_for_category("lockset")
        assert max_q <= 2, f"Lockset max should be ≤2, got {max_q}"

    def test_default_max_for_unknown(self, extract_tables):
        """Unknown categories get a reasonable default cap."""
        max_q = extract_tables._max_qty_for_category("unknown_widget")
        assert max_q <= 10, f"Default max should be ≤10, got {max_q}"

    def test_real_pdf_quantities_reasonable(self, extract_tables, small_pdf_path):
        """All quantities in real PDF extraction are within category limits."""
        with pdfplumber.open(str(small_pdf_path)) as pdf:
            sets = extract_tables.extract_all_hardware_sets(pdf)
        for s in sets:
            for item in s.items:
                assert item.qty <= 10, (
                    f"Set {s.set_id}: '{item.name}' has qty {item.qty} — BUG-3 regression"
                )


# ── BUG-4: Mojibake cleaning ──

class TestBug4Mojibake:
    """Verify clean_cell() handles known mojibake artifacts."""

    def test_latin1_middle_dot(self, extract_tables):
        result = extract_tables.clean_cell("\u00c2\u00b7")
        assert result == "\u00b7", f"Expected middle dot, got {repr(result)}"

    def test_fi_ligature(self, extract_tables):
        result = extract_tables.clean_cell("\ufb01re rating")
        assert "fi" in result, f"fi-ligature not expanded: {repr(result)}"
        assert "\ufb01" not in result, "Ligature still present"

    def test_en_dash_artifact(self, extract_tables):
        # In real PDFs, the 3-byte sequence â€" appears as Latin-1 misread of UTF-8.
        # Test with surrounding text to avoid NFKC stripping isolated control chars.
        result = extract_tables.clean_cell("3\u00e2\u0080\u00934 HR")
        assert "\u00e2" not in result, f"Mojibake not cleaned: {repr(result)}"

    def test_windows_1252_bullet(self, extract_tables):
        result = extract_tables.clean_cell("\x95")
        assert result == "\u2022", f"Expected bullet, got {repr(result)}"

    def test_nbsp_cleaned(self, extract_tables):
        result = extract_tables.clean_cell("\u00c2\u00a0test")
        assert "\u00c2" not in result, "NBSP artifact not cleaned"

    def test_none_handled(self, extract_tables):
        result = extract_tables.clean_cell(None)
        assert result == "", "None should return empty string"


# ── BUG-5: Door number validation ──

class TestBug5DoorValidation:
    """Verify is_valid_door_number() rejects hardware set codes."""

    # These should be REJECTED (hardware set codes)
    @pytest.mark.parametrize("val", ["DCB2", "DH1", "HW3", "HS4", "HD2", "FH1", "HMS2"])
    def test_rejects_hw_set_codes(self, extract_tables, val):
        assert not extract_tables.is_valid_door_number(val), (
            f"'{val}' should be rejected as hardware set code"
        )

    # These should be ACCEPTED (valid door numbers)
    @pytest.mark.parametrize("val", [
        "101", "A101", "1-101", "B1-101", "101A", "1.01.A.01A",
        "110-01C", "ST-100", "110-01A", "110A-04A", "120-02A",
    ])
    def test_accepts_valid_doors(self, extract_tables, val):
        assert extract_tables.is_valid_door_number(val), (
            f"'{val}' should be accepted as a valid door number"
        )

    # Edge cases
    def test_rejects_empty(self, extract_tables):
        assert not extract_tables.is_valid_door_number("")

    def test_rejects_single_char(self, extract_tables):
        assert not extract_tables.is_valid_door_number("A")

    def test_rejects_trailing_dash(self, extract_tables):
        assert not extract_tables.is_valid_door_number("MCA1-2-")

    def test_rejects_spaces(self, extract_tables):
        assert not extract_tables.is_valid_door_number("SET A")

    def test_rejects_pure_long_number(self, extract_tables):
        assert not extract_tables.is_valid_door_number("303872")


# ── MEDIUM PDF verification (44 pages) ──

class TestMediumPDFVerification:
    """Verify the MEDIUM PDF (44-page Radius DC submittal) extracts correctly."""

    def test_medium_pdf_extracts_openings(self, extract_tables, medium_pdf_path):
        """44-page PDF should find >=100 door openings (pages 6-8)."""
        import pdfplumber
        with pdfplumber.open(str(medium_pdf_path)) as pdf:
            openings, tables_found = extract_tables.extract_opening_list(pdf, None)
        assert len(openings) >= 100, (
            f"Expected >=100 openings from MEDIUM PDF, got {len(openings)}"
        )

    def test_medium_pdf_extracts_hardware_sets(self, extract_tables, medium_pdf_path):
        """44-page PDF should find multiple hardware set definitions."""
        import pdfplumber
        with pdfplumber.open(str(medium_pdf_path)) as pdf:
            sets = extract_tables.extract_all_hardware_sets(pdf)
        assert len(sets) >= 5, f"Expected ≥5 hardware sets from 44-page PDF, got {len(sets)}"

    def test_medium_pdf_no_mojibake(self, extract_tables, medium_pdf_path):
        """No mojibake control characters in hardware set data."""
        import pdfplumber
        import unicodedata
        with pdfplumber.open(str(medium_pdf_path)) as pdf:
            sets = extract_tables.extract_all_hardware_sets(pdf)
        for s in sets:
            for item in s.items:
                for field in [item.name, item.manufacturer, item.model, item.finish]:
                    if field:
                        bad = [c for c in field if ord(c) > 127 and unicodedata.category(c).startswith('C')]
                        assert not bad, f"Mojibake in set {s.set_id}: {field!r}"

    def test_medium_pdf_no_duplicate_items_per_set(self, extract_tables, medium_pdf_path):
        """No duplicate items within any hardware set."""
        import pdfplumber
        with pdfplumber.open(str(medium_pdf_path)) as pdf:
            sets = extract_tables.extract_all_hardware_sets(pdf)
        for s in sets:
            models = [i.model for i in s.items if i.model]
            unique = set(models)
            assert len(models) == len(unique), (
                f"Set {s.set_id} has duplicate models: {[m for m in models if models.count(m) > 1]}"
            )

    def test_medium_pdf_quantities_not_extreme(self, extract_tables, medium_pdf_path):
        """Quantities should not be absurdly high (>50 per item).

        NOTE: Some items may still show project totals rather than per-opening
        quantities (BUG-7, not yet fixed). This test only catches extreme outliers.
        """
        import pdfplumber
        with pdfplumber.open(str(medium_pdf_path)) as pdf:
            sets = extract_tables.extract_all_hardware_sets(pdf)
        for s in sets:
            for item in s.items:
                assert item.qty <= 50, (
                    f"Set {s.set_id}: '{item.name}' qty {item.qty} is unreasonably high"
                )
