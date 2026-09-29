/**
 * Reading docs/08-parity/parity-matrix.md back as data.
 *
 * The matrix is edited by hand, one commit per worklist item, so two things need
 * code: the score every report quotes (scripts/parity-score.ts), and a test that
 * a hand edit has not left a row the score would miscount (parity-matrix.test.ts).
 * Not used by the app.
 */

export const STATUSES = ['Done', 'Partial', 'Missing', 'N/A'] as const
export const CLASSES = ['Build', 'Bridge', 'Licence', 'Hardware', 'N/A'] as const
export type Status = (typeof STATUSES)[number]
export type Class = (typeof CLASSES)[number]

export interface MatrixRow {
  area: string
  id: string
  feature: string
  status: string
  klass: string
  gap: string
}

/** Split a markdown table row on unescaped pipes, dropping the outer empties. */
export function cells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split(/(?<!\\)\|/)
    .map((c) => c.trim())
}

/**
 * Every matrix row, with its area taken from the `## ` heading above it. Only
 * tables whose first column is `ID` are rows. Columns are found by header name,
 * so adding a column later cannot shift the parse.
 */
export function parseMatrix(text: string): MatrixRow[] {
  const rows: MatrixRow[] = []
  let area = ''
  let header: string[] | null = null
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('## ')) {
      area = line.slice(3).trim()
      header = null
      continue
    }
    if (!line.startsWith('|')) {
      header = null
      continue
    }
    const c = cells(line)
    if (c[0] === 'ID') {
      header = c
      continue
    }
    if (!header || /^[-: ]+$/.test(c[0])) continue
    const h = header
    const get = (name: string) => c[h.indexOf(name)] ?? ''
    rows.push({
      area,
      id: get('ID'),
      feature: get('Feature'),
      status: get('Status'),
      klass: get('Class'),
      gap: get('Gap / how to close'),
    })
  }
  return rows
}

export interface Score {
  rows: number
  applicable: number
  byStatus: Record<Status, number>
  byClass: Record<Class, number>
  /** Applicable rows not yet Done that code alone cannot finish. */
  heldByNeeds: number
  /** Done ÷ applicable, as a percentage. The headline "parity". */
  parityPct: number
  /** (Done + ½ Partial) ÷ applicable: how far along, not how much is finished. */
  progressPct: number
}

export function score(rows: MatrixRow[]): Score {
  const byStatus = Object.fromEntries(
    STATUSES.map((s) => [s, rows.filter((r) => r.status === s).length]),
  ) as Record<Status, number>
  const byClass = Object.fromEntries(
    CLASSES.map((k) => [k, rows.filter((r) => r.klass === k).length]),
  ) as Record<Class, number>
  const applicable = rows.length - byStatus['N/A']
  const heldByNeeds = rows.filter(
    (r) => r.status !== 'Done' && r.status !== 'N/A' && (r.klass === 'Licence' || r.klass === 'Bridge'),
  ).length
  const pct = (n: number) => (applicable ? (100 * n) / applicable : 0)
  return {
    rows: rows.length,
    applicable,
    byStatus,
    byClass,
    heldByNeeds,
    parityPct: pct(byStatus.Done),
    progressPct: pct(byStatus.Done + byStatus.Partial / 2),
  }
}
