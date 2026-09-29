/**
 * Display units for lengths: depth, draft, line length, distance below the line.
 *
 * Only lengths change. Speed stays in knots and distance in nautical miles in
 * both systems, because that is what the chart, the forecast and every other
 * boat speak. Expedition does the same by default. Everything is stored and
 * computed in metres, and is converted only here, at the display edge.
 */

export type Units = 'metric' | 'imperial'

export const METRES_PER_FOOT = 0.3048

export function lengthUnit(u: Units): 'm' | 'ft' {
  return u === 'imperial' ? 'ft' : 'm'
}

/** Metres in the display unit. */
export function toLength(m: number, u: Units): number {
  return u === 'imperial' ? m / METRES_PER_FOOT : m
}

/**
 * A length for display, with its unit, or null when there is no value.
 * Feet get one decimal fewer than metres at the same `dp`, because a foot is a
 * third of the size and the extra digit is noise.
 */
export function fmtLength(m: number | null | undefined, u: Units, dp = 1): string | null {
  if (m == null || !Number.isFinite(m)) return null
  const places = u === 'imperial' ? Math.max(0, dp - 1) : dp
  return `${toLength(m, u).toFixed(places)} ${lengthUnit(u)}`
}
