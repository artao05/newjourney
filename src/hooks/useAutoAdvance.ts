/**
 * Auto mark advance: with Race → Advance set, the active mark moves on by
 * itself once the boat is done with it (lib/legsOnChart.ts shouldAdvance),
 * on whatever screen is showing.
 */
import { useEffect } from 'react'
import { useStore } from '@/state/store'
import { shouldAdvance } from '@/lib/legsOnChart'
import type { LatLon } from '@/lib/types'

export function useAutoAdvance() {
  useEffect(() => {
    let before: LatLon | null = null
    return useStore.subscribe((s, prev) => {
      if (s.state === prev.state) return
      const now = s.state?.position ?? null
      const was = before
      before = now
      if (!now || !was || s.settings.autoAdvance === 'off') return
      if (shouldAdvance(s.course.marks, s.activeMarkIndex, was, now, s.settings.autoAdvance, { start: s.routeStart })) {
        s.setActiveMark(s.activeMarkIndex + 1)
        s.addEvent('note', `Mark ${s.activeMarkIndex + 1} done: on to ${s.course.marks[s.activeMarkIndex + 1]?.name ?? 'the next'}`)
      }
    })
  }, [])
}
