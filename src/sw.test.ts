/**
 * The service worker.
 *
 * `public/sw.js` is 83 lines that decide what a sailor sees when the dockside 3G
 * drops out, and nothing has ever exercised it. It is not imported by the app, so
 * this loads the file and runs it inside a fake worker global: a `self` that
 * collects the event listeners, a `caches` that is a Map of Maps, and a `fetch` the
 * test controls. Then it dispatches real-shaped events at the handlers.
 *
 * Worth the harness because the decisions in there are product claims. "Never serve
 * a cached forecast" is the cardinal rule of this whole project, and "cache-first for
 * our own build output" is the sentence that decides whether a shipped bug fix ever
 * reaches an installed user.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// --------------------------------------------------------------- fake worker

interface FakeResponse {
  ok: boolean
  type: string
  body: string
  clone(): FakeResponse
}

function response(body: string, over: Partial<FakeResponse> = {}): FakeResponse {
  const r: FakeResponse = {
    ok: true,
    type: 'basic',
    body,
    clone: () => response(body, over),
    ...over,
  }
  return r
}

class FakeCache {
  store = new Map<string, FakeResponse>()
  async match(req: { url: string }) {
    return this.store.get(req.url)
  }
  async put(req: { url: string }, res: FakeResponse) {
    this.store.set(req.url, res)
  }
  async addAll(urls: string[]) {
    for (const u of urls) this.store.set(new URL(u, ORIGIN + '/').href, response(`shell:${u}`))
  }
  async keys() {
    return [...this.store.keys()].map((url) => ({ url }))
  }
  async delete(req: { url: string }) {
    return this.store.delete(req.url)
  }
}

class FakeCacheStorage {
  caches = new Map<string, FakeCache>()
  async open(name: string) {
    let c = this.caches.get(name)
    if (!c) {
      c = new FakeCache()
      this.caches.set(name, c)
    }
    return c
  }
  async keys() {
    return [...this.caches.keys()]
  }
  async delete(name: string) {
    return this.caches.delete(name)
  }
  /** Any cache holding this url, mirroring the global `caches.match`. */
  async match(req: { url: string }) {
    for (const c of this.caches.values()) {
      const hit = await c.match(req)
      if (hit) return hit
    }
    return undefined
  }
}

const ORIGIN = 'https://newjourney.example'

interface Loaded {
  listeners: Map<string, (e: unknown) => void>
  cacheStorage: FakeCacheStorage
  fetchMock: ReturnType<typeof vi.fn>
  skipWaitingCalled: () => boolean
  claimCalled: () => boolean
}

/** Evaluate public/sw.js against a fake worker global and return the handles. */
function loadWorker(): Loaded {
  const source = readFileSync(join(process.cwd(), 'public', 'sw.js'), 'utf8')
  const listeners = new Map<string, (e: unknown) => void>()
  const cacheStorage = new FakeCacheStorage()
  const fetchMock = vi.fn()
  let skipWaiting = false
  let claim = false

  const self = {
    addEventListener: (type: string, fn: (e: unknown) => void) => listeners.set(type, fn),
    location: { origin: ORIGIN },
    skipWaiting: () => {
      skipWaiting = true
    },
    clients: {
      claim: () => {
        claim = true
        return Promise.resolve()
      },
    },
  }

  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const run = new Function('self', 'caches', 'fetch', 'URL', source)
  run(self, cacheStorage, fetchMock, URL)

  return {
    listeners,
    cacheStorage,
    fetchMock,
    skipWaitingCalled: () => skipWaiting,
    claimCalled: () => claim,
  }
}

/** Dispatch a fetch event and return what the worker chose to respond with. */
async function fetchEvent(
  w: Loaded,
  url: string,
  init: { method?: string; mode?: string; destination?: string } = {},
): Promise<{ responded: boolean; body: string | undefined }> {
  const handler = w.listeners.get('fetch')
  if (!handler) throw new Error('no fetch listener registered')
  let responded = false
  let promise: Promise<FakeResponse | undefined> | undefined
  const event = {
    request: {
      url,
      method: init.method ?? 'GET',
      mode: init.mode ?? 'cors',
      destination: init.destination ?? '',
    },
    respondWith: (p: Promise<FakeResponse | undefined>) => {
      responded = true
      promise = p
    },
    waitUntil: (p: Promise<unknown>) => p,
  }
  handler(event)
  const res = promise ? await promise : undefined
  return { responded, body: res?.body }
}

let worker: Loaded

beforeEach(() => {
  worker = loadWorker()
})

// -------------------------------------------------------------------- tests

describe('install and activate', () => {
  it('precaches the shell and takes over immediately', async () => {
    const install = worker.listeners.get('install')!
    let waited: Promise<unknown> | undefined
    install({ waitUntil: (p: Promise<unknown>) => (waited = p) })
    await waited
    expect(worker.skipWaitingCalled()).toBe(true)
    const names = await worker.cacheStorage.keys()
    expect(names.some((n) => n.includes('shell'))).toBe(true)
  })

  it('drops caches from an older version and claims open pages', async () => {
    // A stale cache from a previous VERSION must go, or the old app lives forever.
    ;(await worker.cacheStorage.open('nj-portland-v0-shell')).store.set(
      `${ORIGIN}/old.js`,
      response('old'),
    )
    const activate = worker.listeners.get('activate')!
    let waited: Promise<unknown> | undefined
    activate({ waitUntil: (p: Promise<unknown>) => (waited = p) })
    await waited
    expect(await worker.cacheStorage.keys()).not.toContain('nj-portland-v0-shell')
    expect(worker.claimCalled()).toBe(true)
  })
})

describe('the cardinal rule: never serve a cached forecast', () => {
  it('does not intercept the weather API at all', async () => {
    for (const url of [
      'https://api.open-meteo.com/v1/forecast?latitude=43.6',
      'https://marine-api.open-meteo.com/v1/marine?latitude=43.6',
    ]) {
      const { responded } = await fetchEvent(worker, url)
      expect(responded, url).toBe(false)
    }
  })

  it('leaves the other time-sensitive APIs to the network too', async () => {
    // Tide and current predictions are as perishable as a forecast. They are
    // cross-origin, so falling through is the correct outcome - but it is worth
    // pinning, because a later same-origin proxy for them would silently start
    // being cached by the branch below.
    for (const url of [
      'https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?product=predictions',
      'https://api.weather.gov/zones/forecast/ANZ153/forecast',
    ]) {
      const { responded } = await fetchEvent(worker, url)
      expect(responded, url).toBe(false)
    }
  })

  it('does not cache a forecast served from our own origin', async () => {
    /*
     * Found by mutation testing: deleting the `open-meteo.com` guard changed nothing,
     * because that host is cross-origin and the origin check already returned. The
     * rule was enforced by accident, and the accident expires - `venues.ts` plans an
     * owned forecast ingest, and a forecast on our own origin would have fallen into
     * the cache-first branch and been stored.
     *
     * Caching is now default-deny for same-origin paths, so this passes for the
     * reason it says rather than by luck.
     */
    for (const path of ['/api/forecast?lat=43.6', '/api/tides.json', '/data/cube.bin']) {
      const { responded } = await fetchEvent(worker, `${ORIGIN}${path}`)
      expect(responded, path).toBe(false)
    }
  })

  it('ignores non-GET requests', async () => {
    const { responded } = await fetchEvent(worker, `${ORIGIN}/index.html`, { method: 'POST' })
    expect(responded).toBe(false)
  })
})

describe('map tiles', () => {
  it('goes to the network first and caches what it gets', async () => {
    worker.fetchMock.mockResolvedValue(response('fresh-tile'))
    const url = 'https://tile.openstreetmap.org/12/1234/1567.png'
    const { responded, body } = await fetchEvent(worker, url)
    expect(responded).toBe(true)
    expect(body).toBe('fresh-tile')
    // Cached for the next time the connection drops.
    await new Promise((r) => setTimeout(r, 0))
    const hit = await worker.cacheStorage.match({ url })
    expect(hit?.body).toBe('fresh-tile')
  })

  it('falls back to the cache when the network is gone', async () => {
    const url = 'https://tiles.openseamap.org/seamark/12/1234/1567.png'
    ;(await worker.cacheStorage.open('nj-portland-v1-tiles')).store.set(url, response('old-tile'))
    worker.fetchMock.mockRejectedValue(new Error('offline'))
    const { body } = await fetchEvent(worker, url)
    expect(body).toBe('old-tile')
  })
})

describe('the app shell', () => {
  it('serves hashed build output from the cache without touching the network', async () => {
    // Content-hashed, so a cached copy can never be the wrong copy.
    const url = `${ORIGIN}/assets/index-AbC123.js`
    ;(await worker.cacheStorage.open('nj-portland-v1-shell')).store.set(url, response('cached-js'))
    worker.fetchMock.mockResolvedValue(response('network-js'))
    const { body } = await fetchEvent(worker, url)
    expect(body).toBe('cached-js')
    expect(worker.fetchMock).not.toHaveBeenCalled()
  })

  /*
   * The bug this file was written to find.
   *
   * index.html is NOT content-hashed - it is the one file whose name never changes
   * and whose contents change on every deploy, because it carries the <script src>
   * pointing at the new hashed bundle. Serving it cache-first means an installed
   * user keeps running the version they first visited: every fix shipped after that
   * is invisible to them, and VERSION is a hand-edited constant, so nothing
   * invalidates it unless a developer remembers to bump it.
   *
   * For this app that means the land-avoidance fix, the depth-datum caveats and
   * every correction in the last fortnight would never reach an installed phone.
   */
  it('checks the network for the page itself, so a deploy actually lands', async () => {
    const url = `${ORIGIN}/index.html`
    ;(await worker.cacheStorage.open('nj-portland-v1-shell')).store.set(
      url,
      response('OLD app shell'),
    )
    worker.fetchMock.mockResolvedValue(response('NEW app shell'))

    const { body } = await fetchEvent(worker, url, { mode: 'navigate', destination: 'document' })
    expect(body).toBe('NEW app shell')
  })

  it('still serves the page from the cache when offline', async () => {
    // The whole point of the shell: no network, still an app.
    const url = `${ORIGIN}/index.html`
    ;(await worker.cacheStorage.open('nj-portland-v1-shell')).store.set(
      url,
      response('cached app shell'),
    )
    worker.fetchMock.mockRejectedValue(new Error('offline'))
    const { body } = await fetchEvent(worker, url, { mode: 'navigate', destination: 'document' })
    expect(body).toBe('cached app shell')
  })

  it('revalidates an unhashed data asset instead of freezing it forever', async () => {
    /*
     * The venue packs have fixed names - portland-land.bin, portland-depth.bin - so
     * cache-first freezes whatever was downloaded first. The depth grid has already
     * been regenerated once during development; an installed user would still be
     * routing against the first copy.
     *
     * Cache-first is still the right *response* here, because the offline case
     * matters more than a same-day update, but it must refresh in the background so
     * the next launch is current.
     */
    const url = `${ORIGIN}/venue/portland-depth.bin`
    ;(await worker.cacheStorage.open('nj-portland-v1-shell')).store.set(url, response('old-grid'))
    worker.fetchMock.mockResolvedValue(response('new-grid'))

    const { body } = await fetchEvent(worker, url)
    expect(body).toBe('old-grid') // instant, from cache
    await new Promise((r) => setTimeout(r, 0))
    expect(worker.fetchMock).toHaveBeenCalled() // and refreshed behind it
    const hit = await worker.cacheStorage.match({ url })
    expect(hit?.body).toBe('new-grid')
  })

  it('does not cache an error response', async () => {
    const url = `${ORIGIN}/assets/missing-XYZ.js`
    worker.fetchMock.mockResolvedValue(response('not found', { ok: false }))
    await fetchEvent(worker, url)
    await new Promise((r) => setTimeout(r, 0))
    expect(await worker.cacheStorage.match({ url })).toBeUndefined()
  })
})
