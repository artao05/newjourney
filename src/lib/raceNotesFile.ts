/**
 * Race notes to and from files: GeoJSON, which other tools read too, and the
 * plain text list of areas a race committee sends (a name line, then one
 * position line a corner, a new name starting the next area).
 */
import { parseLatLon } from './latlon'
import type { LatLon } from './types'

export interface NoteLike {
  kind: 'point' | 'line' | 'area'
  points: LatLon[]
  text: string
  avoid: boolean
  speedPct: number | null
}

const ring = (pts: LatLon[]) => pts.map((p) => [p.lon, p.lat])

/** The notes as a GeoJSON FeatureCollection: points, lines and polygons with their text and effect. */
export function notesToGeoJSON(notes: readonly NoteLike[]): string {
  return JSON.stringify(
    {
      type: 'FeatureCollection',
      features: notes.map((n) => ({
        type: 'Feature',
        properties: { text: n.text, avoid: n.avoid, speedPct: n.speedPct },
        geometry:
          n.kind === 'point'
            ? { type: 'Point', coordinates: [n.points[0].lon, n.points[0].lat] }
            : n.kind === 'line'
              ? { type: 'LineString', coordinates: ring(n.points) }
              : { type: 'Polygon', coordinates: [[...ring(n.points), ring(n.points)[0]]] },
      })),
    },
    null,
    2,
  )
}

const pt = (c: unknown): LatLon | null => (Array.isArray(c) && Number.isFinite(c[0]) && Number.isFinite(c[1]) ? { lat: Number(c[1]), lon: Number(c[0]) } : null)

/** Notes from a GeoJSON file of ours or anyone's: its points, lines and polygons (outer rings). */
export function notesFromGeoJSON(text: string): NoteLike[] {
  const j = JSON.parse(text) as { type?: string; features?: Array<{ properties?: Record<string, unknown>; geometry?: { type: string; coordinates: unknown } }> }
  const feats = j.type === 'FeatureCollection' ? (j.features ?? []) : [j as never]
  const out: NoteLike[] = []
  for (const f of feats) {
    const g = f.geometry
    if (!g) continue
    const p = f.properties ?? {}
    const base = {
      text: String(p.text ?? p.name ?? ''),
      avoid: p.avoid === true,
      speedPct: typeof p.speedPct === 'number' ? p.speedPct : null,
    }
    if (g.type === 'Point') {
      const q = pt(g.coordinates)
      if (q) out.push({ ...base, kind: 'point', points: [q] })
    } else if (g.type === 'LineString') {
      const pts = (g.coordinates as unknown[]).map(pt).filter((x): x is LatLon => !!x)
      if (pts.length >= 2) out.push({ ...base, kind: 'line', points: pts })
    } else if (g.type === 'Polygon') {
      const pts = ((g.coordinates as unknown[][])[0] ?? []).map(pt).filter((x): x is LatLon => !!x)
      // The ring's closing point repeats the first; a note's area closes itself.
      if (pts.length > 1 && pts[0].lat === pts[pts.length - 1].lat && pts[0].lon === pts[pts.length - 1].lon) pts.pop()
      if (pts.length >= 3) out.push({ ...base, kind: 'area', points: pts })
    }
  }
  return out
}

/**
 * Areas from a text list: a line that is not a position names the next area,
 * and each position line after it is a corner. Positions may be in any form
 * parseLatLon reads. An area needs three corners; fewer is left out.
 */
export function notesFromText(text: string, avoid = false): { notes: NoteLike[]; skipped: string[] } {
  const notes: NoteLike[] = []
  const skipped: string[] = []
  let name: string | null = null
  let pts: LatLon[] = []
  const close = () => {
    if (name != null) {
      if (pts.length >= 3) notes.push({ kind: 'area', points: pts, text: name, avoid, speedPct: null })
      else skipped.push(name)
    }
    pts = []
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    const p = parseLatLon(line)
    if (p) {
      if (name == null) name = 'Area'
      pts.push(p)
    } else {
      close()
      name = line
    }
  }
  close()
  return { notes, skipped }
}
