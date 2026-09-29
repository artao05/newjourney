/**
 * The instrument feed: Signal K into the store, once a second.
 *
 * Deltas arrive as fast as the server sends them, often 10 Hz or more. They
 * are merged into one reading as they come, and the store gets that reading,
 * the boat state and (in instrument wind mode) the wind once a second, which is
 * all the screens redraw at. While the feed is on it is the position source,
 * and the phone's GPS is left off, so two sources never fight over the boat.
 */

import { useEffect, useRef } from 'react'
import { useStore } from '@/state/store'
import { SignalKClient } from '@/lib/instruments/signalk'
import type { Reading } from '@/lib/instruments/nmea0183'
import { boatStateFrom, windFrom } from '@/lib/instruments/toBoat'

export function useInstruments(enabled: boolean, url: string) {
  const reading = useRef<Reading>({})
  const fresh = useRef(false)

  useEffect(() => {
    const st = useStore.getState()
    if (!enabled) {
      st.setInstrumentStatus({ status: 'off', detail: null })
      return
    }
    reading.current = {}
    const client = new SignalKClient(url, {
      onReading: (r) => {
        Object.assign(reading.current, r)
        fresh.current = true
      },
      onStatus: (status, detail) => useStore.getState().setInstrumentStatus({ status, detail: detail ?? null }),
    })
    client.start()

    const tick = window.setInterval(() => {
      if (!fresh.current) return
      fresh.current = false
      const now = Date.now()
      const s = useStore.getState()
      const r = { ...reading.current }
      s.setInstrumentReading(r)
      s.setInstrumentStatus({ lastAt: now })
      const boat = boatStateFrom(r, now)
      if (boat) s.setBoatState(boat)
      if (s.windMode === 'instrument') {
        const w = windFrom(r, now)
        if (w) {
          s.setWind(w)
          s.setWindError(null)
          s.pushWind({ t: now, twd: w.twd, tws: w.tws })
        }
      }
    }, 1000)

    return () => {
      window.clearInterval(tick)
      client.stop()
      useStore.getState().setInstrumentReading(null)
    }
  }, [enabled, url])
}
