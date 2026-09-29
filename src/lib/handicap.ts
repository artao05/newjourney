/**
 * Handicap racing: Expedition's handicap calculator.
 *
 * Two systems cover almost every club race:
 *
 * - **Time on time** (IRC, ORC's TCF, PHRF-ToT): corrected = elapsed × TCF.
 * - **Time on distance** (classic PHRF): corrected = elapsed − rating × distance,
 *   with the rating in seconds a mile.
 *
 * "Owed" answers the question a crew asks on the last run: how much later than
 * that boat can we finish, and still beat her on corrected time?
 */

export type HandicapSystem = 'tot' | 'tod'

export interface Entry {
  name: string
  /** TCF for time on time, or seconds a mile for time on distance. */
  rating: number
  /** Elapsed seconds from the gun, or null while still racing. */
  elapsedS: number | null
}

export function corrected(system: HandicapSystem, elapsedS: number, rating: number, distanceNm: number): number {
  return system === 'tot' ? elapsedS * rating : elapsedS - rating * distanceNm
}

/**
 * How many seconds after `other` finishes `me` can finish and still tie on
 * corrected time. Negative means `me` must finish first by that much.
 */
export function owedS(system: HandicapSystem, me: number, other: number, otherElapsedS: number, distanceNm: number): number {
  if (system === 'tot') {
    // me × e_me = other × e_other  →  e_me = e_other × other / me
    return (otherElapsedS * other) / me - otherElapsedS
  }
  // e_me − me·d = e_other − other·d  →  e_me − e_other = (me − other)·d
  return (me - other) * distanceNm
}

export interface Result extends Entry {
  correctedS: number | null
  /** Seconds behind the corrected-time leader; 0 for the leader. */
  behindS: number | null
  place: number | null
}

/** Finishers ranked by corrected time; boats still racing come after, unranked. */
export function results(system: HandicapSystem, entries: Entry[], distanceNm: number): Result[] {
  const rows: Result[] = entries.map((e) => ({
    ...e,
    correctedS: e.elapsedS == null ? null : corrected(system, e.elapsedS, e.rating, distanceNm),
    behindS: null,
    place: null,
  }))
  const done = rows.filter((r) => r.correctedS != null).sort((a, b) => a.correctedS! - b.correctedS!)
  const best = done[0]?.correctedS ?? null
  done.forEach((r, i) => {
    r.place = i + 1
    r.behindS = r.correctedS! - (best as number)
  })
  return [...done, ...rows.filter((r) => r.correctedS == null)]
}

export interface FleetInput {
  id: string
  name: string
  rating: number
  startAt: number | null
  eventAt: number | null
  reference: boolean
}

export interface FleetRow {
  id: string
  name: string
  reference: boolean
  elapsedS: number | null
  correctedS: number | null
  /** Her corrected time less the reference boat's; positive means we beat her. */
  deltaS: number | null
  /**
   * How long after her the reference boat can finish and still tie. Positive:
   * she owes us that time. Negative: we owe her.
   */
  owedS: number | null
}

/**
 * The calculator's table. Elapsed runs from each boat's own start, or the gun
 * when she has none. A boat without an event time is still racing.
 */
export function fleetTable(system: HandicapSystem, boats: FleetInput[], gunAt: number | null, distanceNm: number): FleetRow[] {
  const elapsed = (b: FleetInput) => {
    const from = b.startAt ?? gunAt
    return from == null || b.eventAt == null ? null : (b.eventAt - from) / 1000
  }
  const ref = boats.find((b) => b.reference) ?? null
  const refElapsed = ref ? elapsed(ref) : null
  const refCorrected = ref && refElapsed != null ? corrected(system, refElapsed, ref.rating, distanceNm) : null
  return boats.map((b) => {
    const e = elapsed(b)
    const c = e == null ? null : corrected(system, e, b.rating, distanceNm)
    return {
      id: b.id,
      name: b.name,
      reference: b.reference,
      elapsedS: e,
      correctedS: c,
      deltaS: c == null || refCorrected == null || b.reference ? null : c - refCorrected,
      owedS: !ref || b.reference || e == null ? null : owedS(system, ref.rating, b.rating, e, distanceNm),
    }
  })
}

/** h:mm:ss, signed when negative. Handicap margins need the seconds. */
export function fmtHms(seconds: number | null): string {
  if (seconds == null || !Number.isFinite(seconds)) return '—'
  const s = Math.round(Math.abs(seconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const body = `${h}:${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
  return seconds < 0 && s > 0 ? `-${body}` : body
}
