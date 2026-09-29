/**
 * Setup → Instruments: connect to a Signal K server or a serial port, and see
 * what it is sending.
 */

import { useStore } from '@/state/store'
import { mixedContentWarning } from '@/lib/instruments/signalk'
import { BAUD_RATES, choosePort, webSerialAvailable } from '@/lib/instruments/webserial'
import { useTick } from '@/hooks/useSensors'

const STATUS_TEXT = {
  off: 'Off',
  connecting: 'Connecting…',
  connected: 'Connected',
  closed: 'Connection closed; trying again',
  error: 'Could not connect; trying again',
} as const

/** A serial port does not retry: it is there, or it was unplugged. */
const SERIAL_TEXT = { ...STATUS_TEXT, closed: 'Port closed: was it unplugged?', error: 'Serial port problem' } as const

export function InstrumentsSection() {
  const instruments = useStore((s) => s.instruments)
  const setInstruments = useStore((s) => s.setInstruments)
  const status = useStore((s) => s.instrumentStatus)
  const reading = useStore((s) => s.instrumentReading)
  const simulate = useStore((s) => s.settings.simulate)
  const now = useTick(1)
  const warning = mixedContentWarning(window.location.protocol, instruments.signalKUrl)
  const age = status.lastAt != null ? Math.max(0, Math.round((now - status.lastAt) / 1000)) : null
  const fields = reading ? Object.keys(reading).length : 0
  const on = instruments.signalKOn || instruments.serialOn
  const serialOk = webSerialAvailable()

  const toggleSerial = async () => {
    if (instruments.serialOn) {
      setInstruments({ serialOn: false })
      return
    }
    try {
      // The picker only opens in answer to a tap, so it is asked for here.
      if (await choosePort()) setInstruments({ serialOn: true })
    } catch {
      // Closing the picker without choosing is not an error.
    }
  }

  return (
    <section aria-label="Instruments">
      <h2>Instruments</h2>
      <div className="field">
        <label htmlFor="sk-url">Signal K server</label>
        <input
          id="sk-url"
          value={instruments.signalKUrl}
          spellCheck={false}
          onChange={(e) => setInstruments({ signalKUrl: e.target.value.trim() })}
        />
      </div>
      {warning && <p className="warnbox">{warning}</p>}
      <button
        className={instruments.signalKOn ? 'btn btn--sm btn--ghost' : 'btn btn--sm'}
        onClick={() => setInstruments({ signalKOn: !instruments.signalKOn })}
      >
        {instruments.signalKOn ? 'DISCONNECT' : 'CONNECT'}
      </button>

      <div className="field">
        <label htmlFor="serial-baud">Serial NMEA 0183 speed</label>
        <select
          id="serial-baud"
          value={instruments.serialBaud}
          onChange={(e) => setInstruments({ serialBaud: Number(e.target.value) })}
        >
          {BAUD_RATES.map((b) => (
            <option key={b} value={b}>{b}</option>
          ))}
        </select>
      </div>
      <button
        className={instruments.serialOn ? 'btn btn--sm btn--ghost' : 'btn btn--sm'}
        disabled={!serialOk && !instruments.serialOn}
        onClick={() => void toggleSerial()}
      >
        {instruments.serialOn ? 'DISCONNECT SERIAL' : 'CONNECT SERIAL'}
      </button>
      {!serialOk && (
        <p className="note">A serial port needs Chrome or Edge on a computer. Other browsers can use Signal K.</p>
      )}

      <p className="note" role="status">
        {on && simulate
          ? 'Waiting: the simulator is on, and it drives the boat while it is.'
          : (instruments.serialOn ? SERIAL_TEXT : STATUS_TEXT)[status.status]}
        {status.detail && status.status !== 'connected' ? ` (${status.detail})` : ''}
        {status.status === 'connected' && age != null ? ` · ${fields} values, the latest ${age} s ago` : ''}
        {status.status === 'connected' && age == null ? ' · no data yet' : ''}
      </p>
      <p className="note">
        A Signal K server on the boat network reads the NMEA 0183 and NMEA 2000 instruments; a
        serial adaptor reads NMEA 0183 directly, most often at 4800 (38400 for AIS). One source at
        a time: while it is connected it gives the position, and the phone&apos;s GPS is not used.
        Choose Instruments under Wind to use its true wind.
      </p>
    </section>
  )
}
