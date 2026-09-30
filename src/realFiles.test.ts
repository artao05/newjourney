/**
 * The real files in fixtures/real (see its SOURCES.md) open with our own
 * readers. Deeper checks on each live beside its module.
 */
import { describe, expect, it } from 'vitest'
import { groupCellFiles } from './lib/charts/library'
import { decodeS57 } from './lib/charts/s57'
import { decodeBsb } from './lib/charts/bsb'
import { readZip } from './lib/zip'
import { decodeGrib2 } from './lib/weather/grib2'
import { parseHarcon } from './lib/tides/harmonic'
import { parseDatums } from './lib/tides/stations'
import { realFile, realText } from './realFiles'

describe('the real files open', () => {
  it('GFS from NOMADS: the filtered subsets and the whole global messages', () => {
    for (const [name, count] of [
      ['gfs-portland-20260930-00z-f006.grb2', 3],
      ['gfs-global-1p00-20260930-00z-f006-prmsl-ugrd10.grb2', 2],
      ['gfs-portland-1p00-20260930-00z-f006-subset.grb2', 2],
    ] as const) {
      const { messages, skipped } = decodeGrib2(realFile(name))
      expect(skipped, name).toEqual([])
      expect(messages.length, name).toBe(count)
    }
  })

  it('the Portland ENC cell, zipped as NOAA ships it, with its update', () => {
    const { cells } = groupCellFiles([{ name: 'US5PWMDC.zip', bytes: realFile('US5PWMDC.zip') }])
    expect(cells.map((c) => [c.name, c.updates.map((u) => u.n)])).toEqual([['US5PWMDC', [1]]])
    const cell = decodeS57(cells[0].base!, cells[0].updates.map((u) => u.bytes))
    expect(cell.warnings).toEqual([])
    expect(cell.features.length).toBeGreaterThan(1000)
  })

  it('the archived NOAA raster chart', () => {
    const kap = readZip(realFile('RNC-14983.zip')).find((e) => /\.kap$/i.test(e.name))!
    const chart = decodeBsb(kap.bytes)
    expect([chart.width, chart.height]).toEqual([5622, 4863])
    expect(chart.warnings).toEqual([])
  })

  it('the WMM-2025 coefficients: 90 Gauss coefficient rows to degree 12', () => {
    const rows = realText('WMM2025.COF').split(/\r?\n/).filter((l) => /^\s*\d+\s+\d+\s+-?\d/.test(l))
    expect(realText('WMM2025.COF')).toMatch(/^\s*2025\.0\s+WMM-2025/)
    expect(rows.length).toBe(90)
  })

  it("NOAA's Portland constants, datums and a week of its predictions", () => {
    expect(parseHarcon(JSON.parse(realText('coops-8418150-harcon.json'))).length).toBe(37)
    expect(parseDatums(JSON.parse(realText('coops-8418150-datums.json')))).toHaveProperty('MLLW')
    expect(JSON.parse(realText('coops-8418150-predictions-20261001-07.json')).predictions.length).toBe(7 * 24)
  })
})
