/**
 * @vitest-environment jsdom
 */

import { describe, expect, it } from 'vitest'
import { LogImportError, importCsvLog, importLog, importNmeaLog, parseLogTime } from './importLog'
import { logToCsv, type LogRow } from './logger'
import { withChecksum } from '@/lib/instruments/nmea0183'

describe('CSV logs', () => {
  it('reads back what the logger exports', () => {
    const rows: LogRow[] = [
      { t: Date.UTC(2026, 8, 29, 10), v: { twd: 250, bsp: 6.2 } },
      { t: Date.UTC(2026, 8, 29, 10, 0, 1), v: { bsp: 6.3 } },
    ]
    expect(importCsvLog(logToCsv(rows))).toMatchObject({ kind: 'csv', rows, skipped: 0, unknownColumns: [] })
  })

  it('takes spreadsheet days as the time, and channel names in any case', () => {
    const csv = '!Boat,Utc,BSP,awa,TWS,Load\n0,46294.4166666667,6.2,-31.5,12.1,1500\n0,46294.4166782407,6.3,-31,12\n'
    const got = importCsvLog(csv)
    expect(got.rows).toHaveLength(2)
    expect(got.rows[0].t).toBe(Date.UTC(2026, 8, 29, 10))
    expect(got.rows[0].v).toEqual({ bsp: 6.2, awa: -31.5, tws: 12.1 })
    expect(got.unknownColumns).toEqual(['Boat', 'Load'])
  })

  it('counts rows it cannot read, and says what is missing from a header', () => {
    const got = importCsvLog('Time,Bsp\n2026-09-29T10:00:00Z,6\nyesterday,6\n2026-09-29T10:00:02Z,\n')
    expect(got.rows).toHaveLength(1)
    expect(got.skipped).toBe(2)
    expect(() => importCsvLog('Bsp,Awa\n6,30')).toThrow(/No time column/)
    expect(() => importCsvLog('Utc,Load\n2026-09-29T10:00:00Z,1')).toThrow(LogImportError)
  })

  it('reads quoted cells', () => {
    expect(importCsvLog('Utc,"Bsp"\n"2026-09-29T10:00:00Z","6.5"').rows[0].v).toEqual({ bsp: 6.5 })
  })

  it('knows spreadsheet days from ISO text', () => {
    expect(parseLogTime('25569')).toBeNaN()
    expect(parseLogTime('25570')).toBe(86_400_000)
    expect(parseLogTime('2026-09-29T10:00:00Z')).toBe(Date.UTC(2026, 8, 29, 10))
  })
})

describe('NMEA recordings', () => {
  it('makes a row each second the clock moves, with the latest of everything', () => {
    const text = [
      withChecksum('GPRMC,100000,A,4339.546,N,07014.808,W,6.0,210.0,290926,14.5,W'),
      withChecksum('IIMWV,330.0,R,15.0,N,A'),
      withChecksum('IIVHW,,T,,M,6.3,N,,K'),
      withChecksum('GPRMC,100001,A,4339.540,N,07014.812,W,6.1,211.0,290926,14.5,W'),
      '$GPRMC,bad*01',
      withChecksum('GPRMC,100001,A,4339.540,N,07014.812,W,6.1,211.0,290926,14.5,W'),
    ].join('\r\n')
    const got = importNmeaLog(text)
    expect(got.rows.map((r) => r.t)).toEqual([Date.UTC(2026, 8, 29, 10), Date.UTC(2026, 8, 29, 10, 0, 1)])
    expect(got.rows[0].v).toMatchObject({ sog: 6, cog: 210, 'magnetic-variation': -14.5 })
    expect(got.rows[1].v).toMatchObject({ sog: 6.1, awa: -30, aws: 15, bsp: 6.3 })
    expect(got.rows[0].v.latitude).toBeCloseTo(43 + 39.546 / 60, 9)
    expect(got.skipped).toBe(1)
  })

  it('refuses a recording with no clock in it', () => {
    expect(() => importNmeaLog(withChecksum('IIMWV,330.0,R,15.0,N,A'))).toThrow(/RMC or ZDA/)
  })
})

describe('choosing the reader', () => {
  const gpx = `<?xml version="1.0"?><gpx version="1.1"><trk><trkseg>
    <trkpt lat="43.66" lon="-70.25"><time>2026-09-29T10:00:00Z</time></trkpt>
    <trkpt lat="43.661" lon="-70.25"><time>2026-09-29T10:00:10Z</time></trkpt>
    <trkpt lat="43.662" lon="-70.25"></trkpt>
  </trkseg></trk></gpx>`

  it('reads GPX tracks, with the speed and course between points', () => {
    const got = importLog('race.gpx', gpx)
    expect(got.kind).toBe('gpx')
    expect(got.rows).toHaveLength(2)
    expect(got.rows[1].v.latitude).toBe(43.661)
    expect(got.rows[1].v.cog).toBeCloseTo(0, 0)
    expect(got.skipped).toBe(1)
  })

  it('tells NMEA from CSV by the first line', () => {
    const zda = withChecksum('GPZDA,100000.00,29,09,2026,00,00')
    expect(importLog('log.txt', `${zda}\n${withChecksum('IIHDT,10.0,T')}`).kind).toBe('nmea')
    expect(importLog('log.txt', 'Utc,Bsp\n2026-09-29T10:00:00Z,6').kind).toBe('csv')
  })
})
