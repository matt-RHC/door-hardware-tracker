import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { createExtractionRun, updateExtractionRun, writeStagingData } from '@/lib/extraction-staging'
import type { StagingOpening } from '@/lib/extraction-staging'

// --- Types ---

interface HardwareItem {
  qty: number              // per-opening (already normalized by Python layer)
  qty_total?: number       // raw total from PDF
  qty_door_count?: number  // openings in this set
  qty_source?: string      // "parsed" | "divided" | "flagged" | "capped"
  name: string
  model: string
  finish: string
  manufacturer: string
}

interface HardwareSet {
  set_id: string
  generic_set_id?: string
  heading: string
  heading_door_count?: number
  heading_leaf_count?: number
  items: HardwareItem[]
}

interface DoorEntry {
  door_number: string
  hw_set: string
  location: string
  door_type: string
  frame_type: string
  fire_rating: string
  hand: string
}

// --- Shared helper: builds Door/Frame auto-items + set items per opening ---

function buildPerOpeningItems(
  openings: Array<{ id: string; door_number: string; hw_set: string | null }>,
  doorInfoMap: Map<string, { door_type: string; frame_type: string }>,
  setMap: Map<string, HardwareSet>,
  fkColumn: 'opening_id' | 'staging_opening_id',
  extraFields?: Record<string, unknown>,
): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = []

  for (const opening of openings) {
    let sortOrder = 0
    const doorInfo = doorInfoMap.get(opening.door_number)

    // Determine if pair
    const hwSet = setMap.get(opening.hw_set ?? '')
    const heading = (hwSet?.heading ?? '').toLowerCase()
    const doorType = (doorInfo?.door_type ?? '').toLowerCase()
    const isPair = heading.includes('pair') || heading.includes('double') ||
                   doorType.includes('pr') || doorType.includes('pair')

    const base = { [fkColumn]: opening.id, ...extraFields }

    // Add door(s) as checkable items
    if (isPair) {
      rows.push({
        ...base,
        name: 'Door (Active Leaf)',
        qty: 1, manufacturer: null, model: doorInfo?.door_type ?? null,
        finish: null, sort_order: sortOrder++,
      })
      rows.push({
        ...base,
        name: 'Door (Inactive Leaf)',
        qty: 1, manufacturer: null, model: doorInfo?.door_type ?? null,
        finish: null, sort_order: sortOrder++,
      })
    } else {
      rows.push({
        ...base,
        name: 'Door',
        qty: 1, manufacturer: null, model: doorInfo?.door_type ?? null,
        finish: null, sort_order: sortOrder++,
      })
    }

    // Frame
    rows.push({
      ...base,
      name: 'Frame',
      qty: 1, manufacturer: null, model: doorInfo?.frame_type ?? null,
      finish: null, sort_order: sortOrder++,
    })

    // Hardware set items
    if ((hwSet?.items?.length ?? 0) > 0) {
      for (const item of hwSet?.items ?? []) {
        rows.push({
          ...base,
          name: item.name,
          qty: item.qty || 1,
          manufacturer: item.manufacturer || null,
          model: item.model || null,
          finish: item.finish || null,
          sort_order: sortOrder++,
        })
      }
    }
  }

  return rows
}

// --- Shared: check for unmatched sets ---

function findUnmatchedSets(doors: DoorEntry[], setMap: Map<string, HardwareSet>): string[] {
  const unmatched: string[] = []
  for (const door of doors) {
    if (door.hw_set && !setMap.has(door.hw_set) && !unmatched.includes(door.hw_set)) {
      unmatched.push(door.hw_set)
    }
  }
  return unmatched
}

// --- Save handler: takes merged parse results, writes to DB ---

const useStaging = true
const CHUNK_SIZE = 50

export async function POST(request: NextRequest) {
  try {
    // Auth check
    const supabase = await createServerSupabaseClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'You must be signed in' }, { status: 401 })
    }

    const body = await request.json()
    const { projectId, hardwareSets, doors } = body as {
      projectId: string
      hardwareSets: HardwareSet[]
      doors: DoorEntry[]
    }

    if (!projectId || !doors || doors.length === 0) {
      return NextResponse.json({ error: 'Missing projectId or doors' }, { status: 400 })
    }

    // Build set lookup map
    const setMap = new Map<string, HardwareSet>()
    for (const set of hardwareSets) {
      setMap.set(set.set_id, set)
    }

    // --- Final qty normalization safety net ---
    // Python does primary normalization. Only re-divide items the LLM may
    // have reverted. Use heading-based counts from Python when available.
    for (const [setId, set] of setMap) {
      const leafCount = (set.heading_leaf_count ?? 0) > 1 ? (set.heading_leaf_count ?? 0) : 0
      const doorCount = (set.heading_door_count ?? 0) > 1 ? (set.heading_door_count ?? 0) : 0
      if (leafCount <= 1 && doorCount <= 1) continue

      for (const item of set.items) {
        if (item.qty_source === 'divided' || item.qty_source === 'flagged' || item.qty_source === 'capped') continue
        let divided = false
        if (leafCount > 1 && item.qty >= leafCount) {
          const perLeaf = item.qty / leafCount
          if (Number.isInteger(perLeaf)) {
            console.log(`[save-qty-norm] ${setId}: "${item.name}" qty ${item.qty} ÷ ${leafCount} leaves = ${perLeaf}`)
            item.qty = perLeaf
            divided = true
          }
        }
        if (!divided && doorCount > 1 && doorCount !== leafCount && item.qty >= doorCount) {
          const perOpening = item.qty / doorCount
          if (Number.isInteger(perOpening)) {
            console.log(`[save-qty-norm] ${setId}: "${item.name}" qty ${item.qty} ÷ ${doorCount} openings = ${perOpening}`)
            item.qty = perOpening
          }
        }
      }
    }

    // Build doorInfoMap (needed by both staging and production paths)
    const doorInfoMap = new Map<string, { door_type: string; frame_type: string }>()
    for (const door of doors) {
      doorInfoMap.set(door.door_number, {
        door_type: door.door_type || '',
        frame_type: door.frame_type || '',
      })
    }

    // ========== STAGING PATH ==========
    if (useStaging) {
      try {
        // 1. Create extraction run
        const runId = await createExtractionRun(supabase, {
          projectId,
          userId: user.id,
          extractionMethod: 'pdfplumber',
        })

        // 2. Transform doors → StagingOpening[]
        const stagingOpenings: StagingOpening[] = doors.map(d => ({
          door_number: d.door_number,
          hw_set: d.hw_set || undefined,
          location: d.location || undefined,
          door_type: d.door_type || undefined,
          frame_type: d.frame_type || undefined,
          fire_rating: d.fire_rating || undefined,
          hand: d.hand || undefined,
        }))

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
          'staging_opening_id',
          { extraction_run_id: runId },
        )

        // 6. Chunk-insert staging hardware items
        let itemsInserted = 0
        for (let i = 0; i < allItems.length; i += CHUNK_SIZE) {
          const chunk = allItems.slice(i, i + CHUNK_SIZE)
          const { data, error } = await (supabase as any)
            .from('staging_hardware_items')
            .insert(chunk as any)
            .select('id')

          if (error) {
            console.error(`Error inserting staging hw items chunk at ${i}:`, error)
          } else if (data) {
            itemsInserted += data.length
          }
        }

        // 7. Update extraction run status
        await updateExtractionRun(supabase, runId, {
          status: 'reviewing',
          doorsExtracted: stagingResult.openingsCount,
          hwSetsExtracted: hardwareSets.length,
          completedAt: new Date().toISOString(),
        })

        const unmatchedSets = findUnmatchedSets(doors, setMap)

        console.log(`Staging save complete: ${stagingResult.openingsCount} openings, ${itemsInserted} items, run=${runId}`)

        return NextResponse.json({
          success: true,
          openingsCount: stagingResult.openingsCount,
          itemsCount: itemsInserted,
          hardwareSets: hardwareSets.length,
          unmatchedSets: unmatchedSets.length > 0 ? unmatchedSets : undefined,
          extraction_run_id: runId,
        })
      } catch (stagingError) {
        console.error('Staging save failed, falling back to direct production save:', stagingError)
        // Fall through to production path below
      }
    }

    // ========== PRODUCTION PATH (fallback) ==========

    // Delete existing openings (cascade deletes children)
    const { error: deleteError } = await (supabase as any)
      .from('openings')
      .delete()
      .eq('project_id', projectId)

    if (deleteError) {
      console.error('Error deleting existing openings:', deleteError)
    }

    // Batch insert all openings
    const openingRows = doors.map((door) => ({
      project_id: projectId,
      door_number: door.door_number,
      hw_set: door.hw_set || null,
      hw_heading: setMap.get(door.hw_set)?.heading || null,
      location: door.location || null,
      door_type: door.door_type || null,
      frame_type: door.frame_type || null,
      fire_rating: door.fire_rating || null,
      hand: door.hand || null,
    }))

    const insertedOpenings: Array<{ id: string; door_number: string; hw_set: string }> = []

    for (let i = 0; i < openingRows.length; i += CHUNK_SIZE) {
      const chunk = openingRows.slice(i, i + CHUNK_SIZE)

      const { data, error } = await (supabase as any)
        .from('openings')
        .insert(chunk as any)
        .select('id, door_number, hw_set')

      if (error) {
        console.error(`Error inserting openings chunk at ${i}:`, error)
      } else if (data) {
        insertedOpenings.push(...data)
      }
    }

    // Build hardware item rows via shared helper
    const allHardwareRows = buildPerOpeningItems(insertedOpenings, doorInfoMap, setMap, 'opening_id')

    let itemsInserted = 0
    for (let i = 0; i < allHardwareRows.length; i += CHUNK_SIZE) {
      const chunk = allHardwareRows.slice(i, i + CHUNK_SIZE)

      const { data, error } = await (supabase as any)
        .from('hardware_items')
        .insert(chunk as any)
        .select('id')

      if (error) {
        console.error(`Error inserting hardware items chunk at ${i}:`, error)
      } else if (data) {
        itemsInserted += data.length
      }
    }

    const unmatchedSets = findUnmatchedSets(doors, setMap)

    console.log(`Save complete: ${insertedOpenings.length} openings, ${itemsInserted} hardware items`)

    return NextResponse.json({
      success: true,
      openingsCount: insertedOpenings.length,
      itemsCount: itemsInserted,
      hardwareSets: hardwareSets.length,
      unmatchedSets: unmatchedSets.length > 0 ? unmatchedSets : undefined,
    })
  } catch (error) {
    console.error('Save error:', error)
    const message = error instanceof Error ? error.message : 'Internal server error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
