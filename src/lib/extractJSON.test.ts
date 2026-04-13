import { describe, it, expect } from 'vitest'
import { extractJSON } from './extractJSON'

describe('extractJSON', () => {
  it('parses valid JSON directly', () => {
    const result = extractJSON('{"hardware_sets": []}')
    expect(result).toEqual({ hardware_sets: [] })
  })

  it('extracts JSON from markdown code block', () => {
    const input =
      'Here are the results:\n```json\n{"hardware_sets": [{"set_id": "DH1"}]}\n```\nLet me know if you need more.'
    const result = extractJSON(input) as { hardware_sets: Array<{ set_id: string }> }
    expect(result.hardware_sets[0].set_id).toBe('DH1')
  })

  it('extracts JSON from prose with embedded JSON', () => {
    const input =
      'I found the following hardware sets:\n\n{"hardware_sets": [{"set_id": "EX1", "heading": "Exterior"}]}'
    const result = extractJSON(input) as { hardware_sets: Array<{ set_id: string }> }
    expect(result.hardware_sets[0].set_id).toBe('EX1')
  })

  it('extracts JSON array', () => {
    const input = 'Results: [{"id": 1}, {"id": 2}]'
    const result = extractJSON(input) as Array<{ id: number }>
    expect(result).toHaveLength(2)
  })

  it('returns null on pure prose with no JSON', () => {
    const result = extractJSON('I could not find any hardware sets. Please try a different PDF.')
    expect(result).toBeNull()
  })

  it('extracts JSON from unlabeled code block', () => {
    const input = '```\n{"data": true}\n```'
    const result = extractJSON(input) as { data: boolean }
    expect(result.data).toBe(true)
  })

  it('returns null on empty string', () => {
    expect(extractJSON('')).toBeNull()
  })

  it('returns null on whitespace-only string', () => {
    expect(extractJSON('   \n\t  ')).toBeNull()
  })

  it('extracts JSON with trailing prose after the object', () => {
    const input = '{"overall_confidence": "medium", "notes": "Looks good"}\n\nHere are some additional thoughts about the extraction.'
    const result = extractJSON(input) as { overall_confidence: string }
    expect(result.overall_confidence).toBe('medium')
  })

  it('extracts JSON with leading prose before the object', () => {
    const input = 'Here is my review:\n\n{"flags": [], "notes": "All clear"}'
    const result = extractJSON(input) as { flags: unknown[]; notes: string }
    expect(result.flags).toEqual([])
    expect(result.notes).toBe('All clear')
  })

  it('extracts JSON from code fence with trailing prose', () => {
    const input = 'Results:\n```json\n{"set_id": "DH1", "items": []}\n```\nLet me know if you have questions!'
    const result = extractJSON(input) as { set_id: string }
    expect(result.set_id).toBe('DH1')
  })

  it('returns null on malformed JSON (unbalanced braces)', () => {
    const result = extractJSON('{"broken": true, "missing_close')
    expect(result).toBeNull()
  })

  it('extracts first valid block when multiple JSON objects are separated by prose', () => {
    // Greedy regex would match from the first `{` to the last `}` and
    // fail JSON.parse because of the prose in between. Bracket-balanced
    // extraction finds each candidate independently.
    const input =
      'Here is my review:\n{"overall_confidence": "high", "notes": "looks solid"}\n\n' +
      'And here are some extra thoughts: {"scratch": "draft"}'
    const result = extractJSON(input) as { overall_confidence: string; notes: string }
    expect(result.overall_confidence).toBe('high')
    expect(result.notes).toBe('looks solid')
  })

  it('skips a broken candidate and returns the next valid one', () => {
    // Two objects where the first parses, ensuring we don\'t accidentally
    // collapse them with a greedy match.
    const input =
      '```json\n{"oops": this is broken json}\n```\n' +
      'Fallback: {"valid": true}'
    const result = extractJSON(input) as { valid: boolean }
    expect(result.valid).toBe(true)
  })

  it('handles nested braces inside string values', () => {
    const input = 'Debug: {"raw": "a {nested} value", "ok": true}'
    const result = extractJSON(input) as { raw: string; ok: boolean }
    expect(result.raw).toBe('a {nested} value')
    expect(result.ok).toBe(true)
  })

  it('handles escaped quotes inside string values', () => {
    const input = 'Note: {"quote": "she said \\"hi\\"", "ok": true}'
    const result = extractJSON(input) as { quote: string; ok: boolean }
    expect(result.quote).toBe('she said "hi"')
    expect(result.ok).toBe(true)
  })

  it('extracts JSON from the first of two code blocks when the first is valid', () => {
    const input =
      '```json\n{"first": 1}\n```\n' +
      'and another:\n```json\n{"second": 2}\n```'
    const result = extractJSON(input) as { first: number }
    expect(result.first).toBe(1)
  })
})
