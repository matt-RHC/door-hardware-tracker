/**
 * Test 3 — UI pair-door-detail: leaf count fallback.
 *
 * The door detail page (src/app/project/[projectId]/door/[doorId]/page.tsx)
 * computes `leafCount` as MAX(opening.leaf_count, 2) when any hardware_item
 * has leaf_side='active' or 'inactive'. This test verifies that fallback logic
 * using the same computation pattern.
 *
 * WHY THIS MATTERS: when the backend writes leaf_count=1 for a pair door
 * (the Bug 1 regression), the UI must still render the Shared/Leaf 1/Leaf 2
 * tab bar based on hardware_items evidence — not silently show "ALL" only.
 *
 * NOTE: This is a pure logic test, not a rendered component test. The same
 * computation appears in the page component; a rendered test would require
 * a full Next.js environment with Supabase mocking which is out of scope
 * for this unit-test layer. This test documents and pins the contract.
 */
import { describe, it, expect } from 'vitest'
import { groupItemsByLeaf } from '@/lib/classify-leaf-items'

// Replicate the UI logic from page.tsx lines 758–769 as a pure function
// so we can unit-test the invariant without mounting the component.
function computeLeafCountForUI(
  storedLeafCount: number,
  hardwareItems: Array<{ leaf_side: string | null }>,
): { leafCount: number; isPair: boolean; mismatchDetected: boolean } {
  const hasLeafSideItems = hardwareItems.some(
    item => item.leaf_side === 'active' || item.leaf_side === 'inactive',
  )
  const leafCount = hasLeafSideItems ? Math.max(storedLeafCount, 2) : storedLeafCount
  const isPair = leafCount >= 2
  const mismatchDetected = hasLeafSideItems && storedLeafCount < 2
  return { leafCount, isPair, mismatchDetected }
}

describe('UI pair-door-detail: leaf count fallback logic', () => {
  // Scenario: backend wrote leaf_count=1 (Bug 1) but items tell the truth.
  it('overrides leaf_count=1 to 2 when hardware_items contain inactive leaf row', () => {
    const items = [
      { leaf_side: 'active'   as const },   // Door (Active Leaf)
      { leaf_side: 'inactive' as const },   // Door (Inactive Leaf)
      { leaf_side: 'shared'   as const },   // Frame
      { leaf_side: null },                   // Mortise Lock (per_opening)
    ]
    const { leafCount, isPair, mismatchDetected } = computeLeafCountForUI(1, items)

    expect(leafCount, 'must override to 2').toBe(2)
    expect(isPair, 'must render as pair').toBe(true)
    expect(mismatchDetected, 'mismatch must be detected for logging').toBe(true)
  })

  it('leaves leaf_count=2 unchanged when backend is correct', () => {
    const items = [
      { leaf_side: 'active'   as const },
      { leaf_side: 'inactive' as const },
      { leaf_side: 'shared'   as const },
    ]
    const { leafCount, isPair, mismatchDetected } = computeLeafCountForUI(2, items)

    expect(leafCount).toBe(2)
    expect(isPair).toBe(true)
    expect(mismatchDetected, 'no mismatch when backend is correct').toBe(false)
  })

  it('keeps leaf_count=1 for single doors with no active/inactive items', () => {
    const items = [
      { leaf_side: null },   // Door (no leaf attribution)
      { leaf_side: 'shared' as const }, // Frame
      { leaf_side: null },   // hardware item
    ]
    const { leafCount, isPair, mismatchDetected } = computeLeafCountForUI(1, items)

    expect(leafCount).toBe(1)
    expect(isPair).toBe(false)
    expect(mismatchDetected).toBe(false)
  })

  it('hinge split inactive items also trigger the override', () => {
    // When buildPerOpeningItems splits hinges per-leaf on a pair door,
    // the inactive-leaf hinge row has leaf_side='inactive'. This is evidence
    // of a pair even if no Door (Inactive Leaf) structural row exists.
    const items = [
      { leaf_side: null },               // Door (no attribution — maybe door_type missing)
      { leaf_side: null },               // Frame
      { leaf_side: 'active'   as const }, // Hinge active leaf
      { leaf_side: 'inactive' as const }, // Hinge inactive leaf
      { leaf_side: null },               // Lock
    ]
    const { leafCount, isPair, mismatchDetected } = computeLeafCountForUI(1, items)

    expect(leafCount).toBe(2)
    expect(isPair).toBe(true)
    expect(mismatchDetected).toBe(true)
  })

  it('groupItemsByLeaf routes items correctly when leaf_count overridden to 2', () => {
    // Smoke-check that groupItemsByLeaf works with the corrected leafCount=2.
    // This exercises the actual code path the UI uses after the fallback.
    const items = [
      { id: 'a', name: 'Door (Active Leaf)',   leaf_side: 'active',   qty: 1 },
      { id: 'b', name: 'Door (Inactive Leaf)', leaf_side: 'inactive', qty: 1 },
      { id: 'c', name: 'Frame',                leaf_side: 'shared',   qty: 1 },
      { id: 'd', name: 'Mortise Lock',         leaf_side: null,       qty: 1 },
    ]

    const { leafCount } = computeLeafCountForUI(1, items)
    const { shared, leaf1, leaf2 } = groupItemsByLeaf(items as any, leafCount)

    // Frame goes to shared; Door (Active Leaf) to leaf1; Inactive to leaf2.
    expect(shared.some((i: any) => i.name === 'Frame')).toBe(true)
    expect(leaf1.some((i: any) => i.name === 'Door (Active Leaf)')).toBe(true)
    expect(leaf2.some((i: any) => i.name === 'Door (Inactive Leaf)')).toBe(true)
  })
})
