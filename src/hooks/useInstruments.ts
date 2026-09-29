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
import { feedAis } from '@/state/ais'
import { SerialNmeaSource, grantedPort } from '@/lib/instruments/webserial'
import type { Reading } from '@/lib/instruments/nmea0183'
import { boatStateFrom } from '@/lib/instruments/toBoat'
import { InstrumentPipeline, type Derived, type PipelineSettings } from '@/lib/instruments/pipeline'
import { NO_CALIBRATION, type Calibration } from '@/lib/instruments/calibration'
import { actionFor, parseExpLine } from '@/lib/instruments/expProtocol'
import { applyExpAction } from '@/state/expCommands'

export type InstrumentSource =
  | { kind: 'signalk'; url: string }
  | { kind: 'serial'; baud: number; format: 'nmea0183' | 'n2k' }
  | null

export function useInstruments(
  source: InstrumentSource,
  settings: PipelineSettings,
  calibration: Calibration = NO_CALIBRATION,
) {
  const reading = useRef<Reading>({})
  const derived = useRef<Derived | null>(null)
  const fresh = useRef(false)
  const key = source ? (source.kind === 'signalk' ? `sk:${source.url}` : `serial:${source.baud}:${source.format}`) : ''
  const settingsKey = JSON.stringify([settings, calibration])

  useEffect(() => {
    const st = useStore.getState()
    if (!source) {
      st.setInstrumentStatus({ status: 'off', detail: null })
      return
    }
    reading.current = {}
    derived.current = null
    // Stepped on every reading, not once a second, so damping sees the full rate.
    const pipeline = new InstrumentPipeline(settings, calibration)
    const onReading = (r: Partial<Reading>) => {
      Object.assign(reading.current, r)
      derived.current = pipeline.step(reading.current, Date.now())
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
      // Expedition's own commands can share the port: the countdown, line ends, marks.
      const onHashLine = (line: string) => {
        const p = parseExpLine(line)
        if (p?.kind !== 'command') return
        const said = applyExpAction(actionFor(p))
        useStore.getState().setInstrumentStatus({ detail: said })
      }
      const serial = new SerialNmeaSource(grantedPort, source.baud, { onReading, onStatus, onHashLine, onAisLine: (l) => feedAis(l), format: source.format })
      void serial.start()
      stop = () => void serial.stop()
    }

    const tick = window.setInterval(() => {
      if (!fresh.current) return
      fresh.current = false
      const now = Date.now()
      const s = useStore.getState()
      const r = { ...reading.current }
      const d = derived.current
      s.setInstrumentReading(r)
      s.setInstrumentDerived(d)
      s.setInstrumentStatus({ lastAt: now })
      const boat = boatStateFrom(r, now)
      if (boat) {
        // The damped values, where the pipeline has them.
        s.setBoatState({
          ...boat,
          cog: d?.cog ?? boat.cog,
          sog: d?.sog ?? boat.sog,
          heading: d?.heading ?? boat.heading,
          bsp: d?.bsp ?? boat.bsp,
          heelDeg: d?.heel ?? boat.heelDeg,
        })
      }
      // Gated on rate of turn, so it is null mid-tack: then the last one stands.
      if (d?.current) s.setCurrent({ ...d.current, source: 'measured' })
      if (s.windMode === 'instrument' && d?.twd != null && d.tws != null) {
        s.setWind({ twd: d.twd, tws: d.tws, source: 'instrument', uncertaintyDeg: 3, t: now })
        s.setWindError(null)
        s.pushWind({ t: now, twd: d.twd, tws: d.tws })
      }
    }, 1000)

    return () => {
      window.clearInterval(tick)
      stop()
      useStore.getState().setInstrumentReading(null)
      useStore.getState().setInstrumentDerived(null)
    }
    // The keys are `source` and `settings` as values: new objects each render must not reconnect.
  }, [key, settingsKey])
}
