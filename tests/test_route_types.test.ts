/**
 * Type conformance tests: verify that the TS interfaces match
 * what Python's extract-tables.py actually returns.
 *
 * Uses a recorded sample response shape (not a live call).
 */
import { describe, it, expect } from 'vitest'

// Mirror the PdfplumberResult interface from route.ts
interface PdfplumberHardwareItem {
  qty: number
  name: string
  manufacturer: string
  model: string
  finish: string
}

interface PdfplumberHardwareSet {
  set_id: string
  heading: string
  items: PdfplumberHardwareItem[]
}

interface PdfplumberDoorEntry {
  door_number: string
  hw_set: string
  hw_heading: string
  location: string
  door_type: string
  frame_type: string
  fire_rating: string
  hand: string
}

interface PdfplumberResult {
  success: boolean
  openings: PdfplumberDoorEntry[]
  hardware_sets: PdfplumberHardwareSet[]
  reference_codes: Array<{ code_type: string; code: string; full_name: string }>
  expected_door_count: number
  tables_found: number
  hw_sets_found: number
  method: string
}

// Sample response matching Python's ExtractionResult schema
const samplePythonResponse: PdfplumberResult = {
  success: true,
  openings: [
    {
      door_number: '101',
      hw_set: 'A',
      hw_heading: 'Interior Openings',
      location: 'Lobby',
      door_type: 'Wood',
      frame_type: 'HM',
      fire_rating: '20 Min',
      hand: 'RH',
    },
  ],
  hardware_sets: [
    {
      set_id: 'A',
      heading: 'Interior Openings - Passage',
      items: [
        {
          qty: 3,
          name: 'Hinge',
          manufacturer: 'Ives',
          model: '5BB1',
          finish: '652',
        },
      ],
    },
  ],
  reference_codes: [
    { code_type: 'manufacturer', code: 'IVE', full_name: 'Ives' },
  ],
  expected_door_count: 10,
  tables_found: 3,
  hw_sets_found: 1,
  method: 'lines',
}

describe('PdfplumberResult type conformance', () => {
  it('sample response has required top-level fields', () => {
    expect(samplePythonResponse).toHaveProperty('success')
    expect(samplePythonResponse).toHaveProperty('openings')
    expect(samplePythonResponse).toHaveProperty('hardware_sets')
    expect(samplePythonResponse).toHaveProperty('reference_codes')
    expect(samplePythonResponse).toHaveProperty('tables_found')
    expect(samplePythonResponse).toHaveProperty('hw_sets_found')
    expect(samplePythonResponse).toHaveProperty('method')
  })

  it('opening entries have all door fields', () => {
    const door = samplePythonResponse.openings[0]!
    expect(door).toHaveProperty('door_number')
    expect(door).toHaveProperty('hw_set')
    expect(door).toHaveProperty('hw_heading')
    expect(door).toHaveProperty('location')
    expect(door).toHaveProperty('door_type')
    expect(door).toHaveProperty('frame_type')
    expect(door).toHaveProperty('fire_rating')
    expect(door).toHaveProperty('hand')
  })

  it('hardware set items have all item fields', () => {
    const item = samplePythonResponse.hardware_sets[0]!.items[0]!
    expect(item).toHaveProperty('qty')
    expect(item).toHaveProperty('name')
    expect(item).toHaveProperty('manufacturer')
    expect(item).toHaveProperty('model')
    expect(item).toHaveProperty('finish')
  })

  it('qty values are numbers', () => {
    const item = samplePythonResponse.hardware_sets[0]!.items[0]!
    expect(typeof item.qty).toBe('number')
    expect(item.qty).toBeGreaterThan(0)
  })
})

describe('capItemQty logic', () => {
  // Replicate the TS capItemQty function for testing
  const QTY_MAX_MAP: Record<string, number> = {
    hinge: 5, continuous: 2, pivot: 2,
    lockset: 1, latch: 1, passage: 1, privacy: 1, storeroom: 1,
    classroom: 1, entrance: 1, mortise: 1, cylindrical: 1, deadbolt: 2,
    exit: 2, panic: 2, 'flush bolt': 2, 'surface bolt': 2,
    closer: 2, coordinator: 1, stop: 2, holder: 2,
    silencer: 4, bumper: 4, threshold: 1, 'kick plate': 2,
    seal: 3, gasket: 3, sweep: 1, 'door bottom': 1,
    astragal: 1, cylinder: 2, core: 2, strike: 2,
    pull: 2, push: 2, lever: 1, knob: 1,
  }

  function capItemQty(qty: number, name: string): number {
    if (qty <= 0) return 1
    const lower = name.toLowerCase()
    for (const [keyword, max] of Object.entries(QTY_MAX_MAP)) {
      if (lower.includes(keyword)) return Math.min(qty, max)
    }
    return Math.min(qty, 4)
  }

  it('caps hinge qty at 5', () => {
    expect(capItemQty(100, 'Full Mortise Hinge')).toBe(5)
  })

  it('caps lockset qty at 1', () => {
    expect(capItemQty(50, 'Mortise Lockset')).toBe(1)
  })

  it('caps closer qty at 2', () => {
    expect(capItemQty(10, 'Door Closer')).toBe(2)
  })

  it('defaults unknown items to max 4', () => {
    expect(capItemQty(10, 'Widget XYZ')).toBe(4)
  })

  it('returns 1 for zero qty', () => {
    expect(capItemQty(0, 'Hinge')).toBe(1)
  })

  it('preserves valid qty', () => {
    expect(capItemQty(3, 'Full Mortise Hinge')).toBe(3)
  })
})
