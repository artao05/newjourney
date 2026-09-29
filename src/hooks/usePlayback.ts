/**
 * Drives a replay: advances the play time while playing, and puts the row at
 * the play time into the store as boat state, wind, instrument reading and
 * current, so every screen shows the logged day as it happened.
 */

import { useEffect, useRef } from 'react'
import { useStore } from '@/state/store'
import { logStore } from '@/lib/logging/idbStore'
import type { LogRow } from '@/lib/logging/logger'
import { currentFromRow, readingFromRow, rowAt, stateFromRow, windFromRow } from '@/lib/logging/playback'

export const PLAYBACK_TICK_MS = 250

/** Starts replaying a day from its first second. */
export async function startPlayback(day: string): Promise<boolean> {
  const rows = await logStore().read(day)
  if (rows.length === 0) return false
  loaded = { day, rows }
  useStore.getState().setPlayback({ day, start: rows[0].t, end: rows[rows.length - 1].t, t: rows[0].t, playing: true, speed: 1 })
  return true
}

let loaded: { day: string; rows: LogRow[] } | null = null

export function usePlayback() {
  const playback = useStore((s) => s.playback)
  const day = playback?.day ?? null
  const lastApplied = useRef<number | null>(null)
  const appliedAt = useRef(0)

  // Load the day, if it was not the one started here (a reload mid-replay).
  useEffect(() => {
    if (!day || loaded?.day === day) return
    let live = true
    void logStore()
      .read(day)
      .then((rows) => {
        if (live) loaded = { day, rows }
      })
    return () => {
      live = false
    }
  }, [day])

  useEffect(() => {
    if (!day) {
      lastApplied.current = null
      return
    }
    const h = window.setInterval(() => {
      const s = useStore.getState()
      const p = s.playback
      if (!p || !loaded || loaded.day !== p.day) return
      if (p.playing) {
        const t = p.t + PLAYBACK_TICK_MS * p.speed
        s.setPlayback(t >= p.end ? { t: p.end, playing: false } : { t })
      }
      const at = useStore.getState().playback!.t
      const row = rowAt(loaded.rows, at)
      // A new row, or the same one once a second so a paused replay stays fresh.
      const now = Date.now()
      if (!row || (row.t === lastApplied.current && now - appliedAt.current < 1000)) return
      lastApplied.current = row.t
      appliedAt.current = now
      // Stamped now, not with the log's time: every screen ages its fix and wind
      // against the clock, and a replayed fix is as fresh as the replay. The log's
      // own time is on the playback bar.
      const boat = stateFromRow(row)
      if (boat) s.setBoatState({ ...boat, t: now })
      const wind = windFromRow(row)
      if (wind) s.setWind({ ...wind, t: now })
      s.setInstrumentReading(readingFromRow(row))
      const current = currentFromRow(row)
      if (current) s.setCurrent(current)
    }, PLAYBACK_TICK_MS)
    return () => window.clearInterval(h)
  }, [day])
}

/** For tests: forget the loaded day. */
export function resetPlayback(): void {
  loaded = null
}
