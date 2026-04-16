/**
 * Walk a string starting at `startIdx` and find the index of the matching
 * closing bracket for the character at `startIdx`. Respects JSON string
 * literals (ignores brackets inside `"..."`) and escape sequences.
 *
 * Returns the index of the matching close bracket, or `null` if no match
 * exists within the string.
 */
function findBalanced(str: string, startIdx: number): number | null {
  const open = str[startIdx]
  const close = open === '{' ? '}' : open === '[' ? ']' : null
  if (close === null) return null

  let depth = 0
  let inString = false
  let escape = false
  for (let i = startIdx; i < str.length; i++) {
    const ch = str[i]
    if (escape) {
      escape = false
      continue
    }
    if (ch === '\\') {
      escape = true
      continue
    }
    if (ch === '"') {
      inString = !inString
      continue
    }
    if (inString) continue
    if (ch === open) depth++
    else if (ch === close) {
      depth--
      if (depth === 0) return i
    }
  }
  return null
}

/**
 * Scan `text` for every `{...}` or `[...]` substring that is bracket-
 * balanced, yielding each in order of appearance. Used to try every
 * candidate JSON block when the first one doesn't parse — handles the
 * "prose JSON prose JSON prose" case that the old greedy regex dropped.
 */
function* iterateBalancedCandidates(text: string): Generator<string> {
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (ch === '{' || ch === '[') {
      const end = findBalanced(text, i)
      if (end !== null) {
        yield text.slice(i, end + 1)
        i = end + 1
        continue
      }
    }
    i++
  }
}

/**
 * Extract a JSON object or array from an LLM response that may contain
 * prose, markdown code blocks, or multiple JSON blocks.
 *
 * Strategy (first win returns):
 *   1. Direct `JSON.parse(raw)` — the happy path when the model obeyed
 *      "respond with ONLY valid JSON."
 *   2. Every markdown code block (```json ... ```) in order.
 *   3. Every bracket-balanced `{...}` / `[...]` substring in order.
 *
 * Returns `null` when no valid JSON can be extracted, allowing callers
 * to fall back to safe defaults instead of crashing the wizard.
 *
 * The previous implementation used a greedy regex `/(\{[\s\S]*\})/` that
 * matched from the first `{` to the last `}` in the text. When the model
 * emitted prose-then-JSON-then-more-prose-then-more-JSON, the whole
 * middle collapsed into one un-parseable string and extractJSON returned
 * null — dropping every correction in a Darrin checkpoint. This version
 * walks candidates one at a time and tries each independently.
 */
export function extractJSON(raw: string): object | null {
  if (!raw || raw.trim().length === 0) return null

  // Try direct parse first
  try {
    return JSON.parse(raw)
  } catch { /* fall through */ }

  console.warn('extractJSON: direct parse failed, attempting fallback extraction')

  // Try every markdown code block in order
  const codeBlockRx = /```(?:json)?\s*([\s\S]*?)```/g
  let match: RegExpExecArray | null
  while ((match = codeBlockRx.exec(raw)) !== null) {
    try {
      return JSON.parse(match[1].trim())
    } catch { /* try next block */ }
  }

  // Try every bracket-balanced candidate in order (first valid wins).
  for (const candidate of iterateBalancedCandidates(raw)) {
    try {
      return JSON.parse(candidate)
    } catch { /* try next candidate */ }
  }

  // All extraction attempts failed — return null so callers can use safe defaults
  console.error(`extractJSON: all strategies failed. Raw response (first 300 chars): ${raw.substring(0, 300)}`)
  return null
}
