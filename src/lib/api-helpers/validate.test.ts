import { describe, it, expect } from 'vitest'
import { NextRequest } from 'next/server'
import { z } from 'zod'
import {
  validateJson,
  validateUpstream,
  errorResponse,
} from '@/lib/api-helpers/validate'

function makeRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost/test', {
    method: 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })
}

const SampleSchema = z.object({
  projectId: z.string().uuid(),
  count: z.number().int().positive(),
})

describe('validateJson', () => {
  it('returns typed data for valid input', async () => {
    const req = makeRequest({
      projectId: '12345678-1234-4123-8123-123456789012',
      count: 5,
    })
    const result = await validateJson(req, SampleSchema)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.projectId).toBe('12345678-1234-4123-8123-123456789012')
      expect(result.data.count).toBe(5)
    }
  })

  it('returns a 400 response with VALIDATION_ERROR details for bad input', async () => {
    const req = makeRequest({ projectId: 'not-a-uuid', count: -1 })
    const result = await validateJson(req, SampleSchema)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.response.status).toBe(400)
      const body = await result.response.json()
      expect(body.code).toBe('VALIDATION_ERROR')
      expect(Array.isArray(body.details)).toBe(true)
      expect(body.details.length).toBeGreaterThan(0)
      expect(body.details[0]).toHaveProperty('path')
      expect(body.details[0]).toHaveProperty('message')
    }
  })

  it('returns 400 for malformed JSON', async () => {
    const req = makeRequest('{ not json')
    const result = await validateJson(req, SampleSchema)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.response.status).toBe(400)
      const body = await result.response.json()
      expect(body.code).toBe('VALIDATION_ERROR')
      expect(body.error).toMatch(/not valid JSON/i)
    }
  })
})

describe('validateUpstream', () => {
  it('returns a 502 response when upstream shape is wrong', () => {
    const result = validateUpstream(SampleSchema, { wrong: 'shape' }, 'Python pipeline')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.response.status).toBe(502)
    }
  })

  it('passes through a valid upstream payload', () => {
    const value = { projectId: '12345678-1234-4123-8123-123456789012', count: 3 }
    const result = validateUpstream(SampleSchema, value, 'Python pipeline')
    expect(result.ok).toBe(true)
  })
})

describe('errorResponse', () => {
  it('maps each code to the correct HTTP status', async () => {
    expect(errorResponse('AUTH_REQUIRED', 'x').status).toBe(401)
    expect(errorResponse('ACCESS_DENIED', 'x').status).toBe(403)
    expect(errorResponse('NOT_FOUND', 'x').status).toBe(404)
    expect(errorResponse('CONFLICT', 'x').status).toBe(409)
    expect(errorResponse('INTERNAL_ERROR', 'x').status).toBe(500)
    expect(errorResponse('UPSTREAM_ERROR', 'x').status).toBe(502)
  })

  it('includes details when provided', async () => {
    const resp = errorResponse('VALIDATION_ERROR', 'bad', [{ path: 'a', message: 'b' }])
    const body = await resp.json()
    expect(body.details).toEqual([{ path: 'a', message: 'b' }])
  })
})
