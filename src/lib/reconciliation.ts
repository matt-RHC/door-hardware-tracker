/**
 * Reconciliation engine (Nuclear Option Phase C).
 *
 * Merges results from Strategy A (pdfplumber + regex) and Strategy B
 * (vision model page-by-page extraction) using voting/agreement to produce
 * a single high-confidence output with per-field audit trails.
 */

import type { HardwareSet, ExtractedHardwareItem } from '@/lib/types'
import type { VisionExtractionResult, VisionHardwareSet } from '@/lib/parse-pdf-helpers'
import { normalizeName } from '@/lib/parse-pdf-helpers'
import type {
  AgreementLevel,
  FieldReconciliation,
  ReconciledItem,
  ReconciledHardwareSet,
  ReconciliationResult,
} from '@/lib/types/reconciliation'

// ── String matching utilities ───────────────────────────────────

/** Compute Jaccard similarity on word tokens between two strings. Returns [0, 1]. */
function tokenJaccard(a: string, b: string): number {
  const setA = new Set((a ?? '').toLowerCase().split(/\s+/).filter(Boolean))
  const setB = new Set((b ?? '').toLowerCase().split(/\s+/).filter(Boolean))
  if (setA.size === 0 && setB.size === 0) return 1
  if (setA.size === 0 || setB.size === 0) return 0
  let intersection = 0
  for (const w of setA) if (setB.has(w)) intersection++
  const union = new Set([...setA, ...setB]).size
  return intersection / union
}

const HARDWARE_CATEGORY_KEYWORDS = [
  'hinge', 'closer', 'lockset', 'exit', 'stop', 'seal',
  'threshold', 'kick', 'flush', 'coordinator', 'bolt',
] as const

function extractCategory(name: string): string | undefined {
  const lower = (name ?? '').toLowerCase()
  return HARDWARE_CATEGORY_KEYWORDS.find(kw => lower.includes(kw))
}

/** Normalize a set_id for matching: strip whitespace, hyphens, lowercase. */
function normalizeSetId(id: string): string {
  return (id ?? '').toLowerCase().replace(/[\s\-_]+/g, '')
}

/**
 * Match an item name from Strategy B against Strategy A item names using
 * the same tiered matching as findItemFuzzy (PR #170):
 *   1. Exact match
 *   2. Case-insensitive match
 *   3. Normalized match
 *   4. Substring match (min 8 chars, 50% length ratio guard)
 *   5. Jaccard scoring (0.5 threshold)
 *
 * Returns the index of the best-matching Strategy A item, or -1 if no match.
 */
function matchItemName(nameB: string, namesA: string[]): number {
  // 1. Exact match
  const exactIdx = namesA.findIndex(n => n === nameB)
  if (exactIdx !== -1) return exactIdx

  // 2. Case-insensitive match
  const lowerB = (nameB ?? '').toLowerCase()
  const ciIdx = namesA.findIndex(n => (n ?? '').toLowerCase() === lowerB)
  if (ciIdx !== -1) return ciIdx

  // Category guard
  const catB = extractCategory(nameB)
  function categoryCompatible(nameA: string): boolean {
    const catA = extractCategory(nameA)
    if (catB && catA) return catB === catA
    return true
  }

  // 3. Normalized match
  const normB = normalizeName(nameB)
  const normMatches = namesA
    .map((n, i) => ({ name: n, idx: i }))
    .filter(({ name }) => categoryCompatible(name) && normalizeName(name) === normB)
  if (normMatches.length === 1) return normMatches[0].idx
  if (normMatches.length > 1) {
    const scored = normMatches.map(m => ({ idx: m.idx, score: tokenJaccard(nameB, m.name) }))
    scored.sort((a, b) => b.score - a.score)
    if (scored[0].score > scored[1].score) return scored[0].idx
    return -1 // ambiguous
  }

  // 4. Substring/contains match (min 8 chars, 50% length ratio guard)
  const MIN_SUBSTRING_LEN = 8
  if (nameB.length >= MIN_SUBSTRING_LEN) {
    const substringMatches = namesA
      .map((n, i) => ({ name: n, idx: i }))
      .filter(({ name }) => {
        if (!categoryCompatible(name)) return false
        const nLower = (name ?? '').toLowerCase()
        const isSubstring = nLower.includes(lowerB) || lowerB.includes(nLower)
        if (!isSubstring) return false
        const shorter = Math.min(lowerB.length, nLower.length)
        const longer = Math.max(lowerB.length, nLower.length)
        return shorter / longer >= 0.5
      })
    if (substringMatches.length === 1) return substringMatches[0].idx
    if (substringMatches.length > 1) {
      const scored = substringMatches.map(m => ({ idx: m.idx, score: tokenJaccard(nameB, m.name) }))
      scored.sort((a, b) => b.score - a.score)
      if (scored[0].score > scored[1].score) return scored[0].idx
      return -1
    }
  }

  // 5. Jaccard scoring — last resort
  const JACCARD_THRESHOLD = 0.5
  const allScored = namesA
    .map((n, i) => ({ idx: i, score: tokenJaccard(nameB, n) }))
    .filter(s => categoryCompatible(namesA[s.idx]) && s.score > JACCARD_THRESHOLD)
  allScored.sort((a, b) => b.score - a.score)
  if (allScored.length >= 2 && allScored[0].score === allScored[1].score) return -1
  if (allScored.length >= 1) return allScored[0].idx

  return -1
}

// ── Reconciliation helpers ──────────────────────────────────────

/** Reconcile a single field from two strategy sources. */
function reconcileField(
  fieldName: string,
  valueA: string | number | undefined | null,
  valueB: string | number | undefined | null,
  preference: 'a' | 'b',
  context: string,
): FieldReconciliation {
  const a = valueA ?? ''
  const b = valueB ?? ''
  const aStr = String(a)
  const bStr = String(b)
  const aEmpty = aStr.trim() === ''
  const bEmpty = bStr.trim() === ''

  // Both empty
  if (aEmpty && bEmpty) {
    return {
      value: '',
      confidence: 'conflict',
      sources: {},
      chosen_from: 'agreed',
      reason: `${context}: both strategies returned empty ${fieldName}`,
    }
  }

  // Only A has a value
  if (!aEmpty && bEmpty) {
    return {
      value: a,
      confidence: 'single_source',
      sources: { strategy_a: a },
      chosen_from: 'a',
      reason: `${context}: only Strategy A had ${fieldName}`,
    }
  }

  // Only B has a value
  if (aEmpty && !bEmpty) {
    return {
      value: b,
      confidence: 'single_source',
      sources: { strategy_b: b },
      chosen_from: 'b',
      reason: `${context}: only Vision model had ${fieldName}`,
    }
  }

  // Both have values — check agreement
  const agree = typeof a === 'number' && typeof b === 'number'
    ? a === b
    : (aStr ?? '').toLowerCase().trim() === (bStr ?? '').toLowerCase().trim()

  if (agree) {
    return {
      value: a,
      confidence: 'full',
      sources: { strategy_a: a, strategy_b: b },
      chosen_from: 'agreed',
      reason: `${context}: both strategies agree on ${fieldName}`,
    }
  }

  // Conflict — use preference
  const winner = preference === 'a' ? a : b
  const preferenceLabel = preference === 'a'
    ? 'Strategy A (pdfplumber more reliable for quantities)'
    : 'Vision model (reads what humans read)'

  return {
    value: winner,
    confidence: 'conflict',
    sources: { strategy_a: a, strategy_b: b },
    chosen_from: preference,
    reason: `${context}: Strategy A=${JSON.stringify(a)}, Vision=${JSON.stringify(b)} — conflict, using ${preferenceLabel}`,
  }
}

/** Compute the worst agreement level from a list. */
function worstAgreement(levels: AgreementLevel[]): AgreementLevel {
  const rank: Record<AgreementLevel, number> = {
    full: 3,
    majority: 2,
    single_source: 1,
    conflict: 0,
  }
  if (levels.length === 0) return 'single_source'
  let worst: AgreementLevel = 'full'
  for (const l of levels) {
    if (rank[l] < rank[worst]) worst = l
  }
  return worst
}

/** Score for a given agreement level (used in weighted average). */
const AGREEMENT_SCORE: Record<AgreementLevel, number> = {
  full: 100,
  majority: 75,
  single_source: 50,
  conflict: 25,
}

// ── Main reconciliation function ────────────────────────────────

export function reconcileExtractions(
  strategyA: HardwareSet[],
  strategyB: VisionExtractionResult,
): ReconciliationResult {
  const auditLog: string[] = []
  const reconciledSets: ReconciledHardwareSet[] = []

  // Build lookup maps for set matching
  const setsA = new Map<string, HardwareSet>()
  const setsANormalized = new Map<string, HardwareSet>()
  for (const s of strategyA) {
    setsA.set(s.set_id, s)
    setsANormalized.set(normalizeSetId(s.set_id), s)
  }

  const setsB = new Map<string, VisionHardwareSet>()
  const setsBNormalized = new Map<string, VisionHardwareSet>()
  for (const s of strategyB.hardware_sets) {
    setsB.set(s.set_id, s)
    setsBNormalized.set(normalizeSetId(s.set_id), s)
  }

  // Track which sets have been matched
  const matchedA = new Set<string>()
  const matchedB = new Set<string>()

  // Step 1: Match sets across strategies

  // Pass 1: exact set_id match
  for (const setB of strategyB.hardware_sets) {
    if (setsA.has(setB.set_id)) {
      matchedA.add(setB.set_id)
      matchedB.add(setB.set_id)
    }
  }

  // Pass 2: normalized set_id match for unmatched sets
  for (const setB of strategyB.hardware_sets) {
    if (matchedB.has(setB.set_id)) continue
    const normId = normalizeSetId(setB.set_id)
    const matchA = setsANormalized.get(normId)
    if (matchA && !matchedA.has(matchA.set_id)) {
      matchedA.add(matchA.set_id)
      matchedB.add(setB.set_id)
      auditLog.push(`Set matching: "${setB.set_id}" (Vision) matched to "${matchA.set_id}" (Strategy A) via normalized ID`)
    }
  }

  // Pass 3: heading text similarity for remaining unmatched sets
  const unmatchedBSets = strategyB.hardware_sets.filter(s => !matchedB.has(s.set_id))
  const unmatchedASets = strategyA.filter(s => !matchedA.has(s.set_id))

  for (const setB of unmatchedBSets) {
    let bestMatch: HardwareSet | undefined
    let bestScore = 0
    for (const setA of unmatchedASets) {
      if (matchedA.has(setA.set_id)) continue
      const score = tokenJaccard(setB.heading, setA.heading)
      if (score > bestScore && score >= 0.5) {
        bestScore = score
        bestMatch = setA
      }
    }
    if (bestMatch) {
      matchedA.add(bestMatch.set_id)
      matchedB.add(setB.set_id)
      auditLog.push(`Set matching: "${setB.set_id}" (Vision) matched to "${bestMatch.set_id}" (Strategy A) via heading similarity (Jaccard=${bestScore.toFixed(2)})`)
    }
  }

  // Build a lookup from B set_id → matched A set
  // We need to resolve the actual matched pairs for reconciliation
  function findMatchedA(setBId: string): HardwareSet | undefined {
    // Exact match
    const exact = setsA.get(setBId)
    if (exact && matchedA.has(exact.set_id)) return exact
    // Normalized match
    const normId = normalizeSetId(setBId)
    const norm = setsANormalized.get(normId)
    if (norm && matchedA.has(norm.set_id)) return norm
    // Heading match (look through all matched A sets)
    for (const setA of strategyA) {
      if (!matchedA.has(setA.set_id)) continue
      // Check if this A set was matched to this B set
      const isMatchedToSomeoneElse = strategyB.hardware_sets.some(
        sb => sb.set_id !== setBId && (
          sb.set_id === setA.set_id ||
          normalizeSetId(sb.set_id) === normalizeSetId(setA.set_id)
        ),
      )
      if (!isMatchedToSomeoneElse) {
        // This A set is matched but not to any other B set — must be ours (heading match)
        const headingScore = tokenJaccard(
          strategyB.hardware_sets.find(s => s.set_id === setBId)?.heading ?? '',
          setA.heading,
        )
        if (headingScore >= 0.5) return setA
      }
    }
    return undefined
  }

  // Step 2: Reconcile matched sets
  for (const setB of strategyB.hardware_sets) {
    if (!matchedB.has(setB.set_id)) continue
    const setA = findMatchedA(setB.set_id)
    if (!setA) continue

    const setCtx = `Set ${setA.set_id}`
    const reconciledItems: ReconciledItem[] = []

    // Match items across strategies
    const aNamesUsed = new Set<number>()
    const aNames = setA.items.map(i => i.name)

    // For each B item, find matching A item
    const bToA = new Map<number, number>() // B index → A index
    for (let bi = 0; bi < setB.items.length; bi++) {
      const itemB = setB.items[bi]
      const matchIdx = matchItemName(itemB.name, aNames)
      if (matchIdx !== -1 && !aNamesUsed.has(matchIdx)) {
        bToA.set(bi, matchIdx)
        aNamesUsed.add(matchIdx)
      }
    }

    // Reconcile matched items
    for (const [bi, ai] of bToA.entries()) {
      const itemA = setA.items[ai]
      const itemB = setB.items[bi]
      const itemCtx = `${setCtx} item '${itemA.name}'`

      const name = reconcileField('name', itemA.name, itemB.name, 'b', itemCtx)
      const qty = reconcileField('qty', itemA.qty, itemB.qty, 'a', itemCtx)
      const manufacturer = reconcileField('manufacturer', itemA.manufacturer, itemB.manufacturer, 'b', itemCtx)
      const model = reconcileField('model', itemA.model, itemB.model, 'b', itemCtx)
      const finish = reconcileField('finish', itemA.finish, itemB.finish, 'b', itemCtx)

      const fieldConfidences = [name.confidence, qty.confidence, manufacturer.confidence, model.confidence, finish.confidence]

      reconciledItems.push({
        name,
        qty,
        manufacturer,
        model,
        finish,
        category: itemB.category || '',
        overall_confidence: worstAgreement(fieldConfidences),
      })
    }

    // Unmatched A items (single source)
    for (let ai = 0; ai < setA.items.length; ai++) {
      if (aNamesUsed.has(ai)) continue
      const itemA = setA.items[ai]
      const itemCtx = `${setCtx} item '${itemA.name}'`
      auditLog.push(`${itemCtx}: only found by Strategy A — single source`)

      reconciledItems.push({
        name: { value: itemA.name, confidence: 'single_source', sources: { strategy_a: itemA.name }, chosen_from: 'a', reason: `${itemCtx}: only found by Strategy A` },
        qty: { value: itemA.qty, confidence: 'single_source', sources: { strategy_a: itemA.qty }, chosen_from: 'a', reason: `${itemCtx}: only found by Strategy A` },
        manufacturer: { value: itemA.manufacturer, confidence: 'single_source', sources: { strategy_a: itemA.manufacturer }, chosen_from: 'a', reason: `${itemCtx}: only found by Strategy A` },
        model: { value: itemA.model, confidence: 'single_source', sources: { strategy_a: itemA.model }, chosen_from: 'a', reason: `${itemCtx}: only found by Strategy A` },
        finish: { value: itemA.finish, confidence: 'single_source', sources: { strategy_a: itemA.finish }, chosen_from: 'a', reason: `${itemCtx}: only found by Strategy A` },
        category: '',
        overall_confidence: 'single_source',
      })
    }

    // Unmatched B items (single source)
    for (let bi = 0; bi < setB.items.length; bi++) {
      if (bToA.has(bi)) continue
      const itemB = setB.items[bi]
      const itemCtx = `${setCtx} item '${itemB.name}'`
      auditLog.push(`${itemCtx}: only found by Vision model — single source`)

      reconciledItems.push({
        name: { value: itemB.name, confidence: 'single_source', sources: { strategy_b: itemB.name }, chosen_from: 'b', reason: `${itemCtx}: only found by Vision model` },
        qty: { value: itemB.qty, confidence: 'single_source', sources: { strategy_b: itemB.qty }, chosen_from: 'b', reason: `${itemCtx}: only found by Vision model` },
        manufacturer: { value: itemB.manufacturer, confidence: 'single_source', sources: { strategy_b: itemB.manufacturer }, chosen_from: 'b', reason: `${itemCtx}: only found by Vision model` },
        model: { value: itemB.model, confidence: 'single_source', sources: { strategy_b: itemB.model }, chosen_from: 'b', reason: `${itemCtx}: only found by Vision model` },
        finish: { value: itemB.finish, confidence: 'single_source', sources: { strategy_b: itemB.finish }, chosen_from: 'b', reason: `${itemCtx}: only found by Vision model` },
        category: itemB.category || '',
        overall_confidence: 'single_source',
      })
    }

    // Reconcile set-level fields
    const heading = reconcileField('heading', setA.heading, setB.heading, 'b', setCtx)
    const doorNumbers = reconcileDoorNumbers(setA, setB, setCtx, auditLog)
    const qtyConvention = reconcileField(
      'qty_convention',
      setA.qty_convention ?? 'unknown',
      setB.qty_convention,
      'a',
      setCtx,
    )
    const isPair = reconcileField(
      'is_pair',
      // Strategy A doesn't have is_pair directly; infer from heading_leaf_count
      setA.heading_leaf_count && setA.heading_leaf_count > 1 ? 'true' : 'false',
      String(setB.is_pair),
      'b',
      setCtx,
    )

    // Collect all field confidences for overall set confidence
    const allFieldConfidences: AgreementLevel[] = [
      heading.confidence,
      doorNumbers.confidence,
      qtyConvention.confidence,
      isPair.confidence,
      ...reconciledItems.flatMap(item => [
        item.name.confidence,
        item.qty.confidence,
        item.manufacturer.confidence,
        item.model.confidence,
        item.finish.confidence,
      ]),
    ]

    // Add audit entries for item reconciliations
    for (const item of reconciledItems) {
      if (item.overall_confidence === 'full') {
        auditLog.push(`${setCtx}: item '${item.name.value}' — full agreement across all fields`)
      } else if (item.overall_confidence === 'conflict') {
        const conflictFields = [
          item.name.confidence === 'conflict' ? 'name' : null,
          item.qty.confidence === 'conflict' ? 'qty' : null,
          item.manufacturer.confidence === 'conflict' ? 'manufacturer' : null,
          item.model.confidence === 'conflict' ? 'model' : null,
          item.finish.confidence === 'conflict' ? 'finish' : null,
        ].filter(Boolean)
        auditLog.push(`${setCtx}: item '${item.name.value}' — conflict in: ${conflictFields.join(', ')}`)
      }
    }

    reconciledSets.push({
      set_id: setA.set_id,
      heading,
      items: reconciledItems,
      door_numbers: doorNumbers,
      qty_convention: qtyConvention,
      is_pair: isPair,
      overall_confidence: worstAgreement(allFieldConfidences),
    })
  }

  // Step 3: Add unmatched Strategy A sets as single-source
  for (const setA of strategyA) {
    if (matchedA.has(setA.set_id)) continue
    auditLog.push(`Set ${setA.set_id}: only found by Strategy A — single source`)

    reconciledSets.push({
      set_id: setA.set_id,
      heading: singleSourceField(setA.heading, 'a', `Set ${setA.set_id} heading`),
      items: setA.items.map(item => singleSourceItem(item, 'a', `Set ${setA.set_id}`)),
      door_numbers: singleSourceField(
        (setA.heading_doors ?? []).join(', '),
        'a',
        `Set ${setA.set_id} door_numbers`,
      ),
      qty_convention: singleSourceField(setA.qty_convention ?? 'unknown', 'a', `Set ${setA.set_id} qty_convention`),
      is_pair: singleSourceField(
        setA.heading_leaf_count && setA.heading_leaf_count > 1 ? 'true' : 'false',
        'a',
        `Set ${setA.set_id} is_pair`,
      ),
      overall_confidence: 'single_source',
    })
  }

  // Add unmatched Strategy B sets as single-source
  for (const setB of strategyB.hardware_sets) {
    if (matchedB.has(setB.set_id)) continue
    auditLog.push(`Set ${setB.set_id}: only found by Vision model — single source`)

    reconciledSets.push({
      set_id: setB.set_id,
      heading: singleSourceField(setB.heading, 'b', `Set ${setB.set_id} heading`),
      items: setB.items.map(item => ({
        name: singleSourceField(item.name, 'b', `Set ${setB.set_id} item '${item.name}'`),
        qty: singleSourceField(item.qty, 'b', `Set ${setB.set_id} item '${item.name}' qty`),
        manufacturer: singleSourceField(item.manufacturer, 'b', `Set ${setB.set_id} item '${item.name}' manufacturer`),
        model: singleSourceField(item.model, 'b', `Set ${setB.set_id} item '${item.name}' model`),
        finish: singleSourceField(item.finish, 'b', `Set ${setB.set_id} item '${item.name}' finish`),
        category: item.category || '',
        overall_confidence: 'single_source' as AgreementLevel,
      })),
      door_numbers: singleSourceField(setB.door_numbers.join(', '), 'b', `Set ${setB.set_id} door_numbers`),
      qty_convention: singleSourceField(setB.qty_convention, 'b', `Set ${setB.set_id} qty_convention`),
      is_pair: singleSourceField(String(setB.is_pair), 'b', `Set ${setB.set_id} is_pair`),
      overall_confidence: 'single_source',
    })
  }

  // Step 4: Calculate summary statistics
  const allFields: AgreementLevel[] = []
  for (const set of reconciledSets) {
    allFields.push(set.heading.confidence, set.door_numbers.confidence, set.qty_convention.confidence, set.is_pair.confidence)
    for (const item of set.items) {
      allFields.push(item.name.confidence, item.qty.confidence, item.manufacturer.confidence, item.model.confidence, item.finish.confidence)
    }
  }

  const totalFields = allFields.length
  const fullCount = allFields.filter(l => l === 'full').length
  const conflictCount = allFields.filter(l => l === 'conflict').length
  const singleSourceCount = allFields.filter(l => l === 'single_source').length

  const fullAgreementPct = totalFields > 0 ? Math.round((fullCount / totalFields) * 100) : 0

  // Weighted average score: full=100, majority=75, single_source=50, conflict=25
  const scoreSum = allFields.reduce((sum, level) => sum + AGREEMENT_SCORE[level], 0)
  const score = totalFields > 0 ? Math.round(scoreSum / totalFields) : 0

  const totalItems = reconciledSets.reduce((sum, s) => sum + s.items.length, 0)

  const overallConfidence = worstAgreement(allFields)

  return {
    hardware_sets: reconciledSets,
    summary: {
      total_sets: reconciledSets.length,
      total_items: totalItems,
      full_agreement_pct: fullAgreementPct,
      conflicts: conflictCount,
      single_source_fields: singleSourceCount,
      overall_confidence: overallConfidence,
      score,
    },
    audit_log: auditLog,
  }
}

// ── Door number reconciliation ──────────────────────────────────

function reconcileDoorNumbers(
  setA: HardwareSet,
  setB: VisionHardwareSet,
  context: string,
  auditLog: string[],
): FieldReconciliation {
  const doorsA = new Set(setA.heading_doors ?? [])
  const doorsB = new Set(setB.door_numbers)

  // Union of both
  const union = new Set([...doorsA, ...doorsB])

  // Classify doors
  const onlyInA = [...doorsA].filter(d => !doorsB.has(d))
  const onlyInB = [...doorsB].filter(d => !doorsA.has(d))

  if (onlyInA.length > 0) {
    auditLog.push(`${context} doors: ${onlyInA.join(', ')} only in Strategy A`)
  }
  if (onlyInB.length > 0) {
    auditLog.push(`${context} doors: ${onlyInB.join(', ')} only in Vision model`)
  }

  const doorsAStr = [...doorsA].sort().join(', ')
  const doorsBStr = [...doorsB].sort().join(', ')
  const unionStr = [...union].sort().join(', ')

  const bothEmpty = doorsA.size === 0 && doorsB.size === 0

  if (bothEmpty) {
    return {
      value: '',
      confidence: 'single_source',
      sources: {},
      chosen_from: 'agreed',
      reason: `${context}: neither strategy found door numbers`,
    }
  }

  // Check exact agreement
  if (doorsAStr === doorsBStr) {
    return {
      value: unionStr,
      confidence: 'full',
      sources: { strategy_a: doorsAStr, strategy_b: doorsBStr },
      chosen_from: 'agreed',
      reason: `${context}: both strategies agree on door numbers`,
    }
  }

  // Partial overlap or one-sided
  if (doorsA.size === 0) {
    return {
      value: doorsBStr,
      confidence: 'single_source',
      sources: { strategy_b: doorsBStr },
      chosen_from: 'b',
      reason: `${context}: only Vision model had door numbers`,
    }
  }
  if (doorsB.size === 0) {
    return {
      value: doorsAStr,
      confidence: 'single_source',
      sources: { strategy_a: doorsAStr },
      chosen_from: 'a',
      reason: `${context}: only Strategy A had door numbers`,
    }
  }

  // Both have doors but differ — use union, flag as conflict
  auditLog.push(`${context}: door number conflict — using union of both strategies`)
  return {
    value: unionStr,
    confidence: 'conflict',
    sources: { strategy_a: doorsAStr, strategy_b: doorsBStr },
    chosen_from: 'merged',
    reason: `${context}: door number disagreement — using union (A: ${doorsAStr}, B: ${doorsBStr})`,
  }
}

// ── Single-source helpers ───────────────────────────────────────

function singleSourceField(
  value: string | number,
  from: 'a' | 'b',
  context: string,
): FieldReconciliation {
  const label = from === 'a' ? 'Strategy A' : 'Vision model'
  return {
    value,
    confidence: 'single_source',
    sources: from === 'a' ? { strategy_a: value } : { strategy_b: value },
    chosen_from: from,
    reason: `${context}: only found by ${label}`,
  }
}

function singleSourceItem(
  item: ExtractedHardwareItem,
  from: 'a' | 'b',
  setContext: string,
): ReconciledItem {
  const ctx = `${setContext} item '${item.name}'`
  return {
    name: singleSourceField(item.name, from, ctx),
    qty: singleSourceField(item.qty, from, ctx),
    manufacturer: singleSourceField(item.manufacturer, from, ctx),
    model: singleSourceField(item.model, from, ctx),
    finish: singleSourceField(item.finish, from, ctx),
    category: '',
    overall_confidence: 'single_source',
  }
}
