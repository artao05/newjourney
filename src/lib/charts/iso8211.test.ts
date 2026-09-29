import { describe, expect, it } from 'vitest'
import { expandFormats, parse8211 } from './iso8211'

/*
 * Records built to the ISO 8211 layout, with fields shaped like S-57's: DSID
 * (text, integers and a one-byte code), and SG2D (a repeating group of
 * signed four-byte coordinates, little-endian).
 */
const FT = 0x1e
const UT = 0x1f
const enc = (s: string) => [...s].map((c) => c.charCodeAt(0))
const pad = (n: number, w: number) => enc(String(n).padStart(w, '0'))

function record(kind: 'L' | 'D', fields: Array<[string, number[]]>, controlLen: string): number[] {
  const sizeLen = 3
  const sizePos = 4
  const sizeTag = 4
  const dir: number[] = []
  const area: number[] = []
  for (const [tag, data] of fields) {
    dir.push(...enc(tag), ...pad(data.length, sizeLen), ...pad(area.length, sizePos))
    area.push(...data)
  }
  dir.push(FT)
  const base = 24 + dir.length
  const length = base + area.length
  const lead = [...pad(length, 5), ...enc(kind === 'L' ? '3' : ' '), ...enc(kind), ...enc(kind === 'L' ? 'E1 ' : '   '), ...enc(controlLen), ...pad(base, 5), ...enc(kind === 'L' ? ' ! ' : '   '), ...pad(sizeLen, 1), ...pad(sizePos, 1), 48, ...pad(sizeTag, 1)]
  return [...lead, ...dir, ...area]
}

const ddrField = (controls: string, name: string, desc: string, fc: string) => [...enc(controls), ...enc(name), UT, ...enc(desc), UT, ...enc(fc), FT]
const le = (v: number, n: number) => {
  const x = v < 0 ? v + 2 ** (8 * n) : v
  return Array.from({ length: n }, (_, i) => Math.floor(x / 256 ** i) & 255)
}

function file(): Uint8Array {
  const ddr = record(
    'L',
    [
      ['0000', [...enc('0000;&   '), ...enc('ENC TEST'), FT]],
      ['0001', ddrField('0100;&   ', 'ISO 8211 Record Identifier', '', '(b12)')],
      ['DSID', ddrField('1600;&   ', 'Data set identification field', 'RCNM!RCID!DSNM!EDTN!PRSP', '(b11,b14,A,A,b11)')],
      ['SG2D', ddrField('2600;&   ', '2-D coordinate field', '*YCOO!XCOO', '(2b24)')],
    ],
    '06',
  )
  const dr1 = record('D', [['0001', [...le(1, 2), FT]], ['DSID', [...le(10, 1), ...le(1, 4), ...enc('US5ME11M.000'), UT, ...enc('3'), UT, ...le(1, 1), FT]]], '  ')
  const pts: Array<[number, number]> = [
    [43.65, -70.25],
    [43.66, -70.24],
    [-12.5, 170.125],
  ]
  const sg2d = pts.flatMap(([lat, lon]) => [...le(Math.round(lat * 1e7), 4), ...le(Math.round(lon * 1e7), 4)])
  const dr2 = record('D', [['0001', [...le(2, 2), FT]], ['SG2D', [...sg2d, FT]]], '  ')
  return new Uint8Array([...ddr, ...dr1, ...dr2])
}

describe('ISO 8211', () => {
  it('expands format controls, repeats and nested groups included', () => {
    expect(expandFormats('(A(2),I(10),3b12)')).toEqual(['A(2)', 'I(10)', 'b12', 'b12', 'b12'])
    expect(expandFormats('(b11,2(b12,b24),A)')).toEqual(['b11', 'b12', 'b24', 'b12', 'b24', 'A'])
  })

  it('reads the field descriptions, then each record’s fields by them', () => {
    const f = parse8211(file())
    expect([...f.fields.keys()]).toEqual(['0001', 'DSID', 'SG2D'])
    expect(f.fields.get('SG2D')).toMatchObject({ name: '2-D coordinate field', labels: ['YCOO', 'XCOO'], repeating: true, formats: ['b24', 'b24'] })
    expect(f.records).toHaveLength(2)
    const [id, dsid] = f.records[0]
    expect(id).toEqual({ tag: '0001', groups: [{ '': 1 }] })
    expect(dsid.groups).toEqual([{ RCNM: 10, RCID: 1, DSNM: 'US5ME11M.000', EDTN: '3', PRSP: 1 }])
  })

  it('reads a repeating group of signed little-endian coordinates', () => {
    const sg2d = parse8211(file()).records[1][1]
    expect(sg2d.tag).toBe('SG2D')
    expect(sg2d.groups.map((g) => [(g.YCOO as number) / 1e7, (g.XCOO as number) / 1e7])).toEqual([
      [43.65, -70.25],
      [43.66, -70.24],
      [-12.5, 170.125],
    ])
  })

  it('refuses what is not ISO 8211, or is cut short', () => {
    expect(() => parse8211(new TextEncoder().encode('hello, world, this is not a chart at all'))).toThrow(/not an ISO 8211 record/)
    const f = file()
    expect(() => parse8211(f.subarray(0, f.length - 10))).toThrow(/runs past the end/)
  })
})
