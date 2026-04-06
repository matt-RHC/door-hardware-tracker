/**
 * Unit tests for extractJSON.
 * Run: npx tsx src/lib/extractJSON.test.ts
 */
import { extractJSON } from './extractJSON'

let passed = 0
let failed = 0

function assert(name: string, fn: () => void) {
  try {
    fn()
    passed++
    console.log(`  PASS: ${name}`)
  } catch (e) {
    failed++
    console.error(`  FAIL: ${name}`, e instanceof Error ? e.message : e)
  }
}

function assertEqual(actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}

console.log('extractJSON tests:')

// 1. Valid JSON — direct parse
assert('parses valid JSON directly', () => {
  const result = extractJSON('{"hardware_sets": []}')
  assertEqual(result, { hardware_sets: [] })
})

// 2. JSON in markdown code block
assert('extracts JSON from markdown code block', () => {
  const input = 'Here are the results:\n```json\n{"hardware_sets": [{"set_id": "DH1"}]}\n```\nLet me know if you need more.'
  const result = extractJSON(input) as { hardware_sets: Array<{ set_id: string }> }
  assertEqual(result.hardware_sets[0].set_id, 'DH1')
})

// 3. JSON with prose preamble
assert('extracts JSON from prose with embedded JSON', () => {
  const input = 'I found the following hardware sets in the document:\n\n{"hardware_sets": [{"set_id": "EX1", "heading": "Exterior"}]}'
  const result = extractJSON(input) as { hardware_sets: Array<{ set_id: string }> }
  assertEqual(result.hardware_sets[0].set_id, 'EX1')
})

// 4. JSON array
assert('extracts JSON array', () => {
  const input = 'Results: [{"id": 1}, {"id": 2}]'
  const result = extractJSON(input) as Array<{ id: number }>
  assertEqual(result.length, 2)
})

// 5. Pure prose — should throw
assert('throws on pure prose with no JSON', () => {
  let threw = false
  try {
    extractJSON('I could not find any hardware sets in this document. Please try a different PDF.')
  } catch (e) {
    threw = true
    if (!(e instanceof Error) || !e.message.includes('non-JSON response')) {
      throw new Error(`Wrong error message: ${e}`)
    }
  }
  if (!threw) throw new Error('Expected an error to be thrown')
})

// 6. Code block without json label
assert('extracts JSON from unlabeled code block', () => {
  const input = '```\n{"data": true}\n```'
  const result = extractJSON(input) as { data: boolean }
  assertEqual(result.data, true)
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
