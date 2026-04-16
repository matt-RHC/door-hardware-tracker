/**
 * Shared helpers for the PDF extraction pipeline.
 * Canonical implementations extracted from chunk/route.ts (S-067 consolidation).
 */
import Anthropic from '@anthropic-ai/sdk'

/**
 * Construct an Anthropic client tuned for this app's workload.
 *
 *   - `maxRetries: 2` (SDK default). Higher values risk consuming the
 *     entire Vercel timeout budget on a single retryable call. If
 *     Anthropic is overloaded, 2 retries with exponential backoff is
 *     sufficient — beyond that the pipeline should fail fast.
 *   - `timeout: 290_000` ms keeps a stuck request from consuming the
 *     full 800s Vercel Fluid Compute window.
 *
 * Use this factory everywhere we'd otherwise call `new Anthropic(...)`
 * so the tuning stays consistent.
 */
export function createAnthropicClient(): Anthropic {
  return new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
    maxRetries: 2,       // SDK default. 4 was too aggressive — each retry can burn 290s.
    timeout: 290_000,
  })
}
import {
  getColumnMappingReviewPrompt,
  getPostExtractionReviewPrompt,
  getQuantityCheckPrompt,
  getDeepExtractionPrompt,
} from '@/lib/punchy-prompts'
import type {
  DoorEntry,
  ExtractedHardwareItem,
  HardwareSet,
  PageClassification,
  PdfplumberFlaggedDoor,
  PunchyColumnReview,
  PunchyCorrections,
  PunchyQuantityCheck,
} from '@/lib/types'
import type {
  ConfidenceLevel,
  FieldConfidence,
  ItemConfidence,
  ExtractionConfidence,
} from '@/lib/types/confidence'
import { extractJSON } from '@/lib/extractJSON'
import { TAXONOMY_REGEX_CACHE, classifyItem, scanElectricHinges, isAsymmetricHingeSplit, type InstallScope } from '@/lib/hardware-taxonomy'
import { createAdminSupabaseClient } from '@/lib/supabase/admin'

// --- Punchy observation logging (fire-and-forget) ---

/**
 * Log a Punchy checkpoint call to the `punchy_logs` table for observability.
 * Fire-and-forget — never awaited, never throws, never blocks the parse flow.
 */
function logPunchyCall(opts: {
  projectId?: string
  extractionRunId?: string
  checkpoint: 1 | 2 | 3
  inputSnapshot: Record<string, unknown>
  response: unknown
  parseOk: boolean
  inputTokens?: number
  outputTokens?: number
  latencyMs: number
}): void {
  try {
    const supabase = createAdminSupabaseClient()
    // `punchy_logs` was added by migration 014 (PR #135) but the generated
    // Database type in `src/lib/types/database.ts` has not been regenerated,
    // so the typed client rejects the insert. Cast through `any` until the
    // types can be regenerated against the live Supabase schema.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const insertPromise = (supabase.from('punchy_logs') as any)
      .insert({
        project_id: opts.projectId ?? null,
        extraction_run_id: opts.extractionRunId ?? null,
        checkpoint: opts.checkpoint,
        input_snapshot: opts.inputSnapshot,
        response: opts.response as Record<string, unknown>,
        parse_ok: opts.parseOk,
        input_tokens: opts.inputTokens ?? null,
        output_tokens: opts.outputTokens ?? null,
        latency_ms: opts.latencyMs,
      }) as Promise<{ error: { message: string } | null }>
    insertPromise
      .then(({ error }) => {
        if (error) console.warn('Punchy log insert failed:', error.message)
      })
      .catch((err: unknown) => {
        console.warn('Punchy log insert error:', err instanceof Error ? err.message : String(err))
      })
  } catch (err) {
    // createAdminSupabaseClient can fail if env vars are missing (e.g. in tests)
    console.warn('Punchy log skipped (no admin client):', err instanceof Error ? err.message : String(err))
  }
}

// --- Category classification for quantity normalization ---

/**
 * Classify a hardware item name into a taxonomy category.
 * Returns the install_scope for the matched category, or null if unrecognized.
 * Mirrors Python's _classify_hardware_item() at extract-tables.py:173.
 * Uses the shared TAXONOMY_REGEX_CACHE from hardware-taxonomy.ts.
 *
 * When `model` is provided, patterns are tested against `name + " " + model`
 * so identifiers like "CON TW8" in the model field are matched.
 */
export function classifyItemScope(name: string, model?: string): InstallScope | null {
  const text = model ? `${name} ${model}` : name
  for (const cat of TAXONOMY_REGEX_CACHE) {
    for (const rx of cat.patterns) {
      if (rx.test(text)) return cat.install_scope
    }
  }
  return null
}

/**
 * Terminal `qty_source` values that must NOT be re-normalized.
 *
 * Every normalization entry point (`normalizeQuantities` here, save/route.ts,
 * apply-revision/route.ts) must check this set before dividing a qty. Values
 * in this set represent a qty that is already per-opening / per-leaf / final
 * for one of these reasons:
 *
 *   - 'divided' / 'flagged' / 'capped' — produced by a prior normalization
 *     pass. Re-dividing would compound the division.
 *   - 'llm_override' — Punchy explicitly corrected the qty. Punchy's prompt
 *     at punchy-prompts.ts:187 tells it the values it sees are already
 *     per-opening, so its returned values are final.
 *   - 'auto_corrected' — PunchyReview.tsx auto-applied a Punchy correction.
 *     Same rationale as 'llm_override'.
 *   - 'deep_extract' / 'region_extract' — pulled from a targeted region of
 *     the PDF with Claude's vision model. Returned values are per-opening.
 *   - 'propagated' — apply-to-all copy of an already-normalized qty.
 *   - 'reverted' — user manually reverted an auto-correction. The user chose
 *     this exact value; do not silently change it.
 *   - 'manual_placeholder' — triage-time placeholder the user will edit.
 */
export const NEVER_RENORMALIZE: ReadonlySet<string> = new Set([
  'divided',
  'flagged',
  'capped',
  'llm_override',
  'auto_corrected',
  'deep_extract',
  'region_extract',
  'propagated',
  'reverted',
  'manual_placeholder',
])

/**
 * Leaf attribution values persisted on `hardware_items.leaf_side`.
 *
 * - 'active'   — active leaf only (lockset, exit device on most pairs)
 * - 'inactive' — inactive leaf only (flush bolts)
 * - 'shared'   — one per opening, not per leaf (coordinator, threshold,
 *   astragal, gaskets, thresholds)
 * - 'both'     — present on each leaf with its own row (hinges, closers
 *   when the user has split them per-leaf via the triage UI)
 *
 * `null` means "unset — fall back to render-time classification in
 * `classify-leaf-items.ts::groupItemsByLeaf`." See migration 013.
 */
export type LeafSide = 'active' | 'inactive' | 'shared' | 'both'

/**
 * Compute the unambiguous `leaf_side` for a hardware item at save time.
 *
 * Returns a definite value for structural rows (Door / Frame) and for
 * items whose taxonomy scope is per_pair or per_frame (those items only
 * ever exist once per opening regardless of leaf count). For per_leaf
 * and per_opening items on pair doors, the choice between 'active',
 * 'inactive', and 'both' depends on installation details we can't infer
 * from the name alone, so we return `null` and let render-time logic
 * handle it — users will eventually override via the triage UI.
 *
 * Exception: electric / conductor hinges on pair doors are always assigned
 * to the active leaf. They carry wiring between the frame and active leaf
 * and are never installed on the inactive leaf (DHI standard practice).
 *
 * Note: caller should pass `leafCount` from the opening row so we can
 * correctly handle single-leaf openings (where there's no inactive leaf
 * and a bare "Door" is implicitly active).
 */
export function computeLeafSide(
  itemName: string,
  leafCount: number,
  model?: string,
): LeafSide | null {
  // Structural items — fixed by name.
  if (itemName === 'Door (Active Leaf)') return 'active'
  if (itemName === 'Door (Inactive Leaf)') return 'inactive'
  if (itemName === 'Frame') return 'shared'
  // A bare 'Door' row exists only on single-leaf openings; the render
  // code routes it to leaf 1 which is the implicit active leaf.
  if (itemName === 'Door') return leafCount <= 1 ? 'active' : null

  // Hardware items — scope drives unambiguous attribution.
  const scope = classifyItemScope(itemName, model)
  if (scope === 'per_pair' || scope === 'per_frame') return 'shared'

  // per_leaf / per_opening / unknown on pair doors: ambiguous, defer.
  // NOTE: Electric hinges on pair doors are handled by buildPerOpeningItems()
  // (save path, stamps leaf_side='active') and groupItemsByLeaf() (preview
  // path, routes to active leaf). This function returns null to let those
  // callers decide — the electric hinge check that was here was dead code
  // because buildPerOpeningItems() always overwrites the result immediately.
  return null
}

// --- Shared types ---

export interface PdfplumberResult {
  success: boolean
  openings: DoorEntry[]
  hardware_sets: Array<{
    set_id: string
    generic_set_id?: string
    heading: string
    heading_door_count?: number
    heading_leaf_count?: number
    /** Specific door numbers listed under this sub-heading. Populated by
     *  api/extract-tables.py via extract_heading_door_numbers(). Used by
     *  the TS layer to route doors to specific sub-sets (DH4A.0 vs
     *  DH4A.1) instead of collapsing them by generic_set_id. */
    heading_doors?: string[]
    /** Quantity convention detected from preamble text by Python. */
    qty_convention?: 'per_opening' | 'aggregate' | 'unknown'
    items: Array<{
      qty: number
      qty_total?: number
      qty_door_count?: number
      qty_source?: string
      name: string
      manufacturer: string
      model: string
      finish: string
    }>
  }>
  reference_codes?: Array<{
    code_type: string
    code: string
    full_name: string
  }>
  flagged_doors?: PdfplumberFlaggedDoor[]
  expected_door_count: number
  tables_found: number
  hw_sets_found: number
  method: string
  error: string
  confidence?: string
  extraction_notes?: string[]
}

// --- Pipeline helpers ---

export async function callPdfplumber(
  base64: string,
  userColumnMapping?: Record<string, number> | null,
  requestOrigin?: string,
): Promise<PdfplumberResult> {
  // PYTHON_API_URL allows pointing to a standalone Python server in local dev.
  // requestOrigin (derived from new URL(request.url).origin in the route handler)
  // is used as the primary fallback so relative-path fetch errors never occur on
  // preview/production deployments where NEXT_PUBLIC_APP_URL is unset.
  // Use || not ?? for env vars: next.config.ts bakes unset vars as ""
  // (empty string), and "" ?? x returns "" because ?? only short-circuits
  // on null/undefined. || treats "" as falsy so the chain reaches
  // requestOrigin, which is always a valid absolute origin.
  const baseUrl = process.env.PYTHON_API_URL
    || (requestOrigin && requestOrigin !== 'null' ? requestOrigin : null)
    || process.env.NEXT_PUBLIC_APP_URL
    || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000')

  const payload: Record<string, unknown> = { pdf_base64: base64 }
  if (userColumnMapping) {
    payload.user_column_mapping = userColumnMapping
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 280_000)

  const internalToken = process.env.PYTHON_INTERNAL_SECRET ?? ''

  try {
    const response = await fetch(`${baseUrl}/api/extract-tables`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(internalToken ? { 'X-Internal-Token': internalToken } : {}),
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    })

    if (!response.ok) {
      const rawText = await response.text()
      console.error('[callPdfplumber] Non-OK response:', response.status, rawText.slice(0, 500))
      throw new Error(`Pdfplumber extraction failed: ${response.status} ${response.statusText}`)
    }

    return response.json()
  } catch (err: unknown) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new Error('Python endpoint timed out after 280s')
    }
    throw err
  } finally {
    clearTimeout(timeout)
  }
}

export async function callPunchyColumnReview(
  client: Anthropic,
  base64: string,
  columnMapping: Record<string, number> | null | undefined,
  opts?: { projectId?: string; extractionRunId?: string },
): Promise<PunchyColumnReview> {
  const systemPrompt = getColumnMappingReviewPrompt()

  const mappingSummary = columnMapping
    ? JSON.stringify(columnMapping, null, 2)
    : 'No column mapping provided (auto-detection will be used)'

  const startMs = Date.now()
  try {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 4096,
      system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'document',
              source: { type: 'base64', media_type: 'application/pdf', data: base64 },
              cache_control: { type: 'ephemeral' },
            },
            {
              type: 'text',
              text: `Here is the user's column mapping for the opening list table:\n\n${mappingSummary}\n\nReview the PDF and check if any expected fields are unmapped or incorrectly mapped. Return corrections as JSON.`,
            },
          ],
        },
      ],
    })
    const latencyMs = Date.now() - startMs

    const textBlock = response.content.find((b: { type: string }) => b.type === 'text')
    if (!textBlock || textBlock.type !== 'text') {
      logPunchyCall({
        projectId: opts?.projectId, extractionRunId: opts?.extractionRunId,
        checkpoint: 1, inputSnapshot: { columnMapping }, response: null,
        parseOk: false, inputTokens: response.usage?.input_tokens,
        outputTokens: response.usage?.output_tokens, latencyMs,
      })
      return { unmapped_fields: [], mapping_issues: [], notes: 'Punchy returned no text' }
    }

    const text = textBlock.text.trim()
    const parsed = extractJSON(text)

    logPunchyCall({
      projectId: opts?.projectId, extractionRunId: opts?.extractionRunId,
      checkpoint: 1, inputSnapshot: { columnMapping },
      response: parsed ?? { raw_text: text.substring(0, 2000) },
      parseOk: !!parsed, inputTokens: response.usage?.input_tokens,
      outputTokens: response.usage?.output_tokens, latencyMs,
    })

    if (!parsed) {
      console.warn('Punchy column review returned unparseable response:', text.substring(0, 300))
      return { unmapped_fields: [], mapping_issues: [], notes: 'Punchy returned unparseable response' }
    }

    return parsed as PunchyColumnReview
  } catch (err) {
    logPunchyCall({
      projectId: opts?.projectId, extractionRunId: opts?.extractionRunId,
      checkpoint: 1, inputSnapshot: { columnMapping }, response: { error: err instanceof Error ? err.message : String(err) },
      parseOk: false, latencyMs: Date.now() - startMs,
    })
    console.error('Punchy column review failed:', err instanceof Error ? err.message : String(err))
    return { unmapped_fields: [], mapping_issues: [], notes: `Punchy column review failed: ${err instanceof Error ? err.message : String(err)}` }
  }
}

// ── Representative door sampling for Punchy checkpoints ──────────────

/**
 * Select a representative subset of doors that maximises coverage for Punchy review.
 *
 * Strategy (in priority order):
 *   1. One door per unique hardware set — ensures every set gets reviewed.
 *   2. Prioritise pair doors (leaf_count > 1) since they are architecturally
 *      interesting and prone to quantity issues.
 *   3. Prioritise doors with the most hardware items (via set membership).
 *   4. Fill remaining slots from under-represented sets (sets with more total
 *      doors receive proportionally *less* extra representation).
 *
 * If the project has fewer doors than maxSample, all doors are returned.
 */
export function selectRepresentativeSample(
  doors: DoorEntry[],
  hardwareSets: HardwareSet[],
  maxSample: number = 15,
): DoorEntry[] {
  if (doors.length <= maxSample) return [...doors]

  // Build lookup: set_id → item count (for diversity scoring)
  const setItemCount = new Map<string, number>()
  for (const s of hardwareSets) {
    setItemCount.set(s.set_id, s.items?.length ?? 0)
  }

  // Group doors by hw_set
  const doorsBySet = new Map<string, DoorEntry[]>()
  for (const d of doors) {
    const key = d.hw_set ?? ''
    const arr = doorsBySet.get(key)
    if (arr) arr.push(d)
    else doorsBySet.set(key, [d])
  }

  const selected: DoorEntry[] = []
  const selectedIndices = new Set<number>()

  const addDoor = (d: DoorEntry): boolean => {
    const idx = doors.indexOf(d)
    if (selectedIndices.has(idx)) return false
    selectedIndices.add(idx)
    selected.push(d)
    return true
  }

  // Phase 1: one door per unique hardware set.
  // Prefer pair doors within each set, then doors with many items.
  for (const [, setDoors] of doorsBySet) {
    if (selected.length >= maxSample) break
    // Sort candidates: pair doors first, then by item count descending
    const sorted = [...setDoors].sort((a, b) => {
      const aPair = (a.leaf_count ?? 1) > 1 ? 1 : 0
      const bPair = (b.leaf_count ?? 1) > 1 ? 1 : 0
      if (bPair !== aPair) return bPair - aPair
      const aItems = setItemCount.get(a.hw_set ?? '') ?? 0
      const bItems = setItemCount.get(b.hw_set ?? '') ?? 0
      return bItems - aItems
    })
    addDoor(sorted[0])
  }

  if (selected.length >= maxSample) return selected

  // Phase 2: add pair doors not already selected
  const remaining = () => maxSample - selected.length
  const pairDoors = doors.filter(d => (d.leaf_count ?? 1) > 1 && !selectedIndices.has(doors.indexOf(d)))
  for (const d of pairDoors) {
    if (remaining() <= 0) break
    addDoor(d)
  }

  if (selected.length >= maxSample) return selected

  // Phase 3: doors with the most hardware items (via their set)
  const unselected = () => doors.filter((_, i) => !selectedIndices.has(i))
  const byItemCount = unselected().sort((a, b) => {
    return (setItemCount.get(b.hw_set ?? '') ?? 0) - (setItemCount.get(a.hw_set ?? '') ?? 0)
  })
  for (const d of byItemCount) {
    if (remaining() <= 0) break
    addDoor(d)
  }

  if (selected.length >= maxSample) return selected

  // Phase 4: fill from under-represented sets (sets with more doors get less extra)
  const setRepCount = new Map<string, number>()
  for (const d of selected) {
    const key = d.hw_set ?? ''
    setRepCount.set(key, (setRepCount.get(key) ?? 0) + 1)
  }
  // Score: lower is better (under-represented). Ratio = selected / total.
  const candidatesByUnderRep = unselected().sort((a, b) => {
    const aKey = a.hw_set ?? ''
    const bKey = b.hw_set ?? ''
    const aRatio = (setRepCount.get(aKey) ?? 0) / (doorsBySet.get(aKey)?.length ?? 1)
    const bRatio = (setRepCount.get(bKey) ?? 0) / (doorsBySet.get(bKey)?.length ?? 1)
    return aRatio - bRatio
  })
  for (const d of candidatesByUnderRep) {
    if (remaining() <= 0) break
    addDoor(d)
  }

  return selected
}

export async function callPunchyPostExtraction(
  client: Anthropic,
  base64: string,
  pdfplumberResult: PdfplumberResult,
  knownSetIds?: string[],
  opts?: {
    projectId?: string
    extractionRunId?: string
    goldenSample?: {
      set_id: string
      items: Array<{ qty: number; name: string; manufacturer?: string; model?: string; finish?: string }>
    }
  },
): Promise<PunchyCorrections> {
  const systemPrompt = getPostExtractionReviewPrompt(opts?.goldenSample)

  const allOpenings = pdfplumberResult?.openings ?? []
  const extractedSummary = JSON.stringify({
    hardware_sets: (pdfplumberResult?.hardware_sets ?? []).map(s => ({
      set_id: s.set_id,
      heading: s.heading,
      heading_door_count: s.heading_door_count ?? null,
      heading_leaf_count: s.heading_leaf_count ?? null,
      qty_convention: s.qty_convention ?? 'unknown',
      item_count: s.items?.length ?? 0,
      // Pass full annotation context to Punchy CP2 so it sees RAW PDF quantities.
      //
      // ARCHITECTURE NOTE (2026-04-13 overhaul):
      // Python no longer mutates item.qty. It sets:
      //   qty       = raw PDF value (unchanged)
      //   qty_total = same raw PDF value (explicitly preserved)
      //   qty_door_count = recommended divisor (how many doors/leaves Python thinks this total covers)
      //   qty_source = 'needs_division' | 'needs_cap' | 'needs_review' | 'rhr_lhr_pair' | 'parsed'
      //
      // Punchy CP2 runs HERE, BEFORE normalizeQuantities divides anything.
      // This means Punchy sees the raw totals from the PDF and can apply
      // domain expertise: "42 hinges for 6 pair doors (12 leaves) should be
      // 3-4 per leaf, not 7" — that's an insight Punchy can have but a
      // simple divider cannot. If Punchy changes a qty, it sets qty_source='llm_override',
      // which is in NEVER_RENORMALIZE and will not be divided again.
      items: (s.items ?? []).map(item => ({
        qty: item.qty,
        qty_total: item.qty_total ?? item.qty,  // raw PDF total (same as qty before division)
        qty_door_count: item.qty_door_count ?? null,  // Python's recommended divisor
        qty_source: item.qty_source ?? null,  // Python's annotation ('needs_division', etc.)
        name: item.name,
        manufacturer: item.manufacturer,
        model: item.model,
        finish: item.finish,
      })),
    })),
    // Compact full door list: every door_number + hw_set (~2KB for 200 doors)
    // so Punchy can detect missing doors and wrong assignments across the full project.
    all_doors: allOpenings.map(d => ({
      door_number: d.door_number,
      hw_set: d.hw_set,
      fire_rating: d.fire_rating ?? '',
    })),
    // Representative sample for detailed field review (up to 15, covering all sets)
    doors_sample: selectRepresentativeSample(
      allOpenings,
      (pdfplumberResult?.hardware_sets ?? []) as HardwareSet[],
    ),
    total_doors: allOpenings.length,
    known_set_ids: knownSetIds ?? [],
  }, null, 2)

  // Snapshot for logging (exclude full items to keep log rows reasonable)
  const inputSnapshot = {
    hw_sets_count: pdfplumberResult?.hardware_sets?.length ?? 0,
    doors_count: pdfplumberResult?.openings?.length ?? 0,
    known_set_ids: knownSetIds ?? [],
  }

  const startMs = Date.now()
  try {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 8192,
      system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'document',
              source: { type: 'base64', media_type: 'application/pdf', data: base64 },
              cache_control: { type: 'ephemeral' },
            },
            {
              type: 'text',
              text: `Here is the automated extraction result. Review it against the PDF and return corrections as JSON:\n\n${extractedSummary}`,
            },
          ],
        },
      ],
    })
    const latencyMs = Date.now() - startMs

    const textBlock = response.content.find((b: { type: string }) => b.type === 'text')
    if (!textBlock || textBlock.type !== 'text') {
      logPunchyCall({
        projectId: opts?.projectId, extractionRunId: opts?.extractionRunId,
        checkpoint: 2, inputSnapshot, response: null,
        parseOk: false, inputTokens: response.usage?.input_tokens,
        outputTokens: response.usage?.output_tokens, latencyMs,
      })
      return { notes: 'Punchy returned no text' }
    }

    const text = textBlock.text.trim()
    const parsed = extractJSON(text)

    logPunchyCall({
      projectId: opts?.projectId, extractionRunId: opts?.extractionRunId,
      checkpoint: 2, inputSnapshot,
      response: parsed ?? { raw_text: text.substring(0, 2000) },
      parseOk: !!parsed, inputTokens: response.usage?.input_tokens,
      outputTokens: response.usage?.output_tokens, latencyMs,
    })

    if (!parsed) {
      console.warn('Punchy post-extraction review returned unparseable response:', text.substring(0, 300))
      return { notes: 'Punchy returned unparseable response' }
    }

    return parsed as PunchyCorrections
  } catch (err) {
    logPunchyCall({
      projectId: opts?.projectId, extractionRunId: opts?.extractionRunId,
      checkpoint: 2, inputSnapshot, response: { error: err instanceof Error ? err.message : String(err) },
      parseOk: false, latencyMs: Date.now() - startMs,
    })
    console.error('Punchy post-extraction review failed:', err instanceof Error ? err.message : String(err))
    return { notes: `Punchy review failed: ${err instanceof Error ? err.message : String(err)}` }
  }
}

export async function callPunchyQuantityCheck(
  client: Anthropic,
  base64: string,
  hardwareSets: HardwareSet[],
  doors: DoorEntry[],
  goldenSample?: {
    set_id: string
    items: Array<{ qty: number; name: string; manufacturer?: string; model?: string; finish?: string }>
  } | null,
  opts?: { projectId?: string; extractionRunId?: string },
): Promise<PunchyQuantityCheck> {
  const systemPrompt = getQuantityCheckPrompt(goldenSample ?? undefined)

  const dataSummary = JSON.stringify({
    hardware_sets: hardwareSets.map(s => ({
      set_id: s.set_id,
      heading: s.heading,
      heading_door_count: s.heading_door_count,
      heading_leaf_count: s.heading_leaf_count,
      qty_convention: s.qty_convention ?? 'unknown',
      items: (s.items ?? []).map(i => ({
        name: i.name,
        qty: i.qty,
        qty_total: i.qty_total,
        qty_source: i.qty_source,
        manufacturer: i.manufacturer,
        model: i.model,
        finish: i.finish,
      })),
    })),
    doors: selectRepresentativeSample(doors, hardwareSets, 20).map(d => ({
      door_number: d.door_number,
      hw_set: d.hw_set,
      fire_rating: d.fire_rating,
      door_type: d.door_type,
      hand: d.hand,
      leaf_count: d.leaf_count ?? 1,
    })),
    // Compact full door list for pair-door compliance checks across all openings
    all_doors_compact: doors.map(d => ({
      door_number: d.door_number,
      hw_set: d.hw_set,
      fire_rating: d.fire_rating ?? '',
      leaf_count: d.leaf_count ?? 1,
    })),
    total_doors: doors.length,
  }, null, 2)

  // Snapshot for logging (summary, not full data)
  const inputSnapshot = {
    hw_sets_count: hardwareSets.length,
    total_doors: doors.length,
    has_golden_sample: !!goldenSample,
  }

  const startMs = Date.now()
  try {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 4096,
      system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'document',
              source: { type: 'base64', media_type: 'application/pdf', data: base64 },
              cache_control: { type: 'ephemeral' },
            },
            {
              type: 'text',
              text: `Review the normalized hardware quantities and door assignments. Return auto_corrections for high-confidence fixes, questions for ambiguous cases, and flags/compliance_issues for other observations:\n\n${dataSummary}`,
            },
          ],
        },
      ],
    })
    const latencyMs = Date.now() - startMs

    const textBlock = response.content.find((b: { type: string }) => b.type === 'text')
    if (!textBlock || textBlock.type !== 'text') {
      logPunchyCall({
        projectId: opts?.projectId, extractionRunId: opts?.extractionRunId,
        checkpoint: 3, inputSnapshot, response: null,
        parseOk: false, inputTokens: response.usage?.input_tokens,
        outputTokens: response.usage?.output_tokens, latencyMs,
      })
      return { flags: [], compliance_issues: [], notes: 'Punchy returned no text' }
    }

    const text = textBlock.text.trim()
    const parsed = extractJSON(text)

    logPunchyCall({
      projectId: opts?.projectId, extractionRunId: opts?.extractionRunId,
      checkpoint: 3, inputSnapshot,
      response: parsed ?? { raw_text: text.substring(0, 2000) },
      parseOk: !!parsed, inputTokens: response.usage?.input_tokens,
      outputTokens: response.usage?.output_tokens, latencyMs,
    })

    if (!parsed) {
      console.warn('Punchy quantity check returned unparseable response:', text.substring(0, 300))
      return { flags: [], compliance_issues: [], notes: 'Punchy returned unparseable response' }
    }

    // Ensure backward compat: default missing arrays
    const typed = parsed as PunchyQuantityCheck
    return {
      auto_corrections: typed.auto_corrections ?? [],
      questions: typed.questions ?? [],
      flags: typed.flags ?? [],
      compliance_issues: typed.compliance_issues ?? [],
      notes: typed.notes,
    }
  } catch (err) {
    logPunchyCall({
      projectId: opts?.projectId, extractionRunId: opts?.extractionRunId,
      checkpoint: 3, inputSnapshot, response: { error: err instanceof Error ? err.message : String(err) },
      parseOk: false, latencyMs: Date.now() - startMs,
    })
    console.error('Punchy quantity check failed:', err instanceof Error ? err.message : String(err))
    return { flags: [], compliance_issues: [], notes: `Punchy quantity check failed: ${err instanceof Error ? err.message : String(err)}` }
  }
}

// --- Deep Extraction: LLM-based item extraction for empty sets ---

export interface DeepExtractResult {
  set_id: string
  items: ExtractedHardwareItem[]
}

/**
 * Outcome of a deep-extraction call.
 *
 * - `ok: true` — the LLM responded successfully. `results` may still be an
 *   empty array if the model legitimately found no items.
 * - `ok: false` — the call failed (network, LLM error, parse error, empty
 *   response, etc.). `error` carries the reason so callers can surface it
 *   to the user instead of silently rendering "0 items".
 */
export type DeepExtractOutcome =
  | { ok: true; results: DeepExtractResult[] }
  | { ok: false; error: string }

// ── Vision extraction types (Strategy B) ──────────────────────────

export interface VisionHardwareSet {
  set_id: string
  heading: string
  items: Array<{
    name: string
    qty: number
    manufacturer: string
    model: string
    finish: string
    category: string
  }>
  door_numbers: string[]
  qty_convention: 'per_opening' | 'aggregate' | 'unknown'
  is_pair: boolean
  source_pages: number[]
}

export interface VisionExtractionResult {
  hardware_sets: VisionHardwareSet[]
  page_results: Array<{
    pageNumber: number
    page_type: string
    sets_found: number
    processing_time_ms: number
  }>
  total_processing_time_ms: number
  model_used: string
  pages_processed: number
  pages_skipped: number
}

export async function callDeepExtraction(
  client: Anthropic,
  base64: string,
  emptySets: Array<{ set_id: string; heading: string }>,
  goldenSample?: { set_id: string; items: ExtractedHardwareItem[] } | null,
  userHint?: string,
): Promise<DeepExtractOutcome> {
  const systemPrompt = getDeepExtractionPrompt(userHint)

  const setsDescription = emptySets
    .map(s => `- Set "${s.set_id}" (${s.heading || 'no heading'})`)
    .join('\n')

  // Build the user message — include golden sample as few-shot if available
  let userText = ''
  if (goldenSample && (goldenSample.items?.length ?? 0) > 0) {
    const sampleItems = (goldenSample.items ?? []).map(i => ({
      qty: i.qty, name: i.name, manufacturer: i.manufacturer, model: i.model, finish: i.finish,
    }))
    userText += `Here is a VERIFIED example from this same submittal. Set "${goldenSample.set_id}" was confirmed by the user:\n\n`
    userText += JSON.stringify(sampleItems, null, 2)
    userText += '\n\nUse the same format, level of detail, and naming conventions for the remaining sets.\n\n'
  }
  userText += `The following hardware sets were identified in this PDF but our automated reader could not extract their items. Please read the items directly from the PDF for each set:\n\n${setsDescription}\n\nReturn a JSON array of objects with set_id and items.`

  try {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 8192,
      system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'document',
              source: { type: 'base64', media_type: 'application/pdf', data: base64 },
              cache_control: { type: 'ephemeral' },
            },
            {
              type: 'text',
              text: userText,
            },
          ],
        },
      ],
    })

    const textBlock = response.content.find((b: { type: string }) => b.type === 'text')
    if (!textBlock || textBlock.type !== 'text') {
      console.error('Deep extraction returned no text content from LLM')
      return { ok: false, error: 'LLM response had no text content' }
    }

    const text = textBlock.text.trim()
    const parsed = extractJSON(text)
    if (!parsed) {
      console.error('Deep extraction JSON parse failed. Raw text:', text.slice(0, 500))
      return { ok: false, error: 'Could not parse LLM response as JSON' }
    }

    // Handle both array and { sets: [...] } response shapes
    const results: DeepExtractResult[] = Array.isArray(parsed)
      ? parsed
      : (parsed as { sets?: DeepExtractResult[] })?.sets ?? []

    // Normalize items: ensure qty is a number, default to 1
    for (const result of results) {
      for (const item of result.items ?? []) {
        if (typeof item.qty !== 'number' || item.qty < 1) item.qty = 1
        item.name = item.name ?? ''
        item.manufacturer = item.manufacturer ?? ''
        item.model = item.model ?? ''
        item.finish = item.finish ?? ''
        item.qty_source = 'deep_extract'
      }
    }

    // Log cache usage
    const usage = response.usage as unknown as Record<string, unknown>
    if (usage?.cache_creation_input_tokens || usage?.cache_read_input_tokens) {
      console.debug(
        `Deep extract cache: created=${usage.cache_creation_input_tokens ?? 0}, ` +
        `read=${usage.cache_read_input_tokens ?? 0}`
      )
    }

    console.debug(
      `Deep extraction: ${results.length} sets returned, ` +
      `${results.reduce((sum, r) => sum + (r.items?.length ?? 0), 0)} total items`
    )

    return { ok: true, results }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('Deep extraction failed:', message)
    return { ok: false, error: message }
  }
}

// ── Vision extraction (Strategy B) ──────────────────────────────

/** System prompt for page-by-page vision extraction. */
export const VISION_EXTRACTION_PROMPT = `You are analyzing a door hardware submittal PDF page. Extract ALL hardware information visible on this page.

For each hardware set visible:
- Set identifier (heading number, set number, or both)
- Hardware items with: name, quantity, manufacturer, model/catalog number, finish
- Door assignments: which door numbers are assigned to this set
- Whether quantities appear to be per-opening or aggregate totals

Hardware categories to recognize: hinges, locksets/cylindrical locks, exit devices, closers, door stops, kick plates, protection plates, thresholds, weatherstripping, smoke seals, flush bolts, coordinators, overhead stops, magnetic holders, electric strikes, electric hinges, electric latch retraction, card readers, keypads

Common manufacturer abbreviations: IVE/Ives, VD/Von Duprin, SCH/Schlage, LCN, SA/Sargent, MK/McKinney, RO/Rockwood, PE/Pemko, NGP, HAG/Hager

Return valid JSON matching this schema:
{
  "hardware_sets": [{
    "set_id": "string",
    "heading": "string",
    "items": [{
      "name": "string",
      "qty": number,
      "manufacturer": "string",
      "model": "string",
      "finish": "string",
      "category": "string"
    }],
    "door_numbers": ["string"],
    "qty_convention": "per_opening" | "aggregate" | "unknown",
    "is_pair": boolean
  }],
  "page_type": "schedule" | "opening_list" | "cut_sheet" | "cover" | "spec" | "other",
  "continuation": boolean
}

Rules:
- If a set continues from a previous page, set "continuation": true.
- If no hardware sets are visible (cut sheet, cover page, etc.), return an empty "hardware_sets" array.
- Expand manufacturer abbreviations to full names when you are confident (e.g., "IVE" → "Ives", "VD" → "Von Duprin").
- For quantity, report exactly what you see on the page. Do not divide or normalize.
- "category" should be one of: hinge, lockset, exit_device, closer, door_stop, kick_plate, protection_plate, threshold, weatherstripping, smoke_seal, flush_bolt, coordinator, overhead_stop, magnetic_holder, electric_strike, electric_hinge, elr, card_reader, keypad, other
- Return ONLY valid JSON — no prose, no markdown fences.`

/** Page types that should be sent to vision extraction. */
const VISION_SCHEDULE_PAGE_TYPES = new Set([
  'door_schedule',
  'hardware_set',
  'hardware_sets',
])

// Default: 3 minutes. Leaves budget for triage + staging after vision completes.
const VISION_WALL_CLOCK_LIMIT_MS = 180_000

/**
 * Send PDF pages to Claude's vision model for structured hardware extraction.
 *
 * Pages are processed in batches of `batchSize` (default 5) to stay within
 * token limits while providing enough cross-page context for multi-page sets.
 * Uses the Anthropic SDK's native PDF document support — no image conversion needed.
 */

export async function callVisionExtraction(
  client: Anthropic,
  pdfBase64: string,
  pageNumbers: number[],
  context: {
    projectId?: string
    knownSetIds?: string[]
    expectedFormat?: string
  },
  batchSize = 5,
  wallClockLimitMs = VISION_WALL_CLOCK_LIMIT_MS,
): Promise<VisionExtractionResult> {
  const MODEL = 'claude-sonnet-4-20250514'
  const allSets: VisionHardwareSet[] = []
  const pageResults: VisionExtractionResult['page_results'] = []
  const totalStart = Date.now()
  let pagesProcessed = 0

  // Split page numbers into batches
  const batches: number[][] = []
  for (let i = 0; i < pageNumbers.length; i += batchSize) {
    batches.push(pageNumbers.slice(i, i + batchSize))
  }

  for (const batch of batches) {
    // Wall-clock guard: stop sending new batches if we've exceeded the time budget.
    // Already-completed batches are kept — we return partial results.
    const elapsed = Date.now() - totalStart
    if (elapsed > wallClockLimitMs) {
      const skippedPages = batches.slice(batches.indexOf(batch)).flat()
      console.warn(
        `[vision-extract] Wall-clock limit reached (${Math.round(elapsed / 1000)}s > ${Math.round(wallClockLimitMs / 1000)}s). ` +
        `Skipping ${skippedPages.length} remaining pages: ${skippedPages.join(', ')}`,
      )
      // Record skipped pages in results
      for (const p of skippedPages) {
        pageResults.push({
          pageNumber: p,
          page_type: 'skipped_timeout',
          sets_found: 0,
          processing_time_ms: 0,
        })
      }
      break
    }

    const batchStart = Date.now()

    let contextHint = ''
    if (context.knownSetIds && context.knownSetIds.length > 0) {
      contextHint += `\n\nKnown set IDs from prior extraction: ${context.knownSetIds.join(', ')}. Validate your findings against these.`
    }
    if (context.expectedFormat) {
      contextHint += `\nExpected document format: ${context.expectedFormat}.`
    }

    const userText = `Extract all hardware information from pages ${batch.join(', ')} of this document.${contextHint}\n\nReturn a single JSON object with the combined results from all pages in this batch.`

    try {
      const response = await client.messages.create({
        model: MODEL,
        max_tokens: 8192,
        system: [
          { type: 'text', text: VISION_EXTRACTION_PROMPT, cache_control: { type: 'ephemeral' } },
        ],
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'document',
                source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 },
                cache_control: { type: 'ephemeral' },
              },
              { type: 'text', text: userText },
            ],
          },
        ],
      })

      const textBlock = response.content.find((b: { type: string }) => b.type === 'text')
      if (!textBlock || textBlock.type !== 'text') {
        console.warn(`[vision-extract] Batch pages ${batch.join(',')}: no text response`)
        for (const p of batch) {
          pageResults.push({ pageNumber: p, page_type: 'other', sets_found: 0, processing_time_ms: 0 })
        }
        continue
      }

      const parsed = extractJSON(textBlock.text.trim())
      if (!parsed || typeof parsed !== 'object') {
        console.warn(`[vision-extract] Batch pages ${batch.join(',')}: JSON parse failed`)
        for (const p of batch) {
          pageResults.push({ pageNumber: p, page_type: 'other', sets_found: 0, processing_time_ms: 0 })
        }
        continue
      }

      const batchResult = parsed as {
        hardware_sets?: Array<{
          set_id?: string
          heading?: string
          items?: Array<{
            name?: string
            qty?: number
            manufacturer?: string
            model?: string
            finish?: string
            category?: string
          }>
          door_numbers?: string[]
          qty_convention?: string
          is_pair?: boolean
        }>
        page_type?: string
        continuation?: boolean
      }

      const batchMs = Date.now() - batchStart
      const batchSets = batchResult.hardware_sets ?? []

      for (const rawSet of batchSets) {
        if (!rawSet.set_id) continue

        const items = (rawSet.items ?? []).map(item => ({
          name: item.name ?? '',
          qty: typeof item.qty === 'number' && item.qty >= 1 ? item.qty : 1,
          manufacturer: item.manufacturer ?? '',
          model: item.model ?? '',
          finish: item.finish ?? '',
          category: item.category ?? 'other',
        }))

        const qtyConvention = rawSet.qty_convention === 'per_opening' || rawSet.qty_convention === 'aggregate'
          ? rawSet.qty_convention
          : 'unknown' as const

        // Check if this set already exists (continuation from prior batch)
        const existing = allSets.find(s => s.set_id === rawSet.set_id)
        if (existing && batchResult.continuation) {
          // Merge items — deduplicate by name+model
          for (const newItem of items) {
            const dup = (existing.items ?? []).find(
              e => e.name === newItem.name && e.model === newItem.model,
            )
            if (!dup) { if (!existing.items) existing.items = []; existing.items.push(newItem) }
          }
          // Merge door numbers
          for (const dn of rawSet.door_numbers ?? []) {
            if (!existing.door_numbers.includes(dn)) existing.door_numbers.push(dn)
          }
          // Merge source pages
          for (const p of batch) {
            if (!existing.source_pages.includes(p)) existing.source_pages.push(p)
          }
        } else {
          allSets.push({
            set_id: rawSet.set_id,
            heading: rawSet.heading ?? '',
            items,
            door_numbers: rawSet.door_numbers ?? [],
            qty_convention: qtyConvention,
            is_pair: rawSet.is_pair ?? false,
            source_pages: [...batch],
          })
        }
      }

      // Record per-page results
      for (const p of batch) {
        pageResults.push({
          pageNumber: p,
          page_type: batchResult.page_type ?? 'schedule',
          sets_found: batchSets.length,
          processing_time_ms: Math.round(batchMs / batch.length),
        })
      }

      pagesProcessed += batch.length

      // Log cache usage
      const usage = response.usage as unknown as Record<string, unknown>
      if (usage?.cache_creation_input_tokens || usage?.cache_read_input_tokens) {
        console.debug(
          `[vision-extract] Batch pages ${batch.join(',')}: cache created=${usage.cache_creation_input_tokens ?? 0}, ` +
          `read=${usage.cache_read_input_tokens ?? 0}`,
        )
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[vision-extract] Batch pages ${batch.join(',')}: LLM error: ${msg}`)
      for (const p of batch) {
        pageResults.push({ pageNumber: p, page_type: 'other', sets_found: 0, processing_time_ms: 0 })
      }
    }
  }

  const pagesSkipped = pageResults.filter(r => r.page_type === 'skipped_timeout').length
  return {
    hardware_sets: allSets,
    page_results: pageResults,
    total_processing_time_ms: Date.now() - totalStart,
    model_used: MODEL,
    pages_processed: pagesProcessed,
    pages_skipped: pagesSkipped,
  }
}

/**
 * Filter page classifications to only include schedule/hardware set pages
 * suitable for vision extraction. Skips cut sheets, covers, specs, etc.
 */
export function filterSchedulePages(
  pages: PageClassification[],
): { schedulePages: number[]; skippedPages: number[] } {
  const schedulePages: number[] = []
  const skippedPages: number[] = []

  for (const page of pages) {
    if (VISION_SCHEDULE_PAGE_TYPES.has(page.page_type)) {
      schedulePages.push(page.page_number)
    } else {
      skippedPages.push(page.page_number)
    }
  }

  return { schedulePages, skippedPages }
}

/** Hardware category keywords used to prevent cross-category fuzzy matches. */
const HARDWARE_CATEGORY_KEYWORDS = [
  'hinge', 'closer', 'lockset', 'exit', 'stop', 'seal',
  'threshold', 'kick', 'flush', 'coordinator', 'bolt',
] as const

/**
 * Extract the hardware category keyword from a name, if any.
 * Returns the first matching category keyword found, or undefined.
 */
function extractCategory(name: string): string | undefined {
  const lower = (name ?? '').toLowerCase()
  return HARDWARE_CATEGORY_KEYWORDS.find(kw => lower.includes(kw))
}

/**
 * Normalize a hardware item name for comparison: lowercase, strip trailing
 * dimension/spec patterns, collapse whitespace, remove trailing punctuation.
 */
export function normalizeName(name: string): string {
  let s = (name ?? '').toLowerCase()
  // Strip parenthesized finish codes like (US26D), (689), (SP28)
  s = s.replace(/\s*\([^)]*\)\s*/g, ' ')
  // Strip trailing dimension patterns: digits with quotes/fractions e.g. 83", 4-1/2" x 4-1/2"
  s = s.replace(/[,\s]+[\d][\d\-/]*"?(\s*x\s*[\d][\d\-/]*"?)*\s*$/i, '')
  // Strip trailing model numbers: sequences of uppercase+digits at end (after lowering)
  // e.g. "exit device 99eo us26d" → strip "99eo us26d"
  s = s.replace(/(\s+[a-z]*\d[a-z0-9]*)+\s*$/i, '')
  // Strip trailing commas, periods, quotes, whitespace
  s = s.replace(/[,."'\s]+$/, '')
  // Collapse multiple spaces
  s = s.replace(/\s+/g, ' ').trim()
  return s
}

/**
 * Compute Jaccard similarity on word tokens between two strings.
 * Returns a value in [0, 1].
 */
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

/**
 * Name matcher used when applying Punchy corrections to extracted items.
 *
 * Matching tiers (first hit wins):
 *   1. Exact string match
 *   2. Case-insensitive match
 *   3. Normalized match (strip punctuation, trailing specs/dimensions)
 *   4. Substring/contains match (min 8 chars, with category guard)
 *   5. Best-match Jaccard scoring across all items
 *
 * Cross-category matches are blocked: if both names contain a hardware
 * category keyword (hinge, closer, lockset, etc.), they must be the same.
 */
export function findItemFuzzy(
  items: ExtractedHardwareItem[],
  name: string,
  context: string,
): ExtractedHardwareItem | undefined {
  // 1. Exact match
  const exact = items.find(i => i.name === name)
  if (exact) {
    console.debug(`Punchy correction match (exact): "${name}" [${context}]`)
    return exact
  }

  // 2. Case-insensitive match
  const lower = (name ?? '').toLowerCase()
  const ci = items.find(i => (i.name ?? '').toLowerCase() === lower)
  if (ci) {
    console.debug(`Punchy correction fuzzy match (case): "${name}" → "${ci.name}" [${context}]`)
    return ci
  }

  // Category guard: prevents matching across different hardware types
  const nameCategory = extractCategory(name)
  function categoryCompatible(itemName: string): boolean {
    const itemCategory = extractCategory(itemName)
    // If both have a category keyword, they must match
    if (nameCategory && itemCategory) return nameCategory === itemCategory
    return true
  }

  // 3. Normalized match
  const normName = normalizeName(name)
  const normMatches = items.filter(i =>
    categoryCompatible(i.name) && normalizeName(i.name) === normName,
  )
  if (normMatches.length === 1) {
    console.debug(`Punchy correction fuzzy match (normalized): "${name}" → "${normMatches[0].name}" [${context}]`)
    return normMatches[0]
  }
  if (normMatches.length > 1) {
    // Multiple normalized matches — pick best Jaccard score
    const scored = normMatches.map(i => ({ item: i, score: tokenJaccard(name, i.name) }))
    scored.sort((a, b) => b.score - a.score)
    if (scored[0].score > scored[1].score) {
      console.debug(`Punchy correction fuzzy match (normalized+scored): "${name}" → "${scored[0].item.name}" [${context}]`)
      return scored[0].item
    }
    console.warn(`Punchy correction ambiguous normalized match for "${name}" (${scored.length} tied candidates) [${context}]`)
    return undefined
  }

  // 4. Substring/contains match (min 8 chars, and shorter string must be
  //    ≥50% of the longer to avoid "Hinge" matching "Heavy-Duty Hinge")
  const MIN_SUBSTRING_LEN = 8
  if (name.length >= MIN_SUBSTRING_LEN) {
    const substringMatches = items.filter(i => {
      if (!categoryCompatible(i.name)) return false
      const iLower = (i.name ?? '').toLowerCase()
      const isSubstring = iLower.includes(lower) || lower.includes(iLower)
      if (!isSubstring) return false
      // Length ratio guard: the shorter string must be at least 50% of the longer
      const shorter = Math.min(lower.length, iLower.length)
      const longer = Math.max(lower.length, iLower.length)
      return shorter / longer >= 0.5
    })
    if (substringMatches.length === 1) {
      console.debug(`Punchy correction fuzzy match (substring): "${name}" → "${substringMatches[0].name}" [${context}]`)
      return substringMatches[0]
    }
    if (substringMatches.length > 1) {
      // Pick best Jaccard score among substring matches
      const scored = substringMatches.map(i => ({ item: i, score: tokenJaccard(name, i.name) }))
      scored.sort((a, b) => b.score - a.score)
      if (scored[0].score > scored[1].score) {
        console.debug(`Punchy correction fuzzy match (substring+scored): "${name}" → "${scored[0].item.name}" [${context}]`)
        return scored[0].item
      }
      console.warn(`Punchy correction ambiguous substring match for "${name}" (${scored.length} tied candidates) [${context}]`)
      return undefined
    }
  }

  // 5. Best-match Jaccard scoring — last resort
  const JACCARD_THRESHOLD = 0.5
  const allScored = items
    .filter(i => categoryCompatible(i.name))
    .map(i => ({ item: i, score: tokenJaccard(name, i.name) }))
    .filter(s => s.score > JACCARD_THRESHOLD)
  allScored.sort((a, b) => b.score - a.score)
  if (allScored.length >= 2 && allScored[0].score === allScored[1].score) {
    console.warn(`Punchy correction ambiguous Jaccard match for "${name}" (${allScored.length} tied candidates) [${context}]`)
    return undefined
  }
  if (allScored.length >= 1) {
    console.debug(`Punchy correction fuzzy match (jaccard=${allScored[0].score.toFixed(2)}): "${name}" → "${allScored[0].item.name}" [${context}]`)
    return allScored[0].item
  }

  console.warn(`Punchy correction could not match item "${name}" [${context}]`)
  return undefined
}

/**
 * Resolve a Punchy-supplied set_id to the concrete `HardwareSet` objects it
 * should apply to.
 *
 *   - Prefer an exact `set_id` hit (one target).
 *   - Otherwise treat the id as a `generic_set_id` and apply to every
 *     sub-variant (e.g., Punchy says "DH4A" when the extraction has
 *     "DH4A.0" and "DH4A.1").
 *   - Empty result → correction is dropped and we log a warning so the
 *     miss is observable.
 */
function resolveSetsForCorrection(
  hardwareSets: HardwareSet[],
  correctionSetId: string,
  context: string,
): HardwareSet[] {
  const exact = hardwareSets.find(s => s.set_id === correctionSetId)
  if (exact) return [exact]

  const byGeneric = hardwareSets.filter(s => s.generic_set_id === correctionSetId)
  if (byGeneric.length > 0) {
    console.debug(
      `Punchy correction resolved via generic_set_id: "${correctionSetId}" → ${byGeneric
        .map(s => s.set_id)
        .join(', ')} [${context}]`,
    )
    return byGeneric
  }

  console.warn(`Punchy correction could not match set_id "${correctionSetId}" [${context}]`)
  return []
}

export function applyCorrections(
  hardwareSets: HardwareSet[],
  doors: DoorEntry[],
  corrections: PunchyCorrections
): { hardwareSets: HardwareSet[]; doors: DoorEntry[] } {
  // Apply hardware set corrections
  if (corrections.hardware_sets_corrections) {
    for (const corr of corrections.hardware_sets_corrections) {
      const targets = resolveSetsForCorrection(hardwareSets, corr.set_id, 'hw_sets_corrections')
      if (targets.length === 0) continue

      for (const set of targets) {
        if (corr.heading) set.heading = corr.heading

        // Remove items (exact + case-insensitive only, never substring)
        if (corr.items_to_remove) {
          const removeLower = new Set(corr.items_to_remove.map(n => (n ?? '').toLowerCase()))
          set.items = (set.items ?? []).filter(
            item => !removeLower.has((item.name ?? '').toLowerCase()),
          )
        }

        // Fix items (exact + case-insensitive)
        if (corr.items_to_fix) {
          for (const fix of corr.items_to_fix) {
            const item = findItemFuzzy(
              set.items ?? [],
              fix.name,
              `set ${set.set_id} fix ${fix.field}`,
            )
            if (item && fix.field in item) {
              const val = fix.new_value
              if (fix.field === 'qty') {
                const parsed = parseInt(val, 10)
                if (Number.isNaN(parsed) || parsed < 0) {
                  console.warn(`[punchy] Skipping invalid qty value "${val}" for item "${fix.name}" in set ${set.set_id}`)
                  continue
                }
                (item as any)[fix.field] = parsed || 1
                // Mark as llm_override so downstream normalization (NEVER_RENORMALIZE)
                // preserves Punchy's correction — Punchy sees per-opening values and
                // returns per-opening values; re-dividing would clobber the fix.
                ;(item as any).qty_source = 'llm_override'
              } else {
                (item as any)[fix.field] = val
              }
            }
          }
        }

        // Add missing items (exact + case-insensitive duplicate check)
        if (corr.items_to_add) {
          for (const newItem of corr.items_to_add) {
            const existing = findItemFuzzy(
              set.items ?? [],
              newItem.name,
              `set ${set.set_id} add`,
            )
            if (!existing) {
              if (!set.items) set.items = []
              // Mark Punchy-injected items as llm_override so the save route's
              // normalizeQuantities safety net doesn't re-divide a qty that
              // Punchy deliberately set. Mirrors items_to_fix handling above.
              set.items.push({ ...newItem, qty_source: 'llm_override' })
            }
          }
        }
      }
    }
  }

  // Add missing sets — also check generic_set_id to avoid duplicating a set
  // when Punchy suggests the generic ID (e.g., "DH4A") while we already have
  // its sub-headings (DH4A.0, DH4A.1) extracted.
  if (corrections.missing_sets) {
    for (const newSet of corrections.missing_sets) {
      const alreadyPresent = hardwareSets.some(
        s => s.set_id === newSet.set_id
          || s.generic_set_id === newSet.set_id
          || (newSet.generic_set_id !== undefined
            && (s.set_id === newSet.generic_set_id
              || s.generic_set_id === newSet.generic_set_id)),
      )
      if (!alreadyPresent) {
        // Forward heading metadata so downstream normalization can divide
        // quantities correctly. Previously all three fields were dropped,
        // which put normalizeQuantities in the "leafCount<=1 && doorCount<=1"
        // skip path — silently bypassing the per-leaf division safety net.
        hardwareSets.push({
          set_id: newSet.set_id,
          generic_set_id: newSet.generic_set_id,
          heading: newSet.heading,
          heading_door_count: newSet.heading_door_count ?? 0,
          heading_leaf_count: newSet.heading_leaf_count ?? 0,
          qty_convention: newSet.qty_convention,
          heading_doors: [],
          // Use the item's explicit qty_source if Punchy set one (e.g. 'llm_override'
          // when Punchy has already verified the qty as per-opening), otherwise
          // fall back to 'parsed' so normalizeQuantities PATH 5 can divide these
          // items by the heading counts we just forwarded above.
          //
          // WHY NOT 'llm_override' by default (changed 2026-04-13):
          // Punchy CP2 sees RAW PDF totals and uses missing_sets to inject sets
          // it found in the PDF but pdfplumber missed. Those raw PDF totals need
          // division just like any other set's items. Blanket-marking them
          // 'llm_override' was blocking the normalizeQuantities PATH 5 division
          // for every Punchy-discovered set. Now only items where Punchy
          // explicitly sets qty_source='llm_override' are protected.
          items: (newSet.items ?? []).map(item => ({
            ...item,
            qty_source: (item as any).qty_source ?? 'parsed',
          })),
        })
      }
    }
  }

  // Apply door corrections.
  //
  // Match by normalized door_number (uppercase + whitespace-collapsed) so
  // Punchy's raw-PDF door numbers (e.g. "110 02A") match our canonical
  // storage form ("11002A"). Exact-string matching used to silently drop
  // every correction where formatting drifted between pdfplumber's extraction
  // and the PDF text Punchy reads.
  if (corrections.doors_corrections) {
    for (const corr of corrections.doors_corrections) {
      const target = normalizeDoorNumber(corr.door_number)
      const door = doors.find(d => normalizeDoorNumber(d.door_number) === target)
      if (!door) {
        console.warn(
          `Punchy doors_corrections could not match door_number "${corr.door_number}"`,
        )
        continue
      }
      if (corr.field in door) {
        (door as any)[corr.field] = corr.new_value
      }
    }
  }

  // Add missing doors (also normalized — same rationale as above).
  if (corrections.missing_doors) {
    for (const newDoor of corrections.missing_doors) {
      const target = normalizeDoorNumber(newDoor.door_number)
      if (!doors.some(d => normalizeDoorNumber(d.door_number) === target)) {
        doors.push(newDoor)
      }
    }
  }

  return { hardwareSets, doors }
}

/**
 * THE SINGLE AUTHORITATIVE QTY DIVISION PASS.
 *
 * ─── ARCHITECTURE (2026-04-13 overhaul) ─────────────────────────────────────
 *
 * Before this overhaul, Python's normalize_quantities() mutated item.qty
 * in place, and this TS function ran again afterwards as a "safety net".
 * That produced several compounding bugs (see PR fix/qty-normalization-pipeline-overhaul
 * and the diagnosis in the PR description for the full evidence chain):
 *
 *   1. Catalog-number item names ('5BB1 HW 4 1/2 x 4 1/2 NRP') aren't
 *      classified by either Python's or TS's pattern matchers, so they
 *      defaulted to the wrong divisor silently.
 *
 *   2. Punchy CP2 received already-divided values but was told they were
 *      raw PDF values. Its domain expertise was effectively disabled because
 *      it couldn't distinguish a faithful extraction from an approximation.
 *
 *   3. Non-integer division was silently rounded and frozen by NEVER_RENORMALIZE,
 *      with no way for the user to see that the value was estimated.
 *
 *   4. The TS function ran a THIRD time in save/route.ts as another
 *      "safety net", compounding the confusion further.
 *
 * NEW CONTRACT:
 *
 *   Python's job (extract-tables.py normalize_quantities):
 *     - Determine the correct divisor (leaf_count or door_count)
 *     - Record it in qty_door_count
 *     - Set qty_source='needs_division' (or 'needs_cap', 'needs_review', etc.)
 *     - Leave item.qty UNCHANGED (raw PDF value)
 *     - Always set qty_total = raw PDF value
 *
 *   This function's job (runs ONCE, after Punchy CP2):
 *     - Read Python's annotations ('needs_division', 'needs_cap', etc.)
 *     - Perform the actual division using Python's recommended divisor
 *     - Fall back to TS taxonomy when Python couldn't classify the item
 *     - Set qty_source to 'divided', 'flagged', or 'capped' after acting
 *     - NEVER touch items whose qty_source is in NEVER_RENORMALIZE
 *
 *   Punchy CP2's job (runs before this function, sees raw PDF qtys):
 *     - Review the raw PDF quantities against the PDF itself
 *     - Apply domain expertise: "42 hinges for 6 pair doors is ~3-4 per leaf"
 *     - Correct obvious extraction errors (wrong set IDs, missing items, etc.)
 *     - Set qty_source='llm_override' when it changes a qty
 *     - Items with llm_override are in NEVER_RENORMALIZE and will not be
 *       re-divided here
 *
 * ─── CALL SITES ──────────────────────────────────────────────────────────────
 *
 *   chunk/route.ts  : called ONCE, after applyCorrections (Punchy CP2 output)
 *   parse-pdf/route.ts: same, once after applyCorrections
 *   save/route.ts   : NOT called — removed in this overhaul. The save route
 *                     receives data from the wizard client which already went
 *                     through the chunk pipeline. Calling it again there was
 *                     the third redundant pass.
 *
 * ─── DIVISION STRATEGY ───────────────────────────────────────────────────────
 *
 *   1. If Python annotated needs_division: trust Python's qty_door_count as
 *      the divisor. Python has better context (heading block counts, fallback
 *      lookup chains) than TS does at this point.
 *
 *   2. If Python set needs_cap: apply the category max as a cap (single-door
 *      set where qty is implausibly high — likely an aggregate with no count).
 *
 *   3. If Python set needs_review or rhr_lhr_pair: apply RHR/LHR rule or
 *      leave for Punchy CP3 and the user.
 *
 *   4. If qty_source is 'parsed' or unset (Python couldn't classify):
 *      fall through to TS taxonomy-based division as a best-effort.
 *      This handles items that arrived from Punchy CP2 additions or sets
 *      that Python didn't see (e.g., empty sets filled by deep_extract).
 *
 * ─── TAXONOMY SCOPE → DIVISOR MAPPING ───────────────────────────────────────
 *
 *   per_leaf    → divide by leafCount (hinges go on each leaf)
 *   per_opening → divide by doorCount (closer = 1 per opening, not per leaf)
 *   per_pair    → never divide (coordinator = 1 per pair regardless)
 *   per_frame   → never divide (seal = 1 per frame regardless)
 *   null/unknown → try leafCount, then doorCount (conservative fallback)
 *
 * ─── ELECTRIC HINGE SCOPE NOTE ───────────────────────────────────────────────
 *
 *   Electric/conductor hinges (CON TW8, ETH, EPT) are classified as
 *   'per_opening' in hardware-taxonomy.ts and DIVISION_PREFERENCE='opening'
 *   in Python. This means they are divided by door_count, not leaf_count.
 *
 *   On pair doors, buildPerOpeningItems() (Phase 4) routes electric hinges
 *   to the active leaf only (leaf_side='active') and splits standard hinges
 *   into per-leaf rows: active gets consolidated qty, inactive gets the
 *   original (unconsolidated) qty. This produces the correct DHI layout:
 *     Active:   3 standard + 1 electric = 4 hinge positions
 *     Inactive: 4 standard + 0 electric = 4 hinge positions
 */
export function normalizeQuantities(
  hardwareSets: HardwareSet[],
  doors: DoorEntry[],
): void {
  // Build door-count lookup from opening list (fallback when heading counts are 0)
  const doorsPerSet = new Map<string, number>()
  const leavesPerSet = new Map<string, number>()
  for (const door of doors) {
    if (door.hw_set) {
      const key = door.hw_set.toUpperCase()
      doorsPerSet.set(key, (doorsPerSet.get(key) ?? 0) + 1)
      leavesPerSet.set(key, (leavesPerSet.get(key) ?? 0) + ((door.leaf_count ?? 1)))
    }
  }

  // Pre-compute generic set totals for sub-heading re-division.
  // When multiple sub-headings (DH3.0, DH3.1) share a generic_set_id (DH3),
  // item qtys may be set-level totals. After dividing by the sub-heading count
  // we check if the result is implausibly high and try the generic total.
  const genericTotals = new Map<string, { doors: number; leaves: number }>()
  for (const set of hardwareSets) {
    const gid = (set.generic_set_id ?? set.set_id).toUpperCase()
    const prev = genericTotals.get(gid) ?? { doors: 0, leaves: 0 }
    genericTotals.set(gid, {
      doors: prev.doors + (set.heading_door_count ?? 0),
      leaves: prev.leaves + (set.heading_leaf_count ?? 0),
    })
  }
  // Fill from opening list when heading counts are 0
  for (const [gid, totals] of genericTotals) {
    if (totals.doors === 0) {
      const olDoors = doorsPerSet.get(gid) ?? 0
      const olLeaves = leavesPerSet.get(gid) ?? 0
      if (olDoors > 0) genericTotals.set(gid, { doors: olDoors, leaves: olLeaves || olDoors })
    }
  }

  // Per-scope category max (used for post-division sanity on sub-headings)
  const MAX_QTY: Record<string, number> = {
    per_leaf: 5, per_opening: 2, per_pair: 1, per_frame: 1,
  }

  for (const set of hardwareSets) {
    // Resolve leaf and door counts for this set.
    // heading_leaf_count and heading_door_count come from Python's heading
    // block parsing (most accurate). Fall back to opening list if unavailable.
    const leafCount = (set.heading_leaf_count ?? 0) > 1 ? (set.heading_leaf_count ?? 0) : 0
    const doorCount = (set.heading_door_count ?? 0) > 1
      ? (set.heading_door_count ?? 0)
      : (doorsPerSet.get((set.generic_set_id ?? set.set_id).toUpperCase()) ?? 0)

    const gid = (set.generic_set_id ?? set.set_id).toUpperCase()
    const genericTotal = genericTotals.get(gid) ?? { doors: 0, leaves: 0 }
    const isSubHeading = (
      set.generic_set_id != null
      && set.generic_set_id !== set.set_id
      && genericTotal.doors > doorCount
    )

    console.debug(
      `[qty-norm] set=${set.set_id} generic=${set.generic_set_id ?? '?'} ` +
      `headingDoors=${set.heading_door_count ?? 0} headingLeaves=${set.heading_leaf_count ?? 0} ` +
      `resolvedLeaves=${leafCount} resolvedDoors=${doorCount}` +
      (isSubHeading ? ` sub-heading(generic=${genericTotal.doors}d/${genericTotal.leaves}l)` : '')
    )

    // Pre-compute electric hinge presence in this set. Used in PATH 1 and
    // PATH 5 to detect asymmetric hinge splits on pair doors: when standard
    // hinges don't divide evenly by leafCount, the remainder is often
    // explained by electric hinges replacing one standard position on the
    // active leaf.
    const { totalElectricQty: setElectricHingeQty } = scanElectricHinges(set.items ?? [], leafCount >= 2)

    for (const item of set.items ?? []) {
      // ── GUARD: terminal states are never re-normalized ──────────────────────
      // See NEVER_RENORMALIZE definition above for the full list and rationale.
      // The key invariant: any qty that was explicitly set by Punchy, the user,
      // or a prior authoritative division must not be changed here.
      if (NEVER_RENORMALIZE.has(item.qty_source ?? '')) {
        continue
      }

      // ── PATH 1: Python annotated this item with a recommended divisor ───────
      //
      // Python's normalize_quantities() determined the divisor from the heading
      // block (most accurate source) and recorded it in qty_door_count without
      // mutating item.qty. We trust that divisor and perform the division here.
      //
      // This path handles both cleanly-divisible and non-integer cases. For
      // non-integer results we round and mark 'flagged' so Punchy CP3 and the
      // UI both surface it for user review. We do NOT silently discard the
      // fractional part as was done previously.
      //
      // ELECTRIC HINGE OVERRIDE: Python doesn't know the item's install scope,
      // so it may set qty_door_count to leafCount for all items in a set.
      // Electric hinges are per_opening (1 per opening, not per leaf), so when
      // the Python divisor looks like leafCount (> doorCount on a pair set), we
      // override it to use doorCount. This prevents electric hinge qtys from
      // being incorrectly divided by leafCount (e.g. 4 ÷ 8 = 0.5 flagged
      // instead of the correct 4 ÷ 4 = 1 divided).
      if (item.qty_source === 'needs_division' && item.qty_door_count != null && item.qty_door_count > 1) {
        const raw = item.qty_total ?? item.qty  // qty_total = raw PDF value (set by Python)
        let divisor = item.qty_door_count

        // Electric hinges: per_opening scope — override leafCount divisor to doorCount.
        if (classifyItem(item.name, undefined, item.model) === 'electric_hinge' && doorCount > 0 && divisor > doorCount) {
          console.debug(
            `[qty-norm] ${set.set_id}: "${item.name}" electric hinge — ` +
            `overriding python divisor ${divisor} → doorCount ${doorCount} (per_opening)`
          )
          divisor = doorCount
          item.qty_door_count = doorCount
        }

        const result = raw / divisor
        item.qty_total = raw
        if (Number.isInteger(result)) {
          item.qty = result
          item.qty_source = 'divided'
          console.debug(
            `[qty-norm] ${set.set_id}: "${item.name}" ${raw} ÷ ${divisor} = ${result} (python-annotated)`
          )
        } else if (
          classifyItem(item.name, undefined, item.model) === 'hinges'
          && isAsymmetricHingeSplit(raw, setElectricHingeQty, divisor)
        ) {
          // Asymmetric hinge split (python-annotated path): the standard hinge
          // total doesn't divide cleanly because electric hinges create an
          // asymmetric per-leaf split. Use ceil to get the larger-leaf count.
          item.qty = Math.ceil(result)
          item.qty_source = 'divided'
          console.debug(
            `[qty-norm] ${set.set_id}: "${item.name}" asymmetric hinge split (python) — ` +
            `${raw} standard + ${setElectricHingeQty} electric = ${raw + setElectricHingeQty} total ÷ ` +
            `${divisor} = ${item.qty} per leaf (electric accounts for asymmetry)`
          )
        } else {
          // Non-integer: round and flag for user review.
          // Do NOT silently accept a rounded value without flagging it.
          item.qty = Math.round(result)
          item.qty_source = 'flagged'
          console.warn(
            `[qty-norm] ${set.set_id}: "${item.name}" ${raw} ÷ ${divisor} = ${result.toFixed(2)} ` +
            `→ rounded to ${item.qty} (flagged for review — non-integer per-leaf/per-opening)`
          )
        }
        continue
      }

      // ── PATH 2: Python flagged a single-door set with an implausibly high qty ─
      //
      // 'needs_cap' means door_count was <= 1 but qty exceeded the category max,
      // suggesting this is an aggregate total from a PDF with no door count.
      // We cap it at the category max and mark it so the user sees it was capped.
      if (item.qty_source === 'needs_cap') {
        const scope = classifyItemScope(item.name, item.model)
        const maxQty = MAX_QTY[scope ?? 'per_leaf'] ?? 5
        item.qty_total = item.qty
        item.qty = Math.min(item.qty, maxQty)
        item.qty_source = 'capped'
        console.warn(
          `[qty-norm] ${set.set_id}: "${item.name}" qty ${item.qty_total} capped to ${item.qty} ` +
          `(no door count, category max=${maxQty})`
        )
        continue
      }

      // ── PATH 3: RHR/LHR variant pair ────────────────────────────────────────
      //
      // Python detected both a RH and LH variant of the same item in this set.
      // Each door gets exactly ONE variant based on its hand, so qty=1 per variant.
      // We set qty=1 here. Punchy CP3 will see this and can question if wrong.
      if (item.qty_source === 'rhr_lhr_pair') {
        item.qty_total = item.qty
        item.qty = 1
        item.qty_source = 'divided'
        console.debug(
          `[qty-norm] ${set.set_id}: "${item.name}" RHR/LHR pair → qty=1 per variant`
        )
        continue
      }

      // ── PATH 4: needs_review (auto-operator + closer conflict) ───────────────
      //
      // Leave qty unchanged but mark as 'flagged' so Punchy CP3 and the UI
      // surface it. We don't attempt division because the conflict itself is
      // the signal — a closer alongside an auto-operator may be redundant.
      if (item.qty_source === 'needs_review') {
        item.qty_source = 'flagged'
        continue
      }

      // ── PATH 5: TS taxonomy fallback (qty_source='parsed' or unset) ──────────
      //
      // Python marked this item 'parsed' meaning either:
      //   a) Python thinks qty is already per-opening (smaller than divisor)
      //   b) Python couldn't determine a divisor (unclassified item name)
      //   c) This item was added by Punchy CP2 and has no Python annotation
      //
      // We attempt TS taxonomy-based division as a best-effort. This path uses
      // the same NEVER_RENORMALIZE guard but does NOT rely on Python's divisor.
      // Because Python's classification failed, we must use TS scope + counts.
      //
      // KEY DIFFERENCE FROM OLD CODE: we no longer have the 'qty <= maxPerOpening'
      // early-exit guard that silently skipped items with small qtys. That guard
      // prevented re-division of already-normalized items but also prevented
      // correct classification of legitimately small aggregates. Instead, we
      // rely on the invariant that Python already set qty_total correctly, so
      // if qty_total == qty (Python didn't divide), we know this is still raw.
      if (leafCount <= 1 && doorCount <= 1) {
        // No counts available — nothing to divide by, leave as-is.
        continue
      }

      const scope = classifyItemScope(item.name, item.model)

      // per_pair / per_frame: never divide regardless of count
      if (scope === 'per_pair' || scope === 'per_frame') {
        continue
      }

      // per_opening: divide by doorCount only.
      // A closer is 1 per opening. It is NOT 1 per leaf. Dividing by leafCount
      // for a closer on a pair door would incorrectly yield 0.5.
      //
      // Use >= (not >) because: if qty == doorCount, that's exactly the case
      // we want to catch (e.g. 2 closers for 2 doors → 1 per opening). The
      // integer check handles under-division naturally (1 closer / 2 doors = 0.5
      // → not integer → skipped without mutation).
      if (scope === 'per_opening') {
        if (doorCount > 1 && item.qty >= doorCount) {
          const perOpening = item.qty / doorCount
          if (Number.isInteger(perOpening)) {
            item.qty_total = item.qty
            item.qty_door_count = doorCount
            item.qty = perOpening
            item.qty_source = 'divided'
          }
          // Non-integer: don't round. Leave for Punchy CP3 to assess.
        }
        continue
      }

      // per_leaf: divide by leafCount (preferred) or doorCount (fallback).
      // Use Math.round for non-integer results and flag for review.
      //
      // ASYMMETRIC HINGE SPLIT: When a set contains both standard and electric
      // hinges on pair doors, the standard hinge total is often odd because
      // the electric hinge replaces one standard position on the active leaf.
      // Example: 8 total hinge positions on a pair → 4 per leaf. Electric takes
      // 1 position on active → 7 standard total (3 active + 4 inactive).
      // Dividing 7/2 = 3.5 is non-integer, but the count IS correct. We detect
      // this by checking if (standardQty + electricQty) divides cleanly — if so,
      // the asymmetry is explained and we use ceil() to get the larger-leaf qty
      // (which is what the consolidation step and buildPerOpeningItems expect).
      if (scope === 'per_leaf') {
        if (leafCount > 1 && item.qty >= leafCount) {
          const perLeaf = item.qty / leafCount
          item.qty_total = item.qty
          item.qty_door_count = leafCount
          if (Number.isInteger(perLeaf)) {
            item.qty = perLeaf
            item.qty_source = 'divided'
          } else if (
            classifyItem(item.name, undefined, item.model) === 'hinges'
            && isAsymmetricHingeSplit(item.qty, setElectricHingeQty, leafCount)
          ) {
            // Asymmetric hinge split: the non-integer division is explained by
            // electric hinges. Use ceil to get the larger-leaf (inactive) count.
            // The consolidation step will subtract the electric qty for the
            // active leaf, and buildPerOpeningItems will reconstitute per-leaf.
            item.qty = Math.ceil(perLeaf)
            item.qty_source = 'divided'
            console.debug(
              `[qty-norm] ${set.set_id}: "${item.name}" asymmetric hinge split — ` +
              `${item.qty_total} standard + ${setElectricHingeQty} electric = ` +
              `${(item.qty_total ?? 0) + setElectricHingeQty} total ÷ ${leafCount} leaves = ` +
              `${item.qty} per leaf (electric accounts for asymmetry)`
            )
          } else {
            item.qty = Math.round(perLeaf)
            item.qty_source = 'flagged'
          }
        } else if (doorCount > 1 && item.qty >= doorCount) {
          const perOpening = item.qty / doorCount
          if (Number.isInteger(perOpening)) {
            item.qty_total = item.qty
            item.qty_door_count = doorCount
            item.qty = perOpening
            item.qty_source = 'divided'
          }
        }
        continue
      }

      // Unknown scope: conservative fallback. Try leafCount, then doorCount.
      // This handles catalog-number names (e.g. '5BB1 HW...') that neither
      // Python nor TS can classify. Both patterns require a clean integer result
      // to avoid silently introducing rounded approximations.
      if (leafCount > 1 && item.qty >= leafCount) {
        const perLeaf = item.qty / leafCount
        if (Number.isInteger(perLeaf)) {
          item.qty_total = item.qty
          item.qty_door_count = leafCount
          item.qty = perLeaf
          item.qty_source = 'divided'
          continue
        }
      }
      if (doorCount > 1 && doorCount !== leafCount && item.qty >= doorCount) {
        const perOpening = item.qty / doorCount
        if (Number.isInteger(perOpening)) {
          item.qty_total = item.qty
          item.qty_door_count = doorCount
          item.qty = perOpening
          item.qty_source = 'divided'
        }
      }
      // If neither divided cleanly, leave qty as-is (raw PDF value).
      // Punchy CP3 will see the raw value and can flag or correct it.
    }

    // ── Post-division sub-heading sanity ───────────────────────────────────────
    //
    // If this set is a sub-heading (e.g. DH3.0 within generic DH3) and a
    // divided qty still exceeds the category max, the item was likely a
    // set-level total that should have been divided by the generic total
    // instead of the sub-heading count. Try the generic total as a corrective.
    //
    // We only do this AFTER all items have been divided (hence separate loop)
    // and only for items that are 'divided' or 'flagged' (i.e., we already
    // acted on them).
    if (isSubHeading) {
      for (const item of set.items ?? []) {
        if (item.qty_source !== 'divided' && item.qty_source !== 'flagged') continue
        const scope = classifyItemScope(item.name, item.model)
        const maxQty = MAX_QTY[scope ?? 'per_opening'] ?? 4
        if (item.qty <= maxQty) continue

        const raw = item.qty_total ?? item.qty
        const altDivisor = scope === 'per_leaf' && genericTotal.leaves > 1
          ? genericTotal.leaves
          : genericTotal.doors

        if (altDivisor > 1) {
          const altPerUnit = raw / altDivisor
          if (Number.isInteger(altPerUnit) && altPerUnit <= maxQty) {
            console.debug(
              `[qty-norm] ${set.set_id}: "${item.name}" re-divided by generic: ` +
              `${raw} ÷ ${altDivisor} = ${altPerUnit} (sub-heading gave ${item.qty}, max=${maxQty})`
            )
            item.qty = altPerUnit
            item.qty_door_count = altDivisor
            item.qty_source = 'divided'
          } else {
            const rounded = Math.round(raw / altDivisor)
            if (rounded <= maxQty) {
              console.debug(
                `[qty-norm] ${set.set_id}: "${item.name}" re-divided (rounded) by generic: ` +
                `${raw} ÷ ${altDivisor} ≈ ${rounded} (sub-heading gave ${item.qty}, max=${maxQty})`
              )
              item.qty = rounded
              item.qty_door_count = altDivisor
              item.qty_source = 'flagged'
            }
          }
        }
      }
    }

    // NOTE: Hinge consolidation (subtracting electric hinge qty from standard
    // hinges) was removed here. The per-leaf adjustment now happens exclusively
    // in groupItemsByLeaf() (wizard preview) and buildPerOpeningItems() (save
    // path), which have leaf-level context to correctly assign:
    //   Active leaf:   standard_per_leaf − electric_qty
    //   Inactive leaf: standard_per_leaf (unchanged)
    // Doing it here caused a double subtraction because downstream also adjusts.
  }
}

// --- Extraction confidence scoring ---

const CONFIDENCE_RANK: Record<ConfidenceLevel, number> = {
  high: 3,
  medium: 2,
  low: 1,
  unverified: 0,
}

function worstConfidence(levels: ConfidenceLevel[]): ConfidenceLevel {
  if (levels.length === 0) return 'unverified'
  let worst: ConfidenceLevel = 'high'
  for (const l of levels) {
    if (CONFIDENCE_RANK[l] < CONFIDENCE_RANK[worst]) worst = l
  }
  return worst
}

/** Expected hardware categories for a "complete" set. */
const EXPECTED_SET_CATEGORIES = ['hinge', 'lockset', 'closer']

function itemHasCategory(name: string, category: string): boolean {
  return (name ?? '').toLowerCase().includes(category)
}

/**
 * Score a single field's confidence based on whether it's populated and
 * whether the item was corrected by Punchy.
 */
function scoreItemFieldConfidence(
  value: string,
  fieldName: string,
  qtySource: string | undefined,
  correctedFields: Set<string>,
  fuzzyCorrectedFields: Set<string>,
): FieldConfidence {
  // Quantity field uses qty_source as the primary signal
  if (fieldName === 'qty') {
    if (qtySource === 'llm_override' || qtySource === 'auto_corrected') {
      return { level: 'medium', reason: 'Punchy corrected this quantity' }
    }
    if (qtySource === 'deep_extract' || qtySource === 'region_extract') {
      return { level: 'medium', reason: 'Extracted via Claude vision from PDF region' }
    }
    if (qtySource === 'flagged') {
      return { level: 'low', reason: 'Division produced non-integer result (rounded)' }
    }
    if (qtySource === 'manual_placeholder') {
      return { level: 'low', reason: 'Placeholder quantity — needs user input' }
    }
    return { level: 'high', reason: 'Quantity extracted cleanly from PDF' }
  }

  // Other fields: check correction status first
  if (fuzzyCorrectedFields.has(fieldName)) {
    return { level: 'medium', reason: 'Punchy corrected via fuzzy match' }
  }
  if (correctedFields.has(fieldName)) {
    return { level: 'medium', reason: 'Punchy corrected this value' }
  }

  // Empty field
  if (!value || value.trim() === '') {
    return { level: 'low', reason: `Empty ${fieldName} — not extracted from PDF` }
  }

  return { level: 'high', reason: 'Extracted cleanly from PDF' }
}

/**
 * Calculate field-level and extraction-level confidence after the full
 * pipeline (extraction + Punchy review + normalization) completes.
 *
 * This function is designed to be lightweight (<50ms) — no LLM calls,
 * no PDF re-reading, just analysis of the data already in memory.
 */
export function calculateExtractionConfidence(
  hardwareSets: HardwareSet[],
  doors: DoorEntry[],
  corrections: PunchyCorrections,
): ExtractionConfidence {
  const signals: string[] = []
  const itemConfidenceMap: Record<string, ItemConfidence> = {}
  const deepExtractionReasons: string[] = []

  // ── Build correction tracking maps ──
  // Track which set+item+field combinations were corrected by Punchy
  const correctedItemFields = new Map<string, Set<string>>()
  const fuzzyCorrectedItemFields = new Map<string, Set<string>>()

  if (corrections.hardware_sets_corrections) {
    for (const corr of corrections.hardware_sets_corrections) {
      if (corr.items_to_fix) {
        for (const fix of corr.items_to_fix) {
          const key = `${corr.set_id}:${fix.name}`
          if (!correctedItemFields.has(key)) correctedItemFields.set(key, new Set())
          correctedItemFields.get(key)!.add(fix.field)
          // Low-confidence Punchy corrections (fuzzy match tier 3+)
          if (fix.confidence === 'low' || fix.confidence === 'medium') {
            if (!fuzzyCorrectedItemFields.has(key)) fuzzyCorrectedItemFields.set(key, new Set())
            fuzzyCorrectedItemFields.get(key)!.add(fix.field)
          }
        }
      }
    }
  }

  // Count total corrections and fuzzy corrections
  let totalCorrections = 0
  let fuzzyCorrections = 0
  if (corrections.hardware_sets_corrections) {
    for (const corr of corrections.hardware_sets_corrections) {
      totalCorrections += (corr.items_to_fix?.length ?? 0)
        + (corr.items_to_add?.length ?? 0)
        + (corr.items_to_remove?.length ?? 0)
      if (corr.items_to_fix) {
        for (const fix of corr.items_to_fix) {
          if (fix.confidence === 'low' || fix.confidence === 'medium') {
            fuzzyCorrections++
          }
        }
      }
    }
  }

  // ── Score each item ──
  let totalItems = 0
  let emptyMfrModelCount = 0
  let emptyFieldItems = 0

  for (const set of hardwareSets) {
    for (const item of set.items) {
      totalItems++
      const key = `${set.set_id}:${item.name}`
      const corrFields = correctedItemFields.get(key) ?? new Set<string>()
      const fuzzyCorrFields = fuzzyCorrectedItemFields.get(key) ?? new Set<string>()

      const nameConf = scoreItemFieldConfidence(item.name, 'name', item.qty_source, corrFields, fuzzyCorrFields)
      const qtyConf = scoreItemFieldConfidence(String(item.qty), 'qty', item.qty_source, corrFields, fuzzyCorrFields)
      const mfrConf = scoreItemFieldConfidence(item.manufacturer, 'manufacturer', item.qty_source, corrFields, fuzzyCorrFields)
      const modelConf = scoreItemFieldConfidence(item.model, 'model', item.qty_source, corrFields, fuzzyCorrFields)
      const finishConf = scoreItemFieldConfidence(item.finish, 'finish', item.qty_source, corrFields, fuzzyCorrFields)

      const overall = worstConfidence([
        nameConf.level,
        qtyConf.level,
        mfrConf.level,
        modelConf.level,
        finishConf.level,
      ])

      const itemConf: ItemConfidence = {
        name: nameConf,
        qty: qtyConf,
        manufacturer: mfrConf,
        model: modelConf,
        finish: finishConf,
        overall,
      }

      itemConfidenceMap[key] = itemConf
      item.confidence = itemConf

      // Track empty field stats
      if (!item.manufacturer?.trim() && !item.model?.trim()) {
        emptyMfrModelCount++
      }
      if (!item.manufacturer?.trim() || !item.model?.trim() || !item.finish?.trim()) {
        emptyFieldItems++
      }
    }

    // ── Per-set signals ──
    if ((set.items ?? []).length === 0) {
      signals.push(`Set ${set.set_id} has zero hardware items`)
    }

    // Check for expected categories
    const setCategories = new Set<string>()
    for (const item of set.items) {
      const lower = (item.name ?? '').toLowerCase()
      for (const cat of EXPECTED_SET_CATEGORIES) {
        if (lower.includes(cat)) setCategories.add(cat)
      }
    }
    if ((set.items ?? []).length > 0 && setCategories.size === EXPECTED_SET_CATEGORIES.length) {
      signals.push(`Set ${set.set_id} has expected categories (hinges, lockset, closer)`)
    }
  }

  // ── Door-level signals ──
  const definedSetIds = new Set<string>()
  for (const set of hardwareSets) {
    definedSetIds.add(set.set_id)
    if (set.generic_set_id) definedSetIds.add(set.generic_set_id)
  }

  let validDoorNumbers = 0
  let doorsWithoutSets = 0
  for (const door of doors) {
    if (door.door_number && door.door_number.trim()) {
      validDoorNumbers++
    }
    if (door.hw_set && !definedSetIds.has(door.hw_set)) {
      doorsWithoutSets++
    }
  }

  if (doors.length > 0 && validDoorNumbers === doors.length) {
    signals.push('All doors have valid door numbers')
  }
  if (doorsWithoutSets > 0) {
    signals.push(`${doorsWithoutSets} door(s) assigned to undefined hardware sets`)
  }

  // ── Punchy correction signals ──
  if (totalCorrections === 0) {
    signals.push('Punchy reviewed and made no corrections')
  } else {
    signals.push(`Punchy made ${totalCorrections} correction(s)`)
  }
  if (fuzzyCorrections > 0) {
    signals.push(`${fuzzyCorrections} correction(s) used fuzzy matching`)
  }

  // ── Quantity convention signals ──
  let preambleConventionSets = 0
  let statisticalConventionSets = 0
  for (const set of hardwareSets) {
    if (set.qty_convention === 'per_opening' || set.qty_convention === 'aggregate') {
      preambleConventionSets++
    } else {
      statisticalConventionSets++
    }
  }
  if (preambleConventionSets > 0 && statisticalConventionSets === 0) {
    signals.push('All quantity conventions detected via preamble')
  }
  if (statisticalConventionSets > 0) {
    signals.push(`${statisticalConventionSets} set(s) used statistical quantity convention fallback`)
  }

  // ── Critical signals: auto-fallback triggers ──
  if (totalItems > 0 && emptyMfrModelCount / totalItems > 0.3) {
    deepExtractionReasons.push(
      `${Math.round((emptyMfrModelCount / totalItems) * 100)}% of items have empty manufacturer + model (threshold: 30%)`
    )
  }
  if (totalCorrections > 0 && fuzzyCorrections / totalCorrections > 0.5) {
    deepExtractionReasons.push(
      `${Math.round((fuzzyCorrections / totalCorrections) * 100)}% of Punchy corrections used fuzzy matching (threshold: 50%)`
    )
  }

  // Punchy flagged >20% of items (items_to_fix + items_to_add as proxy for "flagged")
  const punchyFlaggedCount = totalCorrections
  if (totalItems > 0 && punchyFlaggedCount / totalItems > 0.2) {
    deepExtractionReasons.push(
      `Punchy flagged ${Math.round((punchyFlaggedCount / totalItems) * 100)}% of items (threshold: 20%)`
    )
  }

  // ── Compute overall score (0-100) ──
  let score = 100

  // Negative: empty fields
  if (totalItems > 0) {
    const emptyFieldRatio = emptyFieldItems / totalItems
    score -= Math.round(emptyFieldRatio * 30) // up to -30 for all items having empty fields
  }

  // Negative: Punchy corrections
  if (totalItems > 0) {
    const correctionRatio = totalCorrections / totalItems
    score -= Math.min(20, Math.round(correctionRatio * 20)) // up to -20
  }

  // Negative: fuzzy corrections
  if (totalCorrections > 0) {
    const fuzzyRatio = fuzzyCorrections / totalCorrections
    score -= Math.min(10, Math.round(fuzzyRatio * 10)) // up to -10
  }

  // Negative: statistical qty convention fallback
  if (hardwareSets.length > 0) {
    const statRatio = statisticalConventionSets / hardwareSets.length
    score -= Math.round(statRatio * 10) // up to -10
  }

  // Negative: doors without matching sets
  if (doors.length > 0) {
    const unmatchedRatio = doorsWithoutSets / doors.length
    score -= Math.round(unmatchedRatio * 15) // up to -15
  }

  // Negative: empty sets
  const emptySets = hardwareSets.filter(s => (s.items ?? []).length === 0).length
  if (hardwareSets.length > 0) {
    score -= Math.round((emptySets / hardwareSets.length) * 15) // up to -15
  }

  // Positive: Punchy made no corrections
  if (totalCorrections === 0) {
    score = Math.min(100, score + 5)
  }

  score = Math.max(0, Math.min(100, score))

  // ── Derive overall confidence level from score ──
  let overall: ConfidenceLevel
  if (score >= 80) overall = 'high'
  else if (score >= 50) overall = 'medium'
  else overall = 'low'

  // Override to low if any critical signal triggered
  if (deepExtractionReasons.length > 0) {
    overall = 'low'
  }

  return {
    overall,
    score,
    signals,
    item_confidence: itemConfidenceMap,
    suggest_deep_extraction: deepExtractionReasons.length > 0,
    deep_extraction_reasons: deepExtractionReasons,
  }
}

// --- Save-path validation helpers ---

/**
 * Build the set of all hardware-set IDs that a door's `hw_set` field may
 * legitimately match against. Includes BOTH the specific `set_id` (e.g.,
 * "DH4A.0") AND the `generic_set_id` (e.g., "DH4A") for every set, so
 * that doors whose opening-list entry references the generic parent id
 * still match when the set is stored under a specific sub-heading id.
 *
 * Used by the save-path validation in StepConfirm and in the
 * `/api/parse-pdf/save` route. Previously the client-side validation
 * only used `set.set_id`, which blocked the Save button for any project
 * whose opening list references the parent id of a multi-heading set
 * (the exact Radius DC DH4A case from 2026-04-11).
 */
export function buildDefinedSetIds(hardwareSets: HardwareSet[]): Set<string> {
  const ids = new Set<string>()
  for (const set of hardwareSets) {
    if (set.set_id) ids.add(set.set_id)
    if (set.generic_set_id && set.generic_set_id !== set.set_id) {
      ids.add(set.generic_set_id)
    }
  }
  return ids
}

/**
 * Return the subset of doors whose `hw_set` references a hardware set
 * that doesn't exist in `definedSetIds`. This is the save-blocking
 * validation used by StepConfirm and the save route.
 *
 * Doors with `by_others === true` are EXCLUDED from this check — they
 * are intentionally unassigned (hardware is provided by a different
 * contractor) and their `hw_set` is typically "N/A" or similar sentinel
 * text that will never match a real set. Including them in the
 * unmatched list was the second half of the "Cannot save: 6 Door(s)
 * reference hardware sets that don't exist" bug from 2026-04-11.
 */
export function findDoorsWithUnmatchedSets(
  doors: DoorEntry[],
  definedSetIds: Set<string>,
): DoorEntry[] {
  return doors.filter(
    d => !d.by_others && d.hw_set && !definedSetIds.has(d.hw_set),
  )
}

// --- Door number normalization + doorToSetMap ---

/**
 * Normalize a door number for matching across Opening List and Hardware
 * Schedule extraction. Both sources should produce the same format, but
 * whitespace and case differences are possible.
 *
 * Examples:
 *   "110-02A"   → "110-02A"
 *   " 110-02a " → "110-02A"
 *   "110 02A"   → "11002A"  (spaces collapsed)
 */
export function normalizeDoorNumber(s: string): string {
  return (s ?? '').trim().toUpperCase().replace(/\s+/g, '')
}

// --- Opening size + pair detection ---
//
// Opening size conventions in DFH (Door & Frame Hardware) industry:
//
//   "3070"          → 3'0" × 7'0" (compressed: first 2 digits = feet+inches
//                     for WIDTH, next 2 = feet+inches for HEIGHT)
//   "3068"          → 3'0" × 6'8"
//   "6080"          → 6'0" × 8'0"  (pair — width > 48")
//   "3'0\" x 7'0\"" → explicit feet/inches with spaces and quotes
//   "3'-0\" × 7'-0\""→ dash-separator variant (common in architectural drawings)
//   "36 x 84"       → pure inches (36" wide × 84" tall)
//   "36\" × 84\""   → pure inches with quotes
//   "914 x 2134"    → metric millimeters (international / ISO)
//   "3-0 x 7-0"     → dash-and-zero variant
//
// Pair vs single detection by width (rule of thumb):
//   Width ≥ 5'0" (60" / 152 cm / 1524 mm) → pair (HIGH confidence)
//   Width ≥ 4'0" (48")                    → possibly pair (could be wide
//                                            single; need corroborating
//                                            signal like heading_leaf_count)
//   Width 2'6"–4'0"                       → single (HIGH confidence)
//   Width < 2'6"                          → unusual (sidelite, access panel)
//
// Common pair widths: 5'0", 5'4", 5'8", 6'0" (most common), 6'8", 7'0", 8'0".
// Each leaf in a pair is typically 3'0", 3'4", or 4'0" wide.

const _PAIR_MIN_WIDTH_IN = 48 // 4'0" — below this, it's a single for sure

/**
 * Parse an opening size label into width/height in inches. Returns null if
 * the label doesn't match any recognized format. Used as a secondary pair
 * detection signal when heading_leaf_count is missing.
 *
 * Handles the common DFH format variants listed in the comment block above.
 * Metric millimeters are converted to inches (1 in = 25.4 mm).
 */
export function parseOpeningSize(
  text: string | null | undefined,
): { widthIn: number; heightIn: number } | null {
  if (!text) return null
  const t = text.trim()
  if (t.length === 0) return null

  // Helper: feet + inches → total inches
  const ftIn = (ft: number, inches: number) => ft * 12 + inches

  // --- Format 1: "3'0\" x 7'0\"" or "3'-0\" x 7'-0\"" or "3' 0\" × 7' 0\""
  //   Matches feet/inches with optional dash/space, optional inch marks,
  //   and any of x, ×, X, * as separator.
  //   Groups: (fW)(iW) (fH)(iH)
  const explicitFtIn =
    /(\d+)\s*'\s*[-\s]?\s*(\d{1,2})?\s*"?\s*[x×X*]\s*(\d+)\s*'\s*[-\s]?\s*(\d{1,2})?\s*"?/
  const m1 = t.match(explicitFtIn)
  if (m1) {
    const fW = parseInt(m1[1], 10)
    const iW = m1[2] ? parseInt(m1[2], 10) : 0
    const fH = parseInt(m1[3], 10)
    const iH = m1[4] ? parseInt(m1[4], 10) : 0
    if (!Number.isNaN(fW) && !Number.isNaN(fH)) {
      return { widthIn: ftIn(fW, iW), heightIn: ftIn(fH, iH) }
    }
  }

  // --- Format 2: "3070" or "3068" compressed 4-digit (feet+inches per dim)
  //   2 digits for width (feet tens × 10 + inches ones), 2 digits for height.
  //   Only accept if the implied dimensions are plausible (width 20"–96",
  //   height 60"–144") — else it's probably a door_number or other code.
  const compressed = /^(\d{4,5})$/
  const m2 = t.match(compressed)
  if (m2) {
    const digits = m2[1]
    // Split into width / height halves. For 4 digits: first 2 = width,
    // last 2 = height. For 5 digits: first 2 or 3 = width, last 2 = height.
    const widthStr = digits.length === 5 ? digits.slice(0, 3) : digits.slice(0, 2)
    const heightStr = digits.slice(-2)
    // "30" = 3'0" = 36"; "34" = 3'4" = 40"; "36" = 3'6" = 42"
    // "70" = 7'0" = 84"; "80" = 8'0" = 96"
    const parseFtInPair = (s: string): number | null => {
      if (s.length === 2) {
        const ft = parseInt(s[0], 10)
        const inches = parseInt(s[1], 10)
        if (Number.isNaN(ft) || Number.isNaN(inches)) return null
        return ftIn(ft, inches)
      }
      if (s.length === 3) {
        const ft = parseInt(s.slice(0, 2), 10)
        const inches = parseInt(s[2], 10)
        if (Number.isNaN(ft) || Number.isNaN(inches)) return null
        return ftIn(ft, inches)
      }
      return null
    }
    const widthIn = parseFtInPair(widthStr)
    const heightIn = parseFtInPair(heightStr)
    if (
      widthIn != null &&
      heightIn != null &&
      widthIn >= 20 &&
      widthIn <= 120 &&
      heightIn >= 60 &&
      heightIn <= 144
    ) {
      return { widthIn, heightIn }
    }
  }

  // --- Format 3: "36 x 84" or "36\" × 84\"" pure inches, OR metric mm
  //   Must be standalone (not trailing text), and within plausible ranges.
  //   Allow 2-4 digits so metric millimeters (e.g., 914 × 2134) parse.
  const inchesOnly = /^(\d{2,4})\s*"?\s*[x×X*]\s*(\d{2,4})\s*"?$/
  const m3 = t.match(inchesOnly)
  if (m3) {
    const w = parseInt(m3[1], 10)
    const h = parseInt(m3[2], 10)
    // Plausibility: width 20–144", height 60–144". If both are ≥ 300, treat
    // as metric mm (e.g., "914 x 2134").
    if (w >= 300 && h >= 300) {
      const widthIn = Math.round((w / 25.4) * 10) / 10
      const heightIn = Math.round((h / 25.4) * 10) / 10
      return { widthIn, heightIn }
    }
    if (w >= 20 && w <= 144 && h >= 60 && h <= 144) {
      return { widthIn: w, heightIn: h }
    }
  }

  return null
}

/**
 * Detect whether an opening is a pair door based on the hardware set and
 * door info. Uses a layered signal strategy so the detection is robust
 * across different PDF formats:
 *
 *   1. PRIMARY — `heading_leaf_count > heading_door_count`. If Python's
 *      extractor captured the "N Pair Doors" lines correctly, the leaf
 *      count exceeds the opening count and we have a definitive answer.
 *   2. SECONDARY — Parse the opening size from door_type or the heading
 *      text. If width ≥ 48" (4'0"), treat as pair. This catches PDFs
 *      where the heading parser missed the leaf count but the size is
 *      available in the door schedule.
 *   3. TERTIARY — Keyword scan of heading/door_type for "pair", "double",
 *      "pr" (the legacy behavior). This is the weakest signal but catches
 *      edge cases where neither structured signal is present.
 *
 * Previously only the tertiary signal was used, which failed silently for
 * the Radius DC PDF format (heading text "Heading #DH4A.1", door_type "A")
 * and left pair doors with the wrong per-leaf → per-opening math.
 */
export function detectIsPair(
  hwSet: HardwareSet | undefined,
  doorInfo: { door_type?: string | null; location?: string | null } | undefined,
): boolean {
  // --- Primary: leaf count exceeds door count in the extracted set ---
  const leafCount = hwSet?.heading_leaf_count ?? 0
  const doorCount = hwSet?.heading_door_count ?? 0
  if (doorCount >= 1 && leafCount > doorCount) {
    return true
  }

  // --- Secondary: parse opening size from door_type or heading text ---
  const sizeSources: Array<string | null | undefined> = [
    doorInfo?.door_type,
    doorInfo?.location,
    hwSet?.heading,
  ]
  for (const src of sizeSources) {
    const parsed = parseOpeningSize(src)
    if (parsed && parsed.widthIn >= _PAIR_MIN_WIDTH_IN) {
      return true
    }
  }

  // --- Tertiary: keyword scan (legacy fallback) ---
  const heading = (hwSet?.heading ?? '').toLowerCase()
  const doorType = (doorInfo?.door_type ?? '').toLowerCase()
  if (
    heading.includes('pair') ||
    heading.includes('double') ||
    doorType.includes('pr') ||
    doorType.includes('pair')
  ) {
    return true
  }

  return false
}

/**
 * Build a door-number → specific-sub-set lookup map.
 *
 * Handles the multi-heading case where one generic_set_id (e.g., "DH4A")
 * has multiple sub-headings (DH4A.0, DH4A.1) with different item lists.
 * Each door is assigned to the sub-set whose heading block lists it.
 *
 * First-wins semantics: if a door appears in multiple heading_doors lists
 * (shouldn't happen but possible with PDF parser bugs), the earliest one wins.
 */
export function buildDoorToSetMap(
  hardwareSets: HardwareSet[],
): Map<string, HardwareSet> {
  const map = new Map<string, HardwareSet>()
  for (const set of hardwareSets) {
    for (const doorNum of set.heading_doors ?? []) {
      const key = normalizeDoorNumber(doorNum)
      if (key && !map.has(key)) {
        map.set(key, set)
      }
    }
  }
  return map
}

// --- Hardware item builder (Phase 3) ---

/**
 * Build per-opening hardware item rows (Door/Frame + set items).
 * Used by save/route.ts and apply-revision/route.ts.
 *
 * Resolves the correct sub-set for each opening in this order:
 *  1. doorToSetMap lookup by specific door_number (handles multi-heading)
 *  2. Legacy setMap lookup by opening.hw_set (handles single-heading + fallback)
 */
export function buildPerOpeningItems(
  openings: Array<{ id: string; door_number: string; hw_set: string | null }>,
  doorInfoMap: Map<string, { door_type: string; frame_type: string }>,
  setMap: Map<string, HardwareSet>,
  doorToSetMap: Map<string, HardwareSet>,
  fkColumn: 'opening_id' | 'staging_opening_id' = 'opening_id',
  extraFields?: Record<string, unknown>,
): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = []

  for (const opening of openings) {
    let sortOrder = 0
    const doorInfo = doorInfoMap.get(opening.door_number)
    const base = { [fkColumn]: opening.id, ...extraFields }

    // Resolve the specific sub-set: door-number lookup takes priority over
    // hw_set lookup, so multi-heading sub-sets (DH4A.0 vs DH4A.1) correctly
    // route their items to the right openings.
    const doorKey = normalizeDoorNumber(opening.door_number)
    const hwSet = doorToSetMap.get(doorKey) ?? setMap.get(opening.hw_set ?? '')

    // Pair detection uses detectIsPair which layers three signals:
    //   1. hwSet.heading_leaf_count > heading_door_count (primary)
    //   2. parseOpeningSize → width >= 48" (secondary)
    //   3. keyword scan of heading / door_type (tertiary)
    //
    // This replaces an earlier inline keyword-only check that silently
    // returned false for Radius DC format (heading "Heading #DH4A.1",
    // door_type "A" — no "pair" keyword in either). The result was that
    // pair openings got only 1 Door row and per-leaf item quantities
    // were stored without being doubled.
    const isPair = detectIsPair(hwSet, doorInfo)
    const leafCount = isPair ? 2 : 1

    // Add door(s) only when door_type is known. Stamp leaf_side on each
    // structural row so the DB carries the attribution (see migration 013).
    const doorModel = doorInfo?.door_type?.trim() || null
    if (doorModel) {
      if (isPair) {
        rows.push({ ...base, name: 'Door (Active Leaf)', qty: 1, manufacturer: null, model: doorModel, finish: null, sort_order: sortOrder++, leaf_side: 'active' })
        rows.push({ ...base, name: 'Door (Inactive Leaf)', qty: 1, manufacturer: null, model: doorModel, finish: null, sort_order: sortOrder++, leaf_side: 'inactive' })
      } else {
        rows.push({ ...base, name: 'Door', qty: 1, manufacturer: null, model: doorModel, finish: null, sort_order: sortOrder++, leaf_side: 'active' })
      }
    }

    // Frame — only when frame_type is known. One frame per opening
    // regardless of pair vs single (pair doors share one doubled frame).
    const frameModel = doorInfo?.frame_type?.trim() || null
    if (frameModel) {
      rows.push({ ...base, name: 'Frame', qty: 1, manufacturer: null, model: frameModel, finish: null, sort_order: sortOrder++, leaf_side: 'shared' })
    }

    // Hardware set items — store per-leaf quantities as-is.
    // Phase 2 reverted Phase 1's doubling: the UI now renders
    // Shared / Leaf 1 / Leaf 2 sections, so per-leaf items (hinges,
    // closers, etc.) are stored at their per-leaf value and the UI
    // displays them on each leaf section.
    //
    // Phase 3: attach a leaf_side hint via computeLeafSide() — unambiguous
    // for per_pair / per_frame items (→ 'shared') and left NULL for
    // per_leaf / per_opening items on pairs, where render-time logic still
    // decides (triage UI in a follow-up will let users set these).
    //
    // Phase 4 (pair-door hinge fix): Electric hinges on pair doors are
    // assigned to the active leaf only. Standard hinges are split into
    // per-leaf rows so the active leaf gets the consolidated qty (total -
    // electric) and the inactive leaf gets the original (un-consolidated)
    // qty. This produces the correct DHI layout:
    //   Active:   3 standard + 1 electric = 4 hinge positions
    //   Inactive: 4 standard + 0 electric = 4 hinge positions
    if ((hwSet?.items?.length ?? 0) > 0) {
      // Pre-scan for electric hinges on pair doors so we can adjust
      // standard hinge quantities per-leaf.
      const setItems = hwSet?.items ?? []
      const { totalElectricQty: totalElectricHingeQty } = scanElectricHinges(setItems, isPair)

      for (const item of setItems) {
        const category = isPair ? classifyItem(item.name, undefined, item.model) : null
        let leafSide = computeLeafSide(item.name, leafCount, item.model)

        // Quantity audit columns — carry through from extraction
        const qtyAudit = {
          qty_total: item.qty_total ?? null,
          qty_door_count: item.qty_door_count ?? null,
          qty_source: item.qty_source ?? null,
        }

        // ── Electric hinge: active leaf only on pairs ──
        if (isPair && category === 'electric_hinge') {
          leafSide = 'active'
          rows.push({
            ...base,
            name: item.name,
            qty: item.qty || 1,
            ...qtyAudit,
            manufacturer: item.manufacturer || null,
            model: item.model || null,
            finish: item.finish || null,
            sort_order: sortOrder++,
            leaf_side: leafSide,
          })
          continue
        }

        // ── Standard hinges on pairs with electric hinges: split per leaf ──
        // item.qty is the raw per-leaf value (e.g. 4). The electric hinge
        // replaces one standard hinge position on the active leaf only.
        //   Active leaf:   raw − electric (e.g. 4 − 1 = 3)
        //   Inactive leaf: raw (e.g. 4)
        if (isPair && category === 'hinges' && totalElectricHingeQty > 0) {
          const inactiveQty = item.qty || 1
          const activeQty = inactiveQty - totalElectricHingeQty
          // Active leaf row
          rows.push({
            ...base,
            name: item.name,
            qty: activeQty,
            ...qtyAudit,
            manufacturer: item.manufacturer || null,
            model: item.model || null,
            finish: item.finish || null,
            sort_order: sortOrder++,
            leaf_side: 'active',
          })
          // Inactive leaf row
          rows.push({
            ...base,
            name: item.name,
            qty: inactiveQty,
            ...qtyAudit,
            manufacturer: item.manufacturer || null,
            model: item.model || null,
            finish: item.finish || null,
            sort_order: sortOrder++,
            leaf_side: 'inactive',
          })
          continue
        }

        // ── All other items: default behavior ──
        rows.push({
          ...base,
          name: item.name,
          qty: item.qty || 1,
          ...qtyAudit,
          manufacturer: item.manufacturer || null,
          model: item.model || null,
          finish: item.finish || null,
          sort_order: sortOrder++,
          leaf_side: leafSide,
        })
      }
    }
  }

  return rows
}
