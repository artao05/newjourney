import { describe, expect, it } from 'vitest'
import { estimateBytes, roundedArea, saildocsMailto, saildocsQuery, timesSpec, type GribRequest } from './gribRequest'

const req: GribRequest = {
  model: 'gfs',
  bbox: { west: -71.3, south: 42.8, east: -68.2, north: 44.9 },
  res: 0.5,
  hours: 72,
  stepH: 3,
  params: ['WIND', 'PRESS'],
}

describe('a GRIB request by email', () => {
  it('rounds the area out to whole cells', () => {
    expect(roundedArea(req.bbox, 0.5)).toEqual({ south: 42.5, north: 45, west: -71.5, east: -68 })
    expect(roundedArea({ west: 170.2, south: -35.3, east: 178.9, north: -30.1 }, 1)).toEqual({ south: -36, north: -30, west: 170, east: 179 })
  })

  it('writes the times as a range', () => {
    expect(timesSpec(72, 3)).toBe('0,3..72')
    expect(timesSpec(100, 12)).toBe('0,12..96')
    expect(timesSpec(6, 6)).toBe('0,6')
  })

  it('writes the Saildocs query, with hemispheres, and the mail to send it in', () => {
    expect(saildocsQuery(req)).toBe('send gfs:42.5N,45N,71.5W,68W|0.5,0.5|0,3..72|WIND,PRESS')
    expect(saildocsQuery({ ...req, bbox: { west: 170.2, south: -35.3, east: 178.9, north: -30.1 }, res: 1 })).toBe('send gfs:36S,30S,170E,179E|1,1|0,3..72|WIND,PRESS')
    const m = saildocsMailto(req)
    expect(m.startsWith('mailto:query@saildocs.com?subject=GRIB%20request&body=')).toBe(true)
    expect(decodeURIComponent(m.split('body=')[1])).toBe(saildocsQuery(req))
  })

  it('estimates the size: points, times and fields', () => {
    // 6 × 8 points, 25 times, wind (2 fields) and pressure (1).
    expect(estimateBytes(req)).toBe(Math.round(25 * 3 * (48 * 1.5 + 120)))
    // Over an ocean-sized area, where the points outweigh the headers, halving the spacing about quadruples it.
    const ocean = { ...req, bbox: { west: -70, south: 30, east: -50, north: 50 } }
    expect(estimateBytes({ ...ocean, res: 0.25 }) / estimateBytes(ocean)).toBeGreaterThan(3.5)
  })
})
