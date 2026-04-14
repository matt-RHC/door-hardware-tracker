import { describe, it, expect } from 'vitest'
import { classifyItem, HARDWARE_TAXONOMY } from './hardware-taxonomy'
import type { InstallScope } from './hardware-taxonomy'

/** Helper: look up install_scope for a category ID */
function scopeOf(categoryId: string): InstallScope | undefined {
  return HARDWARE_TAXONOMY.find(c => c.id === categoryId)?.install_scope
}

// ── classifyItem: hinge type splitting ──

describe('classifyItem — hinge types', () => {
  it('classifies standard butt hinges as "hinges"', () => {
    expect(classifyItem('Butt Hinge 4.5x4.5')).toBe('hinges')
    expect(classifyItem('Hinges 5BB1 4.5x4.5 NRP')).toBe('hinges')
    expect(classifyItem('Hinge')).toBe('hinges')
    expect(classifyItem('Hinges')).toBe('hinges')
    expect(classifyItem('5BB1 HW 4.5x4.5')).toBe('hinges')
    expect(classifyItem('BB1 Hinge')).toBe('hinges')
  })

  it('classifies continuous/geared hinges as "continuous_hinge"', () => {
    expect(classifyItem('Continuous Hinge')).toBe('continuous_hinge')
    expect(classifyItem('Geared Hinge Full Mortise')).toBe('continuous_hinge')
    expect(classifyItem('Pin and Barrel Hinge')).toBe('continuous_hinge')
    expect(classifyItem('Full Length Hinge')).toBe('continuous_hinge')
  })

  it('classifies pivot hinges as "pivot_hinge"', () => {
    expect(classifyItem('Pivot Set')).toBe('pivot_hinge')
    expect(classifyItem('Offset Pivot')).toBe('pivot_hinge')
    expect(classifyItem('Intermediate Pivot')).toBe('pivot_hinge')
    expect(classifyItem('Center Pivot')).toBe('pivot_hinge')
    expect(classifyItem('Floor Pivot')).toBe('pivot_hinge')
  })

  it('classifies spring hinges as "spring_hinge"', () => {
    expect(classifyItem('Spring Hinge')).toBe('spring_hinge')
    expect(classifyItem('Self Closing Hinge')).toBe('spring_hinge')
  })

  it('classifies electric/conductor hinges as "electric_hinge"', () => {
    expect(classifyItem('Hinges 5BB1 4.5x4.5 CON TW8')).toBe('electric_hinge')
    expect(classifyItem('Electric Hinge ETH')).toBe('electric_hinge')
    expect(classifyItem('Conductor Hinge')).toBe('electric_hinge')
    expect(classifyItem('Power Transfer Hinge')).toBe('electric_hinge')
  })

  it('classifies electric hinges when identifier is in model field (real PDF data)', () => {
    // Real PDF extraction splits data: name="Hinges", model="5BB1 HW 4 1/2 x 4 1/2 CON TW8"
    // The "CON TW8" identifier is ONLY in the model field.
    expect(classifyItem('Hinges', undefined, '5BB1 HW 4 1/2 x 4 1/2 CON TW8')).toBe('electric_hinge')
    expect(classifyItem('Hinges', undefined, '5BB1 HW 4.5x4.5 CON TW8')).toBe('electric_hinge')
    expect(classifyItem('Hinges', undefined, 'BB1279 4.5x4.5 CON TW4')).toBe('electric_hinge')
  })

  it('classifies standard hinges correctly when model has no electric identifier', () => {
    // Standard hinges should NOT be reclassified when model is a plain model number
    expect(classifyItem('Hinges', undefined, '5BB1 HW 4 1/2 x 4 1/2 NRP')).toBe('hinges')
    expect(classifyItem('Hinges', undefined, '5BB1 4.5x4.5')).toBe('hinges')
    expect(classifyItem('Hinges')).toBe('hinges')
  })

  it('does NOT classify continuous/pivot/spring as generic "hinges"', () => {
    expect(classifyItem('Continuous Hinge')).not.toBe('hinges')
    expect(classifyItem('Pivot Set')).not.toBe('hinges')
    expect(classifyItem('Spring Hinge')).not.toBe('hinges')
  })
})

// ── classifyItem: new categories ──

describe('classifyItem — new categories', () => {
  it('classifies dust proof strikes as "dust_proof_strike"', () => {
    expect(classifyItem('Dust Proof Strike')).toBe('dust_proof_strike')
    expect(classifyItem('DPS')).toBe('dust_proof_strike')
  })

  it('classifies mullions as "mullion"', () => {
    expect(classifyItem('Mullion')).toBe('mullion')
    expect(classifyItem('Removable Mullion')).toBe('mullion')
  })

  it('classifies signage as "signage"', () => {
    expect(classifyItem('Room Number Sign')).toBe('signage')
    expect(classifyItem('Signage')).toBe('signage')
    expect(classifyItem('Placard')).toBe('signage')
  })

  it('classifies viewers as "viewer"', () => {
    expect(classifyItem('Door Viewer')).toBe('viewer')
    expect(classifyItem('Peephole')).toBe('viewer')
    expect(classifyItem('Viewer')).toBe('viewer')
  })

  it('dust proof strike is separate from flush bolt', () => {
    expect(classifyItem('Dust Proof Strike')).toBe('dust_proof_strike')
    expect(classifyItem('Flush Bolt')).toBe('flush_bolt')
  })
})

// ── Scope values ──

describe('HARDWARE_TAXONOMY — install_scope values', () => {
  it('all categories have a defined install_scope', () => {
    for (const cat of HARDWARE_TAXONOMY) {
      expect(cat.install_scope, `${cat.id} should have install_scope`).toBeDefined()
      expect(
        ['per_leaf', 'per_opening', 'per_pair', 'per_frame'].includes(cat.install_scope),
        `${cat.id} has invalid scope: ${cat.install_scope}`,
      ).toBe(true)
    }
  })

  // Hinge scopes
  it('hinges (butt) scope is per_leaf', () => { expect(scopeOf('hinges')).toBe('per_leaf') })
  it('continuous_hinge scope is per_leaf', () => { expect(scopeOf('continuous_hinge')).toBe('per_leaf') })
  it('pivot_hinge scope is per_opening', () => { expect(scopeOf('pivot_hinge')).toBe('per_opening') })
  it('spring_hinge scope is per_leaf', () => { expect(scopeOf('spring_hinge')).toBe('per_leaf') })
  it('electric_hinge scope is per_opening', () => { expect(scopeOf('electric_hinge')).toBe('per_opening') })

  // Door control
  it('closer scope is per_opening', () => { expect(scopeOf('closer')).toBe('per_opening') })
  it('auto_operator scope is per_opening', () => { expect(scopeOf('auto_operator')).toBe('per_opening') })
  it('coordinator scope is per_pair', () => { expect(scopeOf('coordinator')).toBe('per_pair') })
  it('stop scope is per_opening', () => { expect(scopeOf('stop')).toBe('per_opening') })

  // Locking
  it('lockset scope is per_leaf', () => { expect(scopeOf('lockset')).toBe('per_leaf') })
  it('exit_device scope is per_leaf', () => { expect(scopeOf('exit_device')).toBe('per_leaf') })
  it('strike scope is per_opening', () => { expect(scopeOf('strike')).toBe('per_opening') })
  it('cylinder_housing scope is per_leaf', () => { expect(scopeOf('cylinder_housing')).toBe('per_leaf') })
  it('core scope is per_leaf', () => { expect(scopeOf('core')).toBe('per_leaf') })

  // Electrified
  it('elec_modification scope is per_leaf', () => { expect(scopeOf('elec_modification')).toBe('per_leaf') })
  it('wire_harness scope is per_opening', () => { expect(scopeOf('wire_harness')).toBe('per_opening') })

  // Pair-specific
  it('flush_bolt scope is per_pair', () => { expect(scopeOf('flush_bolt')).toBe('per_pair') })
  it('dust_proof_strike scope is per_pair', () => { expect(scopeOf('dust_proof_strike')).toBe('per_pair') })
  it('astragal scope is per_pair', () => { expect(scopeOf('astragal')).toBe('per_pair') })
  it('mullion scope is per_pair', () => { expect(scopeOf('mullion')).toBe('per_pair') })

  // Protection / trim
  it('kick_plate scope is per_leaf', () => { expect(scopeOf('kick_plate')).toBe('per_leaf') })

  // Seals & weatherproofing
  it('threshold scope is per_frame', () => { expect(scopeOf('threshold')).toBe('per_frame') })
  it('gasket scope is per_frame', () => { expect(scopeOf('gasket')).toBe('per_frame') })
  it('smoke_seal scope is per_frame', () => { expect(scopeOf('smoke_seal')).toBe('per_frame') })
  it('gasketing scope is per_frame', () => { expect(scopeOf('gasketing')).toBe('per_frame') })
  it('acoustic_seal scope is per_frame', () => { expect(scopeOf('acoustic_seal')).toBe('per_frame') })
  it('weatherstrip scope is per_frame', () => { expect(scopeOf('weatherstrip')).toBe('per_frame') })
  it('rain_drip scope is per_frame', () => { expect(scopeOf('rain_drip')).toBe('per_frame') })
  it('door_sweep scope is per_leaf', () => { expect(scopeOf('door_sweep')).toBe('per_leaf') })

  // Misc
  it('silencer scope is per_frame', () => { expect(scopeOf('silencer')).toBe('per_frame') })
  it('by_others scope is per_opening', () => { expect(scopeOf('by_others')).toBe('per_opening') })
  it('signage scope is per_opening', () => { expect(scopeOf('signage')).toBe('per_opening') })
  it('viewer scope is per_leaf', () => { expect(scopeOf('viewer')).toBe('per_leaf') })
})

// ── Pattern ordering: specific hinge types before generic ──

describe('HARDWARE_TAXONOMY — pattern ordering', () => {
  it('electric_hinge comes before hinges in array', () => {
    const electricIdx = HARDWARE_TAXONOMY.findIndex(c => c.id === 'electric_hinge')
    const genericIdx = HARDWARE_TAXONOMY.findIndex(c => c.id === 'hinges')
    expect(electricIdx).toBeLessThan(genericIdx)
  })

  it('continuous_hinge comes before hinges in array', () => {
    const continuousIdx = HARDWARE_TAXONOMY.findIndex(c => c.id === 'continuous_hinge')
    const genericIdx = HARDWARE_TAXONOMY.findIndex(c => c.id === 'hinges')
    expect(continuousIdx).toBeLessThan(genericIdx)
  })

  it('pivot_hinge comes before hinges in array', () => {
    const pivotIdx = HARDWARE_TAXONOMY.findIndex(c => c.id === 'pivot_hinge')
    const genericIdx = HARDWARE_TAXONOMY.findIndex(c => c.id === 'hinges')
    expect(pivotIdx).toBeLessThan(genericIdx)
  })

  it('spring_hinge comes before hinges in array', () => {
    const springIdx = HARDWARE_TAXONOMY.findIndex(c => c.id === 'spring_hinge')
    const genericIdx = HARDWARE_TAXONOMY.findIndex(c => c.id === 'hinges')
    expect(springIdx).toBeLessThan(genericIdx)
  })

  it('dust_proof_strike comes before strike in array', () => {
    const dpsIdx = HARDWARE_TAXONOMY.findIndex(c => c.id === 'dust_proof_strike')
    const strikeIdx = HARDWARE_TAXONOMY.findIndex(c => c.id === 'strike')
    expect(dpsIdx).toBeLessThan(strikeIdx)
  })
})
