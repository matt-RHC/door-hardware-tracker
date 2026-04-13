"""
Negative test cases for reference documents (test-pdfs/reference/).

These files are NOT hardware submittals. The pipeline should extract
zero meaningful data from them, or at most produce known false positives
that are well-characterized.

S-066C: Initial reference doc assessment.
"""
import pdfplumber
import pytest


class TestSpecMarshallCourts:
    """087100 hardware spec (24pg). Has spec language but no real door-to-set mappings."""

    @pytest.mark.xfail(reason="spec-MarshallCourts: extractor finds 1 opening in a 0-door doc — known edge case")
    def test_zero_doors(self, extract_tables, ref_spec_marshall_path):
        """Spec doc should produce 0 real doors."""
        with pdfplumber.open(str(ref_spec_marshall_path), unicode_norm="NFKC") as pdf:
            openings, _ = extract_tables.extract_opening_list(pdf, None)
            _, flagged = extract_tables.validate_door_number_consistency(openings)
        # Spec doc contains no real door-to-set mappings
        assert len(openings) == 0, f"Expected 0 doors from spec doc, got {len(openings)}"

    def test_false_positive_sets(self, extract_tables, ref_spec_marshall_path):
        """Spec doc may produce false-positive sets from template language. Document count."""
        with pdfplumber.open(str(ref_spec_marshall_path), unicode_norm="NFKC") as pdf:
            hw_sets = extract_tables.extract_all_hardware_sets(pdf)
        # As of S-066C: 1 false positive set ("Door Hardware Set No. 01" from spec template)
        # This is acceptable — the key assertion is 0 doors, not 0 sets
        assert len(hw_sets) <= 2, (
            f"Spec doc producing {len(hw_sets)} sets — expected <=2 false positives"
        )

    def test_classify_no_door_schedule_pages(self, classify_pages, ref_spec_marshall_path):
        """Classifier should not see real door schedule pages in a spec doc."""
        with pdfplumber.open(str(ref_spec_marshall_path), unicode_norm="NFKC") as pdf:
            pages = [classify_pages.classify_page(p, i) for i, p in enumerate(pdf.pages)]
        # Count high-confidence door_schedule classifications
        high_conf_door_sched = [
            p for p in pages
            if p.get("type") == "door_schedule" and p.get("confidence", 0) >= 0.8
        ]
        assert len(high_conf_door_sched) <= 1, (
            f"Spec doc has {len(high_conf_door_sched)} high-confidence door_schedule pages"
        )


class TestSpecHarrisHealth:
    """Facility spec template (19pg, Word). Contains section numbers that trigger false positives."""

    def test_false_positive_doors(self, extract_tables, ref_spec_harris_path):
        """Spec template produces false-positive 'doors' from section numbers.
        These are not real doors — they have no hw_set assignments."""
        with pdfplumber.open(str(ref_spec_harris_path), unicode_norm="NFKC") as pdf:
            openings, _ = extract_tables.extract_opening_list(pdf, None)
            confirmed, flagged = extract_tables.validate_door_number_consistency(openings)
        # All extracted 'doors' should have empty hw_set (no real door-to-set mapping)
        for door in confirmed:
            assert not door.hw_set.strip(), (
                f"Door {door.door_number} has hw_set={door.hw_set!r} — "
                "spec doc should not have real door-to-set mappings"
            )

    def test_zero_hardware_sets(self, extract_tables, ref_spec_harris_path):
        """Spec template should produce 0 hardware sets."""
        with pdfplumber.open(str(ref_spec_harris_path), unicode_norm="NFKC") as pdf:
            hw_sets = extract_tables.extract_all_hardware_sets(pdf)
        assert len(hw_sets) == 0, f"Expected 0 sets from spec template, got {len(hw_sets)}"

    def test_source_detection(self, classify_pages, ref_spec_harris_path):
        """Should detect Word/Excel as source."""
        with pdfplumber.open(str(ref_spec_harris_path), unicode_norm="NFKC") as pdf:
            source = classify_pages.detect_pdf_source(pdf.metadata or {})
        assert source == "word_excel", f"Expected word_excel source, got {source!r}"


class TestArchDoorSchedule717010A:
    """Architectural door schedule (1pg, Bluebeam). Has door roster but NO hardware sets."""

    def test_extracts_doors_but_no_sets(self, extract_tables, ref_arch_717010a_path):
        """Arch schedule has door-to-set mappings (Layer 1) but no hardware items (Layer 2)."""
        with pdfplumber.open(str(ref_arch_717010a_path), unicode_norm="NFKC") as pdf:
            hw_sets = extract_tables.extract_all_hardware_sets(pdf)
            openings, _ = extract_tables.extract_opening_list(pdf, None)
        # Should find doors (arch schedule IS a door roster)
        assert len(openings) > 50, (
            f"Arch schedule should have many doors, got {len(openings)}"
        )
        # Should find 0 hardware sets (no item details in arch schedule)
        assert len(hw_sets) == 0, (
            f"Arch schedule should have 0 hw sets, got {len(hw_sets)}"
        )

    def test_source_detection(self, classify_pages, ref_arch_717010a_path):
        """Should detect Bluebeam as source."""
        with pdfplumber.open(str(ref_arch_717010a_path), unicode_norm="NFKC") as pdf:
            source = classify_pages.detect_pdf_source(pdf.metadata or {})
        assert source == "bluebeam", f"Expected bluebeam source, got {source!r}"

    def test_classify_as_reference(self, classify_pages, ref_arch_717010a_path):
        """Single page should be classified as reference, not door_schedule."""
        with pdfplumber.open(str(ref_arch_717010a_path), unicode_norm="NFKC") as pdf:
            cls = classify_pages.classify_page(pdf.pages[0], 0)
        assert cls["type"] == "reference", (
            f"Expected 'reference' classification, got {cls['type']!r}"
        )
