/**
 * Groups hardware items into Shared / Leaf 1 / Leaf 2 sections for pair doors.
 *
 * Prefer the persisted `hardware_items.leaf_side` value (migration 013) when
 * it is set; fall back to category-driven placement below when it is NULL.
 * Fallback still runs in two cases:
 *
 *   1. Existing rows backfilled only at the unambiguous cases. Some legacy
 *      rows still carry NULL leaf_side and are classified at render time.
 *   2. The wizard preview operates on items that haven't been saved yet and
 *      therefore have no leaf_side — it relies on the render-time path.
 *
 * Fallback routing (2026-04-18): uses PAIR_LEAF_PLACEMENT (hardware-taxonomy.ts)
 * which answers "where does this hardware physically install on a pair door?"
 * rather than "how does the qty scale?" This prevents the qty=1 duplication
 * where items like cylinder housings and cores showed on both leaves.
 *
 * Placement map → leaf routing:
 *   - 'active'   → leaf1 only   (lockset, exit_device, cylinder_housing,
 *                                core, wire_harness, etc.)
 *   - 'inactive' → leaf2 only   (flush_bolt, dust_proof_strike)
 *   - 'shared'   → shared       (coordinator, threshold, astragal, seals)
 *   - 'split'    → both leaves  (hinges, closers, kick plates)
 *
 * Unknown categories fall back via getPairLeafPlacement:
 *   - qty<=1 → 'shared' (single item, treat as opening-level)
 *   - qty>1  → 'split'  (preserve prior per-leaf behavior)
 *
 * Structural items are classified by name:
 *   - "Door (Active Leaf)"   → leaf1
 *   - "Door (Inactive Leaf)" → leaf2
 *   - "Door"                 → leaf1 (single door)
 *   - "Frame"                → shared
 */

import { classifyItemScope } from '@/lib/parse-pdf-helpers'
import { classifyItem, scanElectricHinges, getPairLeafPlacement } from '@/lib/hardware-taxonomy'
import type { InstallScope } from '@/lib/hardware-taxonomy'

/** Minimal item shape — works with both API response items and wizard preview items. */
export interface LeafGroupableItem {
  id?: string
  name: string
  qty: number | null
  manufacturer?: string | null
  model?: string | null
  finish?: string | null
  options?: string | null
  sort_order?: number | null
  install_type?: string | null
  /** Persisted leaf attribution from migration 013. NULL → fall back to regex. */
  leaf_side?: string | null
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
 *
 * - per_leaf items: stored qty IS the per-leaf qty (show as-is)
 * - per_opening items: stored qty is already per-opening (show as-is)
 * - shared items (per_pair / per_frame): show stored qty as-is
 *
 * IMPORTANT — WHY per_opening IS NOT FURTHER DIVIDED HERE:
 *
 * Before the 2026-04-13 qty normalization overhaul, this function divided
 * per_opening items by leafCount again ("Math.ceil(qty / leafCount)"). That
 * was wrong for two reasons:
 *
 *   1. normalizeQuantities() in parse-pdf-helpers.ts already divided
 *      per_opening items by doorCount when it set qty_source='divided'.
 *      Dividing again by leafCount would compound the division:
 *      1 closer / 2 leaves = 0.5 (ceil → 1 — "worked" only by coincidence
 *      when qty was already 1, but breaks for qty=2 pair).
 *
 *   2. Electric transfer hinges (CON TW8, ETH, EPT) are classified as
 *      per_opening in hardware-taxonomy.ts. They carry wiring and are
 *      installed on the ACTIVE LEAF ONLY (DHI standard practice). Their
 *      stored qty is already 1 per opening after normalizeQuantities().
 *      As of Phase 4, buildPerOpeningItems() stamps leaf_side='active'
 *      on electric hinges for pair doors, so groupItemsByLeaf() routes
 *      them to the active leaf only.
 *
 * The routing of PER_OPENING items to the correct leaf (active vs both) is
 * handled by groupItemsByLeaf() + persisted leaf_side values (migration 013),
 * not by dividing the displayed qty here.
 *
 * If you believe this function should divide per_opening by leafCount: verify
 * first that normalizeQuantities() is NOT already doing that division. The
 * two must not stack.
 */
export function getLeafDisplayQty(
  item: LeafGroupableItem,
): number {
  // All scopes (per_opening / per_leaf / per_pair / per_frame / null) return
  // the stored qty as-is. normalizeQuantities() already divided per_opening
  // items by doorCount and per_leaf items by leafCount. Further division here
  // would double-divide (see JSDoc above).
  return item.qty ?? 0
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
 * True when the item set carries an unambiguous pair signal.
 *
 * Only `leaf_side='inactive'` is used as the signal. `'active'` alone is
 * NOT enough: buildPerOpeningItems stamps a bare "Door" row on SINGLE
 * doors with `leaf_side='active'` (see parse-pdf-helpers.ts), so keying
 * off 'active' would flip every single-door opening into the pair UI.
 * An 'inactive' row is only ever emitted from the pair branch of
 * buildPerOpeningItems, making it the correct unambiguous signal.
 *
 * Used by the door detail page as a fail-safe: if the parent opening
 * claims leaf_count=1 but the items indicate a pair, render the pair UI
 * anyway so a single backend miscompute (2026-04-18 Radius DC regression)
 * can't hide all per-leaf views.
 */
export function itemsIndicatePair(
  items: ReadonlyArray<{ leaf_side?: string | null }>,
): boolean {
  return items.some(i => i.leaf_side === 'inactive')
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

  // Pre-scan: count electric hinge qty in the set. On pair doors the electric
  // hinge occupies one hinge position on the active leaf, so the standard hinge
  // qty on the active leaf must be reduced by this amount during wizard preview
  // (when leaf_side is still null and items haven't been split by the save path).
  const { totalElectricQty: electricHingeQty } = scanElectricHinges(items, isPair)

  for (const item of items) {
    // Phase 3: prefer persisted leaf_side when the DB carries a value.
    // Migration 013 backfilled the unambiguous cases and the save path
    // stamps it going forward. When null/undefined (older rows, wizard
    // preview, or deliberately ambiguous per_leaf/per_opening pair items)
    // we fall through to the legacy taxonomy-regex classification below.
    if (item.leaf_side === 'shared') {
      shared.push(item)
      continue
    }
    if (item.leaf_side === 'active') {
      leaf1.push(item)
      continue
    }
    if (item.leaf_side === 'inactive') {
      if (isPair) leaf2.push(item)
      continue
    }
    if (item.leaf_side === 'both') {
      leaf1.push(item)
      if (isPair) leaf2.push(item)
      continue
    }

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

    // Hardware items: classified by category → placement map.
    const category = classifyItem(item.name, undefined, item.model ?? undefined)

    // Electric hinges: always active leaf only on pairs (even without persisted leaf_side).
    // During wizard preview, items haven't been saved so leaf_side is null. Without this
    // guard, electric hinges fall through to the per_opening branch and appear on BOTH leaves.
    if (isPair && !item.leaf_side && category === 'electric_hinge') {
      leaf1.push(item)
      continue
    }

    // Standard hinge qty adjustment for pair doors with electric hinges.
    // The electric hinge replaces one standard hinge position on the active leaf,
    // so active leaf standard qty = total standard qty - electric hinge qty.
    // Only applies during wizard preview (leaf_side is null); after save, the
    // qty is already correct from buildPerOpeningItems.
    if (isPair && electricHingeQty > 0 && !item.leaf_side && category === 'hinges') {
      leaf1.push({ ...item, qty: Math.max(0, (item.qty || 0) - electricHingeQty) } as T)
      leaf2.push({ ...item } as T)
      continue
    }

    // Single doors: nothing to decide — everything goes to leaf1.
    // Previously the taxonomy-scope branch below was also reaching this case
    // and correctly routing to leaf1, but being explicit avoids stepping
    // through the pair placement logic when leafCount=1.
    if (!isPair) {
      leaf1.push(item)
      continue
    }

    // Pair doors: consult PAIR_LEAF_PLACEMENT with qty fallback.
    //
    // 2026-04-18: Replaced the scope-only fallback (per_pair/per_frame →
    // shared, everything else → both leaves) because it duplicated qty=1
    // items like cylinder housings, cores, and wire harnesses. The new
    // path routes by PHYSICAL INSTALLATION LOCATION (via PAIR_LEAF_PLACEMENT)
    // rather than by how qty scales. Matches the save-path logic in
    // buildPerOpeningItems() so wizard preview and saved state agree.
    //
    // Unknown-category fallback (getPairLeafPlacement):
    //   qty<=1 → shared (prevents qty=1 duplication)
    //   qty>1  → split  (preserves prior behavior for genuine per-leaf items)
    const placement = getPairLeafPlacement(category, item.qty)
    if (placement === 'active') {
      leaf1.push(item)
    } else if (placement === 'inactive') {
      leaf2.push(item)
    } else if (placement === 'shared') {
      shared.push(item)
    } else {
      // 'split' → appears on each leaf with its stored per-leaf qty.
      leaf1.push(item)
      leaf2.push(item)
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
