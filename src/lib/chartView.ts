/**
 * How the chart moves and turns with the boat.
 *
 * Orientation says what is up: true north, the course (the active leg, so a
 * windward-leeward course sits straight up the screen), or the boat's head.
 * Motion says what the chart keeps in view: nothing (free), the boat in the
 * middle (follow), the boat and where she will be in a few minutes on her
 * COG and SOG (look ahead), or the boat and the mark she is sailing to.
 *
 * Head-up turns only past a dead band, and the framing modes zoom only when
 * what they frame leaves the view or the zoom is well off, so a wandering
 * heading or a gust does not keep the chart moving.
 */
import { angdiff, wrap360 } from './angles'
import { bearing, destination } from './geo'
import type { BoatState, LatLon } from './types'

export type ChartOrientation = 'north' | 'course' | 'head'
export type ChartMotion = 'free' | 'follow' | 'ahead' | 'mark'

export const ORIENTATIONS: ChartOrientation[] = ['north', 'course', 'head']
export const MOTIONS: ChartMotion[] = ['free', 'follow', 'ahead', 'mark']

export const ORIENTATION_LABEL: Record<ChartOrientation, string> = { north: 'North up', course: 'Course up', head: 'Head up' }
export const MOTION_LABEL: Record<ChartMotion, string> = { free: 'Free', follow: 'Follow', ahead: 'Look ahead', mark: 'Boat + mark' }

/** Below this the COG means little. */
const MIN_SOG = 0.5

/**
 * The bearing to put up, degrees true, or null to leave the chart as it is
 * (head-up with no heading and no way on, say).
 *
 * @param leg the active leg: from the last mark (or the boat) to the active mark
 */
export function upBearing(o: ChartOrientation, s: Pick<BoatState, 'heading' | 'cog' | 'sog' | 'position'> | null, leg: { from: LatLon | null; to: LatLon } | null): number | null {
  if (o === 'north') return 0
  const cog = s && s.sog >= MIN_SOG ? s.cog : null
  if (o === 'head') return s?.heading ?? cog
  if (leg) {
    const from = leg.from ?? s?.position
    if (from) return bearing(from, leg.to)
  }
  return cog
}

/** Head-up's dead band: the chart turns only when the heading has moved this far. */
export const HEAD_DEADBAND_DEG = 5

export function steadyBearing(current: number, target: number, deadbandDeg = HEAD_DEADBAND_DEG): number {
  return Math.abs(angdiff(target, current)) < deadbandDeg ? current : wrap360(target)
}

/** Look ahead frames this many minutes of the boat's COG and SOG. */
export const AHEAD_MIN = 10

export type MotionTarget = { center: LatLon } | { frame: LatLon[] }

/** What the chart keeps in view, or null when it is left alone. */
export function motionTarget(m: ChartMotion, s: Pick<BoatState, 'position' | 'cog' | 'sog'> | null, mark: LatLon | null, aheadMin = AHEAD_MIN): MotionTarget | null {
  if (m === 'free' || !s) return null
  if (m === 'follow') return { center: s.position }
  if (m === 'ahead') {
    // A mile at least, so a slow boat still sees something ahead.
    const nm = Math.max(1, (Math.max(s.sog, 0) * aheadMin) / 60)
    return { frame: [s.position, destination(s.position, s.cog, nm)] }
  }
  return mark ? { frame: [s.position, mark] } : { center: s.position }
}

/**
 * Whether a framing mode should move the chart: a framed point has left the
 * view (inset by `insetPx`), or the zoom that fits it is `zoomSlack` or more
 * off the zoom shown.
 */
export function shouldReframe(pointsPx: Array<{ x: number; y: number }>, widthPx: number, heightPx: number, currentZoom: number, fitZoom: number, insetPx = 24, zoomSlack = 0.75): boolean {
  if (!(widthPx > 0) || !(heightPx > 0)) return true
  if (Math.abs(fitZoom - currentZoom) >= zoomSlack) return true
  return pointsPx.some((p) => p.x < insetPx || p.y < insetPx || p.x > widthPx - insetPx || p.y > heightPx - insetPx)
}
