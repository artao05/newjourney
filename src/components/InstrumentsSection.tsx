/**
 * Setup → Instruments: connect to a Signal K server or a serial port, and see
 * what it is sending.
 */

import { useState } from 'react'
import { useStore } from '@/state/store'
import { GOOD_COMPASS_DEG, requestOrientationPermission } from '@/lib/instruments/orientation'
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
  const pipeline = useStore((s) => s.pipeline)
  const setPipeline = useStore((s) => s.setPipeline)
  const derived = useStore((s) => s.instrumentDerived)
  const phoneSensors = useStore((s) => s.phoneSensors)
  const setPhoneSensors = useStore((s) => s.setPhoneSensors)
  const phone = useStore((s) => s.phoneOrientation)
  const [phoneError, setPhoneError] = useState<string | null>(null)
  const now = useTick(1)
  const warning = mixedContentWarning(window.location.protocol, instruments.signalKUrl)
  const age = status.lastAt != null ? Math.max(0, Math.round((now - status.lastAt) / 1000)) : null
  const fields = reading ? Object.keys(reading).length : 0
  const on = instruments.signalKOn || instruments.serialOn || instruments.bridgeOn
  const bridgeInputs = useStore((s) => s.bridgeInputs)
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
        <label htmlFor="serial-format">Serial data</label>
        <select
          id="serial-format"
          value={instruments.serialFormat}
          onChange={(e) => setInstruments({ serialFormat: e.target.value as 'nmea0183' | 'n2k' })}
        >
          <option value="nmea0183">NMEA 0183</option>
          <option value="n2k">NMEA 2000, gateway text (Yacht Devices RAW)</option>
        </select>
      </div>
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

      <div className="field">
        <label htmlFor="bridge-url">Bridge</label>
        <input
          id="bridge-url"
          value={instruments.bridgeUrl}
          spellCheck={false}
          onChange={(e) => setInstruments({ bridgeUrl: e.target.value.trim() })}
        />
      </div>
      <button
        className={instruments.bridgeOn ? 'btn btn--sm btn--ghost' : 'btn btn--sm'}
        onClick={() => setInstruments({ bridgeOn: !instruments.bridgeOn })}
      >
        {instruments.bridgeOn ? 'DISCONNECT BRIDGE' : 'CONNECT BRIDGE'}
      </button>
      <p className="note">
        For NMEA and AIS over UDP or TCP on the boat&apos;s network, which a browser cannot open: run{' '}
        <code>node bridge/bridge.ts --udp 10110</code> on this computer (see bridge/README.md).
      </p>
      {instruments.bridgeOn && bridgeInputs.length > 0 && (
        <ul className="note" aria-label="Bridge inputs" style={{ margin: '0 0 8px', paddingLeft: 18 }}>
          {bridgeInputs.map((i) => (
            <li key={i.id}>
              {i.kind === 'udp' ? 'UDP' : i.kind === 'tcp-client' ? 'TCP to' : 'TCP from'} {i.address} · {i.format === 'n2k' ? 'NMEA 2000' : 'NMEA 0183'} · {i.state}
              {i.detail ? ` (${i.detail})` : ''} · {i.lines} lines
            </li>
          ))}
        </ul>
      )}

      <p className="note" role="status">
        {on && simulate
          ? 'Waiting: the simulator is on, and it drives the boat while it is.'
          : (instruments.serialOn ? SERIAL_TEXT : STATUS_TEXT)[status.status]}
        {status.detail && status.status !== 'connected' ? ` (${status.detail})` : ''}
        {status.status === 'connected' && age != null ? ` · ${fields} values, the latest ${age} s ago` : ''}
        {status.status === 'connected' && age == null ? ' · no data yet' : ''}
        {status.status === 'connected' && status.detail ? ` · ${status.detail}` : ''}
      </p>
      <label className="field" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <input
          type="checkbox"
          checked={phoneSensors.on}
          aria-label="Use the phone's tilt as heel"
          onChange={async (e) => {
            const on = e.target.checked
            // iOS asks first, and only in answer to a tap like this one.
            if (on && !(await requestOrientationPermission())) {
              setPhoneError('This browser will not share the phone’s orientation.')
              return
            }
            setPhoneError(null)
            setPhoneSensors({ on })
          }}
        />
        <span>Use the phone&apos;s tilt as heel. Lay it flat, screen up, top toward the bow.</span>
      </label>
      <label className="field" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <input
          type="checkbox"
          checked={phoneSensors.trustCompass}
          disabled={!phoneSensors.on}
          aria-label="Trust the phone's compass for heading"
          onChange={(e) => setPhoneSensors({ trustCompass: e.target.checked })}
        />
        <span>Trust its compass for heading, while the phone says it is within {GOOD_COMPASS_DEG}°.</span>
      </label>
      {phoneError && <p className="warnbox" role="alert">{phoneError}</p>}
      {phoneSensors.on && (
        <p className="note" aria-label="Phone sensors">
          {phone
            ? `Heel ${phone.heel != null ? `${phone.heel.toFixed(0)}°` : '—'} · compass ${
                phone.headingMag != null ? `${Math.round(phone.headingMag)}°M` : 'none on this phone'
              } · ${
                phone.quality === 'good'
                  ? `within ${phone.accuracyDeg}°, good`
                  : phone.quality === 'poor'
                    ? `±${phone.accuracyDeg}°, not trusted`
                    : 'accuracy not reported, not trusted'
              }`
            : 'No orientation from this device yet.'}
        </p>
      )}

      <div className="seg" role="group" aria-label="True wind" style={{ margin: '8px 0' }}>
        <button aria-pressed={pipeline.trueWind === 'calculate'} onClick={() => setPipeline({ trueWind: 'calculate' })}>
          Calculate true wind
        </button>
        <button aria-pressed={pipeline.trueWind === 'instrument'} onClick={() => setPipeline({ trueWind: 'instrument' })}>
          Instruments&apos; true wind
        </button>
      </div>
      <div className="field">
        <label htmlFor="damp-angle">Damping, angles <span className="note">s</span></label>
        <input id="damp-angle" type="number" min="0" step="1" value={pipeline.dampAngleS}
          onChange={(e) => setPipeline({ dampAngleS: Math.max(0, Number(e.target.value) || 0) })} />
      </div>
      <div className="field">
        <label htmlFor="damp-speed">Damping, speeds <span className="note">s</span></label>
        <input id="damp-speed" type="number" min="0" step="1" value={pipeline.dampSpeedS}
          onChange={(e) => setPipeline({ dampSpeedS: Math.max(0, Number(e.target.value) || 0) })} />
      </div>
      <div className="field">
        <label htmlFor="leeway-k">Leeway coefficient <span className="note">k in k·heel/bsp²</span></label>
        <input id="leeway-k" type="number" min="0" step="0.5" value={pipeline.leewayK}
          onChange={(e) => setPipeline({ leewayK: Math.max(0, Number(e.target.value) || 0) })} />
      </div>
      <div className="field">
        <label htmlFor="rot-gate">Set and drift only below <span className="note">°/s of turn</span></label>
        <input id="rot-gate" type="number" min="0.5" step="0.5" value={pipeline.rotLimitDegS}
          onChange={(e) => setPipeline({ rotLimitDegS: Math.max(0.5, Number(e.target.value) || 3) })} />
      </div>
      <label className="field" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <input type="checkbox" checked={pipeline.heelCorrect} aria-label="Correct apparent wind for heel"
          onChange={(e) => setPipeline({ heelCorrect: e.target.checked })} />
        <span>Correct apparent wind for heel. Leave off if the instruments already do (Nexus FDX and others): twice invents wind.</span>
      </label>
      {derived && (
        <p className="note">
          Leeway {derived.leeway != null ? `${derived.leeway.toFixed(1)}°` : '—'} · true wind{' '}
          {derived.twd != null && derived.tws != null ? `${Math.round(derived.twd)}° ${derived.tws.toFixed(1)} kn` : '—'} ·
          set and drift {derived.current ? `${Math.round(derived.current.set)}° ${derived.current.drift.toFixed(1)} kn` : 'held (turning, or not enough data)'}
        </p>
      )}

      <p className="note">
        A Signal K server on the boat network reads the NMEA 0183 and NMEA 2000 instruments; a
        serial adaptor reads NMEA 0183 directly, most often at 4800 (38400 for AIS). One source at
        a time: while it is connected it gives the position, and the phone&apos;s GPS is not used.
        Choose Instruments under Wind to use its true wind.
      </p>
    </section>
  )
}
