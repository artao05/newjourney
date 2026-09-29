/**
 * Instrument calibration: Expedition's additive correction tables.
 *
 * Every table adds a correction to a raw value, looked up by two others and
 * interpolated between the points given, holding the edge values beyond them.
 *
 *   BSP    by boat speed across and heel down        bsp += table(bsp, |heel|)
 *   AWA    by apparent angle across and speed down   awa += ±table(|awa|, aws)
 *   AWS    by apparent angle across and speed down   aws += table(|awa|, aws)
 *   TWA    by true angle across and speed down       twa += ±table(|twa|, tws)
 *   TWS    by true angle across and speed down       tws += table(|twa|, tws)
 *   Deviation by magnetic heading, on the circle      hdg += dev(hdg)
 *
 * The TWA and TWS tables are the upwash and twist correction: a masthead unit
 * reads the flow the sails have bent, differently on each point of sail, so
 * TWD swings on every tack until they are right. Angle corrections are applied
 * with the side's sign, so a correction that frees the wind on one tack frees
 * it on the other too. Sensor offsets (heel, pitch, rudder, mast) are plain
 * additions. No table means no correction.
 */

import { wrap180, wrap360 } from '@/lib/angles'
import type { Reading } from './nmea0183'

/** A correction grid: `values[r][c]` is the correction at `rows[r]`, `cols[c]`. */
export interface Table2D {
  cols: number[]
  rows: number[]
  values: number[][]
}

export interface Calibration {
  bsp: Table2D | null
  awa: Table2D | null
  aws: Table2D | null
  twa: Table2D | null
  tws: Table2D | null
  /** Deviation by magnetic heading: pairs of [heading, deviation east positive]. */
  deviation: Array<[number, number]> | null
  offsets: { heel: number; pitch: number; rudder: number; compass: number; mast: number }
}

export const NO_CALIBRATION: Calibration = {
  bsp: null,
  awa: null,
  aws: null,
  twa: null,
  tws: null,
  deviation: null,
  offsets: { heel: 0, pitch: 0, rudder: 0, compass: 0, mast: 0 },
}

/** Where `x` falls in sorted `xs`: the index below and the fraction toward the next. */
function bracket(xs: number[], x: number): [number, number] {
  if (xs.length === 1 || x <= xs[0]) return [0, 0]
  const last = xs.length - 1
  if (x >= xs[last]) return [last - 1, 1]
  let i = 0
  while (xs[i + 1] < x) i++
  return [i, (x - xs[i]) / (xs[i + 1] - xs[i])]
}

/** Bilinear lookup, held at the edges. */
export function lookup(t: Table2D, col: number, row: number): number {
  const [c, fc] = bracket(t.cols, col)
  const [r, fr] = bracket(t.rows, row)
  const v = (ri: number, ci: number) => t.values[Math.min(ri, t.rows.length - 1)]?.[Math.min(ci, t.cols.length - 1)] ?? 0
  const top = v(r, c) * (1 - fc) + v(r, c + 1) * fc
  const bottom = v(r + 1, c) * (1 - fc) + v(r + 1, c + 1) * fc
  return t.rows.length === 1 ? top : top * (1 - fr) + bottom * fr
}

/** Deviation at a heading, interpolated round the compass. */
export function deviationAt(table: Array<[number, number]>, heading: number): number {
  if (table.length === 0) return 0
  const pts = [...table].map(([h, d]) => [wrap360(h), d] as [number, number]).sort((a, b) => a[0] - b[0])
  if (pts.length === 1) return pts[0][1]
  const h = wrap360(heading)
  for (let i = 0; i < pts.length; i++) {
    const [h0, d0] = pts[i]
    const [h1raw, d1] = pts[(i + 1) % pts.length]
    const h1 = i + 1 === pts.length ? h1raw + 360 : h1raw
    const hh = h < h0 ? h + 360 : h
    if (hh >= h0 && hh <= h1) return d0 + ((d1 - d0) * (hh - h0)) / (h1 - h0 || 1)
  }
  return pts[0][1]
}

const signOf = (a: number) => (a < 0 ? -1 : 1)

/** The sensor corrections, applied before damping. */
export function calibrateRaw(r: Reading, cal: Calibration): Reading {
  const out: Reading = { ...r }
  const o = cal.offsets
  if (out.heel != null) out.heel += o.heel
  if (out.pitch != null) out.pitch += o.pitch
  if (out.rudder != null) out.rudder += o.rudder
  if (out.mastAngle != null) out.mastAngle += o.mast ?? 0
  if (out.headingMag != null) {
    const dev = cal.deviation ? deviationAt(cal.deviation, out.headingMag) : 0
    out.headingMag = wrap360(out.headingMag + o.compass)
    // A table replaces any deviation the compass sent; with none, the compass's stands.
    if (cal.deviation) out.deviation = dev
  }
  if (out.bsp != null && cal.bsp) out.bsp = Math.max(0, out.bsp + lookup(cal.bsp, out.bsp, Math.abs(out.heel ?? 0)))
  if (out.awa != null && out.aws != null) {
    const [awa, aws] = [out.awa, out.aws]
    if (cal.awa) out.awa = wrap180(awa + signOf(awa) * lookup(cal.awa, Math.abs(awa), aws))
    if (cal.aws) out.aws = Math.max(0, aws + lookup(cal.aws, Math.abs(awa), aws))
  }
  return out
}

/** The upwash and twist corrections on true wind, after it is worked out. */
export function calibrateTrue(twa: number, tws: number, cal: Calibration): { twa: number; tws: number } {
  const a = cal.twa ? wrap180(twa + signOf(twa) * lookup(cal.twa, Math.abs(twa), tws)) : twa
  const s = cal.tws ? Math.max(0, tws + lookup(cal.tws, Math.abs(twa), tws)) : tws
  return { twa: a, tws: s }
}

export class CalibrationError extends Error {}

/**
 * A table as text: the first line is the column values (the first cell may be
 * blank or a label), then one line per row, the row value first. Commas, tabs,
 * semicolons or spaces between cells.
 */
export function parseTable(text: string): Table2D {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => l.split(/[,\t; ]+/))
  if (lines.length < 2) throw new CalibrationError('A table needs a header line of column values and at least one row.')
  const head = lines[0]
  const cols = (Number.isFinite(Number(head[0])) && head.length === lines[1].length - 1 ? head : head.slice(1)).map(Number)
  if (cols.length === 0 || cols.some((c) => !Number.isFinite(c))) throw new CalibrationError('The header line must be numbers.')
  const rows: number[] = []
  const values: number[][] = []
  for (const [i, line] of lines.slice(1).entries()) {
    const nums = line.map(Number)
    if (nums.length !== cols.length + 1 || nums.some((n) => !Number.isFinite(n))) {
      throw new CalibrationError(`Row ${i + 1} should be a row value and ${cols.length} numbers.`)
    }
    rows.push(nums[0])
    values.push(nums.slice(1))
  }
  const ascending = (xs: number[]) => xs.every((x, i) => i === 0 || x > xs[i - 1])
  if (!ascending(cols) || !ascending(rows)) throw new CalibrationError('Row and column values must go up.')
  return { cols, rows, values }
}

/** Deviation as text: one `heading, deviation` pair a line, east positive. */
export function parseDeviation(text: string): Array<[number, number]> {
  const out: Array<[number, number]> = []
  for (const [i, raw] of text.split(/\r?\n/).entries()) {
    const l = raw.trim()
    if (!l || l.startsWith('#')) continue
    const [h, d] = l.split(/[,\t; ]+/).map(Number)
    if (!Number.isFinite(h) || !Number.isFinite(d)) throw new CalibrationError(`Line ${i + 1} should be a heading and a deviation.`)
    out.push([h, d])
  }
  if (out.length === 0) throw new CalibrationError('No deviation pairs were found.')
  return out
}
