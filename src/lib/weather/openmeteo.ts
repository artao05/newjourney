/**
 * Open-Meteo client — the phase-1 weather source.
 *
 * See docs/02-data-sources/weather-models.md §1 (endpoints, models, variables)
 * and §7 (u/v discipline, wire format), plus docs/05-spec/technical-spec.md §4.
 *
 * Why an aggregator first: it removes GRIB decoding, run scheduling, storage
 * and regridding from the critical path, so a working router is a weekend
 * rather than a month. It is deliberately isolated behind `WeatherField` so the
 * phase-2 swap to our own GRIB-derived cubes touches nothing downstream.
 *
 * Two things this module insists on:
 *   - Speed/direction is converted to u/v on ingest and only u/v is stored.
 *     Everything downstream interpolates; direction cannot be interpolated.
 *   - A failed marine request degrades to wind-only. Losing a good wind field
 *     because the wave server was busy would be absurd.
 *
 * Attribution obligation: free tier is non-commercial with attribution to
 * Open-Meteo (and DWD for ICON-derived data). See licensing-matrix.md.
 */

import { clamp } from '../angles'
import type { BBox, Degrees, Knots, Millis, WeatherCube } from '../types'
import { cubeIndex, emptyCubeData, uvFromCurrent, uvFromWind } from './cube'

const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast'
const MARINE_URL = 'https://marine-api.open-meteo.com/v1/marine'

export type ModelId =
  | 'best_match'
  | 'ecmwf_ifs025'
  | 'gfs_seamless'
  | 'icon_seamless'
  | 'meteofrance_seamless'
  | 'gem_seamless'

export interface ModelInfo {
  id: ModelId
  label: string
  provider: string
  resolutionKm: number
  horizonH: number
  note: string
}

/**
 * The short list, not the long one. weather-models.md §8: offering two models
 * and showing where they disagree is more honest — and more educational — than
 * offering fifteen and letting the user pick one they do not understand.
 * `resolutionKm` is the finest nested grid a "seamless" blend can serve.
 */
export const MODELS: ModelInfo[] = [
  {
    id: 'best_match',
    label: 'Best match',
    provider: 'Open-Meteo',
    resolutionKm: 2,
    horizonH: 384,
    note: 'Open-Meteo picks the highest-resolution model covering each point. Convenient, but the provenance changes under you as the boat moves.',
  },
  {
    id: 'ecmwf_ifs025',
    label: 'ECMWF IFS 0.25°',
    provider: 'ECMWF',
    resolutionKm: 25,
    horizonH: 240,
    note: 'Best global skill and the model offshore navigators trust most. CC-BY-4.0 since the 2025 policy change.',
  },
  {
    id: 'gfs_seamless',
    label: 'NOAA GFS (seamless)',
    provider: 'NOAA NCEP',
    resolutionKm: 3,
    horizonH: 384,
    note: 'HRRR 3 km over CONUS blending out to GFS 0.25° globally. Public domain, four runs a day, always available.',
  },
  {
    id: 'icon_seamless',
    label: 'DWD ICON (seamless)',
    provider: 'DWD',
    resolutionKm: 2.2,
    horizonH: 180,
    note: 'ICON-D2 2.2 km / ICON-EU 6.5 km / ICON global 13 km. The strongest free option for European inshore racing.',
  },
  {
    id: 'meteofrance_seamless',
    label: 'Météo-France AROME/ARPEGE',
    provider: 'Météo-France',
    resolutionKm: 1.5,
    horizonH: 114,
    note: 'AROME 1.5 km over France and the western Med, ARPEGE beyond. Excellent for Brittany and Med venues; short horizon.',
  },
  {
    id: 'gem_seamless',
    label: 'ECCC GEM (seamless)',
    provider: 'Environment Canada',
    resolutionKm: 2.5,
    horizonH: 240,
    note: 'HRDPS 2.5 km / RDPS / GDPS. Useful for the Great Lakes and the North American east coast.',
  },
]

// ------------------------------------------------------------ request shaping

/** Open-Meteo tolerates long multi-point requests, but not unbounded ones. */
const MAX_POINTS_PER_REQUEST = 400
/** Bounded concurrency: we are a guest on a free, shared service. */
const MAX_CONCURRENCY = 4
/** Whole-grid cap. 40x40 already dwarfs any sensible race area. */
const MAX_GRID_POINTS = 1600
const MAX_SIDE = 120
const MIN_STEP_DEG = 0.02
const MAX_STEP_DEG = 5
const DEFAULT_STEP_DEG = 0.25
const DEFAULT_HOURS = 48
const HOUR_MS = 3600_000

const WIND_VARS = ['wind_speed_10m', 'wind_direction_10m', 'wind_gusts_10m', 'pressure_msl']
const WAVE_VARS = [
  'wave_height',
  'wave_direction',
  'wave_period',
  'swell_wave_height',
  'swell_wave_direction',
  'swell_wave_period',
]
const CURRENT_VARS = ['ocean_current_velocity', 'ocean_current_direction']

/**
 * A cube plus the non-fatal problems hit while building it. `fetchWindCube`
 * returns the `WeatherCube` the contract promises; the notes ride along so the
 * UI can say "waves unavailable" instead of silently showing flat water.
 * Read them with `cubeNotes`.
 */
export interface FetchedCube extends WeatherCube {
  notes: string[]
}

export function cubeNotes(c: WeatherCube): string[] {
  const n = (c as Partial<FetchedCube>).notes
  return Array.isArray(n) ? n : []
}

interface GridPlan {
  nx: number
  ny: number
  dx: number
  dy: number
}

function sideCount(span: number, step: number): number {
  return Math.max(1, Math.min(MAX_SIDE, Math.floor(span / step + 1e-9) + 1))
}

/**
 * Choose a grid that spans the bbox exactly and stays inside the point cap.
 * The requested step is a target, not a promise: a user who asks for 0.02° over
 * an ocean gets a coarser grid rather than a 400 000-point request.
 */
function planGrid(bbox: BBox, stepDeg: number): GridPlan {
  const spanX = Math.max(0, bbox.east - bbox.west)
  const spanY = Math.max(0, bbox.north - bbox.south)
  let step = clamp(stepDeg, MIN_STEP_DEG, MAX_STEP_DEG)
  let nx = sideCount(spanX, step)
  let ny = sideCount(spanY, step)
  for (let guard = 0; nx * ny > MAX_GRID_POINTS && guard < 32; guard++) {
    step *= Math.max(1.25, Math.sqrt((nx * ny) / MAX_GRID_POINTS))
    nx = sideCount(spanX, step)
    ny = sideCount(spanY, step)
  }
  return {
    nx,
    ny,
    dx: nx > 1 ? spanX / (nx - 1) : step,
    dy: ny > 1 ? spanY / (ny - 1) : step,
  }
}

/** Grid nodes in cube order: y outer (south to north), x inner (west to east). */
function gridPoints(bbox: BBox, g: GridPlan): Array<{ lat: number; lon: number }> {
  const pts: Array<{ lat: number; lon: number }> = []
  for (let iy = 0; iy < g.ny; iy++) {
    for (let ix = 0; ix < g.nx; ix++) {
      pts.push({ lat: bbox.south + iy * g.dy, lon: bbox.west + ix * g.dx })
    }
  }
  return pts
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/** Run `fn` over `items` with at most `limit` in flight. Results keep input order. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const workers: Array<Promise<void>> = []
  for (let w = 0; w < Math.min(limit, items.length); w++) {
    workers.push(
      (async () => {
        for (;;) {
          const i = next++
          if (i >= items.length) return
          out[i] = await fn(items[i], i)
        }
      })(),
    )
  }
  await Promise.all(workers)
  return out
}

// ------------------------------------------------------------ response typing

type Series = Array<number | null>

interface OmHourly {
  time?: number[]
  [key: string]: unknown
}

interface OmLocation {
  latitude?: number
  longitude?: number
  hourly?: OmHourly
  hourly_units?: Record<string, string>
}

/**
 * Open-Meteo suffixes variable names with the model id when more than one model
 * is requested, and leaves them bare otherwise. Accept both so a future
 * multi-model comparison view does not silently read undefined.
 */
function pickSeries(hourly: OmHourly | undefined, name: string): Series | null {
  if (!hourly) return null
  const direct = hourly[name]
  if (Array.isArray(direct)) return direct as Series
  for (const key of Object.keys(hourly)) {
    if (key.startsWith(`${name}_`) && Array.isArray(hourly[key])) return hourly[key] as Series
  }
  return null
}

function unitFor(loc: OmLocation, name: string): string | undefined {
  const units = loc.hourly_units
  if (!units) return undefined
  if (units[name]) return units[name]
  for (const key of Object.keys(units)) if (key.startsWith(`${name}_`)) return units[key]
  return undefined
}

/**
 * The marine API has no `wind_speed_unit` switch, so ocean current velocity
 * arrives in whatever the response declares — usually km/h. Read the declared
 * unit rather than assuming; a 1.9x error in current is a wrong route.
 */
function toKnots(value: number, unit: string | undefined): number | null {
  switch ((unit ?? '').trim().toLowerCase()) {
    case 'kn':
    case 'kt':
    case 'kts':
    case 'knots':
      return value
    case 'km/h':
    case 'kmh':
      return value * 0.5399568
    case 'm/s':
    case 'ms':
      return value * 1.9438445
    case 'mp/h':
    case 'mph':
      return value * 0.8689762
    default:
      return null
  }
}

async function getJson(url: string, signal?: AbortSignal): Promise<unknown> {
  const res = await fetch(url, signal ? { signal } : {})
  if (!res.ok) {
    let reason = `${res.status} ${res.statusText}`
    try {
      const body = (await res.json()) as { reason?: string }
      if (body?.reason) reason = body.reason
    } catch {
      // Non-JSON error body; the status line is all we have.
    }
    throw new Error(`Open-Meteo request failed: ${reason}`)
  }
  return res.json()
}

/** Multi-location responses are arrays; single-location ones are bare objects. */
function asLocations(json: unknown): OmLocation[] {
  return Array.isArray(json) ? (json as OmLocation[]) : [json as OmLocation]
}

function pointsQuery(pts: Array<{ lat: number; lon: number }>): string {
  const lat = pts.map((p) => p.lat.toFixed(4)).join(',')
  const lon = pts.map((p) => p.lon.toFixed(4)).join(',')
  return `latitude=${lat}&longitude=${lon}`
}

// -------------------------------------------------------------------- caching

interface CacheEntry {
  expires: Millis
  cube: Promise<WeatherCube>
}

const cache = new Map<string, CacheEntry>()

/**
 * Round only enough to absorb float noise, so a bbox recomputed from the same
 * inputs still hits.
 *
 * This used to quantise to 0.25° "so panning the map by a pixel does not miss the
 * cache", and that was a silent correctness bug: the key was quantised but the
 * fetch used the caller's exact bbox, so two different boxes rounding to the same
 * quarter-degree shared one entry and the second caller received a cube built for
 * the first caller's box. Offset by up to 0.125°, about 7.5 nm, with a strip of the
 * requested area holding no data at all — and nothing downstream reads as an error,
 * because `sampleCube` correctly returns null outside coverage and the router just
 * reports "no legal move from the frontier".
 *
 * The pan case it was written for does not exist: `ChartSurface` fetches on model
 * change and `RouteScreen` on a button press, and neither refetches on map movement.
 * If one ever does, the fix is to snap the *fetched* box outward to a grid and key
 * on that, so the key and the data describe the same rectangle — not to widen the
 * key alone.
 */
const q6 = (x: number): number => Math.round(x * 1e6) / 1e6

function cacheKey(model: ModelId, bbox: BBox, stepDeg: number, hours: number, waves: boolean, current: boolean): string {
  const b = [q6(bbox.west), q6(bbox.south), q6(bbox.east), q6(bbox.north)].join(',')
  return `${model}|${b}|${stepDeg}|${hours}|${waves ? 'w' : '-'}${current ? 'c' : '-'}`
}

/**
 * Model runs land on the hour, so entries expire at the next hour boundary
 * rather than after a fixed TTL — otherwise a cache filled at 05:59 keeps
 * serving the pre-06Z field until 06:59. (weather-models.md §7.)
 */
function expiryAfter(now: Millis): Millis {
  return Math.floor(now / HOUR_MS) * HOUR_MS + HOUR_MS
}

export function clearWeatherCache(): void {
  cache.clear()
}

// ------------------------------------------------------------------- fetching

export interface FetchWindCubeOptions {
  bbox: BBox
  /** Target grid spacing in degrees; the client clamps the point count. */
  stepDeg?: number
  hours?: number
  model?: ModelId
  includeWaves?: boolean
  includeCurrent?: boolean
  signal?: AbortSignal
}

/**
 * Fetch a rectangular grid of forecasts as a single `WeatherCube`.
 *
 * Open-Meteo takes comma-separated latitude/longitude lists and answers with an
 * array, so a whole grid costs a handful of requests rather than one per node.
 * The runtime object is a `FetchedCube`; read `cubeNotes(cube)` for anything
 * that degraded.
 */
export async function fetchWindCube(opts: FetchWindCubeOptions): Promise<WeatherCube> {
  const model = opts.model ?? 'best_match'
  const stepDeg = opts.stepDeg ?? DEFAULT_STEP_DEG
  const hours = clamp(Math.round(opts.hours ?? DEFAULT_HOURS), 1, 384)
  const includeWaves = opts.includeWaves ?? false
  const includeCurrent = opts.includeCurrent ?? false

  const key = cacheKey(model, opts.bbox, stepDeg, hours, includeWaves, includeCurrent)
  const now = Date.now()
  const hit = cache.get(key)
  if (hit && hit.expires > now) return hit.cube

  const pending = buildCube({ ...opts, model, stepDeg, hours, includeWaves, includeCurrent })
  cache.set(key, { expires: expiryAfter(now), cube: pending })
  // A failed fetch must not be remembered — the next call should retry.
  pending.catch(() => {
    if (cache.get(key)?.cube === pending) cache.delete(key)
  })
  return pending
}

async function buildCube(opts: Required<Omit<FetchWindCubeOptions, 'signal'>> & { signal?: AbortSignal }): Promise<FetchedCube> {
  const { bbox, model, stepDeg, hours, includeWaves, includeCurrent, signal } = opts
  const grid = planGrid(bbox, stepDeg)
  const points = gridPoints(bbox, grid)
  const batches = chunk(points, MAX_POINTS_PER_REQUEST)
  const notes: string[] = []

  if (grid.dx > stepDeg * 1.001 || grid.dy > stepDeg * 1.001) {
    notes.push(`grid coarsened to ${grid.dx.toFixed(3)}° x ${grid.dy.toFixed(3)}° to stay under ${MAX_GRID_POINTS} points`)
  }

  const windParams = `hourly=${WIND_VARS.join(',')}&wind_speed_unit=kn&timeformat=unixtime&cell_selection=sea&forecast_hours=${hours}&models=${model}`
  const windResponses = await mapLimit(batches, MAX_CONCURRENCY, async (batch) =>
    asLocations(await getJson(`${FORECAST_URL}?${pointsQuery(batch)}&${windParams}`, signal)),
  )

  // The time axis comes from the wind request; everything else is mapped onto it.
  const axis = firstTimeAxis(windResponses)
  if (!axis) throw new Error('Open-Meteo returned no time axis')
  const nt = axis.length
  const t0 = axis[0] * 1000
  const dtMs = nt > 1 ? (axis[1] - axis[0]) * 1000 : HOUR_MS
  const timeIndex = new Map<number, number>()
  for (let i = 0; i < nt; i++) timeIndex.set(axis[i], i)

  const params = ['u10', 'v10', 'gust', 'prmsl']
  if (includeWaves) params.push('hs', 'wdir', 'wper')
  if (includeCurrent) params.push('uo', 'vo')

  const cube: FetchedCube = {
    model: MODELS.find((m) => m.id === model)?.label ?? model,
    // Open-Meteo does not expose the underlying model run, so this is the
    // retrieval time. Labelled honestly rather than guessed at from synoptic hours.
    run: new Date().toISOString(),
    bbox: { west: bbox.west, south: bbox.south, east: bbox.west + (grid.nx - 1) * grid.dx, north: bbox.south + (grid.ny - 1) * grid.dy },
    nx: grid.nx,
    ny: grid.ny,
    dx: grid.dx,
    dy: grid.dy,
    t0,
    dtMs,
    nt,
    params,
    data: emptyCubeData(params, nt, grid.ny, grid.nx),
    notes,
  }

  fillWind(cube, windResponses, batches, timeIndex)

  if (includeWaves || includeCurrent) {
    try {
      const marineVars = [...(includeWaves ? WAVE_VARS : []), ...(includeCurrent ? CURRENT_VARS : [])]
      const marineParams = `hourly=${marineVars.join(',')}&timeformat=unixtime&length_unit=metric&cell_selection=sea&forecast_hours=${hours}`
      const marineResponses = await mapLimit(batches, MAX_CONCURRENCY, async (batch) =>
        asLocations(await getJson(`${MARINE_URL}?${pointsQuery(batch)}&${marineParams}`, signal)),
      )
      fillMarine(cube, marineResponses, batches, timeIndex, includeWaves, includeCurrent)
    } catch (err) {
      // Partial failure is expected inshore, where marine models have no
      // coverage. Never throw away good wind because the wave server said no.
      notes.push(`marine data unavailable (${err instanceof Error ? err.message : String(err)}); wind only`)
      for (const p of ['hs', 'wdir', 'wper', 'uo', 'vo']) {
        const i = cube.params.indexOf(p)
        if (i >= 0) {
          cube.params.splice(i, 1)
          delete cube.data[p]
        }
      }
    }
  }

  return cube
}

function firstTimeAxis(responses: OmLocation[][]): number[] | null {
  for (const batch of responses) {
    for (const loc of batch) {
      const t = loc.hourly?.time
      if (Array.isArray(t) && t.length > 0) return t
    }
  }
  return null
}

/** Map one location's own time axis onto the cube's. Unknown hours are skipped. */
function alignTimes(own: number[] | undefined, index: Map<number, number>): Int32Array | null {
  if (!Array.isArray(own)) return null
  const out = new Int32Array(own.length)
  for (let i = 0; i < own.length; i++) out[i] = index.get(own[i]) ?? -1
  return out
}

function fillWind(
  cube: FetchedCube,
  responses: OmLocation[][],
  batches: Array<Array<{ lat: number; lon: number }>>,
  timeIndex: Map<number, number>,
): void {
  const u10 = cube.data.u10
  const v10 = cube.data.v10
  const gust = cube.data.gust
  const prmsl = cube.data.prmsl

  for (let b = 0; b < responses.length; b++) {
    const offset = b * MAX_POINTS_PER_REQUEST
    const locations = responses[b]
    for (let p = 0; p < locations.length && p < batches[b].length; p++) {
      const loc = locations[p]
      const flat = offset + p
      const ix = flat % cube.nx
      const iy = Math.floor(flat / cube.nx)
      const map = alignTimes(loc.hourly?.time, timeIndex)
      if (!map) continue

      const speed = pickSeries(loc.hourly, 'wind_speed_10m')
      const dir = pickSeries(loc.hourly, 'wind_direction_10m')
      const gusts = pickSeries(loc.hourly, 'wind_gusts_10m')
      const press = pickSeries(loc.hourly, 'pressure_msl')
      // wind_speed_unit=kn was requested, but trust the response over the request.
      const speedUnit = unitFor(loc, 'wind_speed_10m') ?? 'kn'

      for (let i = 0; i < map.length; i++) {
        const it = map[i]
        if (it < 0) continue
        const cell = cubeIndex(cube, ix, iy, it)

        const s = speed?.[i]
        const d = dir?.[i]
        if (typeof s === 'number' && typeof d === 'number') {
          const kn = toKnots(s, speedUnit)
          if (kn !== null) {
            // Convert on ingest; only u/v is ever stored. weather-models.md §7.
            const uv = uvFromWind(kn, d)
            u10[cell] = uv.u
            v10[cell] = uv.v
          }
        }
        const g = gusts?.[i]
        if (typeof g === 'number') {
          const kn = toKnots(g, unitFor(loc, 'wind_gusts_10m') ?? speedUnit)
          if (kn !== null) gust[cell] = kn
        }
        const pr = press?.[i]
        if (typeof pr === 'number') prmsl[cell] = pr
      }
    }
  }
}

function fillMarine(
  cube: FetchedCube,
  responses: OmLocation[][],
  batches: Array<Array<{ lat: number; lon: number }>>,
  timeIndex: Map<number, number>,
  includeWaves: boolean,
  includeCurrent: boolean,
): void {
  let usedSwellFallback = false
  let unknownCurrentUnit = false

  for (let b = 0; b < responses.length; b++) {
    const offset = b * MAX_POINTS_PER_REQUEST
    const locations = responses[b]
    for (let p = 0; p < locations.length && p < batches[b].length; p++) {
      const loc = locations[p]
      const flat = offset + p
      const ix = flat % cube.nx
      const iy = Math.floor(flat / cube.nx)
      const map = alignTimes(loc.hourly?.time, timeIndex)
      if (!map) continue

      const hs = pickSeries(loc.hourly, 'wave_height')
      const wdir = pickSeries(loc.hourly, 'wave_direction')
      const wper = pickSeries(loc.hourly, 'wave_period')
      const swh = pickSeries(loc.hourly, 'swell_wave_height')
      const swdir = pickSeries(loc.hourly, 'swell_wave_direction')
      const swper = pickSeries(loc.hourly, 'swell_wave_period')
      const cvel = pickSeries(loc.hourly, 'ocean_current_velocity')
      const cdir = pickSeries(loc.hourly, 'ocean_current_direction')
      const velUnit = unitFor(loc, 'ocean_current_velocity')

      for (let i = 0; i < map.length; i++) {
        const it = map[i]
        if (it < 0) continue
        const cell = cubeIndex(cube, ix, iy, it)

        if (includeWaves) {
          // Some marine models publish swell partitions but no total sea state;
          // fall back rather than leave a hole the router reads as "no waves".
          const sh = swh?.[i]
          const useSwell = typeof hs?.[i] !== 'number' && typeof sh === 'number'
          if (useSwell) usedSwellFallback = true
          const h = useSwell ? sh : hs?.[i]
          const d = (useSwell ? swdir?.[i] : wdir?.[i]) ?? wdir?.[i]
          const t = (useSwell ? swper?.[i] : wper?.[i]) ?? wper?.[i]
          if (typeof h === 'number') cube.data.hs[cell] = h
          if (typeof d === 'number') cube.data.wdir[cell] = d
          if (typeof t === 'number') cube.data.wper[cell] = t
        }

        if (includeCurrent) {
          const vel = cvel?.[i]
          const dir = cdir?.[i]
          if (typeof vel === 'number' && typeof dir === 'number') {
            // Marine velocities default to km/h; the API has no knots switch.
            const declared = toKnots(vel, velUnit)
            if (declared === null) unknownCurrentUnit = true
            const kn = declared ?? vel * 0.5399568
            // `ocean_current_direction` is the direction the water flows TOWARDS
            // — the opposite convention to wind. See cube.ts `uvFromCurrent`.
            const uv = uvFromCurrent(kn, dir)
            cube.data.uo[cell] = uv.u
            cube.data.vo[cell] = uv.v
          }
        }
      }
    }
  }

  if (usedSwellFallback) cube.notes.push('some cells used swell partitions in place of total significant wave height')
  if (unknownCurrentUnit) cube.notes.push('ocean current velocity unit not declared; assumed km/h')
}

// ------------------------------------------------------------- point forecast

export interface PointForecast {
  t: Millis[]
  twd: Degrees[]
  tws: Knots[]
  gust: Knots[]
  model: string
}

/**
 * Single-point forecast, used for the tactical wind estimate when there is no
 * instrument and no manual wind. Speed/direction is fine to return here — it is
 * one point, so nothing will interpolate it.
 */
export async function fetchPointForecast(opts: {
  lat: number
  lon: number
  hours?: number
  model?: ModelId
  signal?: AbortSignal
}): Promise<PointForecast> {
  const model = opts.model ?? 'best_match'
  const hours = clamp(Math.round(opts.hours ?? 24), 1, 384)
  const url =
    `${FORECAST_URL}?latitude=${opts.lat.toFixed(4)}&longitude=${opts.lon.toFixed(4)}` +
    `&hourly=${WIND_VARS.join(',')}&wind_speed_unit=kn&timeformat=unixtime` +
    `&cell_selection=sea&forecast_hours=${hours}&models=${model}`

  const loc = asLocations(await getJson(url, opts.signal))[0]
  const times = loc?.hourly?.time ?? []
  const speed = pickSeries(loc?.hourly, 'wind_speed_10m')
  const dir = pickSeries(loc?.hourly, 'wind_direction_10m')
  const gusts = pickSeries(loc?.hourly, 'wind_gusts_10m')
  const speedUnit = unitFor(loc ?? {}, 'wind_speed_10m') ?? 'kn'

  const t: Millis[] = []
  const twd: Degrees[] = []
  const tws: Knots[] = []
  const gust: Knots[] = []
  for (let i = 0; i < times.length; i++) {
    const s = speed?.[i]
    const d = dir?.[i]
    if (typeof s !== 'number' || typeof d !== 'number') continue
    const kn = toKnots(s, speedUnit)
    if (kn === null) continue
    t.push(times[i] * 1000)
    twd.push(d)
    tws.push(kn)
    const g = gusts?.[i]
    const gkn = typeof g === 'number' ? toKnots(g, speedUnit) : null
    gust.push(gkn ?? kn)
  }

  return { t, twd, tws, gust, model: MODELS.find((m) => m.id === model)?.label ?? model }
}
