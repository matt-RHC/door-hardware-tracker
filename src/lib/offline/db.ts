import { openDB } from 'idb'

let db: any = null

export async function initDB() {
  if (db) return db
  db = await openDB('door-hardware-tracker', 1, {
    upgrade(database: any) {
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
    },
  })
  return db
}

export async function getOfflineDB() {
  if (!db) await initDB()
  return db
}

export async function saveCheckOffline(check: {
  id: string
  opening_id: string
  item_id: string
  checked: boolean
  checked_by: string
  checked_at: string
}) {
  const database = await getOfflineDB()
  await database.put('pendingChecks', {
    ...check,
    synced: false,
  })
}

export async function syncPendingChecks(supabase: any) {
  const database = await getOfflineDB()
  const allPendingChecks = await database.getAll('pendingChecks')
  const unsyncedChecks = allPendingChecks.filter((check: any) => !check.synced)

  if (unsyncedChecks.length === 0) {
    return { synced: 0, failed: 0 }
  }

  let synced = 0
  let failed = 0

  for (const check of unsyncedChecks) {
    try {
      const { error } = await supabase
        .from('checklist_progress')
        .upsert(
          {
            id: check.id,
            opening_id: check.opening_id,
            item_id: check.item_id,
            checked: check.checked,
            checked_by: check.checked_by,
            checked_at: check.checked_at,
          },
          { onConflict: 'opening_id,item_id' }
        )
        .select()

      if (error) {
        failed++
        console.error('Failed to sync check:', error)
      } else {
        // Mark as synced
        await database.put('pendingChecks', {
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

export async function cacheOpening(opening: any) {
  const database = await getOfflineDB()
  await database.put('cachedOpenings', opening)
}

export async function getCachedOpening(openingId: string) {
  const database = await getOfflineDB()
  const opening = await database.get('cachedOpenings', openingId)
  return opening || null
}
