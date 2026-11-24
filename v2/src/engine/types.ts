import type { LatLon } from '@/lib/types'

export type { LatLon }

export type MarkRole = 'mark' | 'pin' | 'committee'

export interface Mark {
  id: string
  name: string
  lat: number
  lon: number
  role: MarkRole
  /**
   * Set only on the stand-in for a gate in a course sequence (see
   * `courseMarks`): the stand-in sits at the gate's middle, and these are its
   * two real marks.
   */
  gate?: { gateId: string; a: Mark; b: Mark; open: boolean }
}

/**
 * A gate: two marks a boat rounds either one of.
 *  - open: you sail between the two marks, then round either;
 *  - closed: you may not sail between them, so you go round the outside of one.
 */
export interface Gate {
  id: string
  name: string
  aId: string
  bId: string
  open: boolean
}

/**
 * A race: a start line between a pin and a committee boat, then marks (or
 * gates) rounded in order. The last entry in `sequence` is the finish.
 * `sequence` holds mark ids and gate ids.
 */
export interface Course {
  pinId: string | null
  committeeId: string | null
  sequence: string[]
  gates?: Gate[]
  /** Which standard layout this course was laid from, if any. */
  layout?: string
}

export type Phase = 'free' | 'prestart' | 'racing' | 'finished'

export type LegKind = 'beat' | 'reach' | 'run'

/**
 * How a simulated crew sails. The fleet sails cleanly; the learner profile
 * (own boat in simulation) makes the mistakes the coach is meant to catch.
 */
export interface Skill {
  label: string
  /** Extra TWA upwind, degrees: positive sails lower than target ("footing"). */
  upwindTwaErr: number
  /** Extra TWA downwind, degrees: negative sails higher than target. */
  downwindTwaErr: number
  /** Fraction of polar speed the trim achieves. */
  speedFactor: number
  /** Tack on a header bigger than this, degrees. */
  headerTackDeg: number
  /** Never tack again sooner than this, seconds. */
  minTackIntervalS: number
  /** Multiplies the boat's speed loss in a tack (1 = clean). */
  tackLossMult: number
  /** Multiplies the time a tack takes. */
  tackTimeMult: number
  /** Degrees past the layline before tacking for the mark. */
  overstandDeg: number
  /** Seconds late (positive) the crew pulls the trigger on the start. */
  startDelayS: number
  /** Where along the line (0 pin .. 1 committee) the crew wants to start. */
  lineSpot: number
  /** Scripted lapses, each active for a window of race time. */
  lapses: Lapse[]
}

export type LapseKind = 'foot' | 'pinch' | 'overtack' | 'ignoreHeader' | 'overstand' | 'slowTacks'

export interface Lapse {
  kind: LapseKind
  /** Index into the course sequence: the leg sailed towards that mark. */
  leg: number
  /** Seconds after the start of that leg. */
  fromS: number
  toS: number
}

/** One second of the own boat's instruments, as the coach sees it. */
export interface Sample {
  t: number
  lat: number
  lon: number
  hdg: number
  bsp: number
  twd: number
  tws: number
  twa: number
  targetBsp: number
  targetTwa: number
  polarBsp: number
  phase: Phase
  leg: number
  legKind: LegKind | null
  inManoeuvre: boolean
  /** Signed distance to the start line, nm (pre-start side positive), when there is a line. */
  lineNm: number | null
  /** Upwind or downwind VMG, knots (positive towards the leg's direction). */
  vmg: number
}

export interface BoatTrackPoint {
  t: number
  lat: number
  lon: number
}

export interface SimBoat {
  id: string
  name: string
  mmsi: number
  color: string
  own: boolean
  boatId: string
  skill: Skill
  pos: LatLon
  hdg: number
  bsp: number
  twd: number
  tws: number
  twa: number
  aws: number
  awa: number
  targetBsp: number
  targetTwa: number
  /** Polar speed at the current TWA, knots. */
  polarBsp: number
  phase: Phase
  leg: number
  manoeuvre: { kind: 'tack' | 'gybe'; toHdg: number; leftS: number; totalS: number; startBsp: number } | null
  lastTackT: number
  meanTwd: number
  helm: 'auto' | 'manual'
  /** What the skipper is doing, in words, for the UI and the coach. */
  intent: string
  crossedLineT: number | null
  finishedT: number | null
  ocs: boolean
  tacks: number
  gybes: number
  track: BoatTrackPoint[]
  /** Distance sailed, nm. */
  sailedNm: number
  legStartT: number
  legKind: LegKind | null
  committed: boolean
  /** Speed multiplier the skipper is asking for (luffing < 1). */
  throttle: number
  /** The gate mark this boat has chosen for its current leg, if the leg ends at a gate. */
  gatePick: string | null
  /** Set when the boat sails between the marks of the open gate it is heading for. */
  gateCrossed: boolean
  /** Where the own boat is on the route it is following: course leg and stretch. */
  routeAt: { leg: number; seg: number; lost: boolean } | null
}

export interface RaceEvent {
  t: number
  boatId: string
  kind: 'tack' | 'gybe' | 'rounding' | 'start' | 'finish' | 'ocs' | 'lapse' | 'foul'
  detail: string
  lat: number
  lon: number
}
