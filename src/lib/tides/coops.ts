/**
 * NOAA CO-OPS tidal current predictions.
 *
 * Why this exists at all: the Weather tab's current arrows come from Open-Meteo's
 * global ocean model, and over Casco Bay that model gives 0.05-0.54 kn with
 * **zero direction reversals across 48 hours**. It is resolving residual ocean
 * drift, not tide. NOAA's harmonic prediction for the same water at the same hour
 * gives 1.15 kn ebbing and turns roughly every six hours. A "when does the current
 * turn" answer cannot be derived from the model we already fetch — it has to come
 * from here.
 *
 * See docs/02-data-sources/tides-and-currents.md §1 for the API, and
 * docs/02-data-sources/portland-maine-pilot.md for the station ids and the rule
 * that these are harmonic predictions, never live sensors.
 *
 * No key and no proxy: the endpoint sends permissive CORS headers, so this runs
 * straight from the browser.
 */

import type { Degrees, Knots, Millis } from '@/lib/types'

const BASE = 'https://api.tidesandcurrents.noaa.gov/api/prod/datagetter'

/**
 * NOAA asks callers to identify themselves so they can see who is generating
 * load. Required by the pilot doc; do not drop it.
 */
const APPLICATION = 'newjourney'

/** One point on the predicted current curve. */
export interface CurrentPoint {
  t: Millis
  /** Signed along the flood/ebb axis: positive floods, negative ebbs. */
  kn: Knots
}

export type CurrentEventType = 'slack' | 'flood' | 'ebb'

/** A turn of the tide, or a peak between turns. */
export interface CurrentEvent {
  t: Millis
  type: CurrentEventType
  kn: Knots
}

export interface CurrentPrediction {
  stationId: string
  /** Direction the water flows on the flood, degrees true. */
  floodDir: Degrees
  ebbDir: Degrees
  /** 6-minute series, ascending in time. */
  series: CurrentPoint[]
  /** Slack and peak events as published by NOAA, ascending in time. */
  events: CurrentEvent[]
  fetchedAt: Millis
}

// ------------------------------------------------------------------ parsing

/**
 * NOAA returns `'YYYY-MM-DD HH:mm'` with the zone decided by the `time_zone`
 * parameter, and no offset in the string. We always ask for GMT, so this must be
 * parsed as UTC explicitly — `new Date('2026-08-05 03:05')` is treated as *local*
 * time by every engine, which would silently shift every slack time by the
 * machine's offset. Four hours of error in Maine, and it would look plausible.
 */
export function parseCoopsTime(s: string): Millis {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(s)
  if (!m) return NaN
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5])
}

interface RawCp {
  Time?: string
  Velocity_Major?: number | string
  Type?: string
  meanFloodDir?: number | string
  meanEbbDir?: number | string
}

const num = (v: unknown): number => (typeof v === 'number' ? v : Number(v))

function normaliseType(raw: string | undefined): CurrentEventType | null {
  const s = (raw ?? '').trim().toLowerCase()
  if (s === 'slack') return 'slack'
  if (s === 'flood') return 'flood'
  if (s === 'ebb') return 'ebb'
  return null
}

/** Pull the `cp` array out of a response, or explain why we cannot. */
function readCp(body: unknown, what: string): RawCp[] {
  if (!body || typeof body !== 'object') throw new Error(`${what}: response was not an object`)
  const b = body as Record<string, unknown>
  // A bad station or date range comes back 200 with an error object, so this has
  // to be checked before looking for data.
  const err = b.error as { message?: string } | undefined
  if (err?.message) throw new Error(`${what}: NOAA said "${err.message.trim()}"`)
  const wrap = b.current_predictions as { cp?: unknown } | undefined
  const cp = wrap?.cp
  if (!Array.isArray(cp)) throw new Error(`${what}: no current_predictions.cp array`)
  if (cp.length === 0) throw new Error(`${what}: NOAA returned an empty prediction`)
  return cp as RawCp[]
}

/** Flood/ebb axis directions, which NOAA repeats on every row. */
function readDirections(cp: RawCp[]): { floodDir: Degrees; ebbDir: Degrees } {
  for (const row of cp) {
    const f = num(row.meanFloodDir)
    const e = num(row.meanEbbDir)
    if (Number.isFinite(f) && Number.isFinite(e)) return { floodDir: f, ebbDir: e }
  }
  throw new Error('no meanFloodDir/meanEbbDir on any row')
}

export function parseSeries(body: unknown): {
  series: CurrentPoint[]
  floodDir: Degrees
  ebbDir: Degrees
} {
  const cp = readCp(body, 'current series')
  const { floodDir, ebbDir } = readDirections(cp)
  const series: CurrentPoint[] = []
  for (const row of cp) {
    const t = parseCoopsTime(row.Time ?? '')
    const kn = num(row.Velocity_Major)
    if (!Number.isFinite(t) || !Number.isFinite(kn)) continue
    series.push({ t, kn })
  }
  if (series.length === 0) throw new Error('current series: no parseable rows')
  series.sort((a, b) => a.t - b.t)
  return { series, floodDir, ebbDir }
}

export function parseEvents(body: unknown): CurrentEvent[] {
  const cp = readCp(body, 'current events')
  const events: CurrentEvent[] = []
  for (const row of cp) {
    const t = parseCoopsTime(row.Time ?? '')
    const type = normaliseType(row.Type)
    const kn = num(row.Velocity_Major)
    if (!Number.isFinite(t) || !type) continue
    events.push({ t, type, kn: Number.isFinite(kn) ? kn : 0 })
  }
  events.sort((a, b) => a.t - b.t)
  return events
}

// -------------------------------------------------------------- interrogation

/**
 * Signed velocity at an arbitrary time, linearly interpolated.
 *
 * Returns null outside the predicted window rather than clamping to the nearest
 * end — a flat line extending past the data would read as "slack for hours".
 */
export function velocityAt(p: CurrentPrediction, t: Millis): Knots | null {
  const s = p.series
  if (s.length === 0 || t < s[0].t || t > s[s.length - 1].t) return null
  // Binary search; the series is 6-minute and can run to hundreds of points.
  let lo = 0
  let hi = s.length - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (s[mid].t <= t) lo = mid
    else hi = mid
  }
  const span = s[hi].t - s[lo].t
  if (span <= 0) return s[lo].kn
  const f = (t - s[lo].t) / span
  return s[lo].kn + (s[hi].kn - s[lo].kn) * f
}

/**
 * Direction the water is flowing at a time, plus a word for it.
 *
 * At a reversing station the harmonic prediction is one signed number along a
 * fixed axis, so the direction is binary: the flood bearing or the ebb bearing.
 * It is not a continuously rotating vector, and presenting it as one would invent
 * precision the model does not contain.
 */
export function flowAt(
  p: CurrentPrediction,
  t: Millis,
  slackBelowKn = 0.1,
): { kn: Knots; dir: Degrees; label: 'flood' | 'ebb' | 'slack' } | null {
  const v = velocityAt(p, t)
  if (v == null) return null
  if (Math.abs(v) < slackBelowKn) {
    return { kn: Math.abs(v), dir: v >= 0 ? p.floodDir : p.ebbDir, label: 'slack' }
  }
  return v >= 0
    ? { kn: v, dir: p.floodDir, label: 'flood' }
    : { kn: -v, dir: p.ebbDir, label: 'ebb' }
}

/** The next turn of the tide at or after `t`. */
export function nextSlack(p: CurrentPrediction, t: Millis): CurrentEvent | null {
  return p.events.find((e) => e.type === 'slack' && e.t >= t) ?? null
}

// ------------------------------------------------------------------ fetching

function ymd(d: Date): string {
  return (
    `${d.getUTCFullYear()}` +
    `${String(d.getUTCMonth() + 1).padStart(2, '0')}` +
    `${String(d.getUTCDate()).padStart(2, '0')}`
  )
}

function url(params: Record<string, string>): string {
  return `${BASE}?${new URLSearchParams({
    application: APPLICATION,
    format: 'json',
    time_zone: 'gmt',
    // english gives "feet, knots"; metric would give cm/s, which nobody sails in.
    units: 'english',
    product: 'currents_predictions',
    ...params,
  })}`
}

async function getJson(u: string, what: string, signal?: AbortSignal): Promise<unknown> {
  const res = await fetch(u, { signal })
  if (!res.ok) throw new Error(`${what}: HTTP ${res.status} from NOAA CO-OPS`)
  const text = await res.text()
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new Error(`${what}: NOAA returned a non-JSON body (${text.slice(0, 80)})`)
  }
}

export interface FetchCurrentOptions {
  stationId: string
  /** Window start; defaults to the start of the current UTC day. */
  beginDate?: Date
  rangeHours?: number
  signal?: AbortSignal
}

const cache = new Map<string, Promise<CurrentPrediction>>()

/**
 * Fetch a station's predicted current: the 6-minute curve and NOAA's own slack
 * and peak events.
 *
 * Two requests rather than deriving the turns from zero crossings of the curve.
 * NOAA publishes the slack times; re-deriving them from a 6-minute sample would
 * disagree with the printed tables by a few minutes for no benefit, and the event
 * `Type` labels come free.
 */
export function fetchCurrentPrediction(o: FetchCurrentOptions): Promise<CurrentPrediction> {
  const begin = o.beginDate ?? new Date()
  const rangeHours = o.rangeHours ?? 48
  const key = `${o.stationId}|${ymd(begin)}|${rangeHours}`
  const hit = cache.get(key)
  if (hit) return hit

  const pending = (async (): Promise<CurrentPrediction> => {
    const common = { station: o.stationId, begin_date: ymd(begin), range: String(rangeHours) }
    const [seriesBody, eventsBody] = await Promise.all([
      getJson(url(common), 'current series', o.signal),
      getJson(url({ ...common, interval: 'MAX_SLACK' }), 'current events', o.signal),
    ])
    const { series, floodDir, ebbDir } = parseSeries(seriesBody)
    // Events are the nice-to-have: a station with a curve but no published slack
    // table is still worth charting, so this must not sink the whole request.
    let events: CurrentEvent[] = []
    try {
      events = parseEvents(eventsBody)
    } catch {
      events = []
    }
    return { stationId: o.stationId, floodDir, ebbDir, series, events, fetchedAt: Date.now() }
  })().catch((e) => {
    // Never cache a failure — a dropped connection should be retryable.
    cache.delete(key)
    throw e
  })

  cache.set(key, pending)
  return pending
}

/** Testing seam. */
export function clearCurrentPredictionCache(): void {
  cache.clear()
}
