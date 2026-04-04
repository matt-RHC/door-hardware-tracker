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


@pytest.fixture(scope="session")
def extract_tables():
    """Import api/extract-tables.py as a module named 'extract_tables'."""
    module_path = API_DIR / "extract-tables.py"
    if not module_path.exists():
        pytest.skip(f"extract-tables.py not found at {module_path}")

    spec = importlib.util.spec_from_file_location("extract_tables", str(module_path))
    mod = importlib.util.module_from_spec(spec)
    sys.modules["extract_tables"] = mod
    spec.loader.exec_module(mod)
    return mod


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
