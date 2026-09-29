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
