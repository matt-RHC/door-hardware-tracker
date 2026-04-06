/**
 * Extract a JSON object or array from an LLM response that may contain
 * prose, markdown code blocks, or other non-JSON text.
 */
export function extractJSON(raw: string): object {
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

  // All extraction attempts failed
  throw new Error(`LLM returned non-JSON response: ${raw.substring(0, 200)}...`)
}
