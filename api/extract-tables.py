"""
Phase 2.1: Deterministic table extraction via pdfplumber.

Vercel Python serverless function that receives base64-encoded PDF pages,
extracts BOTH:
  1. Hardware Set definitions (set ID, heading, items with qty/name/mfr/model/finish)
  2. Opening List / Door Schedule (door number, hw_set, location, types, rating, hand)

Multi-strategy extraction pipeline:
  - Strategy 1: Line-based table detection (explicit grid lines)
  - Strategy 2: Text-alignment table detection (transparent/invisible grid lines)
  - Strategy 3: Pure text parsing fallback
  - Best result wins (most data extracted)

Also extracts reference tables and reports text layer health for OCR decisions.

Location: /api/extract-tables.py (project root, Vercel Python runtime)
"""

import base64
import io
import json
import re
import traceback
from concurrent.futures import ThreadPoolExecutor, as_completed
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
    has_text_layer: bool = True
    pages_with_text: int = 0
    total_pages: int = 0


# --- Table extraction settings presets ---

# Strategy 1: Explicit line-based (visible grid lines)
LINES_SETTINGS = {
    "vertical_strategy": "lines",
    "horizontal_strategy": "lines",
    "intersection_tolerance": 8,
    "snap_tolerance": 8,
    "join_tolerance": 8,
    "edge_min_length": 8,
    "min_words_vertical": 1,
    "min_words_horizontal": 1,
}

# Strategy 2: Text-alignment (transparent/invisible grid lines)
TEXT_ALIGN_SETTINGS = {
    "vertical_strategy": "text",
    "horizontal_strategy": "text",
    "intersection_tolerance": 8,
    "snap_tolerance": 8,
    "join_tolerance": 8,
    "min_words_vertical": 2,
    "min_words_horizontal": 1,
    "text_x_tolerance": 5,
    "text_y_tolerance": 5,
}

# Strategy 3: Mixed — lines vertical, text horizontal (for partial grids)
MIXED_SETTINGS = {
    "vertical_strategy": "lines",
    "horizontal_strategy": "text",
    "intersection_tolerance": 8,
    "snap_tolerance": 8,
    "join_tolerance": 8,
    "min_words_horizontal": 1,
    "text_y_tolerance": 5,
}


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

HW_SET_HEADING_PATTERN = re.compile(
    r"(?i)"
    r"(?:"
    r"heading\s*#?\s*([A-Z0-9][A-Z0-9.\-]*)\s*\(set\s*#?\s*([A-Z0-9][A-Z0-9.\-]*)\)"
    r"|"
    r"(?:hardware\s+)?set\s*[:# ]\s*([A-Z0-9][A-Z0-9.\-]*)"
    r")"
)

HW_SET_DESC_PATTERN = re.compile(
    r"(?i)heading\s*#?\s*[A-Z0-9][A-Z0-9.\-]*\s*[-\u2013\u2014]\s*(.+?)(?:\(|$)"
)

# Common hardware item name patterns (kept in sync with src/lib/hardware-taxonomy.ts)
HARDWARE_ITEM_NAMES = re.compile(
    r"(?i)("
    r"hinge|pivot|spring\s*hinge|continuous\s*hinge|"
    r"lockset|latchset|latch\s*set|lock\s*set|passage|privacy|"
    r"storeroom|classroom|entrance|office|mortise.*lock|"
    r"cylindrical|deadbolt|dead\s*bolt|night\s*latch|"
    r"exit\s*device|panic|rim\s*device|concealed\s*vertical|"
    r"surface\s*vertical|crossbar|touch\s*bar|push\s*bar|"
    r"flush\s*bolt|constant\s*latching|surface\s*bolt|dust\s*proof|"
    r"strike|electric\s*strike|power\s*strike|"
    r"elec.*modif|electrif|power\s*transfer|ept|"
    r"wire\s*harness|connector|molex|con-\d|wiring|pigtail|"
    r"closer|door\s*check|floor\s*closer|"
    r"coordinator|"
    r"cylinder|core|interchangeable|"
    r"kick\s*plate|protection\s*plate|mop\s*plate|armor\s*plate|"
    r"wall\s*stop|floor\s*stop|overhead\s*stop|door\s*stop|holder|hold\s*open|"
    r"door\s*sweep|auto.*door\s*bottom|drop\s*seal|door\s*bottom|"
    r"threshold|saddle|"
    r"gasket|smoke\s*seal|gasketing|acoustic\s*seal|weatherstrip|"
    r"perimeter\s*seal|sound\s*seal|"
    r"rain\s*drip|drip\s*cap|astragal|meeting\s*stile|"
    r"silencer|bumper|mute|"
    r"by\s*others|hardware\s*by\s*others|not\s*in\s*contract|"
    r"not\s*used|no\s*hardware|"
    r"pull|push|plate|lever|knob|key|magnetic|roller|catch"
    r")"
)


def match_column(header: str, pattern: re.Pattern) -> bool:
    if not header:
        return False
    return bool(pattern.search(header.strip()))


def detect_column_mapping(headers: list[str]) -> dict[str, int]:
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
    mapping = detect_column_mapping(headers)
    has_door = "door_number" in mapping
    has_secondary = "hw_set" in mapping or "location" in mapping
    return has_door and has_secondary


def clean_cell(val) -> str:
    if val is None:
        return ""
    return str(val).strip()


def is_valid_door_number(val: str) -> bool:
    if not val:
        return False
    lower = val.lower()
    if lower in ("", "total", "totals", "note", "notes", "cont", "continued"):
        return False
    if lower.startswith("note:") or lower.startswith("*"):
        return False
    return bool(re.search(r"\d", val))


# --- Text layer detection ---

def check_text_layer(pdf: pdfplumber.PDF) -> tuple[bool, int]:
    """
    Check if the PDF has a usable text layer.
    Returns (has_text_layer, pages_with_text).
    """
    pages_with_text = 0
    for page in pdf.pages:
        text = (page.extract_text() or "").strip()
        # A page has useful text if it has at least 20 chars of non-whitespace
        if len(re.sub(r"\s+", "", text)) > 20:
            pages_with_text += 1
    has_text = pages_with_text > len(pdf.pages) * 0.3  # >30% of pages have text
    return has_text, pages_with_text


# --- Hardware Set Extraction ---

def is_hardware_set_page(text: str) -> bool:
    return bool(HW_SET_HEADING_PATTERN.search(text))


def parse_hw_set_id_from_text(text: str) -> tuple[str, str]:
    m = HW_SET_HEADING_PATTERN.search(text)
    if not m:
        return ("", "")

    if m.group(2):
        set_id = m.group(2).strip()
    elif m.group(3):
        set_id = m.group(3).strip()
    elif m.group(1):
        set_id = m.group(1).strip()
    else:
        set_id = ""

    heading = ""
    lines = text.split("\n")
    for line in lines:
        if HW_SET_HEADING_PATTERN.search(line):
            dash_match = re.search(
                r"(?:heading\s*#?\s*[A-Z0-9][A-Z0-9.\-]*)\s*[-\u2013\u2014]\s*(.+?)(?:\(|$)",
                line, re.IGNORECASE
            )
            if dash_match:
                heading = dash_match.group(1).strip()
            else:
                heading = re.sub(
                    r"(?i)(?:heading|set)\s*#?\s*[A-Z0-9][A-Z0-9.\-]*\s*[-\u2013\u2014:]\s*",
                    "", line
                ).strip()
                heading = re.sub(
                    r"\(set\s*#?\s*[A-Z0-9][A-Z0-9.\-]*\)\s*$", "",
                    heading, flags=re.IGNORECASE
                ).strip()
            break

    return (set_id, heading)


def _extract_hw_items_from_table(table: list, page_text: str) -> list[HardwareItem]:
    """Extract hardware items from a single detected table."""
    items: list[HardwareItem] = []
    if not table or len(table) < 2:
        return items

    header_row = [clean_cell(c) for c in table[0]]

    # Skip if this looks like a door list table
    if any(match_column(h, DOOR_NUMBER_PATTERNS) for h in header_row):
        return items

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

    # Positional inference fallback
    if qty_col is None and name_col is None and len(header_row) >= 3:
        data_rows = table[1:6]
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

    if name_col is None and qty_col is None:
        return items

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
            raw_qty = cells[qty_col]
            qty_match = re.match(r"(\d+)", raw_qty)
            if qty_match:
                qty_val = int(qty_match.group(1))

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


def extract_hardware_sets_from_page(page, page_text: str) -> list[HardwareSetDef]:
    """
    Extract hardware set definitions from a single page.
    Tries multiple table detection strategies and picks the best result.
    """
    sets: list[HardwareSetDef] = []

    set_id, heading = parse_hw_set_id_from_text(page_text)
    if not set_id:
        return sets

    best_items: list[HardwareItem] = []

    # Try each strategy, keep the one with the most items
    for settings in [TEXT_ALIGN_SETTINGS, LINES_SETTINGS, MIXED_SETTINGS]:
        try:
            tables = page.extract_tables(table_settings=settings)
            strategy_items: list[HardwareItem] = []
            for table in (tables or []):
                strategy_items.extend(_extract_hw_items_from_table(table, page_text))
            if len(strategy_items) > len(best_items):
                best_items = strategy_items
        except Exception:
            continue

    # If table extraction found nothing, try text-line parsing
    if not best_items:
        best_items = extract_hw_items_from_text(page_text)

    if best_items:
        sets.append(HardwareSetDef(
            set_id=set_id,
            heading=heading,
            items=best_items,
        ))

    return sets


def extract_hw_items_from_text(text: str) -> list[HardwareItem]:
    """Fallback: extract hardware items from raw text lines."""
    items: list[HardwareItem] = []
    lines = text.split("\n")

    item_line_pattern = re.compile(r"^\s*(\d{1,3})\s+(.+)")

    for line in lines:
        m = item_line_pattern.match(line)
        if not m:
            continue

        qty = int(m.group(1))
        rest = m.group(2).strip()

        if not HARDWARE_ITEM_NAMES.search(rest):
            continue

        parts = re.split(r"\s{2,}|\t", rest)

        items.append(HardwareItem(
            qty=qty,
            name=parts[0] if len(parts) > 0 else rest,
            manufacturer=parts[1] if len(parts) > 1 else "",
            model=parts[2] if len(parts) > 2 else "",
            finish=parts[3] if len(parts) > 3 else "",
        ))

    return items


def _process_hw_page(page_data: tuple) -> list[HardwareSetDef]:
    """Process a single page for hardware sets (for parallel execution)."""
    page, page_text = page_data
    if not is_hardware_set_page(page_text):
        return []
    return extract_hardware_sets_from_page(page, page_text)


def extract_all_hardware_sets(pdf: pdfplumber.PDF) -> list[HardwareSetDef]:
    """
    Extract all hardware set definitions from the entire PDF.
    Uses parallel page processing for speed.
    """
    all_sets: list[HardwareSetDef] = []
    seen_set_ids: set[str] = set()

    # Prepare page data (extract text first since page objects aren't thread-safe)
    # Process sequentially since pdfplumber page objects share the PDF file handle
    for page_num, page in enumerate(pdf.pages):
        text = page.extract_text() or ""
        if not is_hardware_set_page(text):
            continue

        page_sets = extract_hardware_sets_from_page(page, text)

        for hw_set in page_sets:
            if hw_set.set_id in seen_set_ids:
                for existing in all_sets:
                    if existing.set_id == hw_set.set_id:
                        existing.items.extend(hw_set.items)
                        break
            else:
                seen_set_ids.add(hw_set.set_id)
                all_sets.append(hw_set)

    return all_sets


# --- Opening List Extraction ---

def _extract_doors_from_tables(tables: list, seen: set[str],
                               last_mapping: dict[str, int] | None = None
                               ) -> tuple[list[DoorEntry], int, dict[str, int] | None]:
    """
    Extract door entries from a list of pdfplumber tables.
    Uses last_mapping as fallback for continuation pages without headers.
    Returns (doors, tables_found, last_valid_mapping).
    """
    doors: list[DoorEntry] = []
    tables_found = 0

    for table in tables:
        if not table or len(table) < 2:
            continue

        header_row_idx = None
        mapping = {}

        # Look for header row in first 5 rows
        for row_idx, row in enumerate(table[:5]):
            headers = [clean_cell(c) for c in row]
            if is_opening_list_table(headers):
                header_row_idx = row_idx
                mapping = detect_column_mapping(headers)
                last_mapping = mapping
                break

        # If no header found, try using the last known mapping
        # (for continuation pages of multi-page tables)
        if header_row_idx is None and last_mapping:
            # Check if first data row looks like door data using last mapping
            first_row = [clean_cell(c) for c in table[0]]
            door_col = last_mapping.get("door_number")
            if door_col is not None and door_col < len(first_row):
                if is_valid_door_number(first_row[door_col]):
                    header_row_idx = -1  # No header row, start from row 0
                    mapping = last_mapping

        if not mapping:
            continue

        tables_found += 1
        start_row = header_row_idx + 1 if header_row_idx >= 0 else 0

        for row in table[start_row:]:
            cells = [clean_cell(c) for c in row]

            door_col = mapping.get("door_number")
            if door_col is None or door_col >= len(cells):
                continue

            door_num = cells[door_col]
            if not is_valid_door_number(door_num):
                continue

            door_num = re.sub(r"\s+", " ", door_num).strip()

            if door_num in seen:
                continue
            seen.add(door_num)

            def get_field(field: str, m=mapping, c=cells) -> str:
                idx = m.get(field)
                if idx is None or idx >= len(c):
                    return ""
                return c[idx]

            doors.append(DoorEntry(
                door_number=door_num,
                hw_set=get_field("hw_set"),
                location=get_field("location"),
                door_type=get_field("door_type"),
                frame_type=get_field("frame_type"),
                fire_rating=get_field("fire_rating"),
                hand=get_field("hand"),
            ))

    return doors, tables_found, last_mapping


def extract_opening_list(pdf: pdfplumber.PDF) -> tuple[list[DoorEntry], int]:
    """
    Extract the Opening List / Door Schedule using multi-strategy pipeline.
    Tries line-based, text-alignment, and mixed strategies.
    Keeps the strategy that produces the most doors.
    Also carries column mapping across pages for continuation tables.
    """
    best_doors: list[DoorEntry] = []
    best_tables = 0

    for settings in [LINES_SETTINGS, TEXT_ALIGN_SETTINGS, MIXED_SETTINGS]:
        strategy_doors: list[DoorEntry] = []
        strategy_tables = 0
        seen: set[str] = set()
        last_mapping: dict[str, int] | None = None

        for page in pdf.pages:
            try:
                tables = page.extract_tables(table_settings=settings)
                page_doors, page_tables, last_mapping = _extract_doors_from_tables(
                    tables or [], seen, last_mapping
                )
                strategy_doors.extend(page_doors)
                strategy_tables += page_tables
            except Exception:
                continue

        if len(strategy_doors) > len(best_doors):
            best_doors = strategy_doors
            best_tables = strategy_tables

    # Final fallback: pure text parsing
    if not best_doors:
        best_doors, best_tables = extract_opening_list_text(pdf)

    return best_doors, best_tables


def extract_opening_list_text(pdf: pdfplumber.PDF) -> tuple[list[DoorEntry], int]:
    """Fallback extraction using text parsing."""
    all_doors: list[DoorEntry] = []
    seen_door_numbers: set[str] = set()
    tables_found = 0

    door_line_pattern = re.compile(
        r"^(\S+)\s+"
        r"([A-Z][A-Z0-9\-]+)"
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
    codes: list[ReferenceCode] = []

    for page in pdf.pages:
        text = page.extract_text() or ""

        # Try both line-based and text-alignment for reference tables
        all_tables = []
        for settings in [LINES_SETTINGS, TEXT_ALIGN_SETTINGS]:
            try:
                tables = page.extract_tables(table_settings=settings)
                if tables:
                    all_tables.extend(tables)
            except Exception:
                continue

        for table in all_tables:
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
                for line in text.split("\n"):
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
                    code_val = f"{code_type}:{cells[0]}"
                    # Avoid duplicates
                    if not any(c.code_type == code_type and c.code == cells[0] for c in codes):
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

            pdf_bytes = base64.b64decode(pdf_base64)
            pdf_file = io.BytesIO(pdf_bytes)

            with pdfplumber.open(pdf_file) as pdf:
                total_pages = len(pdf.pages)

                # Check text layer health
                has_text, pages_with_text = check_text_layer(pdf)

                if not has_text:
                    # No usable text layer — return immediately so LLM can take over
                    result = ExtractionResult(
                        success=False,
                        has_text_layer=False,
                        pages_with_text=pages_with_text,
                        total_pages=total_pages,
                        method="pdfplumber",
                        error="PDF has no usable text layer (likely scanned/image-based). OCR or LLM vision needed.",
                    )
                    self._send_json(200, result)
                    return

                # Phase 1: Extract Hardware Sets
                hardware_sets = extract_all_hardware_sets(pdf)

                # Phase 2: Extract Opening List (multi-strategy)
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
                    has_text_layer=True,
                    pages_with_text=pages_with_text,
                    total_pages=total_pages,
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
