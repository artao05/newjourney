import { describe, expect, it } from 'vitest'
import { notesFromGeoJSON, notesFromText, notesToGeoJSON, type NoteLike } from './raceNotesFile'

const notes: NoteLike[] = [
  { kind: 'point', points: [{ lat: 43.6, lon: -70.2 }], text: 'Committee boat', avoid: false, speedPct: null },
  { kind: 'line', points: [{ lat: 43.6, lon: -70.2 }, { lat: 43.61, lon: -70.21 }], text: 'Channel edge', avoid: false, speedPct: null },
  { kind: 'area', points: [{ lat: 43.6, lon: -70.2 }, { lat: 43.6, lon: -70.19 }, { lat: 43.61, lon: -70.19 }], text: 'Exclusion', avoid: true, speedPct: null },
  { kind: 'area', points: [{ lat: 43.62, lon: -70.2 }, { lat: 43.62, lon: -70.19 }, { lat: 43.63, lon: -70.19 }], text: 'Tide shadow', avoid: false, speedPct: 80 },
]

describe('race note files', () => {
  it('saves notes as GeoJSON and opens them again as they were', () => {
    const gj = notesToGeoJSON(notes)
    expect(JSON.parse(gj).features.map((f: { geometry: { type: string } }) => f.geometry.type)).toEqual(['Point', 'LineString', 'Polygon', 'Polygon'])
    expect(notesFromGeoJSON(gj)).toEqual(notes)
  })

  it('opens anyone’s GeoJSON, names from its properties', () => {
    const fc = JSON.stringify({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: { name: 'Buoy' }, geometry: { type: 'Point', coordinates: [-70.2, 43.6] } }, { type: 'Feature', properties: {}, geometry: { type: 'MultiPolygon', coordinates: [] } }] })
    expect(notesFromGeoJSON(fc)).toEqual([{ kind: 'point', points: [{ lat: 43.6, lon: -70.2 }], text: 'Buoy', avoid: false, speedPct: null }])
  })

  it('reads areas from a text list: a name, then a corner a line', () => {
    const text = ['Area A', '43.60, -70.20', '43 36.0 N, 070 11.4 W', '43.61,-70.19', '', 'Too small', '43.7,-70.1', 'Area C', '43.62,-70.2', '43.62,-70.19', '43.63,-70.19'].join('\n')
    const r = notesFromText(text, true)
    expect(r.notes.map((n) => [n.text, n.points.length, n.avoid])).toEqual([
      ['Area A', 3, true],
      ['Area C', 3, true],
    ])
    expect(r.notes[0].points[1].lon).toBeCloseTo(-70.19, 6)
    expect(r.skipped).toEqual(['Too small'])
  })
})
