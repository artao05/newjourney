/**
 * What a number box shows beyond the channel as it comes: a damped value
 * (the mean over some seconds, circular for angles), and, for a box set by
 * situation, which of its channels the moment calls for.
 */
import type { ChannelValues } from './snapshot'

export type AngleKind = 'none' | 'signed' | 'unsigned'

/**
 * The mean of the values within `seconds` of `now`: plain, or circular for
 * an angle (so 359° and 1° average to 0°, not 180°).
 */
export function dampedValue(history: ReadonlyArray<readonly [number, number]>, now: number, seconds: number, angle: AngleKind = 'none'): number | null {
  const since = now - seconds * 1000
  const vs = history.filter(([t, v]) => t >= since && Number.isFinite(v)).map(([, v]) => v)
  if (!vs.length) return null
  if (angle === 'none') return vs.reduce((a, b) => a + b, 0) / vs.length
  const r = Math.PI / 180
  const x = vs.reduce((a, v) => a + Math.cos(v * r), 0)
  const y = vs.reduce((a, v) => a + Math.sin(v * r), 0)
  if (Math.hypot(x, y) < 1e-9) return null
  const deg = Math.atan2(y, x) / r
  return angle === 'unsigned' ? (deg + 360) % 360 : deg
}

export type Situation = 'upwind' | 'reaching' | 'downwind' | 'prestart'

/**
 * The point of sail, or before the start: upwind until the TWA is more than
 * `bandDeg` wider than the upwind target, downwind from `bandDeg` inside the
 * downwind target, and reaching between. Before the gun, prestart.
 */
export function situationOf(v: ChannelValues, bandDeg = 10): Situation | null {
  const toGun = v['start-time-to-gun']
  if (toGun != null && toGun > 0) return 'prestart'
  const twa = v.twa
  if (twa == null || !Number.isFinite(twa)) return null
  const a = Math.abs(twa)
  const target = v['target-twa']
  const t = target != null && Number.isFinite(target) ? Math.abs(target) : null
  if (a < 90) return t != null && a > t + bandDeg ? 'reaching' : 'upwind'
  return t != null && a < t - bandDeg ? 'reaching' : 'downwind'
}

/** Which of a situation box's channels to show: upwind, reaching, downwind, then prestart if it has one. */
export function situationIndex(s: Situation | null, count: number): number {
  const i = s === 'reaching' ? 1 : s === 'downwind' ? 2 : s === 'prestart' ? 3 : 0
  return i < count ? i : 0
}
