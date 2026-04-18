/**
 * PRIMARY signal + applyCorrections guard regression suite.
 *
 * Seats PR #312's PRIMARY pair-detection signal (the
 * `_PAIR_LEAF_NAMED_DOOR_RE` match on leaf-named Door rows) against the
 * class of regression that spawned it, and the Fix-1 guard rails that
 * refuse Darrin corrections which would silently collapse that signal.
 *
 * Sentry mocking:
 *   We mock `@sentry/nextjs` at the top of the file (vitest-style,
 *   hoisted) and assert on `Sentry.addBreadcrumb` calls. The alternative
 *   — dep-injecting a Sentry facade into applyCorrections — was rejected
 *   because it would ripple an unrelated constructor-arg change across
 *   every applyCorrections call site.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import fixture from '../../tests/baselines/sched-leaf-named-pair.json'

const sentryMock = vi.hoisted(() => ({
  addBreadcrumb: vi.fn(),
}))

vi.mock('@sentry/nextjs', () => ({
  addBreadcrumb: sentryMock.addBreadcrumb,
  // Keep the namespace import surface (parse-pdf-helpers uses `import * as Sentry`)
  // happy for other call sites that might fire during these tests.
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  setTag: vi.fn(),
  setUser: vi.fn(),
  setContext: vi.fn(),
  withScope: vi.fn((cb: (s: unknown) => void) => cb({})),
}))

import { applyCorrections, detectIsPair } from './parse-pdf-helpers'
import type { HardwareSet, DoorEntry, DarrinCorrections } from '@/lib/types'

type FixtureHwSet = (typeof fixture)['hardware_sets'][number]
type FixtureDoor = (typeof fixture)['doors'][number]

function cloneHardwareSets(): HardwareSet[] {
  // JSON.parse(JSON.stringify(...)) deep-clones so each test gets a fresh
  // set of items — applyCorrections mutates in place.
  return JSON.parse(JSON.stringify(fixture.hardware_sets)) as HardwareSet[]
}

function cloneDoors(): DoorEntry[] {
  return JSON.parse(JSON.stringify(fixture.doors)) as DoorEntry[]
}

function firstDoorInfo(doors: DoorEntry[]): { door_type?: string | null; location?: string | null } {
  const d = doors[0] as FixtureDoor
  return { door_type: d.door_type, location: d.location }
}

describe('detectIsPair — PRIMARY signal via leaf-named Door rows', () => {
  beforeEach(() => {
    sentryMock.addBreadcrumb.mockClear()
  })

  it('(a) fires on the synthetic fixture as-extracted', () => {
    const [hwSet] = cloneHardwareSets()
    expect(detectIsPair(hwSet, firstDoorInfo(cloneDoors()))).toBe(true)
  })

  it('(a2) fires when the rows are lowercase — regex is case-insensitive', () => {
    const [hwSet] = cloneHardwareSets()
    const items = hwSet.items ?? []
    for (const item of items) {
      if (item.name === 'Door (Active Leaf)') item.name = 'door (active leaf)'
      if (item.name === 'Door (Inactive Leaf)') item.name = 'door (inactive leaf)'
    }
    expect(detectIsPair(hwSet, firstDoorInfo(cloneDoors()))).toBe(true)
  })

  it('(b) guard holds — applyCorrections refuses items_to_remove on leaf-named rows', () => {
    const hardwareSets = cloneHardwareSets()
    const doors = cloneDoors()

    const corrections: DarrinCorrections = {
      hardware_sets_corrections: [
        {
          set_id: 'DH-PAIR-TEST',
          items_to_remove: ['Door (Active Leaf)', 'Door (Inactive Leaf)'],
        },
      ],
    }

    applyCorrections(hardwareSets, doors, corrections)

    // Rows survive
    const surviving = (hardwareSets[0].items ?? []).map(i => i.name)
    expect(surviving).toContain('Door (Active Leaf)')
    expect(surviving).toContain('Door (Inactive Leaf)')

    // PRIMARY signal still fires
    expect(detectIsPair(hardwareSets[0], firstDoorInfo(doors))).toBe(true)

    // Observability: breadcrumb records the attempted removal
    const breadcrumbCalls = sentryMock.addBreadcrumb.mock.calls
      .map(c => c[0])
      .filter(b => b?.category === 'extraction.corrections.skip_remove_leaf_row')
    expect(breadcrumbCalls.length).toBe(1)
    expect(breadcrumbCalls[0]).toMatchObject({
      level: 'warning',
      data: {
        set_id: 'DH-PAIR-TEST',
        skipped: ['Door (Active Leaf)', 'Door (Inactive Leaf)'],
      },
    })
  })

  it('(c) non-leaf rows are still removable — guard is narrow', () => {
    const hardwareSets = cloneHardwareSets()
    const doors = cloneDoors()

    const corrections: DarrinCorrections = {
      hardware_sets_corrections: [
        {
          set_id: 'DH-PAIR-TEST',
          items_to_remove: ['Silencer'],
        },
      ],
    }

    applyCorrections(hardwareSets, doors, corrections)

    const surviving = (hardwareSets[0].items ?? []).map(i => i.name)
    expect(surviving).not.toContain('Silencer')
    expect(surviving).toContain('Door (Active Leaf)')

    const guardBreadcrumbs = sentryMock.addBreadcrumb.mock.calls
      .map(c => c[0])
      .filter(b =>
        b?.category === 'extraction.corrections.skip_remove_leaf_row'
          || b?.category === 'extraction.corrections.skip_fix_leaf_row',
      )
    expect(guardBreadcrumbs.length).toBe(0)
  })

  it('(d) guard holds — applyCorrections refuses items_to_fix with field=name on leaf-named rows', () => {
    const hardwareSets = cloneHardwareSets()
    const doors = cloneDoors()

    const corrections: DarrinCorrections = {
      hardware_sets_corrections: [
        {
          set_id: 'DH-PAIR-TEST',
          items_to_fix: [
            {
              name: 'Door (Active Leaf)',
              field: 'name',
              old_value: 'Door (Active Leaf)',
              new_value: 'Door',
            },
          ],
        },
      ],
    }

    applyCorrections(hardwareSets, doors, corrections)

    // Row is still named "Door (Active Leaf)" — no collapse to plain "Door".
    const surviving = (hardwareSets[0].items ?? []).map(i => i.name)
    expect(surviving).toContain('Door (Active Leaf)')

    // PRIMARY signal still fires
    expect(detectIsPair(hardwareSets[0], firstDoorInfo(doors))).toBe(true)

    // Observability: the fix-name guard breadcrumb records the refusal
    const fixBreadcrumbs = sentryMock.addBreadcrumb.mock.calls
      .map(c => c[0])
      .filter(b => b?.category === 'extraction.corrections.skip_fix_leaf_row')
    expect(fixBreadcrumbs.length).toBe(1)
    expect(fixBreadcrumbs[0]).toMatchObject({
      level: 'warning',
      data: {
        set_id: 'DH-PAIR-TEST',
        skipped: [{ name: 'Door (Active Leaf)', field: 'name' }],
      },
    })
  })

  it('(e) items_to_fix for non-name fields on leaf-named rows passes through unguarded', () => {
    const hardwareSets = cloneHardwareSets()
    const doors = cloneDoors()

    const corrections: DarrinCorrections = {
      hardware_sets_corrections: [
        {
          set_id: 'DH-PAIR-TEST',
          items_to_fix: [
            {
              name: 'Door (Active Leaf)',
              field: 'qty',
              old_value: '1',
              new_value: '2',
            },
          ],
        },
      ],
    }

    applyCorrections(hardwareSets, doors, corrections)

    const activeLeafRow = (hardwareSets[0].items ?? []).find(i => i.name === 'Door (Active Leaf)')
    expect(activeLeafRow?.qty).toBe(2)

    const guardBreadcrumbs = sentryMock.addBreadcrumb.mock.calls
      .map(c => c[0])
      .filter(b => b?.category === 'extraction.corrections.skip_fix_leaf_row')
    expect(guardBreadcrumbs.length).toBe(0)
  })
})

// Type assertions to keep the fixture typed — fails the build if the
// baseline JSON shape drifts from the HardwareSet interface.
const _typeCheckHwSet: FixtureHwSet = fixture.hardware_sets[0]
const _typeCheckDoor: FixtureDoor = fixture.doors[0]
void _typeCheckHwSet
void _typeCheckDoor
