/**
 * Groups hardware items into Shared / Leaf 1 / Leaf 2 sections for pair doors.
 *
 * Uses the hardware taxonomy's install_scope to classify each item:
 *   - per_leaf   → appears on both Leaf 1 and Leaf 2 (stored qty is per-leaf)
 *   - per_opening → appears on both leaves (UI shows qty / leafCount per leaf)
 *   - per_pair   → Shared section (coordinator, flush bolt, astragal)
 *   - per_frame  → Shared section (threshold, seals, etc.)
 *   - unknown    → defaults to per-leaf behavior (appears on both leaves)
 *
 * Special structural items (Door, Frame) are classified by name:
 *   - "Door (Active Leaf)"   → leaf1
 *   - "Door (Inactive Leaf)" → leaf2
 *   - "Door"                 → leaf1 (single door)
 *   - "Frame"                → shared
 */

import { classifyItemScope } from '@/lib/parse-pdf-helpers'
import type { InstallScope } from '@/lib/hardware-taxonomy'

/** Minimal item shape — works with both API response items and wizard preview items. */
export interface LeafGroupableItem {
  id?: string
  name: string
  qty: number
  manufacturer?: string | null
  model?: string | null
  finish?: string | null
  options?: string | null
  sort_order?: number
  install_type?: string | null
  progress?: any
  progress_by_leaf?: any[]
  [key: string]: any
}

export interface LeafGroupedItems<T extends LeafGroupableItem = LeafGroupableItem> {
  shared: T[]
  leaf1: T[]
  leaf2: T[]
}

/**
 * Compute the display quantity for an item on a specific leaf.
 * - per_leaf items: stored qty IS the per-leaf qty (show as-is)
 * - per_opening items: stored qty is per-opening total; divide by leafCount
 * - shared items: show stored qty as-is
 */
export function getLeafDisplayQty(
  item: LeafGroupableItem,
  leafCount: number,
  scope: InstallScope | null,
): number {
  if (scope === 'per_opening' && leafCount > 1) {
    return Math.ceil(item.qty / leafCount)
  }
  return item.qty
}

/**
 * Get the install scope for an item, handling structural items (Door, Frame).
 */
export function getItemScope(name: string): InstallScope | 'structural' | null {
  // Structural items have fixed classification
  if (name === 'Door (Active Leaf)' || name === 'Door (Inactive Leaf)' || name === 'Door') {
    return 'structural'
  }
  if (name === 'Frame') return 'structural'
  return classifyItemScope(name)
}

/**
 * Group hardware items into Shared / Leaf 1 / Leaf 2 arrays.
 *
 * For single doors (leafCount=1), leaf2 is always empty.
 * Items appear in the same order they were in the input array.
 */
export function groupItemsByLeaf<T extends LeafGroupableItem>(
  items: T[],
  leafCount: number,
): LeafGroupedItems<T> {
  const shared: T[] = []
  const leaf1: T[] = []
  const leaf2: T[] = []
  const isPair = leafCount >= 2

  for (const item of items) {
    // Structural items: classified by name
    if (item.name === 'Door (Active Leaf)') {
      leaf1.push(item)
      continue
    }
    if (item.name === 'Door (Inactive Leaf)') {
      if (isPair) leaf2.push(item)
      continue
    }
    if (item.name === 'Door') {
      leaf1.push(item)
      continue
    }
    if (item.name === 'Frame') {
      shared.push(item)
      continue
    }

    // Hardware items: classified by taxonomy scope
    const scope = classifyItemScope(item.name)

    if (scope === 'per_pair' || scope === 'per_frame') {
      shared.push(item)
    } else if (scope === 'per_leaf' || scope === 'per_opening' || scope === null) {
      // per_leaf: item appears on each leaf with its stored qty
      // per_opening: item appears on each leaf with qty / leafCount
      // null (unknown): conservative — treat like per_leaf
      leaf1.push(item)
      if (isPair) leaf2.push(item)
    }
  }

  return { shared, leaf1, leaf2 }
}

/**
 * Resolve the checklist progress entry for a specific leaf of an item.
 * Returns the progress_by_leaf entry matching the leaf_index, or falls
 * back to the single progress object for backward compatibility.
 */
export function getLeafProgress(
  item: LeafGroupableItem,
  leafIndex: number,
): any | undefined {
  if (item.progress_by_leaf && item.progress_by_leaf.length > 0) {
    return item.progress_by_leaf.find(
      (p: any) => (p.leaf_index ?? 1) === leafIndex
    )
  }
  // Fallback: single progress (pre-Phase 2 data or shared items)
  return leafIndex === 1 ? item.progress : undefined
}
