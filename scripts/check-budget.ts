/**
 * Fails the build when the first download grows past its limit.
 *
 *   node scripts/check-budget.ts     (`npm run build` runs it)
 *
 * The first download is what `dist/index.html` names, gzipped. It decides how long a
 * sailor on the dock waits for the Start tab, and it doubled over one branch without
 * anything noticing. If a change needs more room, make the code load later before
 * raising a number here.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'

const DIST = 'dist'
const LIMIT_KB = { js: 115, css: 8 }

const html = readFileSync(join(DIST, 'index.html'), 'utf8')
const named = [...new Set([...html.matchAll(/(?:src|href)="\.\/(assets\/[^"]+)"/g)].map((m) => m[1]))]
const sizes = { js: 0, css: 0 }
for (const f of named) {
  const kind = f.endsWith('.css') ? 'css' : f.endsWith('.js') ? 'js' : null
  if (kind) sizes[kind] += gzipSync(readFileSync(join(DIST, f))).length / 1024
}

if (sizes.js === 0) {
  console.error('First download: index.html names no script. Has the build changed shape?')
  process.exit(1)
}
const line = `First download: ${sizes.js.toFixed(1)} KB of JS (limit ${LIMIT_KB.js}), ${sizes.css.toFixed(1)} KB of CSS (limit ${LIMIT_KB.css}), gzipped.`
if (sizes.js > LIMIT_KB.js || sizes.css > LIMIT_KB.css) {
  console.error(`${line}\nOver the limit: load something later (see src/App.tsx), then build again.`)
  process.exit(1)
}
console.log(line)
