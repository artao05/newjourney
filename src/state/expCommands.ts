/**
 * Expedition protocol commands, carried out on the store: the countdown, the
 * line ends and the marks, driven from another device on the boat.
 */

import { useStore } from '@/state/store'
import { pingPosition } from '@/lib/startline'
import type { ExpAction } from '@/lib/instruments/expProtocol'

/** Carries out one action. Returns what happened, for the status line. */
export function applyExpAction(a: ExpAction, now = Date.now()): string {
  const s = useStore.getState()
  const gun = s.course.startLine.gunTime
  switch (a.do) {
    case 'gun-sync': {
      if (gun == null) return 'Sync ignored: no countdown running.'
      const rounded = Math.round((gun - now) / 60_000) * 60_000
      s.setGunTime(now + rounded)
      return 'Countdown synced to the minute.'
    }
    case 'gun-kill':
      s.setGunTime(null)
      return 'Countdown stopped.'
    case 'gun-set':
      s.setGunTime(now + Math.round(a.minutes * 60_000))
      return `Countdown set to ${a.minutes} min.`
    case 'ping': {
      if (!s.state) return 'Ping ignored: no position.'
      s.setStartEnd(a.end, pingPosition(s.state, s.boat).at)
      return `${a.end === 'port' ? 'Pin' : 'RC'} end pinged.`
    }
    case 'set-end':
      s.setStartEnd(a.end, { lat: a.lat, lon: a.lon })
      return `${a.end === 'port' ? 'Pin' : 'RC'} end set.`
    case 'mark-next':
    case 'mark-prev': {
      const n = s.course.marks.length
      if (n === 0) return 'No marks to step through.'
      const i = Math.max(0, Math.min(n - 1, s.activeMarkIndex + (a.do === 'mark-next' ? 1 : -1)))
      s.setActiveMark(i)
      return `Active mark: ${s.course.marks[i].name}.`
    }
    case 'mob':
      if (!s.state) return 'MOB ignored: no position.'
      s.dropMob(s.state.position)
      return 'Man overboard marked.'
    case 'mark-ping': {
      const m = s.course.marks[s.activeMarkIndex]
      if (!m || !s.state) return 'Ping ignored: no active mark or no position.'
      s.updateMark(m.id, { position: s.state.position })
      return `${m.name} moved to here.`
    }
    case 'mark-query':
      // Answering needs to transmit, which waits on the owner's read-only decision (D3).
      return 'Query received; replies are not sent while the link is read-only.'
    case 'unsupported':
      return `Not handled: ${a.why}.`
  }
}
