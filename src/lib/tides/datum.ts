/**
 * Vertical datums: turning a modelled depth into water you can float in.
 *
 * Three references meet here and none of them agree:
 *
 *   - **GEBCO** gives elevation above **mean sea level**, positive up.
 *     `depthAt` in `src/data/bathymetry.ts` flips that to depth below MSL,
 *     positive down.
 *   - **NOAA CO-OPS** gives water-surface height above **MLLW** (mean lower low
 *     water), the datum every US chart and printed tide table uses.
 *   - **MSL sits above MLLW** — 1.51 m at Portland station 8418150.
 *
 * So a GEBCO depth is measured from a surface that is usually *higher* than the
 * chart's, which is why the depth layer reads about a metre and a half optimistic
 * at low water. The correction:
 *
 *     depthNow = depthBelowMsl + waterAboveMllw(t) − mslAboveMllw
 *
 * Read the last two terms together: they are the height of the actual water
 * surface relative to mean sea level, which is negative on a falling tide below
 * mean and positive above it. At MLLW exactly the bracket is −1.51 m, so there is
 * a metre and a half less water than the grid claims; at MSL it is zero and the
 * grid is right; at high water it is positive.
 *
 * **This is the module to be suspicious of.** Every term is a small number, the
 * sign of two of them is a convention rather than a fact, and getting one backwards
 * produces a plausible depth that is wrong by three metres at the exact moment it
 * matters — a spring low. The tests pin all three anchor points before anything
 * else, and `datum.test.ts` exists mainly to make a sign inversion fail loudly.
 *
 * ## What this does not fix
 *
 * The datum correction is exact arithmetic on an inexact depth. GEBCO reads 18 m
 * shallow at NDBC 44007 and its cells are 450 m across, so nothing here turns the
 * grid into a survey — see `DEPTH_NOT_FOR_NAVIGATION`. A tide correction makes the
 * number *less wrong in a known direction*; it does not make it right.
 *
 * One station's tide is also not a bay-wide tide. Casco Bay's range varies across
 * its length and the correction is applied uniformly, which is defensible over a
 * venue this size and would not be over a coastline.
 */

import type { Metres, Millis } from '@/lib/types'
import { waterLevelAt, type WaterLevelPrediction } from './coops'

/** The vertical reference a depth number is measured from. */
export interface TidalDatum {
  /** Height of local mean sea level above MLLW, metres. Positive by definition. */
  mslAboveMllwM: Metres
  /** Station the figure belongs to, for display and for blaming. */
  stationId: string
}

/**
 * Height of the water surface relative to mean sea level, metres.
 *
 * Signed: negative below mean sea level, positive above. This is the whole
 * correction, isolated so it can be tested on its own — it is the term whose sign
 * is a convention rather than an observation.
 */
export function surfaceAboveMsl(waterAboveMllwM: Metres, datum: TidalDatum): Metres {
  return waterAboveMllwM - datum.mslAboveMllwM
}

/**
 * Depth of water at a time, metres, from a depth measured below mean sea level.
 *
 * Returns null when the tide prediction does not cover `t` rather than falling back
 * to the uncorrected depth. A silent fallback is the dangerous option here: it
 * would report the optimistic MSL figure exactly when the correction was
 * unavailable, and nothing in the number would say so.
 */
export function depthAtTime(
  depthBelowMslM: Metres | null,
  levels: WaterLevelPrediction | null,
  datum: TidalDatum,
  t: Millis,
): Metres | null {
  if (depthBelowMslM == null || !Number.isFinite(depthBelowMslM)) return null
  if (!levels) return null
  const above = waterLevelAt(levels, t)
  if (above == null) return null
  return depthBelowMslM + surfaceAboveMsl(above, datum)
}

/**
 * Water under the keel, metres. Negative means aground on this model.
 *
 * Null when the draft is unknown — the app has no default draft and must not
 * invent one, because a clearance figure computed from a guessed draft is
 * indistinguishable from one computed from a measurement.
 */
export function underKeel(depthNowM: Metres | null, draftM: Metres | null | undefined): Metres | null {
  if (depthNowM == null || draftM == null || !Number.isFinite(draftM)) return null
  return depthNowM - draftM
}

/** The pilot venue's datum: NOAA 8418150, Portland ME, 1983–2001 epoch. */
export const PORTLAND_DATUM: TidalDatum = {
  // 13.49 ft MSL − 8.55 ft MLLW = 4.94 ft = 1.5057 m, stated to the centimetre the
  // published figures support. Mirrors PORTLAND_MSL_ABOVE_MLLW_M in bathymetry.ts.
  mslAboveMllwM: 1.51,
  stationId: '8418150',
}

/**
 * How much the tide correction is worth right now, as a sentence.
 *
 * Exists because the correction is invisible in the corrected number: 4.2 m of
 * water looks the same whether or not anyone remembered the datum. Saying which
 * way and by how much is what lets a reader check the result against their own
 * tide table.
 */
export function datumNote(
  levels: WaterLevelPrediction | null,
  datum: TidalDatum,
  t: Millis,
): string | null {
  if (!levels) return null
  const above = waterLevelAt(levels, t)
  if (above == null) return null
  const delta = surfaceAboveMsl(above, datum)
  const sign = delta >= 0 ? 'more' : 'less'
  return (
    `Tide ${above.toFixed(2)} m above MLLW at station ${datum.stationId}: ` +
    `${Math.abs(delta).toFixed(2)} m ${sign} water than the chart layer's mean-sea-level figure.`
  )
}
