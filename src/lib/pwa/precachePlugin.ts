/**
 * The build step that writes the precache list into the shipped service worker.
 *
 * Build-time only: `vite.config.ts` is its one importer, and nothing in the app
 * bundle reaches it, which is why it may use node:fs. The decisions - what is
 * critical, what is skipped - live in the pure `precache.ts` beside it.
 *
 * `closeBundle`, because the list has to be read off the disk: public/ is copied
 * in and the routing worker's chunks come from builds of their own, and neither
 * is in the main bundle's view.
 */

import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import type { Plugin } from 'vite'
import { injectPrecache, precacheList } from './precache'

export const PLUGIN_NAME = 'newjourney:precache-manifest'

export function precacheManifest(): Plugin {
  let outDir = ''
  return {
    name: PLUGIN_NAME,
    apply: 'build',
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir)
    },
    closeBundle() {
      const files = readdirSync(outDir, { recursive: true, encoding: 'utf8' })
        .filter((f) => statSync(join(outDir, f)).isFile())
        .map((f) => f.split(sep).join('/'))
      const list = precacheList(files, readFileSync(join(outDir, 'index.html'), 'utf8'))
      const sw = join(outDir, 'sw.js')
      writeFileSync(sw, injectPrecache(readFileSync(sw, 'utf8'), list))
    },
  }
}
