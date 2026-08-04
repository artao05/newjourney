/**
 * Thinning a vector field down to a readable symbol density, and turning it into
 * GeoJSON for a MapLibre symbol layer.
 *
 * Implements docs/07-map-layers/render-architecture.md §4: "Thin the grid to a
 * readable density per zoom level (target ~15-25 marks across the viewport,
 * re-thinned on zoom)." Both barbs and arrows consume the output of this file;
 * only the glyph differs.
 *
 * Three rules, all of them load-bearing:
 *
 *   1. **Never sample outside `bounds`.** Off-screen symbols cost GeoJSON bytes,
 *      parse time and collision work for nothing.
 *   2. **A gap stays a gap.** `sampleCube` returns `null` outside coverage or
 *      where the model has a hole, and this module drops those samples rather
 *      than emitting a zero-wind glyph. A calm arrow where there is no data is a
 *      lie a sailor cannot detect (docs/05-spec/technical-spec.md §4).
 *   3. **Both directions on every sample.** An arrow points the way the flow is
 *      going, a barb stem points into it. They differ by exactly 180°, so
 *      `VectorSample` carries both and the layer picks — rather than each layer
 *      re-deriving a convention that `src/lib/wind.ts` already owns and tests.
 */

import { uvToWind } from '@/lib/wind'
import { DEG, wrap360 } from '@/lib/angles'
import { cubeCoverage, sampleCube } from '@/lib/weather/cube'
import type { Millis, WeatherCube } from '@/lib/types'
import type { ThinOptions, VectorSample } from './types'

/**
 * Feature property names, so the thinning, the icon expression and the colour
 * expression cannot drift apart.
 *
 * - `kn`     magnitude, for `rampToMapLibreExpression` and `barbImageExpression`
 * - `fromDeg`  `icon-rotate` for a **barb** (stem points into the wind)
 * - `towardDeg` `icon-rotate` for an **arrow** (glyph points downwind)
 */
export const PROP_MAGNITUDE = 'kn'
export const PROP_FROM = 'fromDeg'
export const PROP_TOWARD = 'towardDeg'

/** One minute of latitude is one nautical mile; longitude shrinks by cos(lat). */
const MIN_PER_DEG = 60

/**
 * Slack on the bounds test. A node lon of 0.30000000000000004 is on screen even
 * when the caller's `bounds.east` is 0.3, and dropping the edge column of
 * symbols because of a float is a visible bug for an invisible reason.
 */
const EDGE_EPS = 1e-9

/**
 * Choose a grid stride so roughly `targetAcross` symbols span the viewport.
 *
 * Worked in nautical miles rather than degrees on purpose. A cube's `dx` and
 * `dy` are equal in degrees but not on the ground — at 60°N a 0.25° cell is half
 * as wide as it is tall — so striding by equal index counts would produce
 * symbols in tall thin columns. Converting through `cos(lat)` keeps the symbol
 * spacing square on screen, which is what "readable density" actually means.
 */
export function strideFor(
  cube: WeatherCube,
  opts: ThinOptions,
): { strideX: number; strideY: number } {
  const vis = visibleSpan(cube, opts)
  if (!vis) return { strideX: 1, strideY: 1 }

  const target = Math.max(1, Math.floor(opts.targetAcross))
  const cosLat = Math.max(0.05, Math.cos(vis.midLat * DEG))
  const widthNm = vis.spanLon * MIN_PER_DEG * cosLat
  const heightNm = vis.spanLat * MIN_PER_DEG
  // The shorter axis sets the density, so a landscape phone and a portrait one
  // show symbols the same size apart rather than the same number of them.
  const shorterNm = Math.max(1e-6, Math.min(widthNm, heightNm))
  const spacingNm = shorterNm / target

  const cellXNm = Math.max(1e-9, cube.dx * MIN_PER_DEG * cosLat)
  const cellYNm = Math.max(1e-9, cube.dy * MIN_PER_DEG)
  return {
    strideX: Math.max(1, Math.round(spacingNm / cellXNm)),
    strideY: Math.max(1, Math.round(spacingNm / cellYNm)),
  }
}

interface Span {
  west: number
  south: number
  east: number
  north: number
  spanLon: number
  spanLat: number
  midLat: number
}

/** Intersection of the requested bounds with the cube's real coverage. */
function visibleSpan(cube: WeatherCube, opts: ThinOptions): Span | null {
  if (cube.nx < 1 || cube.ny < 1 || cube.nt < 1) return null
  const cov = cubeCoverage(cube).bbox
  const west = Math.max(cov.west, Math.min(opts.bounds.west, opts.bounds.east))
  const east = Math.min(cov.east, Math.max(opts.bounds.west, opts.bounds.east))
  const south = Math.max(cov.south, Math.min(opts.bounds.south, opts.bounds.north))
  const north = Math.min(cov.north, Math.max(opts.bounds.south, opts.bounds.north))
  if (!(east >= west) || !(north >= south)) return null
  return {
    west,
    south,
    east,
    north,
    spanLon: east - west,
    spanLat: north - south,
    midLat: (north + south) / 2,
  }
}

/**
 * Thin a cube's vector field to a readable symbol density and sample it.
 *
 * Symbols land on cube grid nodes whose index is a multiple of the stride, not
 * on nodes counted from the left edge of the viewport. That is a small detail
 * with a large effect: anchoring to the grid means panning slides the symbols
 * with the map instead of reshuffling them under the cursor, and two layers over
 * the same cube (barbs and current arrows) land on the same nodes.
 *
 * `t` is a valid time, not a step index — `sampleCube` interpolates between
 * steps, so a scrubber sitting between two forecast hours still gets a field.
 */
export function thinVectorField(
  cube: WeatherCube,
  params: [string, string],
  t: Millis,
  opts: ThinOptions,
): VectorSample[] {
  const [uParam, vParam] = params
  if (!cube.data[uParam] || !cube.data[vParam]) return []
  const vis = visibleSpan(cube, opts)
  if (!vis) return []

  const { strideX, strideY } = strideFor(cube, opts)
  const out: VectorSample[] = []

  const i0 = cube.dx > 0 ? Math.max(0, Math.floor((vis.west - cube.bbox.west) / cube.dx)) : 0
  const i1 = cube.dx > 0 ? Math.min(cube.nx - 1, Math.ceil((vis.east - cube.bbox.west) / cube.dx)) : 0
  const j0 = cube.dy > 0 ? Math.max(0, Math.floor((vis.south - cube.bbox.south) / cube.dy)) : 0
  const j1 = cube.dy > 0 ? Math.min(cube.ny - 1, Math.ceil((vis.north - cube.bbox.south) / cube.dy)) : 0

  for (let j = Math.ceil(j0 / strideY) * strideY; j <= j1; j += strideY) {
    const lat = cube.bbox.south + j * cube.dy
    if (lat < vis.south - EDGE_EPS || lat > vis.north + EDGE_EPS) continue
    for (let i = Math.ceil(i0 / strideX) * strideX; i <= i1; i += strideX) {
      const lon = cube.bbox.west + i * cube.dx
      if (lon < vis.west - EDGE_EPS || lon > vis.east + EDGE_EPS) continue

      const u = sampleCube(cube, uParam, lat, lon, t)
      if (u === null) continue
      const v = sampleCube(cube, vParam, lat, lon, t)
      if (v === null) continue

      // Always through `uvToWind`: it owns the meteorological sign convention
      // and is unit-tested for it. `dirFrom` is where the flow comes from, so the
      // heading it is going is 180° round.
      const { dirFrom, speed } = uvToWind(u, v)
      out.push({
        lon,
        lat,
        towardDeg: wrap360(dirFrom + 180),
        fromDeg: dirFrom,
        magnitude: speed,
      })
    }
  }
  return out
}

/**
 * GeoJSON FeatureCollection ready for a MapLibre symbol source.
 *
 * Coordinates and angles are rounded: at 5 decimal places a position is good to
 * about a metre and an angle to a tenth of a degree, which is far below the
 * resolution of any forecast, and the rounding roughly halves the JSON the map
 * has to re-parse on every scrubber tick.
 */
export function vectorSamplesToFC(samples: VectorSample[]): unknown {
  return {
    type: 'FeatureCollection',
    features: samples.map((s) => ({
      type: 'Feature',
      properties: {
        [PROP_MAGNITUDE]: round(s.magnitude, 1),
        [PROP_TOWARD]: round(s.towardDeg, 1),
        [PROP_FROM]: round(s.fromDeg, 1),
      },
      geometry: {
        type: 'Point',
        coordinates: [round(s.lon, 5), round(s.lat, 5)],
      },
    })),
  }
}

function round(x: number, dp: number): number {
  const k = 10 ** dp
  return Math.round(x * k) / k
}
