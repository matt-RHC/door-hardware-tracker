/**
 * Simple feature flag helper.
 *
 * Checks environment variable first, then falls back to URL query params.
 * This keeps the mechanism lightweight — no external service needed.
 */

/**
 * Returns true when the background-job wizard flow should be used instead
 * of the legacy client-side extraction flow.
 *
 * Enabled when:
 *  - `NEXT_PUBLIC_USE_JOB_WIZARD=true` env var is set, OR
 *  - `?jobWizard=true` query param is present in the URL
 */
export function useJobWizardEnabled(): boolean {
  if (typeof window === 'undefined') return false

  // Env var takes precedence
  if (process.env.NEXT_PUBLIC_USE_JOB_WIZARD === 'true') return true

  // Fall back to query param
  try {
    const params = new URLSearchParams(window.location.search)
    return params.get('jobWizard') === 'true'
  } catch {
    return false
  }
}
