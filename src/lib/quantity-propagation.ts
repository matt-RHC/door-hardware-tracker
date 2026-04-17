/**
 * Quantity Propagation Engine
 *
 * When a user answers a quantity question for one hardware set,
 * this engine finds all other sets with matching items and applies
 * the same resolution — so one answer can fix 40 openings.
 *
 * Example: User confirms "4 hinges per leaf" for set DH5.
 * Propagation finds all other sets where hinge qty doesn't match
 * the standard (3 per leaf) and applies 4 per leaf to matching sets.
 */

import { TAXONOMY_REGEX_CACHE } from '@/lib/hardware-taxonomy'
import type { HardwareSet } from '@/lib/types'

// ── Category classification (uses shared TAXONOMY_REGEX_CACHE) ──

/** Classify a hardware item name into a taxonomy category ID. */
export function classifyItemCategory(name: string): string | null {
  for (const cat of TAXONOMY_REGEX_CACHE) {
    for (const rx of cat.patterns) {
      if (rx.test(name)) return cat.id
    }
  }
  return null
}

// ── Propagation types ──

export interface QtyDecision {
  /** The category of hardware item (e.g., 'hinges', 'lockset') */
  item_category: string
  /** The resolved per-opening quantity */
  resolved_qty: number
  /** Source set where the user made the decision */
  source_set_id: string
  /** Human-readable reason */
  reason: string
}

export interface PropagationResult {
  /** Updated hardware sets with propagated quantities */
  updatedSets: HardwareSet[]
  /** How many items were updated across all sets */
  appliedCount: number
  /** Sets that were modified */
  modifiedSetIds: string[]
}

// ── Propagation logic ──

/**
 * Propagate a quantity decision across all hardware sets.
 *
 * Finds items matching the same category across all sets and applies
 * the resolved quantity, skipping:
 * - The source set (already resolved)
 * - Items already marked as 'divided' or 'auto_corrected'
 * - Items where the qty already matches the resolved value
 */
export function propagateQuantityDecision(
  decision: QtyDecision,
  hardwareSets: HardwareSet[],
): PropagationResult {
  let appliedCount = 0
  const modifiedSetIds: string[] = []

  const updatedSets = hardwareSets.map(set => {
    // Skip the source set — it's already resolved
    if (set.set_id === decision.source_set_id) return set

    let setModified = false
    const updatedItems = (set.items ?? []).map(item => {
      // Skip already-processed items
      if (item.qty_source === 'divided' || item.qty_source === 'auto_corrected') return item

      // Check if this item matches the decision category
      const category = classifyItemCategory(item.name)
      if (category !== decision.item_category) return item

      // Skip if qty already matches
      if (item.qty === decision.resolved_qty) return item

      // Apply the decision
      appliedCount++
      setModified = true
      return {
        ...item,
        qty_total: item.qty_total ?? item.qty, // preserve original as total
        qty: decision.resolved_qty,
        qty_source: 'propagated' as const,
      }
    })

    if (setModified) {
      modifiedSetIds.push(set.set_id)
      return { ...set, items: updatedItems }
    }
    return set
  })

  return { updatedSets, appliedCount, modifiedSetIds }
}

/**
 * Build a QtyDecision from a user's answer to a Darrin quantity question.
 *
 * Parses the answer to extract a quantity value and determines the
 * item category from the question context.
 */
export function buildDecisionFromAnswer(
  questionSetId: string,
  questionItemName: string,
  answer: string,
): QtyDecision | null {
  // Try to extract a number from the answer (e.g., "4 per leaf (tall/heavy)" → 4)
  const numMatch = answer.match(/^(\d+)/)
  if (!numMatch) return null

  const resolvedQty = parseInt(numMatch[1], 10)
  const category = classifyItemCategory(questionItemName)
  if (!category) return null

  return {
    item_category: category,
    resolved_qty: resolvedQty,
    source_set_id: questionSetId,
    reason: `User answered: "${answer}"`,
  }
}
