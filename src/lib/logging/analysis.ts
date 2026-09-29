/**
 * What a logged session says, after the fact: each tack and gybe and what it
 * cost, the best 24-hour run, and a summary of the sailing.
 *
 * A manoeuvre is the TWA changing sign: through the wind, a tack; through
 * dead downwind, a gybe. Its cost is the distance made good lost against the
 * VMG sailed steadily before it, over a window from shortly before to well
 * after, as metres and as the seconds that distance is worth at that VMG.
 */
import { distance } from '../geo'
import type { LogRow } from './logger'

export interface Manoeuvre {
  t: number
  kind: 'tack' | 'gybe'
  /** Metres of VMG lost, and the time that is worth; null without VMG around it. */
  lossM: number | null
  lossS: number | null
}

const KN = 1852 / 3600

export interface ManoeuvreOptions {
  /** Crossings closer than this to the last are the same manoeuvre (a wobble, a luff). */
  minGapS?: number
  /** The steady VMG is taken from `baseFromS` to `baseToS` before the crossing. */
  baseFromS?: number
  baseToS?: number
  /** The loss is summed from `baseToS` before to `afterS` after. */
  afterS?: number
}

const val = (r: LogRow, k: string) => {
  const v = r.v[k]
  return v != null && Number.isFinite(v) ? v : null
}

export function findManoeuvres(rows: LogRow[], o: ManoeuvreOptions = {}): Manoeuvre[] {
  const minGap = (o.minGapS ?? 30) * 1000
  const baseFrom = (o.baseFromS ?? 45) * 1000
  const baseTo = (o.baseToS ?? 15) * 1000
  const after = (o.afterS ?? 45) * 1000
  const out: Manoeuvre[] = []
  let last = -Infinity
  let prev: { t: number; twa: number } | null = null
  for (const r of rows) {
    const twa = val(r, 'twa')
    if (twa == null) continue
    if (prev && Math.sign(prev.twa) !== Math.sign(twa) && twa !== 0 && prev.twa !== 0 && r.t - last >= minGap) {
      // Through the wind with both sides forward of the beam, a tack; aft, a gybe.
      const kind = Math.abs(prev.twa) + Math.abs(twa) < 180 ? 'tack' : 'gybe'
      out.push({ t: r.t, kind, ...loss(rows, r.t, baseFrom, baseTo, after) })
      last = r.t
    }
    prev = { t: r.t, twa }
  }
  return out
}

function loss(rows: LogRow[], t: number, baseFrom: number, baseTo: number, after: number): { lossM: number | null; lossS: number | null } {
  const steady = rows.filter((r) => r.t >= t - baseFrom && r.t < t - baseTo).map((r) => val(r, 'vmg')).filter((v): v is number => v != null)
  if (steady.length < 3) return { lossM: null, lossS: null }
  const base = Math.abs(steady.reduce((a, b) => a + b, 0) / steady.length)
  if (base < 0.3) return { lossM: null, lossS: null }
  let lostM = 0
  let prevT: number | null = null
  for (const r of rows) {
    if (r.t < t - baseTo || r.t > t + after) continue
    const v = val(r, 'vmg')
    if (v == null) continue
    const dt = prevT == null ? 1 : Math.min(10, (r.t - prevT) / 1000)
    lostM += (base - Math.abs(v)) * KN * dt
    prevT = r.t
  }
  return { lossM: lostM, lossS: lostM / (base * KN) }
}

export interface BestRun {
  nm: number
  from: number
  to: number
}

/**
 * The most distance sailed in any `hours` window, joining the rows given
 * (several days, in order). A fix no boat could have reached (over `maxKn`)
 * is a bad one and is left out.
 */
export function bestRun(rows: LogRow[], hours = 24, maxKn = 50): BestRun | null {
  const pts = rows
    .map((r) => ({ t: r.t, lat: val(r, 'latitude'), lon: val(r, 'longtitude') }))
    .filter((p): p is { t: number; lat: number; lon: number } => p.lat != null && p.lon != null)
    .sort((a, b) => a.t - b.t)
  // A fix no boat could have reached from the last good one is dropped; the next good fix
  // is measured from the last good one.
  const good = [pts[0]]
  for (const p of pts.slice(1)) {
    const q = good[good.length - 1]
    const h = (p.t - q.t) / 3_600_000
    if (h > 0 && distance(q, p) / h <= maxKn) good.push(p)
  }
  pts.splice(0, pts.length, ...good)
  if (pts.length < 2) return null
  const cum = [0]
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + distance(pts[i - 1], pts[i]))
  const span = hours * 3_600_000
  let best: BestRun | null = null
  let i = 0
  for (let j = 1; j < pts.length; j++) {
    while (pts[j].t - pts[i].t > span) i++
    const nm = cum[j] - cum[i]
    if (!best || nm > best.nm) best = { nm, from: pts[i].t, to: pts[j].t }
  }
  return best
}

export interface PerformanceReport {
  durationS: number
  distanceNm: number
  meanSog: number | null
  maxSog: number | null
  meanTws: number | null
  meanPolarPct: number | null
  meanVmgPct: number | null
  /** Share of the time upwind (TWA under 80°), reaching, and downwind (over 110°). */
  upwindPct: number | null
  reachingPct: number | null
  downwindPct: number | null
  tacks: number
  gybes: number
  meanTackLossS: number | null
  meanGybeLossS: number | null
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null)

/** A session in numbers, from its logged channels. */
export function performanceReport(rows: LogRow[]): PerformanceReport {
  const col = (k: string) => rows.map((r) => val(r, k)).filter((v): v is number => v != null)
  const twa = col('twa').map(Math.abs)
  const share = (f: (a: number) => boolean) => (twa.length ? (100 * twa.filter(f).length) / twa.length : null)
  const man = findManoeuvres(rows)
  const lossOf = (k: Manoeuvre['kind']) => mean(man.filter((m) => m.kind === k && m.lossS != null).map((m) => m.lossS!))
  const sog = col('sog')
  const run = bestRun(rows, 1e6)
  return {
    durationS: rows.length > 1 ? (rows[rows.length - 1].t - rows[0].t) / 1000 : 0,
    distanceNm: run?.nm ?? 0,
    meanSog: mean(sog),
    maxSog: sog.length ? Math.max(...sog) : null,
    meanTws: mean(col('tws')),
    meanPolarPct: mean(col('polar-bsp-pct')),
    meanVmgPct: mean(col('vmg-pct')),
    upwindPct: share((a) => a < 80),
    reachingPct: share((a) => a >= 80 && a <= 110),
    downwindPct: share((a) => a > 110),
    tacks: man.filter((m) => m.kind === 'tack').length,
    gybes: man.filter((m) => m.kind === 'gybe').length,
    meanTackLossS: lossOf('tack'),
    meanGybeLossS: lossOf('gybe'),
  }
}
