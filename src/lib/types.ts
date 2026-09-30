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
  /**
   * Wind weight: the day's air heavier (over 1) or lighter than the polar's, from
   * density or shear. It scales the polar's speeds, targets and routing alike.
   */
  windWeight?: number
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

/**
 * The sea as a router penalises it: swell and wind sea apart, each a height and
 * the direction it comes from (NaN where unknown). Null heights are "not known",
 * never a flat sea.
 */
export interface SeaState {
  swellH: Metres | null
  swellFrom: Degrees
  windWaveH: Metres | null
  windWaveFrom: Degrees
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
  /** Swell and wind sea apart, where the field knows them. Optional: most fields don't. */
  seaState?(lat: number, lon: number, t: Millis): SeaState | null
  /** Air density, kg/m³, from pressure and temperature (and humidity if known). */
  airDensity?(lat: number, lon: number, t: Millis): number | null
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
  /** Set on a man-overboard mark: when it went in. */
  mobAt?: Millis
  /** A gate: its two buoys. `position` is then the middle of the gate. */
  gate?: { widthM: number; left: LatLon; right: LatLon }
  /** Locked: it cannot be moved or deleted until unlocked. */
  locked?: boolean
  /** A range circle drawn around it, nautical miles; inside it, auto advance counts it done. */
  rangeNm?: number
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
  /**
   * Where the bow will be at the gun, on the present COG and SOG, as a distance
   * below the line: positive short of it, negative over. Null without a gun.
   */
  gunDistanceBelowLineM: Metres | null
  /** The stern's distance below the line: the bow's plus the hull's length along the line's normal. */
  sternBelowLineM: Metres | null
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
  /** The simple times to each end: at polar speed, with no current, turns or acceleration. */
  timeToPortEndSimpleS: Seconds | null
  timeToStarboardEndSimpleS: Seconds | null
  /** The speed that gets the bow to each end exactly at the gun. */
  speedToPortEndKn: Knots | null
  speedToStarboardEndKn: Knots | null
  /** The speed that reaches the line at the gun on each tack, close-hauled (or running). */
  speedOnPortKn: Knots | null
  speedOnStarboardKn: Knots | null
  /**
   * The reaching approach, holding the present heading to the line: how far,
   * how long at start-polar speed, and the speed that gets there at the gun.
   */
  reachDistanceM: Metres | null
  reachTimeS: Seconds | null
  reachSpeedKn: Knots | null
  /** Upwind targets from the start polar at the present wind. */
  targetBsp: Knots | null
  targetTwa: Degrees | null
  /** Straight at each end at the polar speed for that angle: no tacks, pinching if need be. */
  pinchTimeToPortS: Seconds | null
  pinchTimeToStarboardS: Seconds | null
  /** Boat speed now as a percentage of the upwind target, and of the polar at the present angle. */
  gunBspTargetPct: number | null
  gunBspPolarPct: number | null
  /** Running the line: from the bow's foot on it to the pin, at the polar speed along it. */
  boatToPinS: Seconds | null
  /**
   * Sailing parallel to the line toward an end, the time to its layline: the
   * starboard-tack layline through the pin (P), the port-tack one through the
   * committee boat (S). Negative when already past it.
   */
  timeToLaylinePS: Seconds | null
  timeToLaylineSS: Seconds | null
  /**
   * The top corner: where the pin's port-tack course and the committee boat's
   * starboard-tack course meet above the line, the point both ends lay alike.
   * The time to sail there, and that time less the time to gun (positive: late).
   */
  topCorner: LatLon | null
  timeToCornerS: Seconds | null
  cornerBurnS: Seconds | null
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
  /** Length of the leg after this one: active mark to the next mark. */
  nextMarkRange: NauticalMiles | null
  /** Beat split: nm to sail on each tack to fetch the mark. */
  portTackDistanceNm: NauticalMiles | null
  starboardTackDistanceNm: NauticalMiles | null
}

// ------------------------------------------------------------------ routing

export interface RouteConstraints {
  maxTws?: Knots
  minTws?: Knots
  /** No heading closer than 90° to the wind above this TWS: the boat will not beat into it. */
  maxTwsUpwind?: Knots
  /** No heading 90° or more off the wind above this TWS. */
  maxTwsDownwind?: Knots
  /** Motor at `motorSpeedKn` wherever sailing would be slower than `motorBelowKn`. */
  motorSpeedKn?: Knots
  motorBelowKn?: Knots
  maxGust?: Knots
  maxWaveHeightM?: Metres
  tackPenaltyS?: Seconds
  gybePenaltyS?: Seconds
  avoidLand: boolean
  /**
   * Race-note areas the route must not enter, as GeoJSON polygon coordinates
   * (`[ring][vertex][lon, lat]`). Tested per segment, exactly as land is.
   */
  avoidAreas?: number[][][][]
  /** Race-note areas where boat speed is a percentage of the polar. */
  slowAreas?: Array<{ polygon: number[][][]; pct: number }>
}

export interface RouteScalings {
  polarPct: number
  polarPctNight: number
  windScalePct: number
  windRotateDeg: Degrees
  windTimeShiftS: Seconds
  currentScalePct: number
  /**
   * The wind observed now, blended into the forecast: the difference between it
   * and the forecast at the start, applied in full at `t0` and fading to nothing
   * over `decayMin` minutes.
   */
  nowCorrection?: { t0: Millis; observedTwd: Degrees; observedTws: Knots; decayMin: number }
  /**
   * Speed in waves, as a percentage of the polar: `pct[r][c]` at wave height
   * `heights[r]` (m) and wave angle `angles[c]` to the boat, 0° head seas and
   * 180° following. Interpolated, and held beyond the edges.
   */
  waveTable?: { heights: number[]; angles: number[]; pct: number[][] }
  /**
   * Swell and wind-sea penalties: the polar is cut by `swellPct` (and
   * `windWavePct`) in full at `refHeightM` of that sea and above, in proportion
   * below; and by `crossedPct` more where swell and wind sea cross within
   * `crossedMarginDeg` of 90°, both above `crossedMinM` and together above
   * `crossedTotalM`. The swell is the swell partition where there is one, else
   * the primary or mean sea.
   */
  seaPenalty?: {
    swellPct: number
    windWavePct: number
    refHeightM: Metres
    crossedPct: number
    crossedMinM: Metres
    crossedTotalM: Metres
    crossedMarginDeg: Degrees
  }
  /** Scale the wind the polar reads by √(ρ/ρref) for the air's density. */
  airDensity?: boolean
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
  /** Also return every path the search kept, to draw: slower to draw, not to compute. */
  returnExplored?: boolean
  /** Isochrones (the default), or the grid, for a second opinion. */
  algorithm?: 'isochrone' | 'grid'
  /** For the grid: lay it along the great circle rather than the rhumb line. */
  greatCircle?: boolean
  /**
   * Route each leg for itself, as older routers do, rather than carrying the
   * best arrival on each tack into the next leg. For comparison; off by default.
   */
  legByLeg?: boolean
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
  /**
   * Every path the forward search kept, when asked for: segments from a node's
   * parent to the node, flat as lat0, lon0, lat1, lon1. Capped, evenly.
   */
  explored?: Float32Array
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
