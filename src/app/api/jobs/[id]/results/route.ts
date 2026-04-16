import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { createAdminSupabaseClient } from '@/lib/supabase/admin'
import type { DoorEntry, HardwareSet, ExtractedHardwareItem } from '@/lib/types'

export const maxDuration = 30

/**
 * GET /api/jobs/[id]/results — Fetch completed job results.
 *
 * Returns doors, hardware sets, triage summary, and constraint flags in the
 * same shape the wizard expects, built from staging data.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: jobId } = await params

  try {
    const supabase = await createServerSupabaseClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'You must be signed in' }, { status: 401 })
    }

    // RLS ensures user is a project member
    const { data: job, error: jobError } = await supabase
      .from('extraction_jobs')
      .select('*')
      .eq('id', jobId)
      .single()

    if (jobError || !job) {
      return NextResponse.json({ error: 'Job not found' }, { status: 404 })
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const row = job as any

    if (row.status !== 'completed') {
      return NextResponse.json(
        { error: `Job is not completed (status: ${row.status})` },
        { status: 400 }
      )
    }

    if (!row.extraction_run_id) {
      return NextResponse.json(
        { error: 'Job completed but no extraction run ID found' },
        { status: 500 }
      )
    }

    // Use admin client to bypass RLS for staging data reads
    const adminSupabase = createAdminSupabaseClient()

    // Fetch staging openings
    const { data: stagingOpenings, error: openingsError } = await adminSupabase
      .from('staging_openings')
      .select('*')
      .eq('extraction_run_id', row.extraction_run_id)
      .order('door_number')

    if (openingsError) {
      return NextResponse.json(
        { error: `Failed to fetch staging openings: ${openingsError.message}` },
        { status: 500 }
      )
    }

    // Fetch staging hardware items
    const { data: stagingItems, error: itemsError } = await adminSupabase
      .from('staging_hardware_items')
      .select('*')
      .eq('extraction_run_id', row.extraction_run_id)
      .order('sort_order')

    if (itemsError) {
      return NextResponse.json(
        { error: `Failed to fetch staging items: ${itemsError.message}` },
        { status: 500 }
      )
    }

    // Build items lookup by staging_opening_id
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const itemsByOpening = new Map<string, any[]>()
    for (const item of (stagingItems ?? [])) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const openingId = (item as any).staging_opening_id
      if (!openingId) continue
      if (!itemsByOpening.has(openingId)) {
        itemsByOpening.set(openingId, [])
      }
      itemsByOpening.get(openingId)!.push(item)
    }

    // Transform to DoorEntry[] format
    const doors: DoorEntry[] = (stagingOpenings ?? []).map(o => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const r = o as any
      return {
        door_number: r.door_number,
        hw_set: r.hw_set ?? '',
        hw_heading: r.hw_heading ?? undefined,
        location: r.location ?? '',
        door_type: r.door_type ?? '',
        frame_type: r.frame_type ?? '',
        fire_rating: r.fire_rating ?? '',
        hand: r.hand ?? '',
        field_confidence: r.field_confidence ?? undefined,
        leaf_count: r.leaf_count ?? undefined,
      }
    })

    // Build HardwareSet[] from staging data
    // Group items by hw_set to reconstruct sets
    const setItemsMap = new Map<string, ExtractedHardwareItem[]>()
    const setHeadingMap = new Map<string, string>()
    const setPageMap = new Map<string, number | null>()

    for (const opening of (stagingOpenings ?? [])) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const r = opening as any
      const setId = r.hw_set
      if (!setId) continue

      if (!setHeadingMap.has(setId)) {
        setHeadingMap.set(setId, r.hw_heading ?? setId)
        setPageMap.set(setId, r.pdf_page ?? null)
      }

      const items = itemsByOpening.get(r.id) ?? []
      if (!setItemsMap.has(setId)) {
        setItemsMap.set(setId, items.map((i: Record<string, unknown>) => ({
          qty: (i.qty as number) ?? 1,
          qty_total: (i.qty_total as number) ?? undefined,
          qty_door_count: (i.qty_door_count as number) ?? undefined,
          qty_source: (i.qty_source as string) ?? undefined,
          name: (i.name as string) ?? '',
          manufacturer: (i.manufacturer as string) ?? '',
          model: (i.model as string) ?? '',
          finish: (i.finish as string) ?? '',
        })))
      }
    }

    const hardwareSets: HardwareSet[] = Array.from(setItemsMap.entries()).map(([setId, items]) => ({
      set_id: setId,
      heading: setHeadingMap.get(setId) ?? setId,
      pdf_page: setPageMap.get(setId) ?? undefined,
      items,
    }))

    return NextResponse.json({
      doors,
      hardwareSets,
      triageResult: row.extraction_summary?.triage ?? null,
      constraintFlags: row.constraint_flags,
      classifyResult: row.classify_result,
      extractionRunId: row.extraction_run_id,
    })
  } catch (error) {
    console.error('GET /api/jobs/[id]/results error:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to get results' },
      { status: 500 }
    )
  }
}
