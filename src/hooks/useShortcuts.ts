/**
 * Acts on the keyboard shortcuts in src/lib/shortcuts.ts.
 *
 * Reads the store at key time rather than through a closure, so the handler is
 * installed once and never acts on a stale course or boat.
 */

import { useEffect, useRef } from 'react'
import { useStore, type PanelTab } from '@/state/store'
import { shortcutFor } from '@/lib/shortcuts'

/**
 * Full screen for the chart when there is one to isolate, else the whole app.
 * Expedition's full screen is a chart-only display.
 */
export function toggleFullscreen(wide: boolean): void {
  if (typeof document === 'undefined' || !document.fullscreenEnabled) return
  if (document.fullscreenElement) {
    void document.exitFullscreen().catch(() => undefined)
    return
  }
  const target = (wide && document.querySelector('.navstation__chart')) || document.documentElement
  void (target as HTMLElement).requestFullscreen?.().catch(() => undefined)
}

export function useShortcuts(wide: boolean): void {
  const wideRef = useRef(wide)
  wideRef.current = wide
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const action = shortcutFor(e, (e.target as HTMLElement | null)?.tagName)
      if (!action) return
      const s = useStore.getState()
      const panel = (p: PanelTab) => (wideRef.current ? s.setNav({ navPanel: p }) : s.setTab(p))
      const n = s.course.marks.length
      switch (action) {
        case 'settings':
        case 'polars':
          panel('setup')
          break
        case 'marks':
          panel('race')
          break
        case 'weather':
          if (wideRef.current) s.setNav({ navChart: 'weather' })
          else s.setTab('weather')
          break
        case 'mob':
          // Man overboard: a mark where the boat is now, made the active mark, so
          // every bearing and range on screen points back at it.
          if (!s.state) return
          s.dropMob(s.state.position)
          panel('race')
          break
        case 'nextMark':
          if (n === 0) return
          s.setActiveMark(Math.min(n - 1, s.activeMarkIndex + 1))
          break
        case 'prevMark':
          if (n === 0) return
          s.setActiveMark(Math.max(0, s.activeMarkIndex - 1))
          break
        case 'fullscreen':
          toggleFullscreen(wideRef.current)
          break
      }
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}
