/**
 * Setup → GPS: where the position comes from and how good it is.
 *
 * NMEA says a great deal about a fix (its kind, the satellites, HDOP); a phone
 * says only an accuracy radius. Each source shows what it gives, and nothing
 * it does not.
 */

import { useStore } from '@/state/store'
import { useTick } from '@/hooks/useSensors'
import { fmtAgo } from '@/components/Tile'

const FIX_KIND: Record<number, string> = {
  0: 'no fix',
  1: 'GPS',
  2: 'differential (DGPS)',
  3: 'PPS',
  4: 'RTK fixed',
  5: 'RTK float',
  6: 'dead reckoning',
  7: 'manual',
  8: 'simulated',
}

export function fixKind(q: number | null | undefined): string | null {
  return q == null ? null : (FIX_KIND[q] ?? `type ${q}`)
}

export function GpsSection() {
  const state = useStore((s) => s.state)
  const gpsError = useStore((s) => s.gpsError)
  const simulate = useStore((s) => s.settings.simulate)
  const instruments = useStore((s) => s.instruments)
  const reading = useStore((s) => s.instrumentReading)
  const now = useTick(1)

  const source = simulate
    ? 'Simulator'
    : instruments.signalKOn
      ? 'Signal K'
      : instruments.serialOn
        ? 'Serial NMEA 0183'
        : "This device's GPS"
  const fromNmea = !simulate && (instruments.signalKOn || instruments.serialOn)
  const rows: Array<[string, string]> = [['Source', source]]
  if (gpsError) rows.push(['Status', gpsError])
  if (state) {
    rows.push(['Fix age', fmtAgo((now - state.t) / 1000) ?? '—'])
    rows.push(['Estimated error', state.accuracyM != null ? `${state.accuracyM.toFixed(0)} m` : '—'])
  }
  if (fromNmea) {
    rows.push(['Fix', fixKind(reading?.fixQuality) ?? '—'])
    rows.push(['Satellites', reading?.satellites != null ? String(reading.satellites) : '—'])
    rows.push(['HDOP', reading?.hdop != null ? reading.hdop.toFixed(1) : '—'])
    rows.push(['Altitude', reading?.altitudeM != null ? `${reading.altitudeM.toFixed(0)} m` : '—'])
  }

  return (
    <section aria-label="GPS">
      <h2>GPS</h2>
      <table className="targets" aria-label="GPS status">
        <tbody>
          {rows.map(([k, v]) => (
            <tr key={k}>
              <th style={{ textAlign: 'left' }}>{k}</th>
              <td>{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {!fromNmea && !simulate && (
        <p className="note">
          A phone gives an accuracy radius only. The kind of fix, the satellites and HDOP come with an
          NMEA GPS, through Signal K or a serial port.
        </p>
      )}
      {fromNmea && (
        <p className="note">The estimated error from NMEA is HDOP × 5 m, a rule of thumb for a plain GPS.</p>
      )}
    </section>
  )
}
