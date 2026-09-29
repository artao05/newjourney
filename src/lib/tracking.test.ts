/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from 'vitest'
import { matchTracks, mergeTracks, parseGpxFleet, parseTrackCsv, parseTrackingFile } from './tracking'

const GPX = `<?xml version="1.0"?>
<gpx version="1.1" creator="tracker" xmlns="http://www.topografix.com/GPX/1/1">
  <trk><name>USA 50</name><trkseg>
    <trkpt lat="43.60" lon="-70.20"><time>2026-09-29T14:00:00Z</time></trkpt>
    <trkpt lat="43.61" lon="-70.19"><time>2026-09-29T14:05:00Z</time></trkpt>
    <trkpt lat="43.62" lon="-70.18"></trkpt>
  </trkseg></trk>
  <trk><name>Sea Fever</name><trkseg>
    <trkpt lat="43.58" lon="-70.22"><time>2026-09-29T14:00:00Z</time></trkpt>
  </trkseg></trk>
</gpx>`

describe('race tracking files', () => {
  it('reads a GPX with a track a boat, leaving out fixes with no time', () => {
    const t = parseGpxFleet(GPX)
    expect(t.map((x) => [x.key, x.points.length])).toEqual([['USA 50', 2], ['Sea Fever', 1]])
    expect(t[0].points[1]).toEqual({ t: Date.UTC(2026, 8, 29, 14, 5), lat: 43.61, lon: -70.19 })
  })

  it('reads a CSV of boat, time and position in any column order, with speed and course where given', () => {
    const csv = ['Time;Boat;Latitude;Longitude;SOG;COG', '2026-09-29 14:05:00;Sea Fever;43.59;-70.21;6.2;45', '1790690400;Sea Fever;43.58;-70.22;;', '2026-09-29T14:00:00Z;Wild Horses;43.6;-70.2;5;90', 'bad;row;x;y'].join('\n')
    const t = parseTrackCsv(csv)
    expect(t.map((x) => [x.key, x.points.length])).toEqual([['Sea Fever', 2], ['Wild Horses', 1]])
    // Epoch seconds and a zoneless time, both as UTC, and in time order.
    expect(t[0].points.map((p) => p.t)).toEqual([1790690400_000, Date.UTC(2026, 8, 29, 14, 5)])
    expect(t[0].points[1]).toMatchObject({ sog: 6.2, cog: 45 })
    expect(t[0].points[0].sog).toBeUndefined()
    expect(() => parseTrackCsv('a,b\n1,2')).toThrow(/boat, time, lat and lon/)
  })

  it('tells GPX from CSV, matches each track to a boat, and merges later files in', () => {
    const fleet = [{ id: 'a', name: 'Wild Horses', sailNumber: 'USA-50' }, { id: 'b', name: 'Sea Fever' }]
    const first = matchTracks(parseTrackingFile(GPX), fleet)
    expect(first.map((t) => t.boatId)).toEqual(['a', 'b'])
    const later = matchTracks(parseTrackingFile('boat,time,lat,lon\nUSA 50,2026-09-29T14:10:00Z,43.63,-70.17\nUSA 50,2026-09-29T14:05:00Z,43.61,-70.19'), fleet)
    const merged = mergeTracks(first, later)
    expect(merged.find((t) => t.key === 'USA 50')!.points.map((p) => p.t / 60_000 - Date.UTC(2026, 8, 29, 14) / 60_000)).toEqual([0, 5, 10])
  })
})
