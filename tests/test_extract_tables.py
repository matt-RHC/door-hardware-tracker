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
            openings, _tables_found = extract_tables.extract_opening_list(pdf, None)
        assert len(openings) >= 1, f"Expected ≥1 opening, got {len(openings)}"


# ── BUG-1: Full PDF extraction works (no chunking needed) ──

class TestBug1FullPDFExtraction:
    """Verify that sending the entire PDF to pdfplumber finds doors."""

    def test_full_pdf_finds_doors(self, extract_tables, small_pdf_path):
        """Processing all pages at once returns doors (no chunk boundary issues)."""
        with pdfplumber.open(str(small_pdf_path)) as pdf:
            openings, _tables_found = extract_tables.extract_opening_list(pdf, None)
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
        # RPL10 3-segment alphanumeric format (S-045)
        "10.E1.03", "10.N2.01A", "10.S1.05B", "10.E2.06A",
        # Location-prefix door numbers (Task 3 / S-045)
        "ST-1", "ST-1A", "EL-1", "EX-1", "EY-001", "CORR-5",
        # MCN grid multi-letter suffix (S-066B)
        "10-03AB",
        # MCN revision suffix (S-066B)
        "10-82A.R1M", "10-82B.R1M",
        # MCN REV-embedded (S-066B, after space normalization)
        "09-15AREV1",
    ])
    def test_accepts_valid_doors(self, extract_tables, val):
        assert extract_tables.is_valid_door_number(val), (
            f"'{val}' should be accepted as a valid door number"
        )

    # S-066B: REV space normalization — pdfplumber may insert a space before REV
    def test_accepts_rev_with_space(self, extract_tables):
        """pdfplumber may extract '09-15A REV1' — space before REV should be normalized."""
        assert extract_tables.is_valid_door_number("09-15A REV1"), (
            "'09-15A REV1' should be accepted after REV space normalization"
        )

    # S-066B: BHMA finish code ranges should be REJECTED
    @pytest.mark.parametrize("val", ["615-622", "626-630", "600-699"])
    def test_rejects_bhma_finish_ranges(self, extract_tables, val):
        assert not extract_tables.is_valid_door_number(val), (
            f"'{val}' should be rejected as BHMA finish code range"
        )

    # S-066B: Leading-zero product codes should be REJECTED
    @pytest.mark.parametrize("val", ["0468", "0123", "0999"])
    def test_rejects_leading_zero_product_codes(self, extract_tables, val):
        assert not extract_tables.is_valid_door_number(val), (
            f"'{val}' should be rejected as leading-zero product code"
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


# ── Content-based structural table detection ──

class TestContentBasedDetection:
    """Verify detect_table_by_content() identifies tables by data patterns."""

    def test_recognizes_door_schedule_by_values(self, extract_tables):
        """A table with door numbers + set codes should be detected even with nonsense headers."""
        table = [
            ["Banana", "Apple", "Cherry", "Grape"],  # nonsense headers
            ["101", "DH1", "DH1.1", "LHR"],
            ["102", "DH1", "DH1.1", "RHR"],
            ["103A", "DH2", "DH2", "LH"],
            ["104", "DH2", "DH2.1", "RHR"],
            ["105", "DH3", "DH3", "LHR"],
            ["106A", "DH3", "DH3", "RHR"],
            ["107", "DH1", "DH1.1", "LHR"],
            ["108", "DH4", "DH4", "RHR"],
            ["109", "DH4", "DH4.1", "LHR"],
        ]
        result = extract_tables.detect_table_by_content(table)
        assert result is not None, "Should detect door schedule by data patterns"
        mapping, header_idx = result
        assert "door_number" in mapping
        assert "hw_set" in mapping or "hw_heading" in mapping

    def test_rejects_non_door_table(self, extract_tables):
        """A table without door numbers should not be detected."""
        table = [
            ["Name", "Email", "Phone"],
            ["John", "john@test.com", "555-1234"],
            ["Jane", "jane@test.com", "555-5678"],
            ["Bob", "bob@test.com", "555-9012"],
            ["Alice", "alice@test.com", "555-3456"],
            ["Eve", "eve@test.com", "555-7890"],
            ["Mallory", "mallory@test.com", "555-2345"],
            ["Trent", "trent@test.com", "555-6789"],
            ["Oscar", "oscar@test.com", "555-0123"],
            ["Peggy", "peggy@test.com", "555-4567"],
        ]
        result = extract_tables.detect_table_by_content(table)
        assert result is None, "Should not detect contact table as door schedule"

    def test_rejects_small_table(self, extract_tables):
        """Tables with fewer than min_data_rows should be rejected."""
        table = [
            ["Door", "Set"],
            ["101", "DH1"],
            ["102", "DH2"],
        ]
        result = extract_tables.detect_table_by_content(table)
        assert result is None, "Should reject table with too few rows"

    def test_score_column_door_numbers(self, extract_tables):
        """Column scoring should recognize door number columns."""
        cells = ["101", "102A", "103", "A104", "105B", "106", "107", "108"]
        score = extract_tables.score_column_by_values(cells, "door_number")
        assert score >= 0.5, f"Door number column should score >= 0.5, got {score}"

    def test_score_column_hand_values(self, extract_tables):
        """Column scoring should recognize hand columns."""
        cells = ["LHR", "RHR", "RHRA/LHR", "LH", "RH", "LHR", "RHR", "LHR"]
        score = extract_tables.score_column_by_values(cells, "hand")
        assert score >= 0.5, f"Hand column should score >= 0.5, got {score}"

    def test_score_column_random_text(self, extract_tables):
        """Random text should not score as door numbers."""
        cells = ["hello", "world", "foo", "bar", "testing", "random", "words", "here"]
        score = extract_tables.score_column_by_values(cells, "door_number")
        assert score < 0.3, f"Random text should score < 0.3 for door_number, got {score}"


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
        """Raw extraction quantities (before normalization) should not be absurdly high.

        NOTE: BUG-7 qty normalization runs in normalize_quantities(), not during
        extraction. Raw values here are project totals (e.g. 56 hinges = 4/door × 14 doors).
        Threshold of 250 catches true extraction errors while allowing project totals.
        """
        import pdfplumber
        with pdfplumber.open(str(medium_pdf_path)) as pdf:
            sets = extract_tables.extract_all_hardware_sets(pdf)
        for s in sets:
            for item in s.items:
                assert item.qty <= 250, (
                    f"Set {s.set_id}: '{item.name}' qty {item.qty} is unreasonably high"
                )


# ── BUG-12: Hardware item field concatenation splitting ──

class TestBug12FieldSplitting:
    """BUG-12: When pdfplumber reads all item details into a single name field,
    split_concatenated_hw_fields() must separate name/model/finish/manufacturer."""

    # --- Mode 1: Full concatenation splitting ---

    def test_split_hinge(self, extract_tables):
        """Standard hinge with model, finish, and mfr."""
        HardwareItem = extract_tables.HardwareItem
        item = HardwareItem(name="Hinges 5BB1 4 1/2 x 4 1/2 652 IV")
        result = extract_tables.split_concatenated_hw_fields(item)
        assert result.name == "Hinges"
        assert result.model == "5BB1 4 1/2 x 4 1/2"
        assert result.finish == "652"
        assert result.manufacturer == "IV"

    def test_split_closer(self, extract_tables):
        """Closer with options in model field."""
        HardwareItem = extract_tables.HardwareItem
        item = HardwareItem(name="Closer 4040XP RWPA TBWMS AL LC")
        result = extract_tables.split_concatenated_hw_fields(item)
        assert result.name == "Closer"
        assert result.model == "4040XP RWPA TBWMS"
        assert result.finish == "AL"
        assert result.manufacturer == "LC"

    def test_split_mortise_with_hand(self, extract_tables):
        """Mortise lockset — hand designation (RH) stays in model."""
        HardwareItem = extract_tables.HardwareItem
        item = HardwareItem(name="Mortise Privacy Set L9040 03N L283-722 L583-363 RH 626 SC")
        result = extract_tables.split_concatenated_hw_fields(item)
        assert result.name == "Mortise Privacy Set"
        assert "RH" in result.model
        assert result.finish == "626"
        assert result.manufacturer == "SC"

    def test_split_exit_device(self, extract_tables):
        """Exit device with complex model."""
        HardwareItem = extract_tables.HardwareItem
        item = HardwareItem(name="Exit Device 9447EO-F 48\" LBRAFL US26D VO")
        result = extract_tables.split_concatenated_hw_fields(item)
        assert result.name == "Exit Device"
        assert "9447EO-F" in result.model
        assert result.finish == "US26D"
        assert result.manufacturer == "VO"

    def test_split_continuous_hinge(self, extract_tables):
        """Continuous hinge — multi-word name."""
        HardwareItem = extract_tables.HardwareItem
        item = HardwareItem(name="Continuous Hinge 112XY 83\" EPT LH 628 IV")
        result = extract_tables.split_concatenated_hw_fields(item)
        assert result.name == "Continuous Hinge"
        assert "112XY" in result.model
        assert result.finish == "628"
        assert result.manufacturer == "IV"

    def test_split_flush_bolt(self, extract_tables):
        """Flush bolt with US-prefix finish."""
        HardwareItem = extract_tables.HardwareItem
        item = HardwareItem(name="Flush Bolt FB31T 36\" US32D IV")
        result = extract_tables.split_concatenated_hw_fields(item)
        assert result.name == "Flush Bolt"
        assert "FB31T" in result.model
        assert result.finish == "US32D"
        assert result.manufacturer == "IV"

    def test_split_weatherstrip_no_finish(self, extract_tables):
        """Weatherstrip — dimension at end is NOT a finish code."""
        HardwareItem = extract_tables.HardwareItem
        item = HardwareItem(name='Weatherstrip 8303AA 1 x 36" 2 x 84" ZE')
        result = extract_tables.split_concatenated_hw_fields(item)
        assert result.name == "Weatherstrip"
        assert result.manufacturer == "ZE"
        assert result.finish == ""  # dimensions are NOT finish codes
        assert '36"' in result.model

    def test_split_coordinator(self, extract_tables):
        """Coordinator with US-prefix finish."""
        HardwareItem = extract_tables.HardwareItem
        item = HardwareItem(name="Coordinator 3780 US28 AB")
        result = extract_tables.split_concatenated_hw_fields(item)
        assert result.name == "Coordinator"
        assert result.model == "3780"
        assert result.finish == "US28"
        assert result.manufacturer == "AB"

    def test_split_protection_plate(self, extract_tables):
        """Protection plate — multi-word name with dimensions in model."""
        HardwareItem = extract_tables.HardwareItem
        item = HardwareItem(name='Protection Plate 8400 10" X 34" B-CS US32D IV')
        result = extract_tables.split_concatenated_hw_fields(item)
        assert result.name == "Protection Plate"
        assert "8400" in result.model
        assert result.finish == "US32D"
        assert result.manufacturer == "IV"

    # --- Bypass / edge cases ---

    def test_skip_by_others(self, extract_tables):
        """BY OTHERS items are left unchanged."""
        HardwareItem = extract_tables.HardwareItem
        item = HardwareItem(name="Card Reader(By Others) CARD READER BY SECURITY VENDOR MISC")
        result = extract_tables.split_concatenated_hw_fields(item)
        assert result.name == item.name  # unchanged
        assert result.manufacturer == ""

    def test_skip_already_split(self, extract_tables):
        """Items with populated fields are not re-split."""
        HardwareItem = extract_tables.HardwareItem
        item = HardwareItem(name="Closer", manufacturer="LC", model="4040XP", finish="AL")
        result = extract_tables.split_concatenated_hw_fields(item)
        assert result.name == "Closer"
        assert result.manufacturer == "LC"
        assert result.model == "4040XP"
        assert result.finish == "AL"

    def test_skip_single_word(self, extract_tables):
        """Single-word items can't be split — returned unchanged."""
        HardwareItem = extract_tables.HardwareItem
        item = HardwareItem(name="Closer")
        result = extract_tables.split_concatenated_hw_fields(item)
        assert result.name == "Closer"
        assert result.manufacturer == ""

    def test_preserves_qty_fields(self, extract_tables):
        """Qty, qty_total, qty_door_count, qty_source are preserved."""
        HardwareItem = extract_tables.HardwareItem
        item = HardwareItem(
            qty=3, qty_total=30, qty_door_count=10,
            qty_source="divided", name="Hinges 5BB1 652 IV",
        )
        result = extract_tables.split_concatenated_hw_fields(item)
        assert result.qty == 3
        assert result.qty_total == 30
        assert result.qty_door_count == 10
        assert result.qty_source == "divided"
        assert result.name == "Hinges"

    # --- Mode 2: Truncated reassembly ---

    def test_reassemble_truncated_name_mfr(self, extract_tables):
        """mfr starts with lowercase → word continuation of name."""
        HardwareItem = extract_tables.HardwareItem
        item = HardwareItem(
            name="Mortise Passag", manufacturer="e Set",
            model="L9010 03N", finish="",
        )
        result = extract_tables.reassemble_truncated_fields(item)
        assert "Passage" in result.name or "Passag" in result.name
        assert result.manufacturer == ""
        assert result.model == ""

    def test_reassemble_protection_plate(self, extract_tables):
        """Short mfr fragment → truncation artifact."""
        HardwareItem = extract_tables.HardwareItem
        item = HardwareItem(
            name="Protection Plat", manufacturer="e",
            model='8400 10" X 34" B', finish="CS",
        )
        result = extract_tables.reassemble_truncated_fields(item)
        assert "Protection Plate" in result.name
        assert result.manufacturer == ""

    def test_no_reassemble_proper_split(self, extract_tables):
        """Properly split items are NOT reassembled."""
        HardwareItem = extract_tables.HardwareItem
        item = HardwareItem(
            name="Closer", manufacturer="LCN",
            model="4040XP RWPA", finish="689",
        )
        result = extract_tables.reassemble_truncated_fields(item)
        # LCN is a known mfr code with a real model → should NOT reassemble
        assert result.manufacturer == "LCN"
        assert result.model == "4040XP RWPA"

    # --- Garbage filter ---

    def test_filter_door_assignment_rows(self, extract_tables):
        """Door assignment rows are removed."""
        HardwareItem = extract_tables.HardwareItem
        items = [
            HardwareItem(name="Single Door #10-76A EXECUTIVE LARGE OFFICE RH"),
            HardwareItem(name="Hinges 5BB1 652 IV"),
            HardwareItem(name="Pair Doors #2.01.F.03 CORR. to ENTRANCE RHA"),
        ]
        result = extract_tables.filter_non_hardware_items(items)
        assert len(result) == 1
        assert result[0].name == "Hinges 5BB1 652 IV"

    def test_filter_sentence_fragments(self, extract_tables):
        """Sentence fragments from PDF notes are removed."""
        HardwareItem = extract_tables.HardwareItem
        items = [
            HardwareItem(name="ew carefully"),
            HardwareItem(name=": Some of the"),
            HardwareItem(name="nish. We have"),
            HardwareItem(name="Closer 4040XP AL LC"),
        ]
        result = extract_tables.filter_non_hardware_items(items)
        assert len(result) == 1
        assert result[0].name == "Closer 4040XP AL LC"

    def test_filter_keeps_real_hardware(self, extract_tables):
        """Real hardware items are NOT filtered out."""
        HardwareItem = extract_tables.HardwareItem
        items = [
            HardwareItem(name="Hinges 5BB1 4 1/2 x 4 1/2 652 IV"),
            HardwareItem(name="Closer 4040XP RWPA TBWMS AL LC"),
            HardwareItem(name="Exit Device 9447EO-F 48\" LBRAFL US26D VO"),
            HardwareItem(name="Card Reader(By Others) CARD READER BY SECURITY VENDOR MISC"),
        ]
        result = extract_tables.filter_non_hardware_items(items)
        assert len(result) == 4  # all kept
