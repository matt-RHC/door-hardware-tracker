"""
Tests for page classification logic (classify-pages.py).

These test the classification functions directly with synthetic text,
no PDF files required.
"""

import pytest

import classify_pages  # imported via conftest.py's _import_hyphenated


class TestPageTypeDetection:
    """Test that regex patterns correctly identify page types."""

    def test_door_schedule_header(self):
        text = "Opening List\nDoor No.  HW Set  Location  Type"
        assert classify_pages.DOOR_SCHEDULE_HEADERS.search(text)

    def test_door_schedule_header_variant(self):
        text = "Door Schedule\nOpening #  Hardware Set  Room"
        assert classify_pages.DOOR_SCHEDULE_HEADERS.search(text)

    def test_hw_set_heading_comsense(self):
        text = "Heading #DH1 (Set #1)\n3 Hinges"
        match = classify_pages.HW_SET_HEADING.search(text)
        assert match is not None

    def test_hw_set_heading_generic(self):
        text = "Hardware Set: DH-5\nItems below"
        match = classify_pages.HW_SET_HEADING.search(text)
        assert match is not None

    def test_reference_page(self):
        text = "Manufacturer List\nABB - ASSA ABLOY\nALG - Allegion"
        assert classify_pages.REFERENCE_PATTERNS.search(text)

    def test_cover_page(self):
        text = "Table of Contents\nSection 1 - Hardware Sets"
        assert classify_pages.COVER_PATTERNS.search(text)

    def test_hardware_item_names(self):
        text = "3 Hinge, 1 Lockset, 1 Closer, 1 Kick Plate"
        matches = classify_pages.HARDWARE_ITEM_NAMES.findall(text)
        assert len(matches) >= 4


class TestPdfSourceDetection:
    """Test PDF source/vendor detection from metadata."""

    def test_bluebeam(self):
        meta = {"Creator": "Bluebeam Revu 2020", "Producer": "Bluebeam PDF"}
        assert classify_pages.detect_pdf_source(meta) == "bluebeam"

    def test_allegion(self):
        meta = {"Creator": "Allegion Overtur", "Producer": ""}
        assert classify_pages.detect_pdf_source(meta) == "allegion"

    def test_assa_abloy(self):
        meta = {"Creator": "ASSA ABLOY Openings Studio", "Producer": ""}
        assert classify_pages.detect_pdf_source(meta) == "assa_abloy"

    def test_comsense(self):
        meta = {"Creator": "Comsense Export", "Producer": "Microsoft Word"}
        assert classify_pages.detect_pdf_source(meta) == "comsense"

    def test_word_excel(self):
        meta = {"Creator": "Microsoft Word 2019", "Producer": "Microsoft Word 2019"}
        assert classify_pages.detect_pdf_source(meta) == "word_excel"

    def test_unknown(self):
        meta = {"Creator": "Some PDF Tool", "Producer": "FPDF 1.7"}
        assert classify_pages.detect_pdf_source(meta) == "unknown"

    def test_empty_metadata(self):
        assert classify_pages.detect_pdf_source({}) == "unknown"


class TestScanDetection:
    """Test scanned page / CIDFont detection."""

    def test_cid_garbage_pattern(self):
        assert classify_pages.CID_GARBAGE_PATTERNS.search("(cid:123)")
        assert classify_pages.CID_GARBAGE_PATTERNS.search("\x01\x02\x03")


class TestClassificationOnRealPDFs:
    """Full-pipeline tests: run classify_page() on real golden PDFs.

    These tests require golden PDF fixtures in tests/fixtures/.
    They verify that the classification stage correctly identifies
    door_schedule, hardware_set, and other page types — closing the
    gap between unit tests (synthetic text) and production pipeline.
    """

    def test_medium_306169_has_door_schedule_pages(self, classify_pages, medium_pdf_path):
        """BUG-8: 306169 pages 5-7 (0-indexed) must be classified as door_schedule."""
        import pdfplumber
        with pdfplumber.open(str(medium_pdf_path)) as pdf:
            door_schedule_pages = []
            for i, page in enumerate(pdf.pages[:15]):
                result = classify_pages.classify_page(page, i)
                if result["type"] == "door_schedule":
                    door_schedule_pages.append(i)
            assert len(door_schedule_pages) >= 1, (
                f"306169: no door_schedule pages found in first 15 pages. "
                f"This causes total pipeline failure (BUG-8)."
            )

    def test_medium_306169_opening_list_not_hardware_set(self, classify_pages, medium_pdf_path):
        """BUG-8: 306169 pages 5-7 (opening list) must NOT be classified as hardware_set."""
        import pdfplumber
        with pdfplumber.open(str(medium_pdf_path)) as pdf:
            misclassified = []
            for i in [5, 6, 7]:
                result = classify_pages.classify_page(pdf.pages[i], i)
                if result["type"] != "door_schedule":
                    misclassified.append((i, result["type"]))
            assert len(misclassified) == 0, (
                f"306169: opening list pages misclassified: {misclassified}. "
                f"Expected door_schedule. This causes total pipeline failure (BUG-8)."
            )

    def test_large_mca_has_door_schedule_pages(self, classify_pages, large_pdf_path):
        """MCA must have at least 1 door_schedule page."""
        import pdfplumber
        with pdfplumber.open(str(large_pdf_path)) as pdf:
            door_schedule_pages = []
            for i, page in enumerate(pdf.pages[:15]):
                result = classify_pages.classify_page(page, i)
                if result["type"] == "door_schedule":
                    door_schedule_pages.append(i)
            assert len(door_schedule_pages) >= 1, (
                f"MCA: no door_schedule pages found in first 15 pages."
            )

    def test_small_081113_has_door_schedule_pages(self, classify_pages, small_pdf_path):
        """SMALL PDF must have at least 1 door_schedule page."""
        import pdfplumber
        with pdfplumber.open(str(small_pdf_path)) as pdf:
            door_schedule_pages = []
            for i, page in enumerate(pdf.pages[:10]):
                result = classify_pages.classify_page(page, i)
                if result["type"] == "door_schedule":
                    door_schedule_pages.append(i)
            assert len(door_schedule_pages) >= 1, (
                f"SMALL: no door_schedule pages found in first 10 pages."
            )


class TestDetectMappingOnRealPDFs:
    """Full-pipeline tests: run find_door_schedule_table() on real golden PDFs.

    Verifies that detect-mapping.py can find a valid column mapping
    from the door schedule pages of each golden PDF.
    """

    def test_medium_306169_finds_table(self, detect_mapping, medium_pdf_path):
        """BUG-8: detect-mapping must find a table with door_number on 306169."""
        import pdfplumber
        with pdfplumber.open(str(medium_pdf_path)) as pdf:
            found = False
            for page in pdf.pages[:15]:
                headers, rows, method = detect_mapping.find_door_schedule_table(page)
                if headers and rows:
                    mapping = detect_mapping.detect_column_mapping(headers)
                    if "door_number" in mapping:
                        found = True
                        break
            assert found, (
                "306169: detect-mapping could not find a table with door_number "
                "in first 15 pages. This causes the column mapper to fail (BUG-8)."
            )

    def test_306169_door_numbers_pass_validation(self, detect_mapping):
        """BUG-8: 306169 door number formats must pass looks_like_door_number()."""
        sample_numbers = ["110A-04A", "110A-04B", "EY-001", "ST-1A", "1400-BL", "110B-07A"]
        for dn in sample_numbers:
            assert detect_mapping.looks_like_door_number(dn), (
                f"306169 door number '{dn}' rejected by looks_like_door_number()"
            )

    def test_large_mca_finds_table(self, detect_mapping, large_pdf_path):
        """MCA must have a detectable door schedule table."""
        import pdfplumber
        with pdfplumber.open(str(large_pdf_path)) as pdf:
            found = False
            for page in pdf.pages[:15]:
                headers, rows, method = detect_mapping.find_door_schedule_table(page)
                if headers and rows:
                    mapping = detect_mapping.detect_column_mapping(headers)
                    if "door_number" in mapping:
                        found = True
                        break
            assert found, "MCA: detect-mapping could not find a door schedule table."


class TestBoundaryDetection:
    """Test chunk boundary detection logic."""

    def _make_page(self, index, page_type, hw_set_ids=None, labels=None):
        return {
            "index": index,
            "type": page_type,
            "confidence": 0.9,
            "section_labels": labels or [],
            "hw_set_ids": hw_set_ids or [],
            "has_door_numbers": page_type == "door_schedule",
            "word_count": 100,
        }

    def test_type_transition_creates_break(self):
        pages = [
            self._make_page(0, "door_schedule"),
            self._make_page(1, "door_schedule"),
            self._make_page(2, "hardware_set", hw_set_ids=["DH1"]),
            self._make_page(3, "hardware_set", hw_set_ids=["DH1"], labels=["continuation"]),
        ]
        # Use max_chunk_pages=2 to force splits at natural boundaries
        chunks, ref_pages = classify_pages.detect_boundaries(pages, max_chunk_pages=2)
        assert len(chunks) == 2
        assert chunks[0]["types"] == ["door_schedule"]
        assert chunks[1]["types"] == ["hardware_set"]

    def test_reference_pages_excluded(self):
        pages = [
            self._make_page(0, "door_schedule"),
            self._make_page(1, "reference"),
            self._make_page(2, "hardware_set", hw_set_ids=["DH1"]),
        ]
        chunks, ref_pages = classify_pages.detect_boundaries(pages)
        assert 1 in ref_pages
        # Reference page should not appear in any chunk
        for chunk in chunks:
            assert 1 not in chunk["pages"]

    def test_single_type_no_split(self):
        pages = [self._make_page(i, "door_schedule") for i in range(5)]
        chunks, _ = classify_pages.detect_boundaries(pages)
        assert len(chunks) == 1
        assert chunks[0]["page_count"] == 5

    def test_new_hw_set_creates_break(self):
        pages = [
            self._make_page(0, "hardware_set", hw_set_ids=["DH1"], labels=["Set DH1"]),
            self._make_page(1, "hardware_set", hw_set_ids=["DH1"], labels=["continuation"]),
            self._make_page(2, "hardware_set", hw_set_ids=["DH2"], labels=["Set DH2"]),
            self._make_page(3, "hardware_set", hw_set_ids=["DH2"], labels=["continuation"]),
        ]
        # Use max_chunk_pages=2 to force splits at set boundaries
        chunks, _ = classify_pages.detect_boundaries(pages, max_chunk_pages=2)
        # Should split at DH1 → DH2 transition
        assert len(chunks) == 2
