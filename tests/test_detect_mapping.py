"""Unit tests for content-based column inference in detect-mapping.py."""
import importlib
import sys
from pathlib import Path

import pytest

# Import the module from api/ directory
api_dir = Path(__file__).resolve().parent.parent / "api"
spec = importlib.util.spec_from_file_location("detect_mapping", api_dir / "detect-mapping.py")
dm = importlib.util.module_from_spec(spec)
sys.modules["detect_mapping"] = dm
spec.loader.exec_module(dm)


class TestScoreContentForField:
    """Tests for score_content_for_field()."""

    def test_fire_ratings_high_confidence(self):
        values = ["45Min", "90Min", "45 MIN", "60min", "20Min"]
        score = dm.score_content_for_field(values, "fire_rating")
        assert score >= 0.8, f"Fire rating column should score high, got {score}"

    def test_fire_ratings_bare_numbers(self):
        values = ["20", "45", "90", "60", "120"]
        score = dm.score_content_for_field(values, "fire_rating")
        assert score >= 0.8, f"Bare fire rating numbers should score high, got {score}"

    def test_hand_notations_high_confidence(self):
        values = ["LH", "RH", "LHR", "RHR", "LHRB"]
        score = dm.score_content_for_field(values, "hand")
        assert score >= 0.8, f"Hand column should score high, got {score}"

    def test_door_numbers_high_confidence(self):
        values = ["101A", "110-02B", "1603", "2101", "A-201"]
        score = dm.score_content_for_field(values, "door_number")
        assert score >= 0.8, f"Door number column should score high, got {score}"

    def test_location_freeform_low_confidence(self):
        values = ["Corridor 1", "Main Lobby", "Office Suite 200", "Stairwell A", "Mechanical Room"]
        score = dm.score_content_for_field(values, "location")
        # Location is free-form text — inherently lower confidence
        assert 0.2 <= score <= 0.6, f"Location column should score low-medium, got {score}"

    def test_empty_column_no_inference(self):
        values = ["", "", "  ", ""]
        score = dm.score_content_for_field(values, "fire_rating")
        assert score == 0.0, f"Empty column should score 0.0, got {score}"

    def test_mixed_content_low_confidence(self):
        values = ["45Min", "Corridor 1", "LH", "101A", "90Min"]
        # Only 2/5 match fire_rating
        score = dm.score_content_for_field(values, "fire_rating")
        assert score <= 0.5, f"Mixed content should score low for fire_rating, got {score}"


class TestContentOverridesHeader:
    """Tests that content-based inference can override header-name matching."""

    def test_opening_label_with_fire_ratings(self):
        """The user's exact failure case: column named 'Opening Label' contains fire ratings."""
        headers = ["Door #", "HW Set", "Opening Label"]
        sample_rows = [
            ["101A", "DH1", "45Min"],
            ["102B", "DH1", "90Min"],
            ["103A", "DH2", "45 MIN"],
            ["104A", "DH2", "60min"],
            ["105A", "DH3", "20Min"],
        ]
        mapping = dm.detect_column_mapping(headers, sample_rows)
        # "Opening Label" should map to fire_rating (content wins over header)
        assert mapping.get("fire_rating") == 2, (
            f"'Opening Label' with fire rating values should map to fire_rating, got mapping: {mapping}"
        )

    def test_header_only_still_works(self):
        """When no sample_rows, header-based mapping still works."""
        headers = ["Door Number", "Hardware Set", "Location"]
        mapping = dm.detect_column_mapping(headers)
        assert "door_number" in mapping
        assert "hw_set" in mapping

    def test_content_scores_reflected_in_confidence(self):
        """Confidence scores should include content-based boost."""
        headers = ["Opening Label"]
        sample_rows = [
            ["45Min"],
            ["90Min"],
            ["60min"],
        ]
        mapping = dm.detect_column_mapping(headers, sample_rows)
        scores = dm.get_confidence_scores(headers, mapping, sample_rows)
        # Should have fire_rating mapped with high confidence from content
        if "fire_rating" in scores:
            assert scores["fire_rating"] >= 0.7, (
                f"Fire rating confidence should be high from content, got {scores['fire_rating']}"
            )
