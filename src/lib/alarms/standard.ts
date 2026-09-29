/**
 * The standard alarms: ready-made rules, and the two derived values they need
 * that no channel carries, distance from the anchor and the wind's shift.
 */

import type { LatLon } from '@/lib/types'
import { distance } from '@/lib/geo'
import type { AlarmRule } from './engine'

/** How far the boat is from where the anchor went down, metres. */
export function anchorDistanceM(anchor: LatLon | null, at: LatLon | null): number | null {
  return anchor && at ? distance(anchor, at) * 1852 : null
}

/**
 * How far the wind has swung from its mean over the last `windowMin` minutes,
 * degrees, signed (+ clockwise, a veer). Null until there are a few minutes to
 * average; a shift is measured against something.
 */
export function windShiftDeg(
  history: ReadonlyArray<{ t: number; twd: number }>,
  now: number,
  windowMin = 10,
): number | null {
  const from = now - windowMin * 60_000
  const pts = history.filter((h) => h.t >= from && h.t <= now && Number.isFinite(h.twd))
  if (pts.length < 3 || pts[pts.length - 1].t - pts[0].t < 120_000) return null
  let sx = 0
  let sy = 0
  for (const p of pts) {
    sx += Math.cos((p.twd * Math.PI) / 180)
    sy += Math.sin((p.twd * Math.PI) / 180)
  }
  const mean = (Math.atan2(sy, sx) * 180) / Math.PI
  const d = pts[pts.length - 1].twd - mean
  return ((((d + 180) % 360) + 360) % 360) - 180
}

/** Values that are not channels, for the alarm engine and the banner. */
export const DERIVED_UNITS: Record<string, string> = { 'anchor-distance': 'm', 'wind-shift': '°' }

export const STANDARD_ALARMS: Array<{ key: string; label: string; rule: Omit<AlarmRule, 'id'> }> = [
  {
    key: 'depth',
    label: 'Shallow water',
    rule: { name: 'Shallow water', channel: 'depth', op: 'below', value: 3, hysteresis: 0.5, delayS: 5, enabled: true },
  },
  {
    key: 'arrival',
    label: 'Arriving at the mark',
    rule: { name: 'Arriving at the mark', channel: 'mark-range', op: 'below', value: 0.1, hysteresis: 0.02, delayS: 0, enabled: true },
  },
  {
    key: 'off-course',
    label: 'Off course',
    rule: { name: 'Off course', channel: 'cross-track-error', op: 'above', value: 0.2, hysteresis: 0.05, delayS: 10, enabled: true, absolute: true },
  },
  {
    key: 'layline-port',
    label: 'Port layline',
    rule: { name: 'Port layline close', channel: 'layline-distance-on-port', op: 'below', value: 0.05, hysteresis: 0.02, delayS: 0, enabled: true },
  },
  {
    key: 'layline-starboard',
    label: 'Starboard layline',
    rule: { name: 'Starboard layline close', channel: 'layline-distance-on-starboard', op: 'below', value: 0.05, hysteresis: 0.02, delayS: 0, enabled: true },
  },
  {
    key: 'gps',
    label: 'GPS lost',
    rule: { name: 'GPS lost', channel: 'gps-age', op: 'above', value: 10, hysteresis: 5, delayS: 0, enabled: true, missingFires: true },
  },
  {
    key: 'anchor',
    label: 'Anchor dragging',
    rule: { name: 'Anchor dragging', channel: 'anchor-distance', op: 'above', value: 30, hysteresis: 5, delayS: 10, enabled: true },
  },
  {
    key: 'wind-shift',
    label: 'Wind shift',
    rule: { name: 'Wind shift', channel: 'wind-shift', op: 'above', value: 10, hysteresis: 3, delayS: 30, enabled: true, absolute: true },
  },
]
