/**
 * Expedition's sail chart: which sail to carry at each true wind angle and speed.
 *
 * The file is a tab-separated table, the form Excel opens. The top row holds the
 * TWA values (after a label cell), the first column the TWS values, and each cell
 * the name of a sail:
 *
 *   TWS\TWA  40  60  90  120  150  180
 *   6        J1  J1  C0  A2   A2   A2
 *   12       J2  J2  C0  A2   A4   A4
 *
 * A point takes the sail of the nearest angle and speed in the table, so a sail's
 * area runs halfway to its neighbours. Crossovers fall midway between breakpoints,
 * which is how the grid reads when you look at it.
 */

export interface SailChart {
  twa: number[]
  tws: number[]
  /** cells[i][j]: the sail at tws[i], twa[j]. Empty string: no sail named. */
  cells: string[][]
}

export class SailChartError extends Error {}

export function parseSailChart(text: string): SailChart {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+$/, ''))
    .filter((l) => l.trim() !== '' && !l.trim().startsWith('!'))
  if (lines.length < 2) throw new SailChartError('A sail chart needs a header row of angles and at least one row of sails.')
  // Tabs, as Expedition writes it. Commas, as a spreadsheet exports it.
  const sep = lines[0].includes('\t') ? '\t' : ','
  const head = lines[0].split(sep).map((c) => c.trim())
  const twa = head.slice(1).map(Number)
  if (twa.length === 0 || twa.some((a) => !Number.isFinite(a) || a < 0 || a > 180)) {
    throw new SailChartError('The first row must be a label followed by TWA values between 0 and 180.')
  }
  for (let j = 1; j < twa.length; j++) {
    if (!(twa[j] > twa[j - 1])) throw new SailChartError('TWA values must increase across the first row.')
  }
  const tws: number[] = []
  const cells: string[][] = []
  for (const line of lines.slice(1)) {
    const c = line.split(sep).map((x) => x.trim())
    const w = Number(c[0])
    if (!Number.isFinite(w) || w < 0) throw new SailChartError(`"${c[0]}" is not a wind speed.`)
    if (tws.length && !(w > tws[tws.length - 1])) throw new SailChartError('TWS values must increase down the first column.')
    tws.push(w)
    cells.push(twa.map((_, j) => c[j + 1] ?? ''))
  }
  return { twa, tws, cells }
}

export function serialiseSailChart(chart: SailChart): string {
  const rows = [['TWS\\TWA', ...chart.twa.map(String)].join('\t')]
  chart.tws.forEach((w, i) => rows.push([String(w), ...chart.cells[i]].join('\t')))
  return rows.join('\n') + '\n'
}

/** Index of the breakpoint nearest `v`, ties going to the lower one. */
function nearest(values: number[], v: number): number {
  let best = 0
  for (let i = 1; i < values.length; i++) {
    if (Math.abs(values[i] - v) < Math.abs(values[best] - v)) best = i
  }
  return best
}

/** The sail for a true wind angle (either tack) and speed, or null if none is named. */
export function sailAt(chart: SailChart | null, twa: number, tws: number): string | null {
  if (!chart || !Number.isFinite(twa) || !Number.isFinite(tws)) return null
  const a = Math.min(180, Math.abs(twa))
  const name = chart.cells[nearest(chart.tws, tws)]?.[nearest(chart.twa, a)] ?? ''
  return name === '' ? null : name
}

/** Every sail the chart names, in the order they first appear. */
export function sailsIn(chart: SailChart): string[] {
  const seen: string[] = []
  for (const row of chart.cells) for (const s of row) if (s && !seen.includes(s)) seen.push(s)
  return seen
}

/** A stable colour for a sail name, so the same sail is the same colour everywhere. */
export function sailColour(name: string): string {
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0
  return `hsl(${h % 360} 55% 42%)`
}
