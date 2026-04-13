import { describe, it, expect } from 'vitest'
import { toPunchyConfidence } from './index'

describe('toPunchyConfidence', () => {
  it('accepts the three valid union members', () => {
    expect(toPunchyConfidence('high')).toBe('high')
    expect(toPunchyConfidence('medium')).toBe('medium')
    expect(toPunchyConfidence('low')).toBe('low')
  })

  it('coerces unknown strings to the default', () => {
    expect(toPunchyConfidence('fair')).toBe('medium')
    expect(toPunchyConfidence('unknown')).toBe('medium')
    expect(toPunchyConfidence('HIGH')).toBe('medium') // case-sensitive by design
  })

  it('coerces nullish and non-string values to the default', () => {
    expect(toPunchyConfidence(undefined)).toBe('medium')
    expect(toPunchyConfidence(null)).toBe('medium')
    expect(toPunchyConfidence(0)).toBe('medium')
    expect(toPunchyConfidence({})).toBe('medium')
  })

  it('honours a caller-supplied fallback', () => {
    expect(toPunchyConfidence('bogus', 'low')).toBe('low')
    expect(toPunchyConfidence(undefined, 'high')).toBe('high')
  })
})
