import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { createAdminSupabaseClient } from '@/lib/supabase/admin'

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

    // Verify membership
    const { data: member } = await supabase
      .from('project_members')
      .select('role')
      .eq('project_id', projectId)
      .eq('user_id', user.id)
      .single()

    if (!member) {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 })
    }

    const admin = createAdminSupabaseClient()

    // Fetch project metadata
    const { data: project } = await admin
      .from('projects')
      .select('name, job_number, general_contractor, architect, address, submittal_date')
      .eq('id', projectId)
      .single()

    // Fetch all openings with hardware items, checklist, and attachments
    const { data: openings } = await admin
      .from('openings')
      .select(`
        id,
        hardware_items(id, install_type),
        checklist_progress(id, checked, received, pre_install, installed, qa_qc),
        attachments(id, category)
      `)
      .eq('project_id', projectId)

    if (!openings) {
      return NextResponse.json({
        project,
        totals: { openings: 0, hardware_items: 0, checked: 0 },
        classification: { bench: 0, field: 0, unclassified: 0 },
        workflow: { received: 0, pre_install: 0, installed: 0, qa_qc: 0 },
        attachments: { floor_plan: 0, door_drawing: 0, frame_drawing: 0, total: 0 },
        openings_complete: 0,
        openings_incomplete: 0,
      })
    }

    let totalItems = 0
    let totalChecked = 0
    let bench = 0
    let field = 0
    let unclassified = 0
    let received = 0
    let preInstall = 0
    let installed = 0
    let qaQc = 0
    let openingsComplete = 0
    let openingsIncomplete = 0
    const attachmentCategories: Record<string, number> = {
      floor_plan: 0,
      door_drawing: 0,
      frame_drawing: 0,
    }
    let totalAttachments = 0

    // Track openings that have at least one drawing in each category
    let openingsWithFloorPlan = 0
    let openingsWithDoorDrawing = 0
    let openingsWithFrameDrawing = 0

    for (const opening of openings) {
      const items = opening.hardware_items as Array<{ id: string; install_type: string | null }> || []
      const checklists = opening.checklist_progress as Array<{
        id: string; checked: boolean;
        received: boolean | null; pre_install: boolean | null;
        installed: boolean | null; qa_qc: boolean | null;
      }> || []
      const atts = opening.attachments as Array<{ id: string; category: string }> || []

      totalItems += items.length
      totalChecked += checklists.filter(c => c.checked).length

      // Classification
      for (const item of items) {
        if (item.install_type === 'bench') bench++
        else if (item.install_type === 'field') field++
        else unclassified++
      }

      // Workflow
      for (const c of checklists) {
        if (c.received) received++
        if (c.pre_install) preInstall++
        if (c.installed) installed++
        if (c.qa_qc) qaQc++
      }

      // Completion
      const itemCount = items.length
      const checkedCount = checklists.filter(c => c.checked).length
      if (itemCount > 0 && checkedCount >= itemCount) {
        openingsComplete++
      } else {
        openingsIncomplete++
      }

      // Attachments
      let hasFloor = false, hasDoor = false, hasFrame = false
      for (const att of atts) {
        totalAttachments++
        if (att.category in attachmentCategories) {
          attachmentCategories[att.category]++
        }
        if (att.category === 'floor_plan') hasFloor = true
        if (att.category === 'door_drawing') hasDoor = true
        if (att.category === 'frame_drawing') hasFrame = true
      }
      if (hasFloor) openingsWithFloorPlan++
      if (hasDoor) openingsWithDoorDrawing++
      if (hasFrame) openingsWithFrameDrawing++
    }

    return NextResponse.json({
      project,
      totals: {
        openings: openings.length,
        hardware_items: totalItems,
        checked: totalChecked,
      },
      classification: { bench, field, unclassified },
      workflow: {
        received,
        pre_install: preInstall,
        installed,
        qa_qc: qaQc,
      },
      attachments: {
        floor_plan: openingsWithFloorPlan,
        door_drawing: openingsWithDoorDrawing,
        frame_drawing: openingsWithFrameDrawing,
        total: totalAttachments,
      },
      openings_complete: openingsComplete,
      openings_incomplete: openingsIncomplete,
    })
  } catch (error) {
    console.error('Summary GET error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
