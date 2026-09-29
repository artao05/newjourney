/**
 * The polar plot, with a logged day's points on it if one is chosen: the
 * quickest way to see whether a polar is optimistic, and on which tack.
 */

import { useEffect, useState } from 'react'
import { PolarPlot } from '@/components/PolarPlot'
import { logStore } from '@/lib/logging/idbStore'
import { polarPoints, type PolarPoint } from '@/lib/logging/logger'
import type { PolarLattice } from '@/lib/types'

/** Half the gap between the plotted wind speeds, so every second has a curve to sit by; at least 1 kn. */
export function bandFor(speeds: number[]): number {
  const s = [...speeds].sort((a, b) => a - b)
  let gap = Infinity
  for (let i = 1; i < s.length; i++) gap = Math.min(gap, s[i] - s[i - 1])
  return Number.isFinite(gap) ? Math.max(1, gap / 2) : 1
}

export function PolarWithLog({ lattice, speeds }: { lattice: PolarLattice | null; speeds: number[] }) {
  const [days, setDays] = useState<string[]>([])
  const [day, setDay] = useState('')
  const [points, setPoints] = useState<PolarPoint[]>([])
  const band = bandFor(speeds)

  useEffect(() => {
    let live = true
    logStore()
      .days()
      .then((d) => live && setDays(d.map((x) => x.day).sort().reverse()))
      .catch(() => {})
    return () => {
      live = false
    }
  }, [])

  useEffect(() => {
    let live = true
    if (!day || !lattice) {
      setPoints([])
      return
    }
    logStore()
      .read(day)
      .then((rows) => live && setPoints(polarPoints(rows, (tws, twa) => lattice.speed(tws, twa), speeds, band)))
      .catch(() => live && setPoints([]))
    return () => {
      live = false
    }
  }, [day, lattice, speeds, band])

  return (
    <>
      <PolarPlot lattice={lattice} speeds={speeds} points={points} />
      {days.length > 0 && (
        <div className="field">
          <label htmlFor="polar-log">Logged points</label>
          <select id="polar-log" value={day} onChange={(e) => setDay(e.target.value)}>
            <option value="">none</option>
            {days.map((d) => (
              <option key={d} value={d}>{d}</option>
            ))}
          </select>
        </div>
      )}
      {day && (
        <p className="note">
          {points.length
            ? `${points.length} seconds within ${band} kn of a plotted wind speed: starboard green on the right, port red on the left, hollow where slower than the polar.`
            : 'No logged seconds with TWA, TWS and boat speed near the plotted wind speeds.'}
        </p>
      )}
    </>
  )
}
