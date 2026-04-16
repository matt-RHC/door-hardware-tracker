"""
Smart Chunking: Page classification and boundary detection for PDF submittals.

Vercel Python serverless function that quickly scans every page of a submittal PDF,
classifies each page by type (door_schedule, hardware_set, reference, cover, other),
detects section boundaries, and returns optimal split points for semantic chunking.

This replaces the fixed 35-page splitting that causes data loss when records
span chunk boundaries.

Location: /api/classify-pages.py (project root, Vercel Python runtime)
"""

import base64
import hmac
import io
import json
import logging
import os
import re
import traceback
from collections import Counter
from http.server import BaseHTTPRequestHandler

import pdfplumber

logger = logging.getLogger("classify-pages")
logging.basicConfig(level=logging.INFO)


# --- Internal Token Auth ---
# Keep in sync with the matching helper in api/extract-tables.py and
# api/detect-mapping.py. Vercel bundles each Python file independently,
# so duplication is the existing convention in this repo.

def require_internal_token(request_handler) -> bool:
    """Verify X-Internal-Token matches PYTHON_INTERNAL_SECRET.

    Returns True if authorized. If not authorized, sends a 401 response
    and returns False — caller should return immediately.

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


# --- Page Type Constants ---
PAGE_TYPE_DOOR_SCHEDULE = "door_schedule"
PAGE_TYPE_HARDWARE_SET = "hardware_set"
PAGE_TYPE_REFERENCE = "reference"
PAGE_TYPE_COVER = "cover"
PAGE_TYPE_OTHER = "other"

# --- Detection Patterns ---

# Door schedule indicators
DOOR_SCHEDULE_HEADERS = re.compile(
    r"(?i)(door\s*(schedule|list|index)|opening\s*(list|schedule|index)|"
    r"(door|opening)\s*(no\.?|num|#|tag).*?(h\.?w\.?\s*set|hardware\s*set|hdg\s*#|location)|"
    r"(door|opening)\s+(hdw|h\.?w\.?|hardware)\s*(set|group))"
)
DOOR_NUMBER_COLUMN = re.compile(
    r"(?i)^(open(ing)?|door)\s*(no\.?|num(ber)?|#|tag)|^#$|^no\.?$|^tag$"
)
# Multiple door-number-like values on one page (e.g. "101-01", "A-201B", "10.E1.03",
# "1313B", "EY-003", "ST-1A", "101", "2145", "10-03AB", "10-82A.R1M")
# S-064: Added bare 3-4 digit pattern for simple numbering schemes (101, 102, 103A)
# S-066B: Added multi-letter suffix, revision suffix, REV-embedded patterns
DOOR_NUMBER_VALUES = re.compile(
    r"\b(\d{2,4}[-\.]\d{1,3}[A-Z]?|"                  # standard: 10-03A
    r"\d{2,3}[-]\d{2,4}[A-Z]{2,3}|"                   # multi-letter: 10-03AB
    r"\d{2,4}[-]\d{2,4}[A-Z]\.[A-Z]\d[A-Z]|"         # revision: 10-82A.R1M
    r"\d{2,4}[-]\d{2,4}[A-Z]{0,3}REV\d?|"            # REV: 09-15AREV1
    r"[A-Z]{1,2}[-]\d{2,4}[A-Z]?|"
    r"[A-Z]\d{3,4}[A-Z]?|\d{3,4}[A-Z]?\b|"
    r"\d{1,3}\.[A-Z]\d{1,3}\.\d{2,4}[A-Z]?)\b"
)

# Hardware set indicators
# BUG-22 fix: tighten bare-set regex to reject English words (set up, set point, etc.)
# BUG-22/S-064: bare-set requires colon/hash (not bare space), and set ID must be
# >=2 chars or start with a digit to reject single-letter false positives.
# Also added colon to character class to match extract-tables.py (S-064 divergence fix).
_SET_ID_BLOCKLIST = r"(?!up|aside|point|down|out|off|back|about|and|the|has|trim|in|on|to|of|at|it|is|as|or|an|no|so|do|if|for|are|was|not|but|all|can|had|her|one|our|new|now|way|may|any|its|let|old|see|how|two|got|use|per|too|did|get|low|run|add|own|say|she|big|end|put|top|try|ask|men|ran|set)"
HW_SET_HEADING = re.compile(
    r"(?i)"
    r"(?:"
    r"heading\s*#?\s*([A-Z0-9][A-Z0-9.\-:]*)\s*\((?:hw\s*)?set\s*#?\s*([A-Z0-9][A-Z0-9.\-:]*)\)"
    r"|"
    r"(?:hardware\s+|hw\s+)(?:set|group)\s*[:# ]\s*([A-Z0-9][A-Z0-9.\-:]{0,14})\b"
    r"|"
    r"(?<![\w.])set\s*[:#]\s*" + _SET_ID_BLOCKLIST + r"([A-Z0-9][A-Z0-9.\-:]{1,14})\b"
    r")"
)
HARDWARE_ITEM_NAMES = re.compile(
    r"(?i)(hinge|pivot|lockset|latchset|exit\s*device|panic|closer|"
    r"flush\s*bolt|strike|cylinder|core|kick\s*plate|threshold|"
    r"gasket|silencer|pull|push|plate|lever|coordinator|"
    r"door\s*sweep|door\s*bottom|astragal|dead\s*bolt|mortise)"
)

# Reference page indicators
REFERENCE_PATTERNS = re.compile(
    r"(?i)(manufacturer\s*(list|key|legend|code|abbrev)|"
    r"finish\s*(list|key|legend|code|abbrev)|"
    r"option\s*(list|key|legend|code|abbrev)|"
    r"abbreviation|legend|general\s*notes|"
    r"symbols?\s*key|keying\s*(schedule|legend)|"
    r"specification\s*reference|basis\s*of\s*design|"
    r"end\s*of\s*schedule|catalog\s*cut\s*summary)"
)

# Cover page indicators
COVER_PATTERNS = re.compile(
    r"(?i)(table\s*of\s*contents|project\s*directory|"
    r"submittal\s*cover|transmittal|project\s*name|"
    r"prepared\s*(by|for)|date\s*of\s*issue|"
    r"building\s*[a-z0-9]?\s*hardware|division\s*\d+|"
    r"section\s*08\s*71)"
)


# --- Scanned / CIDFont Detection ---

# Minimum characters on a page to consider it "native text" (not scanned)
SCANNED_TEXT_THRESHOLD = 50

# CID placeholder patterns — garbage text from CIDFont/Identity-H encoding
CID_GARBAGE_PATTERNS = re.compile(
    r"[\x00-\x08\x0e-\x1f]|"           # control characters
    r"\(cid:\d+\)|"                      # literal CID references
    r"[^\x00-\x7F]{10,}|"               # long runs of non-ASCII
    r"(?:[A-Z]{1,2}\d{1,3}){5,}"         # repeated short code sequences (font glyph IDs)
)


def detect_page_scan_status(page) -> dict:
    """
    Detect whether a page is scanned (image-only), has CIDFont encoding issues,
    or is native text.

    Returns:
        {
            "is_scanned": bool,     # True if page is image-only (no meaningful text)
            "has_cid_issues": bool,  # True if text looks like CIDFont garbage
            "text_char_count": int,  # Number of extractable characters
            "image_count": int,      # Number of images on the page
            "garbage_ratio": float,  # Ratio of garbage characters to total (0.0 - 1.0)
        }
    """
    text = page.extract_text() or ""
    char_count = len(text.strip())
    images = page.images if hasattr(page, "images") else []
    image_count = len(images)

    result = {
        "is_scanned": False,
        "has_cid_issues": False,
        "text_char_count": char_count,
        "image_count": image_count,
        "garbage_ratio": 0.0,
    }

    # Scanned detection: very little text + images present
    if char_count < SCANNED_TEXT_THRESHOLD and image_count > 0:
        result["is_scanned"] = True
        return result

    # CIDFont garbage detection: text exists but is mostly unreadable
    if char_count > 0:
        garbage_matches = CID_GARBAGE_PATTERNS.findall(text)
        garbage_chars = sum(len(m) for m in garbage_matches)
        result["garbage_ratio"] = garbage_chars / char_count if char_count > 0 else 0.0
        if result["garbage_ratio"] > 0.3:
            result["has_cid_issues"] = True

    return result


def detect_pdf_source(metadata: dict) -> str:
    """
    Detect the PDF source/generator from metadata.

    Returns one of: 'comsense', 's4h', 'word_excel', 'allegion',
    'assa_abloy', 'bluebeam', 'unknown'
    """
    raw_creator = metadata.get("Creator") or metadata.get("creator") or ""
    raw_producer = metadata.get("Producer") or metadata.get("producer") or ""
    # Strip trademark/copyright symbols that prevent substring matching
    # e.g. "Microsoft(R) Word" or "Microsoft\u00ae Word"
    _TM_RE = re.compile(r'[\u00ae\u00a9\u2122]|\((?:R|C|TM)\)', re.IGNORECASE)
    creator = _TM_RE.sub('', raw_creator).lower()
    producer = _TM_RE.sub('', raw_producer).lower()
    combined = f"{creator} {producer}"

    # Bluebeam is very distinctive
    if "bluebeam" in combined:
        return "bluebeam"

    # Allegion Overtur
    if "overtur" in combined or "allegion" in combined:
        return "allegion"

    # ASSA ABLOY Openings Studio
    if "assa" in combined or "abloy" in combined or "openings studio" in combined:
        return "assa_abloy"

    # Specification 4 Hardware (S4H)
    if "s4h" in combined or "specification 4" in combined or "spec4" in combined:
        return "s4h"

    # Comsense typically exports via Microsoft Word
    # Check for Word/Excel indicators (may also be manual submittals)
    if "comsense" in combined:
        return "comsense"

    # Word/Excel PDF exports
    if any(kw in combined for kw in ["microsoft word", "microsoft excel", "libreoffice", "openoffice"]):
        return "word_excel"

    # Comsense often uses Word as the engine but doesn't label it
    # Additional heuristic: if Producer is a generic PDF library and no other match
    if "word" in producer and "microsoft" not in producer:
        return "unknown"

    return "unknown"


# --- Document Fingerprinting Helpers ---


def _detect_heading_format(text: str) -> str:
    """
    Match text against HW_SET_HEADING pattern groups and return which
    heading format matched.

    Returns: "specworks" | "himmel" | "hw_prefix" | "colon_sep" | "id_first" | "bare_set" | "unknown"
    """
    # SpecWorks format: "Heading XXX (HwSet YYY)" — must check before himmel
    if re.search(r"(?i)heading\s*#?\s*[A-Z0-9].*?\(hw\s*set\s*#?\s*[A-Z0-9]", text):
        return "specworks"
    # Himmel format: "Heading #X (Set #Y)"
    if re.search(r"(?i)heading\s*#?\s*[A-Z0-9].*?\(set\s*#?\s*[A-Z0-9]", text):
        return "himmel"
    # Hardware prefix: "Hardware Set X"
    if re.search(r"(?i)hardware\s+set\s*[:# ]\s*[A-Z0-9]", text):
        return "hw_prefix"
    # Colon-separated: "Set: X"
    if re.search(r"(?i)\bset\s*:\s*[A-Z0-9]", text):
        return "colon_sep"
    # ID first: "A1 - Hardware Set"
    if re.search(
        r"(?i)\b[A-Z0-9][A-Z0-9.\-]*\s*[-\u2013\u2014]\s*(?:hardware\s+)?set\b",
        text,
    ):
        return "id_first"
    # Bare set: "Set X" or "Set #X" (without hardware prefix)
    if re.search(r"(?i)\bset\s*[# ]\s*[A-Z0-9]", text):
        return "bare_set"
    return "unknown"


def _detect_door_number_format(text: str) -> str:
    """
    Check door number patterns in text and return the dominant format.

    Returns: "dash_numeric" | "alpha_prefix" | "dotted" | "bare_numeric" | "mixed" | "unknown"
    """
    counts = {
        "dash_numeric": len(re.findall(r"\b\d{2,4}-\d{1,3}[A-Z]?\b", text)),
        "alpha_prefix": len(re.findall(r"\b[A-Z]{1,2}-\d{2,4}[A-Z]?\b", text)),
        "dotted": len(re.findall(
            r"\b\d{1,3}\.[A-Z]\d{1,3}\.\d{2,4}[A-Z]?\b", text
        )),
        "bare_numeric": len(re.findall(
            r"\b(?:[A-Z]\d{3,4}[A-Z]?|\d{3,4}[A-Z])\b", text
        )),
    }
    total = sum(counts.values())
    if total == 0:
        return "unknown"

    max_format = max(counts, key=counts.get)
    # If no single format dominates (>60%) across 3+ matches, it's mixed
    if total >= 3 and counts[max_format] / total < 0.6:
        return "mixed"
    return max_format


def _detect_table_strategy(page, tables: list) -> str:
    """
    Detect if pdfplumber tables have explicit ruled lines or are text-aligned.

    Returns: "lines" | "text" | "none"
    """
    if not tables:
        return "none"
    lines = page.lines if hasattr(page, "lines") else []
    rects = page.rects if hasattr(page, "rects") else []
    rule_count = len(lines) + len(rects)
    # 4+ ruling elements suggests explicit grid lines
    if rule_count >= 4:
        return "lines"
    return "text"


def fingerprint_page(page, page_type: str) -> dict:
    """
    Generate structural fingerprint for a single page.

    Called after classify_page() to capture table structure, heading format,
    and door number format metadata for document profiling.
    """
    text = page.extract_text() or ""
    tables = page.find_tables()

    # Max columns from first row of any table
    col_count = 0
    for table in tables:
        extracted = table.extract()
        if extracted and extracted[0]:
            col_count = max(col_count, len(extracted[0]))

    return {
        "table_count": len(tables),
        "table_strategy": _detect_table_strategy(page, tables),
        "col_count": col_count,
        "heading_format": (
            _detect_heading_format(text)
            if page_type == PAGE_TYPE_HARDWARE_SET
            else None
        ),
        "has_qty_column": bool(re.search(r"(?i)\b(qty|quantity)\b", text)),
        "door_number_format": (
            _detect_door_number_format(text)
            if page_type in (PAGE_TYPE_DOOR_SCHEDULE, PAGE_TYPE_HARDWARE_SET)
            else None
        ),
    }


def classify_page(page, page_index: int) -> dict:
    """
    Classify a single page by extracting its text and matching patterns.
    Returns a dict with page info, type, confidence, and any section labels found.
    """
    text = page.extract_text() or ""
    text_lower = text.lower()
    word_count = len(text.split())

    # Detect scanned / CIDFont issues
    scan_status = detect_page_scan_status(page)

    result = {
        "index": page_index,
        "type": PAGE_TYPE_OTHER,
        "confidence": 0.0,
        "section_labels": [],
        "hw_set_ids": [],
        "has_door_numbers": False,
        "word_count": word_count,
        "is_scanned": scan_status["is_scanned"],
        "has_cid_issues": scan_status["has_cid_issues"],
        "garbage_ratio": scan_status["garbage_ratio"],
    }

    # Check for cover page (can appear anywhere, higher confidence early)
    if COVER_PATTERNS.search(text):
        result["type"] = PAGE_TYPE_COVER
        result["confidence"] = 0.9 if page_index < 5 else 0.7
        return result

    # Check for reference/legend pages
    ref_matches = REFERENCE_PATTERNS.findall(text)
    if ref_matches:
        result["type"] = PAGE_TYPE_REFERENCE
        result["confidence"] = 0.85
        result["section_labels"] = [m[0] if isinstance(m, tuple) else m for m in ref_matches[:3]]
        return result

    # Check for door schedule pages with EXPLICIT headers (e.g. "Door Schedule",
    # "Opening List", "Door Index"). These take priority because opening lists
    # sometimes contain "Set" in column headers which could trigger HW_SET_HEADING.
    has_door_schedule_header = bool(DOOR_SCHEDULE_HEADERS.search(text))
    door_nums = DOOR_NUMBER_VALUES.findall(text)

    if has_door_schedule_header:
        result["type"] = PAGE_TYPE_DOOR_SCHEDULE
        result["confidence"] = 0.9
        result["has_door_numbers"] = True
        return result

    # Check for hardware set pages BEFORE door-number-only classification.
    # SpecWorks/kinship-format set pages contain door assignments with many
    # door numbers — heading match must take priority over door number count.
    hw_matches = list(HW_SET_HEADING.finditer(text))
    hw_item_matches = HARDWARE_ITEM_NAMES.findall(text)

    if hw_matches:
        set_ids = []
        for m in hw_matches:
            # Groups: (heading_id, set_id, standalone_set_id)
            sid = m.group(2) or m.group(3) or m.group(1) or ""
            if sid:
                set_ids.append(sid.strip())
        result["type"] = PAGE_TYPE_HARDWARE_SET
        result["hw_set_ids"] = set_ids
        result["confidence"] = 0.95
        result["section_labels"] = [f"Set {s}" for s in set_ids]
        return result

    # If no heading but lots of hardware item names, likely a continuation page
    if len(hw_item_matches) >= 3:
        result["type"] = PAGE_TYPE_HARDWARE_SET
        result["confidence"] = 0.7
        result["section_labels"] = ["continuation"]
        return result

    # Door number values without explicit headers or hw_set headings
    if len(door_nums) >= 5:
        result["type"] = PAGE_TYPE_DOOR_SCHEDULE
        result["confidence"] = 0.6
        result["has_door_numbers"] = True
        return result

    # Pages with 3-4 door numbers but no header — weaker signal
    if len(door_nums) >= 3:
        result["type"] = PAGE_TYPE_DOOR_SCHEDULE
        result["confidence"] = 0.5
        result["has_door_numbers"] = True
        return result

    # Low-content pages are likely cover/separator
    if word_count < 20:
        result["type"] = PAGE_TYPE_COVER
        result["confidence"] = 0.5
        return result

    return result


def postprocess_cut_sheets(pages: list[dict]) -> None:
    """Reclassify cut sheet pages after 'End of Schedule' boundary.

    SpecWorks PDFs end the hardware schedule with an 'End of Schedule' page,
    followed by manufacturer cut sheets (catalog pages). These cut sheets
    contain hardware terminology (hinge, closer, etc.) that causes
    misclassification as hardware_set continuation pages.

    Modifies pages in-place.
    """
    # Find the last page with an actual hw_set heading ID
    last_heading_page = -1
    end_of_schedule_page = -1
    for p in pages:
        if p.get("type") == PAGE_TYPE_HARDWARE_SET and p.get("hw_set_ids"):
            last_heading_page = p["index"]
        if p.get("type") == PAGE_TYPE_REFERENCE and "end of schedule" in (
            " ".join(p.get("section_labels", [])).lower()
        ):
            end_of_schedule_page = p["index"]

    # Only apply cut sheet reclassification with an explicit boundary marker.
    # The last_heading_page fallback is too aggressive for formats that rely
    # on "continuation" classification (e.g., AKN/Comsense).
    if end_of_schedule_page > 0:
        boundary = end_of_schedule_page
    else:
        return  # No explicit boundary found — do not reclassify

    # Reclassify pages after the boundary that don't have heading IDs
    for p in pages:
        if p["index"] <= boundary:
            continue
        if p.get("hw_set_ids"):
            continue  # Page has actual heading IDs, keep it
        if p["type"] in (PAGE_TYPE_HARDWARE_SET, PAGE_TYPE_DOOR_SCHEDULE):
            p["type"] = PAGE_TYPE_REFERENCE
            p["confidence"] = 0.6
            p["section_labels"] = ["cut_sheet"]


def detect_boundaries(pages: list[dict], max_chunk_pages: int = 40) -> list[dict]:
    """
    Given classified pages, find optimal split points that keep sections together.

    Rules:
    1. Never split in the middle of a hardware set (same set_id across pages)
    2. Never split in the middle of a door schedule run
    3. Split at transitions between page types (door_schedule → hardware_set)
    4. Split at new hardware set headings
    5. Enforce max chunk size (default 40 pages) — if a section is larger,
       split at sub-section boundaries (individual hardware set headings)
    6. Reference/cover pages are NOT included in chunks — they're returned
       separately for injection into every chunk

    Returns a list of chunk definitions:
    [{ "start": 0, "end": 15, "types": ["door_schedule"], "labels": [...] }, ...]
    """
    # Separate reference and cover pages from content pages
    content_pages = []
    reference_page_indices = []

    for p in pages:
        if p["type"] in (PAGE_TYPE_REFERENCE, PAGE_TYPE_COVER):
            reference_page_indices.append(p["index"])
        else:
            content_pages.append(p)

    if not content_pages:
        return [], reference_page_indices

    # Find natural break points between content pages
    breaks = []  # indices into content_pages where a new section starts

    for i in range(1, len(content_pages)):
        prev = content_pages[i - 1]
        curr = content_pages[i]

        # Type transition = always a break
        if prev["type"] != curr["type"]:
            breaks.append(i)
            continue

        # Within hardware sets: new set heading = break point
        if curr["type"] == PAGE_TYPE_HARDWARE_SET:
            if curr["hw_set_ids"] and curr["section_labels"] != ["continuation"]:
                # New set heading found — this is a potential break
                # But only if it's a different set than what's on the previous page
                prev_sets = set(prev.get("hw_set_ids", []))
                curr_sets = set(curr.get("hw_set_ids", []))
                if curr_sets and not curr_sets.intersection(prev_sets):
                    breaks.append(i)
                    continue

    # Build initial segments from break points
    segments = []
    seg_start = 0
    for b in breaks:
        segments.append((seg_start, b))
        seg_start = b
    segments.append((seg_start, len(content_pages)))

    # Merge small segments and enforce max chunk size
    chunks = []
    current_start = segments[0][0]
    current_end = segments[0][1]

    for seg_start, seg_end in segments[1:]:
        seg_pages = seg_end - seg_start
        current_pages = current_end - current_start

        # If adding this segment stays under max, merge
        if current_pages + seg_pages <= max_chunk_pages:
            current_end = seg_end
        else:
            # Finalize current chunk
            chunks.append((current_start, current_end))
            current_start = seg_start
            current_end = seg_end

    # Don't forget the last chunk
    chunks.append((current_start, current_end))

    # Handle oversized chunks — split at hardware set boundaries within them
    final_chunks = []
    for chunk_start, chunk_end in chunks:
        chunk_size = chunk_end - chunk_start
        if chunk_size <= max_chunk_pages:
            final_chunks.append((chunk_start, chunk_end))
        else:
            # Find sub-boundaries within this oversized chunk
            sub_breaks = []
            for i in range(chunk_start + 1, chunk_end):
                p = content_pages[i]
                if p["hw_set_ids"] and p["section_labels"] != ["continuation"]:
                    sub_breaks.append(i)

            if sub_breaks:
                # Split at sub-boundaries, respecting max size
                sub_start = chunk_start
                for sb in sub_breaks:
                    if sb - sub_start >= max_chunk_pages:
                        final_chunks.append((sub_start, sb))
                        sub_start = sb
                final_chunks.append((sub_start, chunk_end))
            else:
                # No sub-boundaries found — forced fixed split as last resort
                for fs in range(chunk_start, chunk_end, max_chunk_pages):
                    final_chunks.append((fs, min(fs + max_chunk_pages, chunk_end)))

    # Convert to output format with actual page indices
    result = []
    for cs, ce in final_chunks:
        chunk_pages = content_pages[cs:ce]
        page_indices = [p["index"] for p in chunk_pages]
        types = list(set(p["type"] for p in chunk_pages))
        labels = []
        for p in chunk_pages:
            labels.extend(p.get("section_labels", []))

        result.append({
            "pages": page_indices,
            "start_page": page_indices[0],
            "end_page": page_indices[-1],
            "page_count": len(page_indices),
            "types": types,
            "labels": list(set(labels))[:10],  # cap label list
            "hw_set_ids": list(set(
                sid for p in chunk_pages for sid in p.get("hw_set_ids", [])
            )),
        })

    return result, reference_page_indices


def build_profile(pages: list, source: str) -> dict:
    """
    Aggregate per-page fingerprints into a document-level profile.

    This profile characterizes the PDF's structural patterns so downstream
    extraction can branch logic by document format. Nothing reads this yet —
    it is returned in the classify-pages response for future use.
    """
    heading_formats = []
    door_number_formats = []
    table_strategies = []

    unique_set_ids: set = set()  # BUG-23: track unique set IDs, not cumulative
    hw_set_count_raw = 0  # Keep raw cumulative for debugging
    door_schedule_pages = 0
    has_reference_tables = False

    for p in pages:
        fp = p.get("fingerprint") or {}

        hf = fp.get("heading_format")
        if hf and hf != "unknown":
            heading_formats.append(hf)

        dnf = fp.get("door_number_format")
        if dnf and dnf != "unknown":
            door_number_formats.append(dnf)

        ts = fp.get("table_strategy")
        if ts and ts != "none":
            table_strategies.append(ts)

        if p["type"] == PAGE_TYPE_HARDWARE_SET and p.get("hw_set_ids"):
            hw_set_count_raw += len(p["hw_set_ids"])
            unique_set_ids.update(p["hw_set_ids"])
        if p["type"] == PAGE_TYPE_DOOR_SCHEDULE:
            door_schedule_pages += 1
        if p["type"] == PAGE_TYPE_REFERENCE:
            has_reference_tables = True

    def _most_common(lst, default="unknown"):
        if not lst:
            return default
        return Counter(lst).most_common(1)[0][0]

    return {
        "source": source,
        "heading_format": _most_common(heading_formats),
        "door_number_format": _most_common(door_number_formats),
        "table_strategy": _most_common(table_strategies),
        "hw_set_count": len(unique_set_ids),  # BUG-23: unique, not cumulative
        "hw_set_count_raw": hw_set_count_raw,  # BUG-23: raw cumulative for debugging
        "door_schedule_pages": door_schedule_pages,
        "has_reference_tables": has_reference_tables,
    }


class handler(BaseHTTPRequestHandler):
    """Vercel serverless handler for page classification."""

    def do_POST(self):
        try:
            if not require_internal_token(self):
                return

            content_length = int(self.headers.get("Content-Length", 0))
            raw_body = self.rfile.read(content_length)
            try:
                body_str = raw_body.decode("utf-8")
            except UnicodeDecodeError as ue:
                self.send_response(400)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({
                    "error": f"Request body is not valid UTF-8: {ue}"
                }).encode())
                return
            try:
                data = json.loads(body_str)
            except json.JSONDecodeError as je:
                self.send_response(400)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({
                    "error": f"Request body is not valid JSON: {je}"
                }).encode())
                return

            pdf_base64 = data.get("pdf_base64") or data.get("pdfBase64", "")
            max_chunk_pages = data.get("maxChunkPages", 40)

            if not pdf_base64:
                self.send_response(400)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"error": "pdf_base64 is required"}).encode())
                return

            # Decode PDF
            pdf_bytes = base64.b64decode(pdf_base64)
            pdf_file = io.BytesIO(pdf_bytes)

            with pdfplumber.open(pdf_file, unicode_norm="NFKC") as pdf:
                total_pages = len(pdf.pages)

                # Phase 0: Detect PDF source from metadata
                pdf_source = detect_pdf_source(pdf.metadata or {})

                # Phase 1: Classify every page (fast — text extraction only)
                page_classifications = []
                for i, page in enumerate(pdf.pages):
                    classification = classify_page(page, i)
                    classification["fingerprint"] = fingerprint_page(
                        page, classification["type"]
                    )
                    page_classifications.append(classification)

                # Phase 1.5: Post-process to reclassify cut sheet pages
                postprocess_cut_sheets(page_classifications)

                # Phase 2: Detect optimal chunk boundaries
                chunks, reference_pages = detect_boundaries(
                    page_classifications,
                    max_chunk_pages=max_chunk_pages,
                )

            # Document-level scan/quality summary
            scanned_pages = sum(1 for p in page_classifications if p.get("is_scanned"))
            cid_issue_pages = sum(1 for p in page_classifications if p.get("has_cid_issues"))

            # Determine recommended extraction strategy
            if scanned_pages > total_pages * 0.5:
                extraction_strategy = "claude_vision"
            elif cid_issue_pages > total_pages * 0.3:
                extraction_strategy = "pymupdf"
            else:
                extraction_strategy = "pdfplumber"

            # Build document profile from per-page fingerprints
            profile = build_profile(page_classifications, pdf_source)

            # Build response
            response = {
                "success": True,
                "total_pages": total_pages,
                "pdf_source": pdf_source,
                "profile": profile,
                "extraction_strategy": extraction_strategy,
                "page_classifications": page_classifications,
                "chunks": chunks,
                "reference_pages": reference_pages,
                "summary": {
                    "door_schedule_pages": sum(
                        1 for p in page_classifications
                        if p["type"] == PAGE_TYPE_DOOR_SCHEDULE
                    ),
                    "hardware_set_pages": sum(
                        1 for p in page_classifications
                        if p["type"] == PAGE_TYPE_HARDWARE_SET
                    ),
                    "reference_pages": sum(
                        1 for p in page_classifications
                        if p["type"] == PAGE_TYPE_REFERENCE
                    ),
                    "cover_pages": sum(
                        1 for p in page_classifications
                        if p["type"] == PAGE_TYPE_COVER
                    ),
                    "other_pages": sum(
                        1 for p in page_classifications
                        if p["type"] == PAGE_TYPE_OTHER
                    ),
                    "scanned_pages": scanned_pages,
                    "cid_issue_pages": cid_issue_pages,
                    "chunk_count": len(chunks),
                },
            }

            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps(response).encode())

        except Exception as e:
            self.send_response(500)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({
                "success": False,
                "error": str(e),
                "traceback": traceback.format_exc(),
            }).encode())
