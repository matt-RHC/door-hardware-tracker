import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import type { OpeningWithHardware } from '@/lib/types/database'
import { OPENING_COLUMNS, HARDWARE_ITEM_COLUMNS } from '@/lib/supabase-selects'

function escapeCSV(value: string | null | undefined): string {
  if (value == null || value === '') return ''
  const str = String(value)
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`
  }
  return str
}

/** Interpret a query flag as a strict boolean ("true" | "1" → true). */
function parseBoolFlag(value: string | null): boolean | null {
  if (value == null) return null
  const v = value.toLowerCase()
  if (v === 'true' || v === '1' || v === 'yes') return true
  if (v === 'false' || v === '0' || v === 'no') return false
  return null
}

/** Does a fire_rating string represent a rated door? Mirrors tracking-items logic. */
function isFireRated(value: string | null | undefined): boolean {
  if (!value) return false
  const normalized = value.trim().toLowerCase()
  if (normalized === '' || normalized === 'n/a' || normalized === 'none') return false
  return true
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  try {
    const supabase = await createServerSupabaseClient()

    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { projectId } = await params

    // Verify project access
    const { data: projectMember } = await supabase
      .from('project_members')
      .select('role')
      .eq('project_id', projectId)
      .eq('user_id', user.id)
      .single()

    if (!projectMember) {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 })
    }

    // ── Query params ──
    const url = new URL(request.url)
    const floorParam = url.searchParams.get('floor')
    const floorFilter = floorParam != null && floorParam !== '' ? Number(floorParam) : null
    const fireRatedFilter = parseBoolFlag(url.searchParams.get('fire_rated'))
    const issuesOnly = parseBoolFlag(url.searchParams.get('issues_only')) === true
    const hwSetFilter = url.searchParams.get('hw_set')

    // Get project name for filename
    const { data: project } = await supabase
      .from('projects')
      .select('name, job_number')
      .eq('id', projectId)
      .single() as { data: { name: string; job_number: string | null } | null }

    // Get all openings with hardware items and checklist status
    let query = supabase
      .from('openings')
      .select(`
        ${OPENING_COLUMNS},
        hardware_items(
          ${HARDWARE_ITEM_COLUMNS},
          checklist_progress(checked)
        )
      `)
      .eq('project_id', projectId)
      .eq('is_active', true)

    if (floorFilter != null && Number.isFinite(floorFilter)) {
      query = query.eq('floor_number', floorFilter)
    }
    if (hwSetFilter) {
      query = query.eq('hw_set', hwSetFilter)
    }

    const { data: openings, error: openingsError } = await query
      .order('door_number', { ascending: true }) as { data: OpeningWithHardware[] | null; error: unknown }

    if (openingsError) {
      console.error('CSV export error:', openingsError)
      return NextResponse.json({ error: 'Failed to fetch data' }, { status: 500 })
    }

    // Post-query filters (fire_rated and issues_only need computed/semantic checks)
    let filteredOpenings = openings ?? []
    if (fireRatedFilter !== null) {
      filteredOpenings = filteredOpenings.filter((o) =>
        fireRatedFilter ? isFireRated(o.fire_rating) : !isFireRated(o.fire_rating),
      )
    }
    if (issuesOnly) {
      // Definition: an opening has an "issue" if it has zero hardware items.
      // Additional issue definitions (missing required fields, QA findings)
      // can be layered on later without breaking the param contract.
      filteredOpenings = filteredOpenings.filter(
        (o) => (o.hardware_items ?? []).length === 0,
      )
    }

    // Build CSV: one row per hardware item, grouped by door.
    //
    // Pair-door note: split-placement items (closer, kick plate, hinges,
    // etc.) appear as two CSV rows — one per leaf — with leaf_side set to
    // 'active'/'inactive'. This mirrors the per-leaf row emission from
    // buildPerOpeningItems and reflects real installed counts. See
    // PAIR_LEAF_PLACEMENT in hardware-taxonomy.ts.
    const headers = [
      'Door Number',
      'HW Set',
      'HW Set Description',
      'Floor',
      'Location',
      'Door Type',
      'Frame Type',
      'Fire Rating',
      'Hand',
      'Item Name',
      'Qty',
      'Manufacturer',
      'Model',
      'Finish',
      'Extraction Source',
      'Checked',
      // 'Notes' column removed in migration 054 (audit finding #10).
      // Future: wire to opening-scope notes from the new notes table
      // when the punch-notes export work lands (PR 6).
    ]

    const rows: string[] = [headers.map(escapeCSV).join(',')]

    for (const opening of filteredOpenings) {
      const items = opening.hardware_items || []
      items.sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))

      const floorCell = opening.floor_number != null ? String(opening.floor_number) : ''

      if (items.length === 0) {
        rows.push([
          escapeCSV(opening.door_number),
          escapeCSV(opening.hw_set),
          escapeCSV(opening.hw_heading),
          escapeCSV(floorCell),
          escapeCSV(opening.location),
          escapeCSV(opening.door_type),
          escapeCSV(opening.frame_type),
          escapeCSV(opening.fire_rating),
          escapeCSV(opening.hand),
          '', '', '', '', '',
          '',
          '',
        ].join(','))
      } else {
        for (const item of items) {
          const checked = item.checklist_progress?.some((cp) => cp.checked) ? 'Yes' : 'No'
          rows.push([
            escapeCSV(opening.door_number),
            escapeCSV(opening.hw_set),
            escapeCSV(opening.hw_heading),
            escapeCSV(floorCell),
            escapeCSV(opening.location),
            escapeCSV(opening.door_type),
            escapeCSV(opening.frame_type),
            escapeCSV(opening.fire_rating),
            escapeCSV(opening.hand),
            escapeCSV(item.name),
            escapeCSV(String(item.qty)),
            escapeCSV(item.manufacturer),
            escapeCSV(item.model),
            escapeCSV(item.finish),
            escapeCSV(item.qty_source),
            escapeCSV(checked),
          ].join(','))
        }
      }
    }

    // Prepend UTF-8 BOM so Excel correctly detects the encoding
    const csv = '\uFEFF' + rows.join('\n')
    const projectName = project?.name?.replace(/[^a-zA-Z0-9]/g, '_') || 'project'
    const date = new Date().toISOString().split('T')[0]
    const filename = `${projectName}_hardware_export_${date}.csv`

    return new Response(csv, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
    })
  } catch (error) {
    console.error('CSV export error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
