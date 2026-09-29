/**
 * Ensemble routing: the same course through every member of an ensemble
 * forecast. One route says where to go; twenty say how sure that is. The
 * spread of arrival times is the honest error bar on the ETA.
 */

import type { LatLon, RouteResult } from '@/lib/types'

export interface MemberRoute {
  member: string
  ok: boolean
  elapsedS: number | null
  etaMs: number | null
  track: LatLon[]
  error?: string
}

export function memberRoute(member: string, r: RouteResult): MemberRoute {
  return {
    member,
    ok: r.ok,
    elapsedS: r.elapsedS,
    etaMs: r.etaMs,
    track: r.legs.map((l) => l.position),
    ...(r.ok ? {} : { error: r.error }),
  }
}

export interface EnsembleSummary {
  count: number
  failed: number
  minS: number
  maxS: number
  meanS: number
  sdS: number
  /** The member closest to the mean: the one to sail, if any is. */
  typical: string | null
}

export function summariseEnsemble(members: MemberRoute[]): EnsembleSummary | null {
  const done = members.filter((m) => m.ok && m.elapsedS != null)
  if (done.length === 0) return null
  const t = done.map((m) => m.elapsedS!)
  const mean = t.reduce((a, b) => a + b, 0) / t.length
  const sd = Math.sqrt(t.reduce((a, b) => a + (b - mean) ** 2, 0) / t.length)
  const typical = done.reduce((a, b) => (Math.abs(b.elapsedS! - mean) < Math.abs(a.elapsedS! - mean) ? b : a)).member
  return {
    count: done.length,
    failed: members.length - done.length,
    minS: Math.min(...t),
    maxS: Math.max(...t),
    meanS: mean,
    sdS: sd,
    typical,
  }
}
