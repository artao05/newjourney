/**
 * Expedition's What-if: a wind shift, a speed change and a current, laid over
 * the real numbers to see where the laylines and times would go.
 *
 * "A navigator might be expecting a 10° shift to the left and want to see where
 * the laylines would be." It decorates the wind and current every screen already
 * uses, so Race, Start, the Route laylines and the number boxes all move
 * together. It is never persisted: a what-if left on from yesterday is a lie.
 */

import type { CurrentEstimate, WindEstimate } from '@/lib/types'
import { wrap360 } from '@/lib/angles'

export interface WhatIf {
  shiftDeg: number
  speedDeltaKn: number
  /** A what-if current, replacing the measured one, or null to leave it alone. */
  current: { set: number; drift: number } | null
}

export const NO_WHAT_IF: WhatIf = { shiftDeg: 0, speedDeltaKn: 0, current: null }

export function whatIfActive(w: WhatIf): boolean {
  return w.shiftDeg !== 0 || w.speedDeltaKn !== 0 || w.current !== null
}

export function applyWhatIfWind(wind: WindEstimate | null, w: WhatIf): WindEstimate | null {
  if (!wind || (w.shiftDeg === 0 && w.speedDeltaKn === 0)) return wind
  return { ...wind, twd: wrap360(wind.twd + w.shiftDeg), tws: Math.max(0.5, wind.tws + w.speedDeltaKn) }
}

export function applyWhatIfCurrent(current: CurrentEstimate | null, w: WhatIf): CurrentEstimate | null {
  if (!w.current) return current
  return { set: wrap360(w.current.set), drift: Math.max(0, w.current.drift), source: 'what-if' }
}

/** The banner text, e.g. "+10° shift, −2 kn, current 045° 0.8 kn". */
export function describeWhatIf(w: WhatIf): string {
  const parts: string[] = []
  const signed = (n: number) => (n > 0 ? `+${n}` : `${n}`)
  if (w.shiftDeg !== 0) parts.push(`${signed(w.shiftDeg)}° shift`)
  if (w.speedDeltaKn !== 0) parts.push(`${signed(w.speedDeltaKn)} kn`)
  if (w.current) parts.push(`current ${String(Math.round(wrap360(w.current.set))).padStart(3, '0')}° ${w.current.drift.toFixed(1)} kn`)
  return parts.join(', ')
}
