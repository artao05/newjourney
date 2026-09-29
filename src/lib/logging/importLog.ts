/**
 * Log import: a CSV log, an NMEA recording or a GPX track, into log rows.
 *
 *   CSV    a time column (`Utc`, `Time`, `Date/Time`), as ISO text or as
 *          spreadsheet days since 1899-12-30, then columns named as channels
 *          are (`Bsp`, `Awa`, `Twd`...), matched without regard to case. Our
 *          own export reads back as it went out.
 *   NMEA   one sentence a line; a row each time RMC or ZDA moves the clock on
 *          a second, holding the latest of everything between.
 *   GPX    track points, with the speed and course between them.
 *
 * Rows come out in time order; lines that cannot be read are counted, not
 * guessed at.
 */

import { CHANNELS } from '@/lib/channels/catalogue'
import { parseGpx } from '@/lib/gpx'
import { checksumFails, decode, parseSentence, type Reading } from '@/lib/instruments/nmea0183'
import { headingTrueOf } from '@/lib/instruments/toBoat'
import type { LogRow } from './logger'

export interface Imported {
  kind: 'csv' | 'nmea' | 'gpx'
  rows: LogRow[]
  skipped: number
  /** CSV columns that are not a channel this app knows. */
  unknownColumns: string[]
}

export class LogImportError extends Error {}

const BY_NAME = new Map<string, string>()
for (const c of CHANNELS) {
  BY_NAME.set(c.name.toLowerCase(), c.id)
  BY_NAME.set(c.id.toLowerCase(), c.id)
}
// Names the catalogue spells differently from how people write them.
BY_NAME.set('lat', 'latitude')
BY_NAME.set('lon', 'longtitude')
BY_NAME.set('longitude', 'longtitude')
BY_NAME.set('hdg', 'heading')

const TIME_COLUMNS = new Set(['utc', 'time', 'date/time', 'datetime', 'timestamp'])

/** Spreadsheet (OLE) days, or ISO text, as milliseconds; NaN if neither. */
export function parseLogTime(cell: string): number {
  const s = cell.trim()
  if (/^\d+(\.\d+)?$/.test(s)) {
    const d = Number(s)
    // Days since 1899-12-30: 25569 is 1970-01-01. Anything smaller is not a date.
    return d > 25569 ? Math.round((d - 25569) * 86_400_000) : NaN
  }
  return Date.parse(s)
}

function splitCsv(line: string): string[] {
  const out: string[] = []
  let cur = ''
  let q = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (q) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"'
        i++
      } else if (ch === '"') q = false
      else cur += ch
    } else if (ch === '"') q = true
    else if (ch === ',') {
      out.push(cur)
      cur = ''
    } else cur += ch
  }
  out.push(cur)
  return out.map((c) => c.trim())
}

export function importCsvLog(text: string): Imported {
  const lines = text.split(/\r?\n/).filter((l) => l.trim())
  if (lines.length < 2) throw new LogImportError('A log needs a header line and at least one row.')
  const head = splitCsv(lines[0].replace(/^[!#]/, ''))
  const timeAt = head.findIndex((h) => TIME_COLUMNS.has(h.toLowerCase()))
  if (timeAt < 0) throw new LogImportError('No time column: the header needs Utc, Time or Date/Time.')
  const cols = head.map((h, i) => (i === timeAt ? null : (BY_NAME.get(h.toLowerCase()) ?? null)))
  const unknownColumns = head.filter((h, i) => i !== timeAt && h && cols[i] == null)
  if (!cols.some(Boolean)) throw new LogImportError('None of the columns is a channel this app knows.')
  const rows: LogRow[] = []
  let skipped = 0
  for (const line of lines.slice(1)) {
    const cells = splitCsv(line)
    const t = parseLogTime(cells[timeAt] ?? '')
    if (!Number.isFinite(t)) {
      skipped++
      continue
    }
    const v: Record<string, number> = {}
    cols.forEach((id, i) => {
      if (!id || cells[i] == null || cells[i] === '') return
      const x = Number(cells[i])
      if (Number.isFinite(x)) v[id] = x
    })
    if (Object.keys(v).length) rows.push({ t, v })
    else skipped++
  }
  return { kind: 'csv', rows: rows.sort((a, b) => a.t - b.t), skipped, unknownColumns }
}

/** A reading's values under the channel ids the log uses. */
export function readingToChannels(r: Reading): Record<string, number> {
  const pairs: Array<[string, number | null | undefined]> = [
    ['latitude', r.lat],
    ['longtitude', r.lon],
    ['sog', r.sog],
    ['cog', r.cog],
    ['heading', headingTrueOf(r)],
    ['bsp', r.bsp],
    ['awa', r.awa],
    ['aws', r.aws],
    ['twa', r.twa],
    ['tws', r.tws],
    ['twd', r.twd],
    ['depth', r.depthM],
    ['sea-temperature', r.waterTempC],
    ['air-temperature', r.airTempC],
    ['barometer', r.baroHpa],
    ['heel-roll', r.heel],
    ['trim-pitch', r.pitch],
    ['rudder', r.rudder],
    ['gps-hdop', r.hdop],
    ['magnetic-variation', r.variation],
  ]
  const v: Record<string, number> = {}
  for (const [k, x] of pairs) if (x != null && Number.isFinite(x)) v[k] = x
  return v
}

export function importNmeaLog(text: string): Imported {
  const reading: Reading = {}
  const rows: LogRow[] = []
  let second: number | null = null
  let skipped = 0
  // Each second's row is the latest of everything as that second ends, so it is
  // written when the clock moves on, and once more at the end of the file.
  const emit = () => {
    if (second == null) return
    const v = readingToChannels(reading)
    if (Object.keys(v).length) rows.push({ t: second * 1000, v })
  }
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim().startsWith('$')) continue
    const s = parseSentence(line)
    if (!s) {
      if (checksumFails(line)) skipped++
      continue
    }
    const r = decode(s)
    if (!r) continue
    if (r.utc != null) {
      const sec = Math.floor(r.utc / 1000)
      if (sec !== second) {
        emit()
        second = sec
      }
    }
    Object.assign(reading, r)
  }
  emit()
  if (rows.length === 0) throw new LogImportError('No timed sentences: an NMEA log needs RMC or ZDA for its clock.')
  return { kind: 'nmea', rows, skipped, unknownColumns: [] }
}

export function importGpxLog(text: string): Imported {
  const g = parseGpx(text)
  if (g.trackPoints.length === 0) throw new LogImportError('That GPX has no timed track points.')
  const rows = g.trackPoints.map((p) => {
    const v: Record<string, number> = { latitude: p.lat, longtitude: p.lon }
    if (Number.isFinite(p.sog)) v.sog = p.sog
    if (Number.isFinite(p.cog)) v.cog = p.cog
    return { t: p.t, v }
  })
  return { kind: 'gpx', rows, skipped: g.skippedTrackPoints, unknownColumns: [] }
}

/** Picks the reader by the file's name, then by what is in it. */
export function importLog(fileName: string, text: string): Imported {
  const name = fileName.toLowerCase()
  if (name.endsWith('.gpx') || /^\s*<\?xml|<gpx[\s>]/.test(text.slice(0, 200))) return importGpxLog(text)
  const first = text.split(/\r?\n/).find((l) => l.trim()) ?? ''
  if (first.trim().startsWith('$')) return importNmeaLog(text)
  return importCsvLog(text)
}
