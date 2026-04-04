#!/usr/bin/env python3
"""
Generate a baseline JSON file from a golden PDF.

Usage:
    python tests/create_expected.py <pdf-filename>

Example:
    python tests/create_expected.py SMALL_081113.pdf

The PDF must exist in tests/fixtures/.
Output goes to tests/baselines/<stem>.json.
You MUST manually verify and correct the JSON before using it as ground truth.
"""

import json
import sys
from pathlib import Path

import importlib.util

API_DIR = Path(__file__).resolve().parent.parent / "api"
FIXTURES_DIR = Path(__file__).parent / "fixtures"
BASELINES_DIR = Path(__file__).parent / "baselines"


def _import_hyphenated(filename: str, module_name: str):
    spec = importlib.util.spec_from_file_location(module_name, API_DIR / filename)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = mod
    spec.loader.exec_module(mod)
    return mod


def main():
    if len(sys.argv) < 2:
        print(f"Usage: {sys.argv[0]} <pdf-filename>")
        print(f"  PDF must be in {FIXTURES_DIR}/")
        sys.exit(1)

    pdf_name = sys.argv[1]
    pdf_path = FIXTURES_DIR / pdf_name

    if not pdf_path.exists():
        print(f"Error: {pdf_path} not found")
        sys.exit(1)

    import pdfplumber
    mod = _import_hyphenated("extract-tables.py", "extract_tables")

    print(f"Processing {pdf_name} ({pdf_path.stat().st_size} bytes)...")

    with pdfplumber.open(str(pdf_path), unicode_norm="NFKC") as pdf:
        # Phase 1: Hardware sets
        hardware_sets = mod.extract_all_hardware_sets(pdf)

        # Phase 2: Opening list
        openings, tables_found = mod.extract_opening_list(pdf, None)

        # Phase 3: Reference tables
        reference_codes = mod.extract_reference_tables(pdf)

        # Phase 3.5: Qty normalization (BUG-7)
        mod.normalize_quantities(hardware_sets, openings)

        # Phase 4: Consensus validation
        confirmed, flagged = mod.validate_door_number_consistency(openings)

    baseline = {
        "pdf_name": pdf_name,
        "door_count": len(confirmed) + len(flagged),
        "confirmed_count": len(confirmed),
        "flagged_count": len(flagged),
        "hw_set_count": len(hardware_sets),
        "tables_found": tables_found,
        "reference_code_count": len(reference_codes),
        "hardware_sets": [
            {
                "set_id": hs.set_id,
                "heading": hs.heading,
                "item_count": len(hs.items),
                "items": [
                    {
                        "name": item.name,
                        "qty": item.qty,
                        "qty_source": item.qty_source,
                        "qty_total": item.qty_total,
                        "qty_door_count": item.qty_door_count,
                        "manufacturer": item.manufacturer or "",
                        "model": item.model or "",
                        "finish": item.finish or "",
                    }
                    for item in hs.items
                ],
            }
            for hs in hardware_sets
        ],
        "flagged_doors": [
            {
                "door_number": f.door.door_number,
                "reason": f.reason,
            }
            for f in flagged
        ],
    }

    BASELINES_DIR.mkdir(exist_ok=True)
    out_path = BASELINES_DIR / (Path(pdf_name).stem + ".json")
    out_path.write_text(json.dumps(baseline, indent=2, ensure_ascii=True), encoding="utf-8")

    print(f"\nWrote {out_path}")
    print(f"  Doors: {len(confirmed)} confirmed, {len(flagged)} flagged")
    print(f"  HW sets: {len(hardware_sets)}")
    print(f"  Reference codes: {len(reference_codes)}")
    print(f"\n  >>> IMPORTANT: Manually verify {out_path} before using as ground truth <<<")


if __name__ == "__main__":
    main()
