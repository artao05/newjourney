import { describe, expect, it } from 'vitest'
import { bestRun, findManoeuvres, performanceReport } from './analysis'
import { destination } from '../geo'
import type { LogRow } from './logger'

const T0 = Date.UTC(2026, 8, 29, 12)

/**
 * A logged session, a row a second: 10 min beating on starboard at VMG 5 kn,
 * a tack at 600 s that drops VMG to 2 kn for 10 s, 10 min on port, then a run
 * from 1200 s with a gybe at 1800 s, the same dip. Moving north at 6 kn.
 */
function session(): LogRow[] {
  const rows: LogRow[] = []
  let at = { lat: 43.6, lon: -70.2 }
  for (let s = 0; s < 2400; s++) {
    const beat = s < 1200
    // Beat on starboard, tack to port, bear away on port, gybe to starboard.
    const twa = beat ? (s < 600 ? 42 : -42) : s < 1800 ? -150 : 150
    const inDip = (s >= 600 && s < 610) || (s >= 1800 && s < 1810)
    const vmg = (beat ? 5 : -6) * (inDip ? 0.4 : 1)
    rows.push({ t: T0 + s * 1000, v: { twa, vmg, sog: 6, tws: 12, 'polar-bsp-pct': 95, 'vmg-pct': 90, latitude: at.lat, longtitude: at.lon } })
    at = destination(at, 0, 6 / 3600)
  }
  return rows
}

describe('log analysis', () => {
  it('finds the tack and the gybe, and what each cost', () => {
    const m = findManoeuvres(session())
    expect(m.map((x) => [x.kind, (x.t - T0) / 1000])).toEqual([
      ['tack', 600],
      ['gybe', 1800],
    ])
    // 10 s at 3 kn short of 5 kn: 30 kn·s, 15.43 m; worth 6 s at 5 kn.
    expect(m[0].lossM).toBeCloseTo((30 * 1852) / 3600, 6)
    expect(m[0].lossS).toBeCloseTo(6, 6)
    // Downwind: 10 s at 3.6 kn short of 6 kn: worth 6 s too.
    expect(m[1].lossS).toBeCloseTo(6, 6)
  })

  it('does not count a wobble through the wind as a second tack', () => {
    const rows = session().map((r) => {
      const s = (r.t - T0) / 1000
      return s >= 605 && s < 612 ? { ...r, v: { ...r.v, twa: s % 2 ? 5 : -5 } } : r
    })
    expect(findManoeuvres(rows).filter((m) => m.kind === 'tack')).toHaveLength(1)
  })

  it('finds the best 24-hour run across days, leaving out a bad fix', () => {
    // 30 hours at 6 kn, a fix every minute, one of them 100 nm out.
    const rows: LogRow[] = []
    let at = { lat: 40, lon: -60 }
    for (let m = 0; m <= 30 * 60; m++) {
      const bad = m === 500
      const p = bad ? destination(at, 90, 100) : at
      rows.push({ t: T0 + m * 60_000, v: { latitude: p.lat, longtitude: p.lon } })
      at = destination(at, 45, 0.1)
    }
    const b = bestRun(rows)!
    expect(b.nm).toBeCloseTo(144, 1)
    expect((b.to - b.from) / 3_600_000).toBeCloseTo(24, 6)
    expect(bestRun(rows.slice(0, 1))).toBeNull()
  })

  it('sums the session up', () => {
    const r = performanceReport(session())
    expect(r.durationS).toBe(2399)
    expect(r.distanceNm).toBeCloseTo((6 * 2399) / 3600, 3)
    expect(r).toMatchObject({ tacks: 1, gybes: 1, meanSog: 6, maxSog: 6, meanTws: 12, meanPolarPct: 95, meanVmgPct: 90, upwindPct: 50, reachingPct: 0, downwindPct: 50 })
    expect(r.meanTackLossS).toBeCloseTo(6, 6)
  })
})
