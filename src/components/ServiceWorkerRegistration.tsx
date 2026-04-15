'use client'

import { useEffect } from 'react'

export function ServiceWorkerRegistration() {
  useEffect(() => {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker
        .register('/sw.js')
        .then((reg) => {
          console.log('[SW] Registered:', reg.scope)

          // Check for updates periodically
          setInterval(() => reg.update(), 60 * 60 * 1000) // Every hour
        })
        .catch((err) => {
          console.error('[SW] Registration failed:', err)
        })
    }
  }, [])

  return null // This component renders nothing
}
