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
import re
import traceback
import unicodedata
from http.server import BaseHTTPRequestHandler

import pdfplumber
from pydantic import BaseModel


# --- Pydantic Models ---

class HardwareItem(BaseModel):
    qty: int = 1
    name: str = ""
    manufacturer: str = ""
    model: str = ""
    finish: str = ""


class HardwareSetDef(BaseModel):
    set_id: str
    heading: str = ""
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


class ExtractionResult(BaseModel):
    success: bool
    openings: list[DoorEntry] = []
    hardware_sets: list[HardwareSetDef] = []
    reference_codes: list[ReferenceCode] = []
    expected_door_count: int = 0
    tables_found: int = 0
    hw_sets_found: int = 0
    method: str = "pdfplumber"
    error: str = ""


# --- Column Detection for Opening List ---

DOOR_NUMBER_PATTERNS = re.compile(
    r"(?i)^(open(ing)?|door)\s*(no\.?|num(ber)?|#|tag)|^#$|^no\.?$|^tag$"
)
HW_SET_PATTERNS = re.compile(
    r"(?i)(h\.?w\.?\s*(set|group)|hardware\s*set|set\s*(no\.?|#|id))"
)
LOCATION_PATTERNS = re.compile(
    r"(?i)(location|label|description|opening\s*label|from\s*/?\s*to)"
)
DOOR_TYPE_PATTERNS = re.compile(
    r"(?i)(door\s*type|dr\.?\s*type|type\s*d)"
)
FRAME_TYPE_PATTERNS = re.compile(
    r"(?i)(frame\s*type|fr\.?\s*type|type\s*f)"
)
FIRE_RATING_PATTERNS = re.compile(
    r"(?i)(fire\s*rat(ing|e)|rating|f\.?r\.?)"
)
HAND_PATTERNS = re.compile(
    r"(?i)^hand(ing)?$|^handing$"
)

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
    r"heading\s*#?\s*([A-Z0-9][A-Z0-9.\-]*)\s*\(set\s*#?\s*([A-Z0-9][A-Z0-9.\-]*)\)"  # Heading #X (Set #Y)
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


def match_column(header: str, pattern: re.Pattern) -> bool:
    """Check if a header string matches a column pattern."""
    if not header:
        return False
    return bool(pattern.search(header.strip()))


def detect_column_mapping(headers: list[str]) -> dict[str, int]:
    """
    Given a list of column headers, return a mapping of
    field_name -> column_index for Opening List fields.
    """
    mapping = {}
    patterns = {
        "door_number": DOOR_NUMBER_PATTERNS,
        "hw_set": HW_SET_PATTERNS,
        "location": LOCATION_PATTERNS,
        "door_type": DOOR_TYPE_PATTERNS,
        "frame_type": FRAME_TYPE_PATTERNS,
        "fire_rating": FIRE_RATING_PATTERNS,
        "hand": HAND_PATTERNS,
    }

    for i, header in enumerate(headers):
        if not header:
            continue
        h = header.strip()
        for field, pattern in patterns.items():
            if field not in mapping and match_column(h, pattern):
                mapping[field] = i
                break

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


def clean_cell(val) -> str:
    """Clean a cell value, handling None, whitespace, and mojibake characters."""
    if val is None:
        return ""
    s = str(val).strip()
    # Fix common UTF-8/Latin-1 mojibake patterns
    # Â· (C2 B7 decoded as Latin-1) → · (middle dot, standard hardware separator)
    mojibake_map = {
        "Â·": "·",       # middle dot
        "Â\u00b7": "·",  # alternate encoding
        "â€"": "–",      # en dash
        "â€"": "—",      # em dash
        "â€™": "'",      # right single quote
        "â€˜": "'",      # left single quote
        "â€œ": '"',      # left double quote
        "â€\u009d": '"', # right double quote
        "Ã—": "×",       # multiplication sign
        "Â½": "½",       # one half
        "Â¼": "¼",       # one quarter
        "Â¾": "¾",       # three quarters
        "Â®": "®",       # registered
        "Â©": "©",       # copyright
        "Ã\u0097": "×",  # multiplication sign variant
    }
    for bad, good in mojibake_map.items():
        if bad in s:
            s = s.replace(bad, good)
    # Normalize Unicode to NFC form
    s = unicodedata.normalize("NFC", s)
    return s


def is_valid_door_number(val: str) -> bool:
    """
    Check if a value looks like a valid door number.
    Door numbers typically contain digits and may have letter suffixes,
    hyphens, or prefixes like ST-, EY-.
    """
    if not val:
        return False
    lower = val.lower()
    if lower in ("", "total", "totals", "note", "notes", "cont", "continued"):
        return False
    if lower.startswith("note:") or lower.startswith("*"):
        return False
    return bool(re.search(r"\d", val))


# --- Hardware Set Extraction ---

def is_hardware_set_page(text: str) -> bool:
    """Check if a page likely contains hardware set definitions."""
    return bool(HW_SET_HEADING_PATTERN.search(text))


def parse_hw_set_id_from_text(text: str) -> tuple[str, str]:
    """
    Extract set_id and heading description from page text.
    Returns (set_id, heading_description).
    """
    m = HW_SET_HEADING_PATTERN.search(text)
    if not m:
        return ("", "")

    # Group 1 = heading number, Group 2 = set ID (from "Heading #X (Set #Y)" format)
    # Group 3 = set ID (from "Hardware Set X" / "SET: X" format)
    if m.group(2):
        set_id = m.group(2).strip()
    elif m.group(3):
        set_id = m.group(3).strip()
    elif m.group(1):
        set_id = m.group(1).strip()
    else:
        set_id = ""

    # Try to extract the heading description
    heading = ""
    # Look for pattern: "Heading #ID - Description (Set #ID)"
    # or just take the line containing the set heading
    lines = text.split("\n")
    for line in lines:
        if HW_SET_HEADING_PATTERN.search(line):
            # Try to extract description after dash
            dash_match = re.search(
                r"(?:heading\s*#?\s*[A-Z0-9][A-Z0-9.\-]*)\s*[-–—]\s*(.+?)(?:\(|$)",
                line, re.IGNORECASE
            )
            if dash_match:
                heading = dash_match.group(1).strip()
            else:
                # Use the full line as heading, cleaned up
                heading = re.sub(
                    r"(?i)(?:heading|set)\s*#?\s*[A-Z0-9][A-Z0-9.\-]*\s*[-–—:]\s*",
                    "", line
                ).strip()
                # Remove trailing "(Set #...)" if present
                heading = re.sub(r"\(set\s*#?\s*[A-Z0-9][A-Z0-9.\-]*\)\s*$", "", heading, flags=re.IGNORECASE).strip()
            break

    return (set_id, heading)


def extract_hardware_sets_from_page(page, page_text: str) -> list[HardwareSetDef]:
    """
    Extract hardware set definitions from a single page using text-alignment
    table detection (for transparent/invisible grid lines).
    """
    sets: list[HardwareSetDef] = []

    set_id, heading = parse_hw_set_id_from_text(page_text)
    if not set_id:
        return sets

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

        # Skip if this looks like a door list table (Qty | Description | Door # | Location)
        if any(match_column(h, DOOR_NUMBER_PATTERNS) for h in header_row):
            continue

        # Detect hardware items table by looking for qty + item/description columns
        qty_col = None
        name_col = None
        mfr_col = None
        model_col = None
        finish_col = None

        for i, h in enumerate(header_row):
            hl = h.lower()
            if re.match(r"(?i)^(qty\.?|quantity|#)$", hl):
                qty_col = i
            elif re.search(r"(?i)(item|description|hardware|product)", hl):
                name_col = i
            elif re.search(r"(?i)(mfr|mfg|manufacturer|vendor)", hl):
                mfr_col = i
            elif re.search(r"(?i)(model|catalog|cat\.?\s*#?|product\s*#?|series)", hl):
                model_col = i
            elif re.search(r"(?i)(finish|fin\.?|color)", hl):
                finish_col = i

        # If we didn't find explicit headers, try positional inference
        # Many submittals have: Qty | Description | Manufacturer | Catalog No. | Finish
        if qty_col is None and name_col is None and len(header_row) >= 3:
            # Check if first column values look like quantities (small integers)
            data_rows = table[1:6]  # sample first 5 data rows
            first_col_is_qty = all(
                re.match(r"^\d{1,3}$", clean_cell(row[0]))
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

            # Get qty
            qty_val = 1
            if qty_col is not None and qty_col < len(cells):
                raw_qty = cells[qty_col]
                qty_match = re.match(r"(\d+)", raw_qty)
                if qty_match:
                    qty_val = int(qty_match.group(1))

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
        sets.append(HardwareSetDef(
            set_id=set_id,
            heading=heading,
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
    item_line_pattern = re.compile(
        r"^\s*(\d{1,3})\s+(.+)"
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
                        break
            else:
                seen_set_ids.add(hw_set.set_id)
                all_sets.append(hw_set)

    return all_sets


# --- Opening List Extraction ---

def extract_opening_list(pdf: pdfplumber.PDF) -> tuple[list[DoorEntry], int]:
    """
    Extract the Opening List / Door Schedule from a PDF.
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
            for row_idx, row in enumerate(table[:5]):
                headers = [clean_cell(c) for c in row]
                if is_opening_list_table(headers):
                    header_row_idx = row_idx
                    mapping = detect_column_mapping(headers)
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
                    location=get_field("location"),
                    door_type=get_field("door_type"),
                    frame_type=get_field("frame_type"),
                    fire_rating=get_field("fire_rating"),
                    hand=get_field("hand"),
                )
                all_doors.append(entry)

    # If line-based found nothing, try text-alignment strategy
    if not all_doors:
        all_doors, tables_found = extract_opening_list_text_align(pdf)

    # Final fallback: pure text parsing
    if not all_doors:
        all_doors, tables_found = extract_opening_list_text(pdf)

    return all_doors, tables_found


def extract_opening_list_text_align(pdf: pdfplumber.PDF) -> tuple[list[DoorEntry], int]:
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
            for row_idx, row in enumerate(table[:5]):
                headers = [clean_cell(c) for c in row]
                if is_opening_list_table(headers):
                    header_row_idx = row_idx
                    mapping = detect_column_mapping(headers)
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
                    location=get_field("location"),
                    door_type=get_field("door_type"),
                    frame_type=get_field("frame_type"),
                    fire_rating=get_field("fire_rating"),
                    hand=get_field("hand"),
                )
                all_doors.append(entry)

    return all_doors, tables_found


def extract_opening_list_text(pdf: pdfplumber.PDF) -> tuple[list[DoorEntry], int]:
    """
    Fallback extraction using text parsing when table grid detection fails.
    Looks for structured text patterns typical of Opening List pages.
    """
    all_doors: list[DoorEntry] = []
    seen_door_numbers: set[str] = set()
    tables_found = 0

    door_line_pattern = re.compile(
        r"^(\S+)\s+"           # door number
        r"([A-Z][A-Z0-9\-]+)"  # hw_set (starts with letter, alphanumeric with hyphens)
    )

    for page in pdf.pages:
        text = page.extract_text() or ""
        lines = text.split("\n")

        for line in lines:
            line = line.strip()
            if not line:
                continue

            m = door_line_pattern.match(line)
            if m:
                door_num = m.group(1)
                if not is_valid_door_number(door_num):
                    continue
                if door_num in seen_door_numbers:
                    continue

                seen_door_numbers.add(door_num)
                tables_found = max(tables_found, 1)

                parts = re.split(r"\s{2,}|\t", line)
                entry = DoorEntry(
                    door_number=door_num,
                    hw_set=parts[1] if len(parts) > 1 else "",
                    location=parts[2] if len(parts) > 2 else "",
                    door_type=parts[3] if len(parts) > 3 else "",
                    frame_type=parts[4] if len(parts) > 4 else "",
                    fire_rating=parts[5] if len(parts) > 5 else "",
                    hand=parts[6] if len(parts) > 6 else "",
                )
                all_doors.append(entry)

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
            if not pdf_base64:
                self._send_json(400, ExtractionResult(
                    success=False,
                    error="Missing pdf_base64 in request body"
                ))
                return

            # Decode base64 PDF
            pdf_bytes = base64.b64decode(pdf_base64)
            pdf_file = io.BytesIO(pdf_bytes)

            with pdfplumber.open(pdf_file, unicode_norm="NFC") as pdf:
                # Phase 1: Extract Hardware Sets (text-alignment detection)
                hardware_sets = extract_all_hardware_sets(pdf)

                # Phase 2: Extract Opening List via table grid detection
                openings, tables_found = extract_opening_list(pdf)

                # Phase 3: Extract reference tables
                reference_codes = extract_reference_tables(pdf)

                result = ExtractionResult(
                    success=len(openings) > 0 or len(hardware_sets) > 0,
                    openings=openings,
                    hardware_sets=hardware_sets,
                    reference_codes=reference_codes,
                    expected_door_count=len(openings),
                    tables_found=tables_found,
                    hw_sets_found=len(hardware_sets),
                    method="pdfplumber",
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
