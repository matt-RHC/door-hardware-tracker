"""
Golden file test infrastructure for PDF extraction pipeline.

Fixtures provide:
- Access to golden PDF files in tests/golden_files/
- Expected JSON outputs in tests/expected/
- Accuracy comparison helpers with configurable thresholds
- Direct invocation of extract-tables.py logic (no HTTP layer)
"""

import base64
import importlib.util
import json
import sys
from pathlib import Path

import pytest

# Vercel Python runtime uses hyphenated filenames (extract-tables.py),
# which Python can't import normally. Use importlib to load them.
API_DIR = Path(__file__).resolve().parent.parent / "api"


def _import_hyphenated(filename: str, module_name: str):
    """Import a Python file with a hyphenated name."""
    spec = importlib.util.spec_from_file_location(module_name, API_DIR / filename)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = mod
    spec.loader.exec_module(mod)
    return mod


# Pre-import all API modules so tests can use standard import syntax
_import_hyphenated("extract-tables.py", "extract_tables")
_import_hyphenated("classify-pages.py", "classify_pages")
_import_hyphenated("detect-mapping.py", "detect_mapping")


# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

GOLDEN_DIR = Path(__file__).parent / "golden_files"
EXPECTED_DIR = Path(__file__).parent / "expected"


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def golden_dir():
    """Path to golden PDF files directory."""
    return GOLDEN_DIR


@pytest.fixture
def expected_dir():
    """Path to expected JSON outputs directory."""
    return EXPECTED_DIR


@pytest.fixture
def load_pdf():
    """Return a helper that reads a golden PDF and returns base64-encoded bytes."""

    def _load(name: str) -> str:
        path = GOLDEN_DIR / name
        if not path.exists():
            pytest.skip(f"Golden file not found: {path}")
        return base64.b64encode(path.read_bytes()).decode()

    return _load


@pytest.fixture
def load_expected():
    """Return a helper that reads the expected JSON for a golden file."""

    def _load(name: str) -> dict:
        # foo.pdf -> foo.json
        json_name = Path(name).stem + ".json"
        path = EXPECTED_DIR / json_name
        if not path.exists():
            pytest.skip(f"Expected file not found: {path}")
        return json.loads(path.read_text())

    return _load


@pytest.fixture
def extract(load_pdf):
    """
    Run the extraction pipeline on a golden PDF and return the ExtractionResult dict.

    Usage in tests:
        result = extract("sample-comsense.pdf")
        assert result["success"] is True
    """
    import extract_tables  # pre-imported in conftest via _import_hyphenated
    import pdfplumber
    import io

    def _extract(name: str, pages: list[int] | None = None) -> dict:
        pdf_b64 = load_pdf(name)
        pdf_bytes = base64.b64decode(pdf_b64)

        with pdfplumber.open(io.BytesIO(pdf_bytes), unicode_norm="NFC") as pdf:
            if pages is not None:
                selected = [pdf.pages[i] for i in pages if i < len(pdf.pages)]
            else:
                selected = pdf.pages

            # Call the core extraction logic directly (bypasses HTTP handler)
            # We replicate the handler's internal call sequence.
            result = _run_extraction(extract_tables, selected, pdf_b64)
            return result

    return _extract


def _run_extraction(mod, pages, pdf_b64: str) -> dict:
    """
    Invoke extract-tables core logic the same way the HTTP handler does.

    This replicates the do_POST flow without the BaseHTTPRequestHandler layer.
    """
    import io

    # Build the same data dict the handler receives
    data = {"pdfBase64": pdf_b64}

    # We re-open the PDF inside the extraction to match the handler's flow
    pdf_bytes = base64.b64decode(pdf_b64)

    import pdfplumber

    with pdfplumber.open(io.BytesIO(pdf_bytes), unicode_norm="NFC") as pdf:
        # Phase 1: Extract hardware sets
        hardware_sets = []
        tables_found = 0

        for page in pdf.pages:
            sets, tf = mod.extract_hardware_sets_from_page(page)
            hardware_sets.extend(sets)
            tables_found += tf

        # Deduplicate hardware sets by set_id
        seen_ids = set()
        deduped_sets = []
        for hs in hardware_sets:
            if hs.set_id not in seen_ids:
                seen_ids.add(hs.set_id)
                deduped_sets.append(hs)
            else:
                # Merge items into existing set
                for existing in deduped_sets:
                    if existing.set_id == hs.set_id:
                        existing.items.extend(hs.items)
                        break
        hardware_sets = deduped_sets

        # Phase 2: Extract opening list
        openings = []
        for page in pdf.pages:
            doors = mod.extract_opening_list_from_page(page)
            openings.extend(doors)

        # Phase 3: Reference tables
        reference_codes = []
        for page in pdf.pages:
            codes = mod.extract_reference_tables_from_page(page)
            reference_codes.extend(codes)

        # Phase 4: Quantity normalization
        set_door_counts: dict[str, int] = {}
        for door in openings:
            if door.hw_set:
                set_door_counts[door.hw_set] = set_door_counts.get(door.hw_set, 0) + 1

        for hs in hardware_sets:
            count = set_door_counts.get(hs.set_id, 0)
            if count > 1:
                for item in hs.items:
                    if item.qty > 1 and item.qty >= count:
                        if item.qty % count == 0:
                            item.qty_total = item.qty
                            item.qty_door_count = count
                            item.qty = item.qty // count
                            item.qty_source = "divided"

        # Phase 5: Pattern consensus
        confirmed, flagged = mod.validate_door_number_consistency(openings)

        # Confidence
        notes = []
        confidence = "high"
        if len(confirmed) == 0 and len(hardware_sets) > 0:
            confidence = "low"
            notes.append("No door openings found.")
        elif len(confirmed) == 0 and len(hardware_sets) == 0:
            confidence = "low"
            notes.append("No doors or hardware sets found.")
        elif len(flagged) > len(confirmed) * 0.3:
            confidence = "medium"
            notes.append(f"{len(flagged)} door numbers flagged.")
        elif tables_found == 0:
            confidence = "medium"
            notes.append("No structured tables detected.")

        result = mod.ExtractionResult(
            success=len(confirmed) > 0 or len(hardware_sets) > 0,
            openings=confirmed,
            hardware_sets=hardware_sets,
            reference_codes=reference_codes,
            flagged_doors=flagged,
            expected_door_count=len(confirmed) + len(flagged),
            tables_found=tables_found,
            hw_sets_found=len(hardware_sets),
            method="pdfplumber",
            confidence=confidence,
            extraction_notes=notes,
        )
        return json.loads(result.model_dump_json())


@pytest.fixture
def classify(load_pdf):
    """
    Run page classification on a golden PDF and return the classification result.

    Usage:
        result = classify("sample-comsense.pdf")
        assert result["summary"]["hardware_set_pages"] > 0
    """
    import classify_pages  # pre-imported in conftest via _import_hyphenated
    import pdfplumber
    import io

    def _classify(name: str) -> dict:
        pdf_b64 = load_pdf(name)
        pdf_bytes = base64.b64decode(pdf_b64)

        with pdfplumber.open(io.BytesIO(pdf_bytes), unicode_norm="NFC") as pdf:
            page_classifications = []
            for i, page in enumerate(pdf.pages):
                classification = classify_pages.classify_page(page, i)
                page_classifications.append(classification)

            chunks, ref_pages = classify_pages.detect_boundaries(page_classifications)

            return {
                "success": True,
                "total_pages": len(pdf.pages),
                "page_classifications": page_classifications,
                "chunks": chunks,
                "reference_pages": ref_pages,
                "summary": {
                    "door_schedule_pages": sum(1 for p in page_classifications if p["type"] == "door_schedule"),
                    "hardware_set_pages": sum(1 for p in page_classifications if p["type"] == "hardware_set"),
                    "reference_pages": sum(1 for p in page_classifications if p["type"] == "reference"),
                    "cover_pages": sum(1 for p in page_classifications if p["type"] == "cover"),
                    "other_pages": sum(1 for p in page_classifications if p["type"] == "other"),
                    "chunk_count": len(chunks),
                },
            }

    return _classify


# ---------------------------------------------------------------------------
# Accuracy comparison helpers
# ---------------------------------------------------------------------------


class AccuracyResult:
    """Result of comparing extraction output against expected golden data."""

    def __init__(self):
        self.total_fields = 0
        self.correct_fields = 0
        self.mismatches: list[dict] = []
        self.missing_doors: list[str] = []
        self.extra_doors: list[str] = []
        self.missing_sets: list[str] = []
        self.extra_sets: list[str] = []

    @property
    def accuracy(self) -> float:
        if self.total_fields == 0:
            return 0.0
        return self.correct_fields / self.total_fields

    @property
    def door_count_accuracy(self) -> float:
        """1.0 if extracted door count matches expected, else ratio."""
        expected = self.expected_door_count
        actual = self.actual_door_count
        if expected == 0:
            return 1.0 if actual == 0 else 0.0
        return min(actual, expected) / max(actual, expected)

    def summary(self) -> str:
        lines = [
            f"Field accuracy: {self.accuracy:.1%} ({self.correct_fields}/{self.total_fields})",
            f"Door count: {self.actual_door_count} extracted vs {self.expected_door_count} expected ({self.door_count_accuracy:.0%})",
            f"HW set count: {self.actual_set_count} extracted vs {self.expected_set_count} expected",
        ]
        if self.missing_doors:
            lines.append(f"Missing doors: {', '.join(self.missing_doors[:10])}")
        if self.extra_doors:
            lines.append(f"Extra doors: {', '.join(self.extra_doors[:10])}")
        if self.mismatches:
            lines.append(f"Field mismatches: {len(self.mismatches)}")
            for m in self.mismatches[:5]:
                lines.append(f"  {m['door']} .{m['field']}: got '{m['actual']}' expected '{m['expected']}'")
        return "\n".join(lines)


def _normalize_field(value: str | None) -> str:
    """Normalize a field value for comparison (case-insensitive, whitespace-trimmed)."""
    if value is None:
        return ""
    return " ".join(str(value).strip().lower().split())


def compare_extraction(actual: dict, expected: dict) -> AccuracyResult:
    """
    Compare extraction output against expected golden data.

    Expected JSON format:
    {
        "openings": [
            {"door_number": "101-01", "hw_set": "DH1", "location": "Office", ...},
            ...
        ],
        "hardware_sets": [
            {"set_id": "DH1", "heading": "...", "item_count": 5},
            ...
        ],
        "expected_door_count": 104
    }

    Fields compared per door: hw_set, location, door_type, frame_type, fire_rating, hand
    Door numbers compared exactly (case-insensitive).
    """
    result = AccuracyResult()

    # Door-level comparison
    expected_doors = {d["door_number"].strip().upper(): d for d in expected.get("openings", [])}
    actual_doors = {d["door_number"].strip().upper(): d for d in actual.get("openings", [])}

    result.expected_door_count = len(expected_doors)
    result.actual_door_count = len(actual_doors)

    # Sets comparison
    expected_sets = {s["set_id"].strip().upper() for s in expected.get("hardware_sets", [])}
    actual_sets = {s["set_id"].strip().upper() for s in actual.get("hardware_sets", [])}

    result.expected_set_count = len(expected_sets)
    result.actual_set_count = len(actual_sets)
    result.missing_sets = sorted(expected_sets - actual_sets)
    result.extra_sets = sorted(actual_sets - expected_sets)

    # Door presence
    result.missing_doors = sorted(set(expected_doors.keys()) - set(actual_doors.keys()))
    result.extra_doors = sorted(set(actual_doors.keys()) - set(expected_doors.keys()))

    # Field-level comparison for doors present in both
    compare_fields = ["hw_set", "location", "door_type", "frame_type", "fire_rating", "hand"]

    for door_num in sorted(set(expected_doors.keys()) & set(actual_doors.keys())):
        exp = expected_doors[door_num]
        act = actual_doors[door_num]

        for field in compare_fields:
            exp_val = _normalize_field(exp.get(field))
            act_val = _normalize_field(act.get(field))

            result.total_fields += 1
            if exp_val == act_val:
                result.correct_fields += 1
            else:
                # Allow empty expected to match anything (field not verified)
                if exp_val == "":
                    result.correct_fields += 1
                else:
                    result.mismatches.append({
                        "door": door_num,
                        "field": field,
                        "expected": exp_val,
                        "actual": act_val,
                    })

    # Count door presence as fields too
    result.total_fields += len(expected_doors)
    result.correct_fields += len(set(expected_doors.keys()) & set(actual_doors.keys()))

    return result


@pytest.fixture
def compare():
    """Fixture providing the compare_extraction function."""
    return compare_extraction


# ---------------------------------------------------------------------------
# Accuracy threshold assertions
# ---------------------------------------------------------------------------

# Default thresholds — override per-test with @pytest.mark.parametrize or direct calls
DEFAULT_THRESHOLDS = {
    "door_count_accuracy": 0.95,   # 95% of doors identified
    "field_accuracy": 0.90,         # 90% of fields correct
    "hw_set_count_accuracy": 0.90,  # 90% of hardware sets found
}


@pytest.fixture
def assert_accuracy():
    """
    Fixture that asserts accuracy meets thresholds.

    Usage:
        result = compare(actual, expected)
        assert_accuracy(result)  # uses defaults
        assert_accuracy(result, field_accuracy=0.95)  # override threshold
    """

    def _assert(acc: AccuracyResult, **overrides):
        thresholds = {**DEFAULT_THRESHOLDS, **overrides}

        assert acc.door_count_accuracy >= thresholds["door_count_accuracy"], (
            f"Door count accuracy {acc.door_count_accuracy:.1%} below threshold "
            f"{thresholds['door_count_accuracy']:.0%}\n{acc.summary()}"
        )

        if acc.total_fields > 0:
            assert acc.accuracy >= thresholds["field_accuracy"], (
                f"Field accuracy {acc.accuracy:.1%} below threshold "
                f"{thresholds['field_accuracy']:.0%}\n{acc.summary()}"
            )

        if acc.expected_set_count > 0:
            set_accuracy = min(acc.actual_set_count, acc.expected_set_count) / max(acc.actual_set_count, acc.expected_set_count)
            assert set_accuracy >= thresholds["hw_set_count_accuracy"], (
                f"HW set count accuracy {set_accuracy:.1%} below threshold "
                f"{thresholds['hw_set_count_accuracy']:.0%}\n{acc.summary()}"
            )

    return _assert
