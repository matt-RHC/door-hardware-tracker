"""
Shared fixtures for extract-tables.py tests.

Loads the Python extraction module via importlib (since it lives in api/ and
has no __init__.py). Provides path fixtures for golden test PDFs.
"""
import importlib.util
import os
import sys
from pathlib import Path

import pytest

# ── Locate project root (two levels up from tests/) ──
PROJECT_ROOT = Path(__file__).resolve().parent.parent
API_DIR = PROJECT_ROOT / "api"
FIXTURES_DIR = Path(__file__).resolve().parent / "fixtures"


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


@pytest.fixture(scope="session")
def extract_tables():
    """Return the pre-imported extract_tables module."""
    return sys.modules["extract_tables"]


@pytest.fixture(scope="session")
def classify_pages():
    """Return the pre-imported classify_pages module."""
    return sys.modules["classify_pages"]


@pytest.fixture(scope="session")
def detect_mapping():
    """Return the pre-imported detect_mapping module."""
    return sys.modules["detect_mapping"]


@pytest.fixture(scope="session")
def small_pdf_path():
    """Path to the SMALL golden test PDF (CAA Nashville Yards, ~12 pages)."""
    p = FIXTURES_DIR / "SMALL_081113.pdf"
    if not p.exists():
        pytest.skip(f"SMALL PDF not found at {p}. Copy it from Downloads.")
    return p


@pytest.fixture(scope="session")
def medium_pdf_path():
    """Path to the MEDIUM golden test PDF (Radius DC, 44 pages)."""
    p = FIXTURES_DIR / "MEDIUM_306169.pdf"
    if not p.exists():
        pytest.skip(f"MEDIUM PDF not found at {p}. Copy it from Downloads.")
    return p


@pytest.fixture(scope="session")
def large_pdf_path():
    """Path to the LARGE golden test PDF (MCA Hardware, 82 pages)."""
    p = FIXTURES_DIR / "LARGE_MCA.pdf"
    if not p.exists():
        pytest.skip(f"LARGE PDF not found at {p}. Copy it from Downloads.")
    return p


@pytest.fixture(scope="session")
def rpl10_pdf_path():
    """Path to the RPL10 golden test PDF (NW Data Center, 52 pages)."""
    p = FIXTURES_DIR / "RPL10_NW_Data_Center.pdf"
    if not p.exists():
        pytest.skip(f"RPL10 PDF not found at {p}. Copy it from Downloads.")
    return p


@pytest.fixture(scope="session")
def caa_pdf_path():
    """Path to the CAA Nashville Yards golden test PDF (107 pages, 60 doors)."""
    p = FIXTURES_DIR / "CAA_Nashville_Yards.pdf"
    if not p.exists():
        pytest.skip(f"CAA PDF not found at {p}. Copy it from Downloads.")
    return p


@pytest.fixture(scope="session")
def akn_pdf_path():
    """Path to the AKN golden test PDF (ESC/Comsense, 45 pages, no opening list)."""
    p = FIXTURES_DIR / "AKN_ESC.pdf"
    if not p.exists():
        pytest.skip(f"AKN PDF not found at {p}. Copy it from Downloads.")
    return p


# ── Reference docs (test-pdfs/reference/) — NOT submittals ──

REFERENCE_DIR = PROJECT_ROOT / "test-pdfs" / "reference"


@pytest.fixture(scope="session")
def ref_arch_717010a_path():
    """Path to architectural door schedule (1pg, Bluebeam). NOT a hardware submittal."""
    p = REFERENCE_DIR / "arch-DoorSchedule-717010A.pdf"
    if not p.exists():
        pytest.skip(f"arch-717010A not found at {p}")
    return p


@pytest.fixture(scope="session")
def ref_spec_marshall_path():
    """Path to 087100 spec document (24pg). NOT a hardware submittal."""
    p = REFERENCE_DIR / "spec-MarshallCourts.pdf"
    if not p.exists():
        pytest.skip(f"spec-MarshallCourts not found at {p}")
    return p


@pytest.fixture(scope="session")
def ref_spec_harris_path():
    """Path to facility spec template (19pg, Word). NOT a hardware submittal."""
    p = REFERENCE_DIR / "spec-HarrisHealth.pdf"
    if not p.exists():
        pytest.skip(f"spec-HarrisHealth not found at {p}")
    return p


# ── Schedule-format PDF fixtures (S-066A) ──


@pytest.fixture(scope="session")
def sched_akn_pdf_path():
    """sched-AKN: ESC/Comsense, 46 pages."""
    p = FIXTURES_DIR / "sched-AKN.pdf"
    if not p.exists():
        pytest.skip(f"sched-AKN PDF not found at {p}.")
    return p


@pytest.fixture(scope="session")
def sched_barnstable_pdf_path():
    """sched-Barnstable: Comsense, 8 pages."""
    p = FIXTURES_DIR / "sched-Barnstable.pdf"
    if not p.exists():
        pytest.skip(f"sched-Barnstable PDF not found at {p}.")
    return p


@pytest.fixture(scope="session")
def sched_claymont_pdf_path():
    """sched-Claymont: Comsense, 34 pages."""
    p = FIXTURES_DIR / "sched-Claymont.pdf"
    if not p.exists():
        pytest.skip(f"sched-Claymont PDF not found at {p}.")
    return p


@pytest.fixture(scope="session")
def sched_cornell_pdf_path():
    """sched-Cornell: Comsense, 30 pages."""
    p = FIXTURES_DIR / "sched-Cornell.pdf"
    if not p.exists():
        pytest.skip(f"sched-Cornell PDF not found at {p}.")
    return p


@pytest.fixture(scope="session")
def sched_dt_pdf_path():
    """sched-DT: Comsense, 116 pages."""
    p = FIXTURES_DIR / "sched-DT.pdf"
    if not p.exists():
        pytest.skip(f"sched-DT PDF not found at {p}.")
    return p


@pytest.fixture(scope="session")
def sched_etica_pdf_path():
    """sched-Etica: Comsense, 32 pages."""
    p = FIXTURES_DIR / "sched-Etica.pdf"
    if not p.exists():
        pytest.skip(f"sched-Etica PDF not found at {p}.")
    return p


@pytest.fixture(scope="session")
def sched_kdot_pdf_path():
    """sched-Kdot: Comsense, 9 pages."""
    p = FIXTURES_DIR / "sched-Kdot.pdf"
    if not p.exists():
        pytest.skip(f"sched-Kdot PDF not found at {p}.")
    return p


@pytest.fixture(scope="session")
def sched_lutheran_pdf_path():
    """sched-Lutheran: Comsense, 30 pages."""
    p = FIXTURES_DIR / "sched-Lutheran.pdf"
    if not p.exists():
        pytest.skip(f"sched-Lutheran PDF not found at {p}.")
    return p


# ── PDF Catalog (BUG-11: test infrastructure expansion) ──

PDF_CATALOG_ENTRIES = {
    "SMALL": "SMALL_081113.pdf",
    "MEDIUM": "MEDIUM_306169.pdf",
    "LARGE": "LARGE_MCA.pdf",
    "RPL10": "RPL10_NW_Data_Center.pdf",
    "CAA": "CAA_Nashville_Yards.pdf",
    "AKN": "AKN_ESC.pdf",
    "SCHED_AKN": "sched-AKN.pdf",
    "SCHED_BARNSTABLE": "sched-Barnstable.pdf",
    "SCHED_CLAYMONT": "sched-Claymont.pdf",
    "SCHED_CORNELL": "sched-Cornell.pdf",
    "SCHED_DT": "sched-DT.pdf",
    "SCHED_ETICA": "sched-Etica.pdf",
    "SCHED_KDOT": "sched-Kdot.pdf",
    "SCHED_LUTHERAN": "sched-Lutheran.pdf",
}

CROSS_PDF_NAMES = ["SMALL", "MEDIUM", "LARGE", "RPL10", "CAA"]


@pytest.fixture(scope="session")
def pdf_catalog():
    """Return {name: Path|None} for all golden PDFs. Does NOT skip — tests decide."""
    catalog = {}
    for name, filename in PDF_CATALOG_ENTRIES.items():
        p = FIXTURES_DIR / filename
        catalog[name] = p if p.exists() else None
    return catalog


class _PipelineCache:
    """Lazy cache for full-pipeline extraction results. Avoids re-running 30s extractions."""

    def __init__(self, extract_mod, catalog):
        self._mod = extract_mod
        self._catalog = catalog
        self._cache = {}

    def get(self, name):
        if name in self._cache:
            return self._cache[name]
        path = self._catalog.get(name)
        if path is None:
            self._cache[name] = None
            return None
        import pdfplumber
        with pdfplumber.open(str(path), unicode_norm="NFKC") as pdf:
            hw_sets = self._mod.extract_all_hardware_sets(pdf)
            openings, tables_found = self._mod.extract_opening_list(pdf, None)
            ref_codes = self._mod.extract_reference_tables(pdf)
            self._mod.normalize_quantities(hw_sets, openings)
            confirmed, flagged = self._mod.validate_door_number_consistency(openings)
        result = (hw_sets, openings, confirmed, flagged, ref_codes, tables_found)
        self._cache[name] = result
        return result


@pytest.fixture(scope="session")
def pipeline_results(extract_tables, pdf_catalog):
    """Lazy cache for full extraction pipeline results across all golden PDFs."""
    return _PipelineCache(extract_tables, pdf_catalog)
