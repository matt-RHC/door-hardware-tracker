import { detectIsPair } from '@/lib/parse-pdf-helpers'
import type { DoorEntry, HardwareSet } from '@/lib/types'

/**
 * Authoritative leaf-count resolver shared by save/route.ts and
 * apply-revision/route.ts. Returns 2 for pair openings, 1 otherwise.
 *
 * Priority: DoorEntry.leaf_count (already computed by wizard) → detectIsPair
 * fallback using the hwSet heading signals and doorInfo shape signals.
 *
 * Extracted from apply-revision/route.ts (PR-B) so the logic can be unit-
 * tested without mocking Supabase — the absence of this test was the reason
 * the P2 regression (leaf_count omitted on update/insert) went undetected.
 */
export function resolveLeafCount(
  door: Pick<DoorEntry, 'leaf_count' | 'door_type' | 'frame_type'>,
  hwSet: HardwareSet | undefined,
): number {
  return door.leaf_count ?? (detectIsPair(hwSet, { door_type: door.door_type }) ? 2 : 1)
}
