/**
 * The phone's own compass and tilt, from DeviceOrientation.
 *
 * Honest about what it is. A phone compass is a magnetometer a metre from an
 * engine, a keel bolt and a VHF, and it lags: it is not an instrument heading,
 * and nothing treats it as one unless the owner says so and the phone itself
 * says its reading is good (only iOS reports an accuracy at all). Heel is a
 * different matter: gravity is easy to measure, so the tilt is used as heel
 * whenever phone sensors are on.
 *
 * The phone is assumed to lie flat, screen up, with its top toward the bow:
 * then tilting the right edge down is heel to starboard, and raising the top
 * edge is bow up. Any other mounting needs the offsets in Calibration.
 */

export type OrientationQuality = 'good' | 'poor' | 'unknown'

export interface PhoneOrientation {
  /** Magnetic heading, or null when the phone has no absolute compass. */
  headingMag: number | null
  heel: number | null
  pitch: number | null
  /** The phone's own estimate, degrees; only iOS gives one. */
  accuracyDeg: number | null
  quality: OrientationQuality
  t: number
}

/** A compass the phone says is within this is taken as good. */
export const GOOD_COMPASS_DEG = 10

export interface OrientationEventLike {
  alpha: number | null
  beta: number | null
  gamma: number | null
  absolute?: boolean
  webkitCompassHeading?: number
  webkitCompassAccuracy?: number
}

const wrap = (a: number) => ((a % 360) + 360) % 360
const finite = (v: number | null | undefined): v is number => v != null && Number.isFinite(v)

/** One event as heading, heel and pitch. `screenAngle` is the screen's rotation. */
export function fromOrientationEvent(e: OrientationEventLike, screenAngle: number, t: number): PhoneOrientation {
  let headingMag: number | null = null
  let accuracyDeg: number | null = null
  let quality: OrientationQuality = 'unknown'
  if (finite(e.webkitCompassHeading)) {
    // iOS: already a compass bearing, clockwise from magnetic north.
    headingMag = wrap(e.webkitCompassHeading + screenAngle)
    if (finite(e.webkitCompassAccuracy) && e.webkitCompassAccuracy >= 0) {
      accuracyDeg = e.webkitCompassAccuracy
      quality = accuracyDeg <= GOOD_COMPASS_DEG ? 'good' : 'poor'
    }
  } else if (e.absolute && finite(e.alpha)) {
    // Android's absolute event: alpha runs anticlockwise from north.
    headingMag = wrap(360 - e.alpha + screenAngle)
  }
  return {
    headingMag,
    heel: finite(e.gamma) ? e.gamma : null,
    pitch: finite(e.beta) ? e.beta : null,
    accuracyDeg,
    quality,
    t,
  }
}

/** How long a reading stays current: the event fires many times a second. */
export const ORIENTATION_FRESH_MS = 2000

/**
 * What a GPS fix may take from the phone: heel whenever it is fresh, heading
 * only when trusted and good. `declination` turns magnetic into true.
 */
export function phoneAdditions(
  p: PhoneOrientation | null,
  now: number,
  trustCompass: boolean,
  declination: number,
): { heading: number | null; heelDeg: number | null } {
  if (!p || now - p.t > ORIENTATION_FRESH_MS) return { heading: null, heelDeg: null }
  const heading = trustCompass && p.quality === 'good' && p.headingMag != null ? wrap(p.headingMag + declination) : null
  return { heading, heelDeg: p.heel }
}

/**
 * iOS asks before sharing orientation, and only in answer to a tap. Elsewhere
 * there is nothing to ask. Resolves to whether the events will come.
 */
export async function requestOrientationPermission(): Promise<boolean> {
  const DOE = (typeof window === 'undefined' ? undefined : window.DeviceOrientationEvent) as
    | (typeof DeviceOrientationEvent & { requestPermission?: () => Promise<'granted' | 'denied'> })
    | undefined
  if (!DOE) return false
  if (typeof DOE.requestPermission !== 'function') return true
  try {
    return (await DOE.requestPermission()) === 'granted'
  } catch {
    return false
  }
}
