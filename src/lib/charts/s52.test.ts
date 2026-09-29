import { describe, expect, it } from 'vitest'
import { DEPTH_SHADES, LAND, dim, encDrawFeatures } from './s52'
import { decodeS57, type EncCell } from './s57'
import { cell } from './fixtures/cell'

const area = (d1: number) => ({ objl: 42, cls: 'DEPARE', prim: 3, attrs: { DRVAL1: String(d1) }, geometry: { type: 'Polygon' as const, coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]] as Array<[number, number]>] } })
const contour = (v: number) => ({ objl: 43, cls: 'DEPCNT', prim: 2, attrs: { VALDCO: String(v) }, geometry: { type: 'LineString' as const, coordinates: [[0, 0], [1, 1]] as Array<[number, number]> } })
const made = (features: EncCell['features']): EncCell => ({ name: 'T', edition: '1', update: '0', comf: 1e7, somf: 10, features, counts: {}, warnings: [] })

describe('ENC display', () => {
  it('shades depth areas against the safety depth, and draws the safety contour bold', () => {
    const f = encDrawFeatures([made([area(-1), area(1), area(4), area(30), contour(2), contour(5), contour(10)])], { safetyDepthM: 3 })
    expect(f.filter((x) => x.properties.cls === 'DEPARE').map((x) => x.properties.color)).toEqual([DEPTH_SHADES.drying, DEPTH_SHADES.shallow, DEPTH_SHADES.medium, DEPTH_SHADES.deep])
    // The shallowest contour at or below the safety depth: 5 m for a 3 m boat.
    expect(f.filter((x) => x.properties.cls === 'DEPCNT').map((x) => [x.properties.safety, x.properties.width])).toEqual([[false, 0.8], [true, 2.4], [false, 0.8]])
  })

  it('splits soundings, marking those shallower than the safety depth, and colours points by kind', () => {
    const f = encDrawFeatures([decodeS57(cell())], { safetyDepthM: 5, category: 'all' })
    const s = f.filter((x) => x.properties.layer === 'sounding').map((x) => [x.properties.label, x.properties.shallow])
    expect(s).toEqual([['12.3', false], ['4.5', true]])
    expect(f.find((x) => x.properties.cls === 'LIGHTS')!.properties).toMatchObject({ layer: 'point', color: '#e040fb', name: 'Portland Head Light' })
    expect(f.find((x) => x.properties.cls === 'COALNE')!.properties.layer).toBe('line')
    expect(encDrawFeatures([made([{ objl: 71, cls: 'LNDARE', prim: 3, attrs: {}, geometry: area(0).geometry }])], { safetyDepthM: 3 })[0].properties.color).toBe(LAND)
  })
})

describe('ENC display settings', () => {
  const all = [decodeS57(cell())]
  it('draws Display Base always, Standard over it, and soundings only under All', () => {
    const kinds = (category: 'base' | 'standard' | 'all') => [...new Set(encDrawFeatures(all, { safetyDepthM: 3, category }).map((x) => x.properties.cls ?? x.properties.layer))].sort()
    expect(kinds('base')).toEqual(['COALNE', 'DEPARE'])
    expect(kinds('standard')).toEqual(['COALNE', 'DEPARE', 'LIGHTS'])
    expect(kinds('all')).toEqual(['COALNE', 'DEPARE', 'LIGHTS', 'sounding'])
  })

  it('shades in two colours or four, by the shallow, safety and deep contours', () => {
    const shades = (o: Parameters<typeof encDrawFeatures>[1]) => encDrawFeatures([made([area(1), area(3), area(6), area(20)])], o).map((x) => x.properties.color)
    expect(shades({ safetyDepthM: 5, shallowM: 2, deepM: 10 })).toEqual([DEPTH_SHADES.shallow, DEPTH_SHADES.medium, DEPTH_SHADES.medium, DEPTH_SHADES.deep])
    expect(shades({ safetyDepthM: 5, twoShades: true })).toEqual([DEPTH_SHADES.shallow, DEPTH_SHADES.shallow, DEPTH_SHADES.deep, DEPTH_SHADES.deep])
  })

  it('dims every colour for the night palette', () => {
    expect(dim('#ffffff')).toBe('#595959')
    const night = encDrawFeatures([made([area(20)])], { safetyDepthM: 3, night: true })[0].properties.color
    expect(night).toBe(dim(DEPTH_SHADES.deep))
  })
})
