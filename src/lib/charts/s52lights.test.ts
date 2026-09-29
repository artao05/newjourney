import { describe, expect, it } from 'vitest'
import { encDrawFeatures, lightDescription, lightSector, scaleAtZoom } from './s52'
import { distance, bearing } from '../geo'
import type { EncCell, EncFeature } from './s57'

const light = (attrs: Record<string, string>, lon = -70.2, lat = 43.62): EncFeature => ({ objl: 75, cls: 'LIGHTS', prim: 1, attrs, geometry: { type: 'Point', coordinates: [lon, lat] } })
const cell = (features: EncFeature[]): EncCell => ({ name: 'T.000', edition: '1', update: '0', comf: 1e7, somf: 10, scale: 0, bounds: null, features, counts: {}, warnings: [] })

describe('ENC lights', () => {
  it('writes a light as a chart does', () => {
    expect(lightDescription({ LITCHR: '2', SIGGRP: '(2)', COLOUR: '4', SIGPER: '5', HEIGHT: '8', VALNMR: '5' })).toBe('Fl(2)G 5s 8m 5M')
    expect(lightDescription({ LITCHR: '2', SIGGRP: '(1)', COLOUR: '3', SIGPER: '4' })).toBe('Fl R 4s')
    expect(lightDescription({ LITCHR: '4', COLOUR: '1' })).toBe('Q W')
    expect(lightDescription({ LITCHR: '7', COLOUR: '1,3', SIGPER: '6' })).toBe('Iso WR 6s')
    expect(lightDescription({ LITCHR: '1', COLOUR: '3' })).toBe('F R')
    expect(lightDescription({})).toBe('')
  })

  it('draws a sector from the light, its bearings turned round from seaward', () => {
    // Seen from seaward 000° to 090°: from the light, 180° round to 270°.
    const f = light({ SECTR1: '0', SECTR2: '90', COLOUR: '3', VALNMR: '6' })
    const s = lightSector(f, { scale: 20000 })!
    const at = { lat: 43.62, lon: -70.2 }
    const pt = (c: number[]) => ({ lon: c[0], lat: c[1] })
    expect(bearing(at, pt(s.arc[0]))).toBeCloseTo(180, 0)
    expect(bearing(at, pt(s.arc.at(-1)!))).toBeCloseTo(270, 0)
    // 25 mm at 1:20,000 is 500 m.
    expect(distance(at, pt(s.arc[3])) * 1852).toBeCloseTo(500, 0)
    expect(s.colour).toBe('#ff5252')
    // Short legs, or out to the nominal range.
    expect(distance(at, pt(s.legs[0][1])) * 1852).toBeCloseTo(800, 0)
    const full = lightSector(f, { scale: 20000, fullLegs: true, smallSectors: true })!
    expect(distance(at, pt(full.legs[1][1]))).toBeCloseTo(6, 6)
    expect(distance(at, pt(full.arc[0])) * 1852).toBeCloseTo(400, 0)
    // A sector across north.
    const across = lightSector(light({ SECTR1: '150', SECTR2: '210' }), { scale: 20000 })!
    expect(bearing(at, pt(across.arc[0]))).toBeCloseTo(330, 0)
    expect(bearing(at, pt(across.arc.at(-1)!))).toBeCloseTo(30, 0)
    expect(lightSector(light({ COLOUR: '1' }), {})).toBeNull()
  })

  it('knows the scale a zoom shows', () => {
    // 512-pixel tiles: 1.73 m a pixel at zoom 15 at 43.6°N, and 3,779.5 pixels a metre at 96 dpi: 1:6,540.
    expect(scaleAtZoom(15, 43.6)).toBeCloseTo(6538, -1)
    expect(scaleAtZoom(14, 43.6) / scaleAtZoom(15, 43.6)).toBeCloseTo(2, 9)
  })
})

describe('ENC text and clutter', () => {
  const rock = { objl: 153, cls: 'UWTROC', prim: 1, attrs: { OBJNAM: 'Old Anthony', SCAMIN: '10000' }, geometry: { type: 'Point' as const, coordinates: [-70.21, 43.6] as [number, number] } }
  const buoy = { objl: 17, cls: 'BOYLAT', prim: 1, attrs: { OBJNAM: 'G 1', SCAMIN: '10000', COLOUR: '4' }, geometry: { type: 'Point' as const, coordinates: [-70.2, 43.6] as [number, number] } }
  const c = cell([light({ LITCHR: '2', COLOUR: '4', SIGPER: '4', SECTR1: '10', SECTR2: '100' }), rock, buoy])

  it('labels lights and names each on their own switch, and draws sectors', () => {
    const f = encDrawFeatures([c], { safetyDepthM: 3, category: 'all', lightText: true, names: false, sectors: true })
    expect(f.filter((x) => x.properties.layer === 'text').map((x) => x.properties.label)).toEqual(['Fl G 4s'])
    expect(f.filter((x) => x.properties.layer === 'sector').map((x) => x.properties.part)).toEqual(['arc', 'leg', 'leg'])
    const names = encDrawFeatures([c], { safetyDepthM: 3, category: 'all', lightText: false, names: true })
    expect(names.filter((x) => x.properties.layer === 'text').map((x) => x.properties.label)).toEqual(['Old Anthony', 'G 1'])
    expect(names.some((x) => x.properties.layer === 'sector')).toBe(false)
  })

  it('hides detail the scale is too small for, but never a danger', () => {
    const near = encDrawFeatures([c], { safetyDepthM: 3, category: 'all', antiClutter: true, scale: 8000 })
    const far = encDrawFeatures([c], { safetyDepthM: 3, category: 'all', antiClutter: true, scale: 50000 })
    const cls = (f: typeof near) => f.filter((x) => x.properties.layer === 'point').map((x) => x.properties.cls)
    expect(cls(near)).toEqual(['LIGHTS', 'UWTROC', 'BOYLAT'])
    expect(cls(far)).toEqual(['LIGHTS', 'UWTROC'])
    expect(cls(encDrawFeatures([c], { safetyDepthM: 3, category: 'all', antiClutter: false, scale: 50000 }))).toEqual(['LIGHTS', 'UWTROC', 'BOYLAT'])
  })
})
