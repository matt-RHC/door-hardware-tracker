// GET /api/admin/tracking/items
//
// Read endpoint for the /admin/tracking dashboard. Returns all tracking_items,
// optionally filtered by record_type. Admin-only.
//
// Query params:
//   ?type=plan_item|session|metric_run  (optional)
//   ?status=<status>                     (optional — exact match)
//   ?relevance=<relevance>               (optional — exact match)

import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient, createAdminSupabaseClient } from '@/lib/supabase/server'
import { requireTrackingAdmin, TrackingRecordType } from '@/lib/tracking/constants'

export const runtime = 'nodejs'

export async function GET(request: NextRequest) {
  const supabase = await createServerSupabaseClient()
  const auth = await requireTrackingAdmin(supabase)
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status })
  }

  const url = new URL(request.url)
  const typeFilter = url.searchParams.get('type') as TrackingRecordType | null
  const statusFilter = url.searchParams.get('status')
  const relevanceFilter = url.searchParams.get('relevance')

  const admin = createAdminSupabaseClient()
  let query = admin
    .from('tracking_items')
    .select('*')
    .order('record_type', { ascending: true })
    .order('date_identified', { ascending: false, nullsFirst: false })

  if (typeFilter) query = query.eq('record_type', typeFilter)
  if (statusFilter) query = query.eq('status', statusFilter)
  if (relevanceFilter) query = query.eq('relevance', relevanceFilter)

  const { data, error } = await query
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ items: data ?? [], count: data?.length ?? 0 })
}
