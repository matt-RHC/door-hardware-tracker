// Webhook registration and verification helpers

import { createWebhook, enableWebhook } from './client'
import { createAdminSupabaseClient } from '@/lib/supabase/server'
import { SheetType } from './types'
import crypto from 'crypto'

const WEBHOOK_SECRET = process.env.SMARTSHEET_WEBHOOK_SECRET || 'dht_webhook_secret_v1'

export async function registerWebhook(params: {
  sheetId: number
  projectId: string
  sheetType: SheetType
  sheetName: string
}): Promise<{ webhookId: number }> {
  const { sheetId, projectId, sheetType, sheetName } = params
  const callbackUrl = process.env.SMARTSHEET_WEBHOOK_URL
  if (!callbackUrl) {
    throw new Error('SMARTSHEET_WEBHOOK_URL not configured')
  }

  const adminSupabase = createAdminSupabaseClient()

  // Check if webhook already exists for this sheet
  const { data: existing } = await (adminSupabase as any)
    .from('smartsheet_webhooks')
    .select('smartsheet_webhook_id')
    .eq('smartsheet_sheet_id', sheetId)
    .eq('sheet_type', sheetType)
    .single()

  if (existing) {
    return { webhookId: existing.smartsheet_webhook_id }
  }

  // Create webhook in Smartsheet
  const webhook = await createWebhook(
    sheetId,
    `DHT - ${sheetName} (${sheetType})`,
    callbackUrl,
    WEBHOOK_SECRET
  )

  // Store in DB
  await (adminSupabase as any)
    .from('smartsheet_webhooks')
    .insert({
      project_id: projectId,
      sheet_type: sheetType,
      smartsheet_webhook_id: webhook.id,
      smartsheet_sheet_id: sheetId,
      callback_url: callbackUrl,
      status: 'NEW_NOT_VERIFIED',
      shared_secret: WEBHOOK_SECRET,
    })

  // Enable the webhook (triggers verification handshake)
  try {
    await enableWebhook(webhook.id)
    await (adminSupabase as any)
      .from('smartsheet_webhooks')
      .update({ status: 'ENABLED' })
      .eq('smartsheet_webhook_id', webhook.id)
  } catch (err) {
    console.error('Failed to enable webhook:', err)
    // Will be enabled on next verification attempt
  }

  return { webhookId: webhook.id }
}

// Verify HMAC signature from Smartsheet webhook callback
export function verifyWebhookSignature(body: string, signature: string, secret: string): boolean {
  const hmac = crypto.createHmac('sha256', secret)
  hmac.update(body)
  const computed = hmac.digest('hex')
  return crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(signature))
}
