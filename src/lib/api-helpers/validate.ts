import { NextRequest, NextResponse } from 'next/server'
import { z, ZodError, ZodSchema } from 'zod'

export type ApiErrorCode =
  | 'VALIDATION_ERROR'
  | 'AUTH_REQUIRED'
  | 'ACCESS_DENIED'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'UPSTREAM_ERROR'
  | 'INTERNAL_ERROR'

const STATUS_BY_CODE: Record<ApiErrorCode, number> = {
  VALIDATION_ERROR: 400,
  AUTH_REQUIRED: 401,
  ACCESS_DENIED: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  UPSTREAM_ERROR: 502,
  INTERNAL_ERROR: 500,
}

export function errorResponse(
  code: ApiErrorCode,
  message: string,
  details?: unknown,
): NextResponse {
  const body: { error: string; code: ApiErrorCode; details?: unknown } = {
    error: message,
    code,
  }
  if (details !== undefined) body.details = details
  return NextResponse.json(body, { status: STATUS_BY_CODE[code] })
}

export type ValidatedJson<T> =
  | { ok: true; data: T }
  | { ok: false; response: NextResponse }

function formatZodError(err: ZodError): Array<{ path: string; message: string }> {
  return err.issues.map((issue) => ({
    path: issue.path.join('.') || '(root)',
    message: issue.message,
  }))
}

export async function validateJson<T>(
  req: NextRequest,
  schema: ZodSchema<T>,
): Promise<ValidatedJson<T>> {
  let raw: unknown
  try {
    raw = await req.json()
  } catch {
    return {
      ok: false,
      response: errorResponse('VALIDATION_ERROR', 'Request body is not valid JSON'),
    }
  }
  const parsed = schema.safeParse(raw)
  if (!parsed.success) {
    return {
      ok: false,
      response: errorResponse(
        'VALIDATION_ERROR',
        'Request body failed validation',
        formatZodError(parsed.error),
      ),
    }
  }
  return { ok: true, data: parsed.data }
}

export function validateUpstream<T>(
  schema: ZodSchema<T>,
  value: unknown,
  source: string,
): { ok: true; data: T } | { ok: false; response: NextResponse } {
  const parsed = schema.safeParse(value)
  if (!parsed.success) {
    return {
      ok: false,
      response: errorResponse(
        'UPSTREAM_ERROR',
        `${source} returned an unexpected response shape`,
        formatZodError(parsed.error),
      ),
    }
  }
  return { ok: true, data: parsed.data }
}

export { z }
