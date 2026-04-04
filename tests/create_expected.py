#!/usr/bin/env python3
"""
Generate an expected JSON file from a golden PDF.

Usage:
    python tests/create_expected.py <pdf-filename>

Example:
    python tests/create_expected.py sample-comsense.pdf

This runs extraction on the PDF and writes the result to tests/expected/<name>.json.
You MUST manually verify and correct the JSON before using it as ground truth.
"""

import base64
import io
import json
import sys
from pathlib import Path

# Import hyphenated Vercel Python module
import importlib.util
API_DIR = Path(__file__).resolve().parent.parent / "api"


def _import_hyphenated(filename: str, module_name: str):
    spec = importlib.util.spec_from_file_location(module_name, API_DIR / filename)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = mod
    spec.loader.exec_module(mod)
    return mod

GOLDEN_DIR = Path(__file__).parent / "golden_files"
EXPECTED_DIR = Path(__file__).parent / "expected"


def main():
    if len(sys.argv) < 2:
        print(f"Usage: {sys.argv[0]} <pdf-filename>")
        print(f"  PDF must be in {GOLDEN_DIR}/")
        sys.exit(1)

    pdf_name = sys.argv[1]
    pdf_path = GOLDEN_DIR / pdf_name

    if not pdf_path.exists():
        print(f"Error: {pdf_path} not found")
        sys.exit(1)

    import pdfplumber
    mod = _import_hyphenated("extract-tables.py", "extract_tables")

    pdf_bytes = pdf_path.read_bytes()
    pdf_b64 = base64.b64encode(pdf_bytes).decode()

    print(f"Processing {pdf_name} ({len(pdf_bytes)} bytes)...")

    with pdfplumber.open(io.BytesIO(pdf_bytes), unicode_norm="NFC") as pdf:
        # Phase 1: Hardware sets
        hardware_sets = []
        tables_found = 0
        for page in pdf.pages:
            sets, tf = mod.extract_hardware_sets_from_page(page)
            hardware_sets.extend(sets)
            tables_found += tf

        # Dedup sets
        seen = set()
        deduped = []
        for hs in hardware_sets:
            if hs.set_id not in seen:
                seen.add(hs.set_id)
                deduped.append(hs)
            else:
                for existing in deduped:
                    if existing.set_id == hs.set_id:
                        existing.items.extend(hs.items)
                        break
        hardware_sets = deduped

        # Phase 2: Opening list
        openings = []
        for page in pdf.pages:
            doors = mod.extract_opening_list_from_page(page)
            openings.extend(doors)

        # Phase 3: Reference tables
        reference_codes = []
        for page in pdf.pages:
            codes = mod.extract_reference_tables_from_page(page)
            reference_codes.extend(codes)

        # Phase 4: Qty normalization
        set_door_counts = {}
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

        # Phase 5: Consensus
        confirmed, flagged = mod.validate_door_number_consistency(openings)

    # Build expected output (simplified for golden file comparison)
    expected = {
        "_comment": f"Generated from {pdf_name}. VERIFY AND CORRECT before using as ground truth.",
        "expected_door_count": len(confirmed) + len(flagged),
        "openings": [
            {
                "door_number": d.door_number,
                "hw_set": d.hw_set,
                "location": d.location,
                "door_type": d.door_type,
                "frame_type": d.frame_type,
                "fire_rating": d.fire_rating,
                "hand": d.hand,
            }
            for d in confirmed
        ],
        "hardware_sets": [
            {
                "set_id": hs.set_id,
                "heading": hs.heading,
                "item_count": len(hs.items),
                "items": [
                    {
                        "name": item.name,
                        "qty": item.qty,
                        "manufacturer": item.manufacturer,
                        "model": item.model,
                        "finish": item.finish,
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
        "reference_codes": [
            {
                "code_type": rc.code_type,
                "code": rc.code,
                "full_name": rc.full_name,
            }
            for rc in reference_codes
        ],
    }

    EXPECTED_DIR.mkdir(exist_ok=True)
    out_path = EXPECTED_DIR / (Path(pdf_name).stem + ".json")
    out_path.write_text(json.dumps(expected, indent=2))

    print(f"\nWrote {out_path}")
    print(f"  Doors: {len(confirmed)} confirmed, {len(flagged)} flagged")
    print(f"  HW sets: {len(hardware_sets)}")
    print(f"  Reference codes: {len(reference_codes)}")
    print(f"\n  >>> IMPORTANT: Manually verify {out_path} before using as ground truth <<<")


if __name__ == "__main__":
    main()
