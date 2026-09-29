/**
 * Fleet routing: each boat in the fleet routed from where she is now, with her
 * own polar, to the rest of the course, and the arrivals set against ours.
 */
import { boatByMmsi } from '../fleet'
import { positionAt, type FleetTrack } from '../tracking'
import type { LatLon, Millis, PolarTable, RouteResult } from '../types'

export interface FleetBoatLike {
  id: string
  name: string
  colour?: string
  polarId?: string | null
  mmsi?: number | null
}

export interface KnownPosition {
  position: LatLon
  source: 'tracking' | 'ais'
  /** How old the fix is, minutes. */
  ageMin: number
}

/**
 * Where each fleet boat is now: from her track (between fixes, or dead
 * reckoned a while after the last), else from AIS by her MMSI.
 */
export function fleetPositions(
  fleet: FleetBoatLike[],
  tracks: FleetTrack[],
  ais: Array<{ mmsi: number; position: LatLon | null; positionAt: Millis | null }>,
  now: Millis,
): Map<string, KnownPosition> {
  const out = new Map<string, KnownPosition>()
  for (const tr of tracks) {
    if (!tr.boatId) continue
    const p = positionAt(tr, now)
    if (p) out.set(tr.boatId, { position: p.position, source: 'tracking', ageMin: p.ageMin })
  }
  for (const t of ais) {
    const b = boatByMmsi(fleet, t.mmsi)
    if (!b || out.has(b.id) || !t.position) continue
    out.set(b.id, { position: t.position, source: 'ais', ageMin: t.positionAt != null ? (now - t.positionAt) / 60_000 : 0 })
  }
  return out
}

export interface FleetRouteJob {
  boatId: string
  name: string
  colour: string
  start: LatLon
  polar: PolarTable
  source: KnownPosition['source']
}

/** One routing job per boat that has both a polar and a position; the rest say why not. */
export function fleetRouteJobs(
  fleet: FleetBoatLike[],
  positions: Map<string, KnownPosition>,
  polarFor: (b: FleetBoatLike) => PolarTable | null,
): { jobs: FleetRouteJob[]; skipped: Array<{ name: string; why: string }> } {
  const jobs: FleetRouteJob[] = []
  const skipped: Array<{ name: string; why: string }> = []
  for (const b of fleet) {
    const polar = polarFor(b)
    const pos = positions.get(b.id)
    if (!polar) skipped.push({ name: b.name, why: 'no polar' })
    else if (!pos) skipped.push({ name: b.name, why: 'no position from tracking or AIS' })
    else jobs.push({ boatId: b.id, name: b.name, colour: b.colour ?? '#90a4ae', start: pos.position, polar, source: pos.source })
  }
  return { jobs, skipped }
}

export interface FleetRouteRow {
  boatId: string
  name: string
  colour: string
  ok: boolean
  etaMs: Millis | null
  elapsedS: number | null
  /** Her arrival against ours, seconds: negative, she gets there first. */
  vsUsS: number | null
  track: LatLon[]
  error?: string
}

export function fleetRouteRow(job: FleetRouteJob, r: RouteResult, oursEta: Millis | null): FleetRouteRow {
  return {
    boatId: job.boatId,
    name: job.name,
    colour: job.colour,
    ok: r.ok,
    etaMs: r.etaMs,
    elapsedS: r.elapsedS,
    vsUsS: r.ok && r.etaMs != null && oursEta != null ? (r.etaMs - oursEta) / 1000 : null,
    track: r.legs.map((l) => l.position),
    error: r.ok ? undefined : r.error,
  }
}

/** The fleet's arrivals, first first; those that could not be routed last. */
export function rankFleet(rows: FleetRouteRow[]): FleetRouteRow[] {
  return [...rows].sort((a, b) => (a.etaMs ?? Infinity) - (b.etaMs ?? Infinity) || a.name.localeCompare(b.name))
}
