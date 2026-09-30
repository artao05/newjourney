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
import type { ModelId } from '@/lib/weather/openmeteo'

/**
 * Which weather the router sails on: the download and every ticked GRIB file
 * merged (finest grid first), the download alone, or the ticked files alone.
 * Tick one file to route on that file only.
 */
export type RouteWeatherSource = 'merged' | 'download' | 'files'

export interface RouteSettings {
  /** The model downloaded for routing. */
  model: ModelId
  source: RouteWeatherSource
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
  /** Will not sail closer than 90° to the wind above this. Null = no limit. */
  maxTwsUpwind: Knots | null
  /** Will not sail 90° or more off the wind above this. Null = no limit. */
  maxTwsDownwind: Knots | null
  /** Motor at this speed wherever sailing would be slower than `motorBelowKn`. Null = never. */
  motorSpeedKn: Knots | null
  motorBelowKn: Knots | null
  /** Display only: shade water within this many minutes of the optimal route. */
  bandMin: number
  /** Display only: draw an isochrone every this many minutes; 0 draws every step. */
  isoEveryMin: number
  /** Draw every path the search kept, not only the best. */
  showExplored: boolean
  /**
   * Blend the wind now (instruments or manual) into the forecast, fading back
   * to it over this many minutes. 0 is off.
   */
  nowDecayMin: number
  /** Speed in waves as a percentage of the polar, by height and angle to the boat; null for none. */
  waveTable: { heights: number[]; angles: number[]; pct: number[][] } | null
  /** % off the polar in swell, and in wind sea, in full at `waveRefHeightM` and above. */
  swellPct: number
  windWavePct: number
  waveRefHeightM: Metres
  /** % more off where swell and wind sea cross within `crossedMarginDeg` of 90°. */
  crossedSeaPct: number
  crossedMinM: Metres
  crossedTotalM: Metres
  crossedMarginDeg: number
  /** Scale the wind the polar reads for the air's density. */
  airDensity: boolean
  /** Route with NOAA's harmonic tidal streams over the forecast current, within `tidalRadiusNm` of a station. */
  tidalStreams: boolean
  tidalRadiusNm: number
  /** Which router: the isochrones, or the grid for a second opinion. */
  algorithm: 'isochrone' | 'grid'
  /** For the grid: along the great circle rather than the rhumb line. */
  greatCircle: boolean
  /** Route only to the active mark, not the whole course: quicker, for the leg in hand. */
  firstLegOnly: boolean
}

export const DEFAULT_ROUTE_SETTINGS: RouteSettings = {
  model: 'best_match',
  source: 'merged',
  resolution: 'balanced',
  windScalePct: 100,
  windRotateDeg: 0,
  windTimeShiftMin: 0,
  currentScalePct: 100,
  maxTws: null,
  minTws: null,
  maxGust: null,
  maxWaveHeightM: null,
  maxTwsUpwind: null,
  maxTwsDownwind: null,
  motorSpeedKn: null,
  motorBelowKn: null,
  bandMin: 10,
  isoEveryMin: 0,
  showExplored: false,
  nowDecayMin: 0,
  waveTable: null,
  swellPct: 0,
  // Off by default: a polar measured at sea already has the wind sea in it.
  windWavePct: 0,
  waveRefHeightM: 2,
  crossedSeaPct: 0,
  crossedMinM: 0.5,
  crossedTotalM: 1.5,
  crossedMarginDeg: 30,
  airDensity: false,
  tidalStreams: false,
  tidalRadiusNm: 5,
  algorithm: 'isochrone',
  greatCircle: false,
  firstLegOnly: false,
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
  boat: Pick<Boat, 'polarPct' | 'polarPctNight' | 'tackPenaltyS' | 'gybePenaltyS' | 'windWeight'>,
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
  if (settings.maxTwsUpwind != null) constraints.maxTwsUpwind = settings.maxTwsUpwind
  if (settings.maxTwsDownwind != null) constraints.maxTwsDownwind = settings.maxTwsDownwind
  if (settings.motorSpeedKn != null && settings.motorBelowKn != null) {
    constraints.motorSpeedKn = settings.motorSpeedKn
    constraints.motorBelowKn = settings.motorBelowKn
  }
  return {
    constraints,
    scalings: {
      // The wind weight scales the polar as the polar % does.
      polarPct: boat.polarPct * (boat.windWeight ?? 1),
      polarPctNight: boat.polarPctNight * (boat.windWeight ?? 1),
      windScalePct: settings.windScalePct * heightFactor,
      windRotateDeg: settings.windRotateDeg,
      windTimeShiftS: settings.windTimeShiftMin * 60,
      currentScalePct: settings.currentScalePct,
      ...(settings.waveTable ? { waveTable: settings.waveTable } : {}),
      ...((settings.swellPct ?? 0) > 0 || (settings.windWavePct ?? 0) > 0 || (settings.crossedSeaPct ?? 0) > 0
        ? {
            seaPenalty: {
              swellPct: settings.swellPct ?? 0,
              windWavePct: settings.windWavePct ?? 0,
              refHeightM: settings.waveRefHeightM ?? 2,
              crossedPct: settings.crossedSeaPct ?? 0,
              crossedMinM: settings.crossedMinM ?? 0.5,
              crossedTotalM: settings.crossedTotalM ?? 1.5,
              crossedMarginDeg: settings.crossedMarginDeg ?? 30,
            },
          }
        : {}),
      ...(settings.airDensity ? { airDensity: true } : {}),
    },
    resolution: settings.resolution,
  }
}

/**
 * Race-note areas as the kernel wants them: keep-out polygons, and slow polygons
 * with their percentage. Points, lines and plain areas change nothing.
 */
export function zonesFromNotes(
  notes: ReadonlyArray<{ kind: string; points: Array<{ lat: number; lon: number }>; avoid: boolean; speedPct: number | null }>,
): Pick<RouteConstraints, 'avoidAreas' | 'slowAreas'> {
  const ring = (pts: Array<{ lat: number; lon: number }>) => [pts.map((p) => [p.lon, p.lat])]
  const areas = notes.filter((n) => n.kind === 'area' && n.points.length >= 3)
  const avoidAreas = areas.filter((n) => n.avoid).map((n) => ring(n.points))
  const slowAreas = areas
    .filter((n) => !n.avoid && n.speedPct != null && n.speedPct > 0)
    .map((n) => ({ polygon: ring(n.points), pct: n.speedPct as number }))
  return {
    ...(avoidAreas.length ? { avoidAreas } : {}),
    ...(slowAreas.length ? { slowAreas } : {}),
  }
}

/** Settings that differ from the defaults, as short labels for the Route chip row. */
export function nonDefaultLabels(s: RouteSettings): string[] {
  const out: string[] = []
  const signed = (n: number) => (n > 0 ? `+${n}` : `${n}`)
  if (s.model && s.model !== 'best_match') out.push(s.model)
  if (s.source === 'download') out.push('download only')
  if (s.source === 'files') out.push('GRIB files only')
  if (s.resolution !== 'balanced') out.push(s.resolution)
  if (s.windScalePct !== 100) out.push(`wind ${s.windScalePct}%`)
  if (s.windRotateDeg !== 0) out.push(`wind ${signed(s.windRotateDeg)}°`)
  if (s.windTimeShiftMin !== 0) out.push(`wind ${signed(s.windTimeShiftMin)} min`)
  if (s.currentScalePct !== 100) out.push(`current ${s.currentScalePct}%`)
  if (s.maxTws != null) out.push(`TWS ≤ ${s.maxTws} kn`)
  if (s.minTws != null) out.push(`TWS ≥ ${s.minTws} kn`)
  if (s.maxGust != null) out.push(`gust ≤ ${s.maxGust} kn`)
  if (s.maxWaveHeightM != null) out.push(`waves ≤ ${s.maxWaveHeightM} m`)
  if (s.maxTwsUpwind != null) out.push(`beat ≤ ${s.maxTwsUpwind} kn`)
  if (s.maxTwsDownwind != null) out.push(`run ≤ ${s.maxTwsDownwind} kn`)
  if (s.motorSpeedKn != null && s.motorBelowKn != null) out.push(`motor ${s.motorSpeedKn} kn below ${s.motorBelowKn} kn`)
  if (s.nowDecayMin > 0) out.push(`wind now over ${s.nowDecayMin} min`)
  if (s.waveTable) out.push('wave table')
  if ((s.swellPct ?? 0) > 0) out.push(`swell −${s.swellPct}%`)
  if ((s.windWavePct ?? 0) > 0) out.push(`wind sea −${s.windWavePct}%`)
  if ((s.crossedSeaPct ?? 0) > 0) out.push(`crossed sea −${s.crossedSeaPct}%`)
  if (s.airDensity) out.push('air density')
  if (s.tidalStreams) out.push(`tidal streams within ${s.tidalRadiusNm ?? 5} nm`)
  if (s.algorithm === 'grid') out.push(s.greatCircle ? 'grid, great circle' : 'grid')
  if (s.firstLegOnly) out.push('first leg only')
  return out
}
