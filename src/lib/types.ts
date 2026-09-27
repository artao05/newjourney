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
  /**
   * Deepest point of the boat with keel or board down, metres.
   *
   * Optional, and deliberately has no default. Every other dimension here can be
   * looked up from a class name, but a boat's real draft depends on the keel
   * fitted, the board being down, and what is in the bilge — and a clearance figure
   * computed from a guessed draft is indistinguishable from one computed from a
   * measurement. Undefined means the depth advisory reports water depth instead of
   * water under the keel, and says which it is showing.
   */
  draftMetres?: Metres
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
  /**
   * The field's own time cadence in milliseconds, when it has a regular one.
   *
   * Declared here because the router needs it and guessing is not an option: the
   * isochrone time step is clamped to never exceed the forecast cadence, and a
   * step coarser than the data is how a router sails through a front and never
   * notices (docs/03-algorithms/routing-isochrone.md §5).
   *
   * Optional because not every field has a cadence — a constant field and a
   * station interpolation have none — and `undefined` correctly means "no opinion,
   * use the leg table" rather than "instantaneous".
   */
  readonly dtMs?: number
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
  /**
   * `timeToLine - timeToGun`, keeping Expedition's definition verbatim.
   *
   * Mind the sign: this is POSITIVE when you arrive AFTER the gun, i.e. when you
   * are late, and NEGATIVE when you get there early and have spare time to kill.
   * That is the opposite of how a sailor uses the phrase "time to burn", so the
   * UI presents `-timeToBurnS` as the spare time. Do not "fix" the sign here —
   * the field is the interchange value; the flip belongs at the display layer.
   */
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
  /**
   * Distance from this leg to the NEXT one, not the distance already sailed to
   * reach it. Zero on the final leg, which has nowhere to go.
   *
   * Stated because the natural reading is the other one, and this value leaves the
   * app: it is the `dist_nm` column of the CSV export. On a beating leg it is the
   * distance along the drawn VMG-equivalent path, so summing the column gives the
   * length of the drawn route rather than the distance actually sailed through the
   * water while tacking.
   */
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
    /**
     * Whether the search actually consulted a land mask.
     *
     * Separate from `constraints.avoidLand`, because the two disagree in exactly
     * the case that matters: avoidance is requested, the mask never reaches the
     * kernel or is rejected as corrupt, and the route is then computed over open
     * water. Only the kernel knows which happened, so only the kernel may say. A
     * caller that infers this from whether its own copy of the coastline pack
     * loaded will tell a sailor land was avoided when it was not.
     */
    landAvoided: boolean
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
