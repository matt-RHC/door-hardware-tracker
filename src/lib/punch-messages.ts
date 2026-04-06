/**
 * Punch — contextual message engine for the Import Wizard.
 *
 * Named after construction "punch walks" (QA inspection walk-throughs).
 * Generates helper messages from extraction metadata — no LLM calls.
 */

// ── Types ────────────────────────────────────────────────────────────

export type PunchSeverity = 'info' | 'success' | 'warning' | 'error';

export interface PunchMessage {
  text: string;
  severity: PunchSeverity;
  /** If true, render as an inline badge next to a specific field/row. */
  inline?: boolean;
  /** Optional field name this message relates to (for inline placement). */
  field?: string;
  /** Optional row identifier (door_number) for per-row inline tips. */
  rowId?: string;
}

/** Interactive validation question surfaced during triage. */
export interface PunchQuestion {
  id: string;
  text: string;
  options: string[];
  /** Set after user answers. */
  answer?: string;
  /** True if user clicked Skip. */
  dismissed?: boolean;
}

// ── Step 1 — Upload & Classify ───────────────────────────────────────

export interface ClassifyPagesData {
  totalPages: number;
  doorSchedulePages: number;
  hardwareSetPages: number;
  scannedPages?: number;
}

export function classifyMessages(data: ClassifyPagesData): PunchMessage[] {
  const msgs: PunchMessage[] = [];

  if (data.doorSchedulePages === 0 && data.hardwareSetPages === 0) {
    msgs.push({
      text: "I couldn't find a door schedule in this PDF. Double-check you uploaded the right file.",
      severity: 'error',
    });
    return msgs;
  }

  if (data.doorSchedulePages === 0) {
    msgs.push({
      text: "I couldn't find a door schedule in this PDF — only hardware set pages. The schedule may be in a separate file.",
      severity: 'warning',
    });
  }

  const parts: string[] = [];
  if (data.doorSchedulePages > 0)
    parts.push(`${data.doorSchedulePages} door schedule page${data.doorSchedulePages === 1 ? '' : 's'}`);
  if (data.hardwareSetPages > 0)
    parts.push(`${data.hardwareSetPages} hardware set page${data.hardwareSetPages === 1 ? '' : 's'}`);

  if (parts.length > 0) {
    msgs.push({
      text: `Found ${parts.join(' and ')} across ${data.totalPages} total page${data.totalPages === 1 ? '' : 's'}.`,
      severity: 'success',
    });
  }

  if (data.scannedPages && data.scannedPages > 0) {
    msgs.push({
      text: `Some pages look scanned — extraction may be less accurate on ${data.scannedPages === 1 ? 'that page' : `those ${data.scannedPages} pages`}.`,
      severity: 'warning',
    });
  }

  return msgs;
}

// ── Step 2 — Map Columns ─────────────────────────────────────────────

export interface DetectMappingData {
  confidenceScores: Record<string, number>;
  avgConfidence?: number;
  fieldLabels?: Record<string, string>;
}

const LOW_CONFIDENCE_THRESHOLD = 60;

export function mapColumnsMessages(data: DetectMappingData): PunchMessage[] {
  const msgs: PunchMessage[] = [];
  const scores = data.confidenceScores;
  const fields = Object.keys(scores);

  // Overall confidence
  const avg =
    data.avgConfidence ??
    (fields.length > 0
      ? Math.round(fields.reduce((sum, f) => sum + scores[f], 0) / fields.length)
      : 0);

  msgs.push({
    text: `I'm ${avg}% confident about the column mapping.`,
    severity: avg >= 80 ? 'success' : avg >= 60 ? 'info' : 'warning',
  });

  // Per-field inline tips for low-confidence columns
  const lowFields = fields.filter((f) => scores[f] < LOW_CONFIDENCE_THRESHOLD);

  if (lowFields.length === 0 && fields.length > 0) {
    msgs.push({
      text: 'All columns mapped with high confidence.',
      severity: 'success',
    });
  } else {
    for (const f of lowFields) {
      const label = data.fieldLabels?.[f] ?? f;
      msgs.push({
        text: `Not sure about '${label}' — please verify.`,
        severity: 'warning',
        inline: true,
        field: f,
      });
    }
  }

  return msgs;
}

// ── Step 3 — Triage ──────────────────────────────────────────────────

export interface TriageData {
  extractedDoors: number;
  extractedSets: number;
  byOthersCount: number;
  rejectedCount: number;
  quantityNormalized?: number;
}

export function triageMessages(data: TriageData): PunchMessage[] {
  const msgs: PunchMessage[] = [];

  msgs.push({
    text: `Extracted ${data.extractedDoors} door${data.extractedDoors === 1 ? '' : 's'} and ${data.extractedSets} hardware set${data.extractedSets === 1 ? '' : 's'}.`,
    severity: 'success',
  });

  if (data.byOthersCount > 0) {
    msgs.push({
      text: `Flagged ${data.byOthersCount} door${data.byOthersCount === 1 ? '' : 's'} as 'By Others' — they have N/A or GLASS hardware sets.`,
      severity: 'info',
    });
  }

  if (data.rejectedCount > 0) {
    msgs.push({
      text: `Rejected ${data.rejectedCount} entr${data.rejectedCount === 1 ? 'y that looks' : 'ies that look'} like product codes, not real doors.`,
      severity: 'warning',
    });
  }

  if (data.quantityNormalized && data.quantityNormalized > 0) {
    msgs.push({
      text: `${data.quantityNormalized} item${data.quantityNormalized === 1 ? '' : 's'} had quantities adjusted from totals to per-opening.`,
      severity: 'warning',
    });
  }

  return msgs;
}

// ── Step 3 — Triage Questions (interactive validation) ──────────────

/**
 * Generate validation questions from extracted doors.
 * Called after extraction completes, before triage classification.
 */
export function generateTriageQuestions(
  doors: Array<{ door_number: string; hw_set: string }>,
): PunchQuestion[] {
  const questions: PunchQuestion[] = [];

  // 1. Suspicious door numbers: letter prefix + 3+ digits, no separator.
  //    Common product-code shapes: L9175, PT200EZ, 4040XP, 6211WF
  const suspiciousPattern = /^[A-Z]{1,3}\d{3,}[A-Z]{0,3}$/i;
  const suspicious = doors.filter((d) => suspiciousPattern.test(d.door_number));
  for (const door of suspicious.slice(0, 3)) {
    questions.push({
      id: `suspicious-${door.door_number}`,
      text: `Does "${door.door_number}" look like a door number or a product code?`,
      options: ['Door', 'Product Code'],
    });
  }

  // 2. Doors with empty hw_set
  const emptyHwSet = doors.filter((d) => !d.hw_set || d.hw_set.trim() === '');
  if (emptyHwSet.length > 0 && emptyHwSet.length <= 5) {
    for (const door of emptyHwSet.slice(0, 2)) {
      questions.push({
        id: `empty-hwset-${door.door_number}`,
        text: `Door ${door.door_number} has no hardware set assigned. Is this expected?`,
        options: ['Yes, skip it', 'No, flag it'],
      });
    }
  } else if (emptyHwSet.length > 5) {
    questions.push({
      id: 'empty-hwset-bulk',
      text: `${emptyHwSet.length} doors have no hardware set assigned. Should these be skipped?`,
      options: ['Yes, skip them', 'No, flag them'],
    });
  }

  // 3. Common by-others indicators (NH, N/A, GLASS, B/O)
  const byOthersRe = /^(NH|N\/A|GLASS|B\/O|BY OTHERS|ALBO|B\/O'S)$/i;
  const byOthersDoors = doors.filter(
    (d) => d.hw_set && byOthersRe.test(d.hw_set.trim()),
  );
  if (byOthersDoors.length > 0) {
    const indicator = byOthersDoors[0].hw_set.trim();
    questions.push({
      id: 'by-others-bulk',
      text: `${byOthersDoors.length} door${byOthersDoors.length === 1 ? ' is' : 's are'} marked '${indicator}' — should these be 'By Others'?`,
      options: ['Yes', 'No'],
    });
  }

  return questions;
}

// ── Step 4 — Review ──────────────────────────────────────────────────

export interface ReviewRowData {
  doorNumber: string;
  fieldConfidence?: Record<string, number>;
}

export function reviewMessages(rows: ReviewRowData[]): PunchMessage[] {
  const msgs: PunchMessage[] = [];
  let flagCount = 0;

  for (const row of rows) {
    if (!row.fieldConfidence) continue;
    for (const [field, conf] of Object.entries(row.fieldConfidence)) {
      if (conf < LOW_CONFIDENCE_THRESHOLD) {
        flagCount++;
        msgs.push({
          text: `Door ${row.doorNumber} has a low-confidence ${field} — the PDF was hard to read here.`,
          severity: 'warning',
          inline: true,
          field,
          rowId: row.doorNumber,
        });
      }
    }
  }

  // Summary
  if (flagCount === 0) {
    msgs.push({
      text: 'Everything looks good!',
      severity: 'success',
    });
  } else {
    msgs.push({
      text: `${flagCount} item${flagCount === 1 ? '' : 's'} need${flagCount === 1 ? 's' : ''} your attention.`,
      severity: 'warning',
    });
  }

  return msgs;
}

// ── Step 5 — Confirm ─────────────────────────────────────────────────

export interface ConfirmData {
  /** 'fresh' = first import, 'revision' = re-upload comparison */
  mode: 'fresh' | 'revision' | 'post-save';
  doorCount?: number;
  hardwareItemCount?: number;
  changed?: number;
  added?: number;
  removed?: number;
  savedCount?: number;
}

export function confirmMessages(data: ConfirmData): PunchMessage[] {
  const msgs: PunchMessage[] = [];

  switch (data.mode) {
    case 'fresh':
      msgs.push({
        text: `Ready to save ${data.doorCount ?? 0} door${(data.doorCount ?? 0) === 1 ? '' : 's'} with ${data.hardwareItemCount ?? 0} hardware item${(data.hardwareItemCount ?? 0) === 1 ? '' : 's'}.`,
        severity: 'info',
      });
      break;

    case 'revision': {
      const parts: string[] = [];
      if (data.changed) parts.push(`update ${data.changed} door${data.changed === 1 ? '' : 's'}`);
      if (data.added) parts.push(`add ${data.added} new`);
      if (data.removed) parts.push(`remove ${data.removed}`);
      msgs.push({
        text: parts.length > 0
          ? `This will ${parts.join(', ')}.`
          : 'No changes detected from the previous import.',
        severity: parts.length > 0 ? 'info' : 'success',
      });
      break;
    }

    case 'post-save':
      msgs.push({
        text: `Done! ${data.savedCount ?? 0} door${(data.savedCount ?? 0) === 1 ? '' : 's'} loaded successfully.`,
        severity: 'success',
      });
      break;
  }

  return msgs;
}
