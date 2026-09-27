/**
 * The install surface: `index.html`, the web manifest, the icons.
 *
 * Pass 16 found that the widest-reaching bug in this repo was not in any algorithm —
 * it was in the delivery plumbing, in the one file nobody thought of as code. This is
 * the rest of that family, and nothing checked any of it.
 *
 * What these tests defend:
 *
 *   - **Every URL stays relative.** `vite.config.ts` sets `base: './'` so the app can
 *     be served from a subpath. One absolute `/assets/...` or `/sw.js` and the
 *     subpath deploy 404s, with no error anywhere in development because the dev
 *     server is always at the root.
 *   - **Every referenced file exists.** A manifest naming an icon that was renamed
 *     is an install prompt that silently never appears.
 *   - **Claims match the assets.** `purpose: "maskable"` is a promise that the icon
 *     was drawn inside the safe zone. Android believes it and crops accordingly.
 */

import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const read = (p: string) => readFileSync(join(root, p), 'utf8')

const html = read('index.html')
const manifest = JSON.parse(read('public/manifest.webmanifest')) as {
  name: string
  short_name: string
  start_url: string
  scope: string
  display: string
  theme_color: string
  background_color: string
  icons: Array<{ src: string; sizes: string; type: string; purpose?: string }>
}

/** Attribute value from the first matching tag, or undefined. */
function attr(source: string, pattern: RegExp): string | undefined {
  return source.match(pattern)?.[1]
}

describe('the manifest is installable', () => {
  it('carries the fields a browser needs to offer installation', () => {
    for (const key of ['name', 'short_name', 'start_url', 'display', 'icons'] as const) {
      expect(manifest[key], key).toBeTruthy()
    }
    expect(manifest.display).toBe('standalone')
    expect(manifest.icons.length).toBeGreaterThan(0)
  })

  it('keeps start_url and scope relative, so a subpath deploy works', () => {
    // `base: './'` in vite.config.ts exists precisely so this app can live under a
    // path. An absolute start_url sends the installed app to the wrong origin root.
    for (const key of ['start_url', 'scope'] as const) {
      expect(manifest[key], key).not.toMatch(/^\//)
      expect(manifest[key], key).not.toMatch(/^https?:/)
    }
  })

  it('names icons that actually exist', () => {
    for (const icon of manifest.icons) {
      expect(icon.src, 'icon src must be relative').not.toMatch(/^\/|^https?:/)
      const p = join('public', icon.src.replace(/^\.\//, ''))
      expect(existsSync(join(root, p)), `${icon.src} missing at ${p}`).toBe(true)
    }
  })
})

describe('index.html and the manifest agree', () => {
  it('links the manifest relatively', () => {
    const href = attr(html, /<link rel="manifest" href="([^"]+)"/)
    expect(href).toBeTruthy()
    expect(href).not.toMatch(/^\//)
    expect(existsSync(join(root, 'public', (href as string).replace(/^\.\//, '')))).toBe(true)
  })

  it('states one theme colour, not two', () => {
    /*
     * The browser paints the tab and address bar from the meta tag and the installed
     * app's title bar from the manifest. Two different values is not a crash, it is
     * a seam a user can see: the colour changes when they install.
     */
    const meta = attr(html, /<meta name="theme-color" content="([^"]+)"/)
    expect(meta).toBeTruthy()
    expect(meta?.toLowerCase()).toBe(manifest.theme_color.toLowerCase())
  })

  it('registers the service worker at a relative path', () => {
    // `register('/sw.js')` would look outside the scope on a subpath deploy and
    // silently give up offline support — the catch in main.tsx swallows it.
    const main = read('src/main.tsx')
    const path = attr(main, /serviceWorker\.register\('([^']+)'\)/)
    expect(path, 'no serviceWorker.register found').toBeTruthy()
    expect(path).not.toMatch(/^\//)
    expect(existsSync(join(root, 'public', (path as string).replace(/^\.\//, '')))).toBe(true)
  })
})

describe('a maskable icon must be drawn like one', () => {
  /*
   * Android applies its own mask - circle, squircle, rounded square - to any icon
   * declaring `maskable`, and crops everything outside a circle of 80% of the
   * canvas. So the promise has two parts: a full-bleed background, because the
   * platform supplies the shape, and all content inside the safe circle.
   *
   * The original icon declared "any maskable" while being neither: it had a rounded
   * rect of its own, and its waterline ended 220 px from the centre against a safe
   * radius of 204.8. Under a circular mask the ends of the waterline were cut off.
   */
  const maskable = manifest.icons.filter((i) => (i.purpose ?? '').split(/\s+/).includes('maskable'))

  it('has at least one maskable icon, since Android crops the alternative badly', () => {
    expect(maskable.length).toBeGreaterThan(0)
  })

  for (const icon of maskable) {
    it(`${icon.src} bleeds to the edge and keeps its content in the safe zone`, () => {
      const svg = read(join('public', icon.src.replace(/^\.\//, '')))
      const box = svg.match(/viewBox="0 0 (\d+) (\d+)"/)
      expect(box, 'needs a square viewBox from the origin').toBeTruthy()
      const size = Number(box![1])
      expect(size).toBe(Number(box![2]))

      // Full bleed: a background rect covering the canvas, with no corner radius of
      // its own for the platform mask to fight.
      const bg = svg.match(/<rect[^>]*width="(\d+)"[^>]*height="(\d+)"[^>]*\/>/)
      expect(bg, 'needs a background rect').toBeTruthy()
      expect(Number(bg![1])).toBe(size)
      expect(Number(bg![2])).toBe(size)
      expect(bg![0]).not.toMatch(/\brx=/)

      /*
       * Content inside the safe circle. Checked through the group transform rather
       * than by parsing every path: the content is the unscaled artwork placed by
       * one `translate(m,m) scale(s)`, so the furthest any point can land from the
       * centre is bounded by scaling the original canvas diagonal.
       */
      const g = svg.match(/<g transform="translate\(([\d.]+),\s*([\d.]+)\)\s*scale\(([\d.]+)\)"/)
      expect(g, 'content must be placed by a translate+scale group').toBeTruthy()
      const [, mx, my, sc] = g!
      const scale = Number(sc)
      expect(Number(mx)).toBeCloseTo((size * (1 - scale)) / 2, 1)
      expect(Number(my)).toBeCloseTo((size * (1 - scale)) / 2, 1)
      // 80% of the canvas is the documented safe zone.
      expect(scale).toBeLessThanOrEqual(0.8)
    })
  }
})

describe('the built output stays relative', () => {
  const distIndex = join(root, 'dist', 'index.html')

  it.runIf(existsSync(distIndex))('emits no absolute asset paths', () => {
    /*
     * The check that would have caught a base-path regression. Skipped when dist is
     * absent so a fresh clone does not fail; CI builds before testing.
     */
    const built = readFileSync(distIndex, 'utf8')
    const srcs = [...built.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1])
    expect(srcs.length).toBeGreaterThan(0)
    for (const s of srcs) {
      if (s.startsWith('http') || s.startsWith('data:')) continue
      expect(s, `${s} must be relative`).not.toMatch(/^\//)
    }
  })

  it.runIf(existsSync(distIndex))('ships every file the manifest and worker need', () => {
    for (const f of ['sw.js', 'manifest.webmanifest', 'index.html']) {
      expect(existsSync(join(root, 'dist', f)), f).toBe(true)
    }
    for (const icon of manifest.icons) {
      const p = join(root, 'dist', icon.src.replace(/^\.\//, ''))
      expect(existsSync(p), `${icon.src} missing from dist`).toBe(true)
    }
  })
})
