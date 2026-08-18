/**
 * GPX 1.1 import/export.
 *
 * Non-negotiable per docs/04-prior-art/open-source-landscape.md §7: GPX is the
 * one format every plotter, every app and every race committee can exchange.
 * Being unable to get a course in or a route out is what makes a tool a toy.
 */

import { bearing, distance } from './geo'
import type { LatLon, Mark, RouteResult, TrackPoint } from './types'

const XMLNS = 'http://www.topografix.com/GPX/1/1'

function esc(s: string): string {
  return s.replace(/[<>&'"]/g, (c) =>
    c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '&' ? '&amp;' : c === "'" ? '&apos;' : '&quot;',
  )
}

const f6 = (n: number) => n.toFixed(6)

function header(name: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="newjourney" xmlns="${XMLNS}">
  <metadata><name>${esc(name)}</name><time>${new Date().toISOString()}</time></metadata>
`
}

export function marksToGpx(marks: Mark[], name = 'Course'): string {
  const wpts = marks
    .map(
      (m) =>
        `  <wpt lat="${f6(m.position.lat)}" lon="${f6(m.position.lon)}"><name>${esc(
          m.name,
        )}</name></wpt>`,
    )
    .join('\n')
  const rtepts = marks
    .map(
      (m) =>
        `    <rtept lat="${f6(m.position.lat)}" lon="${f6(m.position.lon)}"><name>${esc(
          m.name,
        )}</name></rtept>`,
    )
    .join('\n')
  return `${header(name)}${wpts}
  <rte><name>${esc(name)}</name>
${rtepts}
  </rte>
</gpx>
`
}

export function trackToGpx(points: TrackPoint[], name = 'Track'): string {
  const pts = points
    .map(
      (p) =>
        `      <trkpt lat="${f6(p.lat)}" lon="${f6(p.lon)}"><time>${new Date(
          p.t,
        ).toISOString()}</time></trkpt>`,
    )
    .join('\n')
  return `${header(name)}  <trk><name>${esc(name)}</name><trkseg>
${pts}
  </trkseg></trk>
</gpx>
`
}

/**
 * A computed route as a GPX track, with each point timestamped at its predicted
 * arrival — so it loads into a plotter as a schedule, not just a shape.
 */
export function routeToGpx(route: RouteResult, name = 'Optimal route'): string {
  const pts = route.legs
    .map(
      (l) =>
        `      <trkpt lat="${f6(l.position.lat)}" lon="${f6(l.position.lon)}">` +
        `<time>${new Date(l.t).toISOString()}</time>` +
        `<desc>TWD ${l.twd.toFixed(0)} TWS ${l.tws.toFixed(1)} TWA ${l.twa.toFixed(
          0,
        )} BSP ${l.bsp.toFixed(2)}${l.isBeating ? ' beating' : ''}</desc></trkpt>`,
    )
    .join('\n')
  return `${header(name)}  <trk><name>${esc(name)}</name><trkseg>
${pts}
  </trkseg></trk>
</gpx>
`
}

export function routeToCsv(route: RouteResult): string {
  const head = 'time_utc,lat,lon,twd,tws,twa,bsp,heading,beating,dist_nm'
  const rows = route.legs.map((l) =>
    [
      new Date(l.t).toISOString(),
      f6(l.position.lat),
      f6(l.position.lon),
      l.twd.toFixed(1),
      l.tws.toFixed(2),
      l.twa.toFixed(1),
      l.bsp.toFixed(3),
      l.heading.toFixed(1),
      l.isBeating ? '1' : '0',
      l.distanceNm.toFixed(3),
    ].join(','),
  )
  return [head, ...rows].join('\n')
}

export interface ParsedGpx {
  waypoints: Array<{ name: string; position: LatLon }>
  trackPoints: TrackPoint[]
  /**
   * Track points dropped because they carried no parseable `<time>`.
   *
   * Reported rather than swallowed: a track is a time series, a point with no
   * time cannot take a place in one, and a caller that imported 500 points and
   * got 380 is entitled to know. Non-zero here is a fact about the file, not an
   * error.
   */
  skippedTrackPoints: number
}

/**
 * Speed and course over ground for an imported track, derived from consecutive
 * fixes.
 *
 * GPX track points carry position and time; speed and course are not in the
 * format. They used to be filled in as `sog: 0, cog: 0`, which is the one thing
 * this codebase says it will never do — a fabricated zero is indistinguishable
 * from a measured one, and a stationary boat pointing due north is a perfectly
 * plausible reading (see the `MISSING`/`null` discipline in `cube.ts`).
 *
 * So they are computed from the geometry, which is real data, and left `NaN`
 * where the geometry cannot supply them: a lone point has no velocity, and
 * `Number.isFinite` guards already exist at every consumer that matters
 * (`startline.ts`, `wind.ts`). The first point borrows the second's, because a
 * forward difference is as valid as a backward one and a leading NaN would be a
 * hole the data does not actually have.
 */
function deriveMotion(pts: Array<{ t: number; lat: number; lon: number }>): TrackPoint[] {
  const out: TrackPoint[] = pts.map((p) => ({ ...p, sog: NaN, cog: NaN }))
  for (let i = 1; i < out.length; i++) {
    const a = pts[i - 1]
    const b = pts[i]
    const dtH = (b.t - a.t) / 3_600_000
    // Non-monotonic or duplicate timestamps make speed meaningless, not zero.
    if (!(dtH > 0)) continue
    const nm = distance(a, b)
    out[i].sog = nm / dtH
    // A fix that has not moved has no bearing to report; NaN, not the last one.
    if (nm > 0) out[i].cog = bearing(a, b)
  }
  if (out.length > 1) {
    out[0].sog = out[1].sog
    out[0].cog = out[1].cog
  }
  return out
}

/**
 * Parse waypoints, route points and track points out of a GPX file.
 * Uses DOMParser, so this is browser-only — which is fine, it is only ever
 * called from a file picker.
 */
export function parseGpx(xml: string): ParsedGpx {
  const doc = new DOMParser().parseFromString(xml, 'application/xml')
  if (doc.querySelector('parsererror')) throw new Error('Not valid XML')

  const waypoints: ParsedGpx['waypoints'] = []
  const readPt = (el: Element) => {
    const lat = Number(el.getAttribute('lat'))
    const lon = Number(el.getAttribute('lon'))
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null
    return { lat, lon }
  }

  // Waypoints and route points both become marks — race committees publish
  // courses as either, and the user does not care which.
  for (const el of Array.from(doc.getElementsByTagName('wpt'))) {
    const p = readPt(el)
    if (p) waypoints.push({ name: el.getElementsByTagName('name')[0]?.textContent ?? 'Mark', position: p })
  }
  for (const el of Array.from(doc.getElementsByTagName('rtept'))) {
    const p = readPt(el)
    if (p) waypoints.push({ name: el.getElementsByTagName('name')[0]?.textContent ?? 'Mark', position: p })
  }

  const timed: Array<{ t: number; lat: number; lon: number }> = []
  let skippedTrackPoints = 0
  for (const el of Array.from(doc.getElementsByTagName('trkpt'))) {
    const p = readPt(el)
    if (!p) continue
    const timeText = el.getElementsByTagName('time')[0]?.textContent
    const t = timeText ? Date.parse(timeText) : NaN
    // A missing time used to become 0, i.e. 1 January 1970 — which does not read
    // as "unknown", it reads as a track that began 56 years ago and makes any
    // replay of it nonsense. Count it out instead.
    if (!Number.isFinite(t)) {
      skippedTrackPoints++
      continue
    }
    timed.push({ t, lat: p.lat, lon: p.lon })
  }
  const trackPoints = deriveMotion(timed)

  // Deduplicate waypoints that appear as both wpt and rtept.
  const seen = new Set<string>()
  const unique = waypoints.filter((w) => {
    const k = `${w.position.lat.toFixed(6)},${w.position.lon.toFixed(6)}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })

  return { waypoints: unique, trackPoints, skippedTrackPoints }
}

/** Trigger a download in the browser. */
export function downloadText(filename: string, text: string, mime = 'application/gpx+xml') {
  const blob = new Blob([text], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}
