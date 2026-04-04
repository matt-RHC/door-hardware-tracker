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
import io
import json
import logging
import re
import traceback
import unicodedata
from http.server import BaseHTTPRequestHandler

logger = logging.getLogger("extract-tables")
logging.basicConfig(level=logging.INFO)

import pdfplumber
from pydantic import BaseModel


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


class HardwareSetDef(BaseModel):
    set_id: str              # heading-level ID (e.g., "I2S-1E:WI")
    generic_set_id: str = "" # set-level ID (e.g., "I2S-1E") for UI grouping
    heading: str = ""
    heading_door_count: int = 0   # openings listed in heading block
    heading_leaf_count: int = 0   # total leaves (pairs × 2, singles × 1)
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


# --- Category-Aware Quantity Validation ---
# Expected per-opening quantity ranges by hardware category.
# Values outside these ranges are likely aggregate/total quantities.
EXPECTED_QTY_RANGES: dict[str, tuple[int, int]] = {
    "hinge":              (2, 5),   # 3 standard, 4-5 for tall/heavy doors
    "continuous_hinge":   (1, 2),
    "pivot":              (1, 2),
    "lockset":            (1, 1),
    "exit_device":        (1, 2),
    "flush_bolt":         (1, 2),
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

# Map item names to categories using keyword matching
_CATEGORY_PATTERNS: list[tuple[str, re.Pattern]] = [
    ("continuous_hinge", re.compile(r"(?i)continuous\s*hinge|cont\.?\s*hinge")),
    ("hinge",     re.compile(r"(?i)\bhinge|pivot|spring\s*hinge")),
    ("pivot",     re.compile(r"(?i)\bpivot\b")),
    ("lockset",   re.compile(r"(?i)lockset|latchset|latch\s*set|lock\s*set|passage|privacy|storeroom|classroom|entrance|mortise|cylindrical|deadbolt")),
    ("exit_device", re.compile(r"(?i)exit\s*device|panic|rim\s*device|concealed\s*vertical|surface\s*vertical|push\s*bar|touch\s*bar")),
    ("flush_bolt", re.compile(r"(?i)flush\s*bolt|surface\s*bolt")),
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

# Pattern to match hardware set heading lines like:
# "Heading #DH4.1 (Set #DH4-R-NOCR)" or "Hardware Set DH1" or "SET: DH2"
HW_SET_HEADING_PATTERN = re.compile(
    r"(?i)"
    r"(?:"
    r"heading\s*#?\s*([A-Z0-9][A-Z0-9.\-:]*)\s*\(set\s*#?\s*([A-Z0-9][A-Z0-9.\-]*)\)"  # Heading #X (Set #Y)
    r"|"
    r"(?:hardware\s+)?set\s*[:# ]\s*([A-Z0-9][A-Z0-9.\-]*)"  # Hardware Set DH1 / SET: DH2
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
    Must have at least a door number column and one of hw_set or location.
    """
    mapping = detect_column_mapping(headers)
    has_door = "door_number" in mapping
    has_secondary = "hw_set" in mapping or "location" in mapping
    return has_door and has_secondary


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
    # Simple numeric: 101, 1001 (3-4 digits, optionally with letter suffix)
    # Bare 2-digit numbers (20, 94) are quantities/page numbers, not doors
    r'^\d{3,4}[A-Z]?$',
    # Letter prefix: A101, B2145, N101
    r'^[A-Z]{1,2}\d{2,4}[A-Z]?$',
    # Period-separated sub-doors: 101.1, A101.2
    r'^[A-Z]?\d{2,4}\.\d{1,2}$',
    # Compound dot-separated: 1.01.A.01A, 2.01.F.06E
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
    r'^(?:EXIT|STOR|ELEC|MECH|STAIR|CORR|VEST|LOBBY|OFFICE)[-]?\d*$',
]

# Explicit blocklist for known hardware set prefixes
HARDWARE_SET_PREFIXES = frozenset({
    'DH', 'DCB', 'HM', 'HMS', 'HW', 'HS', 'HD', 'FH', 'AH',
    'SET', 'TYPE', 'GRP', 'GROUP', 'STYLE',
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

    # Reject phone number patterns
    if re.match(r'^\d{3}-\d{3}-\d{4}$', clean):
        return False

    # Reject if it matches a hardware set pattern
    for pattern in HARDWARE_SET_PATTERNS:
        if re.match(pattern, clean, re.IGNORECASE):
            if log_rejections:
                print(f"[DOOR_VALIDATION] Rejected '{val}': matches HW set pattern {pattern}")
            return False

    # Reject known hardware set prefixes (short codes only)
    for prefix in HARDWARE_SET_PREFIXES:
        if clean.startswith(prefix) and len(clean) <= len(prefix) + 2:
            if log_rejections:
                print(f"[DOOR_VALIDATION] Rejected '{val}': HW set prefix {prefix}")
            return False

    # Must match at least one positive door number pattern
    for pattern in DOOR_NUMBER_PATTERNS:
        if re.match(pattern, clean):
            return True

    # Fallback: if it has 3+ consecutive digits and isn't a set ID, cautiously accept
    # This catches unconventional numbering we haven't seen yet.
    # Require 3+ digits to avoid matching bare quantities (20, 94, etc.)
    # Reject pure-digit strings > 4 chars (project/document numbers like 303872)
    if re.match(r'^\d{5,}$', clean):
        if log_rejections:
            print(f"[DOOR_VALIDATION] Rejected '{val}': pure numeric > 4 digits (project/doc number)")
        return False
    if re.search(r'\d{3,}', clean) and len(clean) >= 3 and len(clean) <= 12:
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

    # Group 1 = heading ID (from "Heading #X (Set #Y)" format, includes :suffix)
    # Group 2 = generic set ID (from same format)
    # Group 3 = set ID (from "Hardware Set X" / "SET: X" format)
    heading_id = ""
    generic_set_id = ""

    if m.group(1) and m.group(2):
        # "Heading #I2S-1E:WI (Set #I2S-1E)" → heading=I2S-1E:WI, generic=I2S-1E
        heading_id = m.group(1).strip()
        generic_set_id = m.group(2).strip()
    elif m.group(3):
        # "Hardware Set DH1" → both are the same
        heading_id = m.group(3).strip()
        generic_set_id = m.group(3).strip()
    elif m.group(1):
        # Heading number only (fallback)
        heading_id = m.group(1).strip()
        generic_set_id = m.group(1).strip()

    # Try to extract the heading description
    heading = ""
    lines = text.split("\n")
    for line in lines:
        if HW_SET_HEADING_PATTERN.search(line):
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

    return (heading_id, generic_set_id, heading)


# Pattern to count doors listed in heading block: "1 Pair Doors #..." or "1 Single Door #..."
HEADING_DOOR_LINE = re.compile(
    r"(\d+)\s+(Pair|Single)\s+Doors?\s+#",
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


def extract_hardware_sets_from_page(page, page_text: str) -> list[HardwareSetDef]:
    """
    Extract hardware set definitions from a single page using text-alignment
    table detection (for transparent/invisible grid lines).
    """
    sets: list[HardwareSetDef] = []

    heading_id, generic_set_id, heading = parse_hw_set_id_from_text(page_text)
    if not heading_id:
        return sets

    # Count doors from the heading block (e.g., "1 Pair Doors #1.01.B.03A")
    heading_door_count, heading_leaf_count = count_heading_doors(page_text)

    # Try text-based table extraction first (for transparent grid lines)
    tables = page.extract_tables(
        table_settings={
            "vertical_strategy": "text",
            "horizontal_strategy": "text",
            "intersection_tolerance": 5,
            "snap_tolerance": 5,
            "join_tolerance": 5,
            "min_words_vertical": 2,
            "min_words_horizontal": 1,
            "text_x_tolerance": 3,
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

    items: list[HardwareItem] = []

    for table in tables:
        if not table or len(table) < 2:
            continue

        # Detect which table this is — we want the hardware items table
        # Hardware items tables typically have columns like:
        # Qty | Item/Description | Manufacturer | Model/Catalog | Finish
        header_row = [clean_cell(c) for c in table[0]]
        header_text_lower = " ".join(header_row).lower()

        # Skip if this looks like a door list table (has door_number column)
        if is_opening_list_table(header_row):
            continue

        # Detect hardware items table by looking for qty + item/description columns
        qty_col = None
        total_qty_col = None  # "Total Qty" / "Ext Qty" — aggregate, skip this
        name_col = None
        mfr_col = None
        model_col = None
        finish_col = None

        for i, h in enumerate(header_row):
            hl = h.lower()
            # Detect "total qty", "ext qty", "extended qty" — these are aggregate columns
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

        # If we found a total_qty_col but no per-set qty_col, detect which
        # column type we're dealing with using value heuristics.
        is_aggregate_qty = False
        if qty_col is None and total_qty_col is not None:
            qty_col = total_qty_col
            is_aggregate_qty = True  # Flag for normalization below
        elif qty_col is not None:
            # Validate with heuristics: if >60% of values are >6,
            # it's likely an aggregate column (total qty, not per-opening)
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
                    logger.info(f"Qty column detected as aggregate ({over_threshold}/{len(qty_values)} values > 6)")

        # If we didn't find explicit headers, try positional inference
        # Many submittals have: Qty | Description | Manufacturer | Catalog No. | Finish
        if qty_col is None and name_col is None and len(header_row) >= 3:
            # Check if first column values look like quantities (small integers)
            data_rows = table[1:6]  # sample first 5 data rows
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

        # Need at least name to extract items
        if name_col is None and qty_col is None:
            continue

        # If we only have qty_col, name is likely the next column
        if name_col is None and qty_col is not None:
            name_col = qty_col + 1

        for row in table[1:]:
            cells = [clean_cell(c) for c in row]

            # Get item name
            name_val = cells[name_col] if name_col is not None and name_col < len(cells) else ""
            if not name_val:
                continue

            # Skip rows that look like notes, totals, or continuation text
            name_lower = name_val.lower()
            if name_lower in ("total", "totals", "note", "notes", ""):
                continue
            if name_lower.startswith("note:") or name_lower.startswith("*"):
                continue

            # Validate it looks like a hardware item (or "by others" / "not used")
            # Be lenient — some items have unusual names
            if not HARDWARE_ITEM_NAMES.search(name_val) and len(name_val) < 3:
                continue

            # Get raw qty — pass through as-is; normalization happens in handler
            # after we know the door count per set.
            qty_val = 1
            if qty_col is not None and qty_col < len(cells):
                raw_qty = cells[qty_col].strip()
                # Handle text-only units: "EA", "PR", "SET" → default qty 1
                if re.match(r"^(EA|PR|SET|PAIR|EACH)\.?$", raw_qty, re.IGNORECASE):
                    qty_val = 1
                else:
                    qty_match = re.match(r"-?(\d+)", raw_qty)
                    if qty_match:
                        qty_val = int(qty_match.group(1))  # abs via group(1)
                        # Zero qty → default to 1
                        if qty_val == 0:
                            qty_val = 1

            # Handle text wrapping — if name is very long and contains what looks
            # like a split model/finish, try to separate
            # e.g. "Lockset Schlage ND50PD RHO 626" when columns collapsed
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
    """
    all_sets: list[HardwareSetDef] = []
    seen_set_ids: set[str] = set()

    for page_num, page in enumerate(pdf.pages):
        text = page.extract_text() or ""

        if not is_hardware_set_page(text):
            continue

        # A single page might have multiple sets (less common but possible)
        # For now, extract per-page (most submittals = 1 set per page)
        page_sets = extract_hardware_sets_from_page(page, text)

        for hw_set in page_sets:
            if hw_set.set_id in seen_set_ids:
                # Merge items if same set appears on multiple pages (continuation)
                for existing in all_sets:
                    if existing.set_id == hw_set.set_id:
                        existing.items.extend(hw_set.items)
                        # Dedup after merge to catch cross-page duplicates
                        existing.items = deduplicate_hardware_items(existing.items)
                        break
            else:
                seen_set_ids.add(hw_set.set_id)
                all_sets.append(hw_set)

    return all_sets


# --- Opening List Extraction ---

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

    for page_num, page in enumerate(pdf.pages):
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
                )
                all_doors.append(entry)

    # Merge results from text-alignment strategy (may find doors on pages without grid lines)
    text_align_doors, ta_tables = extract_opening_list_text_align(pdf, user_column_mapping)
    existing_nums = {d.door_number for d in all_doors}
    for d in text_align_doors:
        if d.door_number not in existing_nums:
            all_doors.append(d)
            existing_nums.add(d.door_number)
    tables_found += ta_tables

    # Merge results from word-position fallback (catches remaining stragglers)
    word_doors, w_tables = extract_opening_list_text(pdf)
    for d in word_doors:
        if d.door_number not in existing_nums:
            all_doors.append(d)
            existing_nums.add(d.door_number)
    tables_found += w_tables

    return all_doors, tables_found


def extract_opening_list_text_align(
    pdf: pdfplumber.PDF,
    user_column_mapping: dict[str, int] | None = None,
) -> tuple[list[DoorEntry], int]:
    """
    Try text-alignment based table extraction for Opening List.
    Useful when the table has transparent grid lines.
    """
    all_doors: list[DoorEntry] = []
    tables_found = 0
    seen_door_numbers: set[str] = set()

    for page in pdf.pages:
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


def extract_opening_list_text(pdf: pdfplumber.PDF) -> tuple[list[DoorEntry], int]:
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

    pages_since_header = 0  # Track how many pages since last header seen

    for page in pdf.pages:
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

            entry = DoorEntry(
                door_number=door_num,
                hw_set=clean_cell(vals.get("hw_set", "")),
                hw_heading=clean_cell(vals.get("hw_heading", "")),
                location=clean_cell(vals.get("location", "")),
                door_type=clean_cell(vals.get("door_type", "")),
                frame_type=clean_cell(vals.get("frame_type", "")),
                fire_rating=clean_cell(vals.get("fire_rating", "")),
                hand=clean_cell(vals.get("hand", "")),
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

        for table in tables:
            if not table or len(table) < 2:
                continue

            headers = [clean_cell(c) for c in table[0]]
            header_text = " ".join(headers)

            code_type = None
            if MANUFACTURER_HEADER.search(header_text):
                code_type = "manufacturer"
            elif FINISH_HEADER.search(header_text):
                code_type = "finish"
            elif OPTION_HEADER.search(header_text):
                code_type = "option"

            if not code_type:
                page_text_lines = text.split("\n")
                for line in page_text_lines:
                    if MANUFACTURER_HEADER.search(line):
                        code_type = "manufacturer"
                        break
                    elif FINISH_HEADER.search(line):
                        code_type = "finish"
                        break
                    elif OPTION_HEADER.search(line):
                        code_type = "option"
                        break

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


# --- Vercel Handler ---

class handler(BaseHTTPRequestHandler):
    def do_POST(self):
        try:
            content_length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(content_length)
            data = json.loads(body)

            pdf_base64 = data.get("pdf_base64", "")
            raw_mapping = data.get("user_column_mapping")  # Optional override
            user_column_mapping = normalize_mapping_keys(raw_mapping)
            if not pdf_base64:
                self._send_json(400, ExtractionResult(
                    success=False,
                    error="Missing pdf_base64 in request body"
                ))
                return

            # Decode base64 PDF
            pdf_bytes = base64.b64decode(pdf_base64)
            pdf_file = io.BytesIO(pdf_bytes)

            with pdfplumber.open(pdf_file, unicode_norm="NFKC") as pdf:
                # Phase 1: Extract Hardware Sets (text-alignment detection)
                hardware_sets = extract_all_hardware_sets(pdf)

                # Phase 2: Extract Opening List via table grid detection
                # If user provided a confirmed column mapping, use it
                openings, tables_found = extract_opening_list(pdf, user_column_mapping)

                # Phase 3: Extract reference tables
                reference_codes = extract_reference_tables(pdf)

                # Phase 3.5: Normalize item qty from total → per-opening/per-leaf
                #
                # Primary source: heading block door count (most accurate)
                # Fallback: Opening List hw_heading / hw_set matching
                # Last resort: category cap
                #
                # Division strategy: try leaf count first (most items are per-leaf),
                # then opening count (per-opening items like coordinators, flush bolts).
                # If neither divides evenly, flag for AI review.

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
                        # Fallback 1: Opening List hw_heading match
                        norm_heading = hw_set.set_id.strip().upper()
                        door_count = doors_per_heading.get(norm_heading, 0)
                        leaf_count = door_count  # assume single if unknown from heading
                        if door_count > 0:
                            logger.info(
                                f"[qty-norm] {hw_set.set_id}: fallback to Opening List "
                                f"heading match ({door_count} doors)"
                            )
                        else:
                            # Fallback 2: Opening List hw_set (generic) match
                            norm_set = hw_set.generic_set_id.strip().upper() if hw_set.generic_set_id else norm_heading
                            door_count = doors_per_set.get(norm_set, 0)
                            leaf_count = door_count
                            if door_count > 0:
                                logger.info(
                                    f"[qty-norm] {hw_set.set_id}: fallback to Opening List "
                                    f"generic set match '{norm_set}' ({door_count} doors)"
                                )

                    # --- Single door or unknown: category cap fallback ---
                    if door_count <= 1 and leaf_count <= 1:
                        for item in hw_set.items:
                            category = _classify_hardware_item(item.name)
                            max_qty = _max_qty_for_category(category)
                            raw_qty = item.qty
                            if raw_qty > max_qty:
                                logger.warning(
                                    f"[qty-cap-fallback] {hw_set.set_id}: '{item.name}' "
                                    f"qty {raw_qty} capped to {max_qty} (no door count)"
                                )
                                item.qty = max_qty
                                item.qty_source = "capped"
                                item.qty_total = raw_qty
                                item.qty_door_count = None
                        continue

                    # --- Multi-door set: divide quantities ---
                    for item in hw_set.items:
                        raw_qty = item.qty
                        item.qty_total = raw_qty
                        divided = False

                        # Try 1: divide by leaf count (per-leaf items: hinges, closers, etc.)
                        if leaf_count > 1 and raw_qty >= leaf_count:
                            per_leaf = raw_qty / leaf_count
                            if per_leaf == int(per_leaf):
                                item.qty = int(per_leaf)
                                item.qty_door_count = leaf_count
                                item.qty_source = "divided"
                                divided = True
                                logger.info(
                                    f"[qty-norm] {hw_set.set_id}: '{item.name}' "
                                    f"{raw_qty} ÷ {leaf_count} leaves = {item.qty}"
                                )

                        # Try 2: divide by opening count (per-opening items: coordinator, etc.)
                        if not divided and door_count > 1 and door_count != leaf_count and raw_qty >= door_count:
                            per_opening = raw_qty / door_count
                            if per_opening == int(per_opening):
                                item.qty = int(per_opening)
                                item.qty_door_count = door_count
                                item.qty_source = "divided"
                                divided = True
                                logger.info(
                                    f"[qty-norm] {hw_set.set_id}: '{item.name}' "
                                    f"{raw_qty} ÷ {door_count} openings = {item.qty}"
                                )

                        # Neither worked
                        if not divided:
                            if raw_qty < min(door_count, leaf_count):
                                # qty smaller than door count → likely already per-unit
                                item.qty_source = "parsed"
                                item.qty_door_count = leaf_count
                            else:
                                # Doesn't divide evenly by leaves or openings → flag
                                item.qty_source = "flagged"
                                item.qty_door_count = leaf_count
                                logger.warning(
                                    f"[qty-norm] {hw_set.set_id}: '{item.name}' "
                                    f"qty {raw_qty} doesn't divide evenly by "
                                    f"{leaf_count} leaves or {door_count} openings, flagged"
                                )

                    # Sanity-check: if divided qty still exceeds category max, flag
                    for item in hw_set.items:
                        if item.qty_source == "divided":
                            category = _classify_hardware_item(item.name)
                            max_qty = _max_qty_for_category(category)
                            if item.qty > max_qty:
                                logger.warning(
                                    f"[qty-norm] {hw_set.set_id}: '{item.name}' "
                                    f"divided qty {item.qty} exceeds category max "
                                    f"{max_qty}, flagging for review"
                                )
                                item.qty_source = "flagged"

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

    def _send_json(self, status: int, result: ExtractionResult):
        body = result.model_dump_json()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body.encode())
