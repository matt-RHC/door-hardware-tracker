import { getOfflineDB } from './db'

const MAX_RETRIES = 5
const LOCALSTORAGE_KEY = 'tdh_offline_queue'

interface QueueEntry {
  id: string
  opening_id: string
  item_id: string
  leaf_index: number
  step: string
  value: boolean
  actor_id: string
  acted_at: string
  synced: boolean
  retry_count?: number
  last_error?: string
}

/**
 * Enqueue an offline check. Dual-persists to IndexedDB + localStorage.
 */
export async function enqueueCheck(check: Omit<QueueEntry, 'synced' | 'retry_count'>) {
  const entry: QueueEntry = { ...check, synced: false, retry_count: 0 }

  // Primary: IndexedDB
  const db = await getOfflineDB()
  await db.put('pendingChecksV2', entry)

  // Backup: localStorage (guards against iOS 2-week IndexedDB eviction)
  try {
    const existing: QueueEntry[] = JSON.parse(localStorage.getItem(LOCALSTORAGE_KEY) || '[]')
    existing.push(entry)
    localStorage.setItem(LOCALSTORAGE_KEY, JSON.stringify(existing))
  } catch {
    // localStorage might be full — IndexedDB is primary, this is best-effort
  }

  // Request Background Sync if available
  if ('serviceWorker' in navigator && 'SyncManager' in window) {
    try {
      const reg = await navigator.serviceWorker.ready
      await (reg as any).sync.register('sync-pending-checks')
    } catch {
      // Background Sync not available — fallback handled by sync-coordinator
    }
  }
}

/**
 * Get all pending (unsynced) entries from the queue.
 */
export async function getPendingEntries(): Promise<QueueEntry[]> {
  const db = await getOfflineDB()
  const all: QueueEntry[] = await db.getAll('pendingChecksV2')
  return all.filter((e) => !e.synced)
}

/**
 * Get total pending count.
 */
export async function getPendingCount(): Promise<number> {
  const entries = await getPendingEntries()
  return entries.length
}

/**
 * Replay all pending entries as a batch. Returns sync results.
 */
export async function replayQueue(): Promise<{ synced: number; failed: number; conflicts: number }> {
  const pending = await getPendingEntries()
  if (pending.length === 0) return { synced: 0, failed: 0, conflicts: 0 }

  const db = await getOfflineDB()
  let synced = 0
  let failed = 0
  let conflicts = 0

  for (const entry of pending) {
    // Skip entries that have exceeded max retries
    if ((entry.retry_count || 0) >= MAX_RETRIES) {
      failed++
      continue
    }

    try {
      const response = await fetch(`/api/openings/${entry.opening_id}/check`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          item_id: entry.item_id,
          leaf_index: entry.leaf_index,
          step: entry.step,
          value: entry.value,
          client_id: entry.actor_id,
          client_updated_at: entry.acted_at,
        }),
      })

      if (response.ok) {
        await db.put('pendingChecksV2', { ...entry, synced: true })
        synced++
      } else if (response.status === 409) {
        // LWW conflict — server wins, mark as synced
        await db.put('pendingChecksV2', { ...entry, synced: true })
        conflicts++
        synced++ // Still counts as resolved
      } else if (response.status === 401) {
        // Auth expired — stop replay, user needs to re-authenticate
        break
      } else {
        // Increment retry count
        await db.put('pendingChecksV2', {
          ...entry,
          retry_count: (entry.retry_count || 0) + 1,
          last_error: `HTTP ${response.status}`,
        })
        failed++
      }
    } catch {
      // Network error — increment retry count
      await db.put('pendingChecksV2', {
        ...entry,
        retry_count: (entry.retry_count || 0) + 1,
        last_error: 'Network error',
      })
      failed++
    }

    // Brief pause between requests to avoid hammering the server
    await new Promise((r) => setTimeout(r, 100))
  }

  // Clean up localStorage backup for synced entries
  try {
    const backup: QueueEntry[] = JSON.parse(localStorage.getItem(LOCALSTORAGE_KEY) || '[]')
    const syncedIds = new Set(pending.filter((p) => p.synced).map((p) => p.id))
    const remaining = backup.filter((e) => !syncedIds.has(e.id))
    localStorage.setItem(LOCALSTORAGE_KEY, JSON.stringify(remaining))
  } catch {
    // Best effort
  }

  return { synced, failed, conflicts }
}

/**
 * Restore queue from localStorage backup (recovery from iOS IndexedDB eviction).
 */
export async function restoreFromBackup(): Promise<number> {
  try {
    const backup: QueueEntry[] = JSON.parse(localStorage.getItem(LOCALSTORAGE_KEY) || '[]')
    if (backup.length === 0) return 0

    const db = await getOfflineDB()
    let restored = 0

    for (const entry of backup) {
      if (!entry.synced) {
        const existing = await db.get('pendingChecksV2', entry.id)
        if (!existing) {
          await db.put('pendingChecksV2', entry)
          restored++
        }
      }
    }

    return restored
  } catch {
    return 0
  }
}
