#!/usr/bin/env python3
"""
Investigate a PDF: run classify-pages + extract-tables and dump full results.

Usage:
    python tests/investigate_pdf.py <pdf-path>

Unlike create_expected.py (extraction only), this also captures page
classification, document profile, and pdf source fingerprinting.

Output goes to stdout as JSON.
"""

import json
import sys
import time
from pathlib import Path

import importlib.util

API_DIR = Path(__file__).resolve().parent.parent / "api"


def _import_hyphenated(filename: str, module_name: str):
    spec = importlib.util.spec_from_file_location(module_name, API_DIR / filename)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = mod
    spec.loader.exec_module(mod)
    return mod


def main():
    if len(sys.argv) < 2:
        print(f"Usage: {sys.argv[0]} <pdf-path>", file=sys.stderr)
        sys.exit(1)

    pdf_path = Path(sys.argv[1])
    if not pdf_path.exists():
        print(f"Error: {pdf_path} not found", file=sys.stderr)
        sys.exit(1)

    import pdfplumber

    classify_mod = _import_hyphenated("classify-pages.py", "classify_pages")
    extract_mod = _import_hyphenated("extract-tables.py", "extract_tables")

    print(f"Investigating: {pdf_path.name} ({pdf_path.stat().st_size:,} bytes)", file=sys.stderr)

    results = {"pdf_name": pdf_path.name, "pdf_size_bytes": pdf_path.stat().st_size}

    # --- Phase A: Classification ---
    t0 = time.time()
    with pdfplumber.open(str(pdf_path), unicode_norm="NFKC") as pdf:
        results["total_pages"] = len(pdf.pages)

        # Source detection
        results["pdf_source"] = classify_mod.detect_pdf_source(pdf.metadata or {})

        # Classify each page
        page_classifications = []
        for i, page in enumerate(pdf.pages):
            cls = classify_mod.classify_page(page, i)
            fp = classify_mod.fingerprint_page(page, cls.get("type", "other"))
            cls["fingerprint"] = fp
            page_classifications.append(cls)

        results["page_classifications"] = page_classifications

        # Build profile
        results["profile"] = classify_mod.build_profile(page_classifications, results["pdf_source"])

        # Detect boundaries
        chunks = classify_mod.detect_boundaries(page_classifications)
        results["chunks"] = chunks

    classify_time = time.time() - t0
    results["classify_duration_s"] = round(classify_time, 2)

    # Summary of page types
    type_counts = {}
    for pc in page_classifications:
        t = pc.get("type", "unknown")
        type_counts[t] = type_counts.get(t, 0) + 1
    results["page_type_summary"] = type_counts

    # Collect all hw_set_ids found during classification
    all_set_ids = set()
    for pc in page_classifications:
        for sid in pc.get("hw_set_ids", []):
            all_set_ids.add(sid)
    results["classify_set_ids"] = sorted(all_set_ids)

    # --- Phase B: Extraction ---
    t1 = time.time()
    with pdfplumber.open(str(pdf_path), unicode_norm="NFKC") as pdf:
        hardware_sets = extract_mod.extract_all_hardware_sets(pdf)
        openings, tables_found = extract_mod.extract_opening_list(pdf, None)
        reference_codes = extract_mod.extract_reference_tables(pdf)
        extract_mod.normalize_quantities(hardware_sets, openings)
        confirmed, flagged = extract_mod.validate_door_number_consistency(openings)

    extract_time = time.time() - t1
    results["extract_duration_s"] = round(extract_time, 2)
    results["total_duration_s"] = round(classify_time + extract_time, 2)

    # Extraction results
    results["extraction"] = {
        "door_count": len(confirmed) + len(flagged),
        "confirmed_count": len(confirmed),
        "flagged_count": len(flagged),
        "hw_set_count": len(hardware_sets),
        "tables_found": tables_found,
        "reference_code_count": len(reference_codes),
        "openings_sample": [
            {
                "door_number": o.door_number,
                "hw_set": o.hw_set,
                "hw_heading": getattr(o, "hw_heading", ""),
                "location": o.location,
            }
            for o in (confirmed + [f.door for f in flagged])[:10]
        ],
        "hardware_sets_summary": [
            {
                "set_id": hs.set_id,
                "heading": hs.heading,
                "item_count": len(hs.items),
                "items_preview": [item.name for item in hs.items[:5]],
            }
            for hs in hardware_sets[:10]
        ],
        "flagged_doors": [
            {"door_number": f.door.door_number, "reason": f.reason}
            for f in flagged
        ],
        "reference_codes_sample": [
            {"code_type": rc.code_type, "code": rc.code, "full_name": rc.full_name}
            for rc in reference_codes[:10]
        ],
    }

    print(json.dumps(results, indent=2, ensure_ascii=True, default=str))


if __name__ == "__main__":
    main()
