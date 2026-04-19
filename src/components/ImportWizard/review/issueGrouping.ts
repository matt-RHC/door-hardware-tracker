import type { DoorEntry } from "../types";
import { getDoorIssues } from "./utils";
import { ISSUE_LABELS } from "./types";

export type IssueSeverity = "high" | "med" | "soft";

export interface IssueGroupDoor {
  door: DoorEntry;
  originalIndex: number;
}

export interface IssueGroup {
  /** Raw key from `getDoorIssues` (e.g. `missing_location`). Used as
   *  React key and for severity / rationale lookups. */
  issueKey: string;
  /** Human-readable label — ISSUE_LABELS or a deterministic fallback. */
  label: string;
  /** Severity drives the card accent border, matching the rest of the
   *  review UI's high/med/soft taxonomy. `missing_*` required fields
   *  are `high` (can block export), other `missing_*` are `med`, and
   *  `low_confidence_*` is `soft` (advisory). */
  severity: IssueSeverity;
  /** The field this issue is about, when the key follows the
   *  `missing_<field>` / `low_confidence_<field>` convention. Null for
   *  keys that don't fit that shape. Consumers can use it to drive
   *  bulk-apply modals (Path B) without re-parsing the key. */
  field: string | null;
  /** Doors flagged with this issue. A single door may appear in
   *  multiple groups — that's intentional: multiple root causes
   *  deserve separate cluster cards. */
  doors: IssueGroupDoor[];
  /** Distinct hardware-set ids represented in this cluster — used by
   *  the cluster header to show spread ("3 sets · 12 openings") and
   *  by the rail to pick which source page to show. */
  setIds: string[];
}

// Required fields: missing these blocks export. Everything else falls
// back to the advisory `soft` tier for low_confidence_* and `med` for
// other missing_*. Kept in a Set (not a regex) so lookups are O(1)
// and the intent is obvious at a glance.
const REQUIRED_FIELD_KEYS = new Set([
  "missing_door_number",
  "missing_hw_set",
]);

function severityFor(issueKey: string): IssueSeverity {
  if (REQUIRED_FIELD_KEYS.has(issueKey)) return "high";
  if (issueKey.startsWith("low_confidence_")) return "soft";
  return "med";
}

function fieldFor(issueKey: string): string | null {
  if (issueKey.startsWith("missing_")) return issueKey.slice("missing_".length);
  if (issueKey.startsWith("low_confidence_")) {
    return issueKey.slice("low_confidence_".length);
  }
  return null;
}

function labelFor(issueKey: string): string {
  return ISSUE_LABELS[issueKey] ?? issueKey.replace(/_/g, " ");
}

const SEVERITY_RANK: Record<IssueSeverity, number> = {
  high: 0,
  med: 1,
  soft: 2,
};

/**
 * Bucket an opening list by issue key. Returns clusters sorted by
 * severity (high → med → soft), ties broken by door count (desc) then
 * the issue key itself (asc) for stable output.
 *
 * Doors with no flagged issues are absent from every group — the
 * issue view only surfaces openings that need a call. A door with
 * three flags appears in three groups; the duplication is the point,
 * it signals overlapping root causes that may share a fix.
 */
export function computeIssueGroups(
  doors: IssueGroupDoor[],
): IssueGroup[] {
  const buckets = new Map<string, IssueGroup>();

  for (const entry of doors) {
    const issues = getDoorIssues(entry.door);
    for (const issueKey of issues) {
      let bucket = buckets.get(issueKey);
      if (!bucket) {
        bucket = {
          issueKey,
          label: labelFor(issueKey),
          severity: severityFor(issueKey),
          field: fieldFor(issueKey),
          doors: [],
          setIds: [],
        };
        buckets.set(issueKey, bucket);
      }
      bucket.doors.push(entry);
    }
  }

  // Fill setIds — distinct, preserving first-seen order so the rail
  // lands on the first cluster member's source page rather than an
  // alphabetically-first one that may be elsewhere in the PDF.
  for (const bucket of buckets.values()) {
    const seen = new Set<string>();
    for (const { door } of bucket.doors) {
      const sid = door.hw_set?.trim();
      if (!sid || seen.has(sid)) continue;
      seen.add(sid);
      bucket.setIds.push(sid);
    }
  }

  return [...buckets.values()].sort((a, b) => {
    const sev = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (sev !== 0) return sev;
    if (b.doors.length !== a.doors.length) {
      return b.doors.length - a.doors.length;
    }
    return a.issueKey.localeCompare(b.issueKey);
  });
}
