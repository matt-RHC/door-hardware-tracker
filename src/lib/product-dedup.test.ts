import { describe, it, expect } from 'vitest'
import { analyzeProducts } from '@/lib/product-dedup'
import type { HardwareSet } from '@/lib/types'

function makeSet(setId: string, items: Array<{ name: string; model: string; manufacturer: string }>): HardwareSet {
  return {
    set_id: setId,
    heading: setId,
    items: items.map((it) => ({
      qty: 1,
      name: it.name,
      model: it.model,
      manufacturer: it.manufacturer,
      finish: '',
    })),
  }
}

describe('analyzeProducts — existing families filter', () => {
  // Two families that differ by one character trigger the Levenshtein-1 typo
  // candidate. We rely on this fixture across the two tests below.
  const setsWithTypo: HardwareSet[] = [
    makeSet('DH1', [
      { name: 'Hinges', model: 'BB1279', manufacturer: 'Hager' },
      { name: 'Hinges', model: 'BB1279', manufacturer: 'Hager' },
    ]),
    makeSet('DH2', [
      // The "O" substitute for "0" — common OCR typo pattern this feature catches.
      { name: 'Hinges', model: 'BB127O', manufacturer: 'Hager' },
    ]),
  ]

  it('surfaces a typo candidate when no existing families are supplied', () => {
    const analysis = analyzeProducts(setsWithTypo)
    expect(analysis.typoCandidates.length).toBeGreaterThan(0)
    const match = analysis.typoCandidates.find((t) => {
      const pair = [t.familyA.baseSeries, t.familyB.baseSeries]
        .map((s) => s.toUpperCase())
        .sort()
      return pair.join(',') === 'BB1279,BB127O' || pair.join(',') === 'BB127O,BB1279'
    })
    expect(match).toBeDefined()
  })

  it('filters the candidate out when one side matches an existing family', () => {
    const analysis = analyzeProducts(setsWithTypo, [
      { manufacturer: 'Hager', base_series: 'BB1279' },
    ])
    // The typo pair is pre-resolved — user already decided this in a prior session.
    expect(analysis.typoCandidates).toHaveLength(0)
  })

  it('is case-insensitive when matching existing families', () => {
    const analysis = analyzeProducts(setsWithTypo, [
      { manufacturer: 'HAGER', base_series: 'bb1279' },
    ])
    expect(analysis.typoCandidates).toHaveLength(0)
  })
})
