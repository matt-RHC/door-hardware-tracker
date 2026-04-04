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
