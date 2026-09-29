/**
 * The live channel snapshot: every channel's value at one instant, for one boat.
 *
 * This is the one place where boat state, wind, current, tactics and start
 * numbers become Expedition-style channels. Number boxes, the logger, the
 * stripchart and alarms all read from it. None of them should reach into
 * TacticalNumbers directly, or each would carry its own idea of which field is
 * "Mark time".
 *
 * A producer exists exactly for the channels the catalogue marks `today`. The
 * test holds the two lists equal in both directions, so a producer cannot be added
 * without declaring the channel, and a channel cannot claim `today` without
 * producing it.
 */

import type {
  BoatState,
  Course,
  CurrentEstimate,
  Millis,
  StartNumbers,
  TacticalNumbers,
  WindEstimate,
} from '@/lib/types'
import { CHANNELS } from './catalogue'
import type { GateNumbers } from '@/lib/gates'

export interface SnapshotInputs {
  now: Millis
  state: BoatState | null
  wind: WindEstimate | null
  current: CurrentEstimate | null
  tactics: TacticalNumbers | null
  start: StartNumbers | null
  course: Course
  activeMarkIndex: number
  /** Magnetic variation at the boat, degrees, east positive. */
  variationDeg: number | null
  /** The active mark's gate numbers, when the active mark is a gate. */
  gate?: GateNumbers | null
}

/** Channel id → value in the catalogue's unit, or null when there is none. */
export type ChannelValues = Readonly<Record<string, number | null>>

type Producer = (i: SnapshotInputs) => number | null | undefined

const activeMark = (i: SnapshotInputs) => i.course.marks[i.activeMarkIndex]?.position

export const PRODUCERS: Readonly<Record<string, Producer>> = {
  // position
  latitude: (i) => i.state?.position.lat,
  longtitude: (i) => i.state?.position.lon,
  sog: (i) => i.state?.sog,
  cog: (i) => i.state?.cog,
  time: (i) => i.now,
  'gps-estimated-position-error': (i) => i.state?.accuracyM,
  'magnetic-variation': (i) => i.variationDeg,
  // wind: tactics first, so a what-if or held wind is what every box shows
  twd: (i) => i.tactics?.twd ?? i.wind?.twd,
  tws: (i) => i.tactics?.tws ?? i.wind?.tws,
  twa: (i) => i.tactics?.twa,
  'twd-to-lay-mark': (i) => i.tactics?.laylines?.twdToLay,
  // motion
  heading: (i) => i.state?.heading,
  bsp: (i) => i.state?.bsp,
  'heel-roll': (i) => i.state?.heelDeg,
  // current
  'current-set': (i) => i.current?.set,
  'current-drift': (i) => i.current?.drift,
  // marks
  'mark-bearing': (i) => i.tactics?.markBearing,
  'mark-range': (i) => i.tactics?.markRange,
  'mark-time': (i) => i.tactics?.markTimeS,
  'mark-latitude': (i) => activeMark(i)?.lat,
  'mark-longitude': (i) => activeMark(i)?.lon,
  'heading-to-steer': (i) => i.tactics?.headingToSteer,
  'cross-track-error': (i) => i.tactics?.xteNm,
  'distance-to-finish': (i) => i.tactics?.distanceToFinishNm,
  'next-mark-bearing': (i) => i.tactics?.nextMarkBearing,
  'next-mark-range': (i) => i.tactics?.nextMarkRange,
  // laylines
  'layline-distance-on-port': (i) => i.tactics?.laylines?.distanceToPortLayline,
  'layline-distance-on-starboard': (i) => i.tactics?.laylines?.distanceToStarboardLayline,
  'layline-time-on-port': (i) => i.tactics?.laylines?.timeToPortLaylineS,
  'layline-time-on-starboard': (i) => i.tactics?.laylines?.timeToStarboardLaylineS,
  'layline-port-bearing': (i) => i.tactics?.laylines?.portBearing,
  'layline-starboard-bearing': (i) => i.tactics?.laylines?.starboardBearing,
  // performance
  'polar-bsp': (i) => i.tactics?.polarBsp,
  'polar-bsp-pct': (i) => i.tactics?.polarBspPct,
  'target-bsp': (i) => i.tactics?.targetBsp,
  'target-twa': (i) => i.tactics?.targetTwa,
  vmg: (i) => i.tactics?.vmg,
  'vmg-pct': (i) => i.tactics?.vmgPct,
  vmc: (i) => i.tactics?.vmc,
  'vmc-optimum': (i) => i.tactics?.vmcOptimum,
  'vmc-optimum-heading': (i) => i.tactics?.vmcOptimumHeading,
  // gates
  'gate-bearing': (i) => i.gate?.bearing,
  'gate-range': (i) => i.gate?.rangeNm,
  'gate-square-wind': (i) => i.gate?.squareWindDeg,
  'gate-bias-length': (i) => i.gate?.biasLengthM,
  // start
  'start-time-to-gun': (i) => i.start?.timeToGunS,
  'start-time-to-line': (i) => i.start?.timeToLineS,
  'start-time-to-burn': (i) => i.start?.timeToBurnS,
  'start-distance-below-line': (i) => i.start?.distanceBelowLineM,
  'start-gun-dist-below-line': (i) => i.start?.gunDistanceBelowLineM,
  'start-stern-below-line': (i) => i.start?.sternBelowLineM,
  'start-bias-angle': (i) => i.start?.biasAngleDeg,
  'start-bias-length': (i) => i.start?.biasLengthM,
  'start-line-square-wind': (i) => i.start?.lineSquareWindDeg,
  'start-time-to-port': (i) => i.start?.timeToPortEndS,
  'start-time-to-port-simple': (i) => i.start?.timeToPortEndSimpleS,
  'start-time-to-starboard-simple': (i) => i.start?.timeToStarboardEndSimpleS,
  'start-speed-to-port': (i) => i.start?.speedToPortEndKn,
  'start-speed-to-starboard': (i) => i.start?.speedToStarboardEndKn,
  'start-speed-on-port': (i) => i.start?.speedOnPortKn,
  'start-reach-dist-to-line': (i) => i.start?.reachDistanceM,
  'start-distance-to-line-reach': (i) => i.start?.reachDistanceM,
  'start-reach-time-to-line': (i) => i.start?.reachTimeS,
  'start-reach-speed-to-line': (i) => i.start?.reachSpeedKn,
  'start-speed-on-starboard': (i) => i.start?.speedOnStarboardKn,
  'start-target-bsp': (i) => i.start?.targetBsp,
  'start-target-twa': (i) => i.start?.targetTwa,
  'start-time-to-starboard': (i) => i.start?.timeToStarboardEndS,
  'start-port-latitude': (i) => i.course.startLine.port?.lat,
  'start-port-longitude': (i) => i.course.startLine.port?.lon,
  'start-stbd-latitude': (i) => i.course.startLine.starboard?.lat,
  'start-stbd-longitude': (i) => i.course.startLine.starboard?.lon,
}

/**
 * Every catalogued channel, with a value or null. Non-finite numbers become null,
 * so a box shows a dash and never NaN. A producer that throws costs its own
 * channel, not the snapshot.
 */
export function buildSnapshot(i: SnapshotInputs): ChannelValues {
  const out: Record<string, number | null> = {}
  for (const ch of CHANNELS) {
    const produce = PRODUCERS[ch.id]
    let v: number | null | undefined = null
    if (produce) {
      try {
        v = produce(i)
      } catch {
        v = null
      }
    }
    out[ch.id] = typeof v === 'number' && Number.isFinite(v) ? v : null
  }
  return out
}
