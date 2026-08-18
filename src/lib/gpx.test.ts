/**
 * GPX and CSV interchange.
 *
 * This module is the contract with every plotter, every other app and every race
 * committee, and it had no tests at all. The ones that matter most here are not
 * the happy-path round trips — they are the two places the parser used to invent
 * data it did not have, because a fabricated reading is indistinguishable from a
 * measured one once it is in the app.
 *
 * `parseGpx` needs a DOM, so these run under jsdom (see the pragma below) while
 * the rest of the suite stays in plain Node.
 *
 * @vitest-environment jsdom
 */

import { describe, expect, it } from 'vitest'
import {
  marksToGpx,
  parseGpx,
  routeToCsv,
  routeToGpx,
  trackToGpx,
} from './gpx'
import type { Mark, RouteResult, TrackPoint } from './types'

const mark = (name: string, lat: number, lon: number): Mark => ({
  id: name,
  name,
  position: { lat, lon },
  roundTo: 'port',
})

const T0 = Date.UTC(2026, 7, 6, 12, 0, 0)

/** A GPX document with one track, built from `[timeOffsetS | null, lat, lon]` rows. */
function trackDoc(rows: Array<[number | null, number, number]>): string {
  const pts = rows
    .map(([dt, lat, lon]) => {
      const time = dt === null ? '' : `<time>${new Date(T0 + dt * 1000).toISOString()}</time>`
      return `<trkpt lat="${lat}" lon="${lon}">${time}</trkpt>`
    })
    .join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1">
  <trk><name>t</name><trkseg>
${pts}
  </trkseg></trk>
</gpx>`
}

describe('marksToGpx', () => {
  it('round-trips through the parser', () => {
    const marks = [mark('Start', 43.655, -70.205), mark('Windward', 43.68, -70.19)]
    const parsed = parseGpx(marksToGpx(marks, 'Course A'))
    expect(parsed.waypoints).toHaveLength(2)
    expect(parsed.waypoints[0].name).toBe('Start')
    expect(parsed.waypoints[0].position.lat).toBeCloseTo(43.655, 6)
    expect(parsed.waypoints[1].position.lon).toBeCloseTo(-70.19, 6)
  })

  it('writes each mark as both a waypoint and a route point, and dedupes on the way back', () => {
    // Committees publish courses as either, so we emit both — which means the
    // parser must not hand back every mark twice.
    const gpx = marksToGpx([mark('Pin', 43.6, -70.2)])
    expect(gpx).toContain('<wpt')
    expect(gpx).toContain('<rtept')
    expect(parseGpx(gpx).waypoints).toHaveLength(1)
  })

  it('escapes XML metacharacters in names rather than emitting broken XML', () => {
    const gpx = marksToGpx([mark('Ben & "Jerry" <1>', 43.6, -70.2)], 'A & B')
    expect(gpx).toContain('&amp;')
    expect(gpx).not.toMatch(/<name>Ben & /)
    // The real assertion: it still parses, and the name survives intact.
    const parsed = parseGpx(gpx)
    expect(parsed.waypoints[0].name).toBe('Ben & "Jerry" <1>')
  })

  it('rejects a file that is not XML instead of returning nothing', () => {
    expect(() => parseGpx('this is not xml at all')).toThrow(/valid XML/i)
  })
})

describe('parseGpx track points', () => {
  it('derives speed and course from consecutive fixes', () => {
    /*
     * One degree of latitude is 60 nm by definition, so 0.01° in 36 s is
     * 0.6 nm in 0.01 h = 60 kn — an absurd boat speed, and exactly why it is a
     * good test: the number is unambiguous.
     */
    const parsed = parseGpx(
      trackDoc([
        [0, 43.6, -70.2],
        [36, 43.61, -70.2],
      ]),
    )
    expect(parsed.trackPoints).toHaveLength(2)
    expect(parsed.trackPoints[1].sog).toBeCloseTo(60, 1)
    expect(parsed.trackPoints[1].cog).toBeCloseTo(0, 1) // due north
    // The first point borrows the second's rather than reading as stationary.
    expect(parsed.trackPoints[0].sog).toBeCloseTo(60, 1)
  })

  it('reports NaN, never 0, where the geometry cannot supply a velocity', () => {
    /*
     * The defect this file exists for. A GPX track carries position and time and
     * nothing else; speed and course used to be filled in as 0, and "stationary,
     * heading due north" is a perfectly plausible-looking reading. A hole has to
     * stay a hole — the same rule `cube.ts` applies to forecast gaps.
     */
    const single = parseGpx(trackDoc([[0, 43.6, -70.2]]))
    expect(single.trackPoints).toHaveLength(1)
    expect(single.trackPoints[0].sog).toBeNaN()
    expect(single.trackPoints[0].cog).toBeNaN()

    // A fix that has not moved has a speed of zero but no bearing to report.
    const stationary = parseGpx(
      trackDoc([
        [0, 43.6, -70.2],
        [60, 43.6, -70.2],
      ]),
    )
    expect(stationary.trackPoints[1].sog).toBe(0)
    expect(stationary.trackPoints[1].cog).toBeNaN()
  })

  it('does not compute a speed across a duplicate or backwards timestamp', () => {
    const parsed = parseGpx(
      trackDoc([
        [60, 43.6, -70.2],
        [60, 43.61, -70.2], // same instant
        [0, 43.62, -70.2], // earlier than its predecessor
      ]),
    )
    expect(parsed.trackPoints[1].sog).toBeNaN()
    expect(parsed.trackPoints[2].sog).toBeNaN()
  })

  it('skips a timeless point and says how many it skipped', () => {
    /*
     * A missing <time> used to become epoch 0. That does not read as "unknown",
     * it reads as a track that started on 1 January 1970, and any replay built
     * on it spans 56 years.
     */
    const parsed = parseGpx(
      trackDoc([
        [0, 43.6, -70.2],
        [null, 43.61, -70.2],
        [60, 43.62, -70.2],
      ]),
    )
    expect(parsed.trackPoints).toHaveLength(2)
    expect(parsed.skippedTrackPoints).toBe(1)
    for (const p of parsed.trackPoints) expect(p.t).toBeGreaterThan(T0 - 1)
  })

  it('reports zero skips for a clean file', () => {
    const parsed = parseGpx(trackDoc([[0, 43.6, -70.2]]))
    expect(parsed.skippedTrackPoints).toBe(0)
  })

  it('ignores a point with no usable coordinates', () => {
    const bad = `<?xml version="1.0"?><gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1">
      <trk><trkseg><trkpt lat="not-a-number" lon="-70.2"><time>${new Date(
        T0,
      ).toISOString()}</time></trkpt></trkseg></trk></gpx>`
    const parsed = parseGpx(bad)
    expect(parsed.trackPoints).toHaveLength(0)
    // Not a skipped *time* — it never got as far as having one.
    expect(parsed.skippedTrackPoints).toBe(0)
  })
})

describe('trackToGpx', () => {
  it('round-trips a recorded track back to the same positions and times', () => {
    const track: TrackPoint[] = [
      { t: T0, lat: 43.6, lon: -70.2, sog: 5.1, cog: 10 },
      { t: T0 + 60_000, lat: 43.61, lon: -70.19, sog: 5.4, cog: 12 },
    ]
    const parsed = parseGpx(trackToGpx(track, 'Race 1'))
    expect(parsed.trackPoints).toHaveLength(2)
    expect(parsed.trackPoints[0].t).toBe(T0)
    expect(parsed.trackPoints[1].lat).toBeCloseTo(43.61, 6)
    // sog/cog are not in GPX, so they come back derived rather than as recorded.
    expect(parsed.trackPoints[1].sog).toBeGreaterThan(0)
  })
})

describe('route export', () => {
  const route = {
    ok: true,
    legs: [
      {
        t: T0,
        position: { lat: 43.6, lon: -70.2 },
        twd: 225,
        tws: 12.3,
        twa: -42,
        bsp: 6.12,
        heading: 183,
        isBeating: true,
        tack: 'port' as const,
        currentSet: null,
        currentDrift: null,
        distanceNm: 0.5,
      },
    ],
    etaMs: T0 + 3_600_000,
    elapsedS: 3600,
    directTimeS: 4000,
    isochrones: [],
    reverseIsochrones: [],
    sensitivity: null,
    diagnostics: { nodesExplored: 1, timeStepS: 600, computeMs: 5, warnings: [] },
  } satisfies RouteResult

  it('timestamps each leg so a plotter loads it as a schedule', () => {
    const parsed = parseGpx(routeToGpx(route))
    expect(parsed.trackPoints[0].t).toBe(T0)
  })

  it('carries the per-leg numbers in the description', () => {
    expect(routeToGpx(route)).toContain('TWD 225 TWS 12.3 TWA -42 BSP 6.12 beating')
  })

  it('writes a CSV whose header matches its rows', () => {
    const csv = routeToCsv(route)
    const [head, ...rows] = csv.split('\n')
    expect(rows).toHaveLength(route.legs.length)
    for (const r of rows) expect(r.split(',')).toHaveLength(head.split(',').length)
    expect(head.split(',')[0]).toBe('time_utc')
    expect(rows[0]).toContain('2026-08-06T12:00:00.000Z')
  })
})
