/**
 * What the service worker precaches, decided at build time.
 *
 * The worker registers after the page has loaded, so everything the first visit
 * fetched - the entry script and stylesheet above all - was downloaded before
 * there was a worker to see it, and a worker that only caches what passes
 * through it never stored them. A sailor who opened the link once at home got a
 * blank app on the water. So the build lists its own output, and the worker
 * caches that list when it installs.
 *
 * Pure, so the list is testable without a build: `vite.config.ts` feeds it the
 * files a build actually wrote.
 */

export interface PrecacheList {
  /** Install fails without these, and the browser tries again on the next visit. */
  critical: string[]
  /** Fetched best-effort: a failure costs that one file offline, not the app. */
  rest: string[]
}

/**
 * Never precached: the worker itself, which the browser updates on its own
 * terms; source maps, which are large and only a debugger wants; build metadata.
 */
function skipped(path: string): boolean {
  return path === 'sw.js' || path.endsWith('.map') || path.startsWith('.vite/')
}

/**
 * @param files     paths relative to the build output, with forward slashes
 * @param indexHtml the built page. Every `./assets/` file it names - the entry
 *                  script, its stylesheet, any modulepreload - is critical,
 *                  because the Start tab cannot run without them.
 */
export function precacheList(files: readonly string[], indexHtml: string): PrecacheList {
  const present = new Set(files)
  for (const required of ['index.html', 'manifest.webmanifest']) {
    if (!present.has(required)) throw new Error(`the build did not write ${required}`)
  }
  const named = [
    ...new Set([...indexHtml.matchAll(/(?:src|href)="\.\/(assets\/[^"]+)"/g)].map((m) => m[1])),
  ]
  if (named.length === 0) throw new Error('index.html names no ./assets/ files to precache')
  for (const f of named) {
    if (!present.has(f)) throw new Error(`index.html names ${f}, which the build did not write`)
  }
  const taken = new Set(['index.html', 'manifest.webmanifest', ...named])
  return {
    critical: ['./', './index.html', './manifest.webmanifest', ...named.map((f) => `./${f}`)],
    rest: files
      .filter((f) => !skipped(f) && !taken.has(f))
      .map((f) => `./${f}`)
      .sort(),
  }
}

/** The line in `public/sw.js` that the build rewrites. */
const PRECACHE_LINE = /^const PRECACHE = .* \/\/ @precache$/m

/**
 * Write the list into the worker's source. Throws rather than shipping a worker
 * that silently precaches nothing, if the line it rewrites has gone.
 */
export function injectPrecache(swSource: string, list: PrecacheList): string {
  if (!PRECACHE_LINE.test(swSource)) {
    throw new Error('public/sw.js has lost its "const PRECACHE = … // @precache" line')
  }
  // A function, so no `$` in a file name can be read as a replacement pattern.
  return swSource.replace(PRECACHE_LINE, () => `const PRECACHE = ${JSON.stringify(list)} // @precache`)
}
