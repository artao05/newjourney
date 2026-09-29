import { describe, expect, it } from 'vitest'
import { decodeS57 } from './s57'
import { COMF, SOMF, buoyUpdate, cell, update3 } from './fixtures/cell'

/*
 * A tiny cell built to the S-57 layout: a light on an isolated node, a
 * sounding array, a coastline edge between two connected nodes, a depth area
 * whose one ring is a closed edge, and an object class not in the table.
 */
describe('S-57 cells', () => {
  const c = decodeS57(cell())

  it('reads the cell’s name, edition and scale factors', () => {
    expect([c.name, c.edition, c.update, c.comf, c.somf]).toEqual(['US5ME11M.000', '7', '2', COMF, SOMF])
    expect(c.counts).toEqual({ LIGHTS: 1, SOUNDG: 1, COALNE: 1, DEPARE: 1, OBJL999: 1 })
  })

  it('places points on their nodes, with attributes by name, and soundings with their depths', () => {
    const light = c.features.find((x) => x.cls === 'LIGHTS')!
    expect(light.geometry).toEqual({ type: 'Point', coordinates: [-70.21, 43.62] })
    expect(light.attrs).toEqual({ COLOUR: '3', OBJNAM: 'Portland Head Light' })
    expect(c.features.find((x) => x.cls === 'SOUNDG')!.geometry).toEqual({ type: 'MultiPoint', coordinates: [[-70.2, 43.61, 12.3], [-70.19, 43.6, 4.5]] })
  })

  it('draws a line along its edge, reversed where the feature says so', () => {
    const coast = c.features.find((x) => x.cls === 'COALNE')!
    expect(coast.geometry).toEqual({ type: 'LineString', coordinates: [[-70.25, 43.65], [-70.26, 43.62], [-70.25, 43.6]] })
  })

  it('closes an area from its ring of edges, and says what it could not find', () => {
    const dep = c.features.find((x) => x.cls === 'DEPARE')!
    expect(dep.attrs).toEqual({ DRVAL1: '5', DRVAL2: '10' })
    expect(dep.geometry).toEqual({ type: 'Polygon', coordinates: [[[-70.25, 43.6], [-70.2, 43.6], [-70.2, 43.63], [-70.25, 43.6]]] })
    expect(c.features.find((x) => x.cls === 'OBJL999')!.geometry).toBeNull()
    expect(c.warnings).toEqual(['OBJL999: an edge it points to is not in the cell'])
  })
})

describe('S-57 off the main thread', () => {
  it('opens a cell on this thread where there are no workers, and rejects what is not one', async () => {
    const { openEncCell } = await import('./s57Client')
    const c = await openEncCell(cell().slice().buffer)
    expect(c.features).toHaveLength(5)
    await expect(openEncCell(new TextEncoder().encode('not a chart, not at all, not even close').buffer)).rejects.toThrow(/ISO 8211/)
  })
})

describe('S-57 updates', () => {
  it('applies an update: attributes set and deleted, records in and out, coordinates and pointers changed', () => {
    const c = decodeS57(cell(), [update3()])
    expect(c.update).toBe('3')
    expect(c.warnings).toEqual([])
    const light = c.features.find((f) => f.cls === 'LIGHTS')!
    expect(light.attrs).toEqual({ COLOUR: '4' })
    // The feature pointing at a missing edge is gone, and with it its warning.
    expect(c.features.some((f) => f.cls === 'OBJL999')).toBe(false)
    const buoy = c.features.find((f) => f.cls === 'BOYLAT')!
    expect(buoy.attrs).toEqual({ COLOUR: '3', BOYSHP: '2' })
    expect(buoy.geometry).toEqual({ type: 'Point', coordinates: [-70.22, 43.63] })
    const ring = (c.features.find((f) => f.cls === 'DEPARE')!.geometry as { coordinates: number[][][] }).coordinates[0]
    expect(ring[2]).toEqual([-70.2, 43.64])
    // The coastline: edge 20 reversed, then edge 21 carried on from node 10.
    const coast = c.features.find((f) => f.cls === 'COALNE')!.geometry as { type: string; coordinates: number[][] }
    expect(coast.type).toBe('LineString')
    expect(coast.coordinates).toHaveLength(6)
    expect(coast.coordinates.at(-1)).toEqual([-70.25, 43.6])
  })

  it('applies updates in their own order, and stops at a gap', () => {
    const next = buoyUpdate('US5ME11M.004', '7', 4, '4')
    const c = decodeS57(cell(), [next, update3()])
    expect(c.update).toBe('4')
    expect(c.features.find((f) => f.cls === 'BOYLAT')!.attrs.COLOUR).toBe('4')
    const gap = decodeS57(cell(), [next])
    expect(gap.update).toBe('2')
    expect(gap.warnings).toContain('update 4 left out: update 3 is missing')
  })

  it('leaves out an update for another cell or edition, and one already in the base', () => {
    const other = decodeS57(cell(), [buoyUpdate('US5ME12M.003', '7', 3, '4')])
    expect(other.update).toBe('2')
    expect(other.warnings).toContain('update US5ME12M.003 is for another cell, not US5ME11M.000')
    const edition = decodeS57(cell(), [buoyUpdate('US5ME11M.003', '8', 3, '4')])
    expect(edition.warnings).toContain('update 3 is for edition 8; this cell is edition 7')
    const old = decodeS57(cell(), [buoyUpdate('US5ME11M.002', '7', 2, '4')])
    expect(old.update).toBe('2')
    expect(old.warnings.filter((w) => w.startsWith('update'))).toEqual([])
  })

  it('knows its compilation scale and where it lies', () => {
    const c = decodeS57(cell())
    expect(c.scale).toBe(20000)
    const b = c.bounds!
    expect(b.west).toBeCloseTo(-70.26, 9)
    expect(b.east).toBeCloseTo(-70.19, 9)
    expect(b.south).toBeCloseTo(43.6, 9)
    expect(b.north).toBeCloseTo(43.65, 9)
  })
})
