/**
 * The sailor's routing settings, and how they become a RouteRequest.
 *
 * The kernel has supported every one of these for a long time: resolution, wind
 * scale, rotation and time shift, current scale, and the TWS, gust and wave
 * limits. The Route screen used to hard-code them all. These are Expedition's
 * optimal-routing options, and the ones that matter most in practice are the
 * corrections a navigator applies once the forecast is visibly early, late,
 * backed or light.
 *
 * Kept apart from the screen so the mapping is one tested function. The route
 * and the departure sweep then cannot disagree about which boat they are for.
 */

import type {
  Boat,
  Knots,
  Metres,
  PolarTable,
  RouteConstraints,
  RouteResolution,
  RouteScalings,
} from '@/lib/types'
import { heightScaleFactor } from '@/lib/polar'

export interface RouteSettings {
  resolution: RouteResolution
  /** Multiply forecast wind speed, before any height correction. 100 = as forecast. */
  windScalePct: number
  /** Veer (+) or back (−) the forecast wind, in degrees. */
  windRotateDeg: number
  /**
   * Shift the forecast in time, in minutes. +60 means the weather is running an
   * hour late, so the 17z field is used at 18z.
   */
  windTimeShiftMin: number
  /** Multiply forecast current. 100 = as forecast. */
  currentScalePct: number
  /** Cells above this true wind speed are impassable. Null = no limit. */
  maxTws: Knots | null
  /** Cells below this true wind speed are impassable. Null = no limit. */
  minTws: Knots | null
  /** Cells with gusts above this are impassable. Null = no limit. */
  maxGust: Knots | null
  /** Cells with significant wave height above this are impassable. Null = no limit. */
  maxWaveHeightM: Metres | null
}

export const DEFAULT_ROUTE_SETTINGS: RouteSettings = {
  resolution: 'balanced',
  windScalePct: 100,
  windRotateDeg: 0,
  windTimeShiftMin: 0,
  currentScalePct: 100,
  maxTws: null,
  minTws: null,
  maxGust: null,
  maxWaveHeightM: null,
}

/**
 * How much to scale the forecast's 10 m wind so the polar reads it at the height it
 * was built for.
 *
 * Forecast models give wind at 10 m. A designer polar is usually indexed by 10 m wind
 * too, and then the two already agree and the factor is 1. A polar tuned against the
 * boat's own instruments is indexed by masthead wind, which blows harder: about 9 %
 * on a 20 m rig. That polar needs the forecast lifted to masthead height first, or
 * every routed speed comes from a lighter breeze than the one the polar describes.
 * This is Expedition's "Scale winds" percentage, worked out from the mast height
 * instead of being typed in.
 */
export function windHeightFactor(
  reference: PolarTable['reference'] | undefined,
  mastHeightM: number,
): number {
  return reference === 'masthead' ? heightScaleFactor(mastHeightM) : 1
}

/**
 * The settings as the kernel wants them. Only limits that were set are passed on.
 * `heightFactor` comes from `windHeightFactor` and multiplies the sailor's own wind
 * scale.
 */
export function requestParts(
  settings: RouteSettings,
  boat: Pick<Boat, 'polarPct' | 'polarPctNight' | 'tackPenaltyS' | 'gybePenaltyS'>,
  avoidLand: boolean,
  heightFactor = 1,
): { constraints: RouteConstraints; scalings: RouteScalings; resolution: RouteResolution } {
  const constraints: RouteConstraints = {
    avoidLand,
    tackPenaltyS: boat.tackPenaltyS,
    gybePenaltyS: boat.gybePenaltyS,
  }
  if (settings.maxTws != null) constraints.maxTws = settings.maxTws
  if (settings.minTws != null) constraints.minTws = settings.minTws
  if (settings.maxGust != null) constraints.maxGust = settings.maxGust
  if (settings.maxWaveHeightM != null) constraints.maxWaveHeightM = settings.maxWaveHeightM
  return {
    constraints,
    scalings: {
      polarPct: boat.polarPct,
      polarPctNight: boat.polarPctNight,
      windScalePct: settings.windScalePct * heightFactor,
      windRotateDeg: settings.windRotateDeg,
      windTimeShiftS: settings.windTimeShiftMin * 60,
      currentScalePct: settings.currentScalePct,
    },
    resolution: settings.resolution,
  }
}

/** Settings that differ from the defaults, as short labels for the Route chip row. */
export function nonDefaultLabels(s: RouteSettings): string[] {
  const out: string[] = []
  const signed = (n: number) => (n > 0 ? `+${n}` : `${n}`)
  if (s.resolution !== 'balanced') out.push(s.resolution)
  if (s.windScalePct !== 100) out.push(`wind ${s.windScalePct}%`)
  if (s.windRotateDeg !== 0) out.push(`wind ${signed(s.windRotateDeg)}°`)
  if (s.windTimeShiftMin !== 0) out.push(`wind ${signed(s.windTimeShiftMin)} min`)
  if (s.currentScalePct !== 100) out.push(`current ${s.currentScalePct}%`)
  if (s.maxTws != null) out.push(`TWS ≤ ${s.maxTws} kn`)
  if (s.minTws != null) out.push(`TWS ≥ ${s.minTws} kn`)
  if (s.maxGust != null) out.push(`gust ≤ ${s.maxGust} kn`)
  if (s.maxWaveHeightM != null) out.push(`waves ≤ ${s.maxWaveHeightM} m`)
  return out
}
