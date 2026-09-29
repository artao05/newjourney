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
import { buildLattice } from '@/lib/polar'
import { computeTactics } from '@/lib/tactics'
import { computeStart } from '@/lib/startline'
import { declinationAt } from '@/lib/magnetic'
import { PILOT_VENUE } from '@/data/venues'
import { buildSnapshot, type ChannelValues } from '@/lib/channels/snapshot'
import type { PolarLattice } from '@/lib/types'

export function useChannelSnapshot(): ChannelValues {
  const now = useTick(1)
  const state = useStore((s) => s.state)
  const wind = useStore((s) => s.wind)
  const current = useStore((s) => s.current)
  const boat = useStore((s) => s.boat)
  const polar = useStore((s) => s.polar)
  const course = useStore((s) => s.course)
  const activeMarkIndex = useStore((s) => s.activeMarkIndex)
  const windHistory = useStore((s) => s.windHistory)
  const xteOrigin = useStore((s) => s.xteOrigin)

  const lattice = useMemo<PolarLattice | null>(() => {
    if (!polar) return null
    try {
      return buildLattice(polar)
    } catch {
      return null
    }
  }, [polar])

  return useMemo(() => {
    let tactics = null
    let start = null
    if (state) {
      try {
        tactics = computeTactics({
          state, wind, current, boat, lattice, course, activeMarkIndex, windHistory, xteOrigin,
        })
      } catch {
        tactics = null
      }
      try {
        start = computeStart({ line: course.startLine, state, wind, current, boat, lattice, now })
      } catch {
        start = null
      }
    }
    return buildSnapshot({
      now,
      state,
      wind,
      current,
      tactics,
      start,
      course,
      activeMarkIndex,
      variationDeg: declinationAt(PILOT_VENUE.declination, now),
    })
  }, [now, state, wind, current, boat, lattice, course, activeMarkIndex, windHistory, xteOrigin])
}
