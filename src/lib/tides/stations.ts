/**
 * Tide stations: NOAA's list of stations with harmonic constants, the nearest
 * to a point, each station's constants and datums (kept on the device once
 * fetched, so a tide can still be worked out offshore), and a day's tide
 * curve with its highs and lows.
 */
import { distance } from '../geo'
import type { LatLon, Millis } from '../types'
import { HARCON_URL, parseHarcon, predictTide, type HarmonicConstant } from './harmonic'

const MDAPI = 'https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi'

export interface TideStation {
  id: string
  name: string
  position: LatLon
  state?: string
}

export function parseStations(json: unknown): TideStation[] {
  const list = (json as { stations?: unknown } | null)?.stations
  if (!Array.isArray(list)) return []
  return list
    .map((s: { id?: unknown; name?: unknown; lat?: unknown; lng?: unknown; state?: unknown }) => ({
      id: String(s.id ?? ''),
      name: String(s.name ?? ''),
      position: { lat: Number(s.lat), lon: Number(s.lng) },
      state: s.state ? String(s.state) : undefined,
    }))
    .filter((s) => s.id && Number.isFinite(s.position.lat) && Number.isFinite(s.position.lon))
}

/** The `n` stations nearest `at`, with their distance in nautical miles. */
export function nearestStations(list: TideStation[], at: LatLon, n = 5): Array<TideStation & { nm: number }> {
  return list
    .map((s) => ({ ...s, nm: distance(at, s.position) }))
    .sort((a, b) => a.nm - b.nm)
    .slice(0, n)
}

/** A station's datums, metres: MSL, MLLW and the rest, as NOAA lists them. */
export function parseDatums(json: unknown): Record<string, number> {
  const list = (json as { datums?: unknown } | null)?.datums
  const out: Record<string, number> = {}
  if (Array.isArray(list)) for (const d of list as Array<{ name?: unknown; value?: unknown }>) if (d.name && Number.isFinite(Number(d.value))) out[String(d.name)] = Number(d.value)
  return out
}

export interface StationTides {
  station: TideStation
  constants: HarmonicConstant[]
  /** Chart datum (MLLW) below mean sea level, metres; null if NOAA gives none. */
  mslAboveMllw: number | null
  fetchedAt: Millis
}

const KEY = (id: string) => `newjourney.tides.${id}`
const LIST_KEY = 'newjourney.tides.stations'

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

/** The station list, from the device if it has it, else from NOAA (and kept). */
export async function tideStations(fetcher: typeof fetch = fetch): Promise<TideStation[]> {
  const st = storage()
  try {
    const kept = st?.getItem(LIST_KEY)
    if (kept) return JSON.parse(kept) as TideStation[]
  } catch {
    /* a broken copy is fetched again */
  }
  const r = await fetcher(`${MDAPI}/stations.json?type=harcon`)
  if (!r.ok) throw new Error(`NOAA station list: HTTP ${r.status}`)
  const list = parseStations(await r.json())
  try {
    st?.setItem(LIST_KEY, JSON.stringify(list))
  } catch {
    /* full or blocked storage: the list is still returned */
  }
  return list
}

/** A station's constants and datums, from the device if kept, else from NOAA (and kept). */
export async function stationTides(station: TideStation, fetcher: typeof fetch = fetch): Promise<StationTides> {
  const st = storage()
  try {
    const kept = st?.getItem(KEY(station.id))
    if (kept) return JSON.parse(kept) as StationTides
  } catch {
    /* fetched again */
  }
  const [h, d] = await Promise.all([
    fetcher(HARCON_URL(station.id)).then((r) => (r.ok ? r.json() : null)),
    fetcher(`${MDAPI}/stations/${encodeURIComponent(station.id)}/datums.json?units=metric`)
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null),
  ])
  const constants = parseHarcon(h)
  if (!constants.length) throw new Error(`NOAA has no harmonic constants for ${station.name} (${station.id})`)
  const datums = parseDatums(d)
  const out: StationTides = {
    station,
    constants,
    mslAboveMllw: datums.MSL != null && datums.MLLW != null ? datums.MSL - datums.MLLW : null,
    fetchedAt: Date.now(),
  }
  try {
    st?.setItem(KEY(station.id), JSON.stringify(out))
  } catch {
    /* kept in memory only */
  }
  return out
}

export interface TideTurn {
  t: Millis
  /** Height above mean sea level, metres. */
  h: number
  high: boolean
}

/**
 * Highs and lows between `t0` and `t1`: the curve sampled every six minutes,
 * each turn placed by a parabola through its three samples.
 */
export function tideTurns(constants: HarmonicConstant[], t0: Millis, t1: Millis, stepMs = 6 * 60_000): TideTurn[] {
  const out: TideTurn[] = []
  let a = predictTide(constants, t0 - stepMs)
  let b = predictTide(constants, t0)
  for (let t = t0; t <= t1; t += stepMs) {
    const c = predictTide(constants, t + stepMs)
    if ((b > a && b >= c) || (b < a && b <= c)) {
      const denom = a - 2 * b + c
      const off = denom !== 0 ? (0.5 * (a - c)) / denom : 0
      const tt = t + off * stepMs
      out.push({ t: tt, h: predictTide(constants, tt), high: b > a })
    }
    a = b
    b = c
  }
  return out
}
