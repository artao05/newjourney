/**
 * An instrument reading as the app's boat state and wind.
 *
 * Everything past the sensors (tactics, start, routing) reads `BoatState` and
 * `WindEstimate`, so this is where a Signal K or NMEA feed joins the rest of
 * the app. It never invents a value: a field the instruments did not send stays
 * NaN or null, which every consumer already reads as "not known".
 */

import type { BoatState, WindEstimate } from '@/lib/types'
import type { Reading } from './nmea0183'

const wrap = (a: number) => ((a % 360) + 360) % 360

/** Heading true: sent as true, or magnetic corrected by deviation and variation. */
export function headingTrueOf(r: Reading): number | null {
  if (r.headingTrue != null) return r.headingTrue
  if (r.headingMag != null && r.variation != null) return wrap(r.headingMag + (r.deviation ?? 0) + r.variation)
  return null
}

/**
 * Horizontal accuracy from HDOP, by the usual rule of about 5 m of error per
 * unit of HDOP for a plain GPS. A rough figure, but the start tools need some
 * figure to warn with, and HDOP is all NMEA gives.
 */
export const METRES_PER_HDOP = 5

export function boatStateFrom(r: Reading, now: number): BoatState | null {
  if (r.lat == null || r.lon == null) return null
  return {
    t: now,
    position: { lat: r.lat, lon: r.lon },
    cog: r.cog ?? NaN,
    sog: r.sog ?? NaN,
    accuracyM: r.hdop != null ? r.hdop * METRES_PER_HDOP : null,
    heading: headingTrueOf(r),
    bsp: r.bsp ?? null,
    heelDeg: r.heel ?? null,
  }
}

/**
 * True wind from the instruments: TWD and TWS if sent, else TWA and TWS turned
 * into a direction with the heading. Apparent wind alone is not enough here; the
 * true-wind calculation from it is the instrument pipeline (worklist 6.4).
 */
export function windFrom(r: Reading, now: number): WindEstimate | null {
  if (r.tws == null) return null
  let twd = r.twd ?? null
  if (twd == null && r.twa != null) {
    const hdg = headingTrueOf(r)
    if (hdg != null) twd = wrap(hdg + r.twa)
  }
  if (twd == null) return null
  return { twd, tws: r.tws, source: 'instrument', uncertaintyDeg: 3, t: now }
}
