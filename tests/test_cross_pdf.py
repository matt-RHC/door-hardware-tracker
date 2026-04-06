"""
Cross-PDF structural consistency tests (BUG-11).

Runs extraction on multiple golden PDFs and validates that output
meets structural invariants. Parametrized across SMALL, MEDIUM, LARGE,
RPL10, and CAA (AKN excluded — non-standard format, BUG-10).
"""
import re

import pytest

CROSS_PDF_NAMES = ["SMALL", "MEDIUM", "LARGE", "RPL10", "CAA"]


# ── Parametrized fixture ─────────────────────────────────────────────────────

@pytest.fixture(params=CROSS_PDF_NAMES)
def pdf_pipeline_result(request, pipeline_results, pdf_catalog):
    """Run full pipeline for each golden PDF. Skip if PDF missing."""
    name = request.param
    path = pdf_catalog.get(name)
    if path is None:
        pytest.skip(f"{name} PDF not found in tests/fixtures/")
    result = pipeline_results.get(name)
    if result is None:
        pytest.skip(f"{name} pipeline returned None")
    hw_sets, openings, confirmed, flagged, ref_codes, tables_found = result
    return name, hw_sets, openings, confirmed, flagged


# ── Opening Structure ─────────────────────────────────────────────────────────

@pytest.mark.cross_pdf
class TestOpeningStructure:

    def test_every_opening_has_door_number(self, pdf_pipeline_result):
        name, _, openings, _, _ = pdf_pipeline_result
        empty = [i for i, o in enumerate(openings) if not (o.door_number or "").strip()]
        assert len(empty) == 0, (
            f"[{name}] {len(empty)} openings have empty door_number (indices: {empty[:10]})"
        )

    def test_door_numbers_unique_within_project(self, pdf_pipeline_result):
        name, _, openings, _, _ = pdf_pipeline_result
        numbers = [o.door_number for o in openings if (o.door_number or "").strip()]
        seen = {}
        dupes = []
        for dn in numbers:
            if dn in seen:
                dupes.append(dn)
            seen[dn] = True
        assert len(dupes) == 0, (
            f"[{name}] Duplicate door numbers: {sorted(set(dupes))[:20]}"
        )

    def test_all_set_ids_exist_in_hardware_sets(self, pdf_pipeline_result):
        name, hw_sets, openings, _, _ = pdf_pipeline_result
        set_ids = {s.set_id for s in hw_sets}
        # Also include generic_set_id for matching
        generic_ids = {s.generic_set_id for s in hw_sets if s.generic_set_id}
        all_known = set_ids | generic_ids

        orphaned = []
        for o in openings:
            ref = (o.hw_set or "").strip()
            if not ref:
                continue  # no set assigned
            if o.by_others:
                continue  # "BY OTHERS" won't have a matching set
            if ref not in all_known:
                orphaned.append((o.door_number, ref))

        # 5% tolerance for edge cases
        total_with_set = sum(1 for o in openings if (o.hw_set or "").strip() and not o.by_others)
        if total_with_set == 0:
            return  # no set assignments to validate
        ratio = len(orphaned) / total_with_set
        assert ratio <= 0.05, (
            f"[{name}] {len(orphaned)}/{total_with_set} ({ratio:.0%}) openings reference "
            f"unknown set IDs: {orphaned[:10]}"
        )


# ── Hardware Set Structure ────────────────────────────────────────────────────

@pytest.mark.cross_pdf
class TestHardwareSetStructure:

    def test_every_set_has_at_least_one_item(self, pdf_pipeline_result):
        name, hw_sets, _, _, _ = pdf_pipeline_result
        empty = [s.set_id for s in hw_sets if len(s.items) == 0]
        assert len(empty) == 0, f"[{name}] Sets with no items: {empty}"

    def test_no_item_has_zero_qty(self, pdf_pipeline_result):
        name, hw_sets, _, _, _ = pdf_pipeline_result
        zeros = []
        for s in hw_sets:
            for item in s.items:
                if item.qty == 0:
                    zeros.append((s.set_id, item.name))
        assert len(zeros) == 0, f"[{name}] Items with qty=0: {zeros[:10]}"

    def test_no_item_has_extreme_qty(self, pdf_pipeline_result):
        name, hw_sets, _, _, _ = pdf_pipeline_result
        extreme = []
        for s in hw_sets:
            for item in s.items:
                if item.qty > 100:
                    extreme.append((s.set_id, item.name, item.qty))
        assert len(extreme) == 0, f"[{name}] Items with qty>100: {extreme[:10]}"


# ── Fire Rating Values ────────────────────────────────────────────────────────

FIRE_RATING_PATTERN = re.compile(
    r"^("
    r"|"  # empty string
    r"\d{1,3}\s*[Mm][Ii][Nn](\.?)"  # 20Min, 45min, 90MIN.
    r"|\d{1,3}"                       # bare numbers: 20, 45, 60, 90, 120, 180
    r"|\d+\.?\d*\s*[Hh][Rr]\.?"      # 1HR, 1.5Hr, 3hr.
    r"|[ABC]"                          # letter grades
    r"|NR|N/?A|NONE|RATED"            # codes
    r"|--?|—"                          # dashes
    r")$",
    re.IGNORECASE,
)


@pytest.mark.cross_pdf
class TestFireRatingValues:

    def test_fire_ratings_match_known_patterns(self, pdf_pipeline_result):
        name, _, openings, _, _ = pdf_pipeline_result
        unrecognized = []
        for o in openings:
            rating = (o.fire_rating or "").strip()
            if not rating:
                continue
            if not FIRE_RATING_PATTERN.match(rating):
                unrecognized.append((o.door_number, rating))
        assert len(unrecognized) == 0, (
            f"[{name}] Unrecognized fire ratings: {unrecognized[:20]}"
        )
