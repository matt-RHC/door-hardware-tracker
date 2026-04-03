import { NextRequest, NextResponse } from 'next/server'
import { createAdminSupabaseClient } from '@/lib/supabase/server'
import { verifyWebhookSignature } from '@/lib/smartsheet/webhook'
import { pullSync } from '@/lib/smartsheet/sync-engine'
import { getSheet } from '@/lib/smartsheet/client'
import { PROJECT_SHEET_COLUMNS, ISSUES_SHEET_COLUMNS, DELIVERY_SHEET_COLUMNS, SUBMITTAL_SHEET_COLUMNS } from '@/lib/smartsheet/columns'
import { WebhookCallbackPayload } from '@/lib/smartsheet/types'

// HEAD â Smartsheet verification handshake
export async function HEAD(request: NextRequest) {
  const challenge = request.headers.get('smartsheet-hook-challenge')
  return new NextResponse(null, {
    status: 200,
    headers: challenge
      ? { 'smartsheet-hook-response': challenge }
      : {},
  })
}

// GET â also handle verification (some Smartsheet versions use GET)
export async function GET(request: NextRequest) {
  const challenge = request.headers.get('smartsheet-hook-challenge')
  return new NextResponse(null, {
    status: 200,
    headers: challenge
      ? { 'smartsheet-hook-response': challenge }
      : {},
  })
}

// POST â webhook callback with events
export async function POST(request: NextRequest) {
  try {
    // Handle verification challenge on POST too
    const challenge = request.headers.get('smartsheet-hook-challenge')
    if (challenge) {
      return new NextResponse(JSON.stringify({ smartsheetHookResponse: challenge }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'smartsheet-hook-response': challenge,
        },
      })
    }

    const bodyText = await request.text()
    const signature = request.headers.get('smartsheet-hook-hash') || ''

    // Look up the webhook to get the shared secret
    const payload: WebhookCallbackPayload = JSON.parse(bodyText)
    const adminSupabase = createAdminSupabaseClient()

    const { data: webhookRecord } = await (adminSupabase as any)
      .from('smartsheet_webhooks')
      .select('project_id, sheet_type, shared_secret, smartsheet_sheet_id')
      .eq('smartsheet_webhook_id', payload.webhookId)
      .single()

    if (!webhookRecord) {
      console.error('Unknown webhook ID:', payload.webhookId)
      return NextResponse.json({ error: 'Unknown webhook' }, { status: 404 })
    }

    // Verify HMAC signature
    if (signature && webhookRecord.shared_secret) {
      const valid = verifyWebhookSignature(bodyText, signature, webhookRecord.shared_secret)
      if (!valid) {
        console.error('Webhook signature verification failed')
        return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
      }
    }

    // Extract changed row IDs from events
    const changedRowIds = [...new Set(
      payload.events
        .filter(e => e.rowId)
        .map(e => e.rowId!)
    )]

    if (changedRowIds.length === 0) {
      return NextResponse.json({ ok: true, message: 'No row changes' })
    }

    // Get column definitions for this sheet type
    const columnDefs = getColumnDefsForType(webhookRecord.sheet_type)

    // Get the sheet to map column titles to IDs
    const sheet = await getSheet(webhookRecord.smartsheet_sheet_id)

    // Process changes based on sheet type
    await pullSync({
      sheetId: webhookRecord.smartsheet_sheet_id,
      projectId: webhookRecord.project_id,
      sheetType: webhookRecord.sheet_type,
      changedRowIds,
      columns: sheet.columns,
      applyChanges: async (rowId, values, localRecordId) => {
        await applyChangesForType(
          adminSupabase,
          webhookRecord.sheet_type,
          webhookRecord.project_id,
          rowId,
          values,
          localRecordId
        )
      },
    })

    return NextResponse.json({ ok: true, processed: changedRowIds.length })
  } catch (error) {
    console.error('Webhook processing error:', error)
    // Always return 200 to prevent Smartsheet from disabling the webhook
    return NextResponse.json({ ok: true, error: 'Processing error logged' })
  }
}

function getColumnDefsForType(sheetType: string) {
  switch (sheetType) {
    case 'project': return PROJECT_SHEET_COLUMNS
    case 'issues': return ISSUES_SHEET_COLUMNS
    case 'delivery': return DELIVERY_SHEET_COLUMNS
    case 'submittal': return SUBMITTAL_SHEET_COLUMNS
    default: return PROJECT_SHEET_COLUMNS
  }
}

async function applyChangesForType(
  adminSupabase: any,
  sheetType: string,
  projectId: string,
  rowId: number,
  values: Record<string, any>,
  localRecordId: string | null
) {
  switch (sheetType) {
    case 'project':
      // For project sheets, only pull status-related changes
      // Structural data (door number, hw set, etc.) is app-authoritative
      if (localRecordId) {
        // We could update classification or status here if needed
        // For now, project sheet is primarily push-only with status awareness
      }
      break

    case 'issues':
      if (localRecordId) {
        // Update existing issue â Smartsheet wins for all fields
        await (adminSupabase as any)
          .from('issues')
          .update({
            description: values['Description'] || undefined,
            severity: (values['Severity'] || '').toLowerCase() || undefined,
            status: (values['Status'] || '').toLowerCase().replace(' ', '_') || undefined,
            assigned_to: values['Assigned To'] || undefined,
            notes: values['Notes'] || undefined,
            date_resolved: values['Date Resolved'] || undefined,
            updated_at: new Date().toISOString(),
          })
          .eq('id', localRecordId)
      } else {
        // New issue from Smartsheet â create locally
        const issueCount = await (adminSupabase as any)
          .from('issues')
          .select('id', { count: 'exact', head: true })
          .eq('project_id', projectId)
        const seq = ((issueCount as any).count || 0) + 1
        await (adminSupabase as any)
          .from('issues')
          .insert({
            project_id: projectId,
            door_number: values['Door Number'] || null,
            hardware_item_name: values['Hardware Item'] || null,
            issue_id_short: values['Issue ID'] || `ISS-${seq}`,
            description: values['Description'] || 'Issue from Smartsheet',
            severity: (values['Severity'] || 'medium').toLowerCase(),
            status: (values['Status'] || 'open').toLowerCase().replace(' ', '_'),
            assigned_to: values['Assigned To'] || null,
            reported_by: values['Reported By'] || 'Smartsheet',
            notes: values['Notes'] || null,
          })
      }
      break

    case 'delivery':
      if (localRecordId) {
        // Update existing delivery â Smartsheet wins
        await (adminSupabase as any)
          .from('deliveries')
          .update({
            vendor: values['Vendor'] || undefined,
            description: values['Description'] || undefined,
            items_summary: values['Items'] || undefined,
            quantity: values['Quantity'] ? parseInt(values['Quantity']) : undefined,
            expected_date: values['Expected Date'] || undefined,
            actual_date: values['Actual Date'] || undefined,
            status: (values['Status'] || '').toLowerCase().replace(' ', '_') || undefined,
            tracking_number: values['Tracking Number'] || undefined,
            notes: values['Notes'] || undefined,
            updated_at: new Date().toISOString(),
          })
          .eq('id', localRecordId)
      } else {
        // New delivery from Smartsheet
        await (adminSupabase as any)
          .from('deliveries')
          .insert({
            project_id: projectId,
            po_number: values['PO Number'] || null,
            vendor: values['Vendor'] || null,
            description: values['Description'] || null,
            items_summary: values['Items'] || null,
            quantity: values['Quantity'] ? parseInt(values['Quantity']) : null,
            expected_date: values['Expected Date'] || null,
            actual_date: values['Actual Date'] || null,
            status: (values['Status'] || 'pending').toLowerCase().replace(' ', '_'),
            tracking_number: values['Tracking Number'] || null,
            notes: values['Notes'] || null,
          })
      }
      break

    case 'submittal':
      // Submittal tracker â pull status updates only
      if (localRecordId) {
        // Could update submittal status on openings if we track it
      }
      break
  }
}
