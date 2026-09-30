import { describe, expect, it } from 'vitest'
import { FastPacketAssembler, N2kDecoder, decodePgn, fromCanId, parseN2kLine } from './n2k'

/** Little-endian byte helpers, for building payloads as a device would. */
const le = (v: number | bigint, n: number): number[] => {
  const out: number[] = []
  let x = BigInt.asUintN(n * 8, BigInt(v))
  for (let i = 0; i < n; i++) {
    out.push(Number(x & 0xffn))
    x >>= 8n
  }
  return out
}
const hex = (bytes: number[]) => bytes.map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join(' ')
/** A Yacht Devices RAW line for a PDU2 PGN, priority 2. */
const yd = (pgn: number, src: number, bytes: number[]) =>
  `10:00:00.000 R ${((2 << 26) | (pgn << 8) | src).toString(16).toUpperCase().padStart(8, '0')} ${hex(bytes)}`
const rad = (deg: number) => Math.round(((deg * Math.PI) / 180) * 1e4)
const one = (pgn: number, bytes: number[]) => decodePgn({ pgn, src: 1, priority: 2, data: Uint8Array.from(bytes) })

describe('NMEA 2000 frames', () => {
  it('splits a CAN id into PGN, source and priority, for both kinds of address', () => {
    expect(fromCanId(0x09f80115)).toEqual({ pgn: 129025, src: 0x15, priority: 2 })
    // PDU1 (an ISO request): the destination byte is not part of the PGN.
    expect(fromCanId(0x18eaff15)).toEqual({ pgn: 59904, src: 0x15, priority: 6 })
  })

  it('reads Yacht Devices RAW and canboat CSV lines', () => {
    const a = parseN2kLine('17:33:21.107 R 09F80115 A0 7D E6 18 00 00 00 00')!
    expect(a.pgn).toBe(129025)
    expect(Array.from(a.data)).toEqual([0xa0, 0x7d, 0xe6, 0x18, 0, 0, 0, 0])
    const b = parseN2kLine('2026-09-29-10:00:00.000,2,127250,7,255,8,00,ff,7f,ff,7f,ff,7f,fd')!
    expect(b).toMatchObject({ pgn: 127250, src: 7, priority: 2 })
    expect(parseN2kLine('$GPHDT,10,T')).toBeNull()
    expect(parseN2kLine('2026-09-29,2,127250,7,255,8,00')).toBeNull()
  })
})

describe('the PGNs a race boat sends', () => {
  it('position, and course and speed over ground', () => {
    const p = decodePgn(parseN2kLine('17:33:21.107 R 09F80115 A0 7D E6 18 00 00 00 00')!)!
    expect(p.lat).toBeCloseTo(0x18e67da0 * 1e-7, 9)
    expect(p.lon).toBe(0)
    const c = one(129026, [0, 0xfc, ...le(rad(210), 2), ...le(309, 2), 0xff, 0xff])!
    expect(c.cog).toBeCloseTo(210, 2)
    expect(c.sog).toBeCloseTo(3.09 * (3600 / 1852), 6)
  })

  it('heading true or magnetic, with deviation and variation', () => {
    expect(one(127250, [0, ...le(rad(90), 2), ...le(0x7fff, 2), ...le(0x7fff, 2), 0xfc])).toEqual({ headingTrue: expect.closeTo(90, 2) })
    const m = one(127250, [0, ...le(rad(220), 2), ...le(rad(-2), 2), ...le(rad(-14.5), 2), 0xfd])!
    expect(m.headingMag).toBeCloseTo(220, 2)
    expect(m.deviation).toBeCloseTo(-2, 2)
    expect(m.variation).toBeCloseTo(-14.5, 2)
  })

  it('attitude, rate of turn and rudder', () => {
    const a = one(127257, [0, ...le(0x7fff, 2), ...le(rad(2), 2), ...le(rad(-12), 2), 0xff])!
    expect(a.pitch).toBeCloseTo(2, 2)
    expect(a.heel).toBeCloseTo(-12, 2)
    // 10°/s is 0.1745 rad/s, in 3.125e-8 rad/s steps.
    const r = one(127251, [0, ...le(Math.round(((10 * Math.PI) / 180) / 3.125e-8), 4), 0xff, 0xff, 0xff])!
    expect(r.rateOfTurn).toBeCloseTo(600, 2)
    expect(one(127245, [0, 0xff, ...le(0x7fff, 2), ...le(rad(-4), 2), 0xff, 0xff])!.rudder).toBeCloseTo(-4, 2)
  })

  it('boat speed, depth, and nothing for a field marked not available', () => {
    expect(one(128259, [0, ...le(324, 2), ...le(0xffff, 2), 0, 0xff, 0xff])!.bsp).toBeCloseTo(3.24 * (3600 / 1852), 6)
    expect(one(128259, [0, 0xff, 0xff, 0xff, 0xff, 0, 0xff, 0xff])).toEqual({})
    expect(one(128267, [0, ...le(1240, 4), ...le(-500, 2), 0xff])).toEqual({ depthM: 12.4, depthOffsetM: -0.5 })
  })

  it('wind, apparent and true, and the environment', () => {
    const app = one(130306, [0, ...le(772, 2), ...le(rad(330), 2), 0xfa, 0xff, 0xff])!
    expect(app.aws).toBeCloseTo(7.72 * (3600 / 1852), 6)
    expect(app.awa).toBeCloseTo(-30, 2)
    const tw = one(130306, [0, ...le(617, 2), ...le(rad(45), 2), 0xfc, 0xff, 0xff])!
    expect(tw.twa).toBeCloseTo(45, 2)
    const env = one(130310, [0, ...le(29065, 2), ...le(29415, 2), ...le(1013, 2), 0xff])!
    expect(env.waterTempC).toBeCloseTo(17.5, 6)
    expect(env.airTempC).toBeCloseTo(21, 6)
    expect(env.baroHpa).toBe(1013)
  })

  it('does not read a PGN it does not know', () => {
    expect(one(59904, [0, 0, 0])).toBeNull()
  })
})

describe('fast packets', () => {
  /** Splits a payload into fast-packet frames with sequence number `seq`. */
  const frames = (pgn: number, payload: number[], seq = 3) => {
    const out: string[] = []
    out.push(yd(pgn, 9, [(seq << 5) | 0, payload.length, ...payload.slice(0, 6)].concat(Array(8).fill(0xff)).slice(0, 8)))
    for (let i = 6, n = 1; i < payload.length; i += 7, n++) {
      out.push(yd(pgn, 9, [(seq << 5) | n, ...payload.slice(i, i + 7)].concat(Array(8).fill(0xff)).slice(0, 8)))
    }
    return out
  }

  // GNSS position data: a date, a time, 64-bit position and height, DGPS, 9 satellites, HDOP 0.9.
  const gnss = [
    0,
    ...le(20_725, 2), // days since 1970: 2026-09-29
    ...le(36_000 * 10_000, 4), // 10:00:00
    ...le(436591000000000000n, 8),
    ...le(-702468000000000000n, 8),
    ...le(3_500_000, 8),
    0x20, // method 2 (DGNSS), type GPS
    0xfc,
    9,
    ...le(90, 2),
    ...le(150, 2),
    ...le(0, 4),
    0,
  ]

  it('reads the same messages whole, as an Actisense W2K-1 and a Digital Yacht iKonvert send them', () => {
    const wind = [0, ...le(772, 2), ...le(rad(330), 2), 0xfa, 0xff, 0xff]
    const actisense = (pgn: number, src: number, bytes: number[]) =>
      `A173321.107 ${src.toString(16).padStart(2, '0').toUpperCase()}FF2 ${pgn.toString(16).toUpperCase().padStart(5, '0')} ${bytes.map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join('')}`
    const ikonvert = (pgn: number, src: number, bytes: number[]) => `!PDGY,${pgn},2,${src},255,0.000,${btoa(String.fromCharCode(...bytes))}`
    const fromYd = new N2kDecoder().line(yd(130306, 0x23, wind))
    expect(fromYd).toMatchObject({ awa: expect.closeTo(-30, 2) })
    expect(new N2kDecoder().line(actisense(130306, 0x23, wind))).toEqual(fromYd)
    expect(new N2kDecoder().line(ikonvert(130306, 0x23, wind))).toEqual(fromYd)
    expect(parseN2kLine(actisense(130306, 0x23, wind))).toMatchObject({ pgn: 130306, src: 0x23, priority: 2, whole: true })
    // A fast-packet PGN comes in one line, already put together.
    const r = new N2kDecoder().line(actisense(129029, 0x23, gnss))!
    expect(r.lat).toBeCloseTo(43.6591, 9)
    expect(new N2kDecoder().line(ikonvert(129029, 0x23, gnss))!.lon).toBeCloseTo(-70.2468, 9)
    // The iKonvert's own status lines are not frames.
    expect(parseN2kLine('$PDGY,000000,4,,5,482,1,0')).toBeNull()
  })

  it('puts a GNSS position back together from its frames', () => {
    const d = new N2kDecoder()
    const lines = frames(129029, gnss)
    const got = lines.map((l) => d.line(l))
    expect(got.slice(0, -1).every((r) => r === null)).toBe(true)
    const r = got.at(-1)!
    expect(r.lat).toBeCloseTo(43.6591, 9)
    expect(r.lon).toBeCloseTo(-70.2468, 9)
    expect(r).toMatchObject({ fixQuality: 2, satellites: 9, hdop: 0.9, altitudeM: 3.5, utc: Date.UTC(2026, 8, 29, 10) })
    expect(d.stats).toMatchObject({ frames: lines.length, messages: 1 })
  })

  it('drops a message that loses a frame, and starts clean on the next', () => {
    const a = new FastPacketAssembler()
    const [first, , ...rest] = frames(129029, gnss).map((l) => parseN2kLine(l)!)
    a.push(first)
    expect(rest.map((f) => a.push(f)).every((r) => r === null)).toBe(true)
    const again = frames(129029, gnss, 4).map((l) => parseN2kLine(l)!)
    expect(again.map((f) => a.push(f)).at(-1)).not.toBeNull()
  })

  it('reads the distance log', () => {
    const d = new N2kDecoder()
    const payload = [...le(20_725, 2), ...le(0, 4), ...le(2_286_294, 4), ...le(22_780, 4)]
    const r = frames(128275, payload).map((l) => d.line(l)).at(-1)!
    expect(r.logNm).toBeCloseTo(1234.5, 1)
    expect(r.tripNm).toBeCloseTo(12.3, 1)
  })
})
