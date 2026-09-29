/**
 * Whether the screen is wide enough for the nav-station layout: a panel, the
 * chart and a column of number boxes side by side, as on a chart table. Below it
 * the phone layout, one tab at a time, is unchanged.
 */

import { createContext, useContext, useEffect, useState } from 'react'

export const NAV_STATION_MIN_WIDTH_PX = 1024
const QUERY = `(min-width: ${NAV_STATION_MIN_WIDTH_PX}px)`

function matches(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia(QUERY).matches
    : false
}

export function useWide(): boolean {
  const [wide, setWide] = useState(matches)
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const mq = window.matchMedia(QUERY)
    const on = () => setWide(mq.matches)
    on()
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  return wide
}

/**
 * Which layout a screen is being drawn in. Race hides its own number boxes in the
 * nav station, because the station has a column of them beside it.
 */
export const LayoutContext = createContext<'phone' | 'station'>('phone')
export const useLayout = () => useContext(LayoutContext)
