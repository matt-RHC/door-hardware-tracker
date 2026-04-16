import { describe, it, expect } from 'vitest'
import { RegionExtractRequestSchema } from './parse-pdf'

const validProjectId = '00000000-0000-0000-0000-000000000000'

describe('RegionExtractRequestSchema', () => {
  const base = {
    projectId: validProjectId,
    setId: 'DH1',
    page: 3,
    bbox: { x0: 0.1, y0: 0.2, x1: 0.4, y1: 0.5 },
  }

  it('accepts the legacy items-mode request (no mode specified)', () => {
    const parsed = RegionExtractRequestSchema.safeParse(base)
    expect(parsed.success).toBe(true)
  })

  it('accepts mode=items', () => {
    const parsed = RegionExtractRequestSchema.safeParse({ ...base, mode: 'items' })
    expect(parsed.success).toBe(true)
  })

  it('accepts mode=field with target field and door numbers', () => {
    const parsed = RegionExtractRequestSchema.safeParse({
      ...base,
      mode: 'field',
      targetField: 'location',
      targetDoorNumbers: ['110.1', '113'],
    })
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.mode).toBe('field')
      expect(parsed.data.targetDoorNumbers).toEqual(['110.1', '113'])
    }
  })

  it('rejects unknown mode values', () => {
    const parsed = RegionExtractRequestSchema.safeParse({ ...base, mode: 'darrin' })
    expect(parsed.success).toBe(false)
  })

  it('rejects unknown target fields', () => {
    const parsed = RegionExtractRequestSchema.safeParse({
      ...base,
      mode: 'field',
      targetField: 'mystery',
    })
    expect(parsed.success).toBe(false)
  })

  it('rejects non-uuid projectId', () => {
    const parsed = RegionExtractRequestSchema.safeParse({ ...base, projectId: 'not-a-uuid' })
    expect(parsed.success).toBe(false)
  })

  it('accepts propagate: true for the Darrin propagation flow', () => {
    const parsed = RegionExtractRequestSchema.safeParse({
      ...base,
      mode: 'field',
      targetField: 'location',
      targetDoorNumbers: ['110.1', '113'],
      propagate: true,
    })
    expect(parsed.success).toBe(true)
    if (parsed.success) expect(parsed.data.propagate).toBe(true)
  })

  it('rejects non-boolean propagate values', () => {
    const parsed = RegionExtractRequestSchema.safeParse({
      ...base,
      mode: 'field',
      propagate: 'yes',
    })
    expect(parsed.success).toBe(false)
  })
})
