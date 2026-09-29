/**
 * Weather observations: what buoys, airports and tide stations measured, to set
 * against the forecast.
 *
 *   NDBC     realtime2 "standard meteorological" text, one file per buoy, newest first
 *   METAR    raw aviation reports, as aviationweather.gov gives them
 *   CO-OPS   NOS tide stations' wind and pressure, as its data API returns JSON
 *
 * Everything comes out in the app's units: knots, degrees true that the wind
 * comes from, hPa, °C, metres. A value a report does not give is null, never 0.
 */

export type ObsSource = 'ndbc' | 'metar' | 'coops'

export interface Observation {
  source: ObsSource
  station: string
  t: number
  twd: number | null
  tws: number | null
  gust: number | null
  /** Sea-level pressure. */
  pres: number | null
  airTemp: number | null
  dewPoint: number | null
  seaTemp: number | null
  /** Significant wave height, and dominant period. */
  hs: number | null
  period: number | null
  /** Visibility, nautical miles. */
  visNm: number | null
  /** The report as received, for a METAR. */
  raw?: string
}

const MS_TO_KN = 1.9438445
const SM_TO_NM = 0.868976
const M_TO_NM = 1 / 1852

function blank(source: ObsSource, station: string, t: number): Observation {
  return { source, station, t, twd: null, tws: null, gust: null, pres: null, airTemp: null, dewPoint: null, seaTemp: null, hs: null, period: null, visNm: null }
}

// ------------------------------------------------------------------- NDBC

/** An NDBC realtime2 .txt file, oldest first. `MM` is missing. */
export function parseNdbc(text: string, station: string): Observation[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim())
  const header = lines.find((l) => l.startsWith('#'))
  if (!header) return []
  const cols = header.replace(/^#/, '').trim().split(/\s+/)
  const idx = (name: string) => cols.indexOf(name)
  const num = (f: string[], name: string) => {
    const i = idx(name)
    if (i < 0 || f[i] == null || f[i] === 'MM') return null
    const v = Number(f[i])
    return Number.isFinite(v) ? v : null
  }
  const out: Observation[] = []
  for (const l of lines) {
    if (l.startsWith('#')) continue
    const f = l.trim().split(/\s+/)
    const year = num(f, 'YY') ?? num(f, 'YYYY')
    const [mo, dy, hr, mn] = ['MM', 'DD', 'hh', 'mm'].map((c) => Number(f[idx(c)]))
    if (year == null || ![mo, dy, hr].every(Number.isFinite)) continue
    const o = blank('ndbc', station, Date.UTC(year < 100 ? 2000 + year : year, mo - 1, dy, hr, Number.isFinite(mn) ? mn : 0))
    o.twd = num(f, 'WDIR')
    const ws = num(f, 'WSPD')
    const gs = num(f, 'GST')
    o.tws = ws == null ? null : ws * MS_TO_KN
    o.gust = gs == null ? null : gs * MS_TO_KN
    o.hs = num(f, 'WVHT')
    o.period = num(f, 'DPD')
    o.pres = num(f, 'PRES')
    o.airTemp = num(f, 'ATMP')
    o.seaTemp = num(f, 'WTMP')
    o.dewPoint = num(f, 'DEWP')
    o.visNm = num(f, 'VIS')
    out.push(o)
  }
  return out.sort((a, b) => a.t - b.t)
}

// ------------------------------------------------------------------ METAR

/**
 * One raw METAR. Its time gives only the day of the month, so `ref` (when it
 * was fetched) supplies the month: a day later than today is last month's.
 */
export function parseMetar(raw: string, ref: number): Observation | null {
  const text = raw.trim().replace(/\s+/g, ' ')
  const tokens = text.split(' ')
  let i = 0
  if (tokens[i] === 'METAR' || tokens[i] === 'SPECI') i++
  const station = tokens[i++]
  const when = /^(\d{2})(\d{2})(\d{2})Z$/.exec(tokens[i] ?? '')
  if (!station || !/^[A-Z0-9]{4}$/.test(station) || !when) return null
  i++
  const r = new Date(ref)
  let y = r.getUTCFullYear()
  let m = r.getUTCMonth()
  const day = Number(when[1])
  if (day > r.getUTCDate() + 1) {
    m -= 1
    if (m < 0) {
      m = 11
      y -= 1
    }
  }
  const o = blank('metar', station, Date.UTC(y, m, day, Number(when[2]), Number(when[3])))
  o.raw = text
  // "1 1/2SM" is one visibility in two tokens.
  const body = text.split(' RMK ')[0].replace(/ (\d) (\d\/\dSM)/, ' $1_$2').split(' ')
  for (const tok of body.slice(i)) {
    const wind = /^(\d{3}|VRB)(\d{2,3})(?:G(\d{2,3}))?(KT|MPS|KMH)$/.exec(tok)
    if (wind) {
      const k = wind[4] === 'KT' ? 1 : wind[4] === 'MPS' ? MS_TO_KN : 1 / 1.852
      o.twd = wind[1] === 'VRB' || Number(wind[2]) === 0 ? null : Number(wind[1])
      o.tws = Number(wind[2]) * k
      o.gust = wind[3] ? Number(wind[3]) * k : null
      continue
    }
    const sm = /^(M)?(\d+)?(?:_?(\d)\/(\d))?SM$/.exec(tok)
    if (sm && (sm[2] || sm[3])) {
      const whole = sm[2] ? Number(sm[2]) : 0
      const frac = sm[3] ? Number(sm[3]) / Number(sm[4]) : 0
      o.visNm = (whole + frac) * SM_TO_NM
      continue
    }
    if (/^\d{4}$/.test(tok) && o.visNm == null && o.tws != null) {
      // Metres, as the rest of the world reports it; 9999 is 10 km or more.
      o.visNm = Number(tok) * M_TO_NM
      continue
    }
    const td = /^(M)?(\d{2})\/(M)?(\d{2})?$/.exec(tok)
    if (td) {
      o.airTemp = (td[1] ? -1 : 1) * Number(td[2])
      o.dewPoint = td[4] != null ? (td[3] ? -1 : 1) * Number(td[4]) : null
      continue
    }
    const alt = /^A(\d{4})$/.exec(tok)
    if (alt) {
      o.pres ??= (Number(alt[1]) / 100) * 33.8639
      continue
    }
    const q = /^Q(\d{4})$/.exec(tok)
    if (q) o.pres = Number(q[1])
  }
  // Remarks: sea-level pressure and temperatures to a tenth, where they are given.
  const rmk = text.split(' RMK ')[1] ?? ''
  const slp = /\bSLP(\d{3})\b/.exec(rmk)
  if (slp) {
    const v = Number(slp[1]) / 10
    o.pres = v + (v < 50 ? 1000 : 900)
  }
  const tt = /\bT([01])(\d{3})([01])(\d{3})\b/.exec(rmk)
  if (tt) {
    o.airTemp = (tt[1] === '1' ? -1 : 1) * (Number(tt[2]) / 10)
    o.dewPoint = (tt[3] === '1' ? -1 : 1) * (Number(tt[4]) / 10)
  }
  return o
}

/** Several METARs, one a line, oldest first. */
export function parseMetars(text: string, ref: number): Observation[] {
  return text
    .split(/\r?\n/)
    .map((l) => parseMetar(l, ref))
    .filter((o): o is Observation => o != null)
    .sort((a, b) => a.t - b.t)
}

// ----------------------------------------------------------------- CO-OPS

interface CoopsRow {
  t: string
  s?: string
  d?: string
  g?: string
  v?: string
}

/**
 * CO-OPS data API JSON for `product=wind` (in knots, `units=english`) and,
 * optionally, `product=air_pressure` (hPa, `units=metric`), merged by time.
 * Times are GMT when asked for with `time_zone=gmt`.
 */
export function parseCoops(station: string, wind: unknown, pressure?: unknown): Observation[] {
  const rows = (x: unknown): CoopsRow[] => {
    const d = (x as { data?: unknown } | null)?.data
    return Array.isArray(d) ? (d as CoopsRow[]) : []
  }
  const time = (s: string) => Date.parse(s.replace(' ', 'T') + ':00Z')
  const val = (s: string | undefined) => {
    if (s == null || s.trim() === '') return null
    const v = Number(s)
    return Number.isFinite(v) ? v : null
  }
  const byT = new Map<number, Observation>()
  for (const r of rows(wind)) {
    const t = time(r.t)
    if (!Number.isFinite(t)) continue
    const o = blank('coops', station, t)
    o.tws = val(r.s)
    o.twd = o.tws === 0 ? null : val(r.d)
    o.gust = val(r.g)
    byT.set(t, o)
  }
  for (const r of rows(pressure)) {
    const t = time(r.t)
    if (!Number.isFinite(t)) continue
    const o = byT.get(t) ?? blank('coops', station, t)
    o.pres = val(r.v)
    byT.set(t, o)
  }
  return [...byT.values()].sort((a, b) => a.t - b.t)
}

// ---------------------------------------------------------------- fetching

const COOPS = 'https://api.tidesandcurrents.noaa.gov/api/prod/datagetter'

/**
 * A CO-OPS station's wind and pressure over the last `hours`. CO-OPS answers a
 * browser directly; NDBC and aviationweather.gov do not, so buoys and METARs
 * wait for the proxy (D1).
 */
export async function fetchCoopsObservations(station: string, hours = 24, fetcher: typeof fetch = fetch): Promise<Observation[]> {
  const q = (product: string, units: string) =>
    `${COOPS}?product=${product}&station=${encodeURIComponent(station)}&range=${hours}&units=${units}&time_zone=gmt&format=json&application=newjourney`
  const [w, p] = await Promise.all([
    fetcher(q('wind', 'english')).then((r) => (r.ok ? r.json() : null)),
    fetcher(q('air_pressure', 'metric')).then((r) => (r.ok ? r.json() : null)).catch(() => null),
  ])
  const obs = parseCoops(station, w, p)
  if (!obs.length) {
    const msg = (w as { error?: { message?: string } } | null)?.error?.message
    throw new Error(msg ? `CO-OPS ${station}: ${msg}` : `CO-OPS ${station} sent no observations`)
  }
  return obs
}
