import { SupabaseClient } from '@supabase/supabase-js'

/**
 * Verify the user has access to a project. Throws if not a member.
 * Uses the user-scoped Supabase client (respects RLS).
 *
 * @throws Error with status 403 if user is not a project member
 */
export async function assertProjectMember(
  supabase: SupabaseClient,
  userId: string,
  projectId: string,
): Promise<void> {
  const { data, error } = await supabase
    .from('project_members')
    .select('role')
    .eq('project_id', projectId)
    .eq('user_id', userId)
    .single()

  if (error) {
    // Distinguish "not found" (no membership) from actual DB errors
    if (error.code === 'PGRST116') {
      const err = new Error('Access denied to this project')
      ;(err as any).status = 403
      throw err
    }
    // Genuine database error — propagate as 500
    const err = new Error(`Database error checking project membership: ${error.message}`)
    ;(err as any).status = 500
    throw err
  }
  if (!data) {
    const err = new Error('Access denied to this project')
    ;(err as any).status = 403
    throw err
  }
}
