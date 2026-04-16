from __future__ import annotations
"""
Phase 2: Deterministic table extraction via pdfplumber.

Vercel Python serverless function that receives base64-encoded PDF pages,
extracts BOTH:
  1. Hardware Set definitions (set ID, heading, items with qty/name/mfr/model/finish)
  2. Opening List / Door Schedule (door number, hw_set, location, types, rating, hand)

Uses text-alignment-based table detection for hardware sets (transparent grid lines)
and line-based detection for Opening List tables, with text fallback for both.

Also extracts reference tables (Manufacturer List, Finish List, Option List)
and returns them as lookup dictionaries for decoding abbreviations.

Location: /api/extract-tables.py (project root, Vercel Python runtime)
"""

import base64
import hmac
import io
import json
import logging
import os
import re
import traceback
import unicodedata
from http.server import BaseHTTPRequestHandler

logger = logging.getLogger("extract-tables")
logging.basicConfig(level=logging.INFO)

import pdfplumber
from pydantic import BaseModel


# --- Internal Token Auth ---
#
# All three Python endpoints (/api/extract-tables, /api/classify-pages,
# /api/detect-mapping) are publicly reachable on the Vercel deployment URL.
# To prevent anonymous PDF uploads, the Next.js layer forwards a shared
# secret in the X-Internal-Token header. This helper validates that header.
#
# If PYTHON_INTERNAL_SECRET is unset, the request is rejected with 401
# to prevent unauthenticated access. Keep this
# helper in sync across all api/*.py files (Vercel bundles them
# separately, so duplication is intentional).

def require_internal_token(request_handler) -> bool:
    """Verify X-Internal-Token matches PYTHON_INTERNAL_SECRET.

    Returns True if authorized. If not authorized, sends a 401 response
    and returns False — caller should return immediately without further
    processing.

    If PYTHON_INTERNAL_SECRET is not set, the request is rejected with 401
    to prevent unauthenticated access in misconfigured environments.
    """
    expected = os.environ.get("PYTHON_INTERNAL_SECRET", "") or ""
    if not expected:
        logger.error(
            "PYTHON_INTERNAL_SECRET is not set — rejecting request. "
            "Configure the env var in Vercel to enable this endpoint."
        )
        body = json.dumps({"error": "Internal secret not configured"}).encode()
        request_handler.send_response(401)
        request_handler.send_header("Content-Type", "application/json")
        request_handler.send_header("Content-Length", str(len(body)))
        request_handler.end_headers()
        request_handler.wfile.write(body)
        return False

    provided = request_handler.headers.get("X-Internal-Token", "") or ""
    if not hmac.compare_digest(expected, provided):
        body = json.dumps({"error": "Unauthorized"}).encode()
        request_handler.send_response(401)
        request_handler.send_header("Content-Type", "application/json")
        request_handler.send_header("Content-Length", str(len(body)))
        request_handler.end_headers()
        request_handler.wfile.write(body)
        return False

    return True


# --- Pydantic Models ---

class HardwareItem(BaseModel):
    qty: int = 1                        # per-opening qty (normalized)
    qty_total: int | None = None        # raw total from PDF before division
    qty_door_count: int | None = None   # doors in this set (divisor)
    qty_source: str = "parsed"          # "parsed" | "divided" | "flagged" | "capped"
    name: str = ""
    manufacturer: str = ""
    model: str = ""
    finish: str = ""
    base_series: str = ""               # product family ID (e.g., "5BB1", "L9010")


class HardwareSetDef(BaseModel):
    set_id: str              # heading-level ID (e.g., "I2S-1E:WI" or "DH4A.0")
    generic_set_id: str = "" # set-level ID (e.g., "I2S-1E" or "DH4A") for UI grouping
    heading: str = ""
    heading_door_count: int = 0   # openings listed in heading block
    heading_leaf_count: int = 0   # total leaves (pairs × 2, singles × 1)
    heading_doors: list[str] = [] # specific door numbers listed under this sub-heading
    qty_convention: str = "unknown"  # "per_opening" | "aggregate" | "unknown" — detected from preamble text
    items: list[HardwareItem] = []


class DoorEntry(BaseModel):
    door_number: str
    hw_set: str = ""
    hw_heading: str = ""
    location: str = ""
    door_type: str = ""
    frame_type: str = ""
    fire_rating: str = ""
    hand: str = ""
    by_others: bool = False


class ReferenceCode(BaseModel):
    code_type: str  # manufacturer | finish | option
    code: str       # abbreviation
    full_name: str  # decoded value


class FlaggedDoor(BaseModel):
    """A door number that was rejected or flagged for user review."""
    door: DoorEntry
    reason: str          # human-readable reason it was flagged
    pattern: str = ""    # the structural pattern of this door number
    dominant_pattern: str = ""  # the dominant pattern in the document


class ExtractionResult(BaseModel):
    success: bool
    openings: list[DoorEntry] = []
    hardware_sets: list[HardwareSetDef] = []
    reference_codes: list[ReferenceCode] = []
    flagged_doors: list[FlaggedDoor] = []  # outliers for user review
    expected_door_count: int = 0
    tables_found: int = 0
    hw_sets_found: int = 0
    method: str = "pdfplumber"
    error: str = ""
    confidence: str = "high"  # high | medium | low — shown to user
    extraction_notes: list[str] = []  # human-readable notes about extraction quality


class RegionExtractionResult(BaseModel):
    """Lightweight result for bbox-cropped region extraction."""
    success: bool
    items: list[HardwareItem] = []
    raw_text: str = ""
    error: str = ""


# --- Category-Aware Quantity Validation ---
# Expected per-opening quantity ranges by hardware category.
# Values outside these ranges are likely aggregate/total quantities.
EXPECTED_QTY_RANGES: dict[str, tuple[int, int]] = {
    "hinge":              (2, 5),   # 3 standard, 4-5 for tall/heavy doors
    "electric_hinge":     (1, 5),   # Per-opening, but use hinge max for cap-path compat
    "wire_harness":       (1, 2),   # Per-leaf, paired with electric hardware
    "continuous_hinge":   (1, 2),
    "pivot":              (1, 2),
    "lockset":            (1, 1),
    "exit_device":        (1, 2),
    "flush_bolt":         (1, 2),
    "auto_operator":      (1, 1),   # Replaces closer, 1 per opening
    "closer":             (1, 2),
    "coordinator":        (0, 1),
    "stop":               (1, 2),
    "holder":             (1, 2),
    "silencer":           (2, 4),   # Typically 3 per frame
    "threshold":          (1, 1),
    "kick_plate":         (1, 2),
    "seal":               (1, 3),   # Perimeter seals can be 1-3 pieces
    "sweep":              (1, 1),
    "astragal":           (1, 1),
    "cylinder":           (1, 2),
    "strike":             (1, 2),
    "pull":               (1, 2),
}

# Division preference by category: which divisor to try first.
# "leaf"         — per-leaf items (hinges): try leaves first, then openings
# "opening"      — per-opening items (closers, locksets): try openings first, then leaves
# "opening_only" — items that exist once per opening, never per-leaf
DIVISION_PREFERENCE: dict[str, str] = {
    "hinge":            "leaf",
    "electric_hinge":   "opening",     # 1 per opening, replaces one NRP position
    "wire_harness":     "leaf",        # Per-leaf, follows electrified hardware
    "continuous_hinge": "leaf",
    "pivot":            "leaf",
    "auto_operator":    "opening",     # 1 per opening, replaces closer
    "closer":           "opening",
    "lockset":          "opening",
    "exit_device":      "leaf",        # Each leaf gets its own exit device
    "stop":             "leaf",        # Each leaf gets its own stop/holder
    "holder":           "opening",
    "kick_plate":       "leaf",        # Each leaf gets its own protection plate
    "cylinder":         "opening",
    "strike":           "opening",
    "pull":             "opening",
    "silencer":         "opening",
    "threshold":        "opening_only",
    "sweep":            "leaf",        # Each leaf gets its own door bottom/sweep
    "astragal":         "opening_only",
    "seal":             "opening_only",
    "coordinator":      "opening_only",
    "flush_bolt":       "opening_only",
}

# Map item names to categories using keyword matching
_CATEGORY_PATTERNS: list[tuple[str, re.Pattern]] = [
    ("continuous_hinge", re.compile(r"(?i)continuous\s*hinge|cont\.?\s*hinge")),
    # Electric/conductor/power-transfer hinges: per-opening, not per-leaf.
    # These replace ONE standard hinge position on the active leaf.
    # Must be checked BEFORE generic "hinge" pattern.
    ("electric_hinge", re.compile(
        r"(?i)hinge.*\bCON\b|hinge.*\bTW\d|hinge.*electr|hinge.*conduct"
        r"|electr.*hinge|conductor.*hinge|power\s*transfer\s*hinge"
    )),
    ("hinge",     re.compile(r"(?i)\bhinge|pivot|spring\s*hinge")),
    ("pivot",     re.compile(r"(?i)\bpivot\b")),
    ("lockset",   re.compile(r"(?i)lockset|latchset|latch\s*set|lock\s*set|passage|privacy|storeroom|classroom|entrance|mortise|cylindrical|deadbolt")),
    ("exit_device", re.compile(r"(?i)exit\s*device|panic|rim\s*device|concealed\s*vertical|surface\s*vertical|push\s*bar|touch\s*bar")),
    ("flush_bolt", re.compile(r"(?i)flush\s*bolt|surface\s*bolt")),
    # Automatic operators: replace the closer function. When both exist, flag.
    ("auto_operator", re.compile(r"(?i)auto.*operator|automatic\s*operator|power\s*operator|ada\s*operator")),
    # Wire harness / connector: per-leaf, follows electrified hardware.
    # Mirrors the TS taxonomy at src/lib/hardware-taxonomy.ts:205. Placed
    # AFTER electric_hinge so "hinge CON TW8" is classified as electric_hinge,
    # but BEFORE cylinder so standalone "CON-5" style connectors are caught.
    ("wire_harness", re.compile(r"(?i)wire\s*harness|\bmolex\b|\bcon-\d|\bwiring\b|\bpigtail\b|\bconnector\b")),
    ("closer",    re.compile(r"(?i)\bcloser\b|door\s*check|floor\s*closer")),
    ("coordinator", re.compile(r"(?i)\bcoordinator\b")),
    ("stop",      re.compile(r"(?i)\bstop\b|wall\s*stop|floor\s*stop|overhead\s*stop|door\s*stop")),
    ("holder",    re.compile(r"(?i)\bholder\b|hold\s*open")),
    ("silencer",  re.compile(r"(?i)\bsilencer|bumper|mute")),
    ("threshold", re.compile(r"(?i)\bthreshold|saddle")),
    ("kick_plate", re.compile(r"(?i)kick\s*plate|protection\s*plate|mop\s*plate|armor\s*plate")),
    ("seal",      re.compile(r"(?i)\bgasket|smoke\s*seal|acoustic\s*seal|weatherstrip|perimeter\s*seal|sound\s*seal")),
    ("sweep",     re.compile(r"(?i)\bsweep|door\s*bottom|drop\s*seal|auto.*door\s*bottom")),
    ("astragal",  re.compile(r"(?i)\bastragal|meeting\s*stile")),
    ("cylinder",  re.compile(r"(?i)\bcylinder|core|interchangeable")),
    ("strike",    re.compile(r"(?i)\bstrike\b|electric\s*strike|power\s*strike")),
    ("pull",      re.compile(r"(?i)\bpull\b|push\s*plate|lever|knob")),
]


def _classify_hardware_item(name: str) -> str | None:
    """Classify a hardware item name into a category for qty validation."""
    for category, pattern in _CATEGORY_PATTERNS:
        if pattern.search(name):
            return category
    return None


def _max_qty_for_category(category: str | None) -> int:
    """Return the maximum expected per-opening qty for a hardware category."""
    if category and category in EXPECTED_QTY_RANGES:
        return EXPECTED_QTY_RANGES[category][1]
    return 4  # Conservative default for unknown categories


# --- Quantity Convention Detection ---
# Preamble phrases that definitively indicate per-opening quantities.
# These appear in schedule-format PDFs (sched-Barnstable, sched-Claymont, etc.)
# and are strong enough to override the statistical heuristic.
_PER_OPENING_PREAMBLES: list[re.Pattern] = [
    re.compile(r"(?i)each\s+opening\s+to\s+have\s*:"),
    re.compile(r"(?i)each\s+to\s+receive\s*:"),
    re.compile(r"(?i)each\s+to\s+have\s*:"),
    re.compile(r"(?i)each\s+door\s+leaf\s+shall\s+have\s*:"),
    re.compile(r"(?i)each\s+door\s+to\s+have\s*:"),
    re.compile(r"(?i)per\s+opening\s*:"),
]

# Dual-quantity format: "(total) per_door EA" — used by SpecWorks/kinship PDFs.
# E.g., "(42) 3 EA" means 42 total, 3 per door.
_DUAL_QTY_RE = re.compile(r"\((\d+)\)\s*(\d+)\s*EA\b", re.IGNORECASE)


def detect_quantity_convention(text: str, door_count: int = 0) -> str:
    """Detect whether a hardware set uses per-opening or aggregate quantities.

    Scans the text for definitive preamble phrases. If a per-opening preamble
    is found, returns "per_opening". If no preamble is found and quantities
    are much larger than expected for single-door counts, returns "aggregate".
    Otherwise returns "unknown".

    Args:
        text: The raw text of the hardware set section (heading + items).
        door_count: Number of doors assigned to this heading (0 if unknown).

    Returns:
        "per_opening", "aggregate", or "unknown"
    """
    # Definitive: per-opening preamble phrases
    for pattern in _PER_OPENING_PREAMBLES:
        if pattern.search(text):
            return "per_opening"

    # Dual-quantity format "(total) per_door EA" — definitively per-opening
    # because the per-door number is explicitly provided.
    if _DUAL_QTY_RE.search(text):
        return "per_opening"

    # Supportive: absence of per-opening preambles + quantities >> door count
    # suggests aggregate. Only classify as aggregate if we have a door count
    # AND the text contains item lines with large quantities.
    # Exclude door assignment lines (e.g., "1 SGL Door:101") which start with
    # small numbers but are not hardware item quantities.
    if door_count > 1:
        item_qtys = []
        for m in re.finditer(r"^\s*(\d{1,3})\s+(.+)", text, re.MULTILINE):
            rest = m.group(2).strip()
            # Skip door assignment lines
            if re.match(r"(?i)(SGL|PRA/PRI|PR|Pair)\s+(Door|Opening)", rest):
                continue
            item_qtys.append(int(m.group(1)))
        if item_qtys:
            over_threshold = sum(1 for v in item_qtys if v > 6)
            if len(item_qtys) >= 2 and over_threshold / len(item_qtys) > 0.6:
                return "aggregate"

    return "unknown"


def extract_dual_qty(text: str) -> list[tuple[int, int]]:
    """Extract dual-quantity pairs from SpecWorks "(total) per_door EA" format.

    Returns list of (total, per_door) tuples found in the text.
    """
    return [(int(m.group(1)), int(m.group(2))) for m in _DUAL_QTY_RE.finditer(text)]


# --- Hardware Item Dedup (Level 1: within-chunk/within-page) ---

def _normalize_item_name(name: str) -> str:
    """Normalize hardware item name for dedup comparison."""
    _ABBREVIATIONS = {
        'cont.': 'continuous', 'cont': 'continuous',
        'flr': 'floor', 'flr.': 'floor',
        'w/': 'with ', 'w/o': 'without',
        'mtd': 'mounted', 'mtd.': 'mounted',
        'hd': 'heavy duty', 'hd.': 'heavy duty',
        'adj': 'adjustable', 'adj.': 'adjustable',
        'ss': 'stainless steel',
        'alum': 'aluminum', 'alum.': 'aluminum',
        'sfc': 'surface', 'sfc.': 'surface',
        'conc': 'concealed', 'conc.': 'concealed',
        'thresh': 'threshold', 'thresh.': 'threshold',
    }
    n = name.lower().strip()
    for abbr, full in _ABBREVIATIONS.items():
        escaped = re.escape(abbr)
        n = re.sub(rf"\b{escaped}\b", full, n)
    return re.sub(r"\s+", " ", n).strip(" ,;.")


def _item_dedup_key(item: HardwareItem) -> str:
    """Generate a dedup key: prefer model number, fall back to normalized name."""
    model = item.model.strip().lower()
    if model:
        return f"model:{model}"
    return f"name:{_normalize_item_name(item.name)}"


def _item_completeness(item: HardwareItem) -> int:
    """Score how many fields are populated (more = more complete)."""
    return sum(1 for v in [item.name, item.model, item.manufacturer, item.finish] if v.strip())


def deduplicate_hardware_items(items: list[HardwareItem]) -> list[HardwareItem]:
    """Deduplicate hardware items, keeping the version with more complete data."""
    seen: dict[str, HardwareItem] = {}
    for item in items:
        key = _item_dedup_key(item)
        existing = seen.get(key)
        if existing is None:
            seen[key] = item
        elif _item_completeness(item) > _item_completeness(existing):
            seen[key] = item
    deduped = list(seen.values())
    if len(deduped) < len(items):
        logger.info(f"Dedup: {len(items)} → {len(deduped)} items (removed {len(items) - len(deduped)} duplicates)")
    return deduped


# ─── BUG-12: Field-splitting functions ────────────────────────────────────────

def filter_non_hardware_items(items: list[HardwareItem]) -> list[HardwareItem]:
    """
    Remove items that are clearly not hardware (sentence fragments from PDF
    notes, door assignment header rows, section dividers, date strings).
    Conservative — only removes items that definitely aren't hardware.
    """
    filtered: list[HardwareItem] = []
    for item in items:
        name = item.name.strip()
        if not name:
            continue

        # Door assignment rows, section dividers, date strings
        if NON_HARDWARE_PATTERN.search(name):
            logger.debug(f"[filter] Removed non-hardware: {name!r}")
            continue

        # Sentence fragments (starts with lowercase letter)
        if name[0].islower():
            logger.debug(f"[filter] Removed lowercase-start fragment: {name!r}")
            continue

        # Starts with punctuation (not hardware)
        if name[0] in ":;-*,":
            logger.debug(f"[filter] Removed punctuation-start: {name!r}")
            continue

        # Contains sentence-like patterns
        if SENTENCE_FRAGMENT_PATTERN.search(name):
            logger.debug(f"[filter] Removed sentence fragment: {name!r}")
            continue

        # OCR garble: most tokens are 1-2 chars (e.g. "NTOWN CONNECT IO N")
        # Exclude tokens that are known mfr/finish codes from the count
        tokens = name.split()
        if len(tokens) >= 3:
            short_garbage = sum(
                1 for t in tokens
                if len(t) <= 2
                and t.upper() not in MANUFACTURER_CODES
                and not FINISH_CODE_PATTERN.match(t)
            )
            if short_garbage >= len(tokens) * 0.5:
                logger.debug(f"[filter] Removed OCR garble: {name!r}")
                continue

        filtered.append(item)

    if len(filtered) < len(items):
        logger.info(
            f"[filter] Removed {len(items) - len(filtered)} non-hardware items "
            f"({len(items)} → {len(filtered)})"
        )
    return filtered


def reassemble_truncated_fields(item: HardwareItem) -> HardwareItem:
    """
    Fix Mode 2: pdfplumber misaligned column boundaries causing words to be
    split across name/mfr/model/finish fields.

    Detection: if mfr starts with lowercase (word continuation) or is a short
    fragment not matching a known code, reassemble everything into name.
    """
    name = item.name.strip()
    mfr = item.manufacturer.strip()
    model = item.model.strip()
    finish = item.finish.strip()

    # Nothing to reassemble if all other fields are empty
    if not mfr and not model and not finish:
        return item

    # Check if fields look properly structured (skip reassembly)
    if (mfr.upper() in MANUFACTURER_CODES
            and model
            and len(model) > 2
            and (not name or name[-1] == " " or not mfr or not mfr[0].islower())):
        return item

    # Detect truncation artifacts
    truncated = False

    # (a) mfr starts with lowercase → word continuation of name
    if mfr and mfr[0].islower():
        truncated = True

    # (b) mfr is a very short fragment (1-2 chars) not matching any known code
    elif mfr and len(mfr) <= 2 and mfr.upper() not in MANUFACTURER_CODES:
        truncated = True

    # (c) finish contains lowercase letters (likely a word fragment, not a code)
    elif finish and re.search(r"[a-z]", finish) and not FINISH_CODE_PATTERN.match(finish):
        truncated = True

    # (d) model is very short (1-2 chars) and looks like a fragment
    elif model and len(model) <= 2 and not re.match(r"^\d+$", model):
        truncated = True

    if not truncated:
        return item

    # Reassemble all fields into name
    parts = [name]
    if mfr:
        # Lowercase start = direct continuation (no space)
        if mfr[0].islower():
            parts[-1] = parts[-1] + mfr
        else:
            parts.append(mfr)
    if model:
        parts.append(model)
    if finish:
        parts.append(finish)

    reassembled = " ".join(parts)
    reassembled = re.sub(r"\s+", " ", reassembled).strip()

    logger.debug(
        f"[reassemble] '{item.name}' + '{mfr}' + '{model}' + '{finish}' → '{reassembled}'"
    )

    return HardwareItem(
        qty=item.qty,
        qty_total=item.qty_total,
        qty_door_count=item.qty_door_count,
        qty_source=item.qty_source,
        name=reassembled,
        manufacturer="",
        model="",
        finish="",
    )


def split_concatenated_hw_fields(
    item: HardwareItem,
    pdf_reference_codes: list[ReferenceCode] | None = None,
) -> HardwareItem:
    """
    Split a concatenated hardware item name into separate fields.

    Algorithm (right-to-left):
    1. Check if last token is a known manufacturer abbreviation → extract mfr
    2. Check if new last token is a finish code → extract finish
    3. Match beginning against HARDWARE_ITEM_NAMES → extract item name
    4. Everything between name and finish/mfr → model
    """
    # Skip if fields are already populated
    if item.manufacturer or item.model or item.finish:
        return item

    name = item.name.strip()
    if not name:
        return item

    # Skip "by others" / "not used" / "by supplier" items
    # Tolerant of truncation: "by O thers", "b y others", etc.
    if re.search(
        r"(?i)\b(by\s*o\s*thers|by\s*door\s*supplier|by\s*supplier|by\s*security"
        r"|not\s*used|not\s*in\s*contract|no\s*hardware|b\s*y\s*o\b)\b",
        name,
    ):
        return item

    # Build augmented manufacturer lookup from PDF reference codes
    mfr_lookup: dict[str, str] = dict(MANUFACTURER_CODES)
    if pdf_reference_codes:
        for rc in pdf_reference_codes:
            if rc.code_type == "manufacturer" and rc.code:
                mfr_lookup[rc.code.upper()] = rc.full_name

    # Tokenize
    tokens = name.split()
    if len(tokens) < 2:
        return item  # Single-word item, nothing to split

    # --- Step 1: Extract manufacturer (rightmost token) ---
    extracted_mfr = ""
    last_upper = tokens[-1].upper()

    if last_upper in mfr_lookup and last_upper not in NOT_MANUFACTURER_CODES:
        extracted_mfr = tokens[-1]
        tokens = tokens[:-1]

    # --- Step 2: Extract finish (now-rightmost token) ---
    extracted_finish = ""
    if tokens:
        candidate = tokens[-1]
        # Must match finish pattern AND not be a dimension/model suffix
        if (FINISH_CODE_PATTERN.match(candidate)
                and not NOT_FINISH_PATTERN.match(candidate)):
            extracted_finish = tokens[-1]
            tokens = tokens[:-1]

    # --- Step 3: Extract item name (leftmost word-tokens) ---
    # Hardware names are English words (no digits). Model numbers always
    # contain digits. Walk tokens left-to-right; stop at first token with
    # a digit — that starts the model.
    name_end_idx = 0
    for i, tok in enumerate(tokens):
        if re.search(r"\d", tok):
            break
        name_end_idx = i + 1

    if name_end_idx == 0:
        name_end_idx = 1  # at minimum, first token is the name
    extracted_name = " ".join(tokens[:name_end_idx])

    # --- Step 4: Model = everything between name and finish/mfr ---
    model_tokens = tokens[name_end_idx:]
    extracted_model = " ".join(model_tokens)

    # Validate: if we extracted nothing useful, keep original
    if not extracted_model and not extracted_mfr and not extracted_finish:
        return item

    # Extract base series from model string for product family grouping
    base_series = extract_base_series(extracted_model, extracted_mfr)

    logger.debug(
        f"[split] '{item.name}' → name='{extracted_name}', "
        f"model='{extracted_model}', finish='{extracted_finish}', "
        f"mfr='{extracted_mfr}', base_series='{base_series}'"
    )

    return HardwareItem(
        qty=item.qty,
        qty_total=item.qty_total,
        qty_door_count=item.qty_door_count,
        qty_source=item.qty_source,
        name=extracted_name,
        manufacturer=extracted_mfr,
        model=extracted_model,
        finish=extracted_finish,
        base_series=base_series,
    )


def _heal_broken_words(text: str) -> str:
    """
    Fix pdfplumber word-break artifacts where characters are split by spaces.
    E.g., "Continuous Hi nge" → "Continuous Hinge",
          "Protection Pla te" → "Protection Plate",
          "Electrified Mortis e L ock" → "Electrified Mortise Lock"

    Rule: a lowercase-starting token is a fragment of the previous word IF either
    the previous token or the fragment is short (<=3 chars). This distinguishes
    real fragments ("nge", "ore", "te") from real words ("unlocks", "lockset").
    """
    tokens = text.split()
    if len(tokens) < 2:
        return text

    # Pass 1: join lowercase fragments to previous token
    _REAL_WORDS = {"to", "in", "of", "or", "by", "an", "at", "on",
                   "is", "it", "as", "no", "so", "up", "if", "we",
                   "be", "do", "he", "me", "us", "am", "my"}
    merged: list[str] = [tokens[0]]
    for i in range(1, len(tokens)):
        tok = tokens[i]
        if (tok and tok[0].islower() and tok not in ("x",)
                and tok.lower() not in _REAL_WORDS and merged
                and merged[-1].lower() not in _REAL_WORDS
                and (len(merged[-1]) <= 3 or len(tok) <= 3)):
            merged[-1] = merged[-1] + tok
        else:
            merged.append(tok)

    # Pass 2: join isolated single uppercase chars to adjacent token
    result: list[str] = []
    i = 0
    while i < len(merged):
        tok = merged[i]
        if len(tok) == 1 and tok.isalpha() and tok.lower() not in ("x",):
            if i + 1 < len(merged) and merged[i + 1][0:1].isalpha():
                # Prepend to next token
                merged[i + 1] = tok + merged[i + 1]
            elif result and result[-1][-1:].isalpha():
                # End of string: append to previous
                result[-1] = result[-1] + tok
            else:
                result.append(tok)
        else:
            result.append(tok)
        i += 1
    return " ".join(result)


def _join_split_rows(items: list[HardwareItem]) -> list[HardwareItem]:
    """Join rows that pdfplumber split across column boundaries.

    Detects fragments like {"name": "Others)", "model": "CONTRACTOR"} that
    should be part of "Hardware by Others (Contractor)" on the previous row.

    Heuristic: if an item's name is < 4 chars, ends with unmatched ')',
    starts with lowercase, or is pure punctuation — merge it into the
    previous item's model/finish fields.
    """
    if len(items) < 2:
        return items
    merged: list[HardwareItem] = []
    for item in items:
        name = item.name.strip()
        is_fragment = (
            (len(name) < 4 and not re.match(r"^[A-Z]{1,3}$", name))
            or re.match(r"^[)\]\s]+$", name)
            or (len(name) > 0 and name[0].islower())
            or name.endswith(")")
        )
        if is_fragment and merged:
            prev = merged[-1]
            # Join into previous item's model field
            join_text = f"{name} {item.model}".strip() if item.model else name
            new_model = f"{prev.model} {join_text}".strip() if prev.model else join_text
            merged[-1] = HardwareItem(
                qty=prev.qty,
                qty_total=prev.qty_total,
                qty_door_count=prev.qty_door_count,
                qty_source=prev.qty_source,
                name=prev.name,
                manufacturer=prev.manufacturer,
                model=new_model,
                finish=prev.finish if prev.finish else item.finish,
            )
            logger.debug("[join_split_rows] Merged fragment %r into prev item %r", name, prev.name)
        else:
            merged.append(item)
    return merged


def apply_field_splitting(
    hardware_sets: list[HardwareSetDef],
    reference_codes: list[ReferenceCode],
) -> None:
    """
    Post-processing pass: filter garbage items, reassemble truncated fields,
    split concatenated fields, join split rows, and re-deduplicate.
    Mutates hardware_sets in place.
    Called after hardware sets AND reference codes are both extracted.
    """
    for hw_set in hardware_sets:
        hw_set.items = filter_non_hardware_items(hw_set.items)
        new_items: list[HardwareItem] = []
        for item in hw_set.items:
            item = reassemble_truncated_fields(item)
            # Heal broken words before splitting
            healed_name = _heal_broken_words(item.name)
            if healed_name != item.name:
                logger.debug(f"[heal] {item.name!r} → {healed_name!r}")
                item = HardwareItem(
                    qty=item.qty, qty_total=item.qty_total,
                    qty_door_count=item.qty_door_count,
                    qty_source=item.qty_source,
                    name=healed_name,
                    manufacturer=item.manufacturer,
                    model=item.model,
                    finish=item.finish,
                )
            item = split_concatenated_hw_fields(item, reference_codes)
            new_items.append(item)
        # Join rows that pdfplumber split across column boundaries
        new_items = _join_split_rows(new_items)
        # Second filter pass: reassembly can produce longer garbage strings
        # from short fragments that survived the first filter
        new_items = filter_non_hardware_items(new_items)
        hw_set.items = deduplicate_hardware_items(new_items)


# ─── End BUG-12 functions ─────────────────────────────────────────────────────


# --- Column Detection for Opening List ---

# --- Intelligent Column Detection ---
#
# Instead of brittle regex, use keyword scoring. Each field has weighted
# keywords. A header is scored against ALL fields and the best match wins.
# This handles variants like "Hdw Set", "HW Set", "Hardware Set", "Set #",
# "Opening", "Door No.", "Door #", etc. without needing exact patterns.

COLUMN_KEYWORDS: dict[str, list[tuple[str, float]]] = {
    "door_number": [
        ("opening", 0.7), ("door", 0.7), ("no", 0.3), ("num", 0.3),
        ("number", 0.3), ("#", 0.3), ("tag", 0.3), ("mark", 0.3),
    ],
    "hw_set": [
        ("hw", 0.5), ("hdw", 0.5), ("hardware", 0.5), ("set", 0.5),
        ("group", 0.4),
    ],
    "hw_heading": [
        ("hw", 0.3), ("hdw", 0.3), ("hardware", 0.3), ("heading", 0.7),
        ("set", 0.1), ("description", 0.2),
    ],
    "location": [
        ("location", 0.9), ("label", 0.5), ("description", 0.4),
        ("from", 0.4), ("to", 0.3), ("room", 0.5), ("area", 0.4),
    ],
    "door_type": [
        ("door", 0.5), ("type", 0.5), ("dr", 0.5), ("material", 0.3),
    ],
    "frame_type": [
        ("frame", 0.7), ("type", 0.3), ("fr", 0.5), ("material", 0.2),
    ],
    "fire_rating": [
        ("fire", 0.6), ("rating", 0.4), ("rate", 0.4), ("rated", 0.4),
        ("fr", 0.3), ("min", 0.2),
    ],
    "hand": [
        ("hand", 0.8), ("handing", 0.9), ("swing", 0.5),
    ],
}

# Fields that should NOT match a bare header like "Opening" if another field
# already has a stronger claim. Higher = more specific (less likely to be
# a standalone header).
FIELD_SPECIFICITY = {
    "door_number": 1,    # "Opening" alone is likely door_number
    "hw_set": 3,         # needs "set" or "hw"
    "hw_heading": 3,
    "location": 2,
    "door_type": 3,
    "frame_type": 3,
    "fire_rating": 3,
    "hand": 5,           # very specific
}

# Standard column order in door hardware submittals (used for positional
# inference when keyword scoring is ambiguous)
STANDARD_COLUMN_ORDER = [
    "door_number", "hw_set", "hw_heading", "location",
    "door_type", "frame_type", "fire_rating", "hand",
]


# --- Display-name → snake_case alias map ---
# The column mapper UI (detect-mapping.py) returns display names like
# "Door Number", "HW Set", "Fire Rating". Users confirm/adjust these and
# they arrive here as user_column_mapping keys. Internal code uses snake_case.
_DISPLAY_NAME_ALIASES: dict[str, str] = {
    # Direct display label matches (from FIELD_LABELS in detect-mapping.py)
    "door number": "door_number",
    "hw set": "hw_set",
    "hw heading": "hw_heading",
    "location": "location",
    "door type": "door_type",
    "frame type": "frame_type",
    "fire rating": "fire_rating",
    "hand/swing": "hand",
    # Common variations
    "door no": "door_number",
    "door no.": "door_number",
    "door #": "door_number",
    "door#": "door_number",
    "opening": "door_number",
    "opening number": "door_number",
    "opening no": "door_number",
    "opening no.": "door_number",
    "mark": "door_number",
    "mark no": "door_number",
    "mark no.": "door_number",
    "tag": "door_number",
    "hardware set": "hw_set",
    "hardware group": "hw_set",
    "hdw set": "hw_set",
    "set": "hw_set",
    "set id": "hw_set",
    "hw group": "hw_set",
    "hardware heading": "hw_heading",
    "set heading": "hw_heading",
    "heading": "hw_heading",
    "set description": "hw_heading",
    "frame": "frame_type",
    "frame material": "frame_type",
    "door material": "door_type",
    "material": "door_type",
    "fire rated": "fire_rating",
    "rating": "fire_rating",
    "fire label": "fire_rating",
    "fire": "fire_rating",
    "hand": "hand",
    "handing": "hand",
    "swing": "hand",
    "room": "location",
    "room name": "location",
    "description": "location",
    "from / to": "location",
    "from/to": "location",
    # Snake_case pass-through (already correct)
    "door_number": "door_number",
    "hw_set": "hw_set",
    "hw_heading": "hw_heading",
    "door_type": "door_type",
    "frame_type": "frame_type",
    "fire_rating": "fire_rating",
}


def normalize_mapping_keys(
    user_mapping: dict[str, int] | None,
) -> dict[str, int] | None:
    """
    Normalize user-facing column names to internal snake_case keys.

    The column mapper UI passes display names like 'Door Number' but
    extract_opening_list() expects snake_case keys like 'door_number'.
    Returns None if user_mapping is None or empty.
    """
    if not user_mapping:
        return None

    normalized: dict[str, int] = {}
    for display_name, col_index in user_mapping.items():
        key = display_name.lower().strip()
        internal_key = _DISPLAY_NAME_ALIASES.get(key)

        if internal_key is None:
            # Fallback: convert to snake_case by replacing spaces/special chars
            internal_key = re.sub(r"[^a-z0-9]+", "_", key).strip("_")

        # Ensure col_index is int (JSON may deliver strings)
        try:
            idx = int(col_index)
        except (ValueError, TypeError):
            continue

        normalized[internal_key] = idx

    if not normalized:
        return None

    return normalized


def score_header_for_field(header: str, field: str) -> float:
    """
    Score how well a header string matches a field using keyword matching.
    Returns a float 0.0–1.0.
    """
    h = header.lower().strip()
    if not h:
        return 0.0

    # Tokenize: split on whitespace, punctuation, dots
    tokens = re.split(r"[\s._/#\-]+", h)
    tokens = [t for t in tokens if t]

    keywords = COLUMN_KEYWORDS.get(field, [])
    score = 0.0
    matched_keywords = 0

    for token in tokens:
        for keyword, weight in keywords:
            # Exact match
            if token == keyword:
                score += weight
                matched_keywords += 1
                break
            # Prefix match (e.g. "open" matches "opening")
            if len(token) >= 3 and (token.startswith(keyword) or keyword.startswith(token)):
                score += weight * 0.7
                matched_keywords += 1
                break

    # Bonus for matching multiple keywords (e.g. "Door Type" hits both "door" and "type")
    if matched_keywords >= 2:
        score *= 1.2

    # Penalty for very long headers that only match one keyword
    if len(tokens) > 3 and matched_keywords <= 1:
        score *= 0.5

    return min(score, 1.0)

# Reference table header patterns
MANUFACTURER_HEADER = re.compile(
    r"(?i)(manufacturer|mfr\.?|mfg\.?)\s*(list|key|legend|code|abbrev)"
)
FINISH_HEADER = re.compile(
    r"(?i)(finish|fin\.?)\s*(list|key|legend|code|abbrev)"
)
OPTION_HEADER = re.compile(
    r"(?i)(option|opt\.?)\s*(list|key|legend|code|abbrev)"
)

# --- Hardware Set Page Detection ---

# Pattern to match hardware set heading lines — all 6 known real-world formats:
# 1. "SET #04" / "SET 04"              — bare set ID
# 2. "HARDWARE SET #04" / "HW SET #04" — explicit prefix
# 3. "Heading #04 (Set #04)"           — Himmel's format (with optional .PR4/:1 suffix)
# 4. "SET: I1S-7B" / "Set: AD2"        — colon-separated
# 5. "HARDWARE GROUP 04" / "HW GROUP 04" — group keyword
# 6. "04 - Hardware Set"               — ID-first format
# 7. "Heading #: E1-XL.1 3 X 7 IWM"   — ESC/AKN format (colon after #)
HW_SET_HEADING_PATTERN = re.compile(
    r"(?i)"
    r"(?:"
    r"heading\s*#?\s*([A-Z0-9][A-Z0-9.\-:]*)\s*\((?:hw\s*)?set\s*#?\s*([A-Z0-9][A-Z0-9.\-:]*)\)"  # Format 3: Heading #X (Set #Y) or (HwSet Y)
    r"|"
    r"heading\s*#:\s*([A-Z0-9][A-Z0-9.\-]{0,30})\b"  # Format 7: Heading #: ID (ESC/AKN)
    r"|"
    r"(?:hardware\s+|hw\s+)(?:set|group)\s*[:# ]\s*(?!for|that|numbers|should|shall|must|will|with|each|from|into|this|which|their|these|have|been|were|they|also|such|only|when|more|than|some|other|does|both|same|very|much|just|like|make|many|most|made|over|upon|after|being|under|where|added|built)([A-Z0-9][A-Z0-9.\-]{0,14})\b"  # Format 2/5: HARDWARE SET/GROUP #X (with spec-language blocklist)
    r"|"
    r"([A-Z0-9][A-Z0-9.\-]{0,14})\s+[-–—]\s+(?:hardware\s+)?set\b"  # Format 6: ID - Hardware Set
    r"|"
    r"(?<![\w.])set\s*[:#]\s*(?!up|aside|point|down|out|off|back|about|and|the|has|trim|in|on|to|of|at|it|is|as|or|an|no|so|do|if|for|are|was|not|but|all|can|had|her|one|our|new|now|way|may|any|its|let|old|see|how|two|got|use|per|too|did|get|low|run|add|own|say|she|big|end|put|top|try|ask|men|ran|set)([A-Z0-9][A-Z0-9.\-]{1,14})\b"  # Format 1/4: SET #X / SET: X (require : or #, min 2 chars, blocklist)
    r")"
)

# Pattern to detect the heading description (e.g. "Interior Single Door - Office")
HW_SET_DESC_PATTERN = re.compile(
    r"(?i)heading\s*#?\s*[A-Z0-9][A-Z0-9.\-]*\s*[-–—]\s*(.+?)(?:\(|$)"
)

# Common hardware item name patterns to validate extracted items
# Kept in sync with src/lib/hardware-taxonomy.ts
HARDWARE_ITEM_NAMES = re.compile(
    r"(?i)("
    # Hanging
    r"hinge|pivot|spring\s*hinge|continuous\s*hinge|"
    # Locking/Latching
    r"lockset|latchset|latch\s*set|lock\s*set|passage|privacy|"
    r"storeroom|classroom|entrance|office|mortise.*lock|"
    r"cylindrical|deadbolt|dead\s*bolt|night\s*latch|"
    # Exit Devices
    r"exit\s*device|panic|rim\s*device|concealed\s*vertical|"
    r"surface\s*vertical|crossbar|touch\s*bar|push\s*bar|"
    # Flush Bolts
    r"flush\s*bolt|constant\s*latching|surface\s*bolt|dust\s*proof|"
    # Strikes
    r"strike|electric\s*strike|power\s*strike|"
    # Electronic
    r"elec.*modif|electrif|power\s*transfer|ept|"
    r"wire\s*harness|connector|molex|con-\d|wiring|pigtail|"
    # Closers
    r"closer|door\s*check|floor\s*closer|"
    # Coordinators
    r"coordinator|"
    # Cylinders & Cores
    r"cylinder|core|interchangeable|"
    # Protection
    r"kick\s*plate|protection\s*plate|mop\s*plate|armor\s*plate|"
    r"wall\s*stop|floor\s*stop|overhead\s*stop|door\s*stop|holder|hold\s*open|"
    # Sweeps/Bottoms
    r"door\s*sweep|auto.*door\s*bottom|drop\s*seal|door\s*bottom|"
    # Thresholds
    r"threshold|saddle|"
    # Sealing
    r"gasket|smoke\s*seal|gasketing|acoustic\s*seal|weatherstrip|"
    r"perimeter\s*seal|sound\s*seal|"
    # Rain Drip / Astragal
    r"rain\s*drip|drip\s*cap|astragal|meeting\s*stile|"
    # Silencers
    r"silencer|bumper|mute|"
    # By Others / Special
    r"by\s*others|hardware\s*by\s*others|not\s*in\s*contract|"
    r"not\s*used|no\s*hardware|"
    # Misc common items
    r"pull|push|plate|lever|knob|key|magnetic|roller|catch"
    r")"
)


# ─── BUG-12: Field-splitting constants ────────────────────────────────────────
# Manufacturer abbreviation → full name (from data analysis of all 5 golden baselines).
# Augmented at runtime by PDF reference codes (code_type == "manufacturer").
MANUFACTURER_CODES: dict[str, str] = {
    "IV": "Ives",
    "SC": "Schlage",
    "ZE": "Zero International",
    "LC": "LCN",
    "AB": "ABH",
    "ABH": "ABH",
    "VO": "Von Duprin",
    "NA": "National Guard Products",
    "ME": "Medeco",
    "BE": "Best",
    "GL": "Glynn-Johnson",
    "AC": "Accurate",
    "BO": "Bobrick",
    "RO": "Rockwood",
    "ROC": "Rockwood",
    "DM": "Dorma",
    "MK": "McKinney",
    "YA": "Yale",
    "SA": "Sargent",
    "PE": "Pemko",
    "RI": "RIXSON",
    "SE": "Securitron",
    "HE": "HES",
    "AD": "Adams Rite",
    "LO": "Locknetics",
    "HA": "Hager",
    "KN": "Knape & Vogt",
    "RX": "RIXSON",
    "DO": "Dorma",
    "SU": "Sugatsune",
    "EF": "Effector",
    "IN": "Ingersoll Rand",
}

# Tokens that appear in last position but are NOT manufacturer codes.
NOT_MANUFACTURER_CODES: set[str] = {
    "RH", "LH", "RHR", "LHR", "RHRA", "RHA", "LHA",
    "MISC", "B/O'S", "B/O\u2019S",
    "HIMM", "SUPPLIER",
}

# Finish code patterns — conservative, only matches known formats.
FINISH_CODE_PATTERN = re.compile(
    r"^("
    r"\d{3}[A-Z]?"          # 3-digit numeric: 626, 652, 628, 630, 689
    r"|US\d{2}[A-Z]?"       # US-prefix: US32D, US26D, US28
    r"|SP\d{2,3}"           # SP-prefix: SP28, SP313
    r"|Z\d{2}"              # Z-prefix: Z49
    r"|AL"                  # Aluminum
    r"|GRY"                 # Grey
    r"|BK"                  # Black
    r"|BSP"                 # Black Suede Powder
    r"|S4"                  # Hager finish code
    r"|CLR"                 # Clear
    r"|DKB"                 # Dark Bronze
    r")$",
    re.IGNORECASE,
)

# Tokens that look like finish codes but aren't (dimensions, model suffixes).
NOT_FINISH_PATTERN = re.compile(
    r"^\d+['\"\u201d\u2033]"   # Dimensions: 36", 84", 108", 25'
    r"|^CON-\w+"               # Connector model suffixes: CON-6W, CON-38P
    r"|^\d+FP$"                # Model suffixes like 60FP
)

# ─── Base series extraction ─────────────────────────────────────────────────

# Size indicator pattern — matches dimensions like "4 1/2 x 4 1/2", "36\"", "83\""
_SIZE_PATTERN = re.compile(
    r"^\d+[\-\s]?\d*/?\d*\s*[x×X]\s*\d+"  # WxH: "4 1/2 x 4 1/2", "4x4"
    r"|^\d+['\"\u2033\u201d]"               # Length: 36", 83", 108"
    r"|^\d+\-\d+/\d+"                       # Fraction: 4-1/2
)

# Known manufacturer-specific base series patterns.
# Order matters — more specific patterns first.
_BASE_SERIES_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    # Schlage L-series: L + 4 digits (L9010, L9040, L9080, L9092)
    ("schlage", re.compile(r"^(L\d{4})", re.IGNORECASE)),
    # Von Duprin: 2-digit series (98, 99, 22, 88, 55, 78, 75, 94, 95, 33, 35)
    ("von duprin", re.compile(r"^(\d{2})(?:EO|NL|L|TP|DT|-|$|\s)", re.IGNORECASE)),
    # LCN: 4-digit model with optional suffix (4040XP, 4041, 1460, 9542, 4640)
    ("lcn", re.compile(r"^(\d{4}[A-Z]*)", re.IGNORECASE)),
    # Sargent: 2-4 digit model (8200, 8800, 11 line, 28, 482)
    ("sargent", re.compile(r"^(\d{2,4})", re.IGNORECASE)),
    # Corbin Russwin: ML or CL + 4 digits (ML2000, CL3300)
    ("corbin russwin", re.compile(r"^([MC]L\d{4})", re.IGNORECASE)),
    # Adams Rite: 4-digit model (4900, 8800, 7400, 4300)
    ("adams rite", re.compile(r"^(\d{4})", re.IGNORECASE)),
    # Securitron: Letter + 2-3 digits (M32, M62, M82)
    ("securitron", re.compile(r"^([A-Z]\d{2,3})", re.IGNORECASE)),
    # dormakaba / Dorma: 4-digit model (8600, 8900, 7400)
    ("dorma", re.compile(r"^(\d{4})", re.IGNORECASE)),
    ("dormakaba", re.compile(r"^(\d{4})", re.IGNORECASE)),
    # Norton: 4-digit model (7500, 1600, 8000)
    ("norton", re.compile(r"^(\d{4})", re.IGNORECASE)),
]


def extract_base_series(model: str, manufacturer: str) -> str:
    """Extract the base product family identifier from a model string.

    The base series is the leading identifier that maps to a single cut sheet.
    For example:
      "5BB1 HW 4 1/2 x 4 1/2 NRP 652"  → "5BB1"
      "L9010 03N LH 626"                → "L9010"
      "4040XP RWPA TBWMS AL"            → "4040XP"
      "99EO-F 3' US26D"                 → "99"

    Args:
        model: The model string (already split from name/finish/manufacturer).
        manufacturer: The manufacturer name or abbreviation.

    Returns:
        The base series string, or empty string if extraction fails.
    """
    model = model.strip()
    if not model:
        return ""

    mfr_lower = manufacturer.lower()

    # Try manufacturer-specific patterns first
    for mfr_key, pattern in _BASE_SERIES_PATTERNS:
        if mfr_key in mfr_lower:
            m = pattern.match(model)
            if m:
                return m.group(1).upper()

    # Generic fallback: first token that contains alphanumeric chars
    # and is not a pure size indicator
    tokens = model.split()
    for tok in tokens:
        if _SIZE_PATTERN.match(tok):
            continue
        # Must contain at least one alphanumeric character
        if re.search(r"[A-Za-z0-9]", tok):
            # Strip trailing hyphens/punctuation
            cleaned = re.sub(r"[\-,;:]+$", "", tok)
            if cleaned:
                return cleaned.upper()

    return ""


# Non-hardware item patterns — used to filter garbage from extraction.
NON_HARDWARE_PATTERN = re.compile(
    r"^(Single Door|Pair Doors|Opening\b|Properties:|Notes:|Description:)"  # Non-items
    r"|(?:REVISED|CHECKED|REVIEWED)\s+BY:"                # Revision stamps
    r"|_{5,}"                                              # Section dividers
    r"|^(January|February|March|April|May|June|July|August|September|October|November|December)\b"
    r"|^Wiring Diagram\b"                                  # Reference diagrams
    r"|^(Door\s+(normally|remains|nor\b)|Free to egress|Presenting valid)"  # Door operation descriptions
    r"|,.*," # Multiple commas = sentence, not hardware name
    , re.IGNORECASE
)
SENTENCE_FRAGMENT_PATTERN = re.compile(
    r"\b(does not|which is|as follows|please verify|we have|have schedule"
    r"|the floor|this is|it may|if used|are not|all hardware|for pricing"
    r"|as noted|as scheduled|added where|and do not|and removed|was made"
    r"|are entry|bolt should|closer are|set for|may be|is required"
    r"|is a similar|provide new|for a single|for a double|or combination"
    r"|un-occupied|both sides|from either|concealed vertical"
    r"|omits these|pairs, as is|not to be us|sized rated|on non-rated"
    r"|the flushbolts|egress pa|security v|verify this|nomenclatu"
    r"|connect yes|have schedule"
    r"|there are many|prior to t|ation of the|way of"
    r"|card reader unlocks"
    r"|locked\s*w\s*hen|latc\s*hed|crede\s*ntial|tim\s*es\."  # Garbled OCR fragments
    r"|to egress"
    r"|to\s+co\s*nfir|GC\s+to\s+|architect\s+to\s+"   # Project notes
    r"|all\s+restroom\s+locks|with\s+occupancy"
    r"|during\s+emergenc|access\s+in\s+during)\b",
    re.IGNORECASE,
)

# Words that continue a hardware item name (multi-word names like
# "Mortise Privacy Set", "Auto Door Bottom", "Flush Bolt Kit").
# Used to find the boundary between item name and model number.
NAME_CONTINUATION_WORDS: set[str] = {
    "set", "lock", "plate", "bolt", "device", "bottom", "hinge",
    "stop", "holder", "sweep", "drip", "seal", "reader", "position",
    "transfer", "harness", "core", "sensor", "operator", "kit",
    "latch", "latchset", "deadbolt",
}
# ─── End BUG-12 constants ─────────────────────────────────────────────────────


def detect_column_mapping(headers: list[str]) -> dict[str, int]:
    """
    Given a list of column headers, return a mapping of
    field_name -> column_index for Opening List fields.

    Uses keyword scoring instead of rigid regex — handles "Hdw Set",
    "HW Set", "Hardware Set", "Opening", "Door No.", etc. without
    needing to enumerate every variant.
    """
    fields = list(COLUMN_KEYWORDS.keys())
    mapping: dict[str, int] = {}
    used_columns: set[int] = set()

    # Phase 1: Score every header against every field
    # Build a list of (score, field, col_index) and assign greedily
    candidates: list[tuple[float, str, int]] = []

    for i, header in enumerate(headers):
        if not header or not header.strip():
            continue
        for field in fields:
            score = score_header_for_field(header, field)
            if score >= 0.3:  # minimum threshold
                candidates.append((score, field, i))

    # Sort by score descending — best matches assigned first
    candidates.sort(key=lambda x: -x[0])

    for score, field, col_idx in candidates:
        if field in mapping or col_idx in used_columns:
            continue
        mapping[field] = col_idx
        used_columns.add(col_idx)

    # Phase 2: Positional inference for unmapped columns
    # If we have door_number but are missing other fields, try to infer
    # from standard column order (door_number, hw_set, hw_heading, location,
    # door_type, frame_type, fire_rating, hand)
    if "door_number" in mapping and len(mapping) < len(headers):
        door_col = mapping["door_number"]
        # Map remaining headers by position relative to door_number
        for offset, field in enumerate(STANDARD_COLUMN_ORDER):
            col_idx = door_col + offset
            if field not in mapping and col_idx < len(headers) and col_idx not in used_columns:
                # Only assign if header isn't obviously wrong (e.g., empty or numeric)
                h = (headers[col_idx] or "").strip()
                if h and not re.match(r"^\d+$", h):
                    # Check that this header has at least minimal relevance
                    best_score = score_header_for_field(h, field)
                    if best_score >= 0.15:  # very low bar for positional inference
                        mapping[field] = col_idx
                        used_columns.add(col_idx)

    return mapping


def is_opening_list_table(headers: list[str]) -> bool:
    """
    Determine if a table is likely an Opening List based on headers.
    Must have at least a door number column and one secondary field.
    """
    mapping = detect_column_mapping(headers)
    has_door = "door_number" in mapping
    has_secondary = (
        "hw_set" in mapping
        or "hw_heading" in mapping
        or "location" in mapping
    )
    return has_door and has_secondary


# ── Content-Based Structural Table Detection ──────────────────────────
# When headers don't match keywords (e.g., "DOOR INDEX" instead of
# "Opening List"), identify columns by analyzing the DATA itself.
# A column of values like 001.01.A.01A is door numbers regardless
# of what the header says.

# Known handing abbreviations (closed set)
_HAND_VALUES = frozenset({
    "LH", "RH", "LHR", "RHR", "LHRA", "RHRA",
    "LH/LHR", "RH/RHR", "RHRA/LHR", "LHRA/RHR",
    "RHR/LHR", "LHR/RHR",
    "IN", "OUT", "LEFT", "RIGHT",
})


def _is_hw_set_value(val: str) -> bool:
    """Check if a value looks like a hardware set/heading ID (short alphanumeric code)."""
    v = val.strip()
    if not v or len(v) > 20 or len(v) < 1:
        return False
    # Must contain at least one digit (pure text like "John" is not a set ID)
    if not re.search(r"\d", v):
        return False
    # Must be a compact code (alphanumeric + separators, no spaces)
    if " " in v:
        return False
    # Match typical set ID patterns: SSE1XL1, E2-XL.2, I1-B3, 13.0
    return bool(re.match(r"^[A-Z0-9][A-Z0-9.\-:]{0,19}$", v, re.IGNORECASE))


def _is_fire_rating_value(val: str) -> bool:
    """Check if a value looks like a fire rating."""
    v = val.strip().upper()
    return bool(re.match(
        r"^(\d{2,3}\s*MIN|[0-9.]+\s*HR|RATED|[ABC]|N/?A|NONE|NR|--|-|20|45|60|90|120|180)$",
        v,
    ))


def score_column_by_values(cells: list[str], field: str) -> float:
    """
    Score how well a column's actual cell VALUES match expected patterns
    for a field type. Returns 0.0–1.0.

    This is the core of structural detection — instead of checking what
    the header SAYS, check what the data LOOKS LIKE.
    """
    non_empty = [c.strip() for c in cells if c and c.strip()]
    if len(non_empty) < 3:
        return 0.0

    validators = {
        "door_number": lambda v: is_valid_door_number(v),
        "hw_set": _is_hw_set_value,
        "hw_heading": _is_hw_set_value,
        "hand": lambda v: v.strip().upper() in _HAND_VALUES,
        "fire_rating": _is_fire_rating_value,
        "location": lambda v: len(v) > 8 and " " in v,
        "door_type": lambda v: bool(re.match(r"^[A-Z]{1,5}[-]?[A-Z0-9]*$", v)) and len(v) <= 10,
        "frame_type": lambda v: bool(re.match(r"^[A-Z]{1,5}[-]?[A-Z0-9]*$", v)) and len(v) <= 10,
    }

    validator = validators.get(field)
    if not validator:
        return 0.0

    matches = sum(1 for c in non_empty if validator(c))
    return matches / len(non_empty)


def detect_table_by_content(
    table: list[list[str | None]],
    min_data_rows: int = 8,
) -> tuple[dict[str, int], int] | None:
    """
    Identify opening list columns by analyzing cell VALUE patterns, not headers.

    When header-keyword detection fails (e.g., table says "DOOR INDEX"
    instead of "Opening List"), this function examines the actual data
    to recognize door numbers, set IDs, handing, etc. by their structural
    patterns.

    Uses strict thresholds to avoid false positives on hardware set pages
    or reference tables that may contain a few door-number-like values.

    Returns (column_mapping, header_row_index) or None.
    """
    if not table or len(table) < min_data_rows + 1:
        return None

    # Try each of the first 3 rows as the potential header
    for header_idx in range(min(3, len(table))):
        data_rows = table[header_idx + 1:]
        if len(data_rows) < min_data_rows:
            continue

        n_cols = max(len(row) for row in data_rows[:30])
        if n_cols < 2:
            continue

        # Score each column against each field type using value patterns
        fields = ["door_number", "hw_set", "hw_heading", "hand",
                  "fire_rating", "location", "door_type", "frame_type"]
        candidates: list[tuple[float, str, int]] = []

        # Strict thresholds for content-based detection:
        # door_number needs 50%+ match rate (real door lists have 90%+)
        # Other fields need 30%+ match rate
        field_thresholds = {
            "door_number": 0.5,
            "hw_set": 0.3,
            "hw_heading": 0.3,
            "hand": 0.4,
            "fire_rating": 0.3,
            "location": 0.3,
            "door_type": 0.3,
            "frame_type": 0.3,
        }

        for col_idx in range(n_cols):
            col_values = []
            for row in data_rows[:30]:
                val = clean_cell(row[col_idx]) if col_idx < len(row) else ""
                if val:
                    col_values.append(val)

            if len(col_values) < 5:
                continue

            for field in fields:
                score = score_column_by_values(col_values, field)
                threshold = field_thresholds.get(field, 0.3)
                if score >= threshold:
                    candidates.append((score, field, col_idx))

        if not candidates:
            continue

        # Greedy assignment: highest scores first, no reuse
        candidates.sort(key=lambda x: -x[0])
        mapping: dict[str, int] = {}
        used_cols: set[int] = set()

        for score, field, col_idx in candidates:
            if field in mapping or col_idx in used_cols:
                continue
            mapping[field] = col_idx
            used_cols.add(col_idx)

        # Require door_number + a strong secondary field.
        # For content-based detection we require hw_set or hw_heading
        # (not just hand/location) to avoid matching hardware set
        # door-assignment lines which also have doors + hand + location.
        has_door = "door_number" in mapping
        has_set_column = "hw_set" in mapping or "hw_heading" in mapping

        if not (has_door and has_set_column):
            continue

        # Additional validation: count actual valid door numbers in the column
        # Require at least 5 unique valid door numbers to confirm this is
        # a real opening list, not a coincidental match
        door_col = mapping["door_number"]
        valid_doors: set[str] = set()
        for row in data_rows[:30]:
            val = clean_cell(row[door_col]) if door_col < len(row) else ""
            if val and is_valid_door_number(val):
                valid_doors.add(val.strip().upper())

        if len(valid_doors) < 5:
            continue

        # Check uniqueness: door numbers should be mostly unique
        # (unlike quantities or reference codes which repeat heavily)
        all_values = [
            clean_cell(row[door_col]).strip()
            for row in data_rows[:30]
            if door_col < len(row) and clean_cell(row[door_col]).strip()
        ]
        if all_values:
            unique_ratio = len(set(all_values)) / len(all_values)
            if unique_ratio < 0.6:
                continue

        # Also incorporate any header keyword scores for unassigned columns
        headers = [clean_cell(c) for c in table[header_idx]]
        for col_idx, header in enumerate(headers):
            if col_idx in used_cols or not header:
                continue
            for field in fields:
                if field in mapping:
                    continue
                kw_score = score_header_for_field(header, field)
                if kw_score >= 0.3:
                    mapping[field] = col_idx
                    used_cols.add(col_idx)
                    break

        return mapping, header_idx

    return None


# ── Comprehensive Mojibake Replacement Map ──────────────────────────────
# Covers Latin-1/UTF-8 confusion, Windows-1252 artifacts, CIDFont encoding
# failures, double-encoding, and ligatures from Comsense/Openings Studio PDFs.
# Sorted longest-first at runtime to avoid partial replacements.
MOJIBAKE_MAP = {
    # === Latin-1 interpreted as UTF-8 (most common in construction PDFs) ===
    "\u00c2\u00b7": "\u00b7",       # middle dot (Â· → ·)
    "\u00c3\u0097": "\u00d7",       # multiplication sign (Ã— → ×)
    "\u00c3\u00b7": "\u00f7",       # division sign
    "\u00c2\u00bd": "\u00bd",       # one half (Â½ → ½)
    "\u00c2\u00bc": "\u00bc",       # one quarter (Â¼ → ¼)
    "\u00c2\u00be": "\u00be",       # three quarters (Â¾ → ¾)
    "\u00c2\u00ae": "\u00ae",       # registered (Â® → ®)
    "\u00c2\u00a9": "\u00a9",       # copyright (Â© → ©)
    "\u00c2\u00b0": "\u00b0",       # degree (Â° → °)
    "\u00e2\u0080\u0093": "\u2013", # en dash (â€" → –)
    "\u00e2\u0080\u0094": "\u2014", # em dash (â€" → —)
    "\u00e2\u0080\u0099": "\u2019", # right single quote (â€™ → ')
    "\u00e2\u0080\u0098": "\u2018", # left single quote (â€˜ → ')
    "\u00e2\u0080\u009c": "\u201c", # left double quote (â€œ → ")
    "\u00e2\u0080\u009d": "\u201d", # right double quote (â€ → ")
    "\u00e2\u0080\u00a2": "\u2022", # bullet (â€¢ → •)
    "\u00e2\u0080\u00a6": "\u2026", # ellipsis (â€¦ → …)
    "\u00e2\u0080": "\u2014",       # partial em dash (truncated â€ → —)
    "\u00c3\u00a0": "\u00e0",       # à
    "\u00c3\u00a4": "\u00e4",       # ä
    "\u00c3\u00a8": "\u00e8",       # è
    "\u00c3\u00a9": "\u00e9",       # é
    "\u00c3\u00ad": "\u00ed",       # í
    "\u00c3\u00b3": "\u00f3",       # ó
    "\u00c3\u00b6": "\u00f6",       # ö
    "\u00c3\u00ba": "\u00fa",       # ú
    "\u00c3\u00bc": "\u00fc",       # ü
    "\u00c3\u00b1": "\u00f1",       # ñ
    "\u00c3\u00a7": "\u00e7",       # ç (c-cedilla)
    "\u00c2\u00a0": " ",            # NBSP artifact (Â  → space)

    # === Windows-1252 specific ===
    "\x91": "\u2018",   # left single quote
    "\x92": "\u2019",   # right single quote
    "\x93": "\u201c",   # left double quote
    "\x94": "\u201d",   # right double quote
    "\x95": "\u2022",   # bullet
    "\x96": "\u2013",   # en dash
    "\x97": "\u2014",   # em dash
    "\x85": "\u2026",   # ellipsis
    "\x99": "\u2122",   # trademark
    "\xa0": " ",         # NBSP

    # === Double-encoding artifacts ===
    "\u00c3\u00a2\u00e2\u201a\u00ac\u00e2\u20ac\u0153": "\u2013", # double-encoded en dash
    "\u00c3\u00a2\u00e2\u201a\u00ac\u00e2\u20ac":       "\u2014", # double-encoded em dash
    "\u00c3\u00a2\u00e2\u201a\u00ac\u00c2\u00a2":       "\u2022", # double-encoded bullet
    "\u00c3\u00a2\u00e2\u201a\u00ac\u00c5\u201c":       "\u201c", # double-encoded left quote
    "\u00c3\u00a2\u00e2\u201a\u00ac\u0178":              "\u201d", # double-encoded right quote

    # === CIDFont encoding artifacts (Comsense / Openings Studio) ===
    "\u00e0\u2016": "\u2013",  # CID en dash
    "\u00e0\u00a1": "!",
    "\u00e0\u00a2": "\"",
    "\u00e0\u00a8": "(",
    "\u00e0\u00a9": ")",
    "\u00e0\u00ab": "+",
    "\u00e0\u00ac": ",",
    "\u00e0\u00ad": "-",
    "\u00e0\u00ae": ".",
    "\u00e0\u00af": "/",
    "\u00e0\u00ba": ":",

    # === PDF ligature codepoints ===
    "\ufb01": "fi",
    "\ufb02": "fl",
    "\ufb00": "ff",
    "\ufb03": "ffi",
    "\ufb04": "ffl",
}
# Pre-sort keys longest-first so longer sequences match before their prefixes
_MOJIBAKE_SORTED = sorted(MOJIBAKE_MAP.keys(), key=len, reverse=True)


def clean_cell(val) -> str:
    """Clean a cell value, handling None, whitespace, and mojibake characters."""
    if val is None:
        return ""
    s = str(val).strip()
    if not s:
        return ""

    # Apply mojibake map (longest match first to avoid partial replacements)
    for bad in _MOJIBAKE_SORTED:
        if bad in s:
            s = s.replace(bad, MOJIBAKE_MAP[bad])

    # Normalize Unicode to NFKC form (compatibility decomposition + canonical composition)
    # Catches ligatures (fi→fi), width variants, superscripts, fractions at source
    s = unicodedata.normalize("NFKC", s)
    # Strip non-printable control characters (keep newline/tab)
    s = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", "", s)
    # Remove (cid:XX) artifacts from CIDFont failures
    s = re.sub(r"\(cid:\d+\)", "", s)
    # Strip double vertical bar (‖) that appears in garbled headings
    s = s.replace("\u2016", " ").replace("\u2551", " ")
    # Collapse multiple spaces from replacements
    s = re.sub(r"  +", " ", s).strip()
    # Strip trailing em-dashes, en-dashes, and regular dashes that are
    # artifacts of table-cell extraction (e.g. "1.01.A.06A—" → "1.01.A.06A")
    s = s.rstrip("\u2014\u2013\u2012-")
    return s


# ── Door Number Validation ───────────────────────────────────────────────
# Real-world commercial door numbering conventions:
#   Numeric only:      101, 1001, 2145
#   Letter prefix:     A101, B2145, L1-101, N101, S201
#   Floor/area prefix: 1-101, 2A-201, B1-101
#   With letter suffix: 101A, 2145B (pair doors)
#   Room-based:        101.1, 101.2 (multiple doors in same room)
#   Dash-separated:    A-101, B-201, 1-101
#   Compound:          1.01.A.01A, 2.01.F.06E, ER-ADJ9.8-94

# Positive patterns: what IS a door number
DOOR_NUMBER_PATTERNS = [
    # Core: letter prefix + optional area digit + separator + room number
    # Requires at least a prefix OR separator to avoid matching bare numbers
    r'^[A-Z]{1,2}\d?[-.]?[A-Z]?\d{2,4}[A-Z]?(?:\.\d{1,2})?$',
    # Floor-area-room: 1-101, 2A-201, B1-101
    r'^[A-Z]?\d[A-Z]?[-]\d{2,4}[A-Z]?$',
    # Multi-digit-dash-multi-digit: 110-01, 110-01A, 120-02A, 110A-04A
    r'^\d{2,4}[A-Z]?[-]\d{2,4}[A-Z]?$',
    # Multi-letter suffix on floor-room doors: 10-03AB, 09-04AA
    # Prefix limited to 2-3 digits (floor numbers) to avoid matching product models like 4040-18TJ
    r'^\d{2,3}[-]\d{2,4}[A-Z]{2,3}$',
    # Revision suffix: 10-82A.R1M, 10-82B.R1M
    r'^\d{2,4}[-]\d{2,4}[A-Z]\.[A-Z]\d[A-Z]$',
    # REV-embedded door numbers: 09-15AREV1 (after space normalization)
    r'^\d{2,4}[-]\d{2,4}[A-Z]{0,3}REV\d?$',
    # Simple numeric: 101, 1001 (3-4 digits, optionally with letter suffix)
    # Bare 2-digit numbers (20, 94) are quantities/page numbers, not doors
    r'^\d{3,4}[A-Z]?$',
    # Letter prefix: A101, B2145, N101
    r'^[A-Z]{1,2}\d{2,4}[A-Z]?$',
    # Period-separated sub-doors: 101.1, A101.2
    r'^[A-Z]?\d{2,4}\.\d{1,2}$',
    # 3-segment with alphanumeric middle: 10.E1.03, 10.N2.01A, 5.B2.14
    r'^\d{1,3}\.[A-Z]\d{1,3}\.\d{2,4}[A-Z]?$',
    # Compound dot-separated (4-segment): 1.01.A.01A, 2.01.F.06E
    r'^\d+\.\d+\.[A-Z]\.\d+[A-Z]?$',
    # Prefix-dash-digits: ST-100, ER-ADJ9.8-94
    r'^[A-Z]{1,4}[-]\w+$',
]

# Negative patterns: what is NOT a door number (hardware set IDs)
HARDWARE_SET_PATTERNS = [
    r'^[A-Z]{2,}[-]?\d{1,2}[A-Z]?$',   # DCB2, DH1, HM1, HW3, AA1
    r'^(?:SET|HS|HW|DH|DCB|HM|HMS)\b',  # SET A, HS-1, HW3, DH1, DCB2
    r'^[A-Z]{3,}\d?$',                   # Pure letter codes: ABC, EXIT, STOR
    r'^\d{1}[A-Z]$',                     # Single digit + letter: 1A, 2B (too short)
    r'^(?:EXIT|STOR|ELEC|MECH)[-]?\d*$', # Zone codes (without location prefixes)
    r'^L\d{3,5}$',                       # S-065: Schlage lock models (L464, L9175, L9460)
    r'^[A-Z]{2}[-]\d{3,}$',             # S-065: Core/product codes (CC-993, PC-123)
]

# Explicit blocklist for known hardware set prefixes
HARDWARE_SET_PREFIXES = frozenset({
    'DH', 'DCB', 'HM', 'HMS', 'HW', 'HS', 'HD', 'FH', 'AH',
    'SET', 'TYPE', 'GRP', 'GROUP', 'STYLE',
    'PT', 'GF', 'LCN', 'VON',  # Product code prefixes from cut sheets
    'L',  # Schlage lockset models (L9175, L9460, L464, etc.)
    'C0',  # Catalog/product prefix codes (C01511, C01541)
})

# Location prefixes that ARE valid door number prefixes (Task 3 / S-045)
# ST-1 (stair door 1) should NOT be rejected as a hardware set ID.
DOOR_LOCATION_PREFIXES = frozenset({
    'ST', 'STAIR', 'EL', 'ELEV', 'EX', 'EXT', 'EY', 'EN',
    'ENTRY', 'CORR', 'VEST', 'LOBBY',
})

# "No Hardware" set ID values (Task 4 / S-045)
# Openings with these set IDs are marked by_others=True instead of
# creating phantom hardware sets.
NO_HARDWARE_VALUES = frozenset({
    'NH', 'N/A', 'NA', 'NIC', 'BY OTHERS', 'BY OTHER', 'EXIST', 'EXISTING',
    'EXIST HW', 'NO HW', 'NO HARDWARE', 'NONE', 'NOT USED',
    '--', '\u2014', '\u2013', '',
})


def is_valid_door_number(val: str, log_rejections: bool = False) -> bool:
    """
    Validate whether a string is a plausible commercial door number.
    Returns True for door numbers, False for hardware set IDs and garbage.

    Valid:   101, A101, 1-101, B1-101, 101A, 101.1, 2A-201, ST-100,
             1.01.A.01A, 110-01C, ER-ADJ9.8-94
    Invalid: DCB2, DH1, HW3, SET A, AA, 94, 4, MCA1-2-, #2.01.A.14
    """
    if not val or not isinstance(val, str):
        return False

    clean = val.strip().upper()

    # Normalize revision designator: "09-15A REV1" → "09-15AREV1"
    # pdfplumber sometimes inserts a space before REV in door numbers.
    clean = re.sub(r'\s+(?=REV\d?$)', '', clean)

    # Reject empty or extreme lengths
    if len(clean) < 2 or len(clean) > 15:
        if log_rejections:
            print(f"[DOOR_VALIDATION] Rejected '{val}': length {len(clean)}")
        return False

    # Reject common non-door text values
    if clean.lower() in ("total", "totals", "note", "notes", "cont", "continued",
                          "qty", "quantity", "n/a", "none", "see", "above", "below"):
        return False
    if clean.startswith("NOTE:") or clean.startswith("*") or clean.startswith("#"):
        return False

    # Reject measurements, decimals, and product code markers
    if clean.startswith(".") or clean.startswith("-"):
        return False
    if any(c in clean for c in ('"', "'", '*', '(', ')', '/')):
        return False
    if re.search(r'(?:MM|CM|IN)\b', clean):
        return False

    # Door numbers never contain spaces
    if " " in clean:
        if log_rejections:
            print(f"[DOOR_VALIDATION] Rejected '{val}': contains space")
        return False

    # Must contain at least one digit
    if not re.search(r'\d', clean):
        if log_rejections:
            print(f"[DOOR_VALIDATION] Rejected '{val}': no digits")
        return False

    # Reject trailing dash (project/document IDs like MCA1-2-)
    if clean.endswith("-"):
        return False

    # Reject phone number patterns and multi-dash numeric strings
    if re.match(r'^\d+-\d+-\d+$', clean):
        return False

    # Accept location-prefix door numbers BEFORE hardware set rejection.
    # ST-1 (stair door 1), EL-3 (elevator door 3), EX2, CORR-5 etc. would
    # otherwise be rejected by the hardware set patterns below.
    # S-065: Separator is optional — EX2, EX3 are valid (exterior doors)
    for prefix in DOOR_LOCATION_PREFIXES:
        if clean.startswith(prefix) and re.match(
            rf'^{re.escape(prefix)}[-.]?\d{{1,4}}[A-Z]?$', clean
        ):
            return True

    # Reject if it matches a hardware set pattern
    for pattern in HARDWARE_SET_PATTERNS:
        if re.match(pattern, clean, re.IGNORECASE):
            if log_rejections:
                print(f"[DOOR_VALIDATION] Rejected '{val}': matches HW set pattern {pattern}")
            return False

    # Reject known hardware set prefixes (short codes only)
    # S-064: For single-char prefixes like 'L', only reject when followed by
    # 1-2 digits (Schlage lockset models like L9175), not 3+ digits (L101 = valid door)
    for prefix in HARDWARE_SET_PREFIXES:
        if clean.startswith(prefix):
            max_suffix = 2 if len(prefix) == 1 else 4
            if len(clean) <= len(prefix) + max_suffix:
                if log_rejections:
                    print(f"[DOOR_VALIDATION] Rejected '{val}': HW set prefix {prefix}")
                return False

    # Reject BHMA finish code ranges: "615-622", "626-630" etc.
    # Both sides are 3-digit numbers in the 600-699 range (BHMA architectural finishes).
    _finish_range = re.match(r'^(\d{3})-(\d{3})$', clean)
    if _finish_range:
        left, right = int(_finish_range.group(1)), int(_finish_range.group(2))
        if 600 <= left <= 699 and 600 <= right <= 699:
            if log_rejections:
                print(f"[DOOR_VALIDATION] Rejected '{val}': BHMA finish code range")
            return False

    # Reject leading-zero numeric strings: "0468", "0123" — product/model numbers, not doors
    if re.match(r'^0\d{2,3}[A-Z]?$', clean):
        if log_rejections:
            print(f"[DOOR_VALIDATION] Rejected '{val}': leading-zero numeric (product code)")
        return False

    # S-065: Reject values containing ANSI/BHMA finish codes (US32D, US26D, US10B, etc.)
    # These appear when table parsing concatenates a value with its finish column
    if re.search(r'US\d{1,2}[A-Z]?$', clean):
        if log_rejections:
            print(f"[DOOR_VALIDATION] Rejected '{val}': contains ANSI finish code suffix")
        return False

    # S-067: Reject standalone BHMA architectural finish codes (600-699 range).
    if re.match(r'^\d{3}$', clean):
        code = int(clean)
        if 600 <= code <= 699:
            if log_rejections:
                print(f"[DOOR_VALIDATION] Rejected '{val}': BHMA finish code (600-699)")
            return False

    # PERMISSIVE ACCEPTANCE: Accept anything that passed the blocklist checks
    # above, as long as it meets minimum structural requirements. Unusual door
    # numbering schemes should NOT be silently rejected — the consensus
    # validator and human review handle outliers downstream.
    # (DOOR_NUMBER_PATTERNS retained for documentation but no longer used as gate.)

    # Reject pure-digit strings > 4 chars (project/document numbers like 303872)
    if re.match(r'^\d{5,}$', clean):
        if log_rejections:
            print(f"[DOOR_VALIDATION] Rejected '{val}': pure numeric > 4 digits (project/doc number)")
        return False

    # Reject bare 1-2 digit numbers (quantities, page numbers, not doors)
    if re.match(r'^\d{1,2}$', clean):
        if log_rejections:
            print(f"[DOOR_VALIDATION] Rejected '{val}': bare 1-2 digit number")
        return False

    # Accept: must contain at least one digit and be within length bounds
    if len(clean) >= 2 and len(clean) <= 15:
        return True

    if log_rejections:
        print(f"[DOOR_VALIDATION] Rejected '{val}': no pattern match")
    return False


def door_number_shape(door_num: str) -> str:
    """
    Convert a door number into a structural shape string for pattern comparison.
    Replaces runs of digits with 'D', runs of letters with 'L', keeps separators.

    Examples:
        '1.01.A.01A' → 'D.D.L.DL'
        '110-01C'    → 'D-DL'
        'A-201B'     → 'L-DL'
        'ST-100'     → 'L-D'
        'DCB2'       → 'LD'
    """
    shape = ""
    prev_type = ""
    for ch in door_num:
        if ch.isdigit():
            if prev_type != "D":
                shape += "D"
                prev_type = "D"
        elif ch.isalpha():
            if prev_type != "L":
                shape += "L"
                prev_type = "L"
        else:
            # Separator character (dot, dash, etc.) — keep as-is
            shape += ch
            prev_type = ch
    return shape


def validate_door_number_consistency(
    doors: list["DoorEntry"],
    min_doors_for_consensus: int = 5,
    outlier_threshold: float = 0.15,
) -> tuple[list["DoorEntry"], list["FlaggedDoor"]]:
    """
    Post-extraction consensus check. Analyzes structural patterns of all extracted
    door numbers and flags outliers that don't match the dominant pattern(s).

    Returns (confirmed_doors, flagged_doors) where flagged_doors are candidates
    for user review — they are NOT silently removed.

    Args:
        doors: Extracted door entries.
        min_doors_for_consensus: Minimum doors needed to establish a pattern consensus.
            Below this threshold, all doors pass through without flagging.
        outlier_threshold: A pattern must appear in at least this fraction of doors
            to be considered "dominant". Patterns below this are outlier candidates.
    """
    if len(doors) < min_doors_for_consensus:
        return doors, []

    # Classify each door number into a shape
    shape_map: dict[str, list[int]] = {}  # shape → list of indices
    for idx, door in enumerate(doors):
        shape = door_number_shape(door.door_number)
        shape_map.setdefault(shape, []).append(idx)

    # Find dominant pattern(s) — those that appear in a significant portion of doors.
    # A pattern is dominant if it has ≥ outlier_threshold fraction AND at least 3
    # instances (to prevent tiny groups of garbage from masquerading as patterns).
    total = len(doors)
    dominant_shapes: set[str] = set()
    for shape, indices in shape_map.items():
        count = len(indices)
        fraction = count / total
        if fraction >= outlier_threshold and count >= 3:
            dominant_shapes.add(shape)

    # If no clear dominant pattern (very mixed document), don't flag anything
    if not dominant_shapes:
        return doors, []

    # Find the single most common pattern for display purposes
    most_common_shape = max(shape_map.keys(), key=lambda s: len(shape_map[s]))

    confirmed: list[DoorEntry] = []
    flagged: list[FlaggedDoor] = []

    for idx, door in enumerate(doors):
        shape = door_number_shape(door.door_number)
        if shape in dominant_shapes:
            confirmed.append(door)
        else:
            flagged.append(FlaggedDoor(
                door=door,
                reason=f"Pattern '{shape}' doesn't match dominant pattern(s) "
                       f"({', '.join(sorted(dominant_shapes))}). "
                       f"May be a hardware set ID, reference code, or extraction artifact.",
                pattern=shape,
                dominant_pattern=most_common_shape,
            ))

    return confirmed, flagged


# --- Hardware Set Extraction ---

def is_hardware_set_page(text: str) -> bool:
    """Check if a page likely contains hardware set definitions."""
    return bool(HW_SET_HEADING_PATTERN.search(text))


def parse_hw_set_id_from_text(text: str) -> tuple[str, str, str]:
    """
    Extract heading ID, generic set ID, and description from page text.
    Returns (heading_id, generic_set_id, heading_description).

    For "Heading #I2S-1E:WI (Set #I2S-1E)":
      heading_id = "I2S-1E:WI", generic_set_id = "I2S-1E"
    For "Hardware Set DH1":
      heading_id = "DH1", generic_set_id = "DH1"
    """
    m = HW_SET_HEADING_PATTERN.search(text)
    if not m:
        return ("", "", "")

    # Reject if the match is inside a numbered list item (e.g., "33. HW Set EL-XL1").
    # These are notes that reference set IDs, not actual hardware set headings.
    match_line = text[max(0, text.rfind("\n", 0, m.start()) + 1): m.end()]
    if re.match(r"\d+\.\s", match_line.lstrip()):
        return ("", "", "")

    # Group 1 = heading ID from "Heading #X (Set #Y)" (includes :1/.PR4 suffix)
    # Group 2 = generic set ID from same format (from parenthetical)
    # Group 3 = set ID from "Heading #: ID" (ESC/AKN format)
    # Group 4 = set ID from "HARDWARE SET/GROUP #X" format
    # Group 5 = set ID from "ID - Hardware Set" format (ID-first)
    # Group 6 = set ID from "SET #X" / "SET: X" format (bare set)
    heading_id = ""
    generic_set_id = ""

    if m.group(1) and m.group(2):
        # "Heading #I2S-1E:WI (Set #I2S-1E)" → heading=I2S-1E:WI, generic=I2S-1E
        heading_id = m.group(1).strip()
        generic_set_id = m.group(2).strip()
    elif m.group(3):
        # "Heading #: E1-XL.1" (ESC/AKN format)
        heading_id = m.group(3).strip()
        generic_set_id = m.group(3).strip()
    elif m.group(4):
        # "HARDWARE SET DH1" / "HW GROUP 04"
        heading_id = m.group(4).strip()
        generic_set_id = m.group(4).strip()
    elif m.group(5):
        # "04 - Hardware Set" (ID-first format)
        heading_id = m.group(5).strip()
        generic_set_id = m.group(5).strip()
    elif m.group(6):
        # "SET #04" / "SET: AD2"
        heading_id = m.group(6).strip()
        generic_set_id = m.group(6).strip()
    elif m.group(1):
        # Heading number only (fallback)
        heading_id = m.group(1).strip()
        generic_set_id = m.group(1).strip()

    # Try to extract the heading description
    heading = ""
    lines = text.split("\n")
    for line in lines:
        if HW_SET_HEADING_PATTERN.search(line):
            # ESC/AKN format: "Heading #: ID DESCRIPTION" — strip prefix + ID
            esc_match = re.match(
                r"(?i)heading\s*#:\s*([A-Z0-9][A-Z0-9.\-]*)\s+(.*)",
                line,
            )
            if esc_match:
                heading = esc_match.group(2).strip()
                break
            # Try to extract description after dash
            dash_match = re.search(
                r"(?:heading\s*#?\s*[A-Z0-9][A-Z0-9.\-:]*)\s*[-–—]\s*(.+?)(?:\(|$)",
                line, re.IGNORECASE
            )
            if dash_match:
                heading = dash_match.group(1).strip()
            else:
                # Use the full line as heading, cleaned up
                heading = re.sub(
                    r"(?i)(?:heading|set)\s*#?\s*[A-Z0-9][A-Z0-9.\-:]*\s*[-–—:]\s*",
                    "", line
                ).strip()
                # Remove trailing "(Set #...)" if present
                heading = re.sub(r"\(set\s*#?\s*[A-Z0-9][A-Z0-9.\-]*\)\s*$", "", heading, flags=re.IGNORECASE).strip()
            break

    # Defensive: reject heading descriptions that look like numbered list items
    # (e.g. "5. Tags 110A-02B, 110A-03B: ..."). These come from body content lines
    # that happened to match HW_SET_HEADING_PATTERN due to an embedded ID.
    if heading and re.match(r"^\d+\.\s", heading):
        heading = ""

    return (heading_id, generic_set_id, heading)


# Pattern to count doors listed in heading block.
# Matches: "1 Pair Doors #...", "For 2 Single Doors", "Qty: 3 Pair Door Openings",
#           "1 - Pair Doors #..."
HEADING_DOOR_LINE = re.compile(
    r"(?:For\s+|Qty[:\s]+)?(\d+)\s*[-–]?\s*(Pair|Single)\s+Doors?\s*"
    r"(?:Opening)?s?\s*(?:#|$)",
    re.IGNORECASE,
)

# BUG-25: Pattern to extract door numbers from heading block lines.
# Captures: qty, type (Pair/Single), and the door number after #.
HEADING_DOOR_WITH_NUMBER = re.compile(
    r"(?:For\s+|Qty[:\s]+)?(\d+)\s*[-–]?\s*(Pair|Single)\s+Doors?\s*"
    r"(?:Opening)?s?\s*#\s*(\S+)",
    re.IGNORECASE,
)


def count_heading_doors(page_text: str) -> tuple[int, int]:
    """
    Count doors listed in a hardware set heading block.
    Returns (opening_count, leaf_count).

    "1 Pair Doors #1.01.B.03A" → 1 opening, 2 leaves
    "1 Single Door #2.01.E.08" → 1 opening, 1 leaf

    Leaf count accounts for pair doors having 2 leaves each.
    """
    opening_count = 0
    leaf_count = 0
    for m in HEADING_DOOR_LINE.finditer(page_text):
        qty = int(m.group(1))
        is_pair = m.group(2).lower() == "pair"
        opening_count += qty
        leaf_count += qty * (2 if is_pair else 1)
    return (opening_count, leaf_count)


def extract_heading_door_numbers(section_text: str) -> list[str]:
    """
    Extract specific door numbers listed under a hardware set heading block.

    Uses HEADING_DOOR_WITH_NUMBER regex to parse lines like:
      "1 Pair Doors #110-02A  Corridor 1203 from Gallery 1"
      "1 Single Door #09-15AREV1 SOCIAL HUB"

    Returns normalized door numbers (stripped, uppercased), preserving
    insertion order and skipping duplicates.

    This is used to populate HardwareSetDef.heading_doors so that the
    TypeScript layer can match doors to specific sub-sets (e.g., DH4A.0
    vs DH4A.1) instead of collapsing them by generic_set_id.
    """
    doors: list[str] = []
    seen: set[str] = set()
    # Primary: use HEADING_DOOR_WITH_NUMBER which captures qty + type + first door
    for m in HEADING_DOOR_WITH_NUMBER.finditer(section_text):
        door_num = m.group(3).strip().rstrip(",;:").upper()
        if door_num and door_num not in seen and is_valid_door_number(door_num):
            seen.add(door_num)
            doors.append(door_num)
    # Secondary: scan for all #<door_number> patterns in the text.
    # This catches cases where multiple doors are listed on one line
    # (e.g., "5 Single Doors #1603, #1708, #1803, #2101, #2103")
    # that the primary regex only captures the first of.
    for m in re.finditer(r"#\s*(\S+)", section_text):
        door_num = m.group(1).strip().rstrip(",;:").upper()
        if door_num and door_num not in seen and is_valid_door_number(door_num):
            seen.add(door_num)
            doors.append(door_num)
    # Tertiary: ESC/AKN format "N SGL|PR|PRA/PRI Door:XXX.XX.Y.ZZ"
    for sd in _parse_specworks_door_assignments(section_text):
        door_num = sd["door_number"].upper()
        if door_num and door_num not in seen:
            seen.add(door_num)
            doors.append(door_num)
    return doors


def extract_doors_from_set_headings(pdf) -> list[DoorEntry]:
    """
    BUG-25: Extract door numbers from hardware schedule heading blocks as a
    fallback when the opening list table extraction fails or returns
    incomplete results.

    Parses lines like:
      "1 Single Door #10-12B CORR 10-90 to STOR 10-01 90° LH"
      "1 Pair Doors #09-15AREV1 SOCIAL HUB 09-13 from 9TH FLOOR"

    Returns DoorEntry objects with door_number and hw_set populated.
    The hw_set is taken from the current heading context.
    """
    doors: list[DoorEntry] = []
    seen: set[str] = set()

    for page in pdf.pages:
        text = page.extract_text() or ""
        current_set_id = ""
        for line in text.split("\n"):
            heading_match = _HEADING_LINE_PATTERN.match(line.strip())
            if heading_match:
                current_set_id = next(
                    (g for g in heading_match.groups() if g), ""
                )

            door_match = HEADING_DOOR_WITH_NUMBER.search(line)
            if door_match:
                door_num = door_match.group(3).strip().rstrip(",;:")
                if door_num and door_num not in seen and is_valid_door_number(door_num):
                    seen.add(door_num)
                    loc = ""
                    after_door = line[door_match.end(3):]
                    loc_match = re.match(
                        r"\s+(.+?)(?:\s+\d+°|\s+[LR]H[RA]?\s*$|\s*$)",
                        after_door,
                    )
                    if loc_match:
                        loc = loc_match.group(1).strip()

                    doors.append(DoorEntry(
                        door_number=door_num,
                        hw_set=current_set_id,
                        location=loc,
                    ))

    logger.info(
        f"[extract-tables] extract_doors_from_set_headings: "
        f"{len(doors)} doors from hardware schedule headings"
    )
    return doors


# Patterns for extracting door numbers from heading block text.
# Matches "For Openings: 101, 102, 103" / "Doors: 101, 102A" / "#101, #102"
_INLINE_DOOR_LIST_RE = re.compile(
    r"(?:For\s+(?:Openings?|Doors?)\s*[:\-]\s*"      # "For Openings: ..." / "For Doors: ..."
    r"|Doors?\s*[:\-]\s*"                               # "Door: ..." / "Doors: ..."
    r"|Openings?\s*[:\-]\s*"                            # "Opening: ..." / "Openings: ..."
    r"|Assigned\s+(?:to\s+)?(?:Doors?|Openings?)\s*[:\-]\s*"  # "Assigned to Doors: ..."
    r")"
    r"(.+)",
    re.IGNORECASE,
)

# Pattern for individual door numbers in a comma/space/and-separated list
# Handles: 101, 102A, 1-101, B1.03, 1.01.A.01A, 101A & 102B
_DOOR_TOKEN_RE = re.compile(
    r"#?\s*([A-Z0-9][A-Z0-9.\-]{1,14})",
    re.IGNORECASE,
)

# Pattern for doors listed after Pair/Single on heading lines:
# "1 Pair Doors #101, #102" / "2 Single Doors #103A, #104B, #105C"
_HEADING_DOOR_NUMBERS_RE = re.compile(
    r"(?:For\s+|Qty[:\s]+)?(\d+)\s*[-–]?\s*(Pair|Single)\s+Doors?\s*"
    r"(?:Opening)?s?\s*#?\s*(.+)",
    re.IGNORECASE,
)


def extract_inline_door_assignments(
    page_text: str,
    set_id: str,
    heading: str = "",
) -> list[DoorEntry]:
    """Extract door number assignments from heading block text.

    Handles multiple patterns:
    1. "N Pair/Single Doors #101, #102, #103"  (extends HEADING_DOOR_LINE)
    2. "For Openings: 101, 102, 103"
    3. "Doors: 101, 102A, 103B"
    4. SpecWorks: "1 SGL DOOR(S)3.01.H.04"  (delegates to existing parser)

    Returns DoorEntry list with hw_set pre-populated from the set heading.
    """
    doors: list[DoorEntry] = []
    seen: set[str] = set()

    def _add_door(door_number: str, door_type: str = "", hand: str = ""):
        """Add a door if valid and not duplicate."""
        dn = door_number.strip().strip("#").strip()
        if not dn or dn.upper() in seen:
            return
        if not is_valid_door_number(dn):
            return
        seen.add(dn.upper())
        doors.append(DoorEntry(
            door_number=dn,
            hw_set=set_id,
            hw_heading=heading,
            door_type=door_type,
        ))

    # Strategy 1: SpecWorks format ("N SGL DOOR(S)X.XX.Y.ZZ")
    specworks_doors = _parse_specworks_door_assignments(page_text)
    if specworks_doors:
        for sd in specworks_doors:
            _add_door(
                sd["door_number"],
                door_type="PR" if sd.get("door_type") == "PR" else "",
                hand=sd.get("hand", ""),
            )
        # Update hand if available
        for d in doors:
            match = next((sd for sd in specworks_doors if sd["door_number"] == d.door_number), None)
            if match and match.get("hand"):
                d.hand = match["hand"]
        return doors

    # Strategy 2: "N Pair/Single Doors #101, #102, #103" pattern
    for m in _HEADING_DOOR_NUMBERS_RE.finditer(page_text):
        door_type = "PR" if m.group(2).lower() == "pair" else ""
        door_list_text = m.group(3)
        for token in _DOOR_TOKEN_RE.finditer(door_list_text):
            _add_door(token.group(1), door_type=door_type)

    if doors:
        return doors

    # Strategy 3: "For Openings: 101, 102" / "Doors: 101, 102" patterns
    for m in _INLINE_DOOR_LIST_RE.finditer(page_text):
        door_list_text = m.group(1)
        for token in _DOOR_TOKEN_RE.finditer(door_list_text):
            _add_door(token.group(1))

    return doors


# Strict pattern for splitting: heading keywords at start of line only.
# The broader HW_SET_HEADING_PATTERN also matches inside item descriptions,
# which causes false splits. This pattern is deliberately stricter.
_HEADING_LINE_PATTERN = re.compile(
    r"(?i)^(?:"
    r"heading\s+#?([A-Z0-9][A-Z0-9.\-:]*)\s*\((?:hw\s*)?set"  # SpecWorks: "Heading XXX (HwSet YYY)" or Himmel: "Heading #X (Set Y)"
    r"|"
    r"heading\s+#:\s*([A-Z0-9][A-Z0-9.\-]*)"  # ESC/AKN: "Heading #: E1-XL.1"
    r"|"
    r"heading\s+#([A-Z0-9][A-Z0-9.\-:]*)"  # Bare: "Heading #X"
    r"|"
    r"(?:hardware\s+|hw\s+)(?:set|group)\s*[:#\s]\s*([A-Z0-9][A-Z0-9.\-:]*)"
    r"|"
    r"set\s*[:#]\s*([A-Z0-9][A-Z0-9.\-:]*)"
    r"|"
    r"([A-Z0-9][A-Z0-9.\-]{0,14})\s+[-\u2013\u2014]\s+(?:hardware\s+)?set\b"  # S-064: Format 6 (ID-first)
    r")",
    re.MULTILINE
)


def _split_page_at_headings(page_text: str) -> list[str]:
    """Split page text into sections, one per heading.

    Uses strict "Heading #X" pattern (not the broader HW_SET_HEADING_PATTERN)
    to avoid false splits on item lines containing "Set" or model numbers.

    Returns a list of text sections. Each starts with a Heading # line
    and contains all text up to (but not including) the next heading.
    """
    lines = page_text.split("\n")
    heading_lines = []
    for i, line in enumerate(lines):
        if _HEADING_LINE_PATTERN.match(line.strip()):
            heading_lines.append(i)

    if len(heading_lines) <= 1:
        return [page_text]

    sections = []
    for idx, start in enumerate(heading_lines):
        end = heading_lines[idx + 1] if idx + 1 < len(heading_lines) else len(lines)
        sections.append("\n".join(lines[start:end]))
    return sections


# --- SpecWorks / Kinship Format Parsers ---

# SpecWorks item line: "( total) per_opening EA|SET DESCRIPTION CATALOG FINISH MFR"
_SPECWORKS_ITEM_RE = re.compile(
    r"^\(\s*(\d+)\)\s+(\d+)\s+(EA|SET|PR)\s+(.+)"
)

# SpecWorks/ESC door assignment: "N SGL|PR|PRA/PRI Door(S):DOOR_NUM..." or "N SGL Door:DOOR_NUM..."
_SPECWORKS_DOOR_RE = re.compile(
    r"^\s*(\d+)\s+(SGL|PRA/PRI|PR)\s+DOOR(?:\(S\)|:)(\d{1,3}\.\d{2}\.[A-Z]\.\S+)",
    re.IGNORECASE,
)

# Footer line: "Project: ..." or "SpecWorks..."
_SPECWORKS_FOOTER_RE = re.compile(
    r"^(?:Project:|SpecWorks|Supplier:)"
)

# Known 3-letter SpecWorks manufacturer codes
_SPECWORKS_MFR_CODES = {
    "IVE", "SCH", "LCN", "VON", "NGP", "GLY", "ZER", "ECS", "B/O",
    "ABH", "AME", "BEA", "DON", "HAG", "HES", "KAB", "KEM", "MED",
    "PEM", "ROC", "SEC", "SIM", "STA", "TRI",
}


def _parse_specworks_items(page_text: str) -> list[HardwareItem]:
    """Parse hardware items from a SpecWorks-format page.

    SpecWorks item format:
        ( total) per_opening EA DESCRIPTION CATALOG FINISH MFR
        CONTINUATION_TEXT

    Items start after "Totals Each Assembly to have:" line.
    Multi-line wrapping: continuation lines lack the ( total) prefix and
    extend the DESCRIPTION (e.g., "HVY\\nWT" → "HVY WT").
    Manufacturer (3-letter) and finish are always on the FIRST line.
    """
    items: list[HardwareItem] = []
    lines = page_text.split("\n")
    in_items = False
    current_item: dict | None = None

    for line in lines:
        stripped = line.strip()

        # Skip empty lines
        if not stripped:
            continue

        # Detect items start marker
        if "totals each assembly" in stripped.lower() or "each assembly to have" in stripped.lower():
            in_items = True
            continue

        # Stop at footer
        if _SPECWORKS_FOOTER_RE.match(stripped):
            break

        if not in_items:
            continue

        # Skip HEI notes (SpecWorks editor comments)
        if stripped.startswith("HEI:"):
            continue

        # Try to match a new item line
        m = _SPECWORKS_ITEM_RE.match(stripped)
        if m:
            # Save previous item if any
            if current_item:
                items.append(_finalize_specworks_item(current_item))

            total_qty = int(m.group(1))
            per_opening_qty = int(m.group(2))
            rest = m.group(4).strip()

            current_item = {
                "qty": per_opening_qty,
                "qty_total": total_qty,
                "first_line": rest,   # Mfr and finish are on this line only
                "continuations": [],  # Continuation lines extend the description
            }
        elif current_item:
            # Continuation line — extends the description, NOT the mfr/finish
            current_item["continuations"].append(stripped)

    # Save last item
    if current_item:
        items.append(_finalize_specworks_item(current_item))

    return items


def _finalize_specworks_item(item_data: dict) -> HardwareItem:
    """Split a SpecWorks item's first line + continuations into name/model/finish/mfr.

    Manufacturer and finish are extracted from the FIRST LINE only.
    Continuation text is inserted into the description portion.
    """
    first_line = item_data["first_line"]
    continuations = item_data.get("continuations", [])

    # Extract manufacturer from first line: last token if known 3-letter code
    tokens = first_line.split()
    manufacturer = ""
    finish = ""

    if tokens and tokens[-1].upper() in _SPECWORKS_MFR_CODES:
        manufacturer = tokens[-1].upper()
        tokens = tokens[:-1]

    # Extract finish from first line: new last token if BHMA pattern
    if tokens and FINISH_CODE_PATTERN.search(tokens[-1]):
        finish = tokens[-1]
        tokens = tokens[:-1]

    # Rejoin first line without mfr/finish
    first_clean = " ".join(tokens)

    # Find where description ends and catalog number begins in first line
    name = first_clean
    model = ""
    parts = first_clean.split()
    for i, part in enumerate(parts):
        # Catalog numbers start with digits: 5BB1HW, 4040XP, 705, 9553
        if re.match(r"^\d", part) and i > 0:
            name = " ".join(parts[:i])
            model = " ".join(parts[i:])
            break
        # Letter-digit codes: L9010, QEL-9849, EPT
        if re.match(r"^[A-Z]+\d", part) and i > 0 and len(part) >= 3:
            name = " ".join(parts[:i])
            model = " ".join(parts[i:])
            break

    # Append continuation text to the description (name) part
    if continuations:
        name = name + " " + " ".join(continuations)

    return HardwareItem(
        qty=item_data["qty"],
        qty_total=item_data["qty_total"],
        qty_source="parsed",
        name=name.strip(",. "),
        manufacturer=manufacturer,
        model=model,
        finish=finish,
    )


def _count_specworks_doors(page_text: str) -> tuple[int, int]:
    """Count door assignments in a SpecWorks-format page.

    Returns (opening_count, leaf_count).

    SpecWorks format: "1 SGL DOOR(S)3.01.H.04..."  or "1 PR DOOR(S)3.01.E.02..."
    """
    opening_count = 0
    leaf_count = 0
    for line in page_text.split("\n"):
        m = _SPECWORKS_DOOR_RE.match(line.strip())
        if m:
            count = int(m.group(1))
            door_type = m.group(2).upper()
            opening_count += count
            leaf_count += count * (2 if door_type in ("PR", "PRA/PRI") else 1)
    return opening_count, leaf_count


def _parse_specworks_door_assignments(page_text: str) -> list[dict]:
    """Extract door assignments from a SpecWorks/ESC-format set page.

    Returns list of dicts with door_number, hand, door_type.
    """
    doors = []
    for line in page_text.split("\n"):
        m = _SPECWORKS_DOOR_RE.match(line.strip())
        if m:
            raw_type = m.group(2).upper()
            door_type = "PR" if raw_type in ("PR", "PRA/PRI") else "SGL"
            # Door number is concatenated — extract up to the location text
            raw_door = m.group(3)
            # Door number is 4-part dot notation: X.XX.Y.ZZ[A]
            dn_match = re.match(r"(\d{1,3}\.\d{2}\.[A-Z]\.\d{2}[A-Z]?)", raw_door)
            door_number = dn_match.group(1) if dn_match else raw_door

            # Extract handing from the line
            hand = ""
            hand_match = re.search(r"\b(LH|RH|LHR|RHR|LHRA|RHRA|LHA|RHA)\b", line)
            if hand_match:
                hand = hand_match.group(1)

            doors.append({
                "door_number": door_number,
                "hand": hand,
                "door_type": door_type,
            })
    return doors


# --- ESC/AKN Format Item Parser ---
#
# ESC/AKN item format (different from SpecWorks dual-quantity):
#   QTY EA Description CatalogNumber FinishCode (RefCode) Manufacturer
#   CONTINUATION_TEXT
#
# Examples:
#   3 EA Hinge, Full Mortise, Hvy 5BB1HW 4-1/2" x 4-1/2" NRP 630 (HI-1) Ives
#   Wt                          ← continuation of description
#   1 EA Threshold 625A x 36" (TH-10) Zero
#   International               ← continuation of manufacturer
#   0 EA Door Position Switch Tane Alarm SD-72C By Security (EC-7) Miscellaneous

# Match: "QTY EA|SET|PR <rest>"
_ESC_ITEM_RE = re.compile(r"^\s*(\d+)\s+(EA|SET|PR)\s+(.+)", re.IGNORECASE)

# Reference code pattern in parentheses: (HI-1), (ED-3), (CL-3), (TH-10), (GA-40)
_ESC_REF_CODE_RE = re.compile(r"\(([A-Z]{2,4}-\d{1,3})\)")

# Lines that are NOT hardware items or continuations — they're notes, comments, door sizes
_ESC_SKIP_LINE_RE = re.compile(
    r"(?i)^(?:"
    r"\d+['-]"                  # Door size: 3' 0" x 7' 0" or 2-3' 0"
    r"|Phase:"                  # Phase header
    r"|Project\s*ID:"           # Project ID header
    r"|Hardware\s*Schedule"     # Page title
    r"|Engineering\s*Special"   # Footer
    r"|Heading\s*#"             # Heading line
    r"|HEI:"                    # SpecWorks editor notes
    r"|Page\s+\d"               # Page number
    r"|\d+\s+(?:SGL|PR)"       # Door assignment line
    r")"
)

# Footer line for ESC format (at bottom of page, NOT headers at top)
_ESC_FOOTER_RE = re.compile(
    r"^(?:Engineering\s*Special|SpecWorks|Supplier:)"
)


def _is_esc_format(page_text: str) -> bool:
    """Detect if page uses ESC/AKN format (Heading #: ID with QTY EA items).

    Distinguishes from SpecWorks dual-quantity format which uses (total) per_opening EA.
    """
    return bool(re.search(r"(?i)heading\s*#:\s*[A-Z0-9]", page_text))


def _parse_esc_items(section_text: str) -> list[HardwareItem]:
    """Parse hardware items from an ESC/AKN-format section.

    ESC item format:
        QTY EA Description CatalogNumber Finish (RefCode) Manufacturer
        CONTINUATION_TEXT

    Items appear after door assignments and door size line.
    Multi-line wrapping: continuation lines lack the QTY EA prefix.
    Reference code (XX-N) in parentheses is used as anchor to split
    finish and manufacturer from the description.
    """
    items: list[HardwareItem] = []
    lines = section_text.split("\n")
    current_item: dict | None = None
    past_doors = False  # Track when we're past the door assignment section

    for line in lines:
        stripped = line.strip()

        if not stripped:
            continue

        # Skip page headers/footers
        if _ESC_FOOTER_RE.match(stripped):
            break

        # Skip heading line itself
        if re.match(r"(?i)^Heading\s*#", stripped):
            continue

        # Skip door assignment lines
        if _SPECWORKS_DOOR_RE.match(stripped):
            past_doors = True
            continue

        # Skip door size lines (e.g., "3' 0\" x 7' 0\" x 1 3/4\" HMD/HMF")
        if re.match(r"^\d+['\u2032-]", stripped):
            past_doors = True
            continue

        # Skip "Phase:" and "Project ID:" headers
        if re.match(r"(?i)^(?:Phase:|Project\s*ID:|Hardware\s*Schedule)", stripped):
            continue

        # Try to match a new item line: "QTY EA Description..."
        m = _ESC_ITEM_RE.match(stripped)
        if m:
            past_doors = True
            # Save previous item
            if current_item:
                items.append(_finalize_esc_item(current_item))

            qty = int(m.group(1))
            rest = m.group(3).strip()

            current_item = {
                "qty": qty,
                "first_line": rest,
                "continuations": [],
            }
        elif current_item and past_doors:
            # Continuation line — could extend description or manufacturer
            # Skip lines that are standalone notes/annotations, not item continuations
            if (
                not re.match(r"(?i)^(?:Phase:|Project\s*ID:|Hardware\s*Schedule|Heading\s*#)", stripped)
                and not _SPECWORKS_DOOR_RE.match(stripped)
                # Skip installation note annotations like "At header only", "At jamb legs only"
                and not re.match(r"(?i)^at\s+(?:header|jamb|hinge|lock|latch|pull)", stripped)
            ):
                current_item["continuations"].append(stripped)

    # Save last item
    if current_item:
        items.append(_finalize_esc_item(current_item))

    return items


def _finalize_esc_item(item_data: dict) -> HardwareItem:
    """Split an ESC/AKN item's first line + continuations into name/model/finish/mfr.

    Uses the reference code (XX-N) in parentheses as an anchor point.
    Format: Description CatalogNumber Finish (RefCode) Manufacturer
    """
    first_line = item_data["first_line"]
    continuations = item_data.get("continuations", [])
    qty = item_data["qty"]

    # Join first line with continuations for full text analysis
    # But manufacturer name wraps are handled specially
    full_text = first_line

    # Check if first_line has a reference code
    ref_match = _ESC_REF_CODE_RE.search(first_line)

    manufacturer = ""
    finish = ""
    name = ""
    model = ""
    ref_code = ""

    if ref_match:
        ref_code = ref_match.group(1)
        before_ref = first_line[:ref_match.start()].strip()
        after_ref = first_line[ref_match.end():].strip()

        # Manufacturer is after the ref code on the first line
        manufacturer = after_ref

        # If manufacturer wraps to continuation lines, join them
        # (but only if first line had no manufacturer text after ref code)
        mfr_continuations = []
        desc_continuations = []
        for cont in continuations:
            # Only consider manufacturer continuation if the first line
            # had no manufacturer text (e.g., "Zero\nInternational" where
            # "Zero" is the last word before line break)
            if (
                not desc_continuations
                and not mfr_continuations
                and not _ESC_ITEM_RE.match(cont)
                and not manufacturer  # No mfr on first line → this continues it
            ):
                # Check if this looks like a manufacturer continuation
                if (
                    re.match(r"^[A-Z][a-z]", cont)
                    and not re.match(r"(?i)^(?:at\s|per\s|extended|mortise\s*door|concealed|gasketing\s*change|please|EU\s*=|permanent|length|coordinator|closer)", cont)
                    and len(cont.split()) <= 3
                ):
                    mfr_continuations.append(cont)
                    continue
            # If manufacturer IS present and continuation is a known company
            # name suffix (e.g., "International", "Closers", "Builders Hardware")
            elif (
                not desc_continuations
                and not mfr_continuations
                and manufacturer
                and re.match(r"^(?:International|Closers|Builders\s*Hardware|Products|Industries|Corp|Inc)$", cont, re.IGNORECASE)
            ):
                mfr_continuations.append(cont)
                continue
            desc_continuations.append(cont)

        if mfr_continuations:
            manufacturer = (manufacturer + " " + " ".join(mfr_continuations)).strip()

        # Parse the before-ref part: Description CatalogNumber Finish
        # Work backwards from the end: finish is the last BHMA-pattern token
        tokens = before_ref.split()

        # Extract finish: last token(s) that match finish pattern
        while tokens and FINISH_CODE_PATTERN.match(tokens[-1]):
            finish = (tokens.pop() + " " + finish).strip() if finish else tokens.pop()

        # Rejoin and split into name/model
        before_finish = " ".join(tokens)

        # Find where description ends and catalog number begins
        name = before_finish
        model = ""
        parts = before_finish.split()
        for i, part in enumerate(parts):
            # Catalog numbers start with digits: 5BB1HW, 4040XP, 705, 9553
            if re.match(r"^\d", part) and i > 0:
                name = " ".join(parts[:i])
                model = " ".join(parts[i:])
                break
            # Letter-digit codes: L9010, QEL-9849, FB51T
            if re.match(r"^[A-Z]+\d", part) and i > 0 and len(part) >= 3:
                name = " ".join(parts[:i])
                model = " ".join(parts[i:])
                break

        # Prepend description continuations to name
        if desc_continuations:
            # Filter out obvious note lines from description continuations
            hw_conts = []
            for dc in desc_continuations:
                # Stop at note-like lines
                if re.match(r"(?i)^(?:gasketing\s*change|please|ESC\s|per\s|EU\s*=|permanent|length|coordinator|closer\s*mounted|mortise\s*door\s*bottom|concealed\s*OH|extended\s*lip)", dc):
                    break
                hw_conts.append(dc)
            if hw_conts:
                name = name + " " + " ".join(hw_conts)

    else:
        # No reference code — simpler parsing
        # Join continuations
        if continuations:
            full_text = first_line + " " + " ".join(continuations)

        # Try to find name/model split
        parts = full_text.split()
        name = full_text
        for i, part in enumerate(parts):
            if re.match(r"^\d", part) and i > 0:
                name = " ".join(parts[:i])
                model = " ".join(parts[i:])
                break
            if re.match(r"^[A-Z]+\d", part) and i > 0 and len(part) >= 3:
                name = " ".join(parts[:i])
                model = " ".join(parts[i:])
                break

    return HardwareItem(
        qty=qty,
        qty_source="parsed",
        name=name.strip(",. "),
        manufacturer=manufacturer.strip(),
        model=model.strip(),
        finish=finish.strip(),
    )


def parse_items_from_raw_tables(tables: list) -> list[HardwareItem]:
    """
    Parse hardware items from raw pdfplumber table output.
    Extracted as a reusable helper for both full-page and region extraction.
    Handles column detection by header text or positional inference.
    """
    items: list[HardwareItem] = []

    for table in tables:
        if not table or len(table) < 2:
            continue

        header_row = [clean_cell(c) for c in table[0]]

        # Skip door list tables
        if is_opening_list_table(header_row):
            continue

        # Detect columns
        qty_col = None
        total_qty_col = None
        name_col = None
        mfr_col = None
        model_col = None
        finish_col = None

        for i, h in enumerate(header_row):
            hl = h.lower()
            if re.search(r"(?i)(total|ext|extended)\s*(qty|quantity)", hl):
                total_qty_col = i
            elif re.match(r"(?i)^(qty\.?|quantity|#|qty\s*/?\s*ea|ea\.?\s*qty)$", hl):
                qty_col = i
            elif re.search(r"(?i)(item|description|hardware|product)", hl):
                name_col = i
            elif re.search(r"(?i)(mfr|mfg|manufacturer|vendor)", hl):
                mfr_col = i
            elif re.search(r"(?i)(model|catalog|cat\.?\s*#?|product\s*#?|series)", hl):
                model_col = i
            elif re.search(r"(?i)(finish|fin\.?|color)", hl):
                finish_col = i

        is_aggregate_qty = False
        if qty_col is None and total_qty_col is not None:
            qty_col = total_qty_col
            is_aggregate_qty = True
        elif qty_col is not None:
            data_rows = table[1:6]
            qty_values = []
            for row in data_rows:
                cells = [clean_cell(c) for c in row]
                if qty_col < len(cells):
                    m = re.match(r"(\d+)", cells[qty_col])
                    if m:
                        qty_values.append(int(m.group(1)))
            if qty_values:
                over_threshold = sum(1 for v in qty_values if v > 6)
                if over_threshold / len(qty_values) > 0.6:
                    is_aggregate_qty = True

        # Positional inference fallback
        if qty_col is None and name_col is None and len(header_row) >= 3:
            data_rows = table[1:6]
            first_col_is_qty = all(
                re.match(r"^\d{1,2}$", clean_cell(row[0]))
                for row in data_rows
                if row and clean_cell(row[0])
            )
            if first_col_is_qty and len(header_row) >= 4:
                qty_col = 0
                name_col = 1
                mfr_col = 2 if len(header_row) > 2 else None
                model_col = 3 if len(header_row) > 3 else None
                finish_col = 4 if len(header_row) > 4 else None

        if name_col is None and qty_col is None:
            continue
        if name_col is None and qty_col is not None:
            name_col = qty_col + 1

        for row in table[1:]:
            cells = [clean_cell(c) for c in row]
            name_val = cells[name_col] if name_col is not None and name_col < len(cells) else ""
            if not name_val:
                continue
            name_lower = name_val.lower()
            if name_lower in ("total", "totals", "note", "notes", ""):
                continue
            if name_lower.startswith("note:") or name_lower.startswith("*"):
                continue
            if not HARDWARE_ITEM_NAMES.search(name_val) and len(name_val) < 3:
                continue

            qty_val = 1
            if qty_col is not None and qty_col < len(cells):
                raw_qty = cells[qty_col].strip()
                if re.match(r"^(EA|PR|SET|PAIR|EACH)\.?$", raw_qty, re.IGNORECASE):
                    qty_val = 1
                else:
                    qty_match = re.match(r"-?(\d+)", raw_qty)
                    if qty_match:
                        qty_val = int(qty_match.group(1))
                        if qty_val == 0:
                            qty_val = 1

            mfr_val = cells[mfr_col] if mfr_col is not None and mfr_col < len(cells) else ""
            model_val = cells[model_col] if model_col is not None and model_col < len(cells) else ""
            finish_val = cells[finish_col] if finish_col is not None and finish_col < len(cells) else ""

            items.append(HardwareItem(
                qty=qty_val,
                name=name_val,
                manufacturer=mfr_val,
                model=model_val,
                finish=finish_val,
            ))

    return items


def extract_hardware_sets_from_page(page, page_text: str, heading_format: str = "") -> list[HardwareSetDef]:
    """
    Extract hardware set definitions from a single page using text-alignment
    table detection (for transparent/invisible grid lines).

    For pages with multiple headings, splits at heading boundaries and
    extracts each set independently via text-line parsing.

    If heading_format is "specworks", uses the SpecWorks-specific parser
    which handles dual quantities, multi-line wrapping, and 3-letter mfr codes.
    """
    sets: list[HardwareSetDef] = []

    heading_id, generic_set_id, heading = parse_hw_set_id_from_text(page_text)
    if not heading_id:
        return sets

    # SpecWorks format: use dedicated parser (one set per page, no table extraction)
    if heading_format == "specworks" or re.search(
        r"(?i)heading\s+\S+\s*\(hw\s*set", page_text
    ):
        door_count, leaf_count = _count_specworks_doors(page_text)
        items = _parse_specworks_items(page_text)
        if items:
            items = deduplicate_hardware_items(items)
        sets.append(HardwareSetDef(
            set_id=heading_id,
            generic_set_id=generic_set_id,
            heading=heading,
            heading_door_count=door_count,
            heading_leaf_count=leaf_count,
            heading_doors=extract_heading_door_numbers(page_text),
            qty_convention=detect_quantity_convention(page_text, door_count),
            items=items,
        ))
        return sets

    # ESC/AKN format: "Heading #: ID" with "QTY EA Description" items.
    # May have multiple headings per page — split and parse each section.
    if _is_esc_format(page_text):
        sections = _split_page_at_headings(page_text)
        for section_text in sections:
            sec_id, sec_generic, sec_heading = parse_hw_set_id_from_text(section_text)
            if not sec_id:
                continue
            door_count, leaf_count = _count_specworks_doors(section_text)
            items = _parse_esc_items(section_text)
            if items:
                items = deduplicate_hardware_items(items)
            sets.append(HardwareSetDef(
                set_id=sec_id,
                generic_set_id=sec_generic,
                heading=sec_heading,
                heading_door_count=door_count,
                heading_leaf_count=leaf_count,
                heading_doors=extract_heading_door_numbers(section_text),
                qty_convention=detect_quantity_convention(section_text, door_count),
                items=items,
            ))
        return sets

    # Extract door counts from the FULL page text BEFORE splitting so that
    # door listing lines are not lost when they appear between headings.
    full_page_door_count, full_page_leaf_count = count_heading_doors(page_text)

    # Check for multiple headings on this page
    sections = _split_page_at_headings(page_text)

    if len(sections) > 1:
        # Multi-heading page: extract each section independently via text parsing
        logger.info(
            f"Multi-heading page detected ({len(sections)} headings), "
            f"splitting for independent extraction"
        )
        # Build per-section door counts; fall back to full-page counts
        # distributed to the first section that has no counts of its own.
        section_counts: dict[str, tuple[int, int]] = {}
        for section_text in sections:
            sid, sgen, _ = parse_hw_set_id_from_text(section_text)
            key = sgen or sid or ""
            section_counts[key] = count_heading_doors(section_text)

        # If total section counts are lower than full-page counts, the
        # difference was lost during splitting.  Attribute unaccounted
        # counts to sections that reported zero.
        accounted_doors = sum(v[0] for v in section_counts.values())
        accounted_leaves = sum(v[1] for v in section_counts.values())
        extra_doors = full_page_door_count - accounted_doors
        extra_leaves = full_page_leaf_count - accounted_leaves
        if extra_doors > 0 or extra_leaves > 0:
            for key, (d, l) in section_counts.items():
                if d == 0 and l == 0:
                    section_counts[key] = (d + extra_doors, l + extra_leaves)
                    extra_doors = 0
                    extra_leaves = 0
                    break

        for section_text in sections:
            sec_id, sec_generic, sec_heading = parse_hw_set_id_from_text(section_text)
            if not sec_id:
                continue
            key = sec_generic or sec_id
            sec_door_count, sec_leaf_count = section_counts.get(key, (0, 0))
            sec_items = extract_hw_items_from_text(section_text)
            if sec_items:
                sec_items = deduplicate_hardware_items(sec_items)
                sets.append(HardwareSetDef(
                    set_id=sec_id,
                    generic_set_id=sec_generic,
                    heading=sec_heading,
                    heading_door_count=sec_door_count,
                    heading_leaf_count=sec_leaf_count,
                    heading_doors=extract_heading_door_numbers(section_text),
                    qty_convention=detect_quantity_convention(section_text, sec_door_count),
                    items=sec_items,
                ))
        return sets

    # Single heading: use full table-based extraction (richer column parsing)

    # Use pre-computed door counts from full page text
    heading_door_count, heading_leaf_count = full_page_door_count, full_page_leaf_count

    # Try text-based table extraction first (for transparent grid lines)
    tables = page.extract_tables(
        table_settings={
            "vertical_strategy": "text",
            "horizontal_strategy": "text",
            "intersection_tolerance": 5,
            "snap_tolerance": 5,
            "join_tolerance": 8,
            "min_words_vertical": 2,
            "min_words_horizontal": 1,
            "text_x_tolerance": 5,
            "text_y_tolerance": 3,
        }
    )

    # Also try line-based as fallback for pages that DO have visible lines
    if not tables:
        tables = page.extract_tables(
            table_settings={
                "vertical_strategy": "lines",
                "horizontal_strategy": "lines",
                "intersection_tolerance": 5,
                "snap_tolerance": 5,
            }
        )

    items = parse_items_from_raw_tables(tables)

    # If table extraction found nothing, try text-line parsing
    if not items:
        items = extract_hw_items_from_text(page_text)

    if items:
        # Level 1 dedup: remove duplicates from within this page's extraction
        items = deduplicate_hardware_items(items)
        sets.append(HardwareSetDef(
            set_id=heading_id,
            generic_set_id=generic_set_id,
            heading=heading,
            heading_door_count=heading_door_count,
            heading_leaf_count=heading_leaf_count,
            heading_doors=extract_heading_door_numbers(page_text),
            qty_convention=detect_quantity_convention(page_text, heading_door_count),
            items=items,
        ))

    return sets


def extract_hw_items_from_text(text: str) -> list[HardwareItem]:
    """
    Fallback: extract hardware items from raw text when table detection fails.
    Looks for lines that match qty + item name patterns.
    """
    items: list[HardwareItem] = []
    lines = text.split("\n")

    # Pattern: starts with a small integer (qty), followed by item description
    # Max 2 digits — per-set quantities are almost always 1-20
    item_line_pattern = re.compile(
        r"^\s*(\d{1,2})\s+(.+)"
    )

    for line in lines:
        m = item_line_pattern.match(line)
        if not m:
            continue

        qty = int(m.group(1))
        rest = m.group(2).strip()

        # Check if this looks like a hardware item
        if not HARDWARE_ITEM_NAMES.search(rest):
            continue

        # Try to split: name | manufacturer | model | finish
        # Separated by 2+ spaces or tabs
        parts = re.split(r"\s{2,}|\t", rest)

        items.append(HardwareItem(
            qty=qty,
            name=parts[0] if len(parts) > 0 else rest,
            manufacturer=parts[1] if len(parts) > 1 else "",
            model=parts[2] if len(parts) > 2 else "",
            finish=parts[3] if len(parts) > 3 else "",
        ))

    return items


def extract_all_hardware_sets(pdf: pdfplumber.PDF) -> list[HardwareSetDef]:
    """
    Extract all hardware set definitions from the entire PDF.
    Scans each page for hardware set headings and extracts items.

    Merge semantics (EXACT set_id matching only):
    - If the same set_id appears on multiple pages (e.g., "04" continuing
      from page 5 to page 6), merge them — this is a true continuation.
    - If DIFFERENT set_ids share a generic_set_id (e.g., "DH4A.0" and
      "DH4A.1"), keep them as separate sub-variants. Each has its own
      heading_doors, counts, and items list. The TypeScript layer uses
      heading_doors to match openings to their specific sub-set.

    This avoids the silent item-loss bug that occurred when the previous
    generic_set_id-based merge called deduplicate_hardware_items() across
    sub-variants with different door counts.
    """
    all_sets: list[HardwareSetDef] = []
    seen_set_ids: dict[str, int] = {}  # exact set_id → index in all_sets

    for page_num, page in enumerate(pdf.pages):
        text = page.extract_text() or ""

        if not is_hardware_set_page(text):
            continue

        page_sets = extract_hardware_sets_from_page(page, text)

        for hw_set in page_sets:
            # Exact set_id match only (preserves .0/.1/.PR4 suffixes as distinct)
            if hw_set.set_id in seen_set_ids:
                # Continuation of the SAME sub-set on a later page
                existing = all_sets[seen_set_ids[hw_set.set_id]]
                existing.items.extend(hw_set.items)
                existing.items = deduplicate_hardware_items(existing.items)
                existing.heading_door_count += hw_set.heading_door_count
                existing.heading_leaf_count += hw_set.heading_leaf_count
                # Merge heading_doors lists (avoid duplicates)
                for dn in hw_set.heading_doors:
                    if dn not in existing.heading_doors:
                        existing.heading_doors.append(dn)
                # Merge qty_convention: definitive signals override "unknown"
                if existing.qty_convention == "unknown" and hw_set.qty_convention != "unknown":
                    existing.qty_convention = hw_set.qty_convention
            else:
                # First occurrence of this specific set_id (preserve suffix)
                seen_set_ids[hw_set.set_id] = len(all_sets)
                all_sets.append(hw_set)

    # D1: Drop phantom sets — no heading text, no doors, no items.
    # pdfplumber occasionally picks up set IDs from TOC/reference tables
    # and creates empty entries that confuse downstream extraction.
    phantoms = [
        s for s in all_sets
        if not s.heading.strip()
        and s.heading_door_count == 0
        and len(s.heading_doors) == 0
        and len(s.items) == 0
    ]
    for p in phantoms:
        logger.warning(
            "Dropping phantom set '%s' — no heading, no doors, no items",
            p.set_id,
        )
    if phantoms:
        phantom_ids = {id(p) for p in phantoms}
        all_sets = [s for s in all_sets if id(s) not in phantom_ids]

    # D2: Reconcile heading_door_count vs heading_doors when they disagree.
    # count_heading_doors() and extract_heading_door_numbers() use different
    # regexes and can get out of sync. Use the larger value as truth.
    for s in all_sets:
        actual_doors = len(s.heading_doors)
        if actual_doors > 0 and s.heading_door_count != actual_doors:
            logger.warning(
                "Set '%s': heading_door_count=%d disagrees with len(heading_doors)=%d — using max",
                s.set_id,
                s.heading_door_count,
                actual_doors,
            )
            s.heading_door_count = max(s.heading_door_count, actual_doors)

    # Split concatenated fields (BUG-12): MCA-format PDFs merge name,
    # manufacturer, model, and finish into a single name field.  Run field
    # splitting here so every caller gets properly-separated fields.
    reference_codes = extract_reference_tables(pdf)
    apply_field_splitting(all_sets, reference_codes)

    return all_sets


def extract_inline_doors_from_sets(
    pdf: pdfplumber.PDF,
    hardware_sets: list[HardwareSetDef],
) -> list[DoorEntry]:
    """Extract door assignments from hardware set heading blocks.

    Fallback for schedule-format PDFs that have no separate Opening List table.
    Scans each hardware set page for inline door numbers like:
    - "1 Pair Doors #101, #102"
    - "For Openings: 101, 102, 103"
    - SpecWorks: "1 SGL DOOR(S)3.01.H.04"

    Returns a list of DoorEntry objects with hw_set pre-populated.
    """
    all_doors: list[DoorEntry] = []
    seen: set[str] = set()
    set_ids_by_page: dict[int, list[tuple[str, str]]] = {}

    # Map pages to their hardware sets
    for page_num, page in enumerate(pdf.pages):
        text = page.extract_text() or ""
        if not is_hardware_set_page(text):
            continue

        # Get set ID from this page
        heading_id, generic_id, heading = parse_hw_set_id_from_text(text)
        if not heading_id:
            continue

        # Use generic_set_id for matching (consistent with extract_all_hardware_sets)
        match_id = generic_id or heading_id
        set_ids_by_page.setdefault(page_num, []).append((match_id, heading))

    # Now scan each page for inline door assignments
    for page_num, page in enumerate(pdf.pages):
        if page_num not in set_ids_by_page:
            continue

        text = page.extract_text() or ""

        # Handle multi-heading pages by splitting at headings
        sections = _split_page_at_headings(text)

        if len(sections) > 1:
            # Multi-heading page: extract per-section
            for section_text in sections:
                sec_id, sec_generic, sec_heading = parse_hw_set_id_from_text(section_text)
                if not sec_id:
                    continue
                match_id = sec_generic or sec_id
                # Only extract if this set_id matches one in our hardware_sets
                matching_set = next(
                    (s for s in hardware_sets if (s.generic_set_id or s.set_id) == match_id),
                    None,
                )
                if not matching_set:
                    continue
                inline_doors = extract_inline_door_assignments(
                    section_text, matching_set.set_id, matching_set.heading
                )
                for d in inline_doors:
                    if d.door_number.upper() not in seen:
                        seen.add(d.door_number.upper())
                        all_doors.append(d)
        else:
            # Single heading: use full page text
            for match_id, heading in set_ids_by_page[page_num]:
                matching_set = next(
                    (s for s in hardware_sets if (s.generic_set_id or s.set_id) == match_id),
                    None,
                )
                if not matching_set:
                    continue
                inline_doors = extract_inline_door_assignments(
                    text, matching_set.set_id, matching_set.heading
                )
                for d in inline_doors:
                    if d.door_number.upper() not in seen:
                        seen.add(d.door_number.upper())
                        all_doors.append(d)

    if all_doors:
        logger.info(
            f"[inline-doors] Extracted {len(all_doors)} doors from "
            f"hardware set heading blocks (schedule-format fallback)"
        )
    return all_doors


# --- Opening List Extraction ---

def _identify_hw_set_pages(pdf: pdfplumber.PDF) -> set[int]:
    """Identify page indices that contain hardware set definitions.

    Used to exclude hardware schedule and cut sheet pages from opening
    list extraction — opening list pages always precede these.
    """
    hw_pages: set[int] = set()
    for i, page in enumerate(pdf.pages):
        text = page.extract_text() or ""
        if is_hardware_set_page(text):
            hw_pages.add(i)
    return hw_pages


def extract_opening_list(
    pdf: pdfplumber.PDF,
    user_column_mapping: dict[str, int] | None = None,
) -> tuple[list[DoorEntry], int]:
    """
    Extract the Opening List / Door Schedule from a PDF.
    If user_column_mapping is provided, it overrides auto-detection.
    Returns (list of door entries, number of tables found).

    """
    all_doors: list[DoorEntry] = []
    tables_found = 0
    seen_door_numbers: set[str] = set()

    # S-064: Skip hardware set pages to prevent phantom door entries from
    # heading blocks that list assigned door numbers
    hw_set_page_indices = _identify_hw_set_pages(pdf)
    if hw_set_page_indices:
        logger.info(f"Skipping {len(hw_set_page_indices)} hardware set pages in opening list extraction")

    for page_num, page in enumerate(pdf.pages):
        if page_num in hw_set_page_indices:
            continue
        tables = page.extract_tables(
            table_settings={
                "vertical_strategy": "lines",
                "horizontal_strategy": "lines",
                "intersection_tolerance": 5,
                "snap_tolerance": 5,
                "join_tolerance": 5,
                "edge_min_length": 10,
                "min_words_vertical": 1,
                "min_words_horizontal": 1,
            }
        )

        for table in tables:
            if not table or len(table) < 2:
                continue

            header_row_idx = None
            mapping = {}
            # Search first 8 rows for header (page may have title/project rows before columns)
            for row_idx, row in enumerate(table[:8]):
                headers = [clean_cell(c) for c in row]
                if is_opening_list_table(headers):
                    header_row_idx = row_idx
                    # Use user mapping if provided, otherwise auto-detect
                    mapping = user_column_mapping if user_column_mapping else detect_column_mapping(headers)
                    break

            # Fallback: content-based structural detection
            # If headers didn't match keywords, analyze the DATA itself
            if header_row_idx is None and not user_column_mapping:
                content_result = detect_table_by_content(table)
                if content_result:
                    mapping, header_row_idx = content_result
                    logger.info("Content-based detection identified opening list table")

            if header_row_idx is None:
                continue

            tables_found += 1

            for row in table[header_row_idx + 1:]:
                cells = [clean_cell(c) for c in row]

                door_col = mapping.get("door_number")
                if door_col is None or door_col >= len(cells):
                    continue

                door_num = cells[door_col]
                if not is_valid_door_number(door_num):
                    continue

                door_num = re.sub(r"\s+", " ", door_num).strip()

                if door_num in seen_door_numbers:
                    continue
                seen_door_numbers.add(door_num)

                def get_field(field: str) -> str:
                    idx = mapping.get(field)
                    if idx is None or idx >= len(cells):
                        return ""
                    return cells[idx]

                entry = DoorEntry(
                    door_number=door_num,
                    hw_set=get_field("hw_set"),
                    hw_heading=get_field("hw_heading"),
                    location=get_field("location"),
                    door_type=get_field("door_type"),
                    frame_type=get_field("frame_type"),
                    fire_rating=get_field("fire_rating"),
                    hand=get_field("hand"),
                    by_others=get_field("hw_set").strip().upper() in NO_HARDWARE_VALUES,
                )
                all_doors.append(entry)

    # Merge results from text-alignment strategy (may find doors on pages without grid lines)
    # S-064: Pass hw_set_page_indices to skip hardware set pages
    text_align_doors, ta_tables = extract_opening_list_text_align(pdf, user_column_mapping, hw_set_page_indices)
    existing_nums = {d.door_number for d in all_doors}
    for d in text_align_doors:
        if d.door_number not in existing_nums:
            all_doors.append(d)
            existing_nums.add(d.door_number)
    tables_found += ta_tables

    # Merge results from word-position fallback (catches remaining stragglers)
    # S-064: Pass hw_set_page_indices to skip hardware set pages
    word_doors, w_tables = extract_opening_list_text(pdf, hw_set_page_indices)
    for d in word_doors:
        if d.door_number not in existing_nums:
            all_doors.append(d)
            existing_nums.add(d.door_number)
    tables_found += w_tables

    return all_doors, tables_found


def extract_opening_list_text_align(
    pdf: pdfplumber.PDF,
    user_column_mapping: dict[str, int] | None = None,
    skip_pages: set[int] | None = None,
) -> tuple[list[DoorEntry], int]:
    """
    Try text-alignment based table extraction for Opening List.
    Useful when the table has transparent grid lines.
    """
    all_doors: list[DoorEntry] = []
    tables_found = 0
    seen_door_numbers: set[str] = set()
    _skip = skip_pages or set()

    for page_idx, page in enumerate(pdf.pages):
        if page_idx in _skip:
            continue
        tables = page.extract_tables(
            table_settings={
                "vertical_strategy": "text",
                "horizontal_strategy": "text",
                "intersection_tolerance": 5,
                "snap_tolerance": 5,
                "min_words_vertical": 2,
                "min_words_horizontal": 1,
                "text_x_tolerance": 3,
                "text_y_tolerance": 3,
            }
        )

        for table in tables:
            if not table or len(table) < 2:
                continue

            header_row_idx = None
            mapping = {}
            # Search first 8 rows for header (page may have title/project rows before columns)
            for row_idx, row in enumerate(table[:8]):
                headers = [clean_cell(c) for c in row]
                if is_opening_list_table(headers):
                    header_row_idx = row_idx
                    mapping = user_column_mapping if user_column_mapping else detect_column_mapping(headers)
                    break

            if header_row_idx is None:
                continue

            tables_found += 1

            for row in table[header_row_idx + 1:]:
                cells = [clean_cell(c) for c in row]

                door_col = mapping.get("door_number")
                if door_col is None or door_col >= len(cells):
                    continue

                door_num = cells[door_col]
                if not is_valid_door_number(door_num):
                    continue

                door_num = re.sub(r"\s+", " ", door_num).strip()
                if door_num in seen_door_numbers:
                    continue
                seen_door_numbers.add(door_num)

                def get_field(field: str, m=mapping, c=cells) -> str:
                    idx = m.get(field)
                    if idx is None or idx >= len(c):
                        return ""
                    return c[idx]

                entry = DoorEntry(
                    door_number=door_num,
                    hw_set=get_field("hw_set"),
                    hw_heading=get_field("hw_heading"),
                    location=get_field("location"),
                    door_type=get_field("door_type"),
                    frame_type=get_field("frame_type"),
                    fire_rating=get_field("fire_rating"),
                    hand=get_field("hand"),
                    by_others=get_field("hw_set").strip().upper() in NO_HARDWARE_VALUES,
                )
                all_doors.append(entry)

    return all_doors, tables_found


def _detect_header_row_words(
    row_words: list[dict],
) -> dict[str, float] | None:
    """
    Check if a row of words (with x-positions) represents an Opening List header.
    Returns {field_name: x_start_position} if it is, None otherwise.
    """
    header_kw = {
        "door_number": re.compile(r"(?i)^(opening|door|mark|tag)$"),
        "hw_set": re.compile(r"(?i)^(set|hdw|hw|hardware)$"),
        "hw_heading": re.compile(r"(?i)^(heading)$"),
        "location": re.compile(r"(?i)^(label|location|room|description|from)$"),
        "door_type": re.compile(r"(?i)^(door)$"),
        "frame_type": re.compile(r"(?i)^(frame)$"),
        "fire_rating": re.compile(r"(?i)^(fire|rating|rated)$"),
        "hand": re.compile(r"(?i)^(hand|handing|swing)$"),
    }

    # Combine multi-word headers: join adjacent words
    text_combined = " ".join(w["text"] for w in row_words).lower()

    found: dict[str, float] = {}
    if re.search(r"\b(opening|door|mark)\b", text_combined):
        # Find the x position of the "opening"/"door" word
        for w in row_words:
            if re.match(r"(?i)^(opening|door|mark|tag)$", w["text"]):
                found["door_number"] = w["x0"]
                break
    if re.search(r"\b(hdw|hw|hardware)\s*(set|group)\b", text_combined):
        for w in row_words:
            if re.match(r"(?i)^(hdw|hw|hardware)$", w["text"]):
                # Check if next word is "set"/"group"
                found["hw_set"] = w["x0"]
                break
    if re.search(r"\b(hdw|hw|hardware)\s*heading\b", text_combined):
        # Heading column — find the "heading" keyword and use its x
        for w in row_words:
            if re.match(r"(?i)^heading$", w["text"]):
                # Use the x of the Hdw/HW before "Heading"
                for w2 in row_words:
                    if w2["x0"] < w["x0"] and re.match(r"(?i)^(hdw|hw)$", w2["text"]):
                        if abs(w2["x0"] - found.get("hw_set", -999)) > 30:
                            found["hw_heading"] = w2["x0"]
                            break
                if "hw_heading" not in found:
                    found["hw_heading"] = w["x0"]
                break
    if re.search(r"\b(label|location|room|description)\b", text_combined):
        for w in row_words:
            if re.match(r"(?i)^(label|location|room|description)$", w["text"]):
                found["location"] = w["x0"]
                break
        # "Opening Label" — use "Opening" word's x if near label
        if "location" not in found:
            for w in row_words:
                if re.match(r"(?i)^opening$", w["text"]) and w["x0"] != found.get("door_number"):
                    found["location"] = w["x0"]
                    break
    if re.search(r"\bdoor\s*type\b", text_combined):
        for i, w in enumerate(row_words):
            if re.match(r"(?i)^door$", w["text"]) and w["x0"] != found.get("door_number", -1):
                found["door_type"] = w["x0"]
                break
    if re.search(r"\bframe\s*type\b", text_combined):
        for w in row_words:
            if re.match(r"(?i)^frame$", w["text"]):
                found["frame_type"] = w["x0"]
                break
    if re.search(r"\b(fire|rating)\b", text_combined):
        for w in row_words:
            if re.match(r"(?i)^(fire|rating)$", w["text"]):
                found["fire_rating"] = w["x0"]
                break
    if re.search(r"\b(hand|handing|swing)\b", text_combined):
        for w in row_words:
            if re.match(r"(?i)^(hand|handing|swing)$", w["text"]):
                found["hand"] = w["x0"]
                break

    if len(found) >= 2 and "door_number" in found:
        return found
    return None


def _assign_words_to_columns(
    row_words: list[dict],
    col_positions: list[float],
    field_order: list[str],
) -> dict[str, str]:
    """
    Assign words in a row to columns based on their x-position.
    Each word goes to the column whose start position it's closest to (but not before).
    """
    col_values: dict[str, list[str]] = {f: [] for f in field_order}

    for w in row_words:
        x = w["x0"]
        # Find which column this word belongs to
        best_col = field_order[0]
        for j, pos in enumerate(col_positions):
            if x >= pos - 10:  # 10pt tolerance
                best_col = field_order[j]
        col_values[best_col].append(w["text"])

    return {f: " ".join(words).strip() for f, words in col_values.items()}


def extract_opening_list_text(pdf: pdfplumber.PDF, skip_pages: set[int] | None = None) -> tuple[list[DoorEntry], int]:
    """
    Fallback extraction using word-level x-position alignment.
    Uses pdfplumber's word extraction to get exact x-coordinates, then
    clusters words into columns based on the header row's positions.
    Works for PDFs with transparent/invisible grid lines.
    """
    all_doors: list[DoorEntry] = []
    seen_door_numbers: set[str] = set()
    tables_found = 0
    col_positions: list[float] = []
    field_order: list[str] = []
    header_y: float | None = None
    _skip = skip_pages or set()

    pages_since_header = 0  # Track how many pages since last header seen

    for page_idx, page in enumerate(pdf.pages):
        if page_idx in _skip:
            continue
        words = page.extract_words(
            keep_blank_chars=False,
            x_tolerance=3,
            y_tolerance=3,
        )
        if not words:
            continue

        # Group words by y-position (rows), with 4pt tolerance
        rows: dict[float, list[dict]] = {}
        for w in words:
            y = round(w["top"] / 4) * 4  # snap to 4pt grid
            if y not in rows:
                rows[y] = []
            rows[y].append(w)

        # Sort each row by x position
        for y in rows:
            rows[y].sort(key=lambda w: w["x0"])

        # Check if this page has the header
        page_has_header = False
        for y in sorted(rows.keys()):
            result = _detect_header_row_words(rows[y])
            if result:
                page_has_header = True
                if not col_positions:
                    sorted_fields = sorted(result.items(), key=lambda x: x[1])
                    col_positions = [pos for _, pos in sorted_fields]
                    field_order = [field for field, _ in sorted_fields]
                    logger.info(
                        f"Opening list header: {field_order} at x={col_positions}"
                    )
                break

        if page_has_header:
            pages_since_header = 0
        else:
            pages_since_header += 1

        # Only process pages with header or continuation pages nearby
        # Stop if we've gone 3+ pages without seeing a header (left the opening list)
        if not col_positions:
            continue
        if not page_has_header and pages_since_header > 2 and all_doors:
            # We've left the opening list section
            continue

        # Parse data rows on this page
        for y in sorted(rows.keys()):
            # Skip header rows
            if _detect_header_row_words(rows[y]) is not None:
                continue

            row_words = rows[y]
            if not row_words:
                continue

            # Assign words to columns
            vals = _assign_words_to_columns(row_words, col_positions, field_order)

            door_num = clean_cell(vals.get("door_number", ""))
            if not door_num or not is_valid_door_number(door_num):
                continue
            if door_num in seen_door_numbers:
                continue

            seen_door_numbers.add(door_num)
            tables_found = max(tables_found, 1)

            hw_set_val = clean_cell(vals.get("hw_set", ""))
            entry = DoorEntry(
                door_number=door_num,
                hw_set=hw_set_val,
                hw_heading=clean_cell(vals.get("hw_heading", "")),
                location=clean_cell(vals.get("location", "")),
                door_type=clean_cell(vals.get("door_type", "")),
                frame_type=clean_cell(vals.get("frame_type", "")),
                fire_rating=clean_cell(vals.get("fire_rating", "")),
                hand=clean_cell(vals.get("hand", "")),
                by_others=hw_set_val.strip().upper() in NO_HARDWARE_VALUES,
            )
            all_doors.append(entry)

    if all_doors:
        logger.info(f"Word-position fallback: {len(all_doors)} doors extracted")

    return all_doors, tables_found


# --- Reference Table Extraction ---

def extract_reference_tables(pdf: pdfplumber.PDF) -> list[ReferenceCode]:
    """
    Extract reference/legend tables (Manufacturer List, Finish List, Option List).
    These are typically 2-column tables: abbreviation -> full name.
    """
    codes: list[ReferenceCode] = []

    for page in pdf.pages:
        text = page.extract_text() or ""

        tables = page.extract_tables(
            table_settings={
                "vertical_strategy": "lines",
                "horizontal_strategy": "lines",
                "intersection_tolerance": 5,
                "snap_tolerance": 5,
            }
        )

        # S-064: Detect code_type per-page as fallback (used when header-based
        # detection fails for a specific table)
        page_code_type = None
        page_text_lines = text.split("\n")
        for line in page_text_lines:
            if MANUFACTURER_HEADER.search(line):
                page_code_type = "manufacturer"
                break
            elif FINISH_HEADER.search(line):
                page_code_type = "finish"
                break
            elif OPTION_HEADER.search(line):
                page_code_type = "option"
                break

        for table in tables:
            if not table or len(table) < 2:
                continue

            headers = [clean_cell(c) for c in table[0]]
            header_text = " ".join(headers)

            # S-064: Detect code_type per-table from headers first (takes priority)
            code_type = None
            if MANUFACTURER_HEADER.search(header_text):
                code_type = "manufacturer"
            elif FINISH_HEADER.search(header_text):
                code_type = "finish"
            elif OPTION_HEADER.search(header_text):
                code_type = "option"

            # Fall back to page-level detection only if header didn't match
            if not code_type:
                code_type = page_code_type

            if not code_type:
                continue

            for row in table[1:]:
                cells = [clean_cell(c) for c in row]
                if len(cells) >= 2 and cells[0] and cells[1]:
                    codes.append(ReferenceCode(
                        code_type=code_type,
                        code=cells[0],
                        full_name=cells[1],
                    ))

    return codes


_PAIR_RE = re.compile(r"(?i)\bpair\b|\bPR\b")

# Suffixes stripped for fuzzy set-ID matching
_SET_ID_SUFFIX_RE = re.compile(
    r"(?i)(?::(?:WI|1|2|3|OS|IS)|-(?:NR|OS|IS|PRIV|NOCR)|\.PR\d*)$"
)


def _normalize_set_id(raw_id: str) -> str:
    """Strip known suffixes for fuzzy matching (e.g. 'I2S-1E:WI' → 'I2S-1E')."""
    return _SET_ID_SUFFIX_RE.sub("", raw_id.strip().upper())


def _fuzzy_lookup(key: str, lookup_dict: dict[str, int]) -> int:
    """Look up door count with fallback: exact → normalized → prefix match."""
    # Exact
    if key in lookup_dict:
        return lookup_dict[key]
    # Normalized
    norm = _normalize_set_id(key)
    if norm != key and norm in lookup_dict:
        return lookup_dict[norm]
    # Prefix: find longest key that is a prefix of norm, or vice versa
    best_count, best_len = 0, 0
    for dict_key, count in lookup_dict.items():
        dict_norm = _normalize_set_id(dict_key)
        if norm.startswith(dict_norm) or dict_norm.startswith(norm):
            if len(dict_norm) > best_len:
                best_count, best_len = count, len(dict_norm)
    return best_count


def _try_divide(raw_qty: int, divisor: int) -> tuple[int, bool]:
    """Try integer division. Returns (per_unit, success)."""
    if divisor > 1 and raw_qty >= divisor and raw_qty % divisor == 0:
        return raw_qty // divisor, True
    return raw_qty, False


def _leaf_count_from_openings(
    openings: list[DoorEntry],
    match_field: str,
    match_value: str,
    door_count: int,
) -> int:
    """Compute leaf count from Opening List entries for a hardware set.

    Checks door_type for "pair" / "PR" indicators. Each pair opening has
    2 leaves; each single opening has 1.  Falls back to door_count (all
    singles) when no matching entries are found.
    """
    if door_count <= 0:
        return door_count
    leaf_count = 0
    matched = False
    for door in openings:
        field_val = getattr(door, match_field, "").strip().upper()
        if field_val == match_value:
            matched = True
            if _PAIR_RE.search(door.door_type):
                leaf_count += 2
            else:
                leaf_count += 1
    return leaf_count if matched else door_count


def normalize_quantities(
    hardware_sets: list[HardwareSetDef],
    openings: list[DoorEntry],
) -> None:
    """Annotate items with division context — does NOT mutate item.qty.

    # ─── WHY THIS FUNCTION EXISTS AND WHAT IT MUST NOT DO ─────────────────────
    #
    # PHILOSOPHY (2026-04-13 overhaul — see PR #fix/qty-normalization-pipeline-overhaul):
    #
    #   The user's goal is faithful extraction, not silent quantity adjustment.
    #   Every number in this system should be traceable back to the PDF.
    #   Silently changing qty in Python caused cascading bugs:
    #
    #     1. Item names like '5BB1 HW 4 1/2 x 4 1/2 NRP' are catalog numbers,
    #        not English descriptions. _classify_hardware_item() returns None for
    #        them, so DIVISION_PREFERENCE defaulted to 'opening', dividing
    #        42 hinges by 6 doors → 7 per leaf instead of ~3-4 per leaf.
    #
    #     2. Non-integer division was rounded silently (42 ÷ 12 = 3.5 → 4),
    #        marked 'flagged', frozen by NEVER_RENORMALIZE in the TS layer,
    #        and the user had no way to see that the value came from an
    #        imprecise approximation.
    #
    #     3. The TS normalizeQuantities() pass received already-divided values
    #        and had to use the NEVER_RENORMALIZE guard to avoid double-dividing.
    #        That guard relies on Python having set qty_source correctly, which
    #        failed for unclassified items (source stayed 'parsed', not 'divided').
    #
    #     4. Darrin CP2 was told "quantities are already per-opening — don't change
    #        them" but was looking at Python-divided values. It had no way to
    #        distinguish a faithfully-extracted per-opening qty from a rounded
    #        approximation, so its domain expertise was effectively disabled.
    #
    # NEW CONTRACT:
    #
    #   Python's job is: determine HOW to divide (divisor, strategy), record that
    #   intention in metadata fields, but leave item.qty as the raw PDF number.
    #
    #   The single authoritative division pass lives in TS normalizeQuantities()
    #   in src/lib/parse-pdf-helpers.ts. It runs ONCE, after Darrin CP2 has seen
    #   the raw PDF values, and uses Python's annotations as hints.
    #
    #   qty_source values set here:
    #     'needs_division'  — Python determined a divisor; TS must divide
    #     'parsed'          — qty is already per-opening (door_count <= 1,
    #                         qty is plausible, no division needed)
    #     'needs_cap'       — single-door set, qty exceeds category max;
    #                         TS should apply the category cap (not Python)
    #
    #   Fields set here (never mutate item.qty):
    #     qty_total         — set to item.qty (the raw PDF value) when division
    #                         is recommended, so TS always has the original
    #     qty_door_count    — the recommended divisor (leaf_count or door_count)
    #
    # ─────────────────────────────────────────────────────────────────────────

    Strategy for determining the divisor (unchanged from before):
      Primary: heading block door count (most accurate)
      Fallback 1: Opening List hw_heading match
      Fallback 2: Opening List hw_set (generic) match
      Fallback 3: cross-field fuzzy match
    """
    # Build fallback dicts from Opening List
    doors_per_heading: dict[str, int] = {}
    doors_per_set: dict[str, int] = {}
    for door in openings:
        hid = door.hw_heading.strip().upper() if door.hw_heading else ""
        if hid:
            doors_per_heading[hid] = doors_per_heading.get(hid, 0) + 1
        sid = door.hw_set.strip().upper() if door.hw_set else ""
        if sid:
            doors_per_set[sid] = doors_per_set.get(sid, 0) + 1

    if doors_per_heading:
        logger.info(f"Doors per heading (Opening List): {doors_per_heading}")
    if doors_per_set:
        logger.info(f"Doors per set (Opening List): {doors_per_set}")

    # Pre-compute generic set totals for sub-heading normalization.
    # When multiple sub-headings (e.g., DH3.0, DH3.1) share a generic_set_id
    # (DH3), item quantities may be set-level totals that should be divided
    # by the TOTAL door count across all sub-headings, not just one.
    generic_totals: dict[str, tuple[int, int]] = {}  # gid → (total_doors, total_leaves)
    for hw_set in hardware_sets:
        gid = (hw_set.generic_set_id or hw_set.set_id).strip().upper()
        prev_d, prev_l = generic_totals.get(gid, (0, 0))
        generic_totals[gid] = (
            prev_d + hw_set.heading_door_count,
            prev_l + hw_set.heading_leaf_count,
        )
    # Also incorporate Opening List counts for generics (covers cases where
    # heading block door counts are missing but the Opening List has data)
    for gid, (total_d, total_l) in list(generic_totals.items()):
        if total_d == 0:
            ol_count = _fuzzy_lookup(gid, doors_per_set)
            if ol_count > 0:
                ol_leaves = _leaf_count_from_openings(
                    openings, "hw_set", gid, ol_count
                )
                generic_totals[gid] = (ol_count, ol_leaves)
                logger.info(
                    f"[qty-norm] Generic '{gid}': heading counts=0, "
                    f"using Opening List ({ol_count} doors, {ol_leaves} leaves)"
                )

    for gid, (td, tl) in generic_totals.items():
        if td > 0:
            logger.info(f"[qty-norm] Generic total '{gid}': {td} doors, {tl} leaves")

    for hw_set in hardware_sets:
        # --- Determine door count and leaf count ---
        door_count = hw_set.heading_door_count
        leaf_count = hw_set.heading_leaf_count

        if door_count > 0:
            logger.info(
                f"[qty-norm] {hw_set.set_id}: using heading block count "
                f"({door_count} openings, {leaf_count} leaves)"
            )
        else:
            # Fallback 1: Opening List hw_heading match (fuzzy)
            norm_heading = hw_set.set_id.strip().upper()
            door_count = _fuzzy_lookup(norm_heading, doors_per_heading)
            if door_count > 0:
                leaf_count = _leaf_count_from_openings(
                    openings, "hw_heading", norm_heading, door_count
                )
                logger.info(
                    f"[qty-norm] {hw_set.set_id}: fallback to Opening List "
                    f"heading match ({door_count} doors, {leaf_count} leaves)"
                )
            else:
                # Fallback 2: Opening List hw_set (generic) match (fuzzy)
                norm_set = hw_set.generic_set_id.strip().upper() if hw_set.generic_set_id else norm_heading
                door_count = _fuzzy_lookup(norm_set, doors_per_set)
                if door_count > 0:
                    leaf_count = _leaf_count_from_openings(
                        openings, "hw_set", norm_set, door_count
                    )
                    logger.info(
                        f"[qty-norm] {hw_set.set_id}: fallback to Opening List "
                        f"generic set match '{norm_set}' ({door_count} doors)"
                    )
                else:
                    # Fallback 3: search BOTH fields (catches column-swap errors)
                    norm_id = _normalize_set_id(norm_heading)
                    for door in openings:
                        h = _normalize_set_id(door.hw_heading) if door.hw_heading else ""
                        s = _normalize_set_id(door.hw_set) if door.hw_set else ""
                        if norm_id and (norm_id == h or norm_id == s
                                        or h.startswith(norm_id) or s.startswith(norm_id)):
                            door_count += 1
                    if door_count > 0:
                        leaf_count = _leaf_count_from_openings(
                            openings, "hw_heading", norm_heading, door_count
                        )
                        # Also check hw_set field in case columns were swapped
                        if leaf_count == door_count:
                            alt = _leaf_count_from_openings(
                                openings, "hw_set", norm_heading, door_count
                            )
                            if alt != door_count:
                                leaf_count = alt
                        logger.info(
                            f"[qty-norm] {hw_set.set_id}: fallback 3 cross-field "
                            f"match ({door_count} doors, {leaf_count} leaves)"
                        )

        # --- Sub-heading detection: check if this set belongs to a larger group ---
        gid = (hw_set.generic_set_id or hw_set.set_id).strip().upper()
        generic_doors, generic_leaves = generic_totals.get(gid, (0, 0))
        is_sub_heading = (
            hw_set.generic_set_id
            and hw_set.generic_set_id != hw_set.set_id
            and generic_doors > door_count
        )
        if is_sub_heading:
            logger.info(
                f"[qty-norm] {hw_set.set_id}: sub-heading of '{gid}' — "
                f"sub={door_count}d/{leaf_count}l, "
                f"generic={generic_doors}d/{generic_leaves}l"
            )

        # --- Per-heading quantity convention check ---
        #
        # When qty_convention is "per_opening" (detected from preamble phrases
        # like "Each opening to have:"), quantities are already per-opening and
        # should NOT be divided, regardless of door count.
        #
        # When a heading has only 1 door assigned, quantities are inherently
        # per-opening regardless of the global/detected convention.
        #
        # This check runs BEFORE the division logic to short-circuit correctly.
        convention = hw_set.qty_convention
        if convention == "per_opening" and door_count > 1:
            logger.info(
                f"[qty-norm] {hw_set.set_id}: qty_convention='per_opening' — "
                f"skipping division (quantities are already per-opening)"
            )
            for item in hw_set.items:
                item.qty_source = "parsed"
                item.qty_total = item.qty
                item.qty_door_count = door_count or None
            continue

        # --- Single door or unknown: annotate as 'needs_cap' if qty looks like an aggregate ---
        #
        # We no longer mutate item.qty here. Instead we signal to the TS layer
        # that it should apply a category cap if the raw value is implausibly high.
        # This preserves the raw PDF number while still flagging suspicious values.
        if door_count <= 1 and leaf_count <= 1:
            for item in hw_set.items:
                category = _classify_hardware_item(item.name)
                max_qty = _max_qty_for_category(category)
                raw_qty = item.qty
                if raw_qty > max_qty:
                    logger.warning(
                        f"[qty-norm] {hw_set.set_id}: '{item.name}' "
                        f"qty {raw_qty} exceeds category max {max_qty} "
                        f"(no door count available) — annotating needs_cap"
                    )
                    # Do NOT mutate item.qty. The TS layer reads 'needs_cap'
                    # and applies the cap with user-visible logging.
                    item.qty_source = "needs_cap"
                    item.qty_total = raw_qty      # preserve raw PDF value
                    item.qty_door_count = None    # no divisor known
            continue

        # --- Multi-door set: annotate with recommended divisor ---
        #
        # CRITICAL: we set qty_total, qty_door_count, qty_source='needs_division'
        # but we do NOT change item.qty. The TS normalizeQuantities() function
        # reads these annotations and performs the actual division ONCE.
        #
        # Rationale: Python can determine the correct divisor (leaf vs opening)
        # using DIVISION_PREFERENCE and the counts from the heading block, but
        # it cannot reliably classify items whose names are catalog numbers
        # (e.g. '5BB1 HW 4 1/2 x 4 1/2 NRP') rather than English descriptions.
        # Doing the math here silently produces wrong results for those items.
        # The TS taxonomy has the same limitation, but by deferring the division
        # to TS we at least ensure:
        #   1. Darrin CP2 sees the raw PDF qty and can apply domain knowledge
        #      (e.g. "42 hinges for 6 pair doors is 3-4 per leaf")
        #   2. The division happens exactly once
        #   3. The raw value is preserved in qty_total for audit/display
        for item in hw_set.items:
            raw_qty = item.qty
            item.qty_total = raw_qty   # always preserve raw PDF value

            category = _classify_hardware_item(item.name)
            pref = DIVISION_PREFERENCE.get(category, "opening")

            # --- Determine the recommended divisor ---
            recommended_divisor: int | None = None
            recommended_strategy: str = "unknown"

            if pref == "leaf" and leaf_count > 1:
                # Per-leaf items (hinges, pivots, continuous hinges):
                # recommend dividing by leaf count.
                # If leaf_count is not available, fall back to door_count.
                recommended_divisor = leaf_count
                recommended_strategy = "leaf"
            elif pref == "leaf" and door_count > 1:
                # Per-leaf item but leaf_count is not available.
                # Fall back to door_count as best-available divisor.
                recommended_divisor = door_count
                recommended_strategy = "door_fallback"
            elif pref == "opening_only" and door_count > 1:
                # Items that exist once per opening, never per-leaf.
                # (coordinators, astragals, seals, thresholds, flush bolts)
                recommended_divisor = door_count
                recommended_strategy = "opening_only"
            elif pref == "opening" and door_count > 1:
                # Per-opening items (closers, locksets): divide by door count.
                # Note: the old code tried leaf_count as a fallback here, which
                # was wrong — a closer is 1 per opening not 1 per leaf.
                recommended_divisor = door_count
                recommended_strategy = "opening"

            if recommended_divisor and recommended_divisor > 1 and raw_qty >= recommended_divisor:
                # Annotate: TS should divide raw_qty by recommended_divisor.
                item.qty_door_count = recommended_divisor
                item.qty_source = "needs_division"
                logger.info(
                    f"[qty-norm] {hw_set.set_id}: '{item.name}' "
                    f"raw={raw_qty}, recommend ÷{recommended_divisor} "
                    f"(category={category}, strategy={recommended_strategy})"
                )
            elif raw_qty < (recommended_divisor or 2):
                # raw qty is smaller than the divisor — it is likely already
                # per-opening (e.g. a single closer in a multi-door set).
                item.qty_source = "parsed"
                item.qty_door_count = recommended_divisor or door_count or None
                logger.info(
                    f"[qty-norm] {hw_set.set_id}: '{item.name}' "
                    f"raw={raw_qty} < divisor={recommended_divisor} "
                    f"— treating as already per-opening (parsed)"
                )
            else:
                # No divisor determined (counts unavailable or item is
                # unclassified with raw qty that doesn't fit any pattern).
                # Leave qty_source as 'parsed' and let TS/Darrin flag it.
                item.qty_source = "parsed"
                item.qty_door_count = None
                logger.warning(
                    f"[qty-norm] {hw_set.set_id}: '{item.name}' "
                    f"raw={raw_qty} — no divisor determined "
                    f"(category={category}, pref={pref}, "
                    f"door_count={door_count}, leaf_count={leaf_count})"
                )

        # --- Sub-heading: record generic set context for TS sub-heading logic ---
        #
        # If this set is a sub-heading under a larger generic group (e.g. DH3.0
        # under DH3), the TS layer needs to know the generic total so it can
        # re-divide items that are set-level totals rather than sub-heading totals.
        # We do this by stamping qty_door_count with the sub-heading divisor above
        # and trusting the heading_door_count / heading_leaf_count fields on the
        # set for the TS sub-heading sanity pass (those are already populated).
        #
        # No additional mutation needed here — TS reads hw_set.heading_door_count
        # and hw_set.generic_set_id to reconstruct the generic total on its own.
        pass  # sub-heading annotation is implicit via heading metadata fields

    # === Cross-item combination rules ===
    # These rules catch patterns that single-item normalization can't detect.
    _RHR_LHR_RE = re.compile(r"(?i)\b(RHR|LHR|RH|LH)\b")

    for hw_set in hardware_sets:
        # --- Rule: RHR/LHR variant pairing ---
        # When a set has both RHR and LHR variants of the same item, each
        # door gets ONE variant based on its hand. The combined qty for both
        # variants should equal door count, not be divided independently.
        items_by_base: dict[str, list[HardwareItem]] = {}
        for item in hw_set.items:
            base_name = _RHR_LHR_RE.sub("", item.name).strip()
            base_model = _RHR_LHR_RE.sub("", item.model).strip() if item.model else ""
            key = f"{base_name}|{base_model}".lower()
            items_by_base.setdefault(key, []).append(item)

        for key, variants in items_by_base.items():
            if len(variants) < 2:
                continue
            hands = set()
            for v in variants:
                m = _RHR_LHR_RE.search(v.name + " " + (v.model or ""))
                if m:
                    hands.add(m.group(1).upper()[:2])  # normalize to RH/LH
            if len(hands) >= 2:
                # Both RH and LH present — each variant's qty should be 1
                # (one per door of that hand). If not 1, annotate so the TS
                # layer can override.
                #
                # We no longer mutate v.qty here; instead we signal via
                # qty_source='rhr_lhr_pair' so the TS layer can set qty=1
                # with the user's awareness. The raw PDF total is preserved
                # in qty_total as always.
                for v in variants:
                    if v.qty_source == "needs_division":
                        logger.info(
                            f"[qty-norm] {hw_set.set_id}: '{v.name}' "
                            f"RHR/LHR variant pair detected — annotating "
                            f"rhr_lhr_pair so TS sets qty=1"
                        )
                        v.qty_source = "rhr_lhr_pair"

        # --- Rule: Auto operator + closer conflict ---
        # When an automatic operator is present, it typically replaces the
        # closer function. Flag the combination for user review.
        has_auto_op = any(
            _classify_hardware_item(item.name) == "auto_operator"
            for item in hw_set.items
        )
        if has_auto_op:
            for item in hw_set.items:
                if _classify_hardware_item(item.name) == "closer":
                    logger.warning(
                        f"[qty-norm] {hw_set.set_id}: auto operator AND "
                        f"closer both present — closer '{item.name}' may "
                        f"be redundant (operator replaces closer function)"
                    )
                    # Don't auto-remove — flag for user review.
                    # If division was recommended, change to 'needs_review'
                    # so the TS layer and Darrin both see this as ambiguous.
                    if item.qty_source == "needs_division":
                        item.qty_source = "needs_review"


# --- Vercel Handler ---

class handler(BaseHTTPRequestHandler):
    def do_POST(self):
        try:
            if not require_internal_token(self):
                return

            content_length = int(self.headers.get("Content-Length", 0))
            raw_body = self.rfile.read(content_length)
            try:
                body_str = raw_body.decode("utf-8")
            except UnicodeDecodeError as ue:
                self._send_json(400, ExtractionResult(
                    success=False,
                    error=f"Request body is not valid UTF-8: {ue}"
                ))
                return
            try:
                data = json.loads(body_str)
            except json.JSONDecodeError as je:
                self._send_json(400, ExtractionResult(
                    success=False,
                    error=f"Request body is not valid JSON: {je}"
                ))
                return

            pdf_base64 = data.get("pdf_base64", "")
            raw_mapping = data.get("user_column_mapping")  # Optional override
            user_column_mapping = normalize_mapping_keys(raw_mapping)
            logger.info(f"[extract-tables] raw_mapping from request: {raw_mapping}")
            logger.info(f"[extract-tables] normalized user_column_mapping: {user_column_mapping}")
            if not pdf_base64:
                self._send_json(400, ExtractionResult(
                    success=False,
                    error="Missing pdf_base64 in request body"
                ))
                return

            # Decode base64 PDF
            pdf_bytes = base64.b64decode(pdf_base64)
            pdf_file = io.BytesIO(pdf_bytes)

            # --- Region extraction: bbox + target_page ---
            bbox_data = data.get("bbox")
            target_page = data.get("target_page")
            if bbox_data is not None and target_page is not None:
                self._handle_region_extract(pdf_bytes, target_page, bbox_data)
                return

            with pdfplumber.open(pdf_file, unicode_norm="NFKC") as pdf:
                # Phase 1: Extract Hardware Sets (text-alignment detection)
                hardware_sets = extract_all_hardware_sets(pdf)

                # Phase 2: Extract Opening List via table grid detection
                # If user provided a confirmed column mapping, use it
                openings, tables_found = extract_opening_list(pdf, user_column_mapping)
                logger.info(f"[extract-tables] extract_opening_list: {len(openings)} doors, {tables_found} tables")

                # Phase 2.5: Schedule-format fallback — if no tabular opening
                # list found but hardware sets exist, extract door assignments
                # from heading blocks on hardware set pages
                if len(openings) == 0 and len(hardware_sets) > 0:
                    logger.info("[extract-tables] No tabular opening list found, trying inline door extraction from heading blocks")
                    inline_doors = extract_inline_doors_from_sets(pdf, hardware_sets)
                    if inline_doors:
                        openings = inline_doors
                        logger.info(f"[extract-tables] Inline door extraction found {len(openings)} doors")

                # Phase 2.6: BUG-25 — Merge doors from "N Single/Pair Door #XXX" lines
                # in hardware schedule headings. Complements Phase 2.5 by catching
                # doors listed in heading blocks that inline extraction missed.
                heading_doors = extract_doors_from_set_headings(pdf)
                if heading_doors:
                    existing_nums = {d.door_number for d in openings}
                    added = 0
                    for hd in heading_doors:
                        if hd.door_number not in existing_nums:
                            openings.append(hd)
                            existing_nums.add(hd.door_number)
                            added += 1
                    if added:
                        logger.info(f"[extract-tables] Merged {added} doors from heading blocks (total now {len(openings)})")

                # Phase 3: Extract reference tables
                reference_codes = extract_reference_tables(pdf)

                # Phase 3.1: Filter garbage + split concatenated fields (BUG-12)
                apply_field_splitting(hardware_sets, reference_codes)

                # Phase 3.5: Normalize item qty from total → per-opening/per-leaf
                normalize_quantities(hardware_sets, openings)

                # Phase 4: Pattern consensus validation
                # Flag door numbers that don't match the dominant structural
                # pattern. These are presented to the user for review, NOT
                # silently removed.
                confirmed_doors, flagged_doors = validate_door_number_consistency(openings)

                # Determine confidence level based on extraction results
                notes: list[str] = []
                confidence = "high"

                if len(confirmed_doors) == 0 and len(hardware_sets) > 0:
                    confidence = "low"
                    notes.append("No door openings found — hardware sets extracted but opening list could not be parsed. Manual review recommended.")
                elif len(confirmed_doors) == 0 and len(hardware_sets) == 0:
                    confidence = "low"
                    notes.append("No doors or hardware sets found. The PDF format may not be supported by auto-extraction.")
                elif len(flagged_doors) > len(confirmed_doors) * 0.3:
                    confidence = "medium"
                    notes.append(f"{len(flagged_doors)} door numbers flagged as potentially incorrect — review recommended.")
                elif tables_found == 0:
                    confidence = "medium"
                    notes.append("No structured tables detected — data extracted via text position analysis.")

                result = ExtractionResult(
                    success=len(confirmed_doors) > 0 or len(hardware_sets) > 0,
                    openings=confirmed_doors,
                    hardware_sets=hardware_sets,
                    reference_codes=reference_codes,
                    flagged_doors=flagged_doors,
                    expected_door_count=len(confirmed_doors) + len(flagged_doors),
                    tables_found=tables_found,
                    hw_sets_found=len(hardware_sets),
                    method="pdfplumber",
                    confidence=confidence,
                    extraction_notes=notes,
                )

            self._send_json(200, result)

        except Exception as e:
            traceback.print_exc()
            self._send_json(500, ExtractionResult(
                success=False,
                error=f"Extraction failed: {str(e)}"
            ))

    def _handle_region_extract(self, pdf_bytes: bytes, target_page: int, bbox_data: dict):
        """Extract hardware items from a cropped region of a single PDF page."""
        try:
            pdf_file = io.BytesIO(pdf_bytes)
            with pdfplumber.open(pdf_file, unicode_norm="NFKC") as pdf:
                if target_page < 0 or target_page >= len(pdf.pages):
                    self._send_region_json(400, RegionExtractionResult(
                        success=False,
                        error=f"Page {target_page} out of range (PDF has {len(pdf.pages)} pages)"
                    ))
                    return

                page = pdf.pages[target_page]
                width = float(page.width)
                height = float(page.height)

                # Convert 0-1 percentage bbox to PDF points
                x0 = float(bbox_data.get("x0", 0)) * width
                y0 = float(bbox_data.get("y0", 0)) * height
                x1 = float(bbox_data.get("x1", 1)) * width
                y1 = float(bbox_data.get("y1", 1)) * height

                # Clamp to page bounds
                x0 = max(0, min(x0, width))
                y0 = max(0, min(y0, height))
                x1 = max(0, min(x1, width))
                y1 = max(0, min(y1, height))

                if x1 - x0 < 1 or y1 - y0 < 1:
                    self._send_region_json(400, RegionExtractionResult(
                        success=False,
                        error="Selection region is too small"
                    ))
                    return

                logger.info(
                    f"[region-extract] page={target_page}, "
                    f"bbox=({x0:.1f}, {y0:.1f}, {x1:.1f}, {y1:.1f}) "
                    f"page_size=({width:.1f}, {height:.1f})"
                )

                # pdfplumber crop: (x0, top, x1, bottom)
                cropped = page.crop((x0, y0, x1, y1))
                cropped_text = cropped.extract_text() or ""

                items: list[HardwareItem] = []

                # Strategy 1: Full set extraction (works if heading is in selection)
                sets = extract_hardware_sets_from_page(cropped, cropped_text)
                for s in sets:
                    items.extend(s.items)

                # Strategy 2: Direct table extraction on cropped region
                if not items:
                    tables = cropped.extract_tables(
                        table_settings={
                            "vertical_strategy": "text",
                            "horizontal_strategy": "text",
                            "intersection_tolerance": 5,
                            "snap_tolerance": 5,
                            "join_tolerance": 8,
                            "min_words_vertical": 2,
                            "min_words_horizontal": 1,
                            "text_x_tolerance": 5,
                            "text_y_tolerance": 3,
                        }
                    )
                    if not tables:
                        tables = cropped.extract_tables(
                            table_settings={
                                "vertical_strategy": "lines",
                                "horizontal_strategy": "lines",
                                "intersection_tolerance": 5,
                                "snap_tolerance": 5,
                            }
                        )
                    if tables:
                        items = parse_items_from_raw_tables(tables)

                # Strategy 3: Text-based fallback
                if not items:
                    items = extract_hw_items_from_text(cropped_text)

                # Deduplicate
                if items:
                    items = deduplicate_hardware_items(items)

                logger.info(f"[region-extract] Extracted {len(items)} items from cropped region")

                self._send_region_json(200, RegionExtractionResult(
                    success=len(items) > 0,
                    items=items,
                    raw_text=cropped_text.strip(),
                    error="" if items else "No hardware items found in selected region"
                ))
        except Exception as e:
            traceback.print_exc()
            self._send_region_json(500, RegionExtractionResult(
                success=False,
                error=f"Region extraction failed: {str(e)}"
            ))

    def _send_json(self, status: int, result: ExtractionResult):
        body = result.model_dump_json()
        body_bytes = body.encode()
        logger.info(f"[extract-tables] Sending response: status={status}, body_size={len(body_bytes)} bytes, "
                     f"openings={len(result.openings)}, hw_sets={len(result.hardware_sets)}")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body_bytes)))
        self.end_headers()
        self.wfile.write(body_bytes)

    def _send_region_json(self, status: int, result: RegionExtractionResult):
        body = result.model_dump_json()
        body_bytes = body.encode()
        logger.info(f"[region-extract] Sending response: status={status}, items={len(result.items)}")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body_bytes)))
        self.end_headers()
        self.wfile.write(body_bytes)
