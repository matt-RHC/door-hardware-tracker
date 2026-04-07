"""
Punchy Review — Python wrapper that calls Anthropic API with the same
system prompt used in the production LLM review pass (parse-pdf/chunk/route.ts).

Functions:
  review_extraction(pdf_path, pdfplumber_result) → corrections dict + confidence
  apply_corrections(hw_sets, doors, corrections) → merged result

Uses claude-haiku-4-5-20251001, requires ANTHROPIC_API_KEY env var.
Caches responses to tests/punchy-cache/{pdf_name}.json.
"""
import base64
import hashlib
import json
import os
from pathlib import Path
from typing import Any

CACHE_DIR = Path(__file__).parent / "punchy-cache"


# ── Taxonomy text (ported from src/lib/hardware-taxonomy.ts getTaxonomyPromptText) ──

HARDWARE_TAXONOMY = [
    {"id": "hinges", "label": "Hinges", "universal": True, "exterior": True, "interior": True, "fire_rated": True, "pairs_only": False, "install_scope": "per-leaf", "typical_qty_single": [3, 5], "typical_qty_pair": [6, 10]},
    {"id": "lockset", "label": "Lockset / Latchset", "universal": False, "exterior": False, "interior": True, "fire_rated": True, "pairs_only": False, "install_scope": "per-opening", "typical_qty_single": [1, 1], "typical_qty_pair": [1, 2]},
    {"id": "exit_device", "label": "Exit Device", "universal": False, "exterior": True, "interior": False, "fire_rated": True, "pairs_only": False, "install_scope": "per-leaf", "typical_qty_single": [1, 1], "typical_qty_pair": [2, 2]},
    {"id": "flush_bolt", "label": "Flush Bolt / Flush Bolt Kit", "universal": False, "exterior": True, "interior": False, "fire_rated": True, "pairs_only": True, "install_scope": "per-pair", "typical_qty_single": [0, 0], "typical_qty_pair": [1, 2]},
    {"id": "strike", "label": "Strike", "universal": False, "exterior": False, "interior": False, "fire_rated": False, "pairs_only": False, "install_scope": "per-opening", "typical_qty_single": [0, 1], "typical_qty_pair": [0, 2]},
    {"id": "elec_modification", "label": "Electronic Modification", "universal": False, "exterior": True, "interior": False, "fire_rated": False, "pairs_only": False, "install_scope": "per-opening", "typical_qty_single": [1, 1], "typical_qty_pair": [1, 2]},
    {"id": "wire_harness", "label": "Wire Harness / Connector", "universal": False, "exterior": False, "interior": False, "fire_rated": False, "pairs_only": False, "install_scope": "per-leaf", "typical_qty_single": [1, 2], "typical_qty_pair": [2, 4]},
    {"id": "closer", "label": "Closer", "universal": True, "exterior": True, "interior": True, "fire_rated": True, "pairs_only": False, "install_scope": "per-leaf", "typical_qty_single": [1, 1], "typical_qty_pair": [2, 2]},
    {"id": "coordinator", "label": "Coordinator", "universal": False, "exterior": False, "interior": False, "fire_rated": False, "pairs_only": True, "install_scope": "per-pair", "typical_qty_single": [0, 0], "typical_qty_pair": [1, 1]},
    {"id": "cylinder_housing", "label": "Cylinder Housing", "universal": False, "exterior": True, "interior": False, "fire_rated": False, "pairs_only": False, "install_scope": "per-opening", "typical_qty_single": [1, 1], "typical_qty_pair": [1, 2]},
    {"id": "core", "label": "IC Core (Temporary / Permanent)", "universal": False, "exterior": True, "interior": True, "fire_rated": False, "pairs_only": False, "install_scope": "per-opening", "typical_qty_single": [1, 2], "typical_qty_pair": [1, 2]},
    {"id": "kick_plate", "label": "Kickplate / Protection Plate", "universal": False, "exterior": True, "interior": False, "fire_rated": False, "pairs_only": False, "install_scope": "per-leaf", "typical_qty_single": [1, 1], "typical_qty_pair": [2, 2]},
    {"id": "stop", "label": "Stop", "universal": False, "exterior": False, "interior": True, "fire_rated": False, "pairs_only": False, "install_scope": "per-leaf", "typical_qty_single": [1, 1], "typical_qty_pair": [2, 2]},
    {"id": "door_sweep", "label": "Door Sweep / Auto Door Bottom", "universal": False, "exterior": True, "interior": False, "fire_rated": False, "pairs_only": False, "install_scope": "per-leaf", "typical_qty_single": [1, 1], "typical_qty_pair": [2, 2]},
    {"id": "threshold", "label": "Threshold", "universal": False, "exterior": True, "interior": False, "fire_rated": False, "pairs_only": False, "install_scope": "per-frame", "typical_qty_single": [1, 1], "typical_qty_pair": [1, 1]},
    {"id": "gasket", "label": "Gasket", "universal": False, "exterior": True, "interior": False, "fire_rated": True, "pairs_only": False, "install_scope": "per-frame", "typical_qty_single": [1, 1], "typical_qty_pair": [1, 2]},
    {"id": "smoke_seal", "label": "Smoke Seal", "universal": False, "exterior": False, "interior": False, "fire_rated": True, "pairs_only": False, "install_scope": "per-frame", "typical_qty_single": [1, 1], "typical_qty_pair": [2, 2]},
    {"id": "gasketing", "label": "Gasketing", "universal": False, "exterior": True, "interior": False, "fire_rated": True, "pairs_only": False, "install_scope": "per-frame", "typical_qty_single": [1, 1], "typical_qty_pair": [2, 2]},
    {"id": "acoustic_seal", "label": "Acoustic Seal", "universal": False, "exterior": False, "interior": False, "fire_rated": False, "pairs_only": False, "install_scope": "per-frame", "typical_qty_single": [1, 2], "typical_qty_pair": [2, 4]},
    {"id": "weatherstrip", "label": "Weatherstrip", "universal": False, "exterior": True, "interior": False, "fire_rated": False, "pairs_only": False, "install_scope": "per-frame", "typical_qty_single": [1, 1], "typical_qty_pair": [2, 2]},
    {"id": "rain_drip", "label": "Rain Drip", "universal": False, "exterior": True, "interior": False, "fire_rated": False, "pairs_only": False, "install_scope": "per-frame", "typical_qty_single": [1, 1], "typical_qty_pair": [2, 2]},
    {"id": "astragal", "label": "Astragal", "universal": False, "exterior": True, "interior": False, "fire_rated": False, "pairs_only": True, "install_scope": "per-pair", "typical_qty_single": [0, 0], "typical_qty_pair": [1, 1]},
    {"id": "silencer", "label": "Silencer", "universal": False, "exterior": False, "interior": True, "fire_rated": False, "pairs_only": False, "install_scope": "per-frame", "typical_qty_single": [1, 3], "typical_qty_pair": [1, 3]},
    {"id": "by_others", "label": "Hardware by Others", "universal": False, "exterior": False, "interior": False, "fire_rated": False, "pairs_only": False, "install_scope": "per-opening", "typical_qty_single": [0, 5], "typical_qty_pair": [0, 5]},
]


def get_taxonomy_prompt_text() -> str:
    """Port of getTaxonomyPromptText() from hardware-taxonomy.ts."""
    lines = []
    for cat in HARDWARE_TAXONOMY:
        contexts = []
        if cat["universal"]:
            contexts.append("ALL")
        if cat["exterior"]:
            contexts.append("EXT")
        if cat["interior"]:
            contexts.append("INT")
        if cat["fire_rated"]:
            contexts.append("FIRE")
        if cat["pairs_only"]:
            contexts.append("PAIRS-ONLY")

        scope = cat["install_scope"]
        sq = cat["typical_qty_single"]
        pq = cat["typical_qty_pair"]
        lines.append(
            f"- {cat['label']} [{','.join(contexts)}] {scope} "
            f"| typical qty: {sq[0]}-{sq[1]} (single), {pq[0]}-{pq[1]} (pair)"
        )

    header = [
        "HARDWARE ITEM CATEGORIES (expected per opening):",
        "Install scopes: per-leaf (each door panel), per-opening (1 per doorway), per-pair (pairs only), per-frame (1 per frame)",
        "Hinge rule: 1 per 30\" of height + 1 (3 for <=7'6\", 4 for 7'6\"-10'0\", 5 for 10'0\"+). Electrified/spring hinges REPLACE a standard hinge, not additive. Continuous = 1 per leaf.",
        "Pair doors: active leaf gets lockset/exit device, inactive gets flush bolts. Both leaves get hinges, closers, protection plates, sweeps.",
    ]
    return "\n".join(header + lines)


# ── System prompt (ported from parse-pdf/chunk/route.ts callLLMReview) ──

SYSTEM_PROMPT = f"""You are a quality reviewer for door hardware submittal PDF extraction.

You will receive:
1. A PDF document (door hardware submittal)
2. Structured data extracted from that PDF by an automated tool (pdfplumber)

Your job is to REVIEW the extracted data against the actual PDF and return ONLY corrections needed. Do NOT re-extract everything — just identify errors and missing data.

Return valid JSON with this structure:
{{
  "hardware_sets_corrections": [
    {{
      "set_id": "DH1",
      "heading": "corrected heading if wrong",
      "items_to_add": [{{"qty": 1, "name": "Missing Item", "manufacturer": "MFR", "model": "MDL", "finish": "FIN"}}],
      "items_to_remove": ["Item Name That Shouldnt Be There"],
      "items_to_fix": [{{"name": "Item Name", "field": "qty", "old_value": "2", "new_value": "3"}}]
    }}
  ],
  "doors_corrections": [
    {{"door_number": "110-01A", "field": "hw_set", "old_value": "DH1", "new_value": "DH2"}}
  ],
  "missing_doors": [
    {{"door_number": "110-05A", "hw_set": "DH1", "location": "Office", "door_type": "WD", "frame_type": "HM", "fire_rating": "20Min", "hand": "LHR"}}
  ],
  "missing_sets": [
    {{"set_id": "DH5", "heading": "Storage Room", "items": [{{"qty": 3, "name": "Hinges", "manufacturer": "IV", "model": "5BB1", "finish": "626"}}]}}
  ],
  "notes": "Optional notes about extraction quality"
}}

If the extraction is accurate and complete, return: {{"notes": "Extraction looks correct"}}

CRITICAL RULES:
- Only report REAL errors you can see in the PDF. Do not hallucinate corrections.
- DO NOT "fix" item quantities. The quantities shown have ALREADY been normalized from PDF totals to per-opening values by dividing by the number of doors in each set. If the PDF shows "8" for closers across 8 doors, the correct per-opening qty is 1, and the extracted data will show 1. Do NOT change it back to 8.
- Focus on: missing items/doors, wrong set assignments, misread text (names, manufacturers, models, finishes).
- Do NOT correct formatting differences (e.g. "HM" vs "Hollow Metal" are both fine).
- FIELD SPLITTING: The name field should contain ONLY the hardware category name (e.g., "Closer", "Hinges", "Exit Device"). If an item's name still contains model numbers, finish codes, or manufacturer abbreviations (e.g., name="Closer 4040XP AL LC" with empty model/finish/mfr), report it as items_to_fix. Split: name=category only, model=catalog/model number, finish=finish code, manufacturer=company abbreviation. Common codes: IV=Ives, SC=Schlage, ZE=Zero, LC=LCN, AB=ABH, VO=Von Duprin, NA=NGP, ME=Medeco.

{get_taxonomy_prompt_text()}"""


def _cache_key(pdf_path: str | Path, pdfplumber_result: dict) -> str:
    """Deterministic cache key from PDF name + hash of extraction result."""
    pdf_name = Path(pdf_path).stem
    content_hash = hashlib.sha256(
        json.dumps(pdfplumber_result, sort_keys=True, default=str).encode()
    ).hexdigest()[:12]
    return f"{pdf_name}_{content_hash}"


def _load_cache(key: str) -> dict | None:
    path = CACHE_DIR / f"{key}.json"
    if path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    return None


def _save_cache(key: str, data: dict) -> None:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    (CACHE_DIR / f"{key}.json").write_text(
        json.dumps(data, indent=2, default=str), encoding="utf-8"
    )


def _extract_json(text: str) -> dict:
    """Extract JSON from LLM response, stripping markdown fences if present."""
    text = text.strip()
    if text.startswith("```"):
        # Remove opening fence (```json or ```)
        first_newline = text.index("\n") if "\n" in text else 3
        text = text[first_newline + 1:]
        # Remove closing fence
        if text.rstrip().endswith("```"):
            text = text.rstrip()[:-3]
    return json.loads(text.strip())


def _serialize_extraction(pdfplumber_result: dict) -> str:
    """Build the extraction summary sent to the LLM (matches TS route)."""
    hw_sets = pdfplumber_result.get("hardware_sets", [])
    openings = pdfplumber_result.get("openings", [])
    return json.dumps({
        "hardware_sets": [
            {
                "set_id": s.get("set_id", ""),
                "heading": s.get("heading", ""),
                "item_count": len(s.get("items", [])),
                "items": s.get("items", []),
            }
            for s in hw_sets
        ],
        "doors_count": len(openings),
        "doors_sample": openings[:10],
        "total_doors": len(openings),
    }, indent=2, default=str)


def review_extraction(
    pdf_path: str | Path,
    pdfplumber_result: dict,
    *,
    use_cache: bool = True,
) -> dict:
    """Call Anthropic API to review pdfplumber extraction against the PDF.

    Args:
        pdf_path: Path to the source PDF file.
        pdfplumber_result: Dict with 'hardware_sets' and 'openings' keys,
            matching the structure produced by extract-tables.py.
        use_cache: If True, return cached response when available.

    Returns:
        Dict with 'corrections' (the LLM response) and 'confidence' (0-1 float
        based on whether the LLM found issues).

    Raises:
        EnvironmentError: If ANTHROPIC_API_KEY is not set.
        FileNotFoundError: If pdf_path does not exist.
    """
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        raise EnvironmentError(
            "ANTHROPIC_API_KEY environment variable is required for LLM review"
        )

    pdf_path = Path(pdf_path)
    if not pdf_path.exists():
        raise FileNotFoundError(f"PDF not found: {pdf_path}")

    # Check cache
    cache_key = _cache_key(pdf_path, pdfplumber_result)
    if use_cache:
        cached = _load_cache(cache_key)
        if cached is not None:
            return cached

    # Lazy import — only needed when actually calling the API
    import anthropic

    client = anthropic.Anthropic(api_key=api_key)

    pdf_bytes = pdf_path.read_bytes()
    b64 = base64.b64encode(pdf_bytes).decode("ascii")

    extracted_summary = _serialize_extraction(pdfplumber_result)

    response = client.messages.create(
        model="claude-haiku-4-5-20251001",
        max_tokens=8192,
        system=[{"type": "text", "text": SYSTEM_PROMPT, "cache_control": {"type": "ephemeral"}}],
        messages=[
            {
                "role": "user",
                "content": [
                    {
                        "type": "document",
                        "source": {"type": "base64", "media_type": "application/pdf", "data": b64},
                        "cache_control": {"type": "ephemeral"},
                    },
                    {
                        "type": "text",
                        "text": (
                            "Here is the automated extraction result. "
                            "Review it against the PDF and return corrections as JSON:\n\n"
                            + extracted_summary
                        ),
                    },
                ],
            },
        ],
    )

    text_block = next((b for b in response.content if b.type == "text"), None)
    if not text_block:
        corrections: dict[str, Any] = {"notes": "LLM review returned no text"}
    else:
        try:
            corrections = _extract_json(text_block.text)
        except (json.JSONDecodeError, ValueError):
            corrections = {"notes": f"Failed to parse LLM response: {text_block.text[:200]}"}

    # Compute confidence: 1.0 if no corrections, lower if corrections found
    has_corrections = any(
        corrections.get(k)
        for k in ("hardware_sets_corrections", "doors_corrections", "missing_doors", "missing_sets")
    )
    confidence = 0.7 if has_corrections else 1.0

    result = {"corrections": corrections, "confidence": confidence}

    # Cache the result
    _save_cache(cache_key, result)

    return result


def apply_corrections(
    hw_sets: list[dict],
    doors: list[dict],
    corrections: dict,
) -> dict:
    """Apply LLM corrections to extraction results (port of TS applyCorrections).

    Args:
        hw_sets: List of hardware set dicts (set_id, heading, items[]).
        doors: List of door/opening dicts (door_number, hw_set, ...).
        corrections: The 'corrections' dict from review_extraction().

    Returns:
        Dict with 'hardware_sets' and 'doors' keys containing the merged data.
    """
    # Deep copy to avoid mutating inputs
    import copy
    hw_sets = copy.deepcopy(hw_sets)
    doors = copy.deepcopy(doors)

    # Apply hardware set corrections
    for corr in corrections.get("hardware_sets_corrections", []):
        matching_set = next((s for s in hw_sets if s.get("set_id") == corr.get("set_id")), None)
        if not matching_set:
            continue

        if corr.get("heading"):
            matching_set["heading"] = corr["heading"]

        # Remove items
        for name in corr.get("items_to_remove", []):
            matching_set["items"] = [
                i for i in matching_set.get("items", []) if i.get("name") != name
            ]

        # Fix items
        for fix in corr.get("items_to_fix", []):
            item = next(
                (i for i in matching_set.get("items", []) if i.get("name") == fix.get("name")),
                None,
            )
            if item and fix.get("field") in item:
                val = fix.get("new_value", "")
                if fix["field"] == "qty":
                    try:
                        item["qty"] = int(val)
                    except (ValueError, TypeError):
                        item["qty"] = 1
                    item["qty_source"] = "llm_override"
                else:
                    item[fix["field"]] = val

        # Add missing items
        for new_item in corr.get("items_to_add", []):
            existing_names = {i.get("name") for i in matching_set.get("items", [])}
            if new_item.get("name") not in existing_names:
                matching_set.setdefault("items", []).append(new_item)

    # Add missing sets
    for new_set in corrections.get("missing_sets", []):
        existing_ids = {s.get("set_id") for s in hw_sets}
        if new_set.get("set_id") not in existing_ids:
            hw_sets.append({
                "set_id": new_set["set_id"],
                "heading": new_set.get("heading", ""),
                "items": new_set.get("items", []),
            })

    # Apply door corrections
    for corr in corrections.get("doors_corrections", []):
        door = next((d for d in doors if d.get("door_number") == corr.get("door_number")), None)
        if door and corr.get("field") in door:
            door[corr["field"]] = corr.get("new_value", "")

    # Add missing doors
    for new_door in corrections.get("missing_doors", []):
        existing_numbers = {d.get("door_number") for d in doors}
        if new_door.get("door_number") not in existing_numbers:
            doors.append(new_door)

    return {"hardware_sets": hw_sets, "doors": doors}
