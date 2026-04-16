import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import type { OpeningWithHardware } from '@/lib/types/database'

function escapeCSV(value: string | null | undefined): string {
  if (value == null || value === '') return ''
  const str = String(value)
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`
  }
  return str
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

    // Get project name for filename
    const { data: project } = await supabase
      .from('projects')
      .select('name, job_number')
      .eq('id', projectId)
      .single() as { data: { name: string; job_number: string | null } | null }

    // Get all openings with hardware items and checklist status
    const { data: openings, error: openingsError } = await supabase
      .from('openings')
      .select(`
        id,
        door_number,
        hw_set,
        hw_heading,
        location,
        door_type,
        frame_type,
        fire_rating,
        hand,
        notes,
        hardware_items(
          id,
          name,
          qty,
          manufacturer,
          model,
          finish,
          sort_order,
          leaf_side,
          checklist_progress(checked)
        )
      `)
      .eq('project_id', projectId)
      .eq('is_active', true)
      .order('door_number', { ascending: true }) as { data: OpeningWithHardware[] | null; error: any }

    if (openingsError) {
      console.error('CSV export error:', openingsError)
      return NextResponse.json({ error: 'Failed to fetch data' }, { status: 500 })
    }

    // Build CSV: one row per hardware item, grouped by door
    const headers = [
      'Door Number',
      'HW Set',
      'HW Set Description',
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
      'Checked',
      'Notes',
    ]

    const rows: string[] = [headers.map(escapeCSV).join(',')]

    for (const opening of (openings || [])) {
      const items = opening.hardware_items || []
      // Sort by sort_order
      items.sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))

      if (items.length === 0) {
        // Still include the door even if no hardware items
        rows.push([
          escapeCSV(opening.door_number),
          escapeCSV(opening.hw_set),
          escapeCSV(opening.hw_heading),
          escapeCSV(opening.location),
          escapeCSV(opening.door_type),
          escapeCSV(opening.frame_type),
          escapeCSV(opening.fire_rating),
          escapeCSV(opening.hand),
          '', '', '', '', '',
          '',
          escapeCSV(opening.notes),
        ].join(','))
      } else {
        for (const item of items) {
          const checked = item.checklist_progress?.some(cp => cp.checked) ? 'Yes' : 'No'
          rows.push([
            escapeCSV(opening.door_number),
            escapeCSV(opening.hw_set),
            escapeCSV(opening.hw_heading),
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
            escapeCSV(checked),
            escapeCSV(opening.notes),
          ].join(','))
        }
      }
    }

    const csv = rows.join('\n')
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
