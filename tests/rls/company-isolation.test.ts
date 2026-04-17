/**
 * RLS cross-tenant isolation suite.
 *
 * Spins up two companies ("acme" and "initech") with one user each, one
 * project each, and asserts no CRUD bleeds across the boundary.
 *
 * Requires a running Postgres with migrations 001–042 applied, plus the
 * storage.buckets `attachments` and `submittals`. The CI job stands up a
 * Postgres 17 service container and applies migrations via
 * `supabase db push --db-url` before calling this file.
 *
 * Skipped automatically when RLS_TEST_DATABASE_URL is unset, so local
 * `npm run test` stays green without a database.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createClient, SupabaseClient } from '@supabase/supabase-js'

const RLS_URL = process.env.RLS_TEST_SUPABASE_URL
const RLS_ANON = process.env.RLS_TEST_ANON_KEY
const RLS_SERVICE = process.env.RLS_TEST_SERVICE_ROLE_KEY

const shouldRun = Boolean(RLS_URL && RLS_ANON && RLS_SERVICE)
const describeOrSkip = shouldRun ? describe : describe.skip

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = SupabaseClient<any>

interface Fixture {
  companyId: string
  userId: string
  userEmail: string
  userPassword: string
  projectId: string
  openingId: string
  client: AnyClient
}

async function signUpAndMint(
  admin: AnyClient,
  email: string,
  password: string,
  companyId: string,
): Promise<Fixture> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: created, error: createErr } = await (admin.auth.admin as any)
    .createUser({ email, password, email_confirm: true })
  if (createErr || !created?.user) throw createErr ?? new Error('createUser failed')
  const userId = (created.user as { id: string }).id

  // Seed company_member (bypasses trigger if domain wasn't registered).
  const { error: memberErr } = await (admin as AnyClient)
    .from('company_members')
    .insert({ company_id: companyId, user_id: userId, role: 'member', is_default: true })
  if (memberErr) throw memberErr

  // Stamp JWT so middleware-style checks see it.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (admin.auth.admin as any).updateUserById(userId, {
    app_metadata: { company_id: companyId },
  })

  // Create a project owned by this company.
  const { data: projectRow, error: projectErr } = await (admin as AnyClient)
    .from('projects')
    .insert({ name: `${email} project`, created_by: userId, company_id: companyId })
    .select('id')
    .single()
  if (projectErr || !projectRow) throw projectErr ?? new Error('project insert failed')
  const projectId = (projectRow as { id: string }).id

  const { error: pmErr } = await (admin as AnyClient)
    .from('project_members')
    .insert({ project_id: projectId, user_id: userId, role: 'admin' })
  if (pmErr) throw pmErr

  const { data: openingRow, error: openingErr } = await (admin as AnyClient)
    .from('openings')
    .insert({ project_id: projectId, door_number: '101' })
    .select('id')
    .single()
  if (openingErr || !openingRow) throw openingErr ?? new Error('opening insert failed')

  // Authenticate the user-scoped client.
  const client = createClient(RLS_URL!, RLS_ANON!)
  const { error: signInErr } = await client.auth.signInWithPassword({ email, password })
  if (signInErr) throw signInErr

  return {
    companyId,
    userId,
    userEmail: email,
    userPassword: password,
    projectId,
    openingId: (openingRow as { id: string }).id,
    client,
  }
}

describeOrSkip('company isolation RLS', () => {
  // Lazy init — `describeOrSkip` stops the `it` blocks from running when
  // the RLS_TEST_* env vars are absent, but vitest still evaluates the
  // describe body during collection, so a top-level `createClient('', '')`
  // would throw `supabaseUrl is required` and fail the whole file even
  // though we meant to skip it. Deferring to beforeAll keeps the file
  // loadable in environments without Supabase creds (local dev, the
  // default test-ts CI job).
  let admin: AnyClient
  let acme: Fixture
  let initech: Fixture

  beforeAll(async () => {
    admin = createClient(RLS_URL!, RLS_SERVICE!, {
      auth: { autoRefreshToken: false, persistSession: false },
    }) as AnyClient

    const { data: acmeCompany, error: acmeErr } = await admin
      .from('companies')
      .insert({ name: 'Acme', slug: `acme-${Date.now()}` })
      .select('id')
      .single()
    if (acmeErr) throw acmeErr
    const { data: initechCompany, error: initechErr } = await admin
      .from('companies')
      .insert({ name: 'Initech', slug: `initech-${Date.now()}` })
      .select('id')
      .single()
    if (initechErr) throw initechErr

    acme = await signUpAndMint(
      admin,
      `acme-${Date.now()}@example.test`,
      'pw-acme-123456',
      (acmeCompany as { id: string }).id,
    )
    initech = await signUpAndMint(
      admin,
      `initech-${Date.now()}@example.test`,
      'pw-initech-123456',
      (initechCompany as { id: string }).id,
    )
  })

  afterAll(async () => {
    if (!acme || !initech) return
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (admin.auth.admin as any).deleteUser(acme.userId)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (admin.auth.admin as any).deleteUser(initech.userId)
    await admin.from('companies').delete().in('id', [acme.companyId, initech.companyId])
  })

  it('cross-tenant project SELECT is empty', async () => {
    const { data } = await acme.client
      .from('projects')
      .select('id')
      .eq('id', initech.projectId)
    expect(data ?? []).toHaveLength(0)
  })

  it('cross-tenant openings SELECT is empty', async () => {
    const { data } = await acme.client
      .from('openings')
      .select('id')
      .eq('project_id', initech.projectId)
    expect(data ?? []).toHaveLength(0)
  })

  it('cross-tenant opening INSERT is rejected', async () => {
    const { error } = await acme.client
      .from('openings')
      .insert({ project_id: initech.projectId, door_number: 'X1' })
    expect(error).not.toBeNull()
  })

  it('cross-tenant hardware_items UPDATE is a no-op', async () => {
    // First create an item directly against initech via admin
    const { data: item } = await (admin as AnyClient)
      .from('hardware_items')
      .insert({ opening_id: initech.openingId, name: 'Hinge', qty: 1 })
      .select('id')
      .single()
    expect(item).toBeTruthy()

    const { data: updated } = await acme.client
      .from('hardware_items')
      .update({ name: 'Hacked' })
      .eq('id', (item as { id: string }).id)
      .select('id')
    expect(updated ?? []).toHaveLength(0)
  })

  it('self-insert into company_members is rejected', async () => {
    const { error } = await acme.client
      .from('company_members')
      .insert({ company_id: initech.companyId, user_id: acme.userId, role: 'member' })
    expect(error).not.toBeNull()
  })

  it('storage buckets are private', async () => {
    const { data, error } = await admin.storage.listBuckets()
    expect(error).toBeNull()
    const buckets = (data ?? []) as Array<{ id: string; public: boolean }>
    for (const id of ['attachments', 'submittals'] as const) {
      const bucket = buckets.find((b) => b.id === id)
      if (bucket) expect(bucket.public).toBe(false)
    }
  })

  it('cross-tenant storage download is denied', async () => {
    // Put a file in initech's project folder via admin so it's truly cross-tenant.
    const path = `${initech.projectId}/rls-test-${Date.now()}.txt`
    const buf = new TextEncoder().encode('secret')
    // Explicit contentType so the bucket's allowed_mime_types (set on
    // CI's local Supabase but not on prod) doesn't 415 the upload
    // before the RLS check runs.
    const { error: upErr } = await admin.storage
      .from('attachments')
      .upload(path, buf, { contentType: 'application/octet-stream' })
    expect(upErr).toBeNull()

    const { data, error } = await acme.client.storage.from('attachments').download(path)
    expect(data).toBeNull()
    expect(error).not.toBeNull()

    await admin.storage.from('attachments').remove([path])
  })

  // Regression fence for blockers #2 + #3 from the PR #277 review:
  // issue-evidence had no RLS, and old uploads put a literal string in
  // segment 1 of the path. Migration 043 fixed both; this test holds
  // the line by mirroring the attachments cross-tenant denial against
  // the new layout.
  it('cross-tenant issue-evidence download is denied', async () => {
    const fakeIssueId = '00000000-0000-0000-0000-000000000001'
    const path = `${initech.projectId}/${fakeIssueId}/rls-test-${Date.now()}.txt`
    const buf = new TextEncoder().encode('secret')
    const { error: upErr } = await admin.storage
      .from('issue-evidence')
      .upload(path, buf, { contentType: 'application/octet-stream' })
    expect(upErr).toBeNull()

    const { data, error } = await acme.client.storage.from('issue-evidence').download(path)
    expect(data).toBeNull()
    expect(error).not.toBeNull()

    await admin.storage.from('issue-evidence').remove([path])
  })
})
