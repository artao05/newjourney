/** The S-57 reader on a real NOAA cell: US5PWMDC, Portland Harbor, with its update (fixtures/real). */
import { describe, expect, it } from 'vitest'
import { realFile } from '../../realFiles'
import { groupCellFiles } from './library'
import { lightDescription } from './s52'
import { decodeS57, readS57 } from './s57'

const { cells } = groupCellFiles([{ name: 'US5PWMDC.zip', bytes: realFile('US5PWMDC.zip') }])
const incoming = cells[0]
const cell = decodeS57(incoming.base!, incoming.updates.map((u) => u.bytes))

describe("NOAA's Portland Harbor cell", () => {
  it('reads as many records as the cell itself says it holds', () => {
    // DSSI: 36 meta + 1,532 geo features; 315 isolated + 1,646 connected nodes + 1,984 edges.
    const base = readS57(incoming.base!)
    expect([base.features.size, base.vectors.size]).toEqual([1568, 3945])
    expect(base.warnings).toEqual([])
  })

  it('applies update 1: three features in, one out', () => {
    expect([cell.name, cell.edition, cell.update, cell.scale, cell.hdat]).toEqual(['US5PWMDC.000', '5', '1', 12000, 2])
    expect(cell.features.length).toBe(1568 + 3 - 1)
    expect(cell.warnings).toEqual([])
  })

  it("lies where NOAA's catalogue says, 43.65–43.725° N, 70.275–70.2° W", () => {
    const b = cell.bounds!
    expect(b.south).toBeCloseTo(43.65, 6)
    expect(b.north).toBeCloseTo(43.725, 6)
    expect(b.west).toBeCloseTo(-70.275, 6)
    expect(b.east).toBeCloseTo(-70.2, 6)
  })

  it('names every object class and attribute the cell uses', () => {
    expect(Object.keys(cell.counts).filter((k) => k.startsWith('OBJL'))).toEqual([])
    expect(cell.features.flatMap((f) => Object.keys(f.attrs)).filter((k) => k.startsWith('ATTL'))).toEqual([])
    expect(cell.counts).toMatchObject({ LIGHTS: 20, BOYLAT: 25, DEPARE: 206, DEPCNT: 220, SBDARE: 107, PONTON: 180, SOUNDG: 18 })
    // Each class that carries its own category attribute carries it exactly as often.
    expect(cell.features.filter((f) => f.attrs.NATSUR).length).toBe(cell.counts.SBDARE)
    expect(cell.features.filter((f) => f.attrs.CATMOR).length).toBe(cell.counts.MORFAC)
  })

  it('reads soundings in metres, and buoys by name', () => {
    const depths = cell.features.filter((f) => f.cls === 'SOUNDG').flatMap((f) => (f.geometry as { coordinates: number[][] }).coordinates.map((p) => p[2]))
    expect(depths.length).toBe(932)
    expect(Math.min(...depths)).toBeCloseTo(0.1, 6)
    expect(Math.max(...depths)).toBeCloseTo(18.5, 6)
    expect(cell.features.some((f) => f.cls === 'BOYLAT' && f.attrs.OBJNAM === 'Casco Bay Channel Buoy 9')).toBe(true)
  })

  it('describes Spring Point Ledge Light and its sectors as the chart does', () => {
    const at = (f: (typeof cell.features)[number]) => (f.geometry as { coordinates: number[] }).coordinates
    const spring = cell.features.filter((f) => f.cls === 'LIGHTS' && Math.abs(at(f)[0] + 70.2239054) < 1e-6 && Math.abs(at(f)[1] - 43.6521131) < 1e-6)
    const seen = spring.map((f) => [lightDescription(f.attrs), Number(f.attrs.SECTR1), Number(f.attrs.SECTR2)])
    expect(seen).toEqual(
      expect.arrayContaining([
        ['Fl W 6s 17m 12M', 74, 288],
        ['Fl W 6s 17m 12M', 331, 337],
        ['Fl R 6s 17m 10M', 288, 331],
        ['Fl R 6s 17m 10M', 337, 74],
      ]),
    )
  })
})
