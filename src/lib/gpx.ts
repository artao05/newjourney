/**
 * GPX 1.1 import/export.
 *
 * Non-negotiable per docs/04-prior-art/open-source-landscape.md §7: GPX is the
 * one format every plotter, every app and every race committee can exchange.
 * Being unable to get a course in or a route out is what makes a tool a toy.
 */

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

  const trackPoints: TrackPoint[] = []
  for (const el of Array.from(doc.getElementsByTagName('trkpt'))) {
    const p = readPt(el)
    if (!p) continue
    const timeText = el.getElementsByTagName('time')[0]?.textContent
    const t = timeText ? Date.parse(timeText) : NaN
    trackPoints.push({
      t: Number.isFinite(t) ? t : 0,
      lat: p.lat,
      lon: p.lon,
      sog: 0,
      cog: 0,
    })
  }

  // Deduplicate waypoints that appear as both wpt and rtept.
  const seen = new Set<string>()
  const unique = waypoints.filter((w) => {
    const k = `${w.position.lat.toFixed(6)},${w.position.lon.toFixed(6)}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })

  return { waypoints: unique, trackPoints }
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
