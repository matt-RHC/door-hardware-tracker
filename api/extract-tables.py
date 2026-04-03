"""
Phase 2: Deterministic table extraction via pdfplumber.

Vercel Python serverless function that receives base64-encoded PDF pages,
extracts the Opening List table deterministically (no LLM variance),
and returns structured JSON matching the DoorScheduleSchema.

Also extracts reference tables (Manufacturer List, Finish List, Option List)
and returns them as lookup dictionaries for decoding abbreviations.

Location: /api/extract-tables.py (project root, Vercel Python runtime)
"""

import base64
import io
import json
import re
import traceback
from http.server import BaseHTTPRequestHandler

import pdfplumber
from pydantic import BaseModel


# --- Pydantic Models ---

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
    reference_codes: list[ReferenceCode] = []
    expected_door_count: int = 0
    tables_found: int = 0
    method: str = "pdfplumber"
    error: str = ""


# --- Column Detection ---

# Common column header patterns for Opening List tables
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
    """Clean a cell value, handling None and whitespace."""
    if val is None:
        return ""
    return str(val).strip()


def is_valid_door_number(val: str) -> bool:
    """
    Check if a value looks like a valid door number.
    Door numbers typically contain digits and may have letter suffixes,
    hyphens, or prefixes like ST-, EY-.
    """
    if not val:
        return False
    # Skip header rows, notes, totals
    lower = val.lower()
    if lower in ("", "total", "totals", "note", "notes", "cont", "continued"):
        return False
    if lower.startswith("note:") or lower.startswith("*"):
        return False
    # Must contain at least one digit
    return bool(re.search(r"\d", val))


# --- Table Extraction ---

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

            # Find the header row (first row with recognizable column names)
            header_row_idx = None
            mapping = {}
            for row_idx, row in enumerate(table[:5]):  # check first 5 rows
                headers = [clean_cell(c) for c in row]
                if is_opening_list_table(headers):
                    header_row_idx = row_idx
                    mapping = detect_column_mapping(headers)
                    break

            if header_row_idx is None:
                continue

            tables_found += 1

            # Extract data rows
            for row in table[header_row_idx + 1:]:
                cells = [clean_cell(c) for c in row]

                # Get door number
                door_col = mapping.get("door_number")
                if door_col is None or door_col >= len(cells):
                    continue

                door_num = cells[door_col]
                if not is_valid_door_number(door_num):
                    continue

                # Normalize door number (strip whitespace, collapse spaces)
                door_num = re.sub(r"\s+", " ", door_num).strip()

                # Skip duplicates (same door on multiple pages = continuation)
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

    return all_doors, tables_found


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

            # Check if this looks like a reference table
            # Reference tables typically have 2-3 columns and a header mentioning
            # manufacturer, finish, or option
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
                # Also check text above the table for section headers
                # (common in submittals — the legend title is outside the table)
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

            # Extract code -> full_name pairs from 2-column tables
            for row in table[1:]:
                cells = [clean_cell(c) for c in row]
                if len(cells) >= 2 and cells[0] and cells[1]:
                    # First column = abbreviation, second = full name
                    codes.append(ReferenceCode(
                        code_type=code_type,
                        code=cells[0],
                        full_name=cells[1],
                    ))

    return codes


# --- Fallback: Text-based extraction ---

def extract_opening_list_text(pdf: pdfplumber.PDF) -> tuple[list[DoorEntry], int]:
    """
    Fallback extraction using text parsing when table grid detection fails.
    Looks for structured text patterns typical of Opening List pages.
    """
    all_doors: list[DoorEntry] = []
    seen_door_numbers: set[str] = set()
    tables_found = 0

    # Pattern for opening list rows:
    # door_number hw_set [location] [door_type] [frame_type] [fire_rating] [hand]
    # These are typically tab/space-separated
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

                # Parse remaining fields from the line
                # This is approximate — the LLM fallback handles edge cases
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

            with pdfplumber.open(pdf_file) as pdf:
                # Phase 1: Extract Opening List via table grid detection
                openings, tables_found = extract_opening_list(pdf)

                # If grid detection found nothing, try text-based fallback
                if not openings:
                    openings, tables_found = extract_opening_list_text(pdf)

                # Phase 2: Extract reference tables
                reference_codes = extract_reference_tables(pdf)

                result = ExtractionResult(
                    success=len(openings) > 0,
                    openings=openings,
                    reference_codes=reference_codes,
                    expected_door_count=len(openings),
                    tables_found=tables_found,
                    method="pdfplumber" if tables_found > 0 else "text_fallback",
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
