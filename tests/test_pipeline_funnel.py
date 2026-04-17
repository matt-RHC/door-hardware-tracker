"""
Pipeline funnel tests — runs pdfplumber -> Darrin LLM review -> merge
for each golden PDF that has ground truth, and prints a funnel table.

Usage:
  pytest tests/test_pipeline_funnel.py --run-ai-review -v   # full run with LLM
  pytest tests/test_pipeline_funnel.py -v                    # skips LLM tests

Without ANTHROPIC_API_KEY: LLM review tests skip gracefully.
"""
import json
from pathlib import Path

import pytest

BASELINES_DIR = Path(__file__).parent / "baselines"

# Grid-format PDFs with reliable baselines
GRID_PDFS = ["SMALL", "MEDIUM", "LARGE", "RPL10", "CAA"]


def _extraction_to_dict(hw_sets, openings, confirmed, flagged):
    """Convert extraction pipeline objects to plain dicts for Darrin review."""
    sets_list = []
    for s in hw_sets:
        items = []
        for item in s.items:
            items.append({
                "name": getattr(item, "name", ""),
                "qty": getattr(item, "qty", 0),
                "qty_source": getattr(item, "qty_source", ""),
                "manufacturer": getattr(item, "manufacturer", ""),
                "model": getattr(item, "model", ""),
                "finish": getattr(item, "finish", ""),
            })
        sets_list.append({
            "set_id": s.set_id,
            "heading": getattr(s, "heading", ""),
            "items": items,
        })

    doors_list = []
    for d in confirmed + flagged:
        doors_list.append({
            "door_number": getattr(d, "door_number", str(d) if not hasattr(d, "door_number") else ""),
            "hw_set": getattr(d, "hw_set", ""),
        })

    return {"hardware_sets": sets_list, "openings": doors_list}


class TestPdfplumberFunnel:
    """Stage 1: pdfplumber extraction accuracy vs ground truth (no LLM)."""

    @pytest.mark.parametrize("pdf_key", GRID_PDFS)
    def test_door_count_matches_truth(self, pdf_key, pipeline_results, ground_truth):
        truth = ground_truth.get(pdf_key)
        if truth is None:
            pytest.skip(f"No ground truth for {pdf_key}")

        result = pipeline_results.get(pdf_key)
        if result is None:
            pytest.skip(f"PDF not available: {pdf_key}")

        hw_sets, openings, confirmed, flagged, refs, tf = result
        actual_doors = len(confirmed) + len(flagged)
        expected = truth["expected_door_count"]
        assert actual_doors == expected, (
            f"{pdf_key}: pdfplumber extracted {actual_doors} doors, expected {expected}"
        )

    @pytest.mark.parametrize("pdf_key", GRID_PDFS)
    def test_set_count_matches_truth(self, pdf_key, pipeline_results, ground_truth):
        truth = ground_truth.get(pdf_key)
        if truth is None:
            pytest.skip(f"No ground truth for {pdf_key}")

        result = pipeline_results.get(pdf_key)
        if result is None:
            pytest.skip(f"PDF not available: {pdf_key}")

        hw_sets, *_ = result
        expected = truth["expected_set_count"]
        assert len(hw_sets) == expected, (
            f"{pdf_key}: pdfplumber extracted {len(hw_sets)} sets, expected {expected}"
        )

    @pytest.mark.parametrize("pdf_key", GRID_PDFS)
    def test_set_ids_match_truth(self, pdf_key, pipeline_results, ground_truth):
        truth = ground_truth.get(pdf_key)
        if truth is None or "expected_set_ids" not in truth:
            pytest.skip(f"No set ID truth for {pdf_key}")

        result = pipeline_results.get(pdf_key)
        if result is None:
            pytest.skip(f"PDF not available: {pdf_key}")

        hw_sets, *_ = result
        actual_ids = [s.set_id for s in hw_sets]
        assert actual_ids == truth["expected_set_ids"], (
            f"{pdf_key}: set IDs differ\n  expected: {truth['expected_set_ids']}\n  actual:   {actual_ids}"
        )


@pytest.mark.llm_review
class TestDarrinFunnel:
    """Stage 2: Darrin LLM review + merge accuracy vs ground truth."""

    @pytest.mark.parametrize("pdf_key", GRID_PDFS)
    def test_review_returns_valid_json(self, pdf_key, pipeline_results, pdf_catalog, darrin_reviewer):
        pdf_path = pdf_catalog.get(pdf_key)
        if pdf_path is None:
            pytest.skip(f"PDF not available: {pdf_key}")

        result = pipeline_results.get(pdf_key)
        if result is None:
            pytest.skip(f"Pipeline result not available: {pdf_key}")

        hw_sets, openings, confirmed, flagged, refs, tf = result
        extraction_dict = _extraction_to_dict(hw_sets, openings, confirmed, flagged)

        review = darrin_reviewer["review"](pdf_path, extraction_dict)
        assert "corrections" in review
        assert "confidence" in review
        assert isinstance(review["confidence"], (int, float))

    @pytest.mark.parametrize("pdf_key", GRID_PDFS)
    def test_merge_preserves_door_count(self, pdf_key, pipeline_results, pdf_catalog, ground_truth, darrin_reviewer):
        truth = ground_truth.get(pdf_key)
        if truth is None:
            pytest.skip(f"No ground truth for {pdf_key}")

        pdf_path = pdf_catalog.get(pdf_key)
        if pdf_path is None:
            pytest.skip(f"PDF not available: {pdf_key}")

        result = pipeline_results.get(pdf_key)
        if result is None:
            pytest.skip(f"Pipeline result not available: {pdf_key}")

        hw_sets, openings, confirmed, flagged, refs, tf = result
        extraction_dict = _extraction_to_dict(hw_sets, openings, confirmed, flagged)

        review = darrin_reviewer["review"](pdf_path, extraction_dict)
        merged = darrin_reviewer["apply"](
            extraction_dict["hardware_sets"],
            extraction_dict["openings"],
            review["corrections"],
        )

        merged_doors = len(merged["doors"])
        expected = truth["expected_door_count"]
        # After LLM merge, door count should be >= original (LLM may add missing doors)
        assert merged_doors >= expected, (
            f"{pdf_key}: merged door count {merged_doors} < expected {expected}"
        )

    @pytest.mark.parametrize("pdf_key", GRID_PDFS)
    def test_merge_preserves_set_count(self, pdf_key, pipeline_results, pdf_catalog, ground_truth, darrin_reviewer):
        truth = ground_truth.get(pdf_key)
        if truth is None:
            pytest.skip(f"No ground truth for {pdf_key}")

        pdf_path = pdf_catalog.get(pdf_key)
        if pdf_path is None:
            pytest.skip(f"PDF not available: {pdf_key}")

        result = pipeline_results.get(pdf_key)
        if result is None:
            pytest.skip(f"Pipeline result not available: {pdf_key}")

        hw_sets, openings, confirmed, flagged, refs, tf = result
        extraction_dict = _extraction_to_dict(hw_sets, openings, confirmed, flagged)

        review = darrin_reviewer["review"](pdf_path, extraction_dict)
        merged = darrin_reviewer["apply"](
            extraction_dict["hardware_sets"],
            extraction_dict["openings"],
            review["corrections"],
        )

        merged_sets = len(merged["hardware_sets"])
        expected = truth["expected_set_count"]
        assert merged_sets >= expected, (
            f"{pdf_key}: merged set count {merged_sets} < expected {expected}"
        )


def test_print_funnel_table(pipeline_results, ground_truth, pdf_catalog, request):
    """Print a summary funnel table to stdout (always runs, no LLM needed)."""
    print("\n" + "=" * 72)
    print("PIPELINE FUNNEL — pdfplumber extraction vs ground truth")
    print("=" * 72)
    print(f"{'PDF':<12} {'Doors(exp)':>10} {'Doors(act)':>10} {'Sets(exp)':>10} {'Sets(act)':>10} {'Status':>8}")
    print("-" * 72)

    all_pass = True
    for pdf_key in GRID_PDFS:
        truth = ground_truth.get(pdf_key)
        result = pipeline_results.get(pdf_key)

        if truth is None:
            print(f"{pdf_key:<12} {'N/A':>10} {'N/A':>10} {'N/A':>10} {'N/A':>10} {'SKIP':>8}")
            continue

        if result is None:
            print(f"{pdf_key:<12} {truth['expected_door_count']:>10} {'N/A':>10} {truth['expected_set_count']:>10} {'N/A':>10} {'SKIP':>8}")
            continue

        hw_sets, openings, confirmed, flagged, refs, tf = result
        actual_doors = len(confirmed) + len(flagged)
        actual_sets = len(hw_sets)
        exp_doors = truth["expected_door_count"]
        exp_sets = truth["expected_set_count"]

        doors_ok = actual_doors == exp_doors
        sets_ok = actual_sets == exp_sets
        status = "PASS" if (doors_ok and sets_ok) else "FAIL"
        if status == "FAIL":
            all_pass = False

        d_mark = "" if doors_ok else " *"
        s_mark = "" if sets_ok else " *"
        print(f"{pdf_key:<12} {exp_doors:>10} {actual_doors:>9}{d_mark:1} {exp_sets:>10} {actual_sets:>9}{s_mark:1} {status:>8}")

    print("-" * 72)
    print("* = mismatch vs ground truth")
    print("=" * 72)
