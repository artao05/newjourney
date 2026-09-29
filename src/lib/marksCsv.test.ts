import { describe, expect, it } from 'vitest'
import { csvFields, marksToCsv, parseMarksCsv, rangeBearingTable } from './marksCsv'

describe("Expedition's marks CSV", () => {
  it("reads the manual's own example, degrees and decimal minutes with letters", () => {
    const { marks, skipped } = parseMarksCsv(
      'North Head,50 42.69n,01 35.52w\nPeters & May,50 46.13n,01 22.19w\n',
    )
    expect(skipped).toBe(0)
    expect(marks[0].name).toBe('North Head')
    expect(marks[0].position.lat).toBeCloseTo(50 + 42.69 / 60, 9)
    expect(marks[0].position.lon).toBeCloseTo(-(1 + 35.52 / 60), 9)
    expect(marks[1].name).toBe('Peters & May')
  })

  it('reads decimal degrees and the optional group, range circle and comment', () => {
    const { marks } = parseMarksCsv('Bell 1,43.6,-70.2,Casco Bay,0.1,"Red, lit"')
    expect(marks[0]).toEqual({
      name: 'Bell 1',
      position: { lat: 43.6, lon: -70.2 },
      folder: 'Casco Bay',
      rangeCircleNm: 0.1,
      comment: 'Red, lit',
    })
  })

  it('skips a header row and lines it cannot place, and counts them', () => {
    const { marks, skipped } = parseMarksCsv(
      'name,lat,lon\nGood,43.6,-70.2\nBad,93 00n,70 00w\n,43,-70\n',
    )
    expect(marks.map((m) => m.name)).toEqual(['Good'])
    expect(skipped).toBe(3)
  })

  it('writes marks that read back to the same positions and fields', () => {
    const marks = [
      { name: 'Bell "1"', position: { lat: 43.61234, lon: -70.20567 }, folder: 'Casco, Bay', comment: 'x' },
      { name: 'Can 3', position: { lat: -33.85, lon: 151.21 } },
    ]
    const back = parseMarksCsv(marksToCsv(marks)).marks
    expect(back.map((m) => m.name)).toEqual(['Bell "1"', 'Can 3'])
    expect(back[0].folder).toBe('Casco, Bay')
    for (let i = 0; i < marks.length; i++) {
      // Three decimal places of a minute is about 2 m.
      expect(back[i].position.lat).toBeCloseTo(marks[i].position.lat, 4)
      expect(back[i].position.lon).toBeCloseTo(marks[i].position.lon, 4)
    }
    expect(marksToCsv([marks[1]])).toBe('Can 3,33 51.000s,151 12.600e\n')
  })

  it('splits quoted fields with commas and doubled quotes', () => {
    expect(csvFields('a,"b, c","d ""e"""')).toEqual(['a', 'b, c', 'd "e"'])
  })

  it('tabulates range and bearing between every pair of marks', () => {
    const t = rangeBearingTable([
      { name: 'A', position: { lat: 43, lon: -70 } },
      { name: 'B', position: { lat: 43 + 1 / 60, lon: -70 } },
    ])
    const rows = t.trim().split('\n')
    expect(rows[0]).toBe('from / to,A,B')
    expect(rows[1]).toBe('A,,1.00 nm 000°T')
    expect(rows[2]).toBe('B,1.00 nm 180°T,')
  })
})
