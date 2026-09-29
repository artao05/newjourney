import { describe, expect, it } from 'vitest'
import { AisDecoder, decodeAis, type AisAton, type AisBase, type AisPosition, type AisSafety, type AisStatic } from './decode'
import { ll, sentences, type Field } from './fixtures/encode'

describe('AIS, from published examples', () => {
  it('reads a class A position report', () => {
    const [m] = decodeAis('!AIVDM,1,1,,B,177KQJ5000G?tO`K>RA1wUbN0TKH,0*5C') as AisPosition[]
    expect(m).toMatchObject({ type: 1, mmsi: 477553000, kind: 'position', cls: 'A', status: 5, sog: 0, cog: 51, heading: 181, channel: 'B', own: false })
    expect(m.lat).toBeCloseTo(47.582833, 5)
    expect(m.lon).toBeCloseTo(-122.345833, 5)
  })

  it('joins a two-sentence static and voyage report', () => {
    const [m] = decodeAis(
      ['!AIVDM,2,1,1,A,55?MbV02;H;s<HtKR20EHE:0@T4@Dn2222222216L961O5Gf0NSQEp6ClRp8,0*1C', '!AIVDM,2,2,1,A,88888888880,2*25'].join('\n'),
    ) as AisStatic[]
    expect(m).toMatchObject({ type: 5, mmsi: 351759000, imo: 9134270, callSign: '3FOF8', name: 'EVER DIADEM', shipType: 70, draughtM: 12.2, destination: 'NEW YORK' })
    expect(m.dims).toEqual({ bow: 225, stern: 70, port: 1, starboard: 31 })
  })
})

const head = (type: number, mmsi: number): Field[] => [[6, type], [2, 0], [30, mmsi]]

describe('AIS, every message type read', () => {
  it('reads rate of turn, and marks what is not available as unknown', () => {
    const f = (rot: number, sog: number, cog: number, hdg: number): Field[] => [
      ...head(3, 338123456), [4, 0], [8, rot], [10, sog], [1, 1], [28, ll(-70.25)], [27, ll(43.6)], [12, cog], [9, hdg], [6, 30], [2, 0], [3, 0], [1, 0], [19, 0],
    ]
    const [a] = decodeAis(sentences(f(-40, 65, 2255, 223)).join('\n')) as AisPosition[]
    expect(a.rot).toBeCloseTo(-((40 / 4.733) ** 2), 6)
    expect([a.sog, a.cog, a.heading, a.second, a.accuracy]).toEqual([6.5, 225.5, 223, 30, true])
    const [b] = decodeAis(sentences(f(-128, 1023, 3600, 511)).join('\n')) as AisPosition[]
    expect([b.rot, b.sog, b.cog, b.heading]).toEqual([null, null, null, null])
  })

  it('reads class B, extended class B with its name and size, and both halves of type 24', () => {
    const pos: Field[] = [[8, 0], [10, 72], [1, 0], [28, ll(-70.1)], [27, ll(43.55)], [12, 900], [9, 90], [6, 12]]
    const [b18] = decodeAis(sentences([...head(18, 367000001), ...pos, [4, 0], [1, 1], [1, 0], [1, 0], [1, 0], [1, 0], [1, 0], [20, 0]]).join('\n')) as AisPosition[]
    expect(b18).toMatchObject({ cls: 'B', mmsi: 367000001, sog: 7.2, cog: 90, heading: 90 })
    expect(b18.lat).toBeCloseTo(43.55, 5)
    const [b19] = decodeAis(
      sentences([...head(19, 367000002), ...pos, [4, 0], [120, 'WILD HORSES'], [8, 36], [9, 10], [9, 2], [6, 2], [6, 2], [4, 1], [1, 0], [1, 1], [1, 0], [4, 0]]).join('\n'),
    ) as AisPosition[]
    expect(b19).toMatchObject({ name: 'WILD HORSES', shipType: 36, dims: { bow: 10, stern: 2, port: 2, starboard: 2 } })
    const [a24] = decodeAis(sentences([...head(24, 367000003), [2, 0], [120, 'SEA FEVER']]).join('\n')) as AisStatic[]
    expect(a24).toMatchObject({ kind: 'static', part: 'A', name: 'SEA FEVER' })
    const [b24] = decodeAis(sentences([...head(24, 367000003), [2, 1], [8, 37], [42, 'ABC1234'], [42, 'WDX1234'], [9, 8], [9, 3], [6, 2], [6, 2], [6, 0]]).join('\n')) as AisStatic[]
    expect(b24).toMatchObject({ part: 'B', shipType: 37, callSign: 'WDX1234', dims: { bow: 8, stern: 3, port: 2, starboard: 2 } })
  })

  it('reads base stations, SAR aircraft, safety text, aids to navigation and long-range reports', () => {
    const [base] = decodeAis(sentences([...head(4, 3669999), [14, 2026], [4, 9], [5, 29], [5, 14], [6, 5], [6, 30], [1, 1], [28, ll(-70.3)], [27, ll(43.7)], [4, 1], [10, 0], [1, 0], [19, 0]]).join('\n')) as AisBase[]
    expect(base).toMatchObject({ kind: 'base', time: Date.UTC(2026, 8, 29, 14, 5, 30) })
    const [sar] = decodeAis(sentences([...head(9, 111232506), [12, 300], [10, 120], [1, 0], [28, ll(-70)], [27, ll(43.5)], [12, 450], [6, 10], [8, 0], [1, 0], [3, 0], [1, 0], [1, 0], [20, 0]]).join('\n')) as AisPosition[]
    expect(sar).toMatchObject({ cls: 'SAR', altitudeM: 300, sog: 120, cog: 45 })
    const [txt] = decodeAis(sentences([...head(14, 970012345), [2, 0], [66, 'SART ACTIVE']]).join('\n')) as AisSafety[]
    expect(txt).toMatchObject({ kind: 'safety', mmsi: 970012345, text: 'SART ACTIVE' })
    const [aton] = decodeAis(
      sentences([...head(21, 993692001), [5, 14], [120, 'PORTLAND HARBOR BELL'], [1, 1], [28, ll(-70.2)], [27, ll(43.62)], [9, 0], [9, 0], [6, 0], [6, 0], [4, 7], [6, 60], [1, 1], [8, 0], [1, 0], [1, 1], [1, 0], [1, 0], [48, ' BUOY 2']]).join('\n'),
    ) as AisAton[]
    expect(aton).toMatchObject({ kind: 'aton', aidType: 14, name: 'PORTLAND HARBOR BELL BUOY 2', offPosition: true, virtual: true })
    expect(aton.lat).toBeCloseTo(43.62, 5)
    const [lr] = decodeAis(sentences([...head(27, 244000001), [1, 1], [1, 0], [4, 0], [18, ll(-70.2, 600)], [17, ll(43.6, 600)], [6, 12], [9, 270], [1, 0], [1, 0]]).join('\n')) as AisPosition[]
    expect(lr).toMatchObject({ cls: 'LR', sog: 12, cog: 270, status: 0 })
    expect(lr.lat).toBeCloseTo(43.6, 1)
  })
})

describe('AIS framing', () => {
  it('joins parts by sequence and channel, even interleaved, and knows its own ship', () => {
    const long: Field[] = [...head(5, 367123456), [2, 0], [30, 1234567], [42, 'KAB123'], [120, 'OWN SHIP'], [8, 36], [30, 0], [4, 1], [20, 0], [8, 21], [120, 'PORTLAND'], [1, 0], [1, 0]]
    const a = sentences(long, { seq: 1, channel: 'A', perSentence: 40 })
    const b = sentences(long, { seq: 2, channel: 'B', perSentence: 40, own: true })
    const d = new AisDecoder()
    const got = [d.push(a[0]), d.push(b[0]), d.push(b[1]), d.push(a[1])].filter(Boolean) as AisStatic[]
    expect(got.map((m) => [m.channel, m.own, m.name, m.draughtM, m.destination])).toEqual([
      ['B', true, 'OWN SHIP', 2.1, 'PORTLAND'],
      ['A', false, 'OWN SHIP', 2.1, 'PORTLAND'],
    ])
  })

  it('rejects a sentence whose checksum is wrong, and ignores what is not AIS', () => {
    const d = new AisDecoder()
    expect(d.push('!AIVDM,1,1,,B,177KQJ5000G?tO`K>RA1wUbN0TKH,0*5D')).toBeNull()
    expect(d.rejected).toBe(1)
    expect(d.push('$GPRMC,120000,A,4336.0,N,07015.0,W,5.0,90.0,290926,,*00')).toBeNull()
    expect(d.rejected).toBe(1)
  })
})
