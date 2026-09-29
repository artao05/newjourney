/**
 * Log playback: a logged day back into the app as if it were live.
 *
 * Each second of a log is a row of channel values. Replaying one means finding
 * the row at the play time and turning it back into what the live sources
 * would have given: boat state, wind, the instrument reading and the current.
 */

import type { BoatState, CurrentEstimate, WindEstimate } from '@/lib/types'
import type { Reading } from '@/lib/instruments/nmea0183'
import type { LogRow } from './logger'

/** The last row at or before `t`, or the first row if `t` is before them all. */
export function rowAt(rows: LogRow[], t: number): LogRow | null {
  if (rows.length === 0) return null
  let lo = 0
  let hi = rows.length - 1
  if (t <= rows[0].t) return rows[0]
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (rows[mid].t <= t) lo = mid
    else hi = mid - 1
  }
  return rows[lo]
}

const num = (v: Record<string, number>, k: string) => (Number.isFinite(v[k]) ? v[k] : null)

/** The boat as the log saw it; the row's own time, so fix age reads true. */
export function stateFromRow(r: LogRow): BoatState | null {
  const lat = num(r.v, 'latitude')
  const lon = num(r.v, 'longtitude')
  if (lat == null || lon == null) return null
  return {
    t: r.t,
    position: { lat, lon },
    cog: num(r.v, 'cog') ?? NaN,
    sog: num(r.v, 'sog') ?? NaN,
    accuracyM: num(r.v, 'gps-estimated-position-error'),
    heading: num(r.v, 'heading'),
    bsp: num(r.v, 'bsp'),
    heelDeg: num(r.v, 'heel-roll'),
  }
}

export function windFromRow(r: LogRow): WindEstimate | null {
  const twd = num(r.v, 'twd')
  const tws = num(r.v, 'tws')
  return twd == null || tws == null ? null : { twd, tws, source: 'instrument', uncertaintyDeg: 5, t: r.t }
}

export function currentFromRow(r: LogRow): CurrentEstimate | null {
  const set = num(r.v, 'current-set')
  const drift = num(r.v, 'current-drift')
  return set == null || drift == null ? null : { set, drift, source: 'measured' }
}

/** The instrument channels back into a reading, for the boxes that show them raw. */
export function readingFromRow(r: LogRow): Reading {
  const map: Array<[keyof Reading, string]> = [
    ['awa', 'awa'],
    ['aws', 'aws'],
    ['depthM', 'depth'],
    ['waterTempC', 'sea-temperature'],
    ['airTempC', 'air-temperature'],
    ['baroHpa', 'barometer'],
    ['humidityPct', 'relative-humidity'],
    ['pitch', 'trim-pitch'],
    ['rudder', 'rudder'],
    ['mastAngle', 'mast-angle'],
    ['logNm', 'log-bsp'],
    ['tripNm', 'instrument-trip-log'],
    ['hdop', 'gps-hdop'],
    ['altitudeM', 'gps-altitude'],
  ]
  const out: Reading = {}
  for (const [k, c] of map) {
    const x = num(r.v, c)
    if (x != null) (out as Record<string, number>)[k] = x
  }
  return out
}

export const PLAYBACK_SPEEDS = [1, 2, 5, 10, 30, 60] as const
