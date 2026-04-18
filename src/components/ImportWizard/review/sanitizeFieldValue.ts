/**
 * sanitizeFieldValue — strip OCR / column-marker noise from a region-extract
 * string BEFORE it is shown to the user in FieldAssignmentPanel and again
 * BEFORE the user's confirmed value is written to DoorEntry state.
 *
 * Background (demo-critical, 2026-04-17): region-extract returns either
 *   - detectedValue (already sanitized by Python when the field regex fully
 *     matched), OR
 *   - rawText.trim() (fallback when Python fell through to the location branch)
 *
 * The rawText fallback carries over column markers that Python did not strip:
 *
 *   "x 90Min"
 *     -> leading "x " from the column heading that Python's _HEADING_*_RE
 *        fullmatch rejected; fire_rating gets recorded as literally "x 90Min".
 *
 *   "R)\nDH1 UPS-C 110-07 to/from DH1 UPS-D 110-08"
 *     -> leading "R)" or "L)" leaf-side marker on a location column; the
 *        paren+newline leaks into the stored location string and pushes the
 *        hand field into location.
 *
 *   "x"  /  "R)"  /  "L)"  alone
 *     -> entirely noise; user apply on these would commit an empty-ish value.
 *
 * Design decisions:
 *   1. Pure function, per-field. We deliberately do NOT try to be
 *      field-agnostic — "x " is noise on fire_rating but could be part of a
 *      legitimate location string like "ROOM X 105". The caller passes field,
 *      so we only strip markers we know are wrong FOR THAT FIELD.
 *
 *   2. Conservative. We match leading markers followed by whitespace or
 *      newline; we do NOT strip anywhere else in the string. A location
 *      like "ROOM R) 105" stays untouched.
 *
 *   3. Idempotent. sanitize(sanitize(x)) === sanitize(x) for any x, so the
 *      double-call pattern (initial state + handleConfirm) is safe.
 *
 *   4. Never throws. Null/undefined/empty all return "".
 *
 * This helper does NOT:
 *   - Invent missing characters (e.g. "DE" -> "DELHR"). That's a truncation
 *     problem and needs a different fix (Python regex, or re-extract).
 *   - Validate content (a fire_rating of "banana" passes through unchanged).
 *     Validation lives in the field-specific confidence scoring, not here.
 */

import type { RegionExtractField } from "@/lib/schemas/parse-pdf";

// Leading leaf-side markers "R)" or "L)" followed by whitespace/newline.
// Common on location columns when Python falls through to the generic
// location branch without stripping the leaf-marker prefix.
// Multiple markers (e.g. "R)\nL)\nROOM 101") are stripped greedily.
const LEAF_MARKER_PREFIX_RE = /^(?:[RL]\)[\s\n]*)+/;

// Leading "x " column marker followed by whitespace. Seen on fire_rating
// ("x 90Min") when Python's _HEADING_DOOR_HAND_RE.fullmatch rejected the
// string and fell through. The marker is always lowercase 'x'; a leading
// capital 'X' could be a real label (e.g. "X-RAY ROOM") so we leave it.
// Trailing whitespace is optional so a bare "x" (after outer trim) also
// matches — an 'x' with nothing after it is always noise.
const X_MARKER_PREFIX_RE = /^x(?:\s+|$)/;

// Trailing paren-only token like " R)" or "L)" at end of a location string.
// Rarer, but observed in the Waymo extraction where two-line labels got
// concatenated by Python's line joiner. Only stripped from location.
const TRAILING_LEAF_MARKER_RE = /\s+[RL]\)\s*$/;

/**
 * Sanitize a raw field value for the given target field.
 *
 * @param field  Which field this value will be written to. Determines which
 *               markers are considered noise vs. legitimate content.
 * @param raw    The unsanitized string (from region-extract.rawText or
 *               region-extract.detectedValue). Null/undefined treated as "".
 * @returns      The sanitized string, trimmed. Empty string if all content
 *               was markers — callers should treat empty as "no value" and
 *               refuse to apply (FieldAssignmentPanel already does via the
 *               `!value.trim()` guard in handleConfirm).
 */
export function sanitizeFieldValue(
  field: RegionExtractField,
  raw: string | null | undefined,
): string {
  if (raw == null) return "";
  let s = String(raw);

  // Universal: trim outer whitespace first so marker regexes see the real
  // leading char. Applied before AND after marker stripping so the result
  // is always a clean, minimally-trimmed string.
  s = s.trim();
  if (s.length === 0) return "";

  switch (field) {
    case "fire_rating": {
      // "x 90Min" -> "90Min"; "x\n90Min" -> "90Min"
      s = s.replace(X_MARKER_PREFIX_RE, "");
      // Fire rating should never carry a leaf marker, but extract leaks happen.
      s = s.replace(LEAF_MARKER_PREFIX_RE, "");
      break;
    }
    case "location": {
      // "R)\nROOM 101" -> "ROOM 101"; "L)\nL)\nROOM 101" -> "ROOM 101"
      s = s.replace(LEAF_MARKER_PREFIX_RE, "");
      // "ROOM 101 R)" at end -> "ROOM 101"
      s = s.replace(TRAILING_LEAF_MARKER_RE, "");
      break;
    }
    case "hand": {
      // Leaf markers on hand are always noise (hand values are short codes
      // like "RHR", "LH", "LHR"); strip them. The truncation case ("DE"
      // from "DELHR") is NOT fixable here — see module docstring.
      s = s.replace(LEAF_MARKER_PREFIX_RE, "");
      s = s.replace(X_MARKER_PREFIX_RE, "");
      break;
    }
    case "door_number": {
      // door_number is the primary key across the wizard; sanitizing it is
      // a safety hazard. Only collapse whitespace — that's always safe.
      break;
    }
    default: {
      // Exhaustiveness check: if a new RegionExtractField is added and this
      // switch isn't updated, TypeScript's `never` will fail the build.
      const _exhaustive: never = field;
      void _exhaustive;
    }
  }

  return s.trim();
}
