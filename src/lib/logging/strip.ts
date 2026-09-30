/**
 * The stripchart's arithmetic: a channel's series in a time window, thinned to
 * what a pane can draw, and the mean between two wands. Angles are averaged
 * on the circle, so a wind oscillating through north averages to north.
 */

import { CHANNELS } from '@/lib/channels/catalogue'
import type { LogRow } from './logger'

const UNIT = new Map(CHANNELS.map((c) => [c.id, c.unit]))
const BEARINGS = new Set(['twd', 'cog', 'heading', 'gwd', 'course', 'current-set', 'heading-to-steer'])

/** Whether a channel is an angle, and if so a compass bearing (0–360) or signed. */
export function angleKind(id: string): 'bearing' | 'signed' | null {
  if (UNIT.get(id) !== 'deg') return null
  return BEARINGS.has(id) || id.startsWith('twd') ? 'bearing' : 'signed'
}

/** The channel's points between `from` and `to`, thinned to at most `max`. */
export function series(rows: LogRow[], id: string, from: number, to: number, max = 600): Array<[number, number]> {
  const pts: Array<[number, number]> = []
  for (const r of rows) {
    if (r.t < from || r.t > to) continue
    const v = r.v[id]
    if (Number.isFinite(v)) pts.push([r.t, v])
  }
  if (pts.length <= max) return pts
  const step = pts.length / max
  const out: Array<[number, number]> = []
  for (let i = 0; i < max; i++) out.push(pts[Math.floor(i * step)])
  return out
}

/** The mean of a channel between two times, on the circle for angles; null with no data. */
export function meanBetween(rows: LogRow[], id: string, a: number, b: number): number | null {
  const [from, to] = a <= b ? [a, b] : [b, a]
  const kind = angleKind(id)
  let n = 0
  let sx = 0
  let sy = 0
  for (const r of rows) {
    if (r.t < from || r.t > to) continue
    const v = r.v[id]
    if (!Number.isFinite(v)) continue
    n++
    if (kind) {
      sx += Math.cos((v * Math.PI) / 180)
      sy += Math.sin((v * Math.PI) / 180)
    } else sx += v
  }
  if (n === 0) return null
  if (!kind) return sx / n
  const deg = (Math.atan2(sy, sx) * 180) / Math.PI
  return kind === 'bearing' ? (deg + 360) % 360 : deg
}

/** Section two's mean less section one's; for angles, the shortest way round. */
export function sectionDelta(id: string, m1: number | null, m2: number | null): number | null {
  if (m1 == null || m2 == null) return null
  const d = m2 - m1
  return angleKind(id) ? ((((d + 180) % 360) + 360) % 360) - 180 : d
}

/** A pane's value axis: the data's range, padded, and never zero-height. */
export function valueRange(pts: Array<[number, number]>): [number, number] {
  if (pts.length === 0) return [0, 1]
  let lo = Infinity
  let hi = -Infinity
  for (const [, v] of pts) {
    lo = Math.min(lo, v)
    hi = Math.max(hi, v)
  }
  const pad = Math.max((hi - lo) * 0.08, 0.5)
  return [lo - pad, hi + pad]
}

/** The points resampled to `hz`: the last value in each 1/hz-second slot. */
export function resample(pts: Array<[number, number]>, hz: number): Array<[number, number]> {
  if (!(hz > 0) || pts.length === 0) return pts
  const slot = 1000 / hz
  const out: Array<[number, number]> = []
  let cur = -Infinity
  for (const p of pts) {
    const k = Math.floor(p[0] / slot)
    if (k === cur) out[out.length - 1] = p
    else {
      out.push(p)
      cur = k
    }
  }
  return out
}

/** Mean and standard deviation of a channel's points, on the circle for angles. */
export function meanSd(id: string, pts: Array<[number, number]>): { mean: number; sd: number } | null {
  if (!pts.length) return null
  const kind = angleKind(id)
  if (!kind) {
    const m = pts.reduce((a, [, v]) => a + v, 0) / pts.length
    return { mean: m, sd: Math.sqrt(pts.reduce((a, [, v]) => a + (v - m) ** 2, 0) / pts.length) }
  }
  const r = Math.PI / 180
  const x = pts.reduce((a, [, v]) => a + Math.cos(v * r), 0) / pts.length
  const y = pts.reduce((a, [, v]) => a + Math.sin(v * r), 0) / pts.length
  const R = Math.min(1, Math.hypot(x, y))
  const deg = Math.atan2(y, x) / r
  // The circular standard deviation: sqrt(−2 ln R), in degrees.
  return { mean: kind === 'bearing' ? (deg + 360) % 360 : deg, sd: R > 0 ? Math.sqrt(-2 * Math.log(R)) / r : 180 }
}

export type AxisMode = 'auto' | 'roll' | 'shift'

/**
 * A pane's value axis from the last one drawn. Auto fits the data each time.
 * Roll keeps the span and slides it, only when the newest value nears an
 * edge, to put it back in the middle. Shift moves toward the fit by no more
 * than `shiftMax` a step, so a spike does not throw the scale about.
 */
export function nextAxis(prev: [number, number] | null, pts: Array<[number, number]>, mode: AxisMode, shiftMax = 1): [number, number] {
  const fit = valueRange(pts)
  if (!prev || mode === 'auto' || !pts.length) return fit
  if (mode === 'roll') {
    const span = prev[1] - prev[0]
    const last = pts[pts.length - 1][1]
    const edge = span * 0.1
    if (last > prev[0] + edge && last < prev[1] - edge) return prev
    return [last - span / 2, last + span / 2]
  }
  const step = (from: number, to: number) => from + Math.max(-shiftMax, Math.min(shiftMax, to - from))
  return [step(prev[0], fit[0]), step(prev[1], fit[1])]
}
