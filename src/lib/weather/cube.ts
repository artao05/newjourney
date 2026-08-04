/**
 * The weather cube: wire format, worker format, and the interpolator that reads it.
 *
 * See docs/05-spec/technical-spec.md §4 (pipeline + wire format) and
 * docs/02-data-sources/weather-models.md §7 (u/v discipline, Int16 sizing).
 *
 * Three rules here are load-bearing, and all three are cheap to get wrong:
 *
 *   1. Wind and current are stored as u/v components, never speed/direction.
 *      Linear interpolation of a direction across the 0/360 wrap produces a
 *      wind blowing the opposite way, and nothing downstream can detect it.
 *      See docs/01-expedition-analysis/how-it-computes.md §4.
 *   2. A sample outside coverage returns `null`, never 0. A route computed
 *      through a region of "no data" silently treated as "no wind, no current"
 *      is precisely the failure mode that puts a boat somewhere it did not
 *      plan to be. See technical-spec.md §4.
 *   3. Int16 with a per-parameter scale, plus a delta+shuffle filter, is what
 *      makes offline work: the reference cube (5°x5° at 0.25°, 48 hourly steps,
 *      u/v+gust) measures 127 318 bytes raw and 30 242 gzipped — a race-morning
 *      download on a phone, and inside the 35 KB budget in the spec.
 */

import { clamp, toDeg, toRad, wrap360 } from '../angles'
import type { BBox, Degrees, Knots, Millis, UV, WeatherCube } from '../types'

// ------------------------------------------------------------- u/v conventions

/**
 * Meteorological convention: wind direction is where the wind comes FROM, so
 * the vector it produces points the opposite way. A wind FROM 090 blows
 * towards the west and therefore has a NEGATIVE u (eastward) component.
 *
 * Get this sign wrong and every route silently inverts, which is why it is
 * isolated in one four-line function with a test around it.
 */
export function uvFromWind(speed: Knots, fromDeg: Degrees): UV {
  const r = toRad(fromDeg)
  return { u: -speed * Math.sin(r), v: -speed * Math.cos(r) }
}

/** Inverse of `uvFromWind`. `dir` is the direction the wind comes FROM. */
export function windFromUv(u: Knots, v: Knots): { speed: Knots; dir: Degrees } {
  return { speed: Math.hypot(u, v), dir: wrap360(toDeg(Math.atan2(-u, -v))) }
}

/**
 * Oceanographic convention, and the opposite of wind: `set` is the direction
 * the water flows TOWARDS. So the signs here are positive where the wind
 * versions are negative. This asymmetry is a genuine trap.
 */
export function uvFromCurrent(drift: Knots, setDeg: Degrees): UV {
  const r = toRad(setDeg)
  return { u: drift * Math.sin(r), v: drift * Math.cos(r) }
}

/** Inverse of `uvFromCurrent`. `set` is the direction the water flows TOWARDS. */
export function currentFromUv(u: Knots, v: Knots): { drift: Knots; set: Degrees } {
  return { drift: Math.hypot(u, v), set: wrap360(toDeg(Math.atan2(u, v))) }
}

// ---------------------------------------------------------------- binary codec

/** 'WCUB', written big-endian so it is legible in a hex dump. */
const MAGIC = 0x57435542
const VERSION = 1
/** magic(4) + version(2) + reserved(2) + headerLength(4) */
const PREAMBLE_BYTES = 12

/** Int16 sentinel for "no data here". Real values are clamped clear of it. */
export const MISSING = -32768

/**
 * Quantised values are clamped to ±16383, not ±32767, so that the difference
 * between any two of them still fits in an Int16 and can never collide with
 * MISSING. That is what makes the delta filter below safe. The cost is half the
 * representable range — ±163 kn of wind at 0.01 kn, ±1638 hPa — which no sea
 * state on this planet troubles.
 */
const RANGE = 16383

/**
 * Body filter, applied before the transport compresses the payload.
 *
 * Raw Int16 gzips to about 50% because the low bytes of a smooth field are
 * noise sitting next to highly repetitive high bytes. Two classic cheap filters
 * fix that, and together they are the difference between a 62 KB and a 30 KB
 * race-morning download for the reference cube:
 *
 *   delta-t   store each hour as its difference from the same cell an hour
 *             earlier. Weather at a fixed point is strongly autocorrelated in
 *             time, so the residuals are small and centred on zero.
 *   shuffle   de-interleave into a plane of low bytes followed by a plane of
 *             high bytes (the HDF5/Blosc trick), so the compressor sees two
 *             homogeneous runs instead of one alternating one.
 *
 * Named in the header so a future encoder can change it without breaking old
 * cubes, and so an unknown filter is a loud error rather than garbage.
 */
const FILTER = 'delta-t,shuffle'

/**
 * Per-parameter quantisation. Each is chosen so the physical range fits in
 * ±RANGE counts with a resolution below the model's own noise floor —
 * quantisation must never be the largest error in the pipeline.
 */
export const PARAM_SCALE: Readonly<Record<string, number>> = {
  u10: 0.01, // knots, ±163 kn, 0.01 kn steps
  v10: 0.01,
  gust: 0.01,
  prmsl: 0.1, // hPa, ±1638 hPa (1013.2 -> 10132)
  hs: 0.01, // metres, ±163 m
  wdir: 0.1, // degrees, 0..3600
  wper: 0.01, // seconds, ±163 s
  uo: 0.001, // knots, ±16 kn; currents are small, so buy resolution
  vo: 0.001,
}

export const DEFAULT_SCALE = 0.01

export function scaleFor(param: string): number {
  return PARAM_SCALE[param] ?? DEFAULT_SCALE
}

interface CubeHeader {
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
  scale: Record<string, number>
  missing: number
  filter: string
}

function headerOf(c: WeatherCube): CubeHeader {
  const scale: Record<string, number> = {}
  for (const p of c.params) scale[p] = scaleFor(p)
  return {
    model: c.model,
    run: c.run,
    bbox: c.bbox,
    nx: c.nx,
    ny: c.ny,
    dx: c.dx,
    dy: c.dy,
    t0: c.t0,
    dtMs: c.dtMs,
    nt: c.nt,
    params: [...c.params],
    scale,
    missing: MISSING,
    filter: FILTER,
  }
}

/** Body offset, keeping the Int16 body 2-byte aligned. */
function bodyOffset(headerLength: number): number {
  const raw = PREAMBLE_BYTES + headerLength
  return raw + (raw % 2)
}

/**
 * Self-describing container: a fixed preamble, a JSON header (so a cube can be
 * inspected with `head -c 400`), then the filtered Int16 body in
 * C-order [param][time][y][x] — the same order as `WeatherCube.data`.
 */
export function encodeCube(c: WeatherCube): ArrayBuffer {
  const header = headerOf(c)
  const headerBytes = new TextEncoder().encode(JSON.stringify(header))
  const offset = bodyOffset(headerBytes.length)
  const cells = c.ny * c.nx
  const plane = c.nt * cells
  const count = c.params.length * plane
  const buf = new ArrayBuffer(offset + count * 2)

  const view = new DataView(buf)
  view.setUint32(0, MAGIC, false)
  view.setUint16(4, VERSION, true)
  view.setUint16(6, 0, true)
  view.setUint32(8, headerBytes.length, true)
  new Uint8Array(buf, PREAMBLE_BYTES, headerBytes.length).set(headerBytes)

  const residual = new Int16Array(count)
  const pred = new Int16Array(cells)
  let w = 0
  for (const param of c.params) {
    const scale = scaleFor(param)
    const src = c.data[param]
    pred.fill(0)
    for (let it = 0; it < c.nt; it++) {
      for (let i = 0; i < cells; i++) {
        const v = src ? src[it * cells + i] : NaN
        if (!Number.isFinite(v)) {
          // A hole stays a hole and leaves the predictor alone, so the next
          // real value still deltas against the last real one.
          residual[w++] = MISSING
          continue
        }
        const q = clamp(Math.round(v / scale), -RANGE, RANGE)
        residual[w++] = q - pred[i]
        pred[i] = q
      }
    }
  }

  // Byte-plane shuffle, low bytes then high bytes.
  const bytes = new Uint8Array(buf, offset, count * 2)
  for (let i = 0; i < count; i++) {
    const v = residual[i] & 0xffff
    bytes[i] = v & 0xff
    bytes[count + i] = (v >> 8) & 0xff
  }
  return buf
}

export function decodeCube(buf: ArrayBuffer): WeatherCube {
  if (buf.byteLength < PREAMBLE_BYTES) throw new Error('weather cube: truncated')
  const view = new DataView(buf)
  if (view.getUint32(0, false) !== MAGIC) throw new Error('weather cube: bad magic')
  const version = view.getUint16(4, true)
  if (version !== VERSION) throw new Error(`weather cube: unsupported version ${version}`)

  const headerLength = view.getUint32(8, true)
  const header = JSON.parse(
    new TextDecoder().decode(new Uint8Array(buf, PREAMBLE_BYTES, headerLength)),
  ) as CubeHeader
  if (header.filter !== FILTER) throw new Error(`weather cube: unknown filter ${header.filter}`)

  const offset = bodyOffset(headerLength)
  const cells = header.ny * header.nx
  const plane = header.nt * cells
  const count = header.params.length * plane
  const bytes = new Uint8Array(buf, offset, count * 2)

  const data: Record<string, Float32Array> = {}
  const pred = new Int16Array(cells)
  let r = 0
  for (const param of header.params) {
    const scale = header.scale[param] ?? scaleFor(param)
    const out = new Float32Array(plane)
    pred.fill(0)
    for (let it = 0; it < header.nt; it++) {
      for (let i = 0; i < cells; i++) {
        // Un-shuffle and sign-extend.
        const raw = ((bytes[count + r] << 8) | bytes[r]) << 16 >> 16
        r++
        if (raw === header.missing) {
          // NaN, not 0 — a decoded hole must stay a hole all the way out.
          out[it * cells + i] = NaN
          continue
        }
        const q = pred[i] + raw
        pred[i] = q
        out[it * cells + i] = q * scale
      }
    }
    data[param] = out
  }

  return {
    model: header.model,
    run: header.run,
    bbox: header.bbox,
    nx: header.nx,
    ny: header.ny,
    dx: header.dx,
    dy: header.dy,
    t0: header.t0,
    dtMs: header.dtMs,
    nt: header.nt,
    params: header.params,
    data,
  }
}

/**
 * Exact encoded byte length, without building the buffer — so the offline pack
 * manager can price a download before committing to it.
 */
export function cubeSizeBytes(c: WeatherCube): number {
  const headerLength = new TextEncoder().encode(JSON.stringify(headerOf(c))).length
  return bodyOffset(headerLength) + c.params.length * c.nt * c.ny * c.nx * 2
}

// ------------------------------------------------------------- interpolation

const EPS = 1e-9
/** Half a millisecond of slack, so an exact end-of-range query counts as inside. */
const T_EPS = 0.5

/** Grid extent implied by the origin corner and the step — the real coverage. */
export function cubeCoverage(c: WeatherCube): { bbox: BBox; t0: Millis; t1: Millis } {
  return {
    bbox: {
      west: c.bbox.west,
      south: c.bbox.south,
      east: c.bbox.west + (c.nx - 1) * c.dx,
      north: c.bbox.south + (c.ny - 1) * c.dy,
    },
    t0: c.t0,
    t1: c.t0 + Math.max(0, c.nt - 1) * c.dtMs,
  }
}

/** Shift a longitude by whole turns to land inside [west, east], or give up. */
function normaliseLon(lon: number, west: number, east: number): number | null {
  if (lon >= west - EPS && lon <= east + EPS) return lon
  if (lon + 360 >= west - EPS && lon + 360 <= east + EPS) return lon + 360
  if (lon - 360 >= west - EPS && lon - 360 <= east + EPS) return lon - 360
  return null
}

/**
 * Scratch cell for `locate`. Reused deliberately: the routing kernel samples
 * fields millions of times per solve and this keeps that loop allocation-free.
 * Module-private, and never escapes — do not hand a reference to it out.
 */
const LOC = { i0: 0, j0: 0, k0: 0, fx: 0, fy: 0, ft: 0 }

/** Fill LOC with the cell and fractions for (lat, lon, t). False = out of coverage. */
function locate(c: WeatherCube, lat: number, lon: number, t: Millis): boolean {
  if (c.nx < 1 || c.ny < 1 || c.nt < 1) return false

  const cov = cubeCoverage(c)
  if (t < cov.t0 - T_EPS || t > cov.t1 + T_EPS) return false
  if (lat < cov.bbox.south - EPS || lat > cov.bbox.north + EPS) return false
  const lonN = normaliseLon(lon, cov.bbox.west, cov.bbox.east)
  if (lonN === null) return false

  const gx = c.dx > 0 ? (lonN - c.bbox.west) / c.dx : 0
  const gy = c.dy > 0 ? (lat - c.bbox.south) / c.dy : 0
  const gt = c.dtMs > 0 ? (t - c.t0) / c.dtMs : 0

  LOC.i0 = c.nx > 1 ? clamp(Math.floor(gx), 0, c.nx - 2) : 0
  LOC.j0 = c.ny > 1 ? clamp(Math.floor(gy), 0, c.ny - 2) : 0
  LOC.k0 = c.nt > 1 ? clamp(Math.floor(gt), 0, c.nt - 2) : 0
  LOC.fx = c.nx > 1 ? clamp(gx - LOC.i0, 0, 1) : 0
  LOC.fy = c.ny > 1 ? clamp(gy - LOC.j0, 0, 1) : 0
  LOC.ft = c.nt > 1 ? clamp(gt - LOC.k0, 0, 1) : 0
  return true
}

/**
 * Bilinear over one time slice. Missing corners are dropped and the remaining
 * weights renormalised, which degrades gracefully along a coastline where the
 * model has land cells; only an entirely missing neighbourhood returns null.
 */
function planeScalar(
  arr: Float32Array,
  nx: number,
  ny: number,
  k: number,
  i0: number,
  j0: number,
  fx: number,
  fy: number,
): number | null {
  const base = k * ny * nx
  let sum = 0
  let wsum = 0
  for (let dj = 0; dj <= 1; dj++) {
    const wy = dj === 0 ? 1 - fy : fy
    if (wy <= 0) continue
    const j = Math.min(ny - 1, j0 + dj)
    for (let di = 0; di <= 1; di++) {
      const wx = di === 0 ? 1 - fx : fx
      if (wx <= 0) continue
      const i = Math.min(nx - 1, i0 + di)
      const v = arr[base + j * nx + i]
      if (!Number.isFinite(v)) continue
      const w = wx * wy
      sum += w * v
      wsum += w
    }
  }
  return wsum > 0 ? sum / wsum : null
}

/**
 * Trilinear sample: bilinear in space, linear in time.
 * Returns null outside coverage or where the data has a hole — never a silent
 * zero (technical-spec.md §4).
 */
export function sampleCube(
  c: WeatherCube,
  param: string,
  lat: number,
  lon: number,
  t: Millis,
): number | null {
  const arr = c.data[param]
  if (!arr) return null
  if (!locate(c, lat, lon, t)) return null

  const a = planeScalar(arr, c.nx, c.ny, LOC.k0, LOC.i0, LOC.j0, LOC.fx, LOC.fy)
  if (a === null) return null
  if (LOC.ft <= 0) return a
  const b = planeScalar(arr, c.nx, c.ny, LOC.k0 + 1, LOC.i0, LOC.j0, LOC.fx, LOC.fy)
  // A missing time step is a real gap in the forecast, not a coastline hole:
  // do not paper over it by falling back to the neighbouring hour.
  if (b === null) return null
  return a + (b - a) * LOC.ft
}

/** Weighted sin/cos accumulator for circular interpolation. Module-private scratch. */
const DIR = { s: 0, c: 0 }

function planeDirection(
  arr: Float32Array,
  nx: number,
  ny: number,
  k: number,
  i0: number,
  j0: number,
  fx: number,
  fy: number,
): boolean {
  const base = k * ny * nx
  let s = 0
  let cc = 0
  let wsum = 0
  for (let dj = 0; dj <= 1; dj++) {
    const wy = dj === 0 ? 1 - fy : fy
    if (wy <= 0) continue
    const j = Math.min(ny - 1, j0 + dj)
    for (let di = 0; di <= 1; di++) {
      const wx = di === 0 ? 1 - fx : fx
      if (wx <= 0) continue
      const i = Math.min(nx - 1, i0 + di)
      const v = arr[base + j * nx + i]
      if (!Number.isFinite(v)) continue
      const w = wx * wy
      const r = toRad(v)
      s += w * Math.sin(r)
      cc += w * Math.cos(r)
      wsum += w
    }
  }
  if (wsum <= 0) return false
  DIR.s = s / wsum
  DIR.c = cc / wsum
  return true
}

/**
 * Circular interpolation of a bearing field.
 *
 * Wind and current never come through here — they are stored as u/v, which is
 * the whole point. But wave direction has no u/v slot in the agreed parameter
 * list, so it is interpolated on the unit circle instead. Arithmetic averaging
 * of 350° and 010° gives 180°, i.e. a swell running the wrong way.
 *
 * Note the caveat from how-it-computes.md §4: crossing swell trains are not
 * really interpolable at all. This is the least-wrong option, not a correct one.
 */
export function sampleCubeDirection(
  c: WeatherCube,
  param: string,
  lat: number,
  lon: number,
  t: Millis,
): Degrees | null {
  const arr = c.data[param]
  if (!arr) return null
  if (!locate(c, lat, lon, t)) return null

  if (!planeDirection(arr, c.nx, c.ny, LOC.k0, LOC.i0, LOC.j0, LOC.fx, LOC.fy)) return null
  let s = DIR.s
  let cc = DIR.c
  if (LOC.ft > 0) {
    if (!planeDirection(arr, c.nx, c.ny, LOC.k0 + 1, LOC.i0, LOC.j0, LOC.fx, LOC.fy)) return null
    s += (DIR.s - s) * LOC.ft
    cc += (DIR.c - cc) * LOC.ft
  }
  if (s === 0 && cc === 0) return null
  return wrap360(toDeg(Math.atan2(s, cc)))
}

/** Flat index of a grid node, matching the `Float32Array(nt*ny*nx)` layout. */
export function cubeIndex(c: WeatherCube, ix: number, iy: number, it: number): number {
  return (it * c.ny + iy) * c.nx + ix
}

/** Allocate an all-missing plane set for a cube under construction. */
export function emptyCubeData(params: string[], nt: number, ny: number, nx: number): Record<string, Float32Array> {
  const data: Record<string, Float32Array> = {}
  for (const p of params) {
    const a = new Float32Array(nt * ny * nx)
    a.fill(NaN)
    data[p] = a
  }
  return data
}
