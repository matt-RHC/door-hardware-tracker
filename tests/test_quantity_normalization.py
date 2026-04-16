"""
Tests for quantity normalization in api/extract-tables.py.

Covers:
  - BUG-9: Float division fix (modulo-based)
  - BUG-9: Pair door leaf count from opening list
  - Fuzzy ID matching (suffix stripping, prefix match, column-swap)
  - Category-aware division order (hinges by leaves, closers by openings)
  - Expanded heading door line regex
  - Quantity convention detection (preamble-based, dual-quantity, mixed)
  - Golden PDF regression tests
"""
import pdfplumber
import pytest


# ── Unit tests: modulo-based division check ──

class TestQuantityDivision:
    """Verify normalize_quantities uses integer modulo, not float equality."""

    def _make_set(self, et, qty, door_count, leaf_count, item_name="Hinge, Full Mortise"):
        """Create a HardwareSetDef with one item."""
        return et.HardwareSetDef(
            set_id="TEST",
            generic_set_id="TEST",
            heading="Test Set",
            heading_door_count=door_count,
            heading_leaf_count=leaf_count,
            items=[
                et.HardwareItem(qty=qty, name=item_name),
            ],
        )

    def test_exact_division_by_leaves(self, extract_tables):
        """12 hinges with 4 leaves → annotate needs_division, qty preserved."""
        hw = self._make_set(extract_tables, qty=12, door_count=2, leaf_count=4)
        extract_tables.normalize_quantities([hw], [])
        item = hw.items[0]
        assert item.qty == 12                    # raw PDF value preserved
        assert item.qty_source == "needs_division"
        assert item.qty_total == 12
        assert item.qty_door_count == 4

    def test_non_exact_per_leaf_annotates_needs_division(self, extract_tables):
        """13 hinges with 4 leaves → annotate needs_division, qty preserved.

        Python no longer rounds or flags — it annotates the raw value and
        divisor. The TS layer performs the actual division.
        qty_door_count MUST be leaf_count (4), not door_count (2) —
        per-leaf items use leaf_count as the recommended divisor.
        """
        hw = self._make_set(extract_tables, qty=13, door_count=2, leaf_count=4)
        extract_tables.normalize_quantities([hw], [])
        item = hw.items[0]
        assert item.qty == 13                    # raw PDF value preserved
        assert item.qty_source == "needs_division"
        assert item.qty_door_count == 4          # leaf_count, not door_count
        assert item.qty_total == 13

    def test_per_leaf_never_falls_back_to_door_count_when_leaf_count_gt_1(self, extract_tables):
        """10 hinges on 5 doors / 7 leaves → annotate with leaf_count divisor.

        Python no longer divides or rounds. It annotates with the correct
        divisor (leaf_count=7) so the TS layer can divide. The key invariant
        is that qty_door_count must be 7 (leaves), not 5 (openings).
        """
        hw = self._make_set(extract_tables, qty=10, door_count=5, leaf_count=7)
        extract_tables.normalize_quantities([hw], [])
        item = hw.items[0]
        assert item.qty == 10                    # raw PDF value preserved
        assert item.qty_source == "needs_division"
        assert item.qty_door_count == 7          # leaf_count, not door_count
        assert item.qty_total == 10

    def test_pair_door_42_hinges_on_12_leaves_annotates_correctly(self, extract_tables):
        """42 hinges across 6 pair doors (12 leaves) → annotate needs_division.

        This is the exact Radius DC DH4A.0 scenario. Python preserves the
        raw qty=42 and records divisor=12 (leaf_count). The TS layer will
        perform 42/12 = 3.5 and handle rounding/flagging.
        """
        hw = self._make_set(extract_tables, qty=42, door_count=6, leaf_count=12)
        extract_tables.normalize_quantities([hw], [])
        item = hw.items[0]
        assert item.qty == 42                    # raw PDF value preserved
        assert item.qty_source == "needs_division"
        assert item.qty_door_count == 12
        assert item.qty_total == 42

    def test_pair_door_48_hinges_on_12_leaves_annotates_correctly(self, extract_tables):
        """48 hinges across 6 pair doors (12 leaves) → annotate needs_division.

        Python no longer distinguishes clean vs non-clean division. Both
        cases get qty_source='needs_division'. The TS layer handles the
        actual math and decides whether to flag non-integer results.
        """
        hw = self._make_set(extract_tables, qty=48, door_count=6, leaf_count=12)
        extract_tables.normalize_quantities([hw], [])
        item = hw.items[0]
        assert item.qty == 48                    # raw PDF value preserved
        assert item.qty_source == "needs_division"
        assert item.qty_door_count == 12
        assert item.qty_total == 48

    def test_large_exact_division(self, extract_tables):
        """42 hinges with 14 leaves → annotate needs_division (BUG-9 scenario)."""
        hw = self._make_set(extract_tables, qty=42, door_count=7, leaf_count=14)
        extract_tables.normalize_quantities([hw], [])
        item = hw.items[0]
        assert item.qty == 42                    # raw PDF value preserved
        assert item.qty_source == "needs_division"
        assert item.qty_door_count == 14
        assert item.qty_total == 42


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


# ── Unit tests: fuzzy ID matching ──

class TestFuzzyIDMatching:
    """Verify _normalize_set_id and _fuzzy_lookup handle suffix mismatches."""

    def test_strip_colon_suffix(self, extract_tables):
        assert extract_tables._normalize_set_id("I2S-1E:WI") == "I2S-1E"

    def test_strip_dash_suffix(self, extract_tables):
        assert extract_tables._normalize_set_id("DH1-10-NR") == "DH1-10"

    def test_strip_pr_suffix(self, extract_tables):
        assert extract_tables._normalize_set_id("04.PR4") == "04"

    def test_no_suffix_unchanged(self, extract_tables):
        assert extract_tables._normalize_set_id("DH1-10") == "DH1-10"

    def test_fuzzy_lookup_exact(self, extract_tables):
        d = {"DH1-10": 5}
        assert extract_tables._fuzzy_lookup("DH1-10", d) == 5

    def test_fuzzy_lookup_prefix(self, extract_tables):
        """Key 'DH1-10' should match dict entry 'DH1' via prefix."""
        d = {"DH1": 8}
        assert extract_tables._fuzzy_lookup("DH1-10", d) == 8

    def test_fuzzy_lookup_normalized(self, extract_tables):
        """Key 'I2S-1E:WI' normalizes to 'I2S-1E', matches dict entry."""
        d = {"I2S-1E": 4}
        assert extract_tables._fuzzy_lookup("I2S-1E:WI", d) == 4

    def test_fuzzy_lookup_no_match(self, extract_tables):
        d = {"XYZ": 3}
        assert extract_tables._fuzzy_lookup("DH1-10", d) == 0

    def test_fallback3_cross_field_match(self, extract_tables):
        """Fallback 3: find doors when hw_set and hw_heading are swapped."""
        hw = extract_tables.HardwareSetDef(
            set_id="DH5",
            generic_set_id="DH5",
            heading="Test",
            heading_door_count=0,
            heading_leaf_count=0,
            items=[
                extract_tables.HardwareItem(qty=9, name="Hinge, Full Mortise"),
            ],
        )
        # Simulate column swap: set ID is in hw_set instead of hw_heading
        openings = [
            extract_tables.DoorEntry(door_number="101", hw_heading="", hw_set="DH5"),
            extract_tables.DoorEntry(door_number="102", hw_heading="", hw_set="DH5"),
            extract_tables.DoorEntry(door_number="103", hw_heading="", hw_set="DH5"),
        ]
        extract_tables.normalize_quantities([hw], openings)
        item = hw.items[0]
        assert item.qty == 9                     # raw PDF value preserved
        assert item.qty_source == "needs_division"
        assert item.qty_door_count == 3
        assert item.qty_total == 9


# ── Unit tests: category-aware division ──

class TestCategoryAwareDivision:
    """Verify division order depends on item category."""

    def _make_set(self, et, qty, door_count, leaf_count, item_name):
        return et.HardwareSetDef(
            set_id="TEST",
            generic_set_id="TEST",
            heading="Test Set",
            heading_door_count=door_count,
            heading_leaf_count=leaf_count,
            items=[et.HardwareItem(qty=qty, name=item_name)],
        )

    def test_hinge_divides_by_leaves_first(self, extract_tables):
        """Hinges prefer leaf division: recommend ÷4 leaves, qty preserved."""
        hw = self._make_set(extract_tables, 12, 2, 4, "Hinge 5BB1")
        extract_tables.normalize_quantities([hw], [])
        item = hw.items[0]
        assert item.qty == 12                    # raw PDF value preserved
        assert item.qty_source == "needs_division"
        assert item.qty_door_count == 4          # divided by leaves
        assert item.qty_total == 12

    def test_closer_divides_by_openings_first(self, extract_tables):
        """Closers prefer opening division: recommend ÷2 openings, qty preserved."""
        hw = self._make_set(extract_tables, 4, 2, 4, "Closer 4040XP")
        extract_tables.normalize_quantities([hw], [])
        item = hw.items[0]
        assert item.qty == 4                     # raw PDF value preserved
        assert item.qty_source == "needs_division"
        assert item.qty_door_count == 2          # divided by openings, not leaves
        assert item.qty_total == 4

    def test_threshold_never_divides_by_leaves(self, extract_tables):
        """Thresholds are opening_only: recommend ÷2 openings, not leaves."""
        hw = self._make_set(extract_tables, 4, 2, 4, "Threshold 655BK")
        extract_tables.normalize_quantities([hw], [])
        item = hw.items[0]
        assert item.qty == 4                     # raw PDF value preserved
        assert item.qty_source == "needs_division"
        assert item.qty_door_count == 2          # openings, not leaves
        assert item.qty_total == 4

    def test_flush_bolt_divides_by_openings(self, extract_tables):
        """Flush bolts are opening_only: recommend ÷3 openings."""
        hw = self._make_set(extract_tables, 6, 3, 6, "Flush Bolt FB32")
        extract_tables.normalize_quantities([hw], [])
        item = hw.items[0]
        assert item.qty == 6                     # raw PDF value preserved
        assert item.qty_source == "needs_division"
        assert item.qty_door_count == 3          # openings
        assert item.qty_total == 6

    def test_lockset_divides_by_openings(self, extract_tables):
        """Locksets are per-opening: recommend ÷4 openings."""
        hw = self._make_set(extract_tables, 8, 4, 8, "Mortise Lockset L9080")
        extract_tables.normalize_quantities([hw], [])
        item = hw.items[0]
        assert item.qty == 8                     # raw PDF value preserved
        assert item.qty_source == "needs_division"
        assert item.qty_door_count == 4          # openings
        assert item.qty_total == 8

    def test_exit_device_divides_by_leaves(self, extract_tables):
        """Exit devices are per-leaf: recommend ÷6 leaves (each leaf gets its own)."""
        hw = self._make_set(extract_tables, 6, 3, 6, "Exit Device 9875")
        extract_tables.normalize_quantities([hw], [])
        item = hw.items[0]
        assert item.qty == 6                     # raw PDF value preserved
        assert item.qty_source == "needs_division"
        assert item.qty_door_count == 6          # leaves, not openings
        assert item.qty_total == 6

    def test_wire_harness_divides_by_leaves(self, extract_tables):
        """Wire harness is per-leaf: recommend ÷4 leaves, qty preserved.
        Phase 2b added it to _CATEGORY_PATTERNS and DIVISION_PREFERENCE
        so it uses leaves as the divisor like hinges do."""
        hw = self._make_set(extract_tables, 4, 2, 4, "CON-5 Wire Harness")
        extract_tables.normalize_quantities([hw], [])
        item = hw.items[0]
        assert item.qty == 4                     # raw PDF value preserved
        assert item.qty_source == "needs_division"
        assert item.qty_door_count == 4          # leaves
        assert item.qty_total == 4

    def test_wire_harness_matches_connector_variants(self, extract_tables):
        """The wire_harness classifier should catch the common name variants
        from the TS taxonomy: 'wire harness', 'molex', 'con-N', 'pigtail',
        'connector'. Don't accidentally classify them as something else
        (especially not as electric_hinge, which uses 'hinge .* CON')."""
        names = [
            "Wire Harness 12in",
            "Molex Connector 4-pin",
            "CON-5 pigtail",
            "Pigtail wiring assembly",
        ]
        for name in names:
            cat = extract_tables._classify_hardware_item(name)
            assert cat == "wire_harness", f"{name!r} → {cat} (expected wire_harness)"


# ── Unit tests: expanded heading regex ──

class TestExpandedHeadingRegex:
    """Verify HEADING_DOOR_LINE matches additional formats."""

    def test_standard_format(self, extract_tables):
        """Standard: '1 Pair Doors #1.01.B.03A'"""
        count, leaves = extract_tables.count_heading_doors(
            "1 Pair Doors #1.01.B.03A"
        )
        assert count == 1
        assert leaves == 2

    def test_for_prefix(self, extract_tables):
        """'For 2 Single Doors'"""
        count, leaves = extract_tables.count_heading_doors(
            "For 2 Single Doors"
        )
        assert count == 2
        assert leaves == 2

    def test_qty_prefix(self, extract_tables):
        """'Qty: 3 Pair Doors'"""
        count, leaves = extract_tables.count_heading_doors(
            "Qty: 3 Pair Doors"
        )
        assert count == 3
        assert leaves == 6

    def test_dash_separator(self, extract_tables):
        """'1 - Pair Doors #...'"""
        count, leaves = extract_tables.count_heading_doors(
            "1 - Pair Doors #1.01"
        )
        assert count == 1
        assert leaves == 2

    def test_door_openings_suffix(self, extract_tables):
        """'2 Single Door Openings'"""
        count, leaves = extract_tables.count_heading_doors(
            "2 Single Door Openings"
        )
        assert count == 2
        assert leaves == 2


# ── Unit tests: normalize with opening list fallback ──

class TestNormalizeWithOpeningsFallback:
    """Verify normalize_quantities uses opening list pair info when heading
    door count is zero (fallback paths)."""

    def test_pair_opening_fallback_divides_correctly(self, extract_tables):
        """Set with 0 heading counts but opening list has 3 pair doors →
        annotate needs_division with divisor=6 (leaf count)."""
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
        assert item.qty == 18                    # raw PDF value preserved
        assert item.qty_source == "needs_division"
        assert item.qty_door_count == 6          # 3 pair doors = 6 leaves
        assert item.qty_total == 18


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
        """SMALL PDF: hinge items marked needs_division should have a valid divisor."""
        result = pipeline_results.get("SMALL")
        if result is None:
            pytest.skip("SMALL PDF not available")
        hw_sets = result[0]
        for hw_set in hw_sets:
            for item in hw_set.items:
                if "hinge" in item.name.lower() and item.qty_source == "needs_division":
                    assert item.qty_door_count is not None and item.qty_door_count > 0, (
                        f"{hw_set.set_id} '{item.name}' marked needs_division "
                        f"but qty_door_count={item.qty_door_count}"
                    )
                    assert item.qty_total == item.qty, (
                        f"{hw_set.set_id} '{item.name}' qty_total should equal raw qty"
                    )

    def test_medium_pdf_quantities_normalized(self, extract_tables, pipeline_results):
        """MEDIUM PDF: all needs_division items should have valid annotations."""
        result = pipeline_results.get("MEDIUM")
        if result is None:
            pytest.skip("MEDIUM PDF not available")
        hw_sets = result[0]
        for hw_set in hw_sets:
            for item in hw_set.items:
                if item.qty_source == "needs_division":
                    assert item.qty_door_count is not None and item.qty_door_count > 0, (
                        f"{hw_set.set_id} '{item.name}' marked needs_division "
                        f"but qty_door_count={item.qty_door_count}"
                    )
                    assert item.qty_total == item.qty, (
                        f"{hw_set.set_id} '{item.name}' qty_total should equal raw qty"
                    )

    def test_large_mca_quantities_normalized(self, extract_tables, pipeline_results):
        """LARGE MCA PDF: all needs_division items should have valid annotations."""
        result = pipeline_results.get("LARGE")
        if result is None:
            pytest.skip("LARGE MCA PDF not available")
        hw_sets = result[0]
        for hw_set in hw_sets:
            for item in hw_set.items:
                if item.qty_source == "needs_division":
                    assert item.qty_door_count is not None and item.qty_door_count > 0, (
                        f"{hw_set.set_id} '{item.name}' marked needs_division "
                        f"but qty_door_count={item.qty_door_count}"
                    )
                    assert item.qty_total == item.qty, (
                        f"{hw_set.set_id} '{item.name}' qty_total should equal raw qty"
                    )


# ── Quantity convention detection tests ──

class TestPreamblePerOpeningDetection:
    """Verify detect_quantity_convention identifies per-opening preamble phrases."""

    def test_each_opening_to_have(self, extract_tables):
        """'Each opening to have:' → per_opening."""
        text = """Heading #01 (Set #01)
1 SGL Door:101  Corridor  LHR
Each opening to have:
3  Hinge 5BB1 4-1/2 x 4-1/2 NRP US32D
1  Closer 4040XP EDA 689"""
        assert extract_tables.detect_quantity_convention(text, 1) == "per_opening"

    def test_each_to_receive(self, extract_tables):
        """'Each to receive:' → per_opening."""
        text = """Set #5
Door Numbers: 201, 202, 203
Each to receive:
3  Hinge BB1191 4 x 4
1  Lockset L9080 03A 626"""
        assert extract_tables.detect_quantity_convention(text, 3) == "per_opening"

    def test_each_to_have(self, extract_tables):
        """'EACH TO HAVE:' (uppercase) → per_opening."""
        text = """HARDWARE SET: 12
DOOR NUMBER: 300 301 302
EACH TO HAVE:
3  Hinge BB1191
1  Lockset L9453"""
        assert extract_tables.detect_quantity_convention(text, 3) == "per_opening"

    def test_each_door_leaf_shall_have(self, extract_tables):
        """'Each door leaf shall have:' → per_opening (Kdot style)."""
        text = """SET NO. 3
Each door leaf shall have:
3  Continuous Hinge 780-112
1  Exit Device 9875"""
        assert extract_tables.detect_quantity_convention(text, 2) == "per_opening"

    def test_each_door_to_have(self, extract_tables):
        """'Each door to have:' → per_opening."""
        text = """HW Set 4
Each door to have:
3  Hinge
1  Closer"""
        assert extract_tables.detect_quantity_convention(text, 5) == "per_opening"

    def test_per_opening_colon(self, extract_tables):
        """'Per opening:' → per_opening."""
        text = """Set: 2.0
Per opening:
3  Hinge
1  Lockset"""
        assert extract_tables.detect_quantity_convention(text, 4) == "per_opening"


class TestPreambleAggregateDetection:
    """Verify detect_quantity_convention detects aggregate quantities."""

    def test_no_preamble_large_quantities(self, extract_tables):
        """No preamble + large qty values + multi-door → aggregate."""
        text = """Heading #04 (Set #04)
1 SGL Door:101  Corridor  LHR
1 SGL Door:102  Corridor  RHR
1 SGL Door:103  Corridor  LHR
30  Hinge 5BB1 4-1/2 x 4-1/2 NRP US32D
10  Closer 4040XP EDA 689
30  Silencer SR64 GRY"""
        assert extract_tables.detect_quantity_convention(text, 10) == "aggregate"

    def test_no_preamble_small_quantities_unknown(self, extract_tables):
        """No preamble + small qty values → unknown (could be either)."""
        text = """Heading #01 (Set #01)
3  Hinge 5BB1
1  Closer 4040XP
1  Lockset L9080"""
        assert extract_tables.detect_quantity_convention(text, 5) == "unknown"

    def test_no_door_count_unknown(self, extract_tables):
        """No door count and no preamble → unknown."""
        text = """Heading #01 (Set #01)
30  Hinge 5BB1
10  Closer 4040XP"""
        assert extract_tables.detect_quantity_convention(text, 0) == "unknown"


class TestMixedConventionPerHeading:
    """Verify per-heading normalization with mixed conventions."""

    def _make_set(self, et, qty, door_count, leaf_count, item_name, convention):
        """Create a HardwareSetDef with one item and a specified convention."""
        return et.HardwareSetDef(
            set_id="TEST",
            generic_set_id="TEST",
            heading="Test Set",
            heading_door_count=door_count,
            heading_leaf_count=leaf_count,
            qty_convention=convention,
            items=[
                et.HardwareItem(qty=qty, name=item_name),
            ],
        )

    def test_single_door_heading_always_per_opening(self, extract_tables):
        """1-door heading: qty is already per-opening regardless of convention."""
        hw = self._make_set(extract_tables, 3, 1, 1, "Hinge 5BB1", "aggregate")
        extract_tables.normalize_quantities([hw], [])
        item = hw.items[0]
        # Single door → goes through the single-door path, not division
        assert item.qty == 3
        assert item.qty_source == "parsed"

    def test_multi_door_per_opening_skips_division(self, extract_tables):
        """Multi-door heading with per_opening convention → no division."""
        hw = self._make_set(extract_tables, 3, 5, 5, "Hinge 5BB1", "per_opening")
        extract_tables.normalize_quantities([hw], [])
        item = hw.items[0]
        assert item.qty == 3
        assert item.qty_source == "parsed"
        assert item.qty_total == 3
        assert item.qty_door_count == 5

    def test_multi_door_aggregate_divides(self, extract_tables):
        """Multi-door heading with aggregate convention → needs_division."""
        hw = self._make_set(extract_tables, 15, 5, 5, "Hinge 5BB1", "aggregate")
        extract_tables.normalize_quantities([hw], [])
        item = hw.items[0]
        assert item.qty == 15
        assert item.qty_source == "needs_division"
        assert item.qty_door_count == 5  # leaf_count for hinges
        assert item.qty_total == 15

    def test_multi_door_unknown_convention_divides(self, extract_tables):
        """Multi-door heading with unknown convention → falls through to division."""
        hw = self._make_set(extract_tables, 15, 5, 5, "Hinge 5BB1", "unknown")
        extract_tables.normalize_quantities([hw], [])
        item = hw.items[0]
        assert item.qty == 15
        assert item.qty_source == "needs_division"
        assert item.qty_door_count == 5
        assert item.qty_total == 15

    def test_mixed_convention_in_same_file(self, extract_tables):
        """Two sets in the same file with different conventions normalize differently."""
        per_opening_set = extract_tables.HardwareSetDef(
            set_id="SET1",
            generic_set_id="SET1",
            heading="Set 1",
            heading_door_count=3,
            heading_leaf_count=3,
            qty_convention="per_opening",
            items=[extract_tables.HardwareItem(qty=3, name="Hinge 5BB1")],
        )
        aggregate_set = extract_tables.HardwareSetDef(
            set_id="SET2",
            generic_set_id="SET2",
            heading="Set 2",
            heading_door_count=3,
            heading_leaf_count=3,
            qty_convention="aggregate",
            items=[extract_tables.HardwareItem(qty=9, name="Hinge 5BB1")],
        )
        extract_tables.normalize_quantities([per_opening_set, aggregate_set], [])

        # per_opening set: qty stays at 3, source is 'parsed'
        assert per_opening_set.items[0].qty == 3
        assert per_opening_set.items[0].qty_source == "parsed"

        # aggregate set: qty stays at 9 (raw), but annotated needs_division
        assert aggregate_set.items[0].qty == 9
        assert aggregate_set.items[0].qty_source == "needs_division"
        assert aggregate_set.items[0].qty_door_count == 3


class TestDualQuantityFormat:
    """Verify dual-quantity format detection: '(total) per_door EA'."""

    def test_dual_qty_extraction(self, extract_tables):
        """'(42) 3 EA' correctly extracts total=42, per_door=3."""
        pairs = extract_tables.extract_dual_qty("(42) 3 EA")
        assert pairs == [(42, 3)]

    def test_dual_qty_multiple(self, extract_tables):
        """Multiple dual-quantity patterns in text."""
        text = "(42) 3 EA\n(10) 1 EA\n(20) 2 EA"
        pairs = extract_tables.extract_dual_qty(text)
        assert pairs == [(42, 3), (10, 1), (20, 2)]

    def test_dual_qty_convention_detected(self, extract_tables):
        """Text with dual-quantity format detected as per_opening."""
        text = """Heading 101 (HwSet 101)
SGL DOOR(S)101.01 Corridor
(42) 3 EA  Hinge 5BB1 4-1/2 x 4-1/2 NRP
(14) 1 EA  Closer 4040XP"""
        assert extract_tables.detect_quantity_convention(text, 14) == "per_opening"

    def test_dual_qty_validates_door_count(self, extract_tables):
        """total / per_door should approximate door count."""
        pairs = extract_tables.extract_dual_qty("(42) 3 EA")
        total, per_door = pairs[0]
        assert total // per_door == 14  # implies 14 doors

    def test_dual_qty_no_match(self, extract_tables):
        """Regular quantity lines don't match dual format."""
        pairs = extract_tables.extract_dual_qty("3  Hinge 5BB1 4-1/2 EA")
        assert pairs == []


class TestPreambleOverridesStatistical:
    """Verify preamble detection takes priority over statistical heuristic."""

    def test_preamble_overrides_large_quantities(self, extract_tables):
        """Even with large quantities, 'Each opening to have:' wins."""
        text = """Set #10
Door Numbers: 101, 102, 103, 104, 105, 106, 107, 108, 109, 110
Each opening to have:
30  Hinge 5BB1 4-1/2 x 4-1/2
10  Closer 4040XP
10  Lockset L9080"""
        # The statistical heuristic would say "aggregate" (all values > 6),
        # but the preamble definitively says "per_opening"
        assert extract_tables.detect_quantity_convention(text, 10) == "per_opening"

    def test_preamble_overrides_in_normalize_quantities(self, extract_tables):
        """normalize_quantities respects per_opening convention even for high qtys."""
        hw = extract_tables.HardwareSetDef(
            set_id="TEST",
            generic_set_id="TEST",
            heading="Test Set",
            heading_door_count=10,
            heading_leaf_count=10,
            qty_convention="per_opening",
            items=[
                extract_tables.HardwareItem(qty=30, name="Hinge 5BB1"),
                extract_tables.HardwareItem(qty=10, name="Closer 4040XP"),
            ],
        )
        extract_tables.normalize_quantities([hw], [])

        # Both items should be marked as 'parsed' (per-opening), NOT divided
        for item in hw.items:
            assert item.qty_source == "parsed", (
                f"'{item.name}' should be 'parsed' with per_opening convention, "
                f"got '{item.qty_source}'"
            )
            assert item.qty_total == item.qty
