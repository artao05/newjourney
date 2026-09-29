/**
 * The live channel snapshot for the boat, recomputed once a second.
 *
 * Race and Start still compute their own tactics and start numbers for their
 * fixed tiles. Everything configurable (number boxes, and later logging, the
 * stripchart and alarms) reads channels from here instead, so they all agree on
 * which value is which.
 */

import { useMemo } from 'react'
import { useStore } from '@/state/store'
import { useTick } from '@/hooks/useSensors'
import { usePolarLattices } from '@/hooks/usePolars'
import { computeTactics } from '@/lib/tactics'
import { computeStart } from '@/lib/startline'
import { declinationAt } from '@/lib/magnetic'
import { PILOT_VENUE } from '@/data/venues'
import { buildSnapshot, type ChannelValues } from '@/lib/channels/snapshot'
import { gateNumbers } from '@/lib/gates'
import { applyWhatIfCurrent, applyWhatIfWind } from '@/lib/whatif'

export function useChannelSnapshot(): ChannelValues {
  const now = useTick(1)
  const state = useStore((s) => s.state)
  const realWind = useStore((s) => s.wind)
  const realCurrent = useStore((s) => s.current)
  const boat = useStore((s) => s.boat)
  const course = useStore((s) => s.course)
  const activeMarkIndex = useStore((s) => s.activeMarkIndex)
  const windHistory = useStore((s) => s.windHistory)
  const xteOrigin = useStore((s) => s.xteOrigin)
  const whatIf = useStore((s) => s.whatIf)
  const startApproaches = useStore((s) => s.startApproaches)
  const instruments = useStore((s) => s.instrumentReading)
  const derived = useStore((s) => s.instrumentDerived)
  const raceNotes = useStore((s) => s.raceNotes)

  const polars = usePolarLattices()
  const lattice = polars.navigation

  return useMemo(() => {
    // The boxes show what Race shows: What-if included, as Expedition's channels do.
    const wind = applyWhatIfWind(realWind, whatIf)
    const current = applyWhatIfCurrent(realCurrent, whatIf)
    let tactics = null
    let start = null
    if (state) {
      try {
        tactics = computeTactics({
          state, wind, current, boat, lattice, course, activeMarkIndex, windHistory, xteOrigin,
          performanceLattice: polars.performance,
        })
      } catch {
        tactics = null
      }
      try {
        start = computeStart({
          line: course.startLine, state, wind, current, boat, lattice: polars.start, now,
          approaches: startApproaches,
        })
      } catch {
        start = null
      }
    }
    const mark = course.marks[activeMarkIndex]
    const gate =
      state && mark?.gate
        ? gateNumbers({ from: state.position, left: mark.gate.left, right: mark.gate.right, wind, lattice })
        : null
    return buildSnapshot({
      gate,
      now,
      state,
      wind,
      current,
      tactics,
      start,
      course,
      activeMarkIndex,
      variationDeg: declinationAt(PILOT_VENUE.declination, now),
      instruments,
      derived,
      raceNotes,
    })
  }, [raceNotes, now, state, realWind, realCurrent, whatIf, startApproaches, boat, lattice, polars.performance, polars.start, course, activeMarkIndex, windHistory, xteOrigin, instruments, derived])
}
