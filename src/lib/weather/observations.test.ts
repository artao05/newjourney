import { describe, expect, it } from 'vitest'
import { parseCoops, parseMetar, parseMetars, parseNdbc } from './observations'

const KN = 1.9438445

describe('NDBC buoy reports', () => {
  const text = [
    '#YY  MM DD hh mm WDIR WSPD GST  WVHT   DPD   APD MWD   PRES  ATMP  WTMP  DEWP  VIS PTDY  TIDE',
    '#yr  mo dy hr mn degT m/s  m/s     m   sec   sec degT   hPa  degC  degC  degC  nmi  hPa    ft',
    '2026 09 29 14 50 200  6.0  8.0   0.9     6   4.8 190 1016.2  15.1  14.8  12.0   MM   MM    MM',
    '2026 09 29 14 40 190  5.0   MM    MM    MM    MM  MM 1016.4  15.0  14.8  11.9   MM -0.6    MM',
  ].join('\n')

  it('reads each row in knots and hPa, oldest first, with MM as missing', () => {
    const o = parseNdbc(text, '44007')
    expect(o.map((x) => x.t)).toEqual([Date.UTC(2026, 8, 29, 14, 40), Date.UTC(2026, 8, 29, 14, 50)])
    expect(o[1]).toMatchObject({ source: 'ndbc', station: '44007', twd: 200, hs: 0.9, period: 6, pres: 1016.2, airTemp: 15.1, seaTemp: 14.8, dewPoint: 12, visNm: null })
    expect(o[1].tws).toBeCloseTo(6 * KN, 6)
    expect(o[1].gust).toBeCloseTo(8 * KN, 6)
    expect(o[0].gust).toBeNull()
    expect(o[0].hs).toBeNull()
  })

  it('reads nothing from a page that is not a buoy file', () => {
    expect(parseNdbc('<html>Not found</html>', 'x')).toEqual([])
  })
})

describe('METARs', () => {
  const REF = Date.UTC(2026, 8, 29, 16)

  it('reads wind, gust, visibility, temperature and pressure, with the remarks to a tenth', () => {
    const o = parseMetar('KPWM 291451Z 20012G20KT 10SM FEW250 16/11 A3002 RMK AO2 SLP165 T01560111', REF)!
    expect(o).toMatchObject({ source: 'metar', station: 'KPWM', t: Date.UTC(2026, 8, 29, 14, 51), twd: 200, tws: 12, gust: 20, airTemp: 15.6, dewPoint: 11.1 })
    expect(o.pres).toBeCloseTo(1016.5, 6)
    expect(o.visNm).toBeCloseTo(10 * 0.868976, 6)
    expect(o.raw).toMatch(/^KPWM 291451Z/)
  })

  it('reads the rest of the world too: metres per second, metres of visibility, Q pressure, below zero', () => {
    const o = parseMetar('METAR EGLL 290950Z 25008MPS 9999 BKN012 M02/M05 Q0998', REF)!
    expect(o.tws).toBeCloseTo(8 * KN, 6)
    expect(o.twd).toBe(250)
    expect(o.visNm).toBeCloseTo(9999 / 1852, 6)
    expect([o.airTemp, o.dewPoint, o.pres]).toEqual([-2, -5, 998])
  })

  it('reads calm and variable winds, fractions of a mile, and a report from last month', () => {
    expect(parseMetar('KBOS 291454Z 00000KT 1 1/2SM BR OVC004 12/12 A2990', REF)).toMatchObject({ twd: null, tws: 0 })
    expect(parseMetar('KBOS 291454Z 00000KT 1 1/2SM BR OVC004 12/12 A2990', REF)!.visNm).toBeCloseTo(1.5 * 0.868976, 6)
    expect(parseMetar('KBOS 291454Z VRB03KT M1/4SM FG 12/12 A2990', REF)).toMatchObject({ twd: null, tws: 3 })
    expect(parseMetar('KBOS 300054Z VRB03KT 10SM 12/12 A2990', Date.UTC(2026, 9, 1, 2))!.t).toBe(Date.UTC(2026, 8, 30, 0, 54))
    expect(parseMetar('KBOS 312354Z 18005KT 10SM 12/12 A2990', Date.UTC(2026, 9, 1, 0, 30))!.t).toBe(Date.UTC(2026, 9 - 1, 31, 23, 54))
    expect(parseMetar('not a metar', REF)).toBeNull()
  })

  it('reads a list, oldest first', () => {
    const o = parseMetars(['KPWM 291551Z 21014KT 10SM 17/11 A3000', 'KPWM 291451Z 20012KT 10SM 16/11 A3002', ''].join('\n'), REF)
    expect(o.map((x) => x.tws)).toEqual([12, 14])
  })
})

describe('CO-OPS stations', () => {
  it('merges wind and pressure by time, in knots and hPa', () => {
    const wind = { data: [{ t: '2026-09-29 14:54', s: '10.50', d: '200.00', dr: 'SSW', g: '14.00', f: '0,0' }, { t: '2026-09-29 15:00', s: '0.00', d: '0.00', g: '', f: '0,0' }] }
    const pressure = { data: [{ t: '2026-09-29 14:54', v: '1016.3', f: '0,0,0' }] }
    const o = parseCoops('8418150', wind, pressure)
    expect(o).toHaveLength(2)
    expect(o[0]).toMatchObject({ source: 'coops', station: '8418150', t: Date.UTC(2026, 8, 29, 14, 54), tws: 10.5, twd: 200, gust: 14, pres: 1016.3 })
    expect(o[1]).toMatchObject({ tws: 0, twd: null, gust: null, pres: null })
    expect(parseCoops('x', { error: { message: 'No data was found' } })).toEqual([])
  })
})
