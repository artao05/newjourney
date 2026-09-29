/**
 * Prints the parity score of docs/08-parity/parity-matrix.md. Every report quotes
 * this output, so the score is computed rather than typed.
 *
 *   node scripts/parity-score.ts            summary
 *   node scripts/parity-score.ts --areas    plus a table by area
 *   node scripts/parity-score.ts --json     machine-readable
 *
 * Runs under Node's built-in type stripping (Node 22.18+ / 24).
 */

import { readFileSync } from 'node:fs'
import { parseMatrix, score } from '../src/parity-matrix.ts'

const rows = parseMatrix(
  readFileSync(new URL('../docs/08-parity/parity-matrix.md', import.meta.url), 'utf8'),
)
const s = score(rows)
const args = process.argv.slice(2)

if (args.includes('--json')) {
  console.log(JSON.stringify(s, null, 2))
} else {
  const fmt = (o: Record<string, number>) =>
    Object.entries(o)
      .map(([k, v]) => `${k} ${v}`)
      .join(' · ')
  console.log(`Rows ${s.rows} (${s.applicable} applicable)`)
  console.log(`Status: ${fmt(s.byStatus)}`)
  console.log(`Class: ${fmt(s.byClass)}`)
  console.log(`Parity (Done ÷ applicable): ${s.parityPct.toFixed(1)} %`)
  console.log(`Progress (Done + ½ Partial): ${s.progressPct.toFixed(1)} %`)
  console.log(`Not done and held by a licence or the bridge: ${s.heldByNeeds}`)
  if (args.includes('--areas')) {
    console.log('\n| Area | Rows | Done | Partial | Missing | N/A |\n|---|---|---|---|---|---|')
    for (const area of [...new Set(rows.map((r) => r.area))]) {
      const t = score(rows.filter((r) => r.area === area))
      const b = t.byStatus
      console.log(`| ${area} | ${t.rows} | ${b.Done} | ${b.Partial} | ${b.Missing} | ${b['N/A']} |`)
    }
  }
}
