/**
 * Depth along a finished route, corrected for the tide at the time you get there.
 *
 * Tier 1 B in docs/05-spec/improvement-plan.md, and the reason it is worth doing
 * *here* rather than on the map: a route carries a time at every leg, so each
 * sample can be corrected with the tide height for the moment the boat is actually
 * at that position. A chart layer can only ever show one tide state at a time. A
 * route can show the one that will be true when it matters.
 *
 * ## This is an advisory. It is not a router constraint, and that is deliberate.
 *
 * `charts-and-bathymetry.md` §5 floats GEBCO as "a coarse grounding check in the
 * router", and the temptation once the asset exists is to wire it to `maxDraft`.
 * The improvement plan recommends against, and this module is built to that
 * recommendation:
 *
 *   - GEBCO reads **18 m shallow** at NDBC 44007, at a position known to a metre.
 *   - Its cells are **450 m across**, so the ledge that actually stops the boat is
 *     not in the data at all.
 *
 * A hard constraint fed by that would refuse good routes, and — far worse — imply
 * it had cleared the ones it allowed. An advisory says "look at this bit on a real
 * chart", which is the only claim the data supports. Nothing in this file returns a
 * value the router consumes.
 *
 * The correction is exact arithmetic on an inexact depth: it makes the number less
 * wrong in a known direction, and does not make it right.
 */

import type { Metres, Millis, RouteResult } from '../types'
import { depthAtTime, underKeel, type TidalDatum } from '../tides/datum'
import type { WaterLevelPrediction } from '../tides/coops'

/** Reads a depth below mean sea level at a position, or null off-grid and on land. */
export type DepthSampler = (lat: number, lon: number) => Metres | null

export interface DepthSample {
  /** Index into `route.legs`. */
  legIndex: number
  t: Millis
  lat: number
  lon: number
  /** Modelled depth below mean sea level, metres. */
  depthMslM: Metres
  /** Depth at `t` once the tide is applied, or null with no tide cover. */
  depthNowM: Metres | null
  /** Water under the keel at `t`, or null with no draft or no tide cover. */
  underKeelM: Metres | null
}

export interface DepthAdvisory {
  /** Every leg that produced a depth, in route order. */
  samples: DepthSample[]
  /**
   * The shallowest sample, judged on tide-corrected depth where available and on
   * the modelled depth otherwise. Null when nothing on the route had a depth.
   */
  shallowest: DepthSample | null
  /** Legs at or below `alarmM` of clearance, worst first. Empty is the good case. */
  concerns: DepthSample[]
  /** Legs the depth grid had no value for — off its box, or called land. */
  legsWithoutDepth: number
  /** Legs a depth existed for but the tide prediction did not cover. */
  legsWithoutTide: number
  /** Sentences for the route's own warnings list. */
  warnings: string[]
}

export interface DepthAdvisoryOptions {
  route: RouteResult
  depthAt: DepthSampler
  /** Tide curve for the venue station. Null runs the check uncorrected. */
  levels: WaterLevelPrediction | null
  datum: TidalDatum
  /** Deepest point of the boat, metres. Null when the user has not said. */
  draftM?: Metres | null
  /**
   * Clearance at or below which a leg becomes a concern, metres.
   *
   * Two metres by default, and the number is doing real work: GEBCO's measured
   * error at the one point we can check it is 18 m, so a tight threshold would
   * either cry wolf constantly or — depending on which way the grid is wrong —
   * stay silent over a ledge. Two metres of *clearance* is roughly "you would want
   * to have looked at a chart here", which is the only thing this can honestly say.
   */
  alarmM?: number
  /**
   * Sample at most this many legs, evenly spaced. A long passage has thousands of
   * legs and the grid has one value per 450 m, so sampling every leg mostly
   * re-reads the same cell.
   */
  maxSamples?: number
}

const DEFAULT_ALARM_M = 2
const DEFAULT_MAX_SAMPLES = 400

/** Depth used for ranking: tide-corrected when we have it, modelled when we do not. */
function rankDepth(s: DepthSample): number {
  return s.depthNowM ?? s.depthMslM
}

/**
 * Walk a route and report the water under it.
 *
 * Pure: takes a sampler and a tide curve rather than fetching either, so it runs
 * in a test against an analytic seabed.
 */
export function depthAdvisory(o: DepthAdvisoryOptions): DepthAdvisory {
  const alarmM = o.alarmM ?? DEFAULT_ALARM_M
  const maxSamples = Math.max(1, Math.floor(o.maxSamples ?? DEFAULT_MAX_SAMPLES))
  const legs = o.route.legs
  const samples: DepthSample[] = []
  const warnings: string[] = []
  let legsWithoutDepth = 0
  let legsWithoutTide = 0

  if (!o.route.ok || legs.length === 0) {
    return {
      samples: [],
      shallowest: null,
      concerns: [],
      legsWithoutDepth: 0,
      legsWithoutTide: 0,
      warnings: [],
    }
  }

  const stride = Math.max(1, Math.ceil(legs.length / maxSamples))
  for (let i = 0; i < legs.length; i += stride) {
    const leg = legs[i]
    const depthMslM = o.depthAt(leg.position.lat, leg.position.lon)
    if (depthMslM == null || !Number.isFinite(depthMslM)) {
      legsWithoutDepth++
      continue
    }
    const depthNowM = depthAtTime(depthMslM, o.levels, o.datum, leg.t)
    if (depthNowM == null) legsWithoutTide++
    samples.push({
      legIndex: i,
      t: leg.t,
      lat: leg.position.lat,
      lon: leg.position.lon,
      depthMslM,
      depthNowM,
      underKeelM: underKeel(depthNowM, o.draftM),
    })
  }
  /*
   * The last leg is the destination, and it is the one most likely to be in
   * shallow water — a mark is usually closer to shore than the water either side
   * of it. `stride` will normally skip it, so it is sampled explicitly.
   */
  const lastIndex = legs.length - 1
  if (samples.length > 0 && samples[samples.length - 1].legIndex !== lastIndex) {
    const leg = legs[lastIndex]
    const depthMslM = o.depthAt(leg.position.lat, leg.position.lon)
    if (depthMslM != null && Number.isFinite(depthMslM)) {
      const depthNowM = depthAtTime(depthMslM, o.levels, o.datum, leg.t)
      if (depthNowM == null) legsWithoutTide++
      samples.push({
        legIndex: lastIndex,
        t: leg.t,
        lat: leg.position.lat,
        lon: leg.position.lon,
        depthMslM,
        depthNowM,
        underKeelM: underKeel(depthNowM, o.draftM),
      })
    } else {
      legsWithoutDepth++
    }
  }

  if (samples.length === 0) {
    return {
      samples,
      shallowest: null,
      concerns: [],
      legsWithoutDepth,
      legsWithoutTide,
      warnings: [
        'No depth data along this route — it lies outside the venue bathymetry grid. No grounding check was made.',
      ],
    }
  }

  let shallowest = samples[0]
  for (const s of samples) if (rankDepth(s) < rankDepth(shallowest)) shallowest = s

  /*
   * Concerns are judged on clearance when a draft exists and on depth when it does
   * not, because with no draft there is no clearance to threshold. Without a draft
   * the same alarm figure is read as an absolute depth, which is a weaker but still
   * honest check: shallow water is worth a look whatever you draw.
   */
  const concerns = samples
    .filter((s) => {
      const clearance = s.underKeelM
      return clearance != null ? clearance <= alarmM : rankDepth(s) <= alarmM
    })
    .sort((a, b) => (a.underKeelM ?? rankDepth(a)) - (b.underKeelM ?? rankDepth(b)))

  // ---------------------------------------------------------------- warnings
  const shallowDepth = rankDepth(shallowest)
  const tideWord = shallowest.depthNowM != null ? 'allowing for tide' : 'at mean sea level'
  if (concerns.length > 0) {
    const worst = concerns[0]
    const where = `leg ${worst.legIndex + 1} of ${legs.length}`
    warnings.push(
      worst.underKeelM != null
        ? `Shallow water on this route: ${worst.underKeelM.toFixed(1)} m under the keel at ${where}, ` +
          `${new Date(worst.t).toISOString().slice(11, 16)}Z. Modelled, ${tideWord} — check a chart before sailing it.`
        : `Shallow water on this route: ${shallowDepth.toFixed(1)} m at ${where}, ` +
          `${new Date(worst.t).toISOString().slice(11, 16)}Z, ${tideWord}. No draft set, so this is depth, not clearance.`,
    )
    if (concerns.length > 1) {
      warnings.push(`${concerns.length} legs on this route are in modelled water that shallow.`)
    }
  }

  if (o.draftM == null) {
    warnings.push(
      'No draft set — enter your draft in Setup to see water under the keel rather than water depth.',
    )
  }
  if (!o.levels) {
    warnings.push(
      'Depths are referenced to mean sea level with no tide correction, so they read about ' +
        `${o.datum.mslAboveMllwM.toFixed(2)} m optimistic at low water.`,
    )
  } else if (legsWithoutTide > 0) {
    warnings.push(
      `${legsWithoutTide} of ${samples.length} depth samples fall outside the tide prediction and are uncorrected.`,
    )
  }
  if (legsWithoutDepth > 0) {
    warnings.push(
      `${legsWithoutDepth} sampled legs have no depth data — outside the venue grid, or on a cell the grid calls land.`,
    )
  }

  return { samples, shallowest, concerns, legsWithoutDepth, legsWithoutTide, warnings }
}
