import { describe, expect, it } from 'vitest'
import { fleetPositions, fleetRouteJobs, fleetRouteRow, rankFleet } from './fleetRoute'
import { POLAR_LIBRARY } from '@/data/polars'
import type { RouteResult } from '../types'

const T = Date.UTC(2026, 8, 29, 14)
const fleet = [
  { id: 'a', name: 'Wild Horses', colour: '#ff8a65', polarId: 'navigation', mmsi: 367000001 },
  { id: 'b', name: 'Sea Fever', colour: '#4fc3f7', polarId: POLAR_LIBRARY[1].id, mmsi: 367000002 },
  { id: 'c', name: 'Blue Moon', polarId: null },
  { id: 'd', name: 'Lost', polarId: 'navigation' },
]
const tracks = [{ key: 'Wild Horses', boatId: 'a', points: [{ t: T - 600_000, lat: 43.6, lon: -70.2 }, { t: T, lat: 43.61, lon: -70.2 }] }]
const ais = [
  { mmsi: 367000001, position: { lat: 50, lon: 0 }, positionAt: T },
  { mmsi: 367000002, position: { lat: 43.55, lon: -70.25 }, positionAt: T - 120_000 },
]

describe('fleet routing', () => {
  it('places each boat by her track first, then by AIS', () => {
    const p = fleetPositions(fleet, tracks, ais, T)
    expect(p.get('a')).toMatchObject({ source: 'tracking', position: { lat: 43.61, lon: -70.2 } })
    expect(p.get('b')).toMatchObject({ source: 'ais', ageMin: 2 })
    expect(p.has('d')).toBe(false)
  })

  it('makes a job for each boat with a polar and a position, and says why the others have none', () => {
    const ours = POLAR_LIBRARY[0].polar
    const { jobs, skipped } = fleetRouteJobs(fleet, fleetPositions(fleet, tracks, ais, T), (b) => (b.polarId === 'navigation' ? ours : POLAR_LIBRARY.find((x) => x.id === b.polarId)?.polar ?? null))
    expect(jobs.map((j) => [j.boatId, j.polar === ours])).toEqual([['a', true], ['b', false]])
    expect(skipped).toEqual([{ name: 'Blue Moon', why: 'no polar' }, { name: 'Lost', why: 'no position from tracking or AIS' }])
  })

  it('sets each arrival against ours, and ranks the fleet first to last', () => {
    const r = (etaMin: number | null): RouteResult => ({ ok: etaMin != null, error: etaMin == null ? 'no wind' : undefined, legs: [], etaMs: etaMin == null ? null : T + etaMin * 60_000, elapsedS: etaMin == null ? null : etaMin * 60, directTimeS: null, isochrones: [], reverseIsochrones: [], sensitivity: null, diagnostics: { nodesExplored: 0, timeStepS: 60, computeMs: 0, landAvoided: true, warnings: [] } }) as RouteResult
    const job = (id: string) => ({ boatId: id, name: id, colour: '#fff', start: { lat: 0, lon: 0 }, polar: POLAR_LIBRARY[0].polar, source: 'ais' as const })
    const ours = T + 60 * 60_000
    const rows = rankFleet([fleetRouteRow(job('slow'), r(75), ours), fleetRouteRow(job('none'), r(null), ours), fleetRouteRow(job('fast'), r(52), ours)])
    expect(rows.map((x) => [x.name, x.vsUsS])).toEqual([['fast', -480], ['slow', 900], ['none', null]])
    expect(rows[2].error).toBe('no wind')
  })
})
