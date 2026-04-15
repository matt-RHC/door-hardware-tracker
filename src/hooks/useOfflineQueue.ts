'use client'

import { useState, useEffect, useCallback } from 'react'
import { initSyncCoordinator, onSyncStateChange, triggerSync, getSyncState } from '@/lib/offline/sync-coordinator'
import { getPendingCount } from '@/lib/offline/queue-handler'

interface OfflineQueueState {
  syncState: 'idle' | 'syncing' | 'error'
  pendingCount: number
  lastResult: { synced: number; failed: number; conflicts: number } | null
  manualSync: () => Promise<void>
}

let coordinatorInitialized = false
// Stored for potential teardown; prefixed to satisfy no-unused-vars
let _coordinatorCleanup: (() => void) | null = null

export function useOfflineQueue(): OfflineQueueState {
  const [syncState, setSyncState] = useState<'idle' | 'syncing' | 'error'>(getSyncState())
  const [pendingCount, setPendingCount] = useState(0)
  const [lastResult, setLastResult] = useState<{ synced: number; failed: number; conflicts: number } | null>(null)

  useEffect(() => {
    // Initialize sync coordinator once across all hook instances
    if (!coordinatorInitialized) {
      _coordinatorCleanup = initSyncCoordinator()
      coordinatorInitialized = true
    }

    // Subscribe to state changes
    const unsubscribe = onSyncStateChange((state, result) => {
      setSyncState(state)
      if (result) setLastResult(result)
    })

    // Poll pending count
    const poll = setInterval(async () => {
      try {
        const count = await getPendingCount()
        setPendingCount(count)
      } catch {
        // IndexedDB might not be available
      }
    }, 3000)

    // Initial count
    getPendingCount().then(setPendingCount).catch(() => {})

    return () => {
      unsubscribe()
      clearInterval(poll)
    }
  }, [])

  const manualSync = useCallback(async () => {
    await triggerSync()
    const count = await getPendingCount()
    setPendingCount(count)
  }, [])

  return { syncState, pendingCount, lastResult, manualSync }
}
