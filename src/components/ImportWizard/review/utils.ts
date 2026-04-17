import type { DoorEntry } from "../types";

/** Orphan door: N/A or empty hw_set and unlikely to have hardware items. */
export function isOrphanDoor(door: DoorEntry): boolean {
  const hwSet = (door.hw_set ?? '').trim();
  return hwSet === '' || hwSet === 'N/A';
}

/** Identifies the specific issue(s) with a door, if any. */
export function getDoorIssues(door: DoorEntry): string[] {
  const issues: string[] = [];
  if (!door.door_number) issues.push('missing_door_number');
  if (!door.hw_set || door.hw_set.trim() === '' || door.hw_set.trim() === 'N/A') issues.push('missing_hw_set');
  if (!door.location?.trim()) issues.push('missing_location');
  if (!door.fire_rating?.trim()) issues.push('missing_fire_rating');
  if (!door.hand?.trim()) issues.push('missing_hand');
  if (!door.door_type?.trim()) issues.push('missing_door_type');
  if (!door.frame_type?.trim()) issues.push('missing_frame_type');

  if (door.field_confidence) {
    for (const [field, score] of Object.entries(door.field_confidence)) {
      if (typeof score === 'number' && score < 0.6) {
        const issueKey = `low_confidence_${field}`;
        if (!issues.includes(issueKey)) issues.push(issueKey);
      }
    }
  }
  return issues;
}

/**
 * Categorize a door for review. Default is "ready" unless there's a specific
 * reason it needs attention. This prevents the old pattern of marking
 * everything as "needs review" and forcing manual verification of every door.
 */
export function getConfidence(door: DoorEntry): "high" | "medium" | "low" {
  if (isOrphanDoor(door)) return "low";
  const issues = getDoorIssues(door);
  const requiredMissing = issues.some(i => i === 'missing_door_number' || i === 'missing_hw_set');
  if (requiredMissing) return "low";
  const hasLowConfidence = issues.some(i => i.startsWith('low_confidence_'));
  const missingOptionalCount = issues.filter(i =>
    i === 'missing_location' || i === 'missing_fire_rating' ||
    i === 'missing_hand' || i === 'missing_door_type' || i === 'missing_frame_type'
  ).length;
  if (hasLowConfidence || missingOptionalCount >= 3) return "medium";
  return "high";
}

/** Token-based name matching: split into words, count shared tokens, divide by max token count. */
export function tokenMatchScore(a: string, b: string): number {
  const tokensA = a.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  const tokensB = b.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  if (tokensA.length === 0 || tokensB.length === 0) return 0;
  const setB = new Set(tokensB);
  const shared = tokensA.filter(t => setB.has(t)).length;
  return shared / Math.max(tokensA.length, tokensB.length);
}

/** Border class for a door row based on its confidence bucket. */
export function confBorder(door: DoorEntry): string {
  const c = getConfidence(door);
  if (c === "high") return "row-accent-green";
  if (c === "medium") return "row-accent-amber";
  return "row-accent-red";
}
