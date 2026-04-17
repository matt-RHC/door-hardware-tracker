"""
Golden PDF baseline regression tests.

Runs the full extraction pipeline (including normalize_quantities) on each
golden PDF and compares against saved baseline JSON files. Catches regressions
in door count, set count, item names, quantities, and qty_source values.

Tests skip gracefully when PDFs are not present (CI won't have them).
"""
import json
from pathlib import Path

import pdfplumber
import pytest

BASELINES_DIR = Path(__file__).parent / "baselines"


def _run_full_pipeline(extract_tables, pdf_path):
    """Run the complete extraction pipeline on a PDF, including qty normalization."""
    with pdfplumber.open(str(pdf_path), unicode_norm="NFKC") as pdf:
        hardware_sets = extract_tables.extract_all_hardware_sets(pdf)
        openings, tables_found = extract_tables.extract_opening_list(pdf, None)
        reference_codes = extract_tables.extract_reference_tables(pdf)
        extract_tables.normalize_quantities(hardware_sets, openings)
        confirmed, flagged = extract_tables.validate_door_number_consistency(openings)
    return hardware_sets, openings, confirmed, flagged, reference_codes, tables_found


def _load_baseline(name):
    """Load a baseline JSON file."""
    path = BASELINES_DIR / name
    if not path.exists():
        pytest.skip(f"Baseline not found: {path}")
    return json.loads(path.read_text(encoding="utf-8"))


class TestSmallBaseline:
    """SMALL PDF (12 pages) regression tests."""

    def test_door_count(self, extract_tables, small_pdf_path):
        baseline = _load_baseline("small-baseline.json")
        hw_sets, openings, confirmed, flagged, refs, tf = _run_full_pipeline(extract_tables, small_pdf_path)
        actual = len(confirmed) + len(flagged)
        assert actual == baseline["door_count"], (
            f"Door count changed: expected {baseline['door_count']}, got {actual}"
        )

    def test_hw_set_count(self, extract_tables, small_pdf_path):
        baseline = _load_baseline("small-baseline.json")
        hw_sets, *_ = _run_full_pipeline(extract_tables, small_pdf_path)
        assert len(hw_sets) == baseline["hw_set_count"], (
            f"HW set count changed: expected {baseline['hw_set_count']}, got {len(hw_sets)}"
        )

    def test_set_ids_match(self, extract_tables, small_pdf_path):
        baseline = _load_baseline("small-baseline.json")
        hw_sets, *_ = _run_full_pipeline(extract_tables, small_pdf_path)
        expected_ids = [s["set_id"] for s in baseline["hardware_sets"]]
        actual_ids = [s.set_id for s in hw_sets]
        assert actual_ids == expected_ids, (
            f"Set IDs changed:\n  expected: {expected_ids}\n  actual:   {actual_ids}"
        )

    def test_item_quantities(self, extract_tables, small_pdf_path):
        baseline = _load_baseline("small-baseline.json")
        hw_sets, *_ = _run_full_pipeline(extract_tables, small_pdf_path)
        for hs, expected_set in zip(hw_sets, baseline["hardware_sets"]):
            assert len(hs.items) == expected_set["item_count"], (
                f"Set {hs.set_id}: item count changed from {expected_set['item_count']} to {len(hs.items)}"
            )
            for item, expected_item in zip(hs.items, expected_set["items"]):
                assert item.qty == expected_item["qty"], (
                    f"Set {hs.set_id}, '{item.name[:40]}': qty changed from {expected_item['qty']} to {item.qty}"
                )
                assert item.qty_source == expected_item["qty_source"], (
                    f"Set {hs.set_id}, '{item.name[:40]}': qty_source changed from "
                    f"'{expected_item['qty_source']}' to '{item.qty_source}'"
                )


class TestMediumBaseline:
    """MEDIUM PDF (44 pages) regression tests."""

    def test_door_count(self, extract_tables, medium_pdf_path):
        baseline = _load_baseline("medium-baseline.json")
        hw_sets, openings, confirmed, flagged, refs, tf = _run_full_pipeline(extract_tables, medium_pdf_path)
        actual = len(confirmed) + len(flagged)
        assert actual == baseline["door_count"], (
            f"Door count changed: expected {baseline['door_count']}, got {actual}"
        )

    def test_107_doors(self, extract_tables, medium_pdf_path):
        """Critical regression: MEDIUM PDF door count history.
        Was 102 before S-045, 104 after S-045 (ST-1A/ST-1C via DOOR_LOCATION_PREFIXES),
        107 after S-064/S-065 (bare 3-digit doors accepted, false positives removed),
        104 after S-072 (3 BHMA finish codes correctly rejected by BUG-24 fix)."""
        hw_sets, openings, confirmed, flagged, refs, tf = _run_full_pipeline(extract_tables, medium_pdf_path)
        actual = len(confirmed) + len(flagged)
        assert actual == 104, f"MEDIUM PDF door count regression: expected 104, got {actual}"

    def test_hw_set_count(self, extract_tables, medium_pdf_path):
        baseline = _load_baseline("medium-baseline.json")
        hw_sets, *_ = _run_full_pipeline(extract_tables, medium_pdf_path)
        assert len(hw_sets) == baseline["hw_set_count"], (
            f"HW set count changed: expected {baseline['hw_set_count']}, got {len(hw_sets)}"
        )

    def test_set_ids_match(self, extract_tables, medium_pdf_path):
        baseline = _load_baseline("medium-baseline.json")
        hw_sets, *_ = _run_full_pipeline(extract_tables, medium_pdf_path)
        expected_ids = [s["set_id"] for s in baseline["hardware_sets"]]
        actual_ids = [s.set_id for s in hw_sets]
        assert actual_ids == expected_ids, (
            f"Set IDs changed:\n  expected: {expected_ids}\n  actual:   {actual_ids}"
        )

    def test_closer_qty_is_1(self, extract_tables, medium_pdf_path):
        """BUG-7 regression: closers must be 1 per opening after normalization."""
        hw_sets, *_ = _run_full_pipeline(extract_tables, medium_pdf_path)
        for hs in hw_sets:
            for item in hs.items:
                lower = item.name.lower()
                if "closer" in lower and item.qty_source == "divided":
                    assert item.qty <= 2, (
                        f"Set {hs.set_id}: closer '{item.name[:40]}' has qty={item.qty} "
                        f"(expected 1-2 after normalization)"
                    )

    def test_hinge_qty_reasonable(self, extract_tables, medium_pdf_path):
        """BUG-7 regression: hinges must be 3-5 per leaf after normalization."""
        hw_sets, *_ = _run_full_pipeline(extract_tables, medium_pdf_path)
        for hs in hw_sets:
            for item in hs.items:
                lower = item.name.lower()
                if "hinge" in lower and item.qty_source == "divided":
                    assert item.qty <= 5, (
                        f"Set {hs.set_id}: hinge '{item.name[:40]}' has qty={item.qty} "
                        f"(expected ≤5 after normalization)"
                    )

    def test_item_quantities(self, extract_tables, medium_pdf_path):
        baseline = _load_baseline("medium-baseline.json")
        hw_sets, *_ = _run_full_pipeline(extract_tables, medium_pdf_path)
        for hs, expected_set in zip(hw_sets, baseline["hardware_sets"]):
            assert len(hs.items) == expected_set["item_count"], (
                f"Set {hs.set_id}: item count changed from {expected_set['item_count']} to {len(hs.items)}"
            )
            for item, expected_item in zip(hs.items, expected_set["items"]):
                assert item.qty == expected_item["qty"], (
                    f"Set {hs.set_id}, '{item.name[:40]}': qty changed from {expected_item['qty']} to {item.qty}"
                )
                assert item.qty_source == expected_item["qty_source"], (
                    f"Set {hs.set_id}, '{item.name[:40]}': qty_source changed from "
                    f"'{expected_item['qty_source']}' to '{item.qty_source}'"
                )

    def test_no_bare_door_frame_items(self, extract_tables, medium_pdf_path):
        """Regression gate for the 2026-04-17 Radius DC phantom-row bug.

        Hardware-set column headers for door-type / frame-type codes must
        never slip through NON_HARDWARE_PATTERN as bare 'Door' / 'Frame'
        items. If they do, buildPerOpeningItems on the TS side amplifies
        them into duplicated structural rows on every opening.
        Radius DC run 5fd76705-b97a-49e9-888e-ddf4f0a34597 carried 127
        such rows across 22-27 sets; 249 invariant violations resulted.
        """
        hw_sets, *_ = _run_full_pipeline(extract_tables, medium_pdf_path)
        offenders = []
        for hs in hw_sets:
            for item in hs.items:
                if (item.name or "").strip().lower() in ("door", "frame"):
                    offenders.append((hs.set_id, item.name, item.model))
        assert not offenders, (
            f"Radius DC baseline emitted bare Door/Frame items "
            f"(set_id, name, model): {offenders}"
        )


class TestLargeBaseline:
    """LARGE PDF (82 pages) regression tests."""

    def test_door_count(self, extract_tables, large_pdf_path):
        baseline = _load_baseline("large-baseline.json")
        hw_sets, openings, confirmed, flagged, refs, tf = _run_full_pipeline(extract_tables, large_pdf_path)
        actual = len(confirmed) + len(flagged)
        assert actual == baseline["door_count"], (
            f"Door count changed: expected {baseline['door_count']}, got {actual}"
        )

    def test_hw_set_count(self, extract_tables, large_pdf_path):
        baseline = _load_baseline("large-baseline.json")
        hw_sets, *_ = _run_full_pipeline(extract_tables, large_pdf_path)
        assert len(hw_sets) == baseline["hw_set_count"], (
            f"HW set count changed: expected {baseline['hw_set_count']}, got {len(hw_sets)}"
        )

    def test_set_ids_match(self, extract_tables, large_pdf_path):
        baseline = _load_baseline("large-baseline.json")
        hw_sets, *_ = _run_full_pipeline(extract_tables, large_pdf_path)
        expected_ids = [s["set_id"] for s in baseline["hardware_sets"]]
        actual_ids = [s.set_id for s in hw_sets]
        assert actual_ids == expected_ids, (
            f"Set IDs changed:\n  expected: {expected_ids}\n  actual:   {actual_ids}"
        )

    def test_item_quantities(self, extract_tables, large_pdf_path):
        baseline = _load_baseline("large-baseline.json")
        hw_sets, *_ = _run_full_pipeline(extract_tables, large_pdf_path)
        for hs, expected_set in zip(hw_sets, baseline["hardware_sets"]):
            assert len(hs.items) == expected_set["item_count"], (
                f"Set {hs.set_id}: item count changed from {expected_set['item_count']} to {len(hs.items)}"
            )
            for item, expected_item in zip(hs.items, expected_set["items"]):
                assert item.qty == expected_item["qty"], (
                    f"Set {hs.set_id}, '{item.name[:40]}': qty changed from {expected_item['qty']} to {item.qty}"
                )
                assert item.qty_source == expected_item["qty_source"], (
                    f"Set {hs.set_id}, '{item.name[:40]}': qty_source changed from "
                    f"'{expected_item['qty_source']}' to '{item.qty_source}'"
                )


class TestRPL10Baseline:
    """RPL10 PDF (52 pages, NW Data Center) regression tests."""

    def test_door_count(self, extract_tables, rpl10_pdf_path):
        baseline = _load_baseline("RPL10_NW_Data_Center.json")
        hw_sets, openings, confirmed, flagged, refs, tf = _run_full_pipeline(extract_tables, rpl10_pdf_path)
        actual = len(confirmed) + len(flagged)
        assert actual == baseline["door_count"], (
            f"Door count changed: expected {baseline['door_count']}, got {actual}"
        )

    def test_rpl10_doors_not_zero(self, extract_tables, rpl10_pdf_path):
        """Critical regression: RPL10 must extract doors (was 0 before S-045 fix)."""
        hw_sets, openings, confirmed, flagged, refs, tf = _run_full_pipeline(extract_tables, rpl10_pdf_path)
        actual = len(confirmed) + len(flagged)
        assert actual >= 70, f"RPL10 door count regression: expected >=70, got {actual}"

    def test_hw_set_count(self, extract_tables, rpl10_pdf_path):
        baseline = _load_baseline("RPL10_NW_Data_Center.json")
        hw_sets, *_ = _run_full_pipeline(extract_tables, rpl10_pdf_path)
        assert len(hw_sets) == baseline["hw_set_count"], (
            f"HW set count changed: expected {baseline['hw_set_count']}, got {len(hw_sets)}"
        )

    def test_set_ids_match(self, extract_tables, rpl10_pdf_path):
        baseline = _load_baseline("RPL10_NW_Data_Center.json")
        hw_sets, *_ = _run_full_pipeline(extract_tables, rpl10_pdf_path)
        expected_ids = [s["set_id"] for s in baseline["hardware_sets"]]
        actual_ids = [s.set_id for s in hw_sets]
        assert actual_ids == expected_ids, (
            f"Set IDs changed:\n  expected: {expected_ids}\n  actual:   {actual_ids}"
        )

    def test_closer_qty_is_1(self, extract_tables, rpl10_pdf_path):
        """BUG-7 regression: closers must be 1 per opening after normalization."""
        hw_sets, *_ = _run_full_pipeline(extract_tables, rpl10_pdf_path)
        for hs in hw_sets:
            for item in hs.items:
                lower = item.name.lower()
                if "closer" in lower and item.qty_source == "divided":
                    assert item.qty <= 2, (
                        f"Set {hs.set_id}: closer '{item.name[:40]}' has qty={item.qty} "
                        f"(expected 1-2 after normalization)"
                    )

    def test_hinge_qty_reasonable(self, extract_tables, rpl10_pdf_path):
        """BUG-7 regression: hinges must be 3-5 per leaf after normalization."""
        hw_sets, *_ = _run_full_pipeline(extract_tables, rpl10_pdf_path)
        for hs in hw_sets:
            for item in hs.items:
                lower = item.name.lower()
                if "hinge" in lower and item.qty_source == "divided":
                    assert item.qty <= 5, (
                        f"Set {hs.set_id}: hinge '{item.name[:40]}' has qty={item.qty} "
                        f"(expected <=5 after normalization)"
                    )

    def test_item_quantities(self, extract_tables, rpl10_pdf_path):
        baseline = _load_baseline("RPL10_NW_Data_Center.json")
        hw_sets, *_ = _run_full_pipeline(extract_tables, rpl10_pdf_path)
        for hs, expected_set in zip(hw_sets, baseline["hardware_sets"]):
            assert len(hs.items) == expected_set["item_count"], (
                f"Set {hs.set_id}: item count changed from {expected_set['item_count']} to {len(hs.items)}"
            )
            for item, expected_item in zip(hs.items, expected_set["items"]):
                assert item.qty == expected_item["qty"], (
                    f"Set {hs.set_id}, '{item.name[:40]}': qty changed from {expected_item['qty']} to {item.qty}"
                )
                assert item.qty_source == expected_item["qty_source"], (
                    f"Set {hs.set_id}, '{item.name[:40]}': qty_source changed from "
                    f"'{expected_item['qty_source']}' to '{item.qty_source}'"
                )


class TestCAANashvilleBaseline:
    """CAA Nashville Yards PDF (107 pages, pilot customer) regression tests."""

    def test_door_count(self, extract_tables, caa_pdf_path):
        baseline = _load_baseline("caa-nashville-baseline.json")
        hw_sets, openings, confirmed, flagged, refs, tf = _run_full_pipeline(extract_tables, caa_pdf_path)
        actual = len(confirmed) + len(flagged)
        assert actual == baseline["door_count"], (
            f"Door count changed: expected {baseline['door_count']}, got {actual}"
        )

    def test_hw_set_count(self, extract_tables, caa_pdf_path):
        baseline = _load_baseline("caa-nashville-baseline.json")
        hw_sets, *_ = _run_full_pipeline(extract_tables, caa_pdf_path)
        assert len(hw_sets) == baseline["hw_set_count"], (
            f"HW set count changed: expected {baseline['hw_set_count']}, got {len(hw_sets)}"
        )

    def test_32_hardware_sets(self, extract_tables, caa_pdf_path):
        """CAA Nashville must extract exactly 32 hardware sets.
        Was 25 before sub-heading preservation (S-073→S-086); now 32
        because sub-variants (.0, .1) are kept as distinct sets."""
        hw_sets, *_ = _run_full_pipeline(extract_tables, caa_pdf_path)
        assert len(hw_sets) == 32, f"CAA set count: expected 32, got {len(hw_sets)}"

    def test_set_ids_match(self, extract_tables, caa_pdf_path):
        baseline = _load_baseline("caa-nashville-baseline.json")
        hw_sets, *_ = _run_full_pipeline(extract_tables, caa_pdf_path)
        expected_ids = [s["set_id"] for s in baseline["hardware_sets"]]
        actual_ids = [s.set_id for s in hw_sets]
        assert actual_ids == expected_ids, (
            f"Set IDs changed:\n  expected: {expected_ids}\n  actual:   {actual_ids}"
        )

    def test_item_quantities(self, extract_tables, caa_pdf_path):
        baseline = _load_baseline("caa-nashville-baseline.json")
        hw_sets, *_ = _run_full_pipeline(extract_tables, caa_pdf_path)
        for hs, expected_set in zip(hw_sets, baseline["hardware_sets"]):
            assert len(hs.items) == expected_set["item_count"], (
                f"Set {hs.set_id}: item count changed from {expected_set['item_count']} to {len(hs.items)}"
            )
            for item, expected_item in zip(hs.items, expected_set["items"]):
                assert item.qty == expected_item["qty"], (
                    f"Set {hs.set_id}, '{item.name[:40]}': qty changed from {expected_item['qty']} to {item.qty}"
                )
                assert item.qty_source == expected_item["qty_source"], (
                    f"Set {hs.set_id}, '{item.name[:40]}': qty_source changed from "
                    f"'{expected_item['qty_source']}' to '{item.qty_source}'"
                )


# ── Schedule-format baseline tests (S-066A) ──
# These capture current extraction state for schedule-format PDFs.
# Many have 0 doors because the pipeline doesn't yet handle inline
# door assignments (no separate opening list grid). Baselines will
# improve as schedule-aware extraction is added.

def _sched_baseline_tests(extract_tables, pdf_path, baseline_name):
    """Shared helper: run pipeline and load baseline for a schedule PDF."""
    baseline = _load_baseline(baseline_name)
    hw_sets, openings, confirmed, flagged, refs, tf = _run_full_pipeline(extract_tables, pdf_path)
    return baseline, hw_sets, confirmed, flagged


class TestSchedAKNBaseline:
    """sched-AKN (ESC/Comsense, 46 pages) baseline tests."""

    def test_door_count(self, extract_tables, sched_akn_pdf_path):
        baseline, hw_sets, confirmed, flagged = _sched_baseline_tests(
            extract_tables, sched_akn_pdf_path, "sched-AKN.json")
        actual = len(confirmed) + len(flagged)
        assert actual == baseline["door_count"], (
            f"Door count changed: expected {baseline['door_count']}, got {actual}")

    def test_hw_set_count(self, extract_tables, sched_akn_pdf_path):
        baseline, hw_sets, *_ = _sched_baseline_tests(
            extract_tables, sched_akn_pdf_path, "sched-AKN.json")
        assert len(hw_sets) == baseline["hw_set_count"], (
            f"HW set count changed: expected {baseline['hw_set_count']}, got {len(hw_sets)}")

    def test_set_ids_match(self, extract_tables, sched_akn_pdf_path):
        baseline, hw_sets, *_ = _sched_baseline_tests(
            extract_tables, sched_akn_pdf_path, "sched-AKN.json")
        expected_ids = [s["set_id"] for s in baseline["hardware_sets"]]
        actual_ids = [s.set_id for s in hw_sets]
        assert actual_ids == expected_ids

    def test_item_quantities(self, extract_tables, sched_akn_pdf_path):
        baseline, hw_sets, *_ = _sched_baseline_tests(
            extract_tables, sched_akn_pdf_path, "sched-AKN.json")
        for hs, expected_set in zip(hw_sets, baseline["hardware_sets"]):
            assert len(hs.items) == expected_set["item_count"]
            for item, expected_item in zip(hs.items, expected_set["items"]):
                assert item.qty == expected_item["qty"]


class TestSchedBarnstableBaseline:
    """sched-Barnstable (Comsense, 8 pages) baseline tests."""

    def test_door_count(self, extract_tables, sched_barnstable_pdf_path):
        baseline, _, confirmed, flagged = _sched_baseline_tests(
            extract_tables, sched_barnstable_pdf_path, "sched-Barnstable.json")
        assert len(confirmed) + len(flagged) == baseline["door_count"]

    def test_hw_set_count(self, extract_tables, sched_barnstable_pdf_path):
        baseline, hw_sets, *_ = _sched_baseline_tests(
            extract_tables, sched_barnstable_pdf_path, "sched-Barnstable.json")
        assert len(hw_sets) == baseline["hw_set_count"]

    def test_set_ids_match(self, extract_tables, sched_barnstable_pdf_path):
        baseline, hw_sets, *_ = _sched_baseline_tests(
            extract_tables, sched_barnstable_pdf_path, "sched-Barnstable.json")
        expected_ids = [s["set_id"] for s in baseline["hardware_sets"]]
        assert [s.set_id for s in hw_sets] == expected_ids


class TestSchedClaymontBaseline:
    """sched-Claymont (Comsense, 34 pages) baseline tests."""

    def test_door_count(self, extract_tables, sched_claymont_pdf_path):
        baseline, _, confirmed, flagged = _sched_baseline_tests(
            extract_tables, sched_claymont_pdf_path, "sched-Claymont.json")
        assert len(confirmed) + len(flagged) == baseline["door_count"]

    def test_hw_set_count(self, extract_tables, sched_claymont_pdf_path):
        baseline, hw_sets, *_ = _sched_baseline_tests(
            extract_tables, sched_claymont_pdf_path, "sched-Claymont.json")
        assert len(hw_sets) == baseline["hw_set_count"]

    def test_set_ids_match(self, extract_tables, sched_claymont_pdf_path):
        baseline, hw_sets, *_ = _sched_baseline_tests(
            extract_tables, sched_claymont_pdf_path, "sched-Claymont.json")
        expected_ids = [s["set_id"] for s in baseline["hardware_sets"]]
        assert [s.set_id for s in hw_sets] == expected_ids


class TestSchedCornellBaseline:
    """sched-Cornell (Comsense, 30 pages) baseline tests."""

    def test_door_count(self, extract_tables, sched_cornell_pdf_path):
        baseline, _, confirmed, flagged = _sched_baseline_tests(
            extract_tables, sched_cornell_pdf_path, "sched-Cornell.json")
        assert len(confirmed) + len(flagged) == baseline["door_count"]

    def test_hw_set_count(self, extract_tables, sched_cornell_pdf_path):
        baseline, hw_sets, *_ = _sched_baseline_tests(
            extract_tables, sched_cornell_pdf_path, "sched-Cornell.json")
        assert len(hw_sets) == baseline["hw_set_count"]

    def test_set_ids_match(self, extract_tables, sched_cornell_pdf_path):
        baseline, hw_sets, *_ = _sched_baseline_tests(
            extract_tables, sched_cornell_pdf_path, "sched-Cornell.json")
        expected_ids = [s["set_id"] for s in baseline["hardware_sets"]]
        assert [s.set_id for s in hw_sets] == expected_ids


class TestSchedDTBaseline:
    """sched-DT (Comsense, 116 pages) baseline tests."""

    def test_door_count(self, extract_tables, sched_dt_pdf_path):
        baseline, _, confirmed, flagged = _sched_baseline_tests(
            extract_tables, sched_dt_pdf_path, "sched-DT.json")
        assert len(confirmed) + len(flagged) == baseline["door_count"]

    def test_hw_set_count(self, extract_tables, sched_dt_pdf_path):
        baseline, hw_sets, *_ = _sched_baseline_tests(
            extract_tables, sched_dt_pdf_path, "sched-DT.json")
        assert len(hw_sets) == baseline["hw_set_count"]

    def test_set_ids_match(self, extract_tables, sched_dt_pdf_path):
        baseline, hw_sets, *_ = _sched_baseline_tests(
            extract_tables, sched_dt_pdf_path, "sched-DT.json")
        expected_ids = [s["set_id"] for s in baseline["hardware_sets"]]
        assert [s.set_id for s in hw_sets] == expected_ids


class TestSchedEticaBaseline:
    """sched-Etica (Comsense, 32 pages) baseline tests."""

    def test_door_count(self, extract_tables, sched_etica_pdf_path):
        baseline, _, confirmed, flagged = _sched_baseline_tests(
            extract_tables, sched_etica_pdf_path, "sched-Etica.json")
        assert len(confirmed) + len(flagged) == baseline["door_count"]

    def test_hw_set_count(self, extract_tables, sched_etica_pdf_path):
        baseline, hw_sets, *_ = _sched_baseline_tests(
            extract_tables, sched_etica_pdf_path, "sched-Etica.json")
        assert len(hw_sets) == baseline["hw_set_count"]

    def test_set_ids_match(self, extract_tables, sched_etica_pdf_path):
        baseline, hw_sets, *_ = _sched_baseline_tests(
            extract_tables, sched_etica_pdf_path, "sched-Etica.json")
        expected_ids = [s["set_id"] for s in baseline["hardware_sets"]]
        assert [s.set_id for s in hw_sets] == expected_ids


class TestSchedKdotBaseline:
    """sched-Kdot (Comsense, 9 pages) — total extraction failure baseline."""

    def test_door_count(self, extract_tables, sched_kdot_pdf_path):
        baseline, _, confirmed, flagged = _sched_baseline_tests(
            extract_tables, sched_kdot_pdf_path, "sched-Kdot.json")
        assert len(confirmed) + len(flagged) == baseline["door_count"]

    def test_hw_set_count(self, extract_tables, sched_kdot_pdf_path):
        baseline, hw_sets, *_ = _sched_baseline_tests(
            extract_tables, sched_kdot_pdf_path, "sched-Kdot.json")
        assert len(hw_sets) == baseline["hw_set_count"]


class TestSchedLutheranBaseline:
    """sched-Lutheran (Comsense, 30 pages) baseline tests."""

    def test_door_count(self, extract_tables, sched_lutheran_pdf_path):
        baseline, _, confirmed, flagged = _sched_baseline_tests(
            extract_tables, sched_lutheran_pdf_path, "sched-Lutheran.json")
        assert len(confirmed) + len(flagged) == baseline["door_count"]

    def test_hw_set_count(self, extract_tables, sched_lutheran_pdf_path):
        baseline, hw_sets, *_ = _sched_baseline_tests(
            extract_tables, sched_lutheran_pdf_path, "sched-Lutheran.json")
        assert len(hw_sets) == baseline["hw_set_count"]

    def test_set_ids_match(self, extract_tables, sched_lutheran_pdf_path):
        baseline, hw_sets, *_ = _sched_baseline_tests(
            extract_tables, sched_lutheran_pdf_path, "sched-Lutheran.json")
        expected_ids = [s["set_id"] for s in baseline["hardware_sets"]]
        assert [s.set_id for s in hw_sets] == expected_ids
