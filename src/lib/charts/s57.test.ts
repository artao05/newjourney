import { describe, expect, it } from 'vitest'
import { decodeS57 } from './s57'
import { COMF, SOMF, cell } from './fixtures/cell'

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
