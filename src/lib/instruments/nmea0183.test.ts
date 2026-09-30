import { describe, expect, it } from 'vitest'
import { NmeaDecoder, decode, nmeaChecksum, parseSentence, withChecksum, type Reading } from './nmea0183'

/** Decode one sentence body, with a correct checksum added. */
const one = (body: string): Partial<Reading> | null => {
  const s = parseSentence(withChecksum(body))
  return s && decode(s)
}

describe('NMEA 0183 checksums', () => {
  it('matches the sentences every NMEA reference quotes', () => {
    // The textbook RMC and GGA, checksums as published.
    expect(nmeaChecksum('GPRMC,123519,A,4807.038,N,01131.000,E,022.4,084.4,230394,003.1,W')).toBe('6A')
    expect(nmeaChecksum('GPGGA,123519,4807.038,N,01131.000,E,1,08,0.9,545.4,M,46.9,M,,')).toBe('47')
  })

  it('refuses a line whose checksum is wrong, and a proprietary one', () => {
    expect(parseSentence('$GPRMC,123519,A,4807.038,N,01131.000,E,022.4,084.4,230394,003.1,W*6B')).toBeNull()
    expect(parseSentence(withChecksum('PGRME,15.0,M,45.0,M,25.0,M'))).toBeNull()
  })

  it('accepts a line with no checksum at all, as older kit sends', () => {
    expect(parseSentence('$IIHDM,123.4,M')).toEqual({ talker: 'II', type: 'HDM', fields: ['123.4', 'M'] })
  })
})

describe('position, course and time', () => {
  it('reads RMC, with its date, south and west', () => {
    const r = one('GPRMC,123519,A,4807.038,N,01131.000,E,022.4,084.4,230394,003.1,W')!
    expect(r.lat).toBeCloseTo(48 + 7.038 / 60, 9)
    expect(r.lon).toBeCloseTo(11 + 31 / 60, 9)
    expect(r).toMatchObject({ sog: 22.4, cog: 84.4, variation: -3.1, utc: Date.UTC(1994, 2, 23, 12, 35, 19) })
    const sw = one('GNRMC,000001.50,A,4339.000,S,07010.500,W,0.0,,290926,,')!
    expect(sw.lat).toBeCloseTo(-(43 + 39 / 60), 9)
    expect(sw.lon).toBeCloseTo(-(70 + 10.5 / 60), 9)
    expect(sw.utc).toBe(Date.UTC(2026, 8, 29, 0, 0, 1) + 500)
  })

  it('takes no position from a void RMC, and none from a GGA without a fix', () => {
    expect(one('GPRMC,123519,V,4807.038,N,01131.000,E,022.4,084.4,230394,,')!.lat).toBeUndefined()
    const g = one('GPGGA,123519,4807.038,N,01131.000,E,0,00,99.9,,M,,M,,')!
    expect(g.lat).toBeUndefined()
    expect(g.fixQuality).toBe(0)
  })

  it('reads GGA: fix, satellites, HDOP and height', () => {
    expect(one('GPGGA,123519,4807.038,N,01131.000,E,1,08,0.9,545.4,M,46.9,M,,')).toMatchObject({
      fixQuality: 1,
      satellites: 8,
      hdop: 0.9,
      altitudeM: 545.4,
    })
  })

  it('reads GLL and both forms of VTG', () => {
    expect(one('GPGLL,4916.45,N,12311.12,W,225444,A,A')!.lon).toBeCloseTo(-(123 + 11.12 / 60), 9)
    expect(one('GPVTG,054.7,T,034.4,M,005.5,N,010.2,K,A')).toEqual({ cog: 54.7, sog: 5.5 })
    expect(one('GPVTG,054.7,034.4,005.5,010.2')).toEqual({ cog: 54.7, sog: 5.5 })
  })

  it('reads ZDA as UTC', () => {
    expect(one('GPZDA,201530.00,04,07,2002,00,00')!.utc).toBe(Date.UTC(2002, 6, 4, 20, 15, 30))
  })
})

describe('heading, wind and speed', () => {
  it('works HDG through to true, with deviation and variation east positive', () => {
    const r = one('HCHDG,98.3,0.5,E,14.7,W')!
    expect(r).toMatchObject({ headingMag: 98.3, deviation: 0.5, variation: -14.7 })
    expect(r.headingTrue).toBeCloseTo(98.3 + 0.5 - 14.7, 9)
    expect(one('HEHDT,274.07,T')).toEqual({ headingTrue: 274.07 })
  })

  it('reads MWV apparent and true, signed, in any speed unit', () => {
    expect(one('IIMWV,315.0,R,12.4,N,A')).toEqual({ awa: -45, aws: 12.4 })
    expect(one('WIMWV,040.0,T,10.0,M,A')!.tws).toBeCloseTo((10 * 3600) / 1852, 9)
    expect(one('IIMWV,040.0,T,18.52,K,A')!.tws).toBeCloseTo(10, 9)
    expect(one('IIMWV,040.0,T,10.0,N,V')).toEqual({})
  })

  it('reads MWD, VHW and VLW', () => {
    expect(one('WIMWD,270.0,T,284.7,M,14.2,N,7.3,M')).toEqual({ twd: 270, tws: 14.2 })
    expect(one('VWVHW,,T,,M,6.53,N,12.09,K')).toEqual({ bsp: 6.53 })
    expect(one('VWVLW,1234.5,N,12.3,N')).toEqual({ logNm: 1234.5, tripNm: 12.3 })
  })
})

describe('depth, environment and the rest', () => {
  it('reads DPT with its offset, and DBT in metres', () => {
    expect(one('SDDPT,12.3,0.5,100')).toEqual({ depthM: 12.3, depthOffsetM: 0.5 })
    expect(one('SDDBT,40.4,f,12.3,M,6.7,F')).toEqual({ depthM: 12.3 })
    expect(one('SDDBT,10.0,f,,M,,F')!.depthM).toBeCloseTo(3.048, 9)
  })

  it('reads MTW and MDA', () => {
    expect(one('YXMTW,17.5,C')).toEqual({ waterTempC: 17.5 })
    expect(one('WIMDA,29.9213,I,1.0132,B,21.5,C,17.0,C,64.0,,12.1,C,210.0,T,224.6,M,11.3,N,5.8,M')).toMatchObject({
      baroHpa: 1013.2,
      airTempC: 21.5,
      waterTempC: 17,
      humidityPct: 64,
      twd: 210,
      tws: 11.3,
    })
  })

  it('reads heel, pitch and pressure out of XDR groups', () => {
    const r = one('IIXDR,A,-12.5,D,HEEL,A,2.1,D,PTCH,P,1.0125,B,BARO,A,24.0,D,MAST')!
    expect(r).toMatchObject({ heel: -12.5, pitch: 2.1, baroHpa: 1012.5, mastAngle: 24 })
    expect(r.xdr).toHaveLength(4)
  })

  it('reads RSA, ROT, XTE, APB and RMB', () => {
    expect(one('IIRSA,-5.2,A,,V')).toEqual({ rudder: -5.2 })
    expect(one('TIROT,-35.0,A')).toEqual({ rateOfTurn: -35 })
    expect(one('GPXTE,A,A,0.67,L,N')).toEqual({ xteNm: 0.67, steer: 'L' })
    expect(one('GPAPB,A,A,0.10,R,N,V,V,011,M,DEST,011,M,011,M')).toMatchObject({ xteNm: 0.1, steer: 'R', waypoint: { id: 'DEST' } })
    const rmb = one('GPRMB,A,0.66,L,003,004,4917.24,N,12309.57,W,001.3,052.5,000.5,V')!
    expect(rmb.waypoint).toMatchObject({ id: '004', rangeNm: 1.3, bearingTrue: 52.5 })
    expect(rmb.waypoint!.lat).toBeCloseTo(49 + 17.24 / 60, 9)
  })

  it('does not read what it does not know', () => {
    expect(one('GPGSV,3,1,11,03,03,111,00,04,15,270,00,06,01,010,00,13,06,292,00')).toBeNull()
  })
})

describe('the streaming decoder', () => {
  it('joins lines split across chunks, keeps the latest of everything, and counts the rest', () => {
    const d = new NmeaDecoder()
    const rmc = withChecksum('GPRMC,123519,A,4807.038,N,01131.000,E,022.4,084.4,230394,003.1,W')
    d.feed(rmc.slice(0, 20), 1)
    expect(d.reading.sog).toBeUndefined()
    d.feed(rmc.slice(20) + '\r\n' + withChecksum('IIMWV,030.0,R,15.0,N,A') + '\r\n$IIHDT,10*00\r\n!AIVDM,1,1,,A,x,0*00\r\n', 2)
    expect(d.reading).toMatchObject({ sog: 22.4, awa: 30, aws: 15 })
    expect(d.updated.awa).toBe(2)
    expect(d.stats).toEqual({ sentences: 2, badChecksum: 1, unknown: 0 })
    // A later sentence with an empty field does not blank the good value.
    d.feed(withChecksum('GPVTG,,T,,M,6.0,N,11.1,K,A') + '\n', 3)
    expect(d.reading).toMatchObject({ cog: 84.4, sog: 6 })
  })

  it('does not let a stream with no line ends grow without bound', () => {
    const d = new NmeaDecoder()
    d.feed('x'.repeat(5000))
    d.feed(withChecksum('IIHDT,10.0,T') + '\n')
    expect(d.reading.headingTrue).toBe(10)
  })
})

describe('a laser rangefinder', () => {
  it("reads a TruPulse's shot: horizontal distance in any unit, azimuth and inclination", () => {
    const one = (body: string) => decode(parseSentence(withChecksum(body))!)
    expect(one('PLTIT,HV,212.4,M,275.3,D,1.2,D,212.5,M')).toEqual({ laser: { rangeM: 212.4, bearing: 275.3, inclination: 1.2 } })
    expect(one('PLTIT,HV,100.0,F,,D,,D,100.0,F')!.laser!.rangeM).toBeCloseTo(30.48, 6)
    expect(one('PLTIT,HV,50.0,Y,90.0,D,0.0,D,50.0,Y')!.laser).toMatchObject({ rangeM: expect.closeTo(45.72, 6), bearing: 90 })
    // Other TruPulse messages, and a shot with no distance, say nothing.
    expect(one('PLTIT,HT,12.0,M')).toBeNull()
    expect(one('PLTIT,HV,,M,275.3,D,1.2,D,,M')).toBeNull()
  })
})
