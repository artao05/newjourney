/**
 * Venue bathymetry — the water-depth layer's data.
 *
 * A companion to `landmask.ts` and deliberately separate from it. The land mask
 * answers "may the router cross this cell", a binary question at 111 m. This
 * answers "how much water is under the boat", a continuous question at 450 m,
 * and the two must never be confused: **this is a display layer, not a depth
 * check**, and the router does not consult it.
 *
 * ## How it was built
 *
 * `scripts/build-depth-grid.mjs` fetches a GEBCO_2020 subset for the venue from
 * NOAA CoastWatch ERDDAP and packs it as raw Int16 decimetres of elevation above
 * mean sea level, positive up, row-major, rows south-to-north and columns
 * west-to-east — the same axis order as `WeatherCube` and the land mask. The
 * script is committed because the asset is a derivative of someone else's data
 * and the recipe has to stay reproducible.
 *
 * GEBCO rather than NOAA ENC because ENC depth extraction is a v1 job
 * (docs/02-data-sources/charts-and-bathymetry.md §1) and GEBCO is the source the
 * venue already declares for "coarse bathymetry display" in `venues.ts`.
 *
 * ## Validation
 *
 * Every value was cross-checked against an independent GEBCO server
 * (api.opentopodata.org, `gebco2020`) at nine spread points: six agreed exactly,
 * two to 1 m, and one — the venue centre, on the steep edge of a small island —
 * to 6 m, which is nearest-cell disagreement between two grid alignments rather
 * than a packing error. All four moored stations in `venues.ts` read as water,
 * two inland towns read as land, and the grid's water fraction of 44.7% agrees
 * with the land mask's independently derived 44.1% water.
 *
 * ## What this data is not
 *
 * Three limits, all measured, all surfaced in the UI rather than buried here:
 *
 *   1. **Accuracy.** At NDBC buoy 44007 (43.525 N, 70.140 W) GEBCO reads 31 m
 *      where NOAA publishes a 49 m water depth — 18 m out, at a position known
 *      to a metre. A 450 m model interpolated over sparse soundings is not a
 *      survey.
 *   2. **Datum.** GEBCO is referenced to mean sea level; charts are referenced
 *      to a low-water datum. At Portland station 8418150, MSL sits 4.94 ft
 *      (1.51 m) above MLLW, so at low water there is about a metre and a half
 *      *less* water than this layer shows.
 *   3. **Small features.** The venue centre is a real island the land mask
 *      resolves and GEBCO calls 10 m of water. Anything narrower than a cell —
 *      ledges, rocks, jetties, dredged channels — is simply not in here.
 *
 * GEBCO's own metadata says it plainly, and we repeat it verbatim in
 * `DEPTH_NOT_FOR_NAVIGATION`.
 *
 * ## Licence
 *
 * GEBCO grids are published for free public use with attribution. Unlike the
 * land mask this is not OSM-derived, so no share-alike obligation attaches —
 * see docs/02-data-sources/licensing-matrix.md.
 */

import type { BBox, Metres, WeatherCube } from '@/lib/types'

export interface DepthGridMeta {
  /**
   * Extent of the cell *centres*, matching `WeatherCube.bbox`, so the first
   * stored row sits exactly on `south` rather than half a cell below it.
   */
  bbox: BBox
  nx: number
  ny: number
  /** Cell size in degrees, for both axes. */
  cellDeg: number
  /** Fraction of cells below mean sea level, for a sanity check after loading. */
  waterFraction: number
  url: string
  attribution: string
}

/** Int16 sentinel for a cell GEBCO has no value for. Matches the cube's MISSING. */
export const DEPTH_MISSING = -32768

/** GEBCO_2020's own caveat, verbatim from the grid's metadata. */
export const DEPTH_NOT_FOR_NAVIGATION =
  'The data in the GEBCO_2020 Grid should not be used for navigation or any purpose relating to safety at sea.'

/**
 * Height of mean sea level above MLLW at NOAA station 8418150 (Portland, ME),
 * 1983-2001 epoch: 13.49 ft MSL − 8.55 ft MLLW = 4.94 ft.
 *
 * GEBCO depths are below MSL, charted depths are below MLLW, and the difference
 * is the wrong way round for a keel: subtract this to get something comparable
 * to a chart. Not applied to the displayed field — one station's datum offset is
 * not a bay-wide correction — but stated wherever the depth is shown.
 */
export const PORTLAND_MSL_ABOVE_MLLW_M = 1.51

export const PORTLAND_DEPTH_GRID: DepthGridMeta = {
  // The land mask's box, not the venue forecast box: a depth layer that stopped
  // short of the visible chart edge would read as "no data" over real water, and
  // sharing an extent lets the two venue assets be checked against each other.
  bbox: {
    west: -70.54791666666667,
    south: 43.381249999999994,
    east: -69.79791666666667,
    north: 43.95208333333332,
  },
  nx: 181,
  ny: 138,
  /** GEBCO's native 15 arc-second step, written exactly. */
  cellDeg: 1 / 240,
  waterFraction: 0.4468,
  // Relative so it resolves under the app's base path when deployed to a subpath.
  url: './venue/portland-depth.bin',
  attribution: 'Bathymetry: GEBCO 2020 Grid (GEBCO Compilation Group)',
}

/** Int16 per cell, so the byte length is fully determined by the grid. */
export function expectedDepthBytes(meta: DepthGridMeta): number {
  return meta.nx * meta.ny * 2
}

export interface LoadedDepthGrid {
  meta: DepthGridMeta
  /** Elevation above MSL in decimetres, positive up. `DEPTH_MISSING` for no data. */
  elevDm: Int16Array
}

let cached: Promise<LoadedDepthGrid> | null = null

/**
 * Fetch and decode the venue depth grid. Cached for the session.
 *
 * Rejects rather than degrading on a wrong-sized payload, for the same reason
 * the land mask does: a truncated grid reads as valid data past the truncation
 * point, and here that would mean a confident depth colour over water nobody
 * has any figure for.
 */
export function loadVenueDepthGrid(
  meta: DepthGridMeta = PORTLAND_DEPTH_GRID,
): Promise<LoadedDepthGrid> {
  if (cached) return cached
  cached = (async () => {
    const res = await fetch(meta.url)
    if (!res.ok) throw new Error(`depth grid ${meta.url}: HTTP ${res.status}`)
    const buf = await res.arrayBuffer()
    const want = expectedDepthBytes(meta)
    if (buf.byteLength !== want) {
      throw new Error(`depth grid is ${buf.byteLength} bytes, expected ${want}`)
    }
    return { meta, elevDm: new Int16Array(buf) }
  })().catch((e) => {
    // Do not cache a failure: a flaky first load should be retryable.
    cached = null
    throw e
  })
  return cached
}

/** Fraction of cells below mean sea level, to verify a freshly loaded grid. */
export function waterFractionOf(elevDm: Int16Array): number {
  let water = 0
  for (let i = 0; i < elevDm.length; i++) {
    const v = elevDm[i]
    if (v !== DEPTH_MISSING && v < 0) water++
  }
  return water / elevDm.length
}

/** Depth in metres below MSL at a stored cell, or null where the cell is not water. */
function cellDepth(g: LoadedDepthGrid, ix: number, iy: number): number | null {
  const v = g.elevDm[iy * g.meta.nx + ix]
  if (v === DEPTH_MISSING || v >= 0) return null
  return -v / 10
}

/**
 * Bilinear depth in metres below MSL, or null outside the grid and over land.
 *
 * Missing corners are dropped and the remaining weights renormalised, exactly as
 * `sampleCube` does, so a position one cell off the beach still gets a depth
 * instead of a hole. All four corners dry means land, and land means null —
 * never 0, which would read as "awash" rather than "no water here".
 */
export function depthAt(g: LoadedDepthGrid, lat: number, lon: number): Metres | null {
  const { bbox, nx, ny, cellDeg } = g.meta
  const gx = (lon - bbox.west) / cellDeg
  const gy = (lat - bbox.south) / cellDeg
  if (!(gx >= -0.5) || !(gy >= -0.5) || gx > nx - 0.5 || gy > ny - 0.5) return null

  const i0 = Math.max(0, Math.min(nx - 2, Math.floor(gx)))
  const j0 = Math.max(0, Math.min(ny - 2, Math.floor(gy)))
  const fx = Math.max(0, Math.min(1, gx - i0))
  const fy = Math.max(0, Math.min(1, gy - j0))

  let sum = 0
  let wsum = 0
  for (let dj = 0; dj <= 1; dj++) {
    const wy = dj === 0 ? 1 - fy : fy
    if (wy <= 0) continue
    for (let di = 0; di <= 1; di++) {
      const wx = di === 0 ? 1 - fx : fx
      if (wx <= 0) continue
      const d = cellDepth(g, Math.min(nx - 1, i0 + di), Math.min(ny - 1, j0 + dj))
      if (d === null) continue
      const w = wx * wy
      sum += w * d
      wsum += w
    }
  }
  return wsum > 0 ? sum / wsum : null
}

/** Cube parameter name the depth layer draws. */
export const DEPTH_PARAM = 'depth'

/**
 * The depth grid wrapped as a single-step `WeatherCube`, for the renderer only.
 *
 * Depth is static, so this is a degenerate cube: `nt` is 1 and `dtMs` is 0.
 * Wrapping it buys the whole tested `ScalarLayer` path — Mercator-corrected
 * mesh, 16-bit encoding, LUT lookup, coverage mask — for a static field, instead
 * of a second renderer that would drift out of step with the first.
 *
 * **Do not sample this with `sampleCube`.** With `nt` 1 and `t0` 0 every query at
 * a real clock time falls outside coverage and returns null. `depthAt` is the
 * sampler for this data; `timeIndices` short-circuits on `nt <= 1`, which is what
 * makes the render path safe.
 *
 * Land cells are NaN so the shader discards them and the coastline stays visible.
 * The cost is that LINEAR filtering blends a coastal cell against a land cell's
 * unset value, which biases the outermost half-cell of the wash *shallow* — a
 * thin conservative fringe along the shore, in water GEBCO already puts in the
 * shallowest bands.
 */
export function depthRenderCube(g: LoadedDepthGrid): WeatherCube {
  const { bbox, nx, ny, cellDeg, attribution } = g.meta
  const depth = new Float32Array(nx * ny)
  for (let i = 0; i < depth.length; i++) {
    const v = g.elevDm[i]
    depth[i] = v === DEPTH_MISSING || v >= 0 ? NaN : -v / 10
  }
  return {
    model: 'gebco2020',
    run: attribution,
    bbox,
    nx,
    ny,
    dx: cellDeg,
    dy: cellDeg,
    t0: 0,
    dtMs: 0,
    nt: 1,
    params: [DEPTH_PARAM],
    data: { [DEPTH_PARAM]: depth },
  }
}
