/**
 * The precache list, and its injection into the worker.
 *
 * What the service worker stores at install decides whether a phone that opened
 * the app once can open it again with no signal. These pin the list against a
 * build's real shape: the entry chunk and its stylesheet are critical, the lazy
 * chunks, the routing worker and the venue packs are fetched best-effort, and the
 * worker itself and the source maps never go in.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { injectPrecache, precacheList } from './precache'
import { PLUGIN_NAME, precacheManifest } from './precachePlugin'

/** A build as it lands on disk, source maps included. */
const FILES = [
  'index.html',
  'manifest.webmanifest',
  'sw.js',
  'icon.svg',
  'icon-maskable.svg',
  'venue/portland-depth.bin',
  'venue/portland-land.bin',
  'assets/index-DiSFO5CF.js',
  'assets/index-DiSFO5CF.js.map',
  'assets/index-BCzdZZKQ.css',
  'assets/RouteScreen-DTl6xd66.js',
  'assets/RouteScreen-DTl6xd66.js.map',
  'assets/WeatherScreen-CYB_1FWg.js',
  'assets/bathymetry-DfJjUJMv.js',
  'assets/bathymetry-DNVN2dqC.css',
  'assets/gpx-D0AkVrXy.js',
  'assets/worker-Bi4lJmyJ.js',
  'assets/polar-DGtKRNLX.js',
  'assets/index-DhFndrxb.js',
  '.vite/manifest.json',
]

/** The head of the built page, attribute order as Vite writes it. */
const INDEX = `<!doctype html><html><head>
<link rel="manifest" href="./manifest.webmanifest" />
<script type="module" crossorigin src="./assets/index-DiSFO5CF.js"></script>
<link rel="stylesheet" crossorigin href="./assets/index-BCzdZZKQ.css">
</head><body><div id="root"></div></body></html>`

describe('precacheList', () => {
  const list = precacheList(FILES, INDEX)

  it('makes the page, the manifest and everything the page names critical', () => {
    expect(list.critical).toEqual([
      './',
      './index.html',
      './manifest.webmanifest',
      './assets/index-DiSFO5CF.js',
      './assets/index-BCzdZZKQ.css',
    ])
  })

  it('fetches the lazy chunks, the routing worker and the venue packs best-effort', () => {
    for (const f of [
      './assets/RouteScreen-DTl6xd66.js',
      './assets/WeatherScreen-CYB_1FWg.js',
      './assets/bathymetry-DfJjUJMv.js',
      './assets/bathymetry-DNVN2dqC.css',
      './assets/worker-Bi4lJmyJ.js',
      './assets/polar-DGtKRNLX.js',
      './venue/portland-depth.bin',
      './venue/portland-land.bin',
      './icon.svg',
    ]) {
      expect(list.rest, f).toContain(f)
    }
  })

  it('never precaches the worker itself, a source map or build metadata', () => {
    const all = [...list.critical, ...list.rest]
    expect(all).not.toContain('./sw.js')
    expect(all.filter((f) => f.endsWith('.map'))).toEqual([])
    expect(all.filter((f) => f.includes('.vite/'))).toEqual([])
  })

  it('lists nothing twice, so one file is never fetched as both kinds', () => {
    const all = [...list.critical, ...list.rest]
    expect(new Set(all).size).toBe(all.length)
  })

  it('catches a modulepreload as critical too', () => {
    const withPreload = INDEX.replace(
      '</head>',
      '<link rel="modulepreload" crossorigin href="./assets/polar-DGtKRNLX.js"></head>',
    )
    const l = precacheList(FILES, withPreload)
    expect(l.critical).toContain('./assets/polar-DGtKRNLX.js')
    expect(l.rest).not.toContain('./assets/polar-DGtKRNLX.js')
  })

  it('refuses a page that names a file the build did not write', () => {
    expect(() => precacheList(FILES.filter((f) => f !== 'assets/index-BCzdZZKQ.css'), INDEX)).toThrow(
      /index-BCzdZZKQ\.css/,
    )
  })

  it('refuses a page with no entry chunk, rather than precaching an app that cannot start', () => {
    expect(() => precacheList(FILES, '<html></html>')).toThrow(/names no/)
  })
})

describe('injectPrecache', () => {
  const source = readFileSync(join(process.cwd(), 'public', 'sw.js'), 'utf8')

  it('rewrites the marked line of the real worker, and only that line', () => {
    const list = precacheList(FILES, INDEX)
    const out = injectPrecache(source, list)
    expect(out).toContain(`const PRECACHE = ${JSON.stringify(list)} // @precache`)
    expect(out.split('\n').length).toBe(source.split('\n').length)
  })

  it('fails the build if the marked line has gone, instead of precaching nothing', () => {
    const lost = source.replace(/ \/\/ @precache$/m, '')
    expect(() => injectPrecache(lost, { critical: [], rest: [] })).toThrow(/@precache/)
  })

  it('writes a $ in a file name literally', () => {
    const out = injectPrecache(source, { critical: ['./a$&b.js'], rest: [] })
    expect(out).toContain('"./a$&b.js"')
  })
})

describe('the build plugin', () => {
  it('writes the list of a real output folder into its worker', () => {
    const out = mkdtempSync(join(tmpdir(), 'nj-precache-'))
    try {
      const put = (f: string, body = '') => {
        mkdirSync(dirname(join(out, f)), { recursive: true })
        writeFileSync(join(out, f), body)
      }
      for (const f of FILES) put(f)
      put('index.html', INDEX)
      put('sw.js', readFileSync(join(process.cwd(), 'public', 'sw.js'), 'utf8'))

      const plugin = precacheManifest() as unknown as {
        configResolved(c: { root: string; build: { outDir: string } }): void
        closeBundle(): void
      }
      plugin.configResolved({ root: out, build: { outDir: '.' } })
      plugin.closeBundle()

      const shipped = readFileSync(join(out, 'sw.js'), 'utf8')
      // Nested folders come back with forward slashes, whatever the OS writes.
      expect(shipped).toContain('"./venue/portland-land.bin"')
      expect(shipped).toContain('"./assets/index-DiSFO5CF.js"')
      expect(shipped).not.toContain('.js.map"')
    } finally {
      rmSync(out, { recursive: true, force: true })
    }
  })

  it('is wired into the build, so a shipped worker is never left with the bare shell', async () => {
    // A path tsc does not follow: the config is plain runtime data here, and its
    // `test` block is typed by vitest rather than by vite.
    const configPath = join(process.cwd(), 'vite.config.ts')
    const { default: config } = (await import(/* @vite-ignore */ configPath)) as {
      default: { plugins: unknown[] }
    }
    const names = config.plugins.flat(3).map((p) => (p as { name?: string } | null)?.name)
    expect(names).toContain(PLUGIN_NAME)
  })
})
