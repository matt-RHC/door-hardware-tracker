// Webhook registration and verification helpers

import { createWebhook, enableWebhook } from './client'
import { createAdminSupabaseClient } from '@/lib/supabase/server'
import { SheetType } from './types'
import crypto from 'crypto'

function getWebhookSecret(): string {
  const secret = process.env.SMARTSHEET_WEBHOOK_SECRET
  if (!secret) throw new Error('SMARTSHEET_WEBHOOK_SECRET environment variable is not set')
  return secret
}

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

  const secret = getWebhookSecret()

  // Create webhook in Smartsheet
  const webhook = await createWebhook(
    sheetId,
    `DHT - ${sheetName} (${sheetType})`,
    callbackUrl,
    secret
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
      shared_secret: secret,
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
  const computedBuf = Buffer.from(computed)
  const signatureBuf = Buffer.from(signature)
  // timingSafeEqual throws if buffers differ in length — reject early
  if (computedBuf.length !== signatureBuf.length) return false
  return crypto.timingSafeEqual(computedBuf, signatureBuf)
}
