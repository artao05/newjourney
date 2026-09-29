/**
 * Race tracking files: the fleet's tracks, each matched to a boat in the boats
 * database by its tracker id, sail number or name.
 *
 * Read: GPX with a track per boat; Expedition's own position lines; the "Basic"
 * text format; Volvo and MaxSea race-office reports; and a plain CSV of boat,
 * time, latitude and longitude (with speed and course where given). YB and
 * Vessel Finder files are not read yet (12.5b).
 */
import { boatByTrackerName, type FleetIdentity } from './fleet'
import { bearing, destination, distance } from './geo'
import type { Millis } from './types'

export interface FleetFix {
  t: Millis
  lat: number
  lon: number
  sog?: number
  cog?: number
}

export interface FleetTrack {
  /** The boat as the file names her. */
  key: string
  /** Her id in the boats database, where one matches. */
  boatId?: string
  points: FleetFix[]
}

/** GPX: each <trk> one boat, named by its <name>, with timed <trkpt>s. */
export function parseGpxFleet(xml: string): FleetTrack[] {
  const doc = new DOMParser().parseFromString(xml, 'application/xml')
  if (doc.querySelector('parsererror')) throw new Error('Not valid XML')
  const out: FleetTrack[] = []
  Array.from(doc.getElementsByTagName('trk')).forEach((trk, i) => {
    const name = Array.from(trk.children).find((c) => c.localName === 'name')?.textContent?.trim() || `Track ${i + 1}`
    const points: FleetFix[] = []
    for (const el of Array.from(trk.getElementsByTagName('trkpt'))) {
      const lat = Number(el.getAttribute('lat'))
      const lon = Number(el.getAttribute('lon'))
      const t = Date.parse(el.getElementsByTagName('time')[0]?.textContent ?? '')
      if (Number.isFinite(lat) && Number.isFinite(lon) && Number.isFinite(t)) points.push({ t, lat, lon })
    }
    if (points.length) out.push({ key: name, points: points.sort((a, b) => a.t - b.t) })
  })
  return out
}

const COLS: Record<string, string[]> = {
  boat: ['boat', 'name', 'boatname', 'id', 'boatid', 'sailno', 'sail', 'tracker'],
  time: ['time', 'timestamp', 'datetime', 'date', 'utc', 'gpsat'],
  lat: ['lat', 'latitude'],
  lon: ['lon', 'lng', 'long', 'longitude'],
  sog: ['sog', 'speed', 'spd'],
  cog: ['cog', 'course', 'heading', 'hdg'],
}

function parseTime(s: string): number {
  const v = s.trim()
  if (/^\d{9,13}(\.\d+)?$/.test(v)) {
    const n = Number(v)
    return n > 1e11 ? n : n * 1000
  }
  // "2026-09-29 14:05:00" with no zone is taken as UTC, as trackers give it.
  const iso = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(v) ? v.replace(' ', 'T') + 'Z' : v
  return Date.parse(iso)
}

/** A CSV (or semicolon or tab separated) of boat, time, lat, lon, and optionally sog and cog. */
export function parseTrackCsv(text: string): FleetTrack[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim())
  if (lines.length < 2) return []
  const sep = [',', ';', '\t'].sort((a, b) => lines[0].split(b).length - lines[0].split(a).length)[0]
  const head = lines[0].split(sep).map((h) => h.trim().toLowerCase().replace(/[^a-z]/g, ''))
  const col = (k: string) => head.findIndex((h) => COLS[k].includes(h))
  const [cb, ct, cla, clo, cs, cc] = ['boat', 'time', 'lat', 'lon', 'sog', 'cog'].map(col)
  if (cb < 0 || ct < 0 || cla < 0 || clo < 0) throw new Error('A tracking CSV needs boat, time, lat and lon columns')
  const by = new Map<string, FleetFix[]>()
  for (const line of lines.slice(1)) {
    const f = line.split(sep)
    const key = (f[cb] ?? '').trim()
    const t = parseTime(f[ct] ?? '')
    const lat = Number(f[cla])
    const lon = Number(f[clo])
    if (!key || !Number.isFinite(t) || !Number.isFinite(lat) || !Number.isFinite(lon)) continue
    const fix: FleetFix = { t, lat, lon }
    // A blank field is missing, not zero (Number('') is 0).
    const num = (i: number) => (i >= 0 && (f[i] ?? '').trim() ? Number(f[i]) : NaN)
    const sog = num(cs)
    const cog = num(cc)
    if (Number.isFinite(sog)) fix.sog = sog
    if (Number.isFinite(cog)) fix.cog = cog
    const list = by.get(key) ?? []
    list.push(fix)
    by.set(key, list)
  }
  return [...by.entries()].map(([key, points]) => ({ key, points: points.sort((a, b) => a.t - b.t) }))
}

function group(fixes: Array<{ key: string } & FleetFix>): FleetTrack[] {
  const by = new Map<string, FleetFix[]>()
  for (const { key, ...f } of fixes) {
    const l = by.get(key) ?? []
    l.push(f)
    by.set(key, l)
  }
  return [...by.entries()].map(([key, points]) => ({ key, points: points.sort((a, b) => a.t - b.t) }))
}

/** Degrees and decimal minutes with a hemisphere: "43 36.25 N", "43°36.25N", "043,36.25N". */
function dm(s: string): number {
  const m = /^\s*(\d{1,3})(?:°|\s+|,)\s*(\d{1,2}(?:\.\d+)?)\s*([NSEW])\s*$/i.exec(s)
  if (!m) return NaN
  const v = Number(m[1]) + Number(m[2]) / 60
  return /[SW]/i.test(m[3]) ? -v : v
}

/** A compact YYMMDDhhmm[ss] time, UTC. */
function compact(s: string): number {
  const m = /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?$/.exec(s.trim())
  return m ? Date.UTC(2000 + Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] ?? 0)) : NaN
}

/**
 * Expedition's own position lines: boat id, latitude, longitude in signed
 * decimal degrees, and optionally a YYMMDDhhmm[ss] time that overrides the
 * file's (from its name, or `fallback`).
 */
export function parseExpeditionPositions(text: string, fallback: number | null = null, fileName = ''): FleetTrack[] {
  const fromName = compact(/(\d{10,12})/.exec(fileName)?.[1] ?? '')
  const base = Number.isFinite(fromName) ? fromName : fallback
  const out: Array<{ key: string } & FleetFix> = []
  for (const line of text.split(/\r?\n/)) {
    const f = line.split(',').map((x) => x.trim())
    if (f.length < 3) continue
    const lat = Number(f[1])
    const lon = Number(f[2])
    const own = f[3] ? compact(f[3]) : NaN
    const t = Number.isFinite(own) ? own : base
    if (!f[0] || !Number.isFinite(lat) || !Number.isFinite(lon) || t == null || !Number.isFinite(t)) continue
    out.push({ key: f[0], t, lat, lon })
  }
  return group(out)
}

/**
 * The "Basic" text format: `Name,dd/mm/yyyy hh:mm:ss[ UTC],DD MM.MM N,DDD MM.MM W`.
 * The date order follows the PC that wrote it, so it is asked for, not guessed.
 */
export function parseBasicPositions(text: string, order: 'dmy' | 'mdy' = 'dmy'): FleetTrack[] {
  const out: Array<{ key: string } & FleetFix> = []
  for (const line of text.split(/\r?\n/)) {
    const f = line.split(',').map((x) => x.trim())
    if (f.length < 4) continue
    const d = /^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?(\s*UTC)?$/i.exec(f[1])
    if (!d) continue
    const [a, b] = [Number(d[1]), Number(d[2])]
    const [day, month] = order === 'dmy' ? [a, b] : [b, a]
    const t = Date.UTC(Number(d[3]), month - 1, day, Number(d[4]), Number(d[5]), Number(d[6] ?? 0))
    const lat = dm(f[2])
    const lon = dm(f[3])
    if (f[0] && Number.isFinite(lat) && Number.isFinite(lon)) out.push({ key: f[0], t, lat, lon })
  }
  return group(out)
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

/**
 * A Volvo Ocean Race office report: `Rank;Boat;Lat;Lon;HHMM;ddMMMyy;WindDir;WindSpeed`,
 * positions as `49,16.74S` (degrees, comma, decimal minutes, hemisphere), UTC;
 * a `POSRELEASE` first line is allowed.
 */
export function parseVolvoPositions(text: string): FleetTrack[] {
  const out: Array<{ key: string } & FleetFix> = []
  for (const line of text.split(/\r?\n/)) {
    const f = line.split(';').map((x) => x.trim())
    if (f.length < 6) continue
    const hm = /^(\d{2})(\d{2})$/.exec(f[4])
    const dt = /^(\d{1,2})([A-Za-z]{3})(\d{2})$/.exec(f[5])
    if (!hm || !dt) continue
    const mon = MONTHS.indexOf(dt[2].toLowerCase())
    if (mon < 0) continue
    const t = Date.UTC(2000 + Number(dt[3]), mon, Number(dt[1]), Number(hm[1]), Number(hm[2]))
    const lat = dm(f[2])
    const lon = dm(f[3])
    if (f[1] && Number.isFinite(lat) && Number.isFinite(lon)) out.push({ key: f[1], t, lat, lon })
  }
  return group(out)
}

/**
 * A MaxSea report: `rank;boat id;lat;lon;date time;...`, positions as
 * `48.2967N` (degrees, then minutes as the fraction's first two digits and
 * the rest their decimals), date and time `MM/dd/yy HH:mm:ss`, UTC; anything
 * after the time is left; a `POSREPORT` first line is allowed.
 */
export function parseMaxSeaPositions(text: string): FleetTrack[] {
  const pos = (s: string) => {
    const m = /^\s*(\d{1,3})\.(\d{2})(\d*)\s*([NSEW])\s*$/i.exec(s)
    if (!m) return NaN
    const v = Number(m[1]) + Number(`${m[2]}.${m[3] || '0'}`) / 60
    return /[SW]/i.test(m[4]) ? -v : v
  }
  const out: Array<{ key: string } & FleetFix> = []
  for (const line of text.split(/\r?\n/)) {
    const f = line.split(';').map((x) => x.trim())
    if (f.length < 5) continue
    const d = /^(\d{1,2})\/(\d{1,2})\/(\d{2})\s+(\d{1,2}):(\d{2}):(\d{2})$/.exec(f[4])
    if (!d) continue
    const t = Date.UTC(2000 + Number(d[3]), Number(d[1]) - 1, Number(d[2]), Number(d[4]), Number(d[5]), Number(d[6]))
    const lat = pos(f[2])
    const lon = pos(f[3])
    if (f[1] && Number.isFinite(lat) && Number.isFinite(lon)) out.push({ key: f[1], t, lat, lon })
  }
  return group(out)
}

/** A tracking file by its content (and, for Expedition's own, its name for the time). */
export function parseTrackingFile(text: string, fileName = '', opts: { dateOrder?: 'dmy' | 'mdy'; fallbackTime?: number | null } = {}): FleetTrack[] {
  const first = text.split(/\r?\n/).find((l) => l.trim())?.trim() ?? ''
  if (/<gpx[\s>]/i.test(text)) return parseGpxFleet(text)
  if (/^POSRELEASE/i.test(first) || /^\d+;[^;]+;\d+,\d/.test(first)) return parseVolvoPositions(text)
  if (/^POSREPORT/i.test(first) || /^rank;\s*boat id/i.test(first)) return parseMaxSeaPositions(text)
  if (/^[^,]+,\s*\d{1,2}\/\d{1,2}\/\d{4}\s/.test(first)) return parseBasicPositions(text, opts.dateOrder)
  if (/^[^,]+,\s*-?\d+(\.\d+)?,\s*-?\d+(\.\d+)?(,|$)/.test(first)) return parseExpeditionPositions(text, opts.fallbackTime ?? null, fileName)
  return parseTrackCsv(text)
}

/** Each track given the boat it belongs to, where the boats database has her. */
export function matchTracks(tracks: FleetTrack[], fleet: FleetIdentity[]): FleetTrack[] {
  return tracks.map((t) => ({ ...t, boatId: t.boatId ?? boatByTrackerName(fleet, t.key)?.id }))
}

/** New fixes into the tracks held: appended by boat, in time order, repeats dropped. */
export function mergeTracks(held: FleetTrack[], add: FleetTrack[]): FleetTrack[] {
  const out = new Map(held.map((t) => [t.key, { ...t, points: [...t.points] }]))
  for (const t of add) {
    const cur = out.get(t.key)
    if (!cur) {
      out.set(t.key, { ...t, points: [...t.points] })
      continue
    }
    const seen = new Set(cur.points.map((p) => p.t))
    for (const p of t.points) if (!seen.has(p.t)) cur.points.push(p)
    cur.points.sort((a, b) => a.t - b.t)
    cur.boatId = cur.boatId ?? t.boatId
  }
  return [...out.values()]
}

// ------------------------------------------------------- the fleet now

export interface FleetNow {
  key: string
  boatId?: string
  position: { lat: number; lon: number }
  /** Carried on from the last fix at its course and speed rather than between fixes. */
  extrapolated: boolean
  /** How old the fix behind this position is, minutes. */
  ageMin: number
}

/**
 * Where a boat is at `t`: between her fixes linearly, or after her last one
 * at the course and speed of her last leg (or its own sog/cog), for up to
 * `maxAheadH`; null before her first fix or beyond that.
 */
export function positionAt(track: FleetTrack, t: number, maxAheadH = 6): FleetNow | null {
  const p = track.points
  if (!p.length || t < p[0].t) return null
  for (let i = 1; i < p.length; i++) {
    if (t <= p[i].t) {
      const a = p[i - 1]
      const b = p[i]
      const f = b.t > a.t ? (t - a.t) / (b.t - a.t) : 1
      return { key: track.key, boatId: track.boatId, position: { lat: a.lat + (b.lat - a.lat) * f, lon: a.lon + (b.lon - a.lon) * f }, extrapolated: false, ageMin: (t - a.t) / 60_000 }
    }
  }
  const last = p[p.length - 1]
  const hours = (t - last.t) / 3_600_000
  if (hours > maxAheadH) return null
  let sog = last.sog
  let cog = last.cog
  if ((sog == null || cog == null) && p.length > 1) {
    const prev = p[p.length - 2]
    const dtH = (last.t - prev.t) / 3_600_000
    if (dtH > 0) {
      const nm = distance(prev, last)
      sog = nm / dtH
      cog = bearing(prev, last)
    }
  }
  const position = sog && cog != null && hours > 0 ? destination(last, cog, sog * hours) : { lat: last.lat, lon: last.lon }
  return { key: track.key, boatId: track.boatId, position, extrapolated: hours > 0, ageMin: hours * 60 }
}

export interface LeaderRow extends FleetNow {
  rangeNm: number | null
  bearing: number | null
  /** Distance to the mark, nm. */
  toMarkNm: number | null
  /** How much nearer the mark she is than we are, nm: positive, she is ahead. */
  aheadNm: number | null
}

/** The fleet at `t`, nearest the mark first, with range and bearing from us and how far each is ahead of us. */
export function leaderboard(tracks: FleetTrack[], t: number, own: { lat: number; lon: number } | null, mark: { lat: number; lon: number } | null): LeaderRow[] {
  const ours = own && mark ? distance(own, mark) : null
  const rows: LeaderRow[] = []
  for (const tr of tracks) {
    const now = positionAt(tr, t)
    if (!now) continue
    const toMarkNm = mark ? distance(now.position, mark) : null
    rows.push({
      ...now,
      rangeNm: own ? distance(own, now.position) : null,
      bearing: own ? bearing(own, now.position) : null,
      toMarkNm,
      aheadNm: ours != null && toMarkNm != null ? ours - toMarkNm : null,
    })
  }
  return rows.sort((a, b) => (a.toMarkNm ?? Infinity) - (b.toMarkNm ?? Infinity) || a.key.localeCompare(b.key))
}
