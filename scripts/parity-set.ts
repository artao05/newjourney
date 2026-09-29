/**
 * Update rows of docs/08-parity/parity-matrix.md by ID, in place.
 *
 *   node scripts/parity-set.ts <Status> <ID>... [--gap "text"]
 *
 * e.g. node scripts/parity-set.ts Done P2-184 P2-213 --gap "RouteSettingsSheet.tsx"
 *
 * Only the Status cell, and the Gap cell when --gap is given, are rewritten.
 * Every other byte of the file is left alone, so the diff shows exactly the
 * rows an item closed. Unknown IDs and statuses fail loudly rather than being
 * skipped.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { STATUSES, cells } from '../src/parity-matrix.ts'

const path = new URL('../docs/08-parity/parity-matrix.md', import.meta.url)
const args = process.argv.slice(2)
const gapAt = args.indexOf('--gap')
const gap = gapAt >= 0 ? args[gapAt + 1] : null
const positional = gapAt >= 0 ? args.slice(0, gapAt) : args
const [status, ...ids] = positional

if (!(STATUSES as readonly string[]).includes(status) || ids.length === 0) {
  console.error(`usage: parity-set.ts <${STATUSES.join('|')}> <ID>... [--gap "text"]`)
  process.exit(2)
}

const text = readFileSync(path, 'utf8')
const eol = text.includes('\r\n') ? '\r\n' : '\n'
let header: string[] | null = null
const found = new Set<string>()
const out = text.split(/\r?\n/).map((line) => {
  if (!line.startsWith('|')) {
    header = null
    return line
  }
  const c = cells(line)
  if (c[0] === 'ID') {
    header = c
    return line
  }
  if (!header || !ids.includes(c[0])) return line
  found.add(c[0])
  c[header.indexOf('Status')] = status
  if (gap != null) c[header.indexOf('Gap / how to close')] = gap.replace(/(?<!\\)\|/g, '\\|')
  return `| ${c.join(' | ')} |`
})

const missing = ids.filter((id) => !found.has(id))
if (missing.length) {
  console.error(`not in the matrix: ${missing.join(', ')}`)
  process.exit(1)
}
writeFileSync(path, out.join(eol))
console.log(`${status}: ${ids.join(', ')}`)
