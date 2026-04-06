"""
MCA-specific extraction tests (BUG-11).

MCA Hardware.pdf (LARGE_MCA.pdf, 82 pages) has a known field concatenation
issue (BUG-12) where name, manufacturer, model, and finish get merged into
one field. Tests that depend on BUG-12 being fixed are marked xfail.
"""
import re

import pdfplumber
import pytest


# ── Field Separation (BUG-12 xfail) ──────────────────────────────────────────

@pytest.mark.bug12
class TestMCAFieldSeparation:
    """Tests that MCA extraction correctly separates hardware item fields.
    All tests xfail until BUG-12 (field concatenation) is fixed."""

    @pytest.mark.xfail(reason="BUG-12: MCA field concatenation")
    def test_items_have_separate_manufacturer(self, extract_tables, large_pdf_path):
        with pdfplumber.open(str(large_pdf_path), unicode_norm="NFKC") as pdf:
            hw_sets = extract_tables.extract_all_hardware_sets(pdf)
        all_items = [item for s in hw_sets for item in s.items]
        assert len(all_items) > 0, "No items extracted"
        with_mfr = sum(1 for i in all_items if (i.manufacturer or "").strip())
        ratio = with_mfr / len(all_items)
        assert ratio >= 0.50, (
            f"Only {with_mfr}/{len(all_items)} ({ratio:.0%}) items have manufacturer"
        )

    @pytest.mark.xfail(reason="BUG-12: MCA field concatenation")
    def test_items_have_separate_model(self, extract_tables, large_pdf_path):
        with pdfplumber.open(str(large_pdf_path), unicode_norm="NFKC") as pdf:
            hw_sets = extract_tables.extract_all_hardware_sets(pdf)
        all_items = [item for s in hw_sets for item in s.items]
        assert len(all_items) > 0
        with_model = sum(1 for i in all_items if (i.model or "").strip())
        ratio = with_model / len(all_items)
        assert ratio >= 0.50, (
            f"Only {with_model}/{len(all_items)} ({ratio:.0%}) items have model"
        )

    @pytest.mark.xfail(reason="BUG-12: MCA field concatenation")
    def test_items_have_separate_finish(self, extract_tables, large_pdf_path):
        with pdfplumber.open(str(large_pdf_path), unicode_norm="NFKC") as pdf:
            hw_sets = extract_tables.extract_all_hardware_sets(pdf)
        all_items = [item for s in hw_sets for item in s.items]
        assert len(all_items) > 0
        with_finish = sum(1 for i in all_items if (i.finish or "").strip())
        ratio = with_finish / len(all_items)
        assert ratio >= 0.30, (
            f"Only {with_finish}/{len(all_items)} ({ratio:.0%}) items have finish"
        )

    @pytest.mark.xfail(reason="BUG-12: MCA field concatenation")
    def test_at_least_3_sets_fully_parsed(self, extract_tables, large_pdf_path):
        with pdfplumber.open(str(large_pdf_path), unicode_norm="NFKC") as pdf:
            hw_sets = extract_tables.extract_all_hardware_sets(pdf)
        fully_parsed = 0
        for s in hw_sets:
            for item in s.items:
                mfr = (item.manufacturer or "").strip()
                model = (item.model or "").strip()
                finish = (item.finish or "").strip()
                if mfr and model and finish:
                    fully_parsed += 1
                    break  # one item per set is enough
        assert fully_parsed >= 3, (
            f"Only {fully_parsed} sets have at least one fully-parsed item"
        )


# ── Quantities ────────────────────────────────────────────────────────────────

class TestMCAQuantities:
    """Quantity validation for MCA extraction (should pass today)."""

    def test_qty_values_within_range(self, extract_tables, large_pdf_path):
        with pdfplumber.open(str(large_pdf_path), unicode_norm="NFKC") as pdf:
            hw_sets = extract_tables.extract_all_hardware_sets(pdf)
            openings, _ = extract_tables.extract_opening_list(pdf, None)
            extract_tables.normalize_quantities(hw_sets, openings)
        for s in hw_sets:
            for item in s.items:
                assert 1 <= item.qty <= 10, (
                    f"Set {s.set_id} item '{item.name}': qty={item.qty} outside 1-10"
                )

    def test_no_zero_qty_items(self, extract_tables, large_pdf_path):
        with pdfplumber.open(str(large_pdf_path), unicode_norm="NFKC") as pdf:
            hw_sets = extract_tables.extract_all_hardware_sets(pdf)
        for s in hw_sets:
            for item in s.items:
                assert item.qty != 0, (
                    f"Set {s.set_id} item '{item.name}' has qty=0"
                )


# ── Set ID Parsing ────────────────────────────────────────────────────────────

MCA_SET_ID_PATTERN = re.compile(r"^[IE]\d[A-Z]{1,3}-\d[A-Z](\.[A-Z0-9]+)?$")


class TestMCASetIdParsing:
    """Validate MCA set_id format and count."""

    def test_set_ids_match_mca_format(self, extract_tables, large_pdf_path):
        with pdfplumber.open(str(large_pdf_path), unicode_norm="NFKC") as pdf:
            hw_sets = extract_tables.extract_all_hardware_sets(pdf)
        assert len(hw_sets) > 0
        matching = [s for s in hw_sets if MCA_SET_ID_PATTERN.match(s.set_id)]
        ratio = len(matching) / len(hw_sets)
        non_matching = [s.set_id for s in hw_sets if not MCA_SET_ID_PATTERN.match(s.set_id)]
        assert ratio >= 0.90, (
            f"Only {len(matching)}/{len(hw_sets)} ({ratio:.0%}) match MCA format. "
            f"Non-matching: {non_matching[:10]}"
        )

    def test_at_least_40_sets_extracted(self, extract_tables, large_pdf_path):
        with pdfplumber.open(str(large_pdf_path), unicode_norm="NFKC") as pdf:
            hw_sets = extract_tables.extract_all_hardware_sets(pdf)
        assert len(hw_sets) >= 40, f"Expected >=40 sets, got {len(hw_sets)}"

    def test_no_duplicate_set_ids(self, extract_tables, large_pdf_path):
        with pdfplumber.open(str(large_pdf_path), unicode_norm="NFKC") as pdf:
            hw_sets = extract_tables.extract_all_hardware_sets(pdf)
        ids = [s.set_id for s in hw_sets]
        dupes = [sid for sid in ids if ids.count(sid) > 1]
        assert len(set(dupes)) == 0, f"Duplicate set IDs: {sorted(set(dupes))}"


# ── Structural Integrity ─────────────────────────────────────────────────────

class TestMCAStructuralIntegrity:
    """Basic structural checks on MCA extraction output."""

    def test_every_set_has_items(self, extract_tables, large_pdf_path):
        with pdfplumber.open(str(large_pdf_path), unicode_norm="NFKC") as pdf:
            hw_sets = extract_tables.extract_all_hardware_sets(pdf)
        empty = [s.set_id for s in hw_sets if len(s.items) == 0]
        assert len(empty) == 0, f"Sets with no items: {empty}"

    def test_set_headings_not_empty(self, extract_tables, large_pdf_path):
        with pdfplumber.open(str(large_pdf_path), unicode_norm="NFKC") as pdf:
            hw_sets = extract_tables.extract_all_hardware_sets(pdf)
        no_heading = [s.set_id for s in hw_sets if not (s.heading or "").strip()]
        assert len(no_heading) == 0, f"Sets with empty heading: {no_heading}"
