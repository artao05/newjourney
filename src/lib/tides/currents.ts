/**
 * Tidal streams from NOAA's harmonic current constants: for each depth bin,
 * the flow along its major axis (bearing `azi`, flood positive) and across it,
 * each a mean plus a sum of constituents, like the tide.
 *
 *   major(t) = mean + Σ f·A·cos(V + u − κ)
 *
 * Only harmonic ("H") stations have constants; subordinate stations are offsets
 * from one of them and are not read yet.
 */
import { distance } from '../geo'
import type { LatLon, Millis } from '../types'
import { astro, CONSTITUENTS, nodeTime, type HarmonicConstant } from './harmonic'

const DEG = Math.PI / 180
const CM_S_TO_KN = 0.0194384

export interface CurrentBin {
  bin: number
  depthM: number | null
  /** Bearing of the major axis, flood positive, degrees true. */
  azi: number
  majorMean: number
  minorMean: number
  /** Amplitudes in cm/s, Greenwich phases. */
  major: HarmonicConstant[]
  minor: HarmonicConstant[]
}

export function parseCurrentHarcon(json: unknown): CurrentBin[] {
  const list = (json as { HarmonicConstituents?: unknown } | null)?.HarmonicConstituents
  if (!Array.isArray(list)) return []
  const bins = new Map<number, CurrentBin>()
  for (const r of list as Array<Record<string, unknown>>) {
    const bin = Number(r.binNbr ?? 1)
    const name = String(r.constituentName ?? r.name ?? '')
    if (!name) continue
    let b = bins.get(bin)
    if (!b) {
      b = { bin, depthM: Number.isFinite(Number(r.binDepth)) ? Number(r.binDepth) : null, azi: Number(r.azi), majorMean: Number(r.majorMeanSpeed) || 0, minorMean: Number(r.minorMeanSpeed) || 0, major: [], minor: [] }
      bins.set(bin, b)
    }
    const ma = Number(r.majorAmplitude)
    const mp = Number(r.majorPhaseGMT)
    const na = Number(r.minorAmplitude)
    const np = Number(r.minorPhaseGMT)
    if (Number.isFinite(ma) && Number.isFinite(mp)) b.major.push({ name, amplitude: ma, phase: mp })
    if (Number.isFinite(na) && Number.isFinite(np)) b.minor.push({ name, amplitude: na, phase: np })
  }
  return [...bins.values()].filter((b) => Number.isFinite(b.azi)).sort((a, b) => a.bin - b.bin)
}

function axis(constants: HarmonicConstant[], mean: number, t: Millis): number {
  const a = astro(t)
  const b = astro(nodeTime(t))
  let v = mean
  for (const k of constants) {
    const con = CONSTITUENTS[k.name]
    if (!con || !k.amplitude) continue
    const [cT, cs, ch, cp, cp1, c0] = con.v
    const V = cT * a.T + cs * a.s + ch * a.h + cp * a.p + cp1 * a.p1 + c0
    v += con.f(b) * k.amplitude * Math.cos((V + con.u(b) - k.phase) * DEG)
  }
  return v
}

export interface StreamNow {
  /** Along the major axis, knots, flood positive. */
  majorKn: number
  minorKn: number
  /** Where the water is going, degrees true, and how fast, knots. */
  set: number
  drift: number
}

/** The stream in one bin at `t`. The minor axis lies 90° clockwise of the major. */
export function predictStream(b: CurrentBin, t: Millis): StreamNow {
  const maj = axis(b.major, b.majorMean, t) * CM_S_TO_KN
  const min = axis(b.minor, b.minorMean, t) * CM_S_TO_KN
  const east = maj * Math.sin(b.azi * DEG) + min * Math.sin((b.azi + 90) * DEG)
  const north = maj * Math.cos(b.azi * DEG) + min * Math.cos((b.azi + 90) * DEG)
  return { majorKn: maj, minorKn: min, set: ((Math.atan2(east, north) / DEG) + 360) % 360, drift: Math.hypot(east, north) }
}

export interface CurrentStation {
  id: string
  name: string
  position: LatLon
  /** The bin NOAA predicts by default. */
  bin: number
}

/** NOAA's current-prediction stations with their own harmonic constants. */
export function parseCurrentStations(json: unknown): CurrentStation[] {
  const list = (json as { stations?: unknown } | null)?.stations
  if (!Array.isArray(list)) return []
  const out: CurrentStation[] = []
  const seen = new Set<string>()
  for (const s of list as Array<Record<string, unknown>>) {
    if (s.type !== 'H') continue
    const id = String(s.id ?? '')
    if (!id || seen.has(id)) continue
    const lat = Number(s.lat)
    const lon = Number(s.lng)
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue
    seen.add(id)
    out.push({ id, name: String(s.name ?? id), position: { lat, lon }, bin: Number(s.currbin ?? 1) || 1 })
  }
  return out
}

export function nearestCurrentStations(list: CurrentStation[], at: LatLon, withinNm: number, max = 12): Array<CurrentStation & { nm: number }> {
  return list
    .map((s) => ({ ...s, nm: distance(at, s.position) }))
    .filter((s) => s.nm <= withinNm)
    .sort((a, b) => a.nm - b.nm)
    .slice(0, max)
}

const MDAPI = 'https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi'
const LIST_KEY = 'newjourney.currents.stations'
const KEY = (id: string) => `newjourney.currents.${id}`

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

/** The harmonic current stations, kept on the device once fetched. */
export async function currentStations(fetcher: typeof fetch = fetch): Promise<CurrentStation[]> {
  const st = storage()
  try {
    const kept = st?.getItem(LIST_KEY)
    if (kept) return JSON.parse(kept) as CurrentStation[]
  } catch {
    /* fetched again */
  }
  const r = await fetcher(`${MDAPI}/stations.json?type=currentpredictions`)
  if (!r.ok) throw new Error(`NOAA current stations: HTTP ${r.status}`)
  const list = parseCurrentStations(await r.json())
  try {
    st?.setItem(LIST_KEY, JSON.stringify(list))
  } catch {
    /* kept in memory only */
  }
  return list
}

/** A station's bins, kept once fetched. */
export async function stationStreams(id: string, fetcher: typeof fetch = fetch): Promise<CurrentBin[]> {
  const st = storage()
  try {
    const kept = st?.getItem(KEY(id))
    if (kept) return JSON.parse(kept) as CurrentBin[]
  } catch {
    /* fetched again */
  }
  const r = await fetcher(`${MDAPI}/stations/${encodeURIComponent(id)}/harcon.json?units=metric`)
  if (!r.ok) throw new Error(`NOAA current constants for ${id}: HTTP ${r.status}`)
  const bins = parseCurrentHarcon(await r.json())
  try {
    st?.setItem(KEY(id), JSON.stringify(bins))
  } catch {
    /* kept in memory only */
  }
  return bins
}
