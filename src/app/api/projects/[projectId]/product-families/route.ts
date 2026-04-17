import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import {
  validateJson,
  errorResponse,
} from '@/lib/api-helpers/validate'
import { ProductFamilyUpsertRequestSchema } from '@/lib/schemas/product-families'

async function requireProjectMember(projectId: string) {
  const supabase = await createServerSupabaseClient()
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser()
  if (authError || !user) {
    return { ok: false as const, response: errorResponse('AUTH_REQUIRED', 'You must be signed in') }
  }
  const { data: member, error: memberError } = await supabase
    .from('project_members')
    .select('role')
    .eq('project_id', projectId)
    .eq('user_id', user.id)
    .single()
  if (memberError || !member) {
    return {
      ok: false as const,
      response: errorResponse('ACCESS_DENIED', 'Access denied to this project'),
    }
  }
  return { ok: true as const, supabase, user }
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await params
  const guard = await requireProjectMember(projectId)
  if (!guard.ok) return guard.response

  const { data, error } = await guard.supabase
    .from('product_families')
    .select(
      'id, project_id, manufacturer, base_series, canonical_model, category, variants, created_by, created_at, updated_at',
    )
    .eq('project_id', projectId)
    .order('manufacturer', { ascending: true })
    .order('base_series', { ascending: true })

  if (error) {
    console.error('product-families GET error:', error)
    return errorResponse('INTERNAL_ERROR', 'Failed to load product families')
  }

  return NextResponse.json(data ?? [])
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await params
  const guard = await requireProjectMember(projectId)
  if (!guard.ok) return guard.response

  const parsed = await validateJson(req, ProductFamilyUpsertRequestSchema)
  if (!parsed.ok) return parsed.response
  const body = parsed.data

  const { data, error } = await guard.supabase
    .from('product_families')
    .upsert(
      {
        project_id: projectId,
        manufacturer: body.manufacturer,
        base_series: body.base_series,
        canonical_model: body.canonical_model,
        category: body.category ?? null,
        variants: body.variants,
        created_by: guard.user.id,
      },
      { onConflict: 'project_id,manufacturer,base_series' },
    )
    .select()
    .single()

  if (error) {
    console.error('product-families POST error:', error)
    return errorResponse('INTERNAL_ERROR', 'Failed to save product family')
  }

  return NextResponse.json(data, { status: 201 })
}
