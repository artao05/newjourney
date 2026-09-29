/**
 * The instrument feed: Signal K or a serial port into the store, once a second.
 *
 * Values arrive as fast as the source sends them, often 10 Hz or more. They
 * are merged into one reading as they come, and the store gets that reading,
 * the boat state and (in instrument wind mode) the wind once a second, which is
 * all the screens redraw at. While a feed is on it is the position source, and
 * the phone's GPS is left off, so two sources never fight over the boat.
 */

import { useEffect, useRef } from 'react'
import { useStore } from '@/state/store'
import { SignalKClient } from '@/lib/instruments/signalk'
import { SerialNmeaSource, grantedPort } from '@/lib/instruments/webserial'
import type { Reading } from '@/lib/instruments/nmea0183'
import { boatStateFrom, windFrom } from '@/lib/instruments/toBoat'

export type InstrumentSource =
  | { kind: 'signalk'; url: string }
  | { kind: 'serial'; baud: number }
  | null

export function useInstruments(source: InstrumentSource) {
  const reading = useRef<Reading>({})
  const fresh = useRef(false)
  const key = source ? (source.kind === 'signalk' ? `sk:${source.url}` : `serial:${source.baud}`) : ''

  useEffect(() => {
    const st = useStore.getState()
    if (!source) {
      st.setInstrumentStatus({ status: 'off', detail: null })
      return
    }
    reading.current = {}
    const onReading = (r: Partial<Reading>) => {
      Object.assign(reading.current, r)
      fresh.current = true
    }
    const onStatus = (status: Parameters<typeof st.setInstrumentStatus>[0]['status'], detail?: string) =>
      useStore.getState().setInstrumentStatus({ status, detail: detail ?? null })

    let stop: () => void
    if (source.kind === 'signalk') {
      const client = new SignalKClient(source.url, { onReading, onStatus })
      client.start()
      stop = () => client.stop()
    } else {
      const serial = new SerialNmeaSource(grantedPort, source.baud, { onReading, onStatus })
      void serial.start()
      stop = () => void serial.stop()
    }

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
      stop()
      useStore.getState().setInstrumentReading(null)
    }
    // `key` is `source` as a value: a new object each render must not reconnect.
  }, [key])
}
