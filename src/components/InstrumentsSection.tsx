/**
 * Setup → Instruments: connect to a Signal K server, and see what it is sending.
 */

import { useStore } from '@/state/store'
import { mixedContentWarning } from '@/lib/instruments/signalk'
import { useTick } from '@/hooks/useSensors'

const STATUS_TEXT = {
  off: 'Off',
  connecting: 'Connecting…',
  connected: 'Connected',
  closed: 'Connection closed; trying again',
  error: 'Could not connect; trying again',
} as const

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
      <p className="note" role="status">
        {instruments.signalKOn && simulate
          ? 'Waiting: the simulator is on, and it drives the boat while it is.'
          : STATUS_TEXT[status.status]}
        {status.detail && status.status !== 'connected' ? ` (${status.detail})` : ''}
        {status.status === 'connected' && age != null ? ` · ${fields} values, the latest ${age} s ago` : ''}
        {status.status === 'connected' && age == null ? ' · no data yet' : ''}
      </p>
      <p className="note">
        A Signal K server on the boat network reads the NMEA 0183 and NMEA 2000 instruments.
        While it is connected it gives the position, and the phone&apos;s GPS is not used. Choose
        Instruments under Wind to use its true wind.
      </p>
    </section>
  )
}
