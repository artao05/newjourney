/**
 * The parity matrix is hand-edited, one commit per worklist item, and every report
 * quotes a score computed from it. A row with a misspelt status or a duplicated ID
 * would not fail anything else. It would just make the score quietly wrong, and
 * that score is the number the owner reads.
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { CLASSES, STATUSES, cells, parseMatrix, score } from './parity-matrix'

const matrix = readFileSync('docs/08-parity/parity-matrix.md', 'utf8')
const rows = parseMatrix(matrix)

describe('the parser', () => {
  it('splits on unescaped pipes only', () => {
    expect(cells('| a | b \\| c | d |')).toEqual(['a', 'b \\| c', 'd'])
  })

  it('takes areas from headings, columns from the header, and skips other tables', () => {
    const text = [
      '## Charts',
      '',
      '| ID | Feature | Status | Class | Gap / how to close |',
      '|---|---|---|---|---|',
      '| P1-001 | S-57 | Missing | Build | parser |',
      '',
      '## Appendix',
      '| Channel | Meaning |',
      '|---|---|',
      '| Awa | angle |',
    ].join('\n')
    expect(parseMatrix(text)).toEqual([
      { area: 'Charts', id: 'P1-001', feature: 'S-57', status: 'Missing', klass: 'Build', gap: 'parser' },
    ])
  })

  it('scores N/A out of the denominator and counts Partial as half progress', () => {
    const r = (status: string, klass = 'Build') => ({ area: 'a', id: 'x', feature: '', status, klass, gap: '' })
    const s = score([r('Done'), r('Partial'), r('Missing', 'Licence'), r('N/A', 'N/A')])
    expect(s.applicable).toBe(3)
    expect(s.parityPct).toBeCloseTo(100 / 3)
    expect(s.progressPct).toBeCloseTo(50)
    expect(s.heldByNeeds).toBe(1)
  })
})

describe('docs/08-parity/parity-matrix.md', () => {
  it('holds the whole manual', () => {
    // Four extraction slices gave 1,011 rows. A big drop means a table broke.
    expect(rows.length).toBeGreaterThan(1000)
  })

  it('gives every row a unique ID in the slice-row form', () => {
    const seen = new Set<string>()
    const bad = rows.filter((r) => !/^P[1-4]-\d{3}$/.test(r.id) || seen.has(r.id) || !seen.add(r.id))
    expect(bad.map((r) => r.id)).toEqual([])
  })

  it('uses only the defined statuses and classes', () => {
    const bad = rows.filter(
      (r) =>
        !(STATUSES as readonly string[]).includes(r.status) ||
        !(CLASSES as readonly string[]).includes(r.klass),
    )
    expect(bad.map((r) => `${r.id} ${r.status}/${r.klass}`)).toEqual([])
  })

  it('marks a row N/A in both columns or neither', () => {
    const bad = rows.filter((r) => (r.status === 'N/A') !== (r.klass === 'N/A'))
    expect(bad.map((r) => `${r.id} ${r.status}/${r.klass}`)).toEqual([])
  })

  it('says what is missing, or where the evidence is, on every applicable row', () => {
    const bad = rows.filter((r) => r.status !== 'N/A' && r.status !== 'Done' && r.gap === '')
    expect(bad.map((r) => r.id)).toEqual([])
  })
})
