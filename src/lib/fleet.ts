/**
 * The boats database: finding a boat by what AIS or a tracker calls her, and
 * the polar she sails to.
 */
import type { PolarTable } from './types'

export interface FleetIdentity {
  id: string
  name: string
  polarId?: string | null
  mmsi?: number | null
  sailNumber?: string
  trackerId?: string
}

const norm = (s: string) => s.replace(/[\s-]/g, '').toUpperCase()

/** The boat AIS means by this MMSI, if she is in the fleet. */
export function boatByMmsi<T extends FleetIdentity>(fleet: T[], mmsi: number): T | undefined {
  return fleet.find((b) => b.mmsi === mmsi)
}

/**
 * The boat a tracker means by this name or id: her tracker id first, then her
 * sail number, then her name, each ignoring case, spaces and dashes.
 */
export function boatByTrackerName<T extends FleetIdentity>(fleet: T[], key: string): T | undefined {
  const k = norm(key)
  if (!k) return undefined
  return (
    fleet.find((b) => b.trackerId && norm(b.trackerId) === k) ??
    fleet.find((b) => b.sailNumber && norm(b.sailNumber) === k) ??
    fleet.find((b) => norm(b.name) === k)
  )
}

/** Her polar: ours for 'navigation', a library class by id, else none. */
export function fleetPolar(b: FleetIdentity, library: Array<{ id: string; polar: PolarTable }>, navigation: PolarTable | null): PolarTable | null {
  if (!b.polarId) return null
  if (b.polarId === 'navigation') return navigation
  return library.find((e) => e.id === b.polarId)?.polar ?? null
}
