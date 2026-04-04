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
    "hw_set": "HW Set",
    "hw_heading": "HW Heading",
    "location": "Location",
    "door_type": "Door Type",
    "frame_type": "Frame Type",
    "fire_rating": "Fire Rating",
    "hand": "Hand/Swing",
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


def find_door_schedule_table(page) -> tuple[list[str], list[list[str]], str]:
    """
    Find the Opening List / Door Schedule table on a page.
    Returns (headers, sample_rows, method).
    """
    # Try line-based detection first (most PDFs have visible grid lines)
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
            # Check if this looks like a door schedule
            header_lower = " ".join(headers).lower()
            has_door_col = any(
                score_header_for_field(h, "door_number") >= 0.3
                for h in headers if h
            )
            if not has_door_col:
                continue
            # Extract sample data rows (first 5)
            sample_rows = []
            for row in table[1:6]:
                sample_rows.append([clean_cell(c) for c in row])
            return headers, sample_rows, strategy

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

                        self._send_json(200, {
                            "success": True,
                            "page_index": pi,
                            "total_pages": len(pdf.pages),
                            "headers": headers,
                            "auto_mapping": mapping,
                            "confidence_scores": scores,
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
