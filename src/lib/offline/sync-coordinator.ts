import { replayQueue, restoreFromBackup, getPendingCount } from './queue-handler'

type SyncState = 'idle' | 'syncing' | 'error'
type SyncListener = (state: SyncState, result?: { synced: number; failed: number; conflicts: number }) => void

let currentState: SyncState = 'idle'
const listeners: Set<SyncListener> = new Set()
let syncInProgress = false

function notify(state: SyncState, result?: { synced: number; failed: number; conflicts: number }) {
  currentState = state
  listeners.forEach((fn) => fn(state, result))
}

/**
 * Subscribe to sync state changes.
 */
export function onSyncStateChange(fn: SyncListener): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

/**
 * Get current sync state.
 */
export function getSyncState(): SyncState {
  return currentState
}

/**
 * Trigger a sync attempt. Debounced — won't run if already syncing.
 */
export async function triggerSync(): Promise<void> {
  if (syncInProgress) return
  syncInProgress = true

  const pending = await getPendingCount()
  if (pending === 0) {
    syncInProgress = false
    return
  }

  notify('syncing')

  try {
    // First, restore any entries lost to iOS IndexedDB eviction
    await restoreFromBackup()

    const result = await replayQueue()
    notify('idle', result)
  } catch {
    notify('error')
  } finally {
    syncInProgress = false
  }
}

/**
 * Initialize the sync coordinator. Call once at app startup.
 * Sets up online/offline listeners and service worker message handler.
 */
export function initSyncCoordinator(): () => void {
  // Sync on coming online
  const handleOnline = () => {
    setTimeout(() => triggerSync(), 2000) // Brief delay to let connection stabilize
  }

  // Listen for Background Sync messages from service worker
  const handleSWMessage = (event: MessageEvent) => {
    if (event.data?.type === 'SYNC_REQUESTED') {
      triggerSync()
    }
  }

  // Listen for visibility change — sync when app comes to foreground
  const handleVisibility = () => {
    if (document.visibilityState === 'visible' && navigator.onLine) {
      triggerSync()
    }
  }

  window.addEventListener('online', handleOnline)
  document.addEventListener('visibilitychange', handleVisibility)

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', handleSWMessage)
  }

  // Initial sync attempt
  if (navigator.onLine) {
    triggerSync()
  }

  // Cleanup function
  return () => {
    window.removeEventListener('online', handleOnline)
    document.removeEventListener('visibilitychange', handleVisibility)
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.removeEventListener('message', handleSWMessage)
    }
  }
}
