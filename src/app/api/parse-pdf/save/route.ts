import { NextRequest, NextResponse } from 'next/server'
import * as Sentry from '@sentry/nextjs'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { createExtractionRun, updateExtractionRun, writeStagingData, promoteExtraction } from '@/lib/extraction-staging'
import type { StagingOpening } from '@/lib/extraction-staging'
import type { DoorEntry, HardwareSet } from '@/lib/types'
import {
  buildPerOpeningItems,
  buildDoorToSetMap,
  buildSetLookupMap,
  detectIsPair,
  normalizeDoorNumber,
  wouldProduceZeroItems,
} from '@/lib/parse-pdf-helpers'
import { validateExtractionRun, summarizeReport } from '@/lib/extraction-invariants'
import type { InvariantViolation } from '@/lib/extraction-invariants'
import { logActivity } from '@/lib/activity-log'
import { validateJson, errorResponse } from '@/lib/api-helpers/validate'
import { ParsePdfSaveRequestSchema } from '@/lib/schemas/parse-pdf'

// Feature-flag the invariants gate for the first week so we can ship safely
// and flip the default on by removing the env check. '1' | 'true' enables it.
// Leaving the flag unset means invariants still RUN (they are cheap and
// side-effect-free) but only 'warning'-level results reach the client and
// blockers do not fail the save. This gives us one-click reversibility if
// the rule set has a false positive we didn't catch.
function invariantGateEnabled(): boolean {
  const v = (process.env.DHT_INVARIANT_CHECKS ?? '').toLowerCase()
  return v === '1' || v === 'true'
}

// --- Shared: check for unmatched sets ---
//
// Doors with `by_others === true` are intentionally unassigned (hardware
// is provided by a different contractor) and their `hw_set` is typically
// a sentinel like "N/A". Skipping them here prevents the save endpoint
// from emitting noise in the `unmatchedSets` warning list and keeps the
// server-side logic consistent with the client-side StepConfirm
// validation (which uses findDoorsWithUnmatchedSets).
function findUnmatchedSets(doors: DoorEntry[], setMap: Map<string, HardwareSet>): string[] {
  const unmatched: string[] = []
  for (const door of doors) {
    if (door.by_others) continue
    if (door.hw_set && !setMap.has(door.hw_set) && !unmatched.includes(door.hw_set)) {
      unmatched.push(door.hw_set)
    }
  }
  return unmatched
}

// --- Save handler: takes merged parse results, writes to DB ---

const CHUNK_SIZE = 50

export async function POST(request: NextRequest) {
  try {
    // Auth check
    const supabase = await createServerSupabaseClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return errorResponse('AUTH_REQUIRED', 'You must be signed in')
    }

    const parsed = await validateJson(request, ParsePdfSaveRequestSchema)
    if (!parsed.ok) return parsed.response
    const { projectId, hardwareSets, doors } = parsed.data as {
      projectId: string
      hardwareSets: HardwareSet[]
      doors: DoorEntry[]
    }

    // Project membership check (finding #9): verify the authenticated user is
    // a member of projectId before writing any staging data. Auth alone is not
    // sufficient — an authenticated user could supply any projectId they know.
    const { data: membership, error: memberError } = await supabase
      .from('project_members')
      .select('role')
      .eq('project_id', projectId)
      .eq('user_id', user.id)
      .single()
    if (memberError || !membership) {
      return errorResponse('ACCESS_DENIED', 'Access denied')
    }

    // Build set lookup map — register under BOTH set_id and generic_set_id
    // because doors may be assigned to either (e.g., heading "DH1.01" vs set "DH1-10")
    const setMap = buildSetLookupMap(hardwareSets)
    // Door-number → specific sub-set map (handles multi-heading sub-sets
    // like DH4A.0 vs DH4A.1 that share a generic_set_id)
    const doorToSetMap = buildDoorToSetMap(hardwareSets)

    // NOTE (2026-04-13, fix/qty-normalization-pipeline-overhaul):
    //
    // normalizeQuantities() is intentionally NOT called here.
    //
    // CONTEXT: normalizeQuantities() used to be called three times:
    //   1. Inside chunk/route.ts (after Darrin CP2)
    //   2. Inside parse-pdf/route.ts (same)
    //   3. HERE — as a "final safety net"
    //
    // The third call was architecturally wrong. By the time save/route.ts
    // runs, the wizard client has already received the fully-normalized
    // HardwareSets from the chunk pipeline, reviewed them with Darrin CP2+CP3,
    // and the user has made (or approved) any manual edits. The data is final.
    //
    // Calling normalizeQuantities() again here would:
    //   a) Re-divide items that already went through PATH 1-4 (Python-annotated
    //      paths). The NEVER_RENORMALIZE guard catches the ones correctly marked,
    //      but items that fell through to PATH 5 and were divided there do NOT
    //      have a terminal qty_source — they have 'divided', 'flagged', etc.
    //      Those ARE in NEVER_RENORMALIZE, so they're protected.
    //   b) However, any item that somehow arrives here with qty_source='parsed'
    //      or undefined would be re-processed by the TS taxonomy fallback. That
    //      is specifically what we're eliminating: silent double-division.
    //
    // If you are tempted to add a safety net here again: solve it upstream
    // instead (in Python annotation or Darrin CP2 feedback). Do not add a
    // third division pass — the value of having a SINGLE authoritative pass
    // is that bugs are visible and traceable.
    //
    // 0. Filter orphan doors — any door that buildPerOpeningItems would emit
    // zero rows for. That happens when NONE of these produce a row:
    //   - hw_set resolves (via doorToSetMap or setMap) to a set with items
    //   - door_type is present (emits a Door row)
    //   - frame_type is present (emits a Frame row)
    //
    // Previously this only caught hw_set values of "" or "N/A". But a door
    // with hw_set "H07" that matches no set AND has empty door/frame types
    // still produces an empty staging_opening — which merge_extraction
    // rejects with the generic "openings with no hardware items" error.
    //
    // See `wouldProduceZeroItems` in parse-pdf-helpers.ts for the shared
    // predicate; StepConfirm runs the same check client-side as a pre-flight.
    const isOrphan = (d: DoorEntry) => wouldProduceZeroItems(d, setMap, doorToSetMap)
    const orphanDoors = doors.filter(isOrphan)
    const activeDoors = doors.filter(d => !isOrphan(d))
    if (orphanDoors.length > 0) {
      console.log(
        `[save] Filtered ${orphanDoors.length} orphan door(s) that would produce zero hardware items:`,
        orphanDoors.map(d => ({
          door_number: d.door_number,
          hw_set: d.hw_set ?? null,
          door_type: d.door_type ?? null,
          frame_type: d.frame_type ?? null,
          resolvedSet:
            doorToSetMap.get(normalizeDoorNumber(d.door_number))?.set_id
            ?? setMap.get((d.hw_set ?? '').trim())?.set_id
            ?? null,
        })),
      )
    }

    // Build doorInfoMap (needed by both staging and production paths).
    // location is included so detectIsPair's secondary size signal can fire
    // for PDFs where heading_leaf_count is absent on sub-sets.
    const doorInfoMap = new Map<string, { door_type: string; frame_type: string; location: string }>()
    for (const door of activeDoors) {
      doorInfoMap.set(door.door_number, {
        door_type: door.door_type || '',
        frame_type: door.frame_type || '',
        location: door.location || '',
      })
    }

    // 1. Create extraction run
    const runId = await createExtractionRun(supabase, {
      projectId,
      userId: user.id,
      extractionMethod: 'pdfplumber',
    })

    // 2. Transform doors → StagingOpening[]
    const stagingOpenings: StagingOpening[] = activeDoors.map(d => {
      // Resolve the hardware set for this door (same lookup chain as buildPerOpeningItems)
      const doorKey = normalizeDoorNumber(d.door_number)
      const hwSet = doorToSetMap.get(doorKey) ?? setMap.get(d.hw_set ?? '')
      const doorInfo = doorInfoMap.get(d.door_number)
      const isPair = detectIsPair(hwSet, doorInfo)
      return {
        door_number: d.door_number,
        hw_set: d.hw_set || undefined,
        location: d.location || undefined,
        door_type: d.door_type || undefined,
        frame_type: d.frame_type || undefined,
        fire_rating: d.fire_rating || undefined,
        hand: d.hand || undefined,
        // Issue #8: carry the set's PDF page through to the staging opening
        // so it lands on openings.pdf_page after promote_extraction().
        pdf_page: setMap.get(d.hw_set ?? '')?.pdf_page ?? null,
        // Phase 2: persist pair detection so the UI can render per-leaf sections
        leaf_count: isPair ? 2 : 1,
        field_confidence: d.field_confidence || undefined,
      }
    })

    // 3. Write staging openings (empty hardwareSets — items handled separately)
    const stagingResult = await writeStagingData(supabase, runId, projectId, stagingOpenings, [])

    // 4. Query back staging openings to get their IDs for item insertion
    const { data: stagingOpeningRows, error: fetchError } = await (supabase as any)
      .from('staging_openings')
      .select('id, door_number, hw_set')
      .eq('extraction_run_id', runId)

    if (fetchError) {
      throw new Error(`Failed to fetch staging openings: ${fetchError.message}`)
    }

    // 5. Build all items (Door/Frame + set items) via shared helper
    const allItems = buildPerOpeningItems(
      stagingOpeningRows ?? [],
      doorInfoMap,
      setMap,
      doorToSetMap,
      'staging_opening_id',
      { extraction_run_id: runId },
    )

    // Breadcrumbs (not errors) — give us context in Sentry for any later
    // alert that fires on this run, without adding noise by themselves.
    const totalHeadingDoors = hardwareSets.reduce(
      (s, set) => s + (set.heading_doors?.length ?? 0),
      0,
    )
    Sentry.addBreadcrumb({
      category: 'extraction.save.input',
      level: 'info',
      message: 'buildPerOpeningItems input',
      data: {
        runId,
        openings: (stagingOpeningRows ?? []).length,
        hardwareSets: hardwareSets.length,
        headingDoorsTotal: totalHeadingDoors,
      },
    })

    const doorRowCount = allItems.filter(r => /^Door(\s|$|\()/.test(String(r['name'] ?? ''))).length
    const frameRowCount = allItems.filter(r => String(r['name'] ?? '') === 'Frame').length
    const activeLeafRowCount = allItems.filter(r => String(r['name'] ?? '') === 'Door (Active Leaf)').length
    const inactiveLeafRowCount = allItems.filter(r => String(r['name'] ?? '') === 'Door (Inactive Leaf)').length
    const perOpeningHistogram: Record<string, number> = {}
    for (const row of allItems) {
      const k = String(row['staging_opening_id'])
      perOpeningHistogram[k] = (perOpeningHistogram[k] ?? 0) + 1
    }
    Sentry.addBreadcrumb({
      category: 'extraction.save.output',
      level: 'info',
      message: 'buildPerOpeningItems output',
      data: {
        runId,
        items: allItems.length,
        doorRows: doorRowCount,
        frameRows: frameRowCount,
        activeLeafRows: activeLeafRowCount,
        inactiveLeafRows: inactiveLeafRowCount,
        // Truncated to stay under Sentry's ~16kb breadcrumb data cap.
        perOpeningHistogramSample: JSON.stringify(perOpeningHistogram).slice(0, 4000),
      },
    })

    // Defensive diagnostic: if any staging opening got zero rows, the orphan
    // filter is out of sync with buildPerOpeningItems. That's a code bug —
    // surface it loudly instead of letting merge_extraction reject with the
    // generic error. Should be unreachable after the wouldProduceZeroItems fix.
    const openingsWithItems = new Set<string>()
    for (const row of allItems) {
      const id = row['staging_opening_id']
      if (typeof id === 'string') openingsWithItems.add(id)
    }
    const zeroItemOpenings = (stagingOpeningRows ?? []).filter(
      (o: { id: string; door_number: string }) => !openingsWithItems.has(o.id),
    )
    if (zeroItemOpenings.length > 0) {
      console.error(
        `[save] BUG: ${zeroItemOpenings.length} staging opening(s) have zero generated items despite orphan filter:`,
        zeroItemOpenings.map((o: { door_number: string }) => o.door_number),
      )
      return NextResponse.json({
        success: false,
        error: `Internal error: doors ${zeroItemOpenings.map((o: { door_number: string }) => o.door_number).join(', ')} would produce zero hardware items. Please contact support.`,
        zeroItemDoors: zeroItemOpenings.map((o: { door_number: string }) => o.door_number),
      }, { status: 500 })
    }

    // 6. Chunk-insert staging hardware items (with single retry on failure)
    let itemsInserted = 0
    const failedItemChunks: Array<{ offset: number; count: number; error: string }> = []
    for (let i = 0; i < allItems.length; i += CHUNK_SIZE) {
      const chunk = allItems.slice(i, i + CHUNK_SIZE)
      let { data, error } = await (supabase as any)
        .from('staging_hardware_items')
        .insert(chunk as any)
        .select('id')

      // Retry once on transient failure before recording it as failed
      if (error) {
        console.warn(`Retrying staging hw items chunk at ${i} after error:`, error.message)
        ;({ data, error } = await (supabase as any)
          .from('staging_hardware_items')
          .insert(chunk as any)
          .select('id'))
      }

      if (error) {
        console.error(`Error inserting staging hw items chunk at ${i} (after retry):`, error)
        failedItemChunks.push({ offset: i, count: chunk.length, error: error.message })
      } else if (data) {
        itemsInserted += data.length
      }
    }

    // 7. Update extraction run status to staged
    await updateExtractionRun(supabase, runId, {
      status: 'reviewing',
      doorsExtracted: stagingResult.openingsCount,
      hwSetsExtracted: hardwareSets.length,
      completedAt: new Date().toISOString(),
    })

    const unmatchedSets = findUnmatchedSets(activeDoors, setMap)

    const isPartialSave = failedItemChunks.length > 0
    console.log(`Staging save complete: ${stagingResult.openingsCount} openings, ${itemsInserted} items, run=${runId}${isPartialSave ? ` (${failedItemChunks.length} chunk(s) failed)` : ''}`)

    // Block auto-promotion when chunks failed: some staging_openings would
    // have zero items, causing merge_extraction() to reject the promotion
    // with a generic "Promotion Failed" error. Surface the real cause instead.
    if (isPartialSave) {
      console.error(`Skipping auto-promote: ${failedItemChunks.length} chunk(s) failed, ${allItems.length - itemsInserted} items missing`)
      return NextResponse.json({
        success: false,
        partial: true,
        error: `Save partially failed: ${failedItemChunks.length} chunk(s) could not be inserted (${allItems.length - itemsInserted} of ${allItems.length} items missing). Promotion skipped to prevent orphaned openings. Please retry the save.`,
        stagingSuccess: false,
        openingsCount: stagingResult.openingsCount,
        itemsCount: itemsInserted,
        expectedItemsCount: allItems.length,
        hardwareSets: hardwareSets.length,
        unmatchedSets: unmatchedSets.length > 0 ? unmatchedSets : undefined,
        failedChunks: failedItemChunks,
        extraction_run_id: runId,
      })
    }

    // 8. Auto-promote: staging → production in the same request
    const promoteResult = await promoteExtraction(supabase, runId, user.id)

    if (!promoteResult.success) {
      console.error('Auto-promote failed:', promoteResult.error, {
        orphanDoors: promoteResult.orphanDoors,
      })
      return NextResponse.json({
        success: false,
        partial: isPartialSave,
        error: promoteResult.error ?? 'Promotion to production failed',
        stagingSuccess: true,
        openingsCount: stagingResult.openingsCount,
        itemsCount: itemsInserted,
        expectedItemsCount: allItems.length,
        hardwareSets: hardwareSets.length,
        unmatchedSets: unmatchedSets.length > 0 ? unmatchedSets : undefined,
        failedChunks: isPartialSave ? failedItemChunks : undefined,
        extraction_run_id: runId,
        orphanDoors: promoteResult.orphanDoors,
      })
    }

    console.log(`Auto-promote complete: ${promoteResult.openingsPromoted} openings, ${promoteResult.itemsPromoted} items`)

    // 9. Post-promote invariants gate.
    //
    // Runs regardless of the feature flag so we always have diagnostic
    // output; only the *enforcement* is gated on DHT_INVARIANT_CHECKS so
    // a false positive in a rule doesn't block production saves during
    // the rollout week. Warnings are always returned to the wizard so the
    // user sees context toasts.
    let invariantBlockers: InvariantViolation[] = []
    let invariantWarnings: InvariantViolation[] = []
    let invariantSkipped: string[] = []
    try {
      const report = await validateExtractionRun(runId, supabase, { hardwareSets })
      invariantBlockers = report.violations.filter(v => v.severity === 'blocker')
      invariantWarnings = report.violations.filter(v => v.severity === 'warning')
      invariantSkipped = report.skippedRules

      console.log(`[save] Invariants: ${summarizeReport(report)}`)

      if (report.blockers > 0) {
        const ruleNames = Array.from(new Set(report.violations.filter(v => v.severity === 'blocker').map(v => v.rule)))
        // Mark the run so downstream views (activity log, admin UI) know
        // this extraction is suspect even though promote_extraction() ran.
        try {
          await updateExtractionRun(supabase, runId, { status: 'completed_with_issues' })
        } catch (e) {
          console.warn('[save] Failed to mark run as completed_with_issues:', e)
        }

        // Single Sentry event with the rule names in tags so issues
        // auto-group by rule instead of producing one event per violation.
        Sentry.captureMessage('Extraction invariants violated after promotion', {
          level: 'error',
          tags: {
            invariant_violation: 'true',
            extraction_run_id: runId,
            project_id: projectId,
            rules: ruleNames.join(','),
          },
          extra: {
            blockers: report.blockers,
            warnings: report.warnings,
            violations: report.violations,
          },
        })

        if (invariantGateEnabled()) {
          return NextResponse.json({
            success: false,
            partial: isPartialSave,
            error: 'Extraction completed with invariant violations.',
            stagingSuccess: true,
            openingsCount: promoteResult.openingsPromoted ?? stagingResult.openingsCount,
            itemsCount: promoteResult.itemsPromoted ?? itemsInserted,
            expectedItemsCount: allItems.length,
            hardwareSets: hardwareSets.length,
            unmatchedSets: unmatchedSets.length > 0 ? unmatchedSets : undefined,
            failedChunks: isPartialSave ? failedItemChunks : undefined,
            extraction_run_id: runId,
            promoted: true,
            invariantBlockers,
            invariantWarnings,
            invariantSkippedRules: invariantSkipped,
          }, { status: 500 })
        }
      }
    } catch (invariantErr) {
      // The validator throwing is a bug in the validator itself, not a
      // data problem. Log it and continue — never block a save because
      // the invariants layer broke.
      console.error('[save] Invariant validation errored:', invariantErr)
      Sentry.captureException(invariantErr, {
        tags: { invariant_violation: 'false', invariant_validator_error: 'true' },
      })
      invariantBlockers = []
      invariantWarnings = []
    }

    // Audit trail
    await logActivity({
      projectId,
      userId: user.id,
      action: 'extraction_promoted',
      entityType: 'project',
      entityId: projectId,
      details: {
        extractionRunId: runId,
        openingsPromoted: promoteResult.openingsPromoted,
        itemsPromoted: promoteResult.itemsPromoted,
        hardwareSets: hardwareSets.length,
      },
    })

    return NextResponse.json({
      success: true,
      partial: isPartialSave,
      openingsCount: promoteResult.openingsPromoted ?? stagingResult.openingsCount,
      itemsCount: promoteResult.itemsPromoted ?? itemsInserted,
      expectedItemsCount: allItems.length,
      hardwareSets: hardwareSets.length,
      unmatchedSets: unmatchedSets.length > 0 ? unmatchedSets : undefined,
      failedChunks: isPartialSave ? failedItemChunks : undefined,
      extraction_run_id: runId,
      promoted: true,
      orphanDoorsFiltered: orphanDoors.length > 0
        ? { count: orphanDoors.length, doorNumbers: orphanDoors.map(d => d.door_number) }
        : undefined,
      invariantBlockers,
      invariantWarnings,
      invariantSkippedRules: invariantSkipped.length > 0 ? invariantSkipped : undefined,
    })
  } catch (error) {
    console.error('Save error:', error)
    const message = error instanceof Error ? error.message : 'Internal server error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
