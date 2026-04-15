"use client"

import { useState, useEffect, useCallback } from "react"
import { getPendingChecksV2, OfflineCheck } from "@/lib/offline/db"

const POLL_INTERVAL_MS = 5_000

type ItemSyncStatus = "synced" | "pending" | "failed"

interface SyncStatus {
  pendingCount: number
  lastSyncedAt: Date | null
  itemStatus: (itemId: string, leafIndex: number) => ItemSyncStatus
}

export function useSyncStatus(): SyncStatus {
  const [checks, setChecks] = useState<OfflineCheck[]>([])

  const refresh = useCallback(async () => {
    try {
      const all = await getPendingChecksV2()
      setChecks(all)
    } catch {
      // IndexedDB may not be available (SSR, private browsing)
    }
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- sync initial state from IndexedDB on mount
    refresh()
    const interval = setInterval(refresh, POLL_INTERVAL_MS)
    return () => clearInterval(interval)
  }, [refresh])

  const pendingCount = checks.filter((c) => !c.synced).length

  const lastSyncedAt = (() => {
    const syncedChecks = checks.filter((c) => c.synced)
    if (syncedChecks.length === 0) return null
    const maxTs = syncedChecks.reduce((max, c) => {
      const ts = new Date(c.acted_at).getTime()
      return ts > max ? ts : max
    }, 0)
    return new Date(maxTs)
  })()

  const itemStatus = useCallback(
    (itemId: string, leafIndex: number): ItemSyncStatus => {
      const matching = checks.filter(
        (c) => c.item_id === itemId && c.leaf_index === leafIndex
      )
      if (matching.length === 0) return "synced" // never been offline-edited
      if (matching.some((c) => !c.synced)) return "pending"
      return "synced"
    },
    [checks]
  )

  return { pendingCount, lastSyncedAt, itemStatus }
}

export function getItemSyncStatus(
  checks: OfflineCheck[],
  openingId: string,
  itemId: string,
  leafIndex: number
): ItemSyncStatus {
  const matching = checks.filter(
    (c) =>
      c.opening_id === openingId &&
      c.item_id === itemId &&
      c.leaf_index === leafIndex
  )
  if (matching.length === 0) return "synced"
  if (matching.some((c) => !c.synced)) return "pending"
  return "synced"
}
