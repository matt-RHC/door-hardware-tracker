"""
Classification regression tests (BUG-11).

Validates page classification accuracy across golden PDFs: cover page
detection, hardware set pages, door schedule pages, and type transitions.
"""
import pdfplumber
import pytest

CROSS_PDF_NAMES = ["SMALL", "MEDIUM", "LARGE", "RPL10", "CAA"]


# ── Helpers ───────────────────────────────────────────────────────────────────

def _classify_all_pages(classify_pages_mod, pdf_path, max_pages=None):
    """Classify all (or first N) pages of a PDF. Returns list of result dicts."""
    results = []
    with pdfplumber.open(str(pdf_path), unicode_norm="NFKC") as pdf:
        pages = pdf.pages[:max_pages] if max_pages else pdf.pages
        for i, page in enumerate(pages):
            results.append(classify_pages_mod.classify_page(page, i))
    return results


# ── Cover Page Classification ─────────────────────────────────────────────────

class TestCoverPageClassification:

    def test_medium_page_1_is_cover_or_other(self, classify_pages, medium_pdf_path):
        """Page 0 of MEDIUM_306169 should NOT be classified as door_schedule."""
        results = _classify_all_pages(classify_pages, medium_pdf_path, max_pages=1)
        page_type = results[0]["type"]
        assert page_type in ("cover", "other"), (
            f"Page 0 of MEDIUM classified as '{page_type}', expected 'cover' or 'other'"
        )


# ── MCA Classification ────────────────────────────────────────────────────────

class TestMCAClassification:

    def test_mca_has_door_schedule_pages(self, classify_pages, large_pdf_path):
        results = _classify_all_pages(classify_pages, large_pdf_path, max_pages=20)
        door_sched = [r for r in results if r["type"] == "door_schedule"]
        assert len(door_sched) >= 1, (
            f"No door_schedule pages in first 20 MCA pages. "
            f"Types found: {set(r['type'] for r in results)}"
        )

    def test_mca_has_hardware_set_pages(self, classify_pages, large_pdf_path):
        results = _classify_all_pages(classify_pages, large_pdf_path)
        hw_set = [r for r in results if r["type"] == "hardware_set"]
        assert len(hw_set) >= 10, (
            f"Only {len(hw_set)} hardware_set pages in MCA (expected >=10). "
            f"Type distribution: {_type_counts(results)}"
        )

    def test_mca_hw_set_pages_have_set_ids(self, classify_pages, large_pdf_path):
        results = _classify_all_pages(classify_pages, large_pdf_path)
        hw_set_pages = [r for r in results if r["type"] == "hardware_set" and r["confidence"] >= 0.9]
        if len(hw_set_pages) == 0:
            pytest.skip("No high-confidence hardware_set pages found")
        with_ids = sum(1 for r in hw_set_pages if r.get("hw_set_ids"))
        ratio = with_ids / len(hw_set_pages)
        assert ratio >= 0.50, (
            f"Only {with_ids}/{len(hw_set_pages)} ({ratio:.0%}) high-confidence "
            f"hw_set pages have hw_set_ids populated"
        )


# ── Every PDF Has Required Types ──────────────────────────────────────────────

class TestEveryPdfHasRequiredTypes:

    @pytest.fixture(params=CROSS_PDF_NAMES)
    def classified_pdf(self, request, classify_pages, pdf_catalog):
        name = request.param
        path = pdf_catalog.get(name)
        if path is None:
            pytest.skip(f"{name} PDF not found in tests/fixtures/")
        results = _classify_all_pages(classify_pages, path)
        return name, results

    def test_has_door_schedule_pages(self, classified_pdf):
        name, results = classified_pdf
        door_sched = [r for r in results if r["type"] == "door_schedule"]
        assert len(door_sched) >= 1, (
            f"[{name}] No door_schedule pages. Types: {_type_counts(results)}"
        )

    def test_has_hardware_set_pages(self, classified_pdf):
        name, results = classified_pdf
        hw_set = [r for r in results if r["type"] == "hardware_set"]
        assert len(hw_set) >= 1, (
            f"[{name}] No hardware_set pages. Types: {_type_counts(results)}"
        )


# ── Boundary Page Classification ──────────────────────────────────────────────

class TestBoundaryPageClassification:

    def test_medium_opening_list_boundary(self, classify_pages, medium_pdf_path):
        """MEDIUM should have a door_schedule -> hardware_set transition."""
        results = _classify_all_pages(classify_pages, medium_pdf_path)
        types = [r["type"] for r in results]
        found_transition = False
        for i in range(len(types) - 1):
            if types[i] == "door_schedule" and types[i + 1] == "hardware_set":
                found_transition = True
                break
        assert found_transition, (
            f"No door_schedule->hardware_set transition in MEDIUM. "
            f"Type sequence: {_summarize_types(types)}"
        )

    def test_rpl10_type_transitions_detected(self, classify_pages, rpl10_pdf_path):
        """RPL10 should have both door_schedule and hardware_set pages."""
        results = _classify_all_pages(classify_pages, rpl10_pdf_path)
        types_found = set(r["type"] for r in results)
        assert "door_schedule" in types_found, (
            f"RPL10 has no door_schedule pages. Types: {_type_counts(results)}"
        )
        assert "hardware_set" in types_found, (
            f"RPL10 has no hardware_set pages. Types: {_type_counts(results)}"
        )

    def test_caa_has_type_transition(self, classify_pages, caa_pdf_path):
        """CAA should have a transition from door_schedule to another type."""
        results = _classify_all_pages(classify_pages, caa_pdf_path)
        types = [r["type"] for r in results]
        # Find any page that's door_schedule followed by a non-door_schedule page
        found = False
        for i in range(len(types) - 1):
            if types[i] == "door_schedule" and types[i + 1] != "door_schedule":
                found = True
                break
        assert found, (
            f"No transition out of door_schedule in CAA. "
            f"Type sequence: {_summarize_types(types)}"
        )


# ── Helpers ───────────────────────────────────────────────────────────────────

def _type_counts(results):
    """Return {type: count} summary."""
    counts = {}
    for r in results:
        t = r["type"]
        counts[t] = counts.get(t, 0) + 1
    return counts


def _summarize_types(types):
    """Collapse consecutive same-type pages: ['ds','ds','hs','hs'] -> 'ds(2)->hs(2)'."""
    if not types:
        return "(empty)"
    groups = []
    current = types[0]
    count = 1
    for t in types[1:]:
        if t == current:
            count += 1
        else:
            groups.append(f"{current}({count})")
            current = t
            count = 1
    groups.append(f"{current}({count})")
    return "->".join(groups)
