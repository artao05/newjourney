/** The GRIB2 decoder on real GFS from NOMADS, run 2026-09-30 00Z, +6 h (fixtures/real). */
import { describe, expect, it } from 'vitest'
import { realFile } from '../../realFiles'
import { sampleCube } from './cube'
import { decodeGrib2, openGribSync, type GribMessage } from './grib2'

/** Each message's data representation template (section 5, octets 10–11). */
function templates(b: Uint8Array): number[] {
  const out: number[] = []
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength)
  for (let i = 0; i < b.length; ) {
    const len = Number(dv.getBigUint64(i + 8))
    for (let j = i + 16; j < i + len - 4; ) {
      const sl = dv.getUint32(j)
      if (b[j + 4] === 5) out.push(dv.getUint16(j + 9))
      j += sl
    }
    i += len
  }
  return out
}

const at = (m: GribMessage, lat: number, lon: number) => {
  const g = m.grid
  const j = g.scanMode & 64 ? Math.round((lat - g.la1) / g.dj) : Math.round((g.la1 - lat) / g.dj)
  const i = Math.round((((lon % 360) + 360) % 360 - g.lo1) / g.di)
  return m.values[j * g.ni + i]
}

describe('real GFS', () => {
  it('reads the 0.25° Portland subset: 10 m wind and MSLP, when and where NOMADS says', () => {
    const { messages } = decodeGrib2(realFile('gfs-portland-20260930-00z-f006.grb2'))
    expect(messages.map((m) => [m.name, m.levelType, m.levelValue])).toEqual([
      ['PRMSL', 101, 0],
      ['UGRD', 103, 10],
      ['VGRD', 103, 10],
    ])
    for (const m of messages) {
      expect(new Date(m.refTime).toISOString()).toBe('2026-09-30T00:00:00.000Z')
      expect(new Date(m.validTime).toISOString()).toBe('2026-09-30T06:00:00.000Z')
      expect(m.grid).toMatchObject({ ni: 21, nj: 21, la1: 41, lo1: 287.5, la2: 46, lo2: 292.5, di: 0.25, dj: 0.25 })
    }
    const [p, u, v] = messages.map((m) => [...m.values])
    expect(Math.min(...p) / 100).toBeGreaterThan(1010)
    expect(Math.max(...p) / 100).toBeLessThan(1025)
    for (let k = 0; k < u.length; k++) expect(Math.hypot(u[k], v[k])).toBeLessThan(20)
  })

  it("decodes NCEP's own complex packing exactly as NOAA's wgrib2 does", () => {
    const whole = realFile('gfs-global-1p00-20260930-00z-f006-prmsl-ugrd10.grb2')
    const sub = realFile('gfs-portland-1p00-20260930-00z-f006-subset.grb2')
    // The whole messages keep GFS's packing (5.3, complex with spatial differencing); NOMADS repacks the subset (5.0).
    expect(templates(whole)).toEqual([3, 3])
    expect(templates(sub)).toEqual([0, 0])
    const g = decodeGrib2(whole).messages
    const s = decodeGrib2(sub).messages
    expect(g.map((m) => [m.name, m.values.length])).toEqual([
      ['PRMSL', 360 * 181],
      ['UGRD', 360 * 181],
    ])
    for (const name of ['PRMSL', 'UGRD']) {
      const G = g.find((m) => m.name === name)!
      const S = s.find((m) => m.name === name)!
      expect(S.values.length).toBe(42)
      for (let j = 0; j < S.grid.nj; j++)
        for (let i = 0; i < S.grid.ni; i++) {
          const lat = S.grid.la1 + j * S.grid.dj
          const lon = S.grid.lo1 + i * S.grid.di
          expect(at(G, lat, lon), `${name} ${lat} ${lon}`).toBe(S.values[j * S.grid.ni + i])
        }
    }
    // And the whole globe is weather, not noise: MSLP everywhere between 940 and 1,060 hPa.
    const p = [...g[0].values]
    expect(p.every((x) => x > 94_000 && x < 106_000)).toBe(true)
  })

  it('opens as a forecast the router can use: knots and hPa at the grid point off Portland', () => {
    const file = realFile('gfs-portland-20260930-00z-f006.grb2')
    const [p, u] = decodeGrib2(file).messages
    const { cube, warnings, skipped } = openGribSync(file, { model: 'gfs' })
    expect([warnings, skipped]).toEqual([[], []])
    const t = Date.UTC(2026, 8, 30, 6)
    expect(sampleCube(cube!, 'prmsl', 43.5, -70.25, t)).toBeCloseTo(at(p, 43.5, -70.25) / 100, 3)
    expect(sampleCube(cube!, 'u10', 43.5, -70.25, t)).toBeCloseTo(at(u, 43.5, -70.25) * 1.943844, 2)
  })
})
