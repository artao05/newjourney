/**
 * A GRIB request: an area, a model, a grid, times and parameters, written as a
 * Saildocs query ("send model:area|grid|times|parameters" to query@saildocs.com)
 * with an estimate of the file that comes back. The GRIB that is emailed back
 * opens under Weather → GRIB files.
 *
 * The model and parameter names follow Saildocs' published help; check them
 * against its own reply to an email to info@saildocs.com before relying on a
 * rarely used one.
 */
import type { BBox } from '../types'

export interface SaildocsModel {
  id: string
  label: string
  params: string[]
  maxHours: number
}

export const SAILDOCS_MODELS: SaildocsModel[] = [
  { id: 'gfs', label: 'GFS (NOAA)', params: ['WIND', 'PRESS', 'GUST', 'RAIN', 'AIRTMP'], maxHours: 384 },
  { id: 'ecmwf', label: 'ECMWF', params: ['WIND', 'PRESS'], maxHours: 240 },
  { id: 'icon', label: 'ICON (DWD)', params: ['WIND', 'PRESS', 'RAIN'], maxHours: 180 },
  { id: 'rtofs', label: 'RTOFS currents', params: ['CURRENT'], maxHours: 192 },
]

export interface GribRequest {
  model: string
  bbox: BBox
  /** Grid spacing, degrees. */
  res: number
  hours: number
  stepH: number
  params: string[]
}

const lat = (v: number) => `${+Math.abs(v).toFixed(2)}${v < 0 ? 'S' : 'N'}`
const lon = (v: number) => `${+Math.abs(v).toFixed(2)}${v < 0 ? 'W' : 'E'}`

/** The area rounded out to whole grid cells, so the file covers all of it. */
export function roundedArea(b: BBox, res: number): BBox {
  const out = (v: number, up: boolean) => (up ? Math.ceil(v / res - 1e-9) : Math.floor(v / res + 1e-9)) * res
  return { south: out(b.south, false), north: out(b.north, true), west: out(b.west, false), east: out(b.east, true) }
}

/** The times: 0 and every step to the last, as "0,3..72". */
export function timesSpec(hours: number, stepH: number): string {
  const last = Math.floor(hours / stepH) * stepH
  return last <= stepH ? `0,${last}` : `0,${stepH}..${last}`
}

export function saildocsQuery(r: GribRequest): string {
  const a = roundedArea(r.bbox, r.res)
  return `send ${r.model}:${lat(a.south)},${lat(a.north)},${lon(a.west)},${lon(a.east)}|${r.res},${r.res}|${timesSpec(r.hours, r.stepH)}|${r.params.join(',')}`
}

export function saildocsMailto(r: GribRequest): string {
  return `mailto:query@saildocs.com?subject=${encodeURIComponent('GRIB request')}&body=${encodeURIComponent(saildocsQuery(r))}`
}

/**
 * About how big the file will be: each field at each time is a GRIB message of
 * a header and about 1.5 bytes a grid point. Wind and current are two fields
 * each (u and v). An estimate, to size a download over a satellite link.
 */
export function estimateBytes(r: GribRequest): number {
  const a = roundedArea(r.bbox, r.res)
  const points = (Math.round((a.north - a.south) / r.res) + 1) * (Math.round((a.east - a.west) / r.res) + 1)
  const steps = Math.floor(r.hours / r.stepH) + 1
  const fields = r.params.reduce((n, p) => n + (p === 'WIND' || p === 'CURRENT' ? 2 : 1), 0)
  return Math.round(steps * fields * (points * 1.5 + 120))
}
