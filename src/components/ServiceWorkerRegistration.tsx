'use client'

import { useEffect } from 'react'

export function ServiceWorkerRegistration() {
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return

    let intervalId: ReturnType<typeof setInterval> | undefined

    navigator.serviceWorker
      .register('/sw.js')
      .then((reg) => {
        console.log('[SW] Registered:', reg.scope)

        // Check for updates periodically
        intervalId = setInterval(() => reg.update(), 60 * 60 * 1000) // Every hour
      })
      .catch((err) => {
        console.error('[SW] Registration failed:', err)
      })

    return () => {
      if (intervalId) clearInterval(intervalId)
    }
  }, [])

  return null // This component renders nothing
}
