/**
 * Expedition's marks CSV, read and written.
 *
 *   mark name, latitude, longitude, mark group name, range circle, comment
 *
 * Only the first three columns are required. Positions may be degrees and decimal
 * minutes with a hemisphere letter ("50 42.69n") or decimal degrees. Writing uses
 * the first form, as Expedition's own examples do, so a file goes back into
 * Expedition unchanged.
 */

import type { LatLon } from '@/lib/types'
import { parseCoordinate } from '@/lib/latlon'
import { bearing, distance } from '@/lib/geo'

export interface CsvMark {
  name: string
  position: LatLon
  folder?: string
  rangeCircleNm?: number
  comment?: string
}

/** Split one CSV line, honouring double quotes and "" inside them. */
export function csvFields(line: string): string[] {
  const out: string[] = []
  let cur = ''
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"'
        i++
      } else if (ch === '"') quoted = false
      else cur += ch
    } else if (ch === '"') quoted = true
    else if (ch === ',') {
      out.push(cur.trim())
      cur = ''
    } else cur += ch
  }
  out.push(cur.trim())
  return out
}

/** Every mark it can read, and how many lines it could not. */
export function parseMarksCsv(text: string): { marks: CsvMark[]; skipped: number } {
  const marks: CsvMark[] = []
  let skipped = 0
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim()) continue
    const f = csvFields(raw)
    const lat = f[1] != null ? parseCoordinate(f[1], 'lat') : null
    const lon = f[2] != null ? parseCoordinate(f[2], 'lon') : null
    if (!f[0] || lat == null || lon == null) {
      skipped++ // a header row lands here too, which is what we want
      continue
    }
    const m: CsvMark = { name: f[0], position: { lat, lon } }
    if (f[3]) m.folder = f[3]
    const rc = Number(f[4])
    if (f[4] && Number.isFinite(rc) && rc > 0) m.rangeCircleNm = rc
    if (f[5]) m.comment = f[5]
    marks.push(m)
  }
  return { marks, skipped }
}

function dmmColumn(deg: number, isLon: boolean): string {
  const hemi = isLon ? (deg < 0 ? 'w' : 'e') : deg < 0 ? 's' : 'n'
  const a = Math.abs(deg)
  let d = Math.floor(a)
  let m = Math.round((a - d) * 60 * 1000) / 1000
  if (m >= 60) {
    d += 1
    m = 0
  }
  return `${String(d).padStart(isLon ? 3 : 2, '0')} ${m.toFixed(3).padStart(6, '0')}${hemi}`
}

const quote = (s: string) => (/[",]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s)

export function marksToCsv(marks: CsvMark[]): string {
  const lines = marks.map((m) =>
    [
      quote(m.name),
      dmmColumn(m.position.lat, false),
      dmmColumn(m.position.lon, true),
      quote(m.folder ?? ''),
      m.rangeCircleNm != null ? String(m.rangeCircleNm) : '',
      quote(m.comment ?? ''),
    ]
      .join(',')
      .replace(/,+$/, ''),
  )
  return lines.join('\n') + '\n'
}

/**
 * Expedition's "Table": the range and bearing from every mark to every other, as
 * a CSV grid to print for the nav table or the sailing instructions.
 */
export function rangeBearingTable(marks: Array<{ name: string; position: LatLon }>): string {
  const head = ['from / to', ...marks.map((m) => quote(m.name))].join(',')
  const rows = marks.map((a) =>
    [
      quote(a.name),
      ...marks.map((b) => {
        if (a === b) return ''
        const brg = String(Math.round(bearing(a.position, b.position)) % 360).padStart(3, '0')
        return `${distance(a.position, b.position).toFixed(2)} nm ${brg}°T`
      }),
    ].join(','),
  )
  return [head, ...rows].join('\n') + '\n'
}
