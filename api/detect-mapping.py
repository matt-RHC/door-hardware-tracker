"""
Lightweight endpoint to detect column mapping from a sample PDF page.

Returns the raw headers, auto-detected column mapping with confidence scores,
and sample data rows so the user can verify/override before full extraction.

Location: /api/detect-mapping.py (Vercel Python runtime)
"""

import base64
import io
import json
import re
import traceback
import unicodedata
from http.server import BaseHTTPRequestHandler

import pdfplumber

# Import column detection logic from extract-tables
# (Vercel bundles all /api/*.py files, so we duplicate the essentials)

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

STANDARD_COLUMN_ORDER = [
    "door_number", "hw_set", "hw_heading", "location",
    "door_type", "frame_type", "fire_rating", "hand",
]

FIELD_LABELS = {
    "door_number": "Door Number",
    "hw_set": "Hardware Set",
    "hw_heading": "Hardware Heading",
    "location": "Location",
    "door_type": "Door Type",
    "frame_type": "Frame Type",
    "fire_rating": "Fire Rating",
    "hand": "Hand / Swing",
}


def clean_cell(val) -> str:
    if val is None:
        return ""
    s = str(val).strip()
    mojibake_map = {
        "\u00c2\u00b7": "\u00b7",
        "\u00c3\u0097": "\u00d7",
        "\u00c3\u00b7": "\u00f7",
        "\u00c2\u00bd": "\u00bd",
        "\u00c2\u00bc": "\u00bc",
        "\u00c2\u00be": "\u00be",
        "\u00c2\u00ae": "\u00ae",
        "\u00c2\u00a9": "\u00a9",
        "\u00e2\u0080\u0093": "\u2013",
        "\u00e2\u0080\u0094": "\u2014",
        "\u00e2\u0080\u0099": "\u2019",
        "\u00e2\u0080\u0098": "\u2018",
        "\u00e2\u0080\u009c": "\u201c",
        "\u00e2\u0080\u009d": "\u201d",
    }
    for bad, good in mojibake_map.items():
        if bad in s:
            s = s.replace(bad, good)
    s = unicodedata.normalize("NFC", s)
    s = s.rstrip("\u2014\u2013\u2012-")
    return s


def score_header_for_field(header: str, field: str) -> float:
    h = header.lower().strip()
    if not h:
        return 0.0
    tokens = re.split(r"[\s._/#\-]+", h)
    tokens = [t for t in tokens if t]
    keywords = COLUMN_KEYWORDS.get(field, [])
    score = 0.0
    matched_keywords = 0
    for token in tokens:
        for keyword, weight in keywords:
            if token == keyword:
                score += weight
                matched_keywords += 1
                break
            if len(token) >= 3 and (token.startswith(keyword) or keyword.startswith(token)):
                score += weight * 0.7
                matched_keywords += 1
                break
    if matched_keywords >= 2:
        score *= 1.2
    if len(tokens) > 3 and matched_keywords <= 1:
        score *= 0.5
    return min(score, 1.0)


def detect_column_mapping(headers: list[str]) -> dict[str, int]:
    fields = list(COLUMN_KEYWORDS.keys())
    mapping: dict[str, int] = {}
    used_columns: set[int] = set()
    candidates: list[tuple[float, str, int]] = []
    for i, header in enumerate(headers):
        if not header or not header.strip():
            continue
        for field in fields:
            score = score_header_for_field(header, field)
            if score >= 0.3:
                candidates.append((score, field, i))
    candidates.sort(key=lambda x: -x[0])
    for score, field, col_idx in candidates:
        if field in mapping or col_idx in used_columns:
            continue
        mapping[field] = col_idx
        used_columns.add(col_idx)
    if "door_number" in mapping and len(mapping) < len(headers):
        door_col = mapping["door_number"]
        for offset, field in enumerate(STANDARD_COLUMN_ORDER):
            col_idx = door_col + offset
            if field not in mapping and col_idx < len(headers) and col_idx not in used_columns:
                h = (headers[col_idx] or "").strip()
                if h and not re.match(r"^\d+$", h):
                    best_score = score_header_for_field(h, field)
                    if best_score >= 0.15:
                        mapping[field] = col_idx
                        used_columns.add(col_idx)
    return mapping


def get_confidence_scores(headers: list[str], mapping: dict[str, int]) -> dict[str, float]:
    """Return confidence score for each mapped field."""
    scores: dict[str, float] = {}
    for field, col_idx in mapping.items():
        if col_idx < len(headers):
            scores[field] = round(score_header_for_field(headers[col_idx], field), 2)
    return scores


def looks_like_door_number(val: str) -> bool:
    """Quick check if a cell value looks like a real door number (not an address or name)."""
    s = val.strip()
    if not s:
        return False
    # Must contain at least one digit
    if not re.search(r"\d", s):
        return False
    # Must NOT contain spaces (door numbers are single tokens)
    if " " in s:
        return False
    # Must be reasonably short (door numbers are <20 chars)
    if len(s) > 20:
        return False
    # Reject phone numbers
    if re.match(r"^\d{3}[-.]?\d{3}[-.]?\d{4}$", s):
        return False
    # Reject bare numbers (quantities, page refs)
    if re.match(r"^\d{1,3}$", s):
        return False
    # Reject years (e.g., 2024, 1999)
    if re.match(r"^(19|20)\d{2}$", s):
        return False
    # Reject ZIP codes
    if re.match(r"^\d{5}(-\d{4})?$", s):
        return False
    return True


def _row_has_contact_data(row: list[str]) -> bool:
    """Check if a row contains phone, email, or address patterns."""
    text = " ".join(row).lower()
    # Phone patterns
    if re.search(r"\d{3}[-.]?\d{3}[-.]?\d{4}", text):
        return True
    # Email patterns
    if re.search(r"[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}", text):
        return True
    # Address keywords
    if re.search(r"\b(street|st\.|suite|ste\.|avenue|ave\.|blvd|boulevard|city|state|zip|po box)\b", text):
        return True
    return False


def find_door_schedule_table(page) -> tuple[list[str], list[list[str]], str]:
    """
    Find the Opening List / Door Schedule table on a page.
    Returns (headers, sample_rows, method).

    Requires BOTH a door_number column AND at least one other recognized field
    to avoid false positives on cover/title page tables.
    """
    best_candidate = None
    best_score = 0.0

    for strategy in ["lines", "text"]:
        settings = {
            "vertical_strategy": strategy,
            "horizontal_strategy": strategy,
            "intersection_tolerance": 5,
            "snap_tolerance": 5,
        }
        if strategy == "text":
            settings.update({
                "join_tolerance": 5,
                "min_words_vertical": 2,
                "min_words_horizontal": 1,
                "text_x_tolerance": 3,
                "text_y_tolerance": 3,
            })

        tables = page.extract_tables(table_settings=settings)
        for table in tables:
            if not table or len(table) < 2:
                continue

            headers = [clean_cell(c) for c in table[0]]

            # Must have at least 3 columns — real door schedules have many fields
            if len([h for h in headers if h and h.strip()]) < 3:
                continue

            # Score all fields against all headers
            field_scores: dict[str, float] = {}
            for field in COLUMN_KEYWORDS:
                best_field_score = 0.0
                for h in headers:
                    if h and h.strip():
                        s = score_header_for_field(h, field)
                        best_field_score = max(best_field_score, s)
                if best_field_score >= 0.4:
                    field_scores[field] = best_field_score

            # MUST have door_number
            if "door_number" not in field_scores:
                continue

            # MUST have at least TWO other recognized fields (hw_set, location,
            # door_type, etc.) — a cover page won't have these
            other_fields = {k for k in field_scores if k != "door_number"}
            if len(other_fields) < 2:
                continue

            # Extract sample rows
            sample_rows = []
            for row in table[1:6]:
                sample_rows.append([clean_cell(c) for c in row])

            # MUST have at least 3 data rows — real schedules have many openings
            non_empty_rows = [r for r in sample_rows if any(c.strip() for c in r)]
            if len(non_empty_rows) < 3:
                continue

            # Reject tables where >50% of rows contain contact data (phones, emails, addresses)
            if non_empty_rows:
                contact_count = sum(1 for r in non_empty_rows if _row_has_contact_data(r))
                if contact_count / len(non_empty_rows) > 0.5:
                    continue

            # Content validation: check if sample data actually looks like
            # door numbers in the mapped door_number column
            mapping = detect_column_mapping(headers)
            door_col = mapping.get("door_number")
            if door_col is not None:
                door_values = [
                    row[door_col] for row in sample_rows
                    if door_col < len(row) and row[door_col].strip()
                ]
                if door_values:
                    valid_count = sum(
                        1 for v in door_values if looks_like_door_number(v)
                    )
                    # If less than 30% of sample values look like door numbers,
                    # this is probably not a door schedule
                    if valid_count / len(door_values) < 0.3:
                        continue

            # Compute overall quality score (average confidence of matched fields)
            avg_confidence = sum(field_scores.values()) / len(field_scores)
            # Bonus for more matched fields
            quality = avg_confidence * (1 + 0.1 * len(field_scores))

            if quality > best_score:
                best_score = quality
                best_candidate = (headers, sample_rows, strategy)

    if best_candidate:
        return best_candidate

    # --- Fallback: text-line header detection ---
    # Some PDFs have text-aligned tables without visible rules or consistent
    # column widths. pdfplumber's extract_tables() fails on these. Scan the
    # raw text for a line that looks like column headers.
    text = page.extract_text() or ""
    lines = text.split("\n")
    for line_idx, line in enumerate(lines[:20]):
        tokens = line.split()
        if len(tokens) < 3:
            continue
        # Reject prose/sentence lines: real column headers don't have
        # trailing commas or common English stop-words
        punct_count = sum(1 for t in tokens if t.endswith(",") or t.endswith(";"))
        if punct_count >= 2:
            continue
        stop_words = {"and", "the", "for", "with", "from", "that", "this", "are", "has", "been"}
        stop_count = sum(1 for t in tokens if t.lower() in stop_words)
        if stop_count >= 2:
            continue
        # Score the whole line as potential headers
        field_scores: dict[str, float] = {}
        for field in COLUMN_KEYWORDS:
            best_s = 0.0
            for token in tokens:
                best_s = max(best_s, score_header_for_field(token, field))
            if best_s >= 0.4:
                field_scores[field] = best_s
        if "door_number" not in field_scores:
            continue
        other = {k for k in field_scores if k != "door_number"}
        if len(other) < 2:
            continue
        # Found a plausible header line — extract data rows below it
        headers = tokens
        sample_rows = []
        for data_line in lines[line_idx + 1: line_idx + 6]:
            row_tokens = data_line.split()
            if row_tokens and len(row_tokens) >= 2:
                sample_rows.append(row_tokens)
        if len(sample_rows) < 3:
            continue
        # Validate door numbers in first column
        mapping = detect_column_mapping(headers)
        door_col = mapping.get("door_number")
        if door_col is not None:
            door_values = [
                r[door_col] for r in sample_rows
                if door_col < len(r) and r[door_col].strip()
            ]
            if door_values:
                valid_count = sum(
                    1 for v in door_values if looks_like_door_number(v)
                )
                if valid_count / len(door_values) < 0.3:
                    continue
        return headers, sample_rows, "text_line"

    return [], [], ""


class handler(BaseHTTPRequestHandler):
    def do_POST(self):
        try:
            content_length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(content_length)
            data = json.loads(body)

            pdf_base64 = data.get("pdf_base64", "")
            page_index = data.get("page_index", 0)

            if not pdf_base64:
                self._send_json(400, {
                    "success": False,
                    "error": "Missing pdf_base64"
                })
                return

            pdf_bytes = base64.b64decode(pdf_base64)
            pdf_file = io.BytesIO(pdf_bytes)

            with pdfplumber.open(pdf_file, unicode_norm="NFC") as pdf:
                # Try the requested page first, then scan all pages
                pages_to_try = [page_index] + [
                    i for i in range(len(pdf.pages)) if i != page_index
                ]

                for pi in pages_to_try:
                    if pi >= len(pdf.pages):
                        continue
                    page = pdf.pages[pi]
                    headers, sample_rows, method = find_door_schedule_table(page)
                    if headers:
                        mapping = detect_column_mapping(headers)
                        scores = get_confidence_scores(headers, mapping)

                        # Compute overall confidence — if too low, mark as
                        # low_confidence so frontend can warn the user
                        avg_confidence = (
                            sum(scores.values()) / len(scores)
                            if scores else 0.0
                        )
                        low_confidence = avg_confidence < 0.4 or len(mapping) < 2

                        self._send_json(200, {
                            "success": True,
                            "page_index": pi,
                            "total_pages": len(pdf.pages),
                            "headers": headers,
                            "auto_mapping": mapping,
                            "confidence_scores": scores,
                            "avg_confidence": round(avg_confidence, 2),
                            "low_confidence": low_confidence,
                            "sample_rows": sample_rows,
                            "field_labels": FIELD_LABELS,
                            "detection_method": method,
                        })
                        return

                # No door schedule found
                self._send_json(200, {
                    "success": False,
                    "error": "No door schedule table found on any page",
                    "total_pages": len(pdf.pages),
                    "headers": [],
                    "auto_mapping": {},
                    "confidence_scores": {},
                    "sample_rows": [],
                    "field_labels": FIELD_LABELS,
                    "detection_method": "",
                })

        except Exception as e:
            traceback.print_exc()
            self._send_json(500, {
                "success": False,
                "error": f"Detection failed: {str(e)}"
            })

    def _send_json(self, status: int, data: dict):
        body = json.dumps(data)
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body.encode())
