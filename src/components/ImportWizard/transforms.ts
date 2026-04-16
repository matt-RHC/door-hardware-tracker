/**
 * Shared response transformation functions for ImportWizard steps.
 *
 * These convert Python API responses into the TypeScript shapes the wizard
 * consumes. They were previously duplicated inline across step components
 * and in __tests__/transforms.test.ts — extracted here per Phase 2
 * close-out (ROADMAP.md → Medium Priority: Transform function duplication)
 * so the test and runtime use the same implementation.
 */

import type {
  ClassifyPagesResponse,
  DetectMappingResponse,
  DoorEntry,
  TriageResult,
} from "./types";

/**
 * Convert the `/api/parse-pdf/classify-pages` Python response into
 * `ClassifyPagesResponse`.
 *
 * Python returns: `{ page_classifications: [{index, type, ...}], summary: {...} }`
 * TS expects:     `{ pages: [{page_number, page_type, confidence, ...}], summary: {...} }`
 */
export function transformClassifyResponse(
  raw: Record<string, unknown>,
): ClassifyPagesResponse {
  const pageClassifications = (raw.page_classifications ?? []) as Array<{
    index: number;
    type: string;
    confidence?: number;
    section_labels?: string[];
    hw_set_ids?: string[];
    has_door_numbers?: boolean;
    is_scanned?: boolean;
  }>;

  const rawSummary = (raw.summary ?? {}) as { scanned_pages?: number };

  return {
    pages: pageClassifications.map((p) => ({
      page_number: p.index,
      page_type: p.type as ClassifyPagesResponse["pages"][0]["page_type"],
      confidence: p.confidence ?? 1,
      section_labels: p.section_labels ?? [],
      hw_set_ids: p.hw_set_ids ?? [],
      has_door_numbers: p.has_door_numbers ?? false,
      is_scanned: p.is_scanned ?? false,
    })),
    summary: {
      total_pages:
        (raw.total_pages as number) ?? pageClassifications.length,
      door_schedule_pages: pageClassifications
        .filter((p) => p.type === "door_schedule")
        .map((p) => p.index),
      hardware_set_pages: pageClassifications
        .filter((p) => p.type === "hardware_set")
        .map((p) => p.index),
      submittal_pages: pageClassifications
        .filter((p) => p.type === "reference")
        .map((p) => p.index),
      cover_pages: pageClassifications
        .filter((p) => p.type === "cover")
        .map((p) => p.index),
      other_pages: pageClassifications
        .filter((p) => p.type === "other")
        .map((p) => p.index),
      scanned_pages: rawSummary.scanned_pages ?? 0,
    },
    profile:
      (raw.profile as ClassifyPagesResponse["profile"]) ?? undefined,
    extraction_strategy:
      (raw.extraction_strategy as string | undefined) ?? undefined,
  };
}

/**
 * Convert the `/api/parse-pdf/detect-mapping` Python response into
 * `DetectMappingResponse`.
 *
 * `fallbackPage` is REQUIRED (no default). The caller passes the first
 * detected door-schedule page index as the fallback — defaulting to `0`
 * would silently route to a cover page when `raw.page_index` is missing.
 */
export function transformDetectMappingResponse(
  raw: Record<string, unknown>,
  fallbackPage: number,
): DetectMappingResponse {
  const headers = (raw.headers ?? []) as string[];
  const autoMapping = (raw.auto_mapping ?? {}) as Record<string, number>;
  const confidenceScores = (raw.confidence_scores ?? {}) as Record<
    string,
    number
  >;

  const indexToField = new Map<number, string>();
  for (const [field, colIdx] of Object.entries(autoMapping)) {
    indexToField.set(colIdx, field);
  }

  return {
    columns: headers.map((header, i) => {
      const mappedField = indexToField.get(i) ?? null;
      const confidence = mappedField
        ? (confidenceScores[mappedField] ?? 0)
        : 0;
      return {
        source_header: header,
        mapped_field: mappedField as keyof DoorEntry | null,
        confidence,
      };
    }),
    best_door_schedule_page: (raw.page_index as number) ?? fallbackPage,
    raw_headers: headers,
  };
}

/**
 * Convert the `/api/parse-pdf/triage` Python response into `TriageResult`.
 *
 * `extractedDoors` is the full set of candidates sent to triage — any door
 * without a classification, or classified as `door`, is accepted.
 */
export function transformTriageResponse(
  raw: Record<string, unknown>,
  extractedDoors: DoorEntry[],
): TriageResult {
  const triageError: boolean = raw.triage_error === true;
  const triageErrorMessage: string =
    (raw.triage_error_message as string | undefined) ?? "";
  const retryable: boolean = raw.retryable === true;

  const classifications: Array<{
    door_number: string;
    class: string;
    confidence: string;
    reason: string;
  }> = Array.isArray(raw.classifications)
    ? (raw.classifications as Array<{
        door_number: string;
        class: string;
        confidence: string;
        reason: string;
      }>)
    : [];

  const acceptedDoors = extractedDoors.filter((d) => {
    const c = classifications.find((cl) => cl.door_number === d.door_number);
    return !c || c.class === "door";
  });

  // Flag by_others doors and low-confidence non-door classifications.
  // Don't flag class="door" items — if triage failed, all doors come back
  // as class="door" + confidence="low" and flagging them all is useless.
  const flagged = classifications
    .filter(
      (c) =>
        c.class === "by_others" ||
        (c.confidence === "low" && c.class !== "door"),
    )
    .map((c) => ({
      door_number: c.door_number,
      reason: c.reason,
      confidence:
        c.confidence === "high" ? 0.9 : c.confidence === "medium" ? 0.6 : 0.3,
    }));

  const stats = (raw.stats ?? {}) as Record<string, number>;

  return {
    doors_found: stats.total ?? extractedDoors.length,
    by_others: stats.by_others ?? 0,
    rejected: stats.rejected ?? 0,
    accepted: acceptedDoors,
    flagged,
    triage_error: triageError,
    triage_error_message: triageErrorMessage || undefined,
    retryable,
  };
}
