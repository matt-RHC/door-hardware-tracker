import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { validateJson, errorResponse } from '@/lib/api-helpers/validate'
import { ProductFamilyPatchRequestSchema } from '@/lib/schemas/product-families'

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
  { params }: { params: Promise<{ projectId: string; familyId: string }> },
) {
  const { projectId, familyId } = await params
  const guard = await requireProjectMember(projectId)
  if (!guard.ok) return guard.response

  const { data, error } = await guard.supabase
    .from('product_families')
    .select()
    .eq('project_id', projectId)
    .eq('id', familyId)
    .single()

  if (error || !data) {
    return errorResponse('NOT_FOUND', 'Product family not found')
  }
  return NextResponse.json(data)
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string; familyId: string }> },
) {
  const { projectId, familyId } = await params
  const guard = await requireProjectMember(projectId)
  if (!guard.ok) return guard.response

  const parsed = await validateJson(req, ProductFamilyPatchRequestSchema)
  if (!parsed.ok) return parsed.response

  const updates: Record<string, unknown> = {}
  if (parsed.data.canonical_model !== undefined)
    updates.canonical_model = parsed.data.canonical_model
  if (parsed.data.category !== undefined) updates.category = parsed.data.category
  if (parsed.data.variants !== undefined) updates.variants = parsed.data.variants

  const { data, error } = await guard.supabase
    .from('product_families')
    .update(updates)
    .eq('project_id', projectId)
    .eq('id', familyId)
    .select()
    .single()

  if (error || !data) {
    return errorResponse('NOT_FOUND', 'Product family not found')
  }
  return NextResponse.json(data)
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ projectId: string; familyId: string }> },
) {
  const { projectId, familyId } = await params
  const guard = await requireProjectMember(projectId)
  if (!guard.ok) return guard.response

  const { error } = await guard.supabase
    .from('product_families')
    .delete()
    .eq('project_id', projectId)
    .eq('id', familyId)

  if (error) {
    console.error('product-families DELETE error:', error)
    return errorResponse('INTERNAL_ERROR', 'Failed to delete product family')
  }
  return NextResponse.json({ success: true })
}
