const CACHE_NAME = 'tdh-offline-v1'
const OFFLINE_FALLBACK = '/offline-fallback.html'

// Install: cache the offline fallback page
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.add(OFFLINE_FALLBACK))
  )
  self.skipWaiting()
})

// Activate: clean old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  )
  self.clients.claim()
})

// Fetch: for navigation requests, serve offline fallback if network fails
// For API requests, let them pass through (the app-level code handles offline queuing)
self.addEventListener('fetch', (event) => {
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request).catch(() => caches.match(OFFLINE_FALLBACK))
    )
  }
  // All other requests (API, assets) pass through normally
  // Offline API handling is done at the application level via the queue handler
})

// Background Sync: replay offline queue when connectivity returns
self.addEventListener('sync', (event) => {
  if (event.tag === 'sync-pending-checks') {
    event.waitUntil(
      // Post message to any open client to trigger sync
      self.clients.matchAll().then((clients) => {
        clients.forEach((client) => {
          client.postMessage({ type: 'SYNC_REQUESTED' })
        })
      })
    )
  }
})

// Listen for messages from the app
self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting()
  }
})
