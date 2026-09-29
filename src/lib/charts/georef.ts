/**
 * Placing a picture on the chart from control points, and shifting the
 * charts to line up with GPS.
 *
 * A north-up picture drawn on Mercator (most charts) or on plain latitude
 * and longitude (many weather charts) has longitude linear in its x, and
 * Mercator latitude, or latitude, linear in its y. Two points far apart fix
 * both lines; more are fitted by least squares, and how far they sit from the
 * fit says how good the placing is.
 */
import type { BBox, LatLon } from '../types'

export type ImageProjection = 'mercator' | 'latlon'

export interface ControlPoint {
  /** Pixel, from the top-left corner of the picture. */
  x: number
  y: number
  lat: number
  lon: number
}

const RAD = Math.PI / 180
const mercY = (lat: number) => Math.log(Math.tan(Math.PI / 4 + (lat * RAD) / 2))
const invMercY = (y: number) => (2 * Math.atan(Math.exp(y)) - Math.PI / 2) / RAD

function fit(u: number[], v: number[]): { a: number; b: number } | null {
  const n = u.length
  const mu = u.reduce((s, x) => s + x, 0) / n
  const mv = v.reduce((s, x) => s + x, 0) / n
  let suu = 0
  let suv = 0
  for (let i = 0; i < n; i++) {
    suu += (u[i] - mu) ** 2
    suv += (u[i] - mu) * (v[i] - mv)
  }
  if (suu < 1e-9) return null
  return { a: mv - (suv / suu) * mu, b: suv / suu }
}

/**
 * The picture's edges from its control points, and how far (RMS, pixels)
 * the points sit from the fit. Null when the points do not spread across
 * the picture both ways.
 */
export function boundsFromControlPoints(points: ControlPoint[], width: number, height: number, projection: ImageProjection = 'mercator'): { bbox: BBox; rmsPx: number } | null {
  if (points.length < 2 || !(width > 0) || !(height > 0)) return null
  const f = (lat: number) => (projection === 'mercator' ? mercY(lat) : lat)
  const g = (v: number) => (projection === 'mercator' ? invMercY(v) : v)
  const lon = fit(points.map((p) => p.x), points.map((p) => p.lon))
  const lat = fit(points.map((p) => p.y), points.map((p) => f(p.lat)))
  if (!lon || !lat || lon.b <= 0 || lat.b >= 0) return null
  let ss = 0
  for (const p of points) {
    const x = (p.lon - lon.a) / lon.b
    const y = (f(p.lat) - lat.a) / lat.b
    ss += (x - p.x) ** 2 + (y - p.y) ** 2
  }
  return {
    bbox: { west: lon.a, east: lon.a + lon.b * width, north: g(lat.a), south: g(lat.a + lat.b * height) },
    rmsPx: Math.sqrt(ss / points.length),
  }
}

// ------------------------------------------------------------ chart offset

export interface ChartOffset {
  /** Metres to move the charts north (negative, south). */
  northM: number
  /** Metres to move the charts east (negative, west). */
  eastM: number
}

export const NO_OFFSET: ChartOffset = { northM: 0, eastM: 0 }

const M_PER_DEG = 1852 * 60

/** The shift in degrees at a latitude. */
export function offsetDegrees(o: ChartOffset, atLat: number): { dLat: number; dLon: number } {
  return { dLat: o.northM / M_PER_DEG, dLon: o.eastM / (M_PER_DEG * Math.cos(atLat * RAD)) }
}

export function offsetPosition(p: LatLon, o: ChartOffset): LatLon {
  const d = offsetDegrees(o, p.lat)
  return { lat: p.lat + d.dLat, lon: p.lon + d.dLon }
}

type Coords = number[] | Coords[]

/**
 * GeoJSON features moved by the offset (one shift for all, at `atLat`, since
 * a chart's error is one shift across it). Features are copied, not changed.
 */
export function offsetFeatures<T extends { geometry: { type: string; coordinates: unknown } | null }>(features: T[], o: ChartOffset, atLat: number): T[] {
  if (!o.northM && !o.eastM) return features
  const { dLat, dLon } = offsetDegrees(o, atLat)
  const move = (c: Coords): Coords => (typeof c[0] === 'number' ? [(c[0] as number) + dLon, (c[1] as number) + dLat, ...(c as number[]).slice(2)] : (c as Coords[]).map(move))
  return features.map((f) => (f.geometry ? { ...f, geometry: { ...f.geometry, coordinates: move(f.geometry.coordinates as Coords) } } : f))
}

/** An image source's corners, [lon, lat] each, moved by the offset. */
export function offsetCorners<C extends Array<[number, number]>>(corners: C, o: ChartOffset): C {
  if (!o.northM && !o.eastM) return corners
  return corners.map(([lon, lat]) => {
    const p = offsetPosition({ lat, lon }, o)
    return [p.lon, p.lat]
  }) as C
}
