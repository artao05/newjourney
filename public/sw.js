/*
 * Minimal offline shell.
 *
 * Four rules, in the order the fetch handler applies them:
 *
 *   1. **Never cache the weather API.** A stale forecast presented as current is
 *      exactly the failure this project exists to avoid.
 *   2. **Map tiles: network first, cache as a fallback.** Tiles are immutable
 *      enough that a stale one is only ever cosmetic, and having them offline is
 *      the difference between a chart and a blank screen.
 *   3. **The page itself: network first.** `index.html` is the one same-origin
 *      file whose name never changes while its contents change on every deploy -
 *      it carries the <script src> pointing at the newly hashed bundle. Serving it
 *      cache-first kept an installed user on the version they first visited, and
 *      because VERSION below is a hand-edited constant, nothing ever invalidated
 *      it. Every fix shipped afterwards was invisible to them.
 *   4. **Everything else same-origin: cache first, then revalidate.** The hashed
 *      build output under /assets/ can be trusted forever, because a cached copy of
 *      a content-hashed name cannot be the wrong copy. The rest - the venue packs,
 *      the manifest - keep their filenames across deploys, so they are served from
 *      cache for speed and refreshed behind the response so the next launch is
 *      current. The depth grid has already been regenerated once in development;
 *      cache-first-forever would have frozen an installed user on the first copy.
 */

const VERSION = 'nj-portland-v1'
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

/** Fetch and store, returning the network response. */
function fromNetwork(req, cacheName) {
  return fetch(req).then((res) => {
    if (res.ok && res.type === 'basic') {
      const copy = res.clone()
      caches.open(cacheName).then((c) => c.put(req, copy))
    }
    return res
  })
}

self.addEventListener('fetch', (e) => {
  const req = e.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)

  // Rule 1. Never serve a cached forecast.
  if (url.hostname.endsWith('open-meteo.com')) return

  const isTile =
    url.hostname.includes('tile.openstreetmap.org') ||
    url.hostname.includes('tiles.openseamap.org')

  // Rule 2.
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

  if (url.origin !== self.location.origin) return

  // Rule 3. A navigation is the deploy boundary: check the network, fall back to
  // the shell so that offline still opens the app.
  if (req.mode === 'navigate' || req.destination === 'document') {
    e.respondWith(fromNetwork(req, SHELL).catch(() => caches.match(req)))
    return
  }

  // Rule 4. Content-hashed output is safe to trust without asking.
  const hashed = /\/assets\/.+-[A-Za-z0-9_-]{6,}\.[a-z0-9]+$/.test(url.pathname)

  e.respondWith(
    caches.match(req).then((hit) => {
      if (!hit) return fromNetwork(req, SHELL)
      if (!hashed) {
        // Refresh behind the response. Failure is expected offline and must not
        // reject the request the page is waiting on.
        fromNetwork(req, SHELL).catch(() => undefined)
      }
      return hit
    }),
  )
})
