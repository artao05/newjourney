/*
 * Minimal offline shell.
 *
 * Strategy: cache-first for our own build output (it is content-hashed, so it
 * is safe to cache forever), network-first with a cache fallback for map tiles,
 * and never cache the weather API — a stale forecast presented as current is
 * exactly the failure this project is trying to avoid.
 */

const VERSION = 'nj-v1'
const SHELL = `${VERSION}-shell`
const TILES = `${VERSION}-tiles`
const TILE_LIMIT = 1200

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(SHELL).then((c) => c.addAll(['./', './index.html', './manifest.webmanifest'])),
  )
  self.skipWaiting()
})

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  )
})

async function trimCache(name, max) {
  const cache = await caches.open(name)
  const keys = await cache.keys()
  if (keys.length <= max) return
  for (const k of keys.slice(0, keys.length - max)) await cache.delete(k)
}

self.addEventListener('fetch', (e) => {
  const req = e.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)

  // Never serve a cached forecast.
  if (url.hostname.endsWith('open-meteo.com')) return

  const isTile =
    url.hostname.includes('tile.openstreetmap.org') ||
    url.hostname.includes('tiles.openseamap.org')

  if (isTile) {
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone()
          caches.open(TILES).then((c) => {
            c.put(req, copy)
            trimCache(TILES, TILE_LIMIT)
          })
          return res
        })
        .catch(() => caches.match(req)),
    )
    return
  }

  if (url.origin === self.location.origin) {
    e.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            if (res.ok && res.type === 'basic') {
              const copy = res.clone()
              caches.open(SHELL).then((c) => c.put(req, copy))
            }
            return res
          }),
      ),
    )
  }
})
