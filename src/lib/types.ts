/**
 * Shared domain types. Every module codes against this file.
 *
 * Unit discipline (see docs/03-algorithms/navigation-math.md §1):
 *   - angles      degrees, 0..360 for bearings, signed -180..180 for TWA/AWA
 *   - speed       knots
 *   - distance    nautical miles (metres only where explicitly named `*Metres`)
 *   - time        epoch milliseconds (UTC) or Date; never local
 *   - lat/lon     WGS-84 decimal degrees, +N / +E
 */

// ---------------------------------------------------------------- primitives

export type Degrees = number
/** Signed, -180..180. Positive = starboard tack. */
export type SignedDegrees = number
export type Knots = number
export type NauticalMiles = number
export type Metres = number
export type Seconds = number
/** Epoch milliseconds, UTC. */
export type Millis = number

export interface LatLon {
  lat: number
  lon: number
}

/** Local tangent-plane coordinates in nautical miles, x = east, y = north. */
export interface XY {
  x: NauticalMiles
  y: NauticalMiles
}

export interface BBox {
  west: number
  south: number
  east: number
  north: number
}

/** Wind or current as components. u = eastward, v = northward, knots. */
export interface UV {
  u: Knots
  v: Knots
}

// --------------------------------------------------------------------- boat

export interface Boat {
  id: string
  name: string
  className: string
  /** Length overall, metres — used for boat-length displays and wave scaling. */
  loaMetres: Metres
  /** Distance bow to GPS antenna, metres. */
  bowToGpsMetres: Metres
  /** Masthead / instrument height, metres. Drives the 10m -> masthead wind scaling. */
  mastHeightMetres: Metres
  /** Global polar scaling, percent. 100 = sail the book. */
  polarPct: number
  /** Polar scaling between civil dusk and dawn, percent. */
  polarPctNight: number
  /** Seconds lost per tack. */
  tackPenaltyS: Seconds
  /** Seconds lost per gybe. */
  gybePenaltyS: Seconds
}

// -------------------------------------------------------------------- polar

/**
 * A ragged polar table, Expedition-format compatible.
 * `tws[i]` is the wind speed of row i; `rows[i]` holds that row's breakpoints.
 */
export interface PolarTable {
  name: string
  tws: Knots[]
  rows: Array<{ twa: Degrees[]; bsp: Knots[] }>
  /** Wind reference height of the source data. */
  reference: '10m' | 'masthead'
  source?: string
}

/** Derived upwind/downwind targets at one wind speed. */
export interface Targets {
  tws: Knots
  upTwa: Degrees
  upBsp: Knots
  upVmg: Knots
  downTwa: Degrees
  downBsp: Knots
  downVmg: Knots
}

/**
 * Polar precomputed onto a regular lattice for O(1) lookup in the routing
 * inner loop. See docs/03-algorithms/polars-and-vpp.md §1.
 */
export interface PolarLattice {
  table: PolarTable
  twsMax: Knots
  twsStep: Knots
  twaStep: Degrees
  /** Float32Array[twsCount * twaCount], row-major (tws outer, twa inner). */
  grid: Float32Array
  twsCount: number
  twaCount: number
  /** Targets sampled at every lattice wind speed. */
  targets: Targets[]
  speed(tws: Knots, twa: SignedDegrees): Knots
  targetsAt(tws: Knots): Targets
}

// ------------------------------------------------------------------ weather

export interface WaveState {
  heightM: Metres
  directionDeg: Degrees
  periodS: Seconds
}

export interface WindSample extends UV {
  source: string
}

/**
 * A time-varying weather field over a bounding box.
 * Returns null outside coverage — never a silent zero.
 * See docs/05-spec/technical-spec.md §4.
 */
export interface WeatherField {
  wind(lat: number, lon: number, t: Millis): WindSample | null
  gust(lat: number, lon: number, t: Millis): Knots | null
  current(lat: number, lon: number, t: Millis): WindSample | null
  waves(lat: number, lon: number, t: Millis): WaveState | null
  coverage(): { bbox: BBox; t0: Millis; t1: Millis }
}

/** Compact transferable weather cube — the wire + worker format. */
export interface WeatherCube {
  model: string
  run: string
  bbox: BBox
  nx: number
  ny: number
  dx: number
  dy: number
  t0: Millis
  dtMs: number
  nt: number
  params: string[]
  /** param -> Float32Array(nt * ny * nx) */
  data: Record<string, Float32Array>
}

// ------------------------------------------------------------ course & race

export type RoundingSide = 'port' | 'starboard' | 'either'

export interface Mark {
  id: string
  name: string
  position: LatLon
  roundTo: RoundingSide
}

export interface StartLine {
  /** Committee boat end. */
  starboard: LatLon | null
  /** Pin end. */
  port: LatLon | null
  /** Scheduled gun, epoch ms. */
  gunTime: Millis | null
}

export interface Course {
  id: string
  name: string
  marks: Mark[]
  startLine: StartLine
  /** Course axis, degrees magnetic, if set by the race committee. */
  axisDeg?: Degrees
}

// ------------------------------------------------------------- live vessel

export interface BoatState {
  t: Millis
  position: LatLon
  /** Course over ground, degrees true. */
  cog: Degrees
  /** Speed over ground, knots. */
  sog: Knots
  /** GPS horizontal accuracy, metres. */
  accuracyM: Metres | null
  /** Compass heading if available (phone magnetometer or instruments). */
  heading: Degrees | null
  /** Boat speed through water, if an instrument supplies it. */
  bsp: Knots | null
  heelDeg: SignedDegrees | null
}

export type WindSource = 'instrument' | 'manual' | 'forecast' | 'estimated' | 'held'

export interface WindEstimate {
  twd: Degrees
  tws: Knots
  source: WindSource
  /** Rough 1-sigma direction uncertainty, degrees. Drives layline bounds. */
  uncertaintyDeg: number
  t: Millis
}

export interface CurrentEstimate {
  set: Degrees
  drift: Knots
  source: string
}

// ------------------------------------------------- computed tactical output

export interface LaylineInfo {
  /** Bearing of the layline to the mark, sailing on port tack. */
  portBearing: Degrees
  starboardBearing: Degrees
  /** Distance to reach the layline you'd cross on this tack, nm. */
  distanceToPortLayline: NauticalMiles | null
  distanceToStarboardLayline: NauticalMiles | null
  timeToPortLaylineS: Seconds | null
  timeToStarboardLaylineS: Seconds | null
  /** What TWD would be needed to lay the mark on the current tack. */
  twdToLay: Degrees | null
  /** Layline bearing envelope from wind oscillation. */
  boundsDeg: number
}

export interface StartNumbers {
  /** Seconds until the gun. Negative after it. */
  timeToGunS: Seconds | null
  /** Shortest time to the line over the enabled approaches. */
  timeToLineS: Seconds | null
  /** timeToLine - timeToGun. Positive = early, must burn time. */
  timeToBurnS: Seconds | null
  /** Signed perpendicular distance to the line, +ve on the pre-start side. */
  distanceBelowLineM: Metres | null
  distanceBelowLineBoatLengths: number | null
  /** -ve = port favoured, +ve = starboard favoured. */
  biasAngleDeg: Degrees | null
  /** Distance advantage at the favoured end, metres. */
  biasLengthM: Metres | null
  favouredEnd: 'port' | 'starboard' | 'even' | null
  /** TWD that would square the line. */
  lineSquareWindDeg: Degrees | null
  lineLengthM: Metres | null
  timeToPortEndS: Seconds | null
  timeToStarboardEndS: Seconds | null
  /** True once the bow is over the line before the gun. */
  ocs: boolean
}

export interface TacticalNumbers {
  twd: Degrees | null
  tws: Knots | null
  twa: SignedDegrees | null
  windSource: WindSource | null
  targetBsp: Knots | null
  targetTwa: Degrees | null
  polarBsp: Knots | null
  polarBspPct: number | null
  vmg: Knots | null
  vmgPct: number | null
  vmc: Knots | null
  vmcOptimum: Knots | null
  vmcOptimumHeading: Degrees | null
  markBearing: Degrees | null
  markRange: NauticalMiles | null
  markTimeS: Seconds | null
  headingToSteer: Degrees | null
  xteNm: NauticalMiles | null
  distanceToFinishNm: NauticalMiles | null
  laylines: LaylineInfo | null
  nextMarkBearing: Degrees | null
  /** Beat split: nm to sail on each tack to fetch the mark. */
  portTackDistanceNm: NauticalMiles | null
  starboardTackDistanceNm: NauticalMiles | null
}

// ------------------------------------------------------------------ routing

export interface RouteConstraints {
  maxTws?: Knots
  minTws?: Knots
  maxGust?: Knots
  maxWaveHeightM?: Metres
  tackPenaltyS?: Seconds
  gybePenaltyS?: Seconds
  avoidLand: boolean
}

export interface RouteScalings {
  polarPct: number
  polarPctNight: number
  windScalePct: number
  windRotateDeg: Degrees
  windTimeShiftS: Seconds
  currentScalePct: number
}

export type RouteResolution = 'fast' | 'balanced' | 'best'

export interface RouteRequest {
  start: LatLon
  startTime: Millis
  marks: LatLon[]
  constraints: RouteConstraints
  scalings: RouteScalings
  resolution: RouteResolution
  computeSensitivity: boolean
}

export interface RouteLeg {
  t: Millis
  position: LatLon
  twd: Degrees
  tws: Knots
  twa: SignedDegrees
  bsp: Knots
  heading: Degrees
  /** True when the router substituted a VMG-equivalent zigzag for this leg. */
  isBeating: boolean
  tack: 'port' | 'starboard'
  currentSet: Degrees | null
  currentDrift: Knots | null
  distanceNm: NauticalMiles
}

export interface Isochrone {
  t: Millis
  points: LatLon[]
}

export interface SensitivityField {
  bbox: BBox
  nx: number
  ny: number
  /** Minutes lost by routing through each cell. Infinity where unreachable. */
  loss: Float32Array
}

export interface RouteResult {
  ok: boolean
  error?: string
  legs: RouteLeg[]
  etaMs: Millis | null
  elapsedS: Seconds | null
  /** Direct great-circle time for comparison, seconds. */
  directTimeS: Seconds | null
  isochrones: Isochrone[]
  reverseIsochrones: Isochrone[]
  sensitivity: SensitivityField | null
  diagnostics: {
    nodesExplored: number
    timeStepS: Seconds
    computeMs: number
    warnings: string[]
  }
}

// ------------------------------------------------------------------- track

export interface TrackPoint {
  t: Millis
  lat: number
  lon: number
  sog: Knots
  cog: Degrees
}

export interface Track {
  id: string
  startedAt: Millis
  points: TrackPoint[]
}
