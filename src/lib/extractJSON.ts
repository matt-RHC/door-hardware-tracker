/**
 * Extract a JSON object or array from an LLM response that may contain
 * prose, markdown code blocks, or other non-JSON text.
 *
 * Returns `null` when no valid JSON can be extracted, allowing callers
 * to fall back to safe defaults instead of crashing the wizard.
 */
export function extractJSON(raw: string): object | null {
  if (!raw || raw.trim().length === 0) return null

  // Try direct parse first
  try {
    return JSON.parse(raw)
  } catch { /* fall through */ }

  console.warn('extractJSON: direct parse failed, attempting fallback extraction')

  // Try extracting JSON from markdown code blocks
  const codeBlockMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (codeBlockMatch) {
    try {
      return JSON.parse(codeBlockMatch[1].trim())
    } catch { /* fall through */ }
  }

  // Try finding first { ... } or [ ... ] block
  const jsonMatch = raw.match(/(\{[\s\S]*\}|\[[\s\S]*\])/)
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[1])
    } catch { /* fall through */ }
  }

  // All extraction attempts failed — return null so callers can use safe defaults
  console.error(`extractJSON: all strategies failed. Raw response (first 300 chars): ${raw.substring(0, 300)}`)
  return null
}
