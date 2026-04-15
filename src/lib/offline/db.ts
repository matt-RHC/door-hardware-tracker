import { openDB } from 'idb'

export type WorkflowStep = 'received' | 'pre_install' | 'installed' | 'qa_qc' | 'checked'

export interface OfflineCheck {
  id: string
  opening_id: string
  item_id: string
  leaf_index: number  // 1 = single/leaf 1, 2 = leaf 2
  step: WorkflowStep
  value: boolean
  actor_id: string    // user who made the change
  acted_at: string    // ISO timestamp when the change was made
  synced: boolean
}

let db: any = null

export async function initDB() {
  if (db) return db
  db = await openDB('door-hardware-tracker', 2, {
    upgrade(database: any, oldVersion: number) {
      // v1 stores
      if (oldVersion < 1) {
        if (!database.objectStoreNames.contains('pendingChecks')) {
          const pendingStore = database.createObjectStore('pendingChecks', { keyPath: 'id' })
          pendingStore.createIndex('by-synced', 'synced')
        }
        if (!database.objectStoreNames.contains('cachedOpenings')) {
          database.createObjectStore('cachedOpenings', { keyPath: 'id' })
        }
        if (!database.objectStoreNames.contains('cachedItems')) {
          database.createObjectStore('cachedItems', { keyPath: 'id' })
        }
      }

      // v1→v2: add pendingChecksV2 store with new schema
      if (oldVersion < 2) {
        if (!database.objectStoreNames.contains('pendingChecksV2')) {
          const v2Store = database.createObjectStore('pendingChecksV2', { keyPath: 'id' })
          v2Store.createIndex('by-synced', 'synced')
          v2Store.createIndex('by-item', ['item_id', 'leaf_index'])
        }
      }
    },
  })

  // Migrate v1 pending checks to v2 format after DB is open
  await migrateV1ToV2(db)

  return db
}

async function migrateV1ToV2(database: any) {
  try {
    const oldChecks = await database.getAll('pendingChecks')
    if (oldChecks.length === 0) return

    const tx = database.transaction(['pendingChecks', 'pendingChecksV2'], 'readwrite')
    const v2Store = tx.objectStore('pendingChecksV2')

    for (const check of oldChecks) {
      // Only migrate entries that haven't been synced yet
      if (check.synced) continue

      const migrated: OfflineCheck = {
        id: check.id,
        opening_id: check.opening_id,
        item_id: check.item_id,
        leaf_index: 1,
        step: 'checked',
        value: check.checked ?? true,
        actor_id: check.checked_by ?? '',
        acted_at: check.checked_at ?? new Date().toISOString(),
        synced: false,
      }
      await v2Store.put(migrated)
    }

    // Clear old store after migration
    const oldStore = tx.objectStore('pendingChecks')
    await oldStore.clear()

    await tx.done
  } catch {
    // Migration is best-effort — don't block app startup
    console.error('Failed to migrate v1 pending checks')
  }
}

export async function getOfflineDB() {
  if (!db) await initDB()
  return db
}

export async function saveCheckOffline(check: Omit<OfflineCheck, 'synced'>) {
  const database = await getOfflineDB()
  await database.put('pendingChecksV2', {
    ...check,
    synced: false,
  })
}

export async function saveCheckOfflineV2(check: Omit<OfflineCheck, 'synced'>) {
  const database = await getOfflineDB()
  await database.put('pendingChecksV2', {
    ...check,
    synced: false,
  })
}

export async function syncPendingChecks() {
  const database = await getOfflineDB()
  const allPendingChecks = await database.getAll('pendingChecksV2')
  const unsyncedChecks = allPendingChecks.filter((check: any) => !check.synced)

  if (unsyncedChecks.length === 0) {
    return { synced: 0, failed: 0 }
  }

  let synced = 0
  let failed = 0

  for (const check of unsyncedChecks) {
    try {
      const response = await fetch(`/api/openings/${check.opening_id}/check`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          item_id: check.item_id,
          leaf_index: check.leaf_index,
          step: check.step,
          value: check.value,
          client_id: check.actor_id,
          client_updated_at: check.acted_at,
        }),
      })

      // Handle 409 Conflict — server version is newer, mark as synced (server wins)
      if (response.status === 409) {
        await database.put('pendingChecksV2', { ...check, synced: true })
        synced++
        continue
      }

      if (!response.ok) {
        failed++
        console.error('Failed to sync check:', await response.text())
      } else {
        // Mark as synced
        await database.put('pendingChecksV2', {
          ...check,
          synced: true,
        })
        synced++
      }
    } catch (error) {
      failed++
      console.error('Error syncing check:', error)
    }
  }

  return { synced, failed }
}

export async function getPendingChecksV2(): Promise<OfflineCheck[]> {
  const database = await getOfflineDB()
  return database.getAll('pendingChecksV2')
}

export async function cacheOpening(opening: any) {
  const database = await getOfflineDB()
  await database.put('cachedOpenings', opening)
}

export async function getCachedOpening(openingId: string) {
  const database = await getOfflineDB()
  const opening = await database.get('cachedOpenings', openingId)
  return opening || null
}
