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


# ── D1: Phantom set filtering ──

class TestPhantomSetFiltering:
    """Verify that phantom empty sets are dropped."""

    def test_drops_phantom_set(self, extract_tables):
        HardwareSetDef = extract_tables.HardwareSetDef
        sets = [
            HardwareSetDef(set_id="DH-1", heading="Corridor", heading_door_count=3, items=[
                extract_tables.HardwareItem(name="Hinges"),
            ]),
            HardwareSetDef(set_id="DH-4", heading="", heading_door_count=0, heading_doors=[], items=[]),
            HardwareSetDef(set_id="DH-2", heading="Office", heading_door_count=1, items=[
                extract_tables.HardwareItem(name="Closer"),
            ]),
        ]
        # Simulate the filter logic from extract_all_hardware_sets
        result = [
            s for s in sets
            if s.heading.strip() or s.heading_door_count > 0 or len(s.heading_doors) > 0 or len(s.items) > 0
        ]
        assert len(result) == 2
        assert result[0].set_id == "DH-1"
        assert result[1].set_id == "DH-2"

    def test_keeps_set_with_heading_only(self, extract_tables):
        HardwareSetDef = extract_tables.HardwareSetDef
        sets = [
            HardwareSetDef(set_id="DH-4", heading="Storage Room", heading_door_count=0, items=[]),
        ]
        result = [
            s for s in sets
            if s.heading.strip() or s.heading_door_count > 0 or len(s.heading_doors) > 0 or len(s.items) > 0
        ]
        assert len(result) == 1, "Set with heading text should be kept"

    def test_keeps_set_with_doors_only(self, extract_tables):
        HardwareSetDef = extract_tables.HardwareSetDef
        sets = [
            HardwareSetDef(set_id="DH-4", heading="", heading_door_count=0, heading_doors=["101A"], items=[]),
        ]
        result = [
            s for s in sets
            if s.heading.strip() or s.heading_door_count > 0 or len(s.heading_doors) > 0 or len(s.items) > 0
        ]
        assert len(result) == 1, "Set with heading_doors should be kept"


# ── D3: Join split rows ──

class TestJoinSplitRows:
    """Verify post-processing joins split rows from pdfplumber column splits."""

    def test_joins_others_fragment(self, extract_tables):
        """'Others)' fragment joins into previous row."""
        HardwareItem = extract_tables.HardwareItem
        items = [
            HardwareItem(name="Hardware by", model="(Contractor", finish=""),
            HardwareItem(name="Others)", model="CONTRACTOR", finish=""),
        ]
        result = extract_tables._join_split_rows(items)
        assert len(result) == 1
        assert "Others)" in result[0].model

    def test_joins_short_fragment(self, extract_tables):
        """Very short name fragments (< 4 chars) are joined."""
        HardwareItem = extract_tables.HardwareItem
        items = [
            HardwareItem(name="Hinges", model="5BB1", finish="626"),
            HardwareItem(name=")", model="", finish=""),
        ]
        result = extract_tables._join_split_rows(items)
        assert len(result) == 1
        assert result[0].name == "Hinges"

    def test_preserves_valid_items(self, extract_tables):
        """Normal items with proper names are not merged."""
        HardwareItem = extract_tables.HardwareItem
        items = [
            HardwareItem(name="Hinges", model="5BB1", finish="626"),
            HardwareItem(name="Closer", model="4040XP", finish="689"),
        ]
        result = extract_tables._join_split_rows(items)
        assert len(result) == 2

    def test_single_item_unchanged(self, extract_tables):
        HardwareItem = extract_tables.HardwareItem
        items = [HardwareItem(name="Hinges", model="5BB1", finish="626")]
        result = extract_tables._join_split_rows(items)
        assert len(result) == 1


# ── Heading door metadata parsing (Prompt 2 cross-reference) ──

class TestHeadingDoorMetadata:
    """
    Heading blocks in hardware schedule pages carry per-door location + hand
    on the same line as the door number. Prompt 2 requires capturing those
    fields (previously only location was captured; hand was dropped).
    """

    def test_parse_location_and_hand(self, extract_tables):
        """Per-door heading line yields both location and hand."""
        loc, hand = extract_tables.parse_heading_door_metadata(
            " RECEPTION 101 to LARGE CONF. ROOM 102 LH"
        )
        assert loc == "RECEPTION 101 to LARGE CONF. ROOM 102"
        assert hand == "LH"

    def test_parse_rhr_hand(self, extract_tables):
        loc, hand = extract_tables.parse_heading_door_metadata(
            " RECEPTION 101 from CORRIDOR 110 RHR"
        )
        assert loc == "RECEPTION 101 from CORRIDOR 110"
        assert hand == "RHR"

    def test_parse_rhra_hand(self, extract_tables):
        """RHRA / LHRA are the pair-door active/inactive hand codes."""
        loc, hand = extract_tables.parse_heading_door_metadata(
            " CORR. to ENTRANCE RHRA"
        )
        assert loc == "CORR. to ENTRANCE"
        assert hand == "RHRA"

    def test_parse_degree_prefixed_hand(self, extract_tables):
        """Degree-prefixed hand (e.g. '90° LH') is captured, location is stripped."""
        loc, hand = extract_tables.parse_heading_door_metadata(
            " CORR 10-90 to STOR 10-01 90° LH"
        )
        assert loc == "CORR 10-90 to STOR 10-01"
        assert hand == "LH"

    def test_parse_location_only(self, extract_tables):
        """Location without hand: hand is empty, location fully captured."""
        loc, hand = extract_tables.parse_heading_door_metadata(
            " SOCIAL HUB 09-13 from 9TH FLOOR"
        )
        assert loc == "SOCIAL HUB 09-13 from 9TH FLOOR"
        assert hand == ""

    def test_parse_empty(self, extract_tables):
        loc, hand = extract_tables.parse_heading_door_metadata("")
        assert loc == ""
        assert hand == ""

    def test_parse_pair_door_split_hand(self, extract_tables):
        """Pair doors sometimes record one hand per leaf with a '\\'
        separator (e.g. 'LHR\\RHR')."""
        loc, hand = extract_tables.parse_heading_door_metadata(
            " Phase 1B Area 6 6100 from Sorting 6101 LHR\\RHR"
        )
        assert loc == "Phase 1B Area 6 6100 from Sorting 6101"
        assert hand == "LHR\\RHR"


class TestExtractDoorsFromSetHeadings:
    """
    Integration of parse_heading_door_metadata into the heading-block extractor.
    A DoorEntry built from a hardware-schedule heading line must carry both
    location AND hand (prior behavior captured only location).
    """

    def test_extract_doors_populates_hand(self, extract_tables, tmp_path):
        """The DoorEntry.hand field is populated from heading door lines."""

        class _FakePage:
            def __init__(self, text):
                self._text = text

            def extract_text(self):
                return self._text

        class _FakePdf:
            def __init__(self, pages):
                self.pages = pages

        pdf = _FakePdf([
            _FakePage(
                "Heading #H01 (Set #H01)\n"
                "1 Single Door #E102 RECEPTION 101 to LARGE CONF. ROOM 102 LH\n"
                "1 Single Door #113 OFFICE (B) 114 to SM. CONF. ROOM 113 RH\n"
                "Opening Description: 3' 0\" x 7' 0\" Type AL-SF Type AL-SF\n"
                "12 Hinges 5BB1 4 1/2 x 4 1/2 652 IV\n"
            )
        ])

        doors = extract_tables.extract_doors_from_set_headings(pdf)
        by_num = {d.door_number: d for d in doors}

        assert "E102" in by_num
        assert by_num["E102"].location == "RECEPTION 101 to LARGE CONF. ROOM 102"
        assert by_num["E102"].hand == "LH"
        assert by_num["E102"].hw_set == "H01"

        assert "113" in by_num
        assert by_num["113"].location == "OFFICE (B) 114 to SM. CONF. ROOM 113"
        assert by_num["113"].hand == "RH"


class TestEnrichOpeningsFromHeadings:
    """
    Prompt 2: When the Opening List table has already produced DoorEntry rows
    with missing location/hand, the heading-block cross-reference must fill
    those fields in place rather than skipping the door.
    """

    def test_enriches_missing_hand_and_location(self, extract_tables):
        DoorEntry = extract_tables.DoorEntry
        openings = [
            DoorEntry(door_number="101", hw_set="H01", location="", hand=""),
            DoorEntry(door_number="102", hw_set="H02", location="LOBBY", hand="RH"),
        ]
        heading_doors = [
            DoorEntry(door_number="101", hw_set="H01",
                      location="RECEPTION 101 from CORRIDOR 110", hand="RHR"),
            DoorEntry(door_number="103", hw_set="H01",
                      location="OFFICE 103", hand="LH"),
        ]
        added, enriched = extract_tables.merge_heading_doors_into_openings(
            openings, heading_doors
        )
        assert added == 1
        assert enriched == 1

        by_num = {d.door_number: d for d in openings}
        assert by_num["101"].location == "RECEPTION 101 from CORRIDOR 110"
        assert by_num["101"].hand == "RHR"
        # Existing non-empty values must not be overwritten
        assert by_num["102"].location == "LOBBY"
        assert by_num["102"].hand == "RH"
        # New door is appended
        assert by_num["103"].location == "OFFICE 103"
        assert by_num["103"].hand == "LH"

    def test_preserves_opening_list_values_when_heading_empty(self, extract_tables):
        """Opening List is canonical — heading data never overwrites populated fields."""
        DoorEntry = extract_tables.DoorEntry
        openings = [
            DoorEntry(door_number="101", hw_set="H01",
                      location="RECEPTION", hand="LH"),
        ]
        heading_doors = [
            DoorEntry(door_number="101", hw_set="H01", location="", hand=""),
        ]
        added, enriched = extract_tables.merge_heading_doors_into_openings(
            openings, heading_doors
        )
        assert added == 0
        assert enriched == 0
        assert openings[0].location == "RECEPTION"
        assert openings[0].hand == "LH"


# ── Opening Description fire rating (Prompt 2 revised) ──

class TestParseOpeningDescriptionFireRating:
    """The 'Opening Description:' line under a heading sometimes carries a
    fire rating (e.g. '90Min') that applies to every door under that
    heading. The pipeline must extract and propagate it."""

    def test_no_rating_returns_empty(self, extract_tables):
        result = extract_tables.parse_opening_description_fire_rating(
            "Opening Description: 3' 0\" x 7' 0\" Type AL-SF Type AL-SF"
        )
        assert result == ""

    def test_extracts_90min(self, extract_tables):
        result = extract_tables.parse_opening_description_fire_rating(
            "Opening Description: 90Min 3' 0\" x 7' 0\" Type HMD Type HMF"
        )
        assert result == "90Min"

    def test_extracts_45_min_with_space(self, extract_tables):
        result = extract_tables.parse_opening_description_fire_rating(
            "Opening Description: 45 Min 3' 0\" x 7' 0\" Type HMD Type HMF"
        )
        assert result == "45 Min"

    def test_extracts_1_hr(self, extract_tables):
        result = extract_tables.parse_opening_description_fire_rating(
            "Opening Description: 1 Hr 3' 0\" x 7' 0\" Type HMD Type HMF"
        )
        assert result == "1 Hr"

    def test_extracts_3_hours_plural(self, extract_tables):
        result = extract_tables.parse_opening_description_fire_rating(
            "Opening Description: 3 Hours 3' 0\" x 7' 0\" Type HMD Type HMF"
        )
        assert result == "3 Hours"

    def test_non_description_line_returns_empty(self, extract_tables):
        """The parser should only fire on lines starting with 'Opening Description'."""
        result = extract_tables.parse_opening_description_fire_rating(
            "1 Single Door #101 CORRIDOR 110 90Min LH"
        )
        assert result == ""


class _FakePage:
    """Minimal pdfplumber-shaped page used by the join tests below."""

    def __init__(self, text, page_number=1):
        self._text = text
        self.page_number = page_number

    def extract_text(self):
        return self._text


class _FakePdf:
    def __init__(self, pages):
        self.pages = pages


class TestBuildHeadingPageMap:
    """Step B of the join: walk heading pages, emit per-door map with
    fire_rating stamped from the Opening Description line of each heading."""

    def test_stamps_fire_rating_from_opening_description(self, extract_tables):
        page_text = (
            "Heading #H07A (Set #H07A)\n"
            "1 Single Door #120 STAIR 201 from CORRIDOR 110 RHR\n"
            "1 Single Door #121 STAIR 201 to ROOF LH\n"
            "Opening Description: 90Min 3' 0\" x 7' 0\" Type HMD Type HMF\n"
            "6 Hinges 5BB1 4 1/2 x 4 1/2 652 IV\n"
        )
        pdf = _FakePdf([_FakePage(page_text)])
        heading_map = extract_tables.build_heading_page_map(pdf)

        assert "120" in heading_map
        assert heading_map["120"].fire_rating == "90Min"
        assert heading_map["120"].location == "STAIR 201 from CORRIDOR 110"
        assert heading_map["120"].hand == "RHR"

        assert "121" in heading_map
        assert heading_map["121"].fire_rating == "90Min"
        assert heading_map["121"].hand == "LH"

    def test_heading_without_rating_leaves_empty(self, extract_tables):
        page_text = (
            "Heading #H01 (Set #H01)\n"
            "1 Single Door #110.1 RECEPTION 101 from CORRIDOR 110 RHR\n"
            "Opening Description: 3' 0\" x 7' 0\" Type AL-SF Type AL-SF\n"
            "12 Hinges 5BB1 4 1/2 x 4 1/2 652 IV\n"
        )
        pdf = _FakePdf([_FakePage(page_text)])
        heading_map = extract_tables.build_heading_page_map(pdf)

        assert "110.1" in heading_map
        assert heading_map["110.1"].fire_rating == ""
        assert heading_map["110.1"].location == "RECEPTION 101 from CORRIDOR 110"
        assert heading_map["110.1"].hand == "RHR"

    def test_rating_does_not_leak_across_headings(self, extract_tables):
        """A rating on heading H07A must not pollute H01 doors."""
        page_text = (
            "Heading #H01 (Set #H01)\n"
            "1 Single Door #110.1 RECEPTION 101 from CORRIDOR 110 RHR\n"
            "Opening Description: 3' 0\" x 7' 0\" Type AL-SF Type AL-SF\n"
            "12 Hinges 5BB1 4 1/2 x 4 1/2 652 IV\n"
            "Heading #H07A (Set #H07A)\n"
            "1 Single Door #120 STAIR 201 from CORRIDOR 110 RHR\n"
            "Opening Description: 90Min 3' 0\" x 7' 0\" Type HMD Type HMF\n"
            "6 Hinges 5BB1 4 1/2 x 4 1/2 652 IV\n"
        )
        pdf = _FakePdf([_FakePage(page_text)])
        heading_map = extract_tables.build_heading_page_map(pdf)

        assert heading_map["110.1"].fire_rating == ""
        assert heading_map["120"].fire_rating == "90Min"

    def test_populates_hw_heading(self, extract_tables):
        """Heading-extracted doors should carry the heading ID in hw_heading
        so confidence scoring + the UI can render the heading context."""
        page_text = (
            "Heading #H01 (Set #H01)\n"
            "1 Single Door #110.1 RECEPTION 101 from CORRIDOR 110 RHR\n"
        )
        pdf = _FakePdf([_FakePage(page_text)])
        heading_map = extract_tables.build_heading_page_map(pdf)
        assert heading_map["110.1"].hw_heading == "H01"

    def test_stitches_location_continuation_line(self, extract_tables):
        """LyftWaymo-style wrap: the hand sits at the end of line 1 and
        the tail of the location sits on line 2. The parser must stitch
        the continuation back onto the location."""
        page_text = (
            "Heading #E01 (Set #E01)\n"
            "1 Single Door #E102 RECEPTION 101 to LARGE RH\n"
            "CONF. ROOM 102\n"
            "Opening Description: 3' 0\" x 6' 9 1/2\" Type EXST Type EXST\n"
            "1 Keypad Lockset DL2700 IC RH 26D ALRM\n"
        )
        pdf = _FakePdf([_FakePage(page_text)])
        heading_map = extract_tables.build_heading_page_map(pdf)

        assert "E102" in heading_map
        assert heading_map["E102"].location == "RECEPTION 101 to LARGE CONF. ROOM 102"
        assert heading_map["E102"].hand == "RH"

    def test_stitches_multiple_door_continuations(self, extract_tables):
        """Every door line in a tight-width layout can wrap. Each
        continuation must stick to its own door, not leak into the next."""
        page_text = (
            "Heading #H01 (Set #H01)\n"
            "1 Single Door #110.1 RECEPTION 101 from RHR\n"
            "CORRIDOR 110\n"
            "1 Single Door #113 OFFICE (B) 114 to SM. CONF. RH\n"
            "ROOM 113\n"
            "1 Single Door #114 CORRIDOR 110 from OFFICE 180° RHR\n"
            "(B) 114\n"
            "Opening Description: 3' 0\" x 7' 0\" Type AL-SF Type AL-SF\n"
        )
        pdf = _FakePdf([_FakePage(page_text)])
        heading_map = extract_tables.build_heading_page_map(pdf)

        assert heading_map["110.1"].location == "RECEPTION 101 from CORRIDOR 110"
        assert heading_map["110.1"].hand == "RHR"
        assert heading_map["113"].location == "OFFICE (B) 114 to SM. CONF. ROOM 113"
        assert heading_map["113"].hand == "RH"
        assert heading_map["114"].location == "CORRIDOR 110 from OFFICE (B) 114"
        assert heading_map["114"].hand == "RHR"

    def test_continuation_does_not_swallow_opening_description(self, extract_tables):
        """A continuation line must never pull text from the
        Opening Description or a later item/door line."""
        page_text = (
            "Heading #H01 (Set #H01)\n"
            "1 Single Door #101 HALLWAY to STAIR RH\n"
            "Opening Description: 3' 0\" x 7' 0\" Type HMD Type HMF\n"
            "12 Hinges 5BB1 4 1/2 x 4 1/2 652 IV\n"
        )
        pdf = _FakePdf([_FakePage(page_text)])
        heading_map = extract_tables.build_heading_page_map(pdf)

        # No continuation present; location must remain exactly what
        # the door line produced.
        assert heading_map["101"].location == "HALLWAY to STAIR"
        assert heading_map["101"].hand == "RH"

    def test_dimension_line_is_not_a_continuation(self, extract_tables):
        """Some PDFs (e.g. grid-RR) print the size / door-type row
        right after the door line without the 'Opening Description:'
        prefix. The continuation-stitch must NOT swallow that into
        the location."""
        page_text = (
            "Heading #H01 (Set #H01)\n"
            "1 Single Door #1707 Future Tenant Space 1703 from IT/IDF Room 1707 RHR\n"
            "3' 0\" x 9' 0\" x 1 3/4\" x HMD Type B x HMF Type F1\n"
            "3 Hinges 5BB1 HW 4 1/2 x 4 1/2 NRP 652 IV\n"
        )
        pdf = _FakePdf([_FakePage(page_text)])
        heading_map = extract_tables.build_heading_page_map(pdf)

        assert heading_map["1707"].location == "Future Tenant Space 1703 from IT/IDF Room 1707"
        assert heading_map["1707"].hand == "RHR"

    def test_pair_door_dimension_line_is_not_a_continuation(self, extract_tables):
        """Pair doors print dimensions as '2 - 3' 0\" x 7' 0\" ...'
        which must also be recognised as a non-continuation line."""
        page_text = (
            "Heading #H01 (Set #H01)\n"
            "1 Pair Doors #2100A Exterior from Phase 1B Anode/ Cathode Production 2100 RHRA\n"
            "2 - 3' 0\" x 7' 0\" x 1 3/4\" x HMD Type HG x HMF Type D\n"
            "6 Hinges 5BB1 HW 4 1/2 x 4 1/2 NRP 652 IV\n"
        )
        pdf = _FakePdf([_FakePage(page_text)])
        heading_map = extract_tables.build_heading_page_map(pdf)

        assert heading_map["2100A"].location == "Exterior from Phase 1B Anode/ Cathode Production 2100"
        assert heading_map["2100A"].hand == "RHRA"


class TestJoinOpeningListWithHeadingPages:
    """Step C: non-destructive fill + append + anomaly counting."""

    def test_fills_missing_fields_from_heading(self, extract_tables):
        DoorEntry = extract_tables.DoorEntry
        openings = [
            DoorEntry(door_number="110.1", hw_set="H01",
                      door_type="AL-SF", frame_type="AL-SF"),
        ]
        heading_doors = [
            DoorEntry(door_number="110.1", hw_set="H01", hw_heading="H01",
                      location="RECEPTION 101 from CORRIDOR 110",
                      hand="RHR", fire_rating=""),
        ]
        stats = extract_tables.join_opening_list_with_heading_pages(
            openings, heading_doors
        )
        assert openings[0].location == "RECEPTION 101 from CORRIDOR 110"
        assert openings[0].hand == "RHR"
        assert stats["enriched"] == 1
        assert stats["added"] == 0
        assert stats["opening_list_only"] == 0
        assert stats["heading_only"] == 0

    def test_propagates_heading_fire_rating_to_ol_door(self, extract_tables):
        """Opening List row with blank fire_rating + heading map rating
        → OL row gets filled with the heading's rating."""
        DoorEntry = extract_tables.DoorEntry
        openings = [
            DoorEntry(door_number="120", hw_set="H07A",
                      door_type="HMD", frame_type="HMF"),
            DoorEntry(door_number="121", hw_set="H07A"),
        ]
        heading_doors = [
            DoorEntry(door_number="120", hw_set="H07A",
                      location="STAIR 201 from CORRIDOR 110",
                      hand="RHR", fire_rating="90Min"),
            DoorEntry(door_number="121", hw_set="H07A",
                      location="STAIR 201 to ROOF",
                      hand="LH", fire_rating="90Min"),
        ]
        extract_tables.join_opening_list_with_heading_pages(
            openings, heading_doors
        )
        by_num = {d.door_number: d for d in openings}
        assert by_num["120"].fire_rating == "90Min"
        assert by_num["121"].fire_rating == "90Min"

    def test_appends_heading_only_doors(self, extract_tables):
        """Heading-only doors (not in the Opening List) are appended and
        counted in stats.heading_only."""
        DoorEntry = extract_tables.DoorEntry
        openings = [
            DoorEntry(door_number="101", hw_set="H01", location="FOYER", hand="LH"),
        ]
        heading_doors = [
            DoorEntry(door_number="101", hw_set="H01",
                      location="DIFFERENT", hand="RH"),
            DoorEntry(door_number="999", hw_set="H01",
                      location="UTILITY", hand="RH"),
        ]
        stats = extract_tables.join_opening_list_with_heading_pages(
            openings, heading_doors
        )
        assert len(openings) == 2
        assert stats["added"] == 1
        assert stats["heading_only"] == 1
        # Existing values on door 101 are NOT overwritten
        by_num = {d.door_number: d for d in openings}
        assert by_num["101"].location == "FOYER"
        assert by_num["101"].hand == "LH"

    def test_counts_opening_list_only_anomaly(self, extract_tables):
        """Doors in the Opening List with no heading-page counterpart are
        counted — this is a real anomaly the user should see."""
        DoorEntry = extract_tables.DoorEntry
        openings = [
            DoorEntry(door_number="101", hw_set="H01"),
            DoorEntry(door_number="102", hw_set="H01"),
        ]
        heading_doors = [
            DoorEntry(door_number="101", hw_set="H01",
                      location="FOYER", hand="LH"),
        ]
        stats = extract_tables.join_opening_list_with_heading_pages(
            openings, heading_doors
        )
        assert stats["opening_list_only"] == 1
        assert stats["opening_list_only_numbers"] == ["102"]


class TestOpeningListHeadingJoinIntegration:
    """End-to-end: a simulated two-map join produces doors with every
    field populated (the Lyft/Waymo-shaped happy path). Mirrors the
    review/utils.ts predicates so we catch UI-visible regressions."""

    def test_all_doors_have_location_hand_and_rating_when_present(self, extract_tables):
        """After the join, every door has location+hand; doors under a
        rated heading also have fire_rating populated. No door triggers
        the review/utils.ts missing_* predicates."""
        DoorEntry = extract_tables.DoorEntry

        # Opening List rows — door_type/frame_type from the OL table,
        # location/hand/fire_rating left blank (typical real PDF).
        openings = [
            DoorEntry(door_number="110.1", hw_set="H01",
                      door_type="AL-SF", frame_type="AL-SF"),
            DoorEntry(door_number="113", hw_set="H01",
                      door_type="AL-SF", frame_type="AL-SF"),
            DoorEntry(door_number="120", hw_set="H07A",
                      door_type="HMD", frame_type="HMF"),
        ]

        # Heading pages produce location/hand and a fire rating on H07A.
        pdf = _FakePdf([
            _FakePage(
                "Heading #H01 (Set #H01)\n"
                "1 Single Door #110.1 RECEPTION 101 from CORRIDOR 110 RHR\n"
                "1 Single Door #113 OFFICE (B) 114 to SM. CONF. ROOM 113 RH\n"
                "Opening Description: 3' 0\" x 7' 0\" Type AL-SF Type AL-SF\n"
                "12 Hinges 5BB1 4 1/2 x 4 1/2 652 IV\n"
            ),
            _FakePage(
                "Heading #H07A (Set #H07A)\n"
                "1 Single Door #120 STAIR 201 from CORRIDOR 110 RHR\n"
                "Opening Description: 90Min 3' 0\" x 7' 0\" Type HMD Type HMF\n"
                "6 Hinges 5BB1 4 1/2 x 4 1/2 652 IV\n"
            ),
        ])

        heading_doors = list(extract_tables.build_heading_page_map(pdf).values())
        stats = extract_tables.join_opening_list_with_heading_pages(
            openings, heading_doors
        )

        assert stats["heading_only"] == 0
        assert stats["opening_list_only"] == 0
        assert stats["enriched"] == 3

        by_num = {d.door_number: d for d in openings}
        # Every door has location + hand (UI "Missing hand/location" → 0)
        for d in openings:
            assert d.location.strip(), f"door {d.door_number} missing location"
            assert d.hand.strip(), f"door {d.door_number} missing hand"
        # Heading with a rating propagates it to every door under it
        assert by_num["120"].fire_rating == "90Min"
        # Heading without a rating gets backfilled to "NR" (Not Rated) —
        # the absence of a fire rating means non-rated, not missing data.
        assert by_num["110.1"].fire_rating == "NR"
        assert by_num["113"].fire_rating == "NR"


class TestNRBackfill:
    """Doors with no fire rating get 'NR' after the join."""

    def test_blank_fire_rating_becomes_nr(self, extract_tables):
        """A door with blank fire_rating gets NR after join."""
        DoorEntry = extract_tables.DoorEntry
        openings = [DoorEntry(door_number="101", hw_set="H01", fire_rating="")]
        heading_doors = [DoorEntry(door_number="101", hw_set="H01", hand="RH", location="ROOM 101")]
        extract_tables.join_opening_list_with_heading_pages(openings, heading_doors)
        assert openings[0].fire_rating == "NR"

    def test_explicit_fire_rating_preserved(self, extract_tables):
        """A door with an explicit fire rating is NOT overwritten with NR."""
        DoorEntry = extract_tables.DoorEntry
        openings = [DoorEntry(door_number="101", hw_set="H01", fire_rating="90Min")]
        heading_doors = [DoorEntry(door_number="101", hw_set="H01", hand="RH")]
        extract_tables.join_opening_list_with_heading_pages(openings, heading_doors)
        assert openings[0].fire_rating == "90Min"

    def test_heading_fire_rating_not_overwritten_by_nr(self, extract_tables):
        """Fire rating from heading page is preserved, not overwritten with NR."""
        DoorEntry = extract_tables.DoorEntry
        openings = [DoorEntry(door_number="101", hw_set="H01", fire_rating="")]
        heading_doors = [DoorEntry(door_number="101", hw_set="H01", fire_rating="1 Hr")]
        extract_tables.join_opening_list_with_heading_pages(openings, heading_doors)
        assert openings[0].fire_rating == "1 Hr"


class TestFalseDoorFiltering:
    """Post-join filter removes catalog numbers mistakenly extracted as doors."""

    def test_removes_no_metadata_no_heading_match(self, extract_tables):
        """A door with no heading match and no metadata is filtered out."""
        DoorEntry = extract_tables.DoorEntry
        openings = [
            DoorEntry(door_number="101", hw_set="H01"),  # real door
            DoorEntry(door_number="4040XP", hw_set="", location="", hand=""),  # false positive
        ]
        heading_doors = [DoorEntry(door_number="101", hw_set="H01", hand="RH")]
        extract_tables.join_opening_list_with_heading_pages(openings, heading_doors)
        door_numbers = [d.door_number for d in openings]
        assert "101" in door_numbers
        assert "4040XP" not in door_numbers

    def test_keeps_door_with_hw_set_even_without_heading(self, extract_tables):
        """A door with hw_set but no heading match is kept (could be real)."""
        DoorEntry = extract_tables.DoorEntry
        openings = [
            DoorEntry(door_number="101", hw_set="H01"),
            DoorEntry(door_number="999", hw_set="H99"),  # has hw_set, keep it
        ]
        heading_doors = [DoorEntry(door_number="101", hw_set="H01", hand="RH")]
        extract_tables.join_opening_list_with_heading_pages(openings, heading_doors)
        door_numbers = [d.door_number for d in openings]
        assert "999" in door_numbers

    def test_no_filtering_without_heading_data(self, extract_tables):
        """When no heading pages exist, don't filter anything."""
        DoorEntry = extract_tables.DoorEntry
        openings = [DoorEntry(door_number="4040XP", hw_set="", location="", hand="")]
        heading_doors = []
        extract_tables.join_opening_list_with_heading_pages(openings, heading_doors)
        assert len(openings) == 1  # kept because no heading data to compare


class TestIsValidDoorNumberNewRejections:
    """New rejection patterns for catalog numbers and option codes."""

    def test_rejects_trailing_colon(self, extract_tables):
        assert not extract_tables.is_valid_door_number("10A:")
        assert not extract_tables.is_valid_door_number("11A:")

    def test_rejects_leading_zero_dash_catalog(self, extract_tables):
        assert not extract_tables.is_valid_door_number("14-010")
        assert not extract_tables.is_valid_door_number("13-247")
        assert not extract_tables.is_valid_door_number("14-028")

    def test_rejects_closer_model_numbers(self, extract_tables):
        assert not extract_tables.is_valid_door_number("4040XP")
        assert not extract_tables.is_valid_door_number("4040XP-3077")
        assert not extract_tables.is_valid_door_number("4040XP-3077SCNS")

    def test_still_accepts_valid_door_numbers(self, extract_tables):
        """Ensure the new rules don't reject real doors."""
        assert extract_tables.is_valid_door_number("101")
        assert extract_tables.is_valid_door_number("1-101")
        assert extract_tables.is_valid_door_number("A101")
        assert extract_tables.is_valid_door_number("110.1")
        assert extract_tables.is_valid_door_number("E102")
        assert extract_tables.is_valid_door_number("ST-100")
