/**
 * Setup → Calibration: the sensor offsets, and the correction tables loaded
 * from text files (see lib/instruments/calibration.ts for the layout).
 */

import { useState } from 'react'
import { useStore } from '@/state/store'
import { CalibrationError, parseDeviation, parseTable, type Calibration } from '@/lib/instruments/calibration'

type TableKey = 'bsp' | 'awa' | 'aws' | 'twa' | 'tws'

const TABLES: Array<[TableKey, string, string]> = [
  ['bsp', 'Boat speed', 'boat speed across, heel down'],
  ['awa', 'Apparent angle', 'AWA across, AWS down'],
  ['aws', 'Apparent speed', 'AWA across, AWS down'],
  ['twa', 'True angle (upwash)', 'TWA across, TWS down'],
  ['tws', 'True speed', 'TWA across, TWS down'],
]

const OFFSETS: Array<[keyof Calibration['offsets'], string]> = [
  ['heel', 'Heel offset'],
  ['pitch', 'Trim offset'],
  ['rudder', 'Rudder offset'],
  ['compass', 'Compass offset'],
  ['mast', 'Mast angle offset'],
]

export function CalibrationSection() {
  const cal = useStore((s) => s.calibration)
  const setCalibration = useStore((s) => s.setCalibration)
  const [error, setError] = useState<string | null>(null)

  const load = async (file: File, apply: (text: string) => void) => {
    try {
      apply(await file.text())
      setError(null)
    } catch (e) {
      setError(e instanceof CalibrationError ? e.message : `Could not read that file: ${e instanceof Error ? e.message : e}`)
    }
  }

  const picker = (label: string, apply: (text: string) => void) => (
    <label className="btn btn--sm btn--ghost" style={{ cursor: 'pointer' }}>
      IMPORT
      <input
        type="file"
        accept=".txt,.csv,text/plain,text/csv"
        aria-label={label}
        style={{ display: 'none' }}
        onChange={(e) => {
          const f = e.target.files?.[0]
          e.target.value = ''
          if (f) void load(f, apply)
        }}
      />
    </label>
  )

  return (
    <section aria-label="Calibration">
      <h2>Calibration</h2>
      {OFFSETS.map(([k, label]) => (
        <div className="field" key={k}>
          <label htmlFor={`cal-${k}`}>{label} <span className="note">°, added</span></label>
          <input
            id={`cal-${k}`}
            type="number"
            step="0.5"
            value={cal.offsets[k]}
            onChange={(e) => setCalibration({ offsets: { ...cal.offsets, [k]: Number(e.target.value) || 0 } })}
          />
        </div>
      ))}
      <table className="targets" aria-label="Correction tables">
        <tbody>
          {TABLES.map(([k, name, layout]) => {
            const t = cal[k]
            return (
              <tr key={k}>
                <td style={{ textAlign: 'left' }}>
                  {name}
                  <div className="note">{layout}</div>
                </td>
                <td>{t ? `${t.rows.length}×${t.cols.length}` : 'none'}</td>
                <td>
                  {picker(`Import the ${name.toLowerCase()} table`, (text) => setCalibration({ [k]: parseTable(text) }))}
                  {t && (
                    <button className="btn btn--sm btn--ghost" onClick={() => setCalibration({ [k]: null })}>
                      CLEAR
                    </button>
                  )}
                </td>
              </tr>
            )
          })}
          <tr>
            <td style={{ textAlign: 'left' }}>
              Compass deviation
              <div className="note">heading, deviation (E +) per line</div>
            </td>
            <td>{cal.deviation ? `${cal.deviation.length} points` : 'none'}</td>
            <td>
              {picker('Import the deviation table', (text) => setCalibration({ deviation: parseDeviation(text) }))}
              {cal.deviation && (
                <button className="btn btn--sm btn--ghost" onClick={() => setCalibration({ deviation: null })}>
                  CLEAR
                </button>
              )}
            </td>
          </tr>
        </tbody>
      </table>
      {error && <p className="warnbox" role="alert">{error}</p>}
      <p className="note">
        Each table adds its correction to the raw value, interpolated between the points given and held
        beyond them. A table file is a line of column values, then a line per row with the row value
        first. Angle corrections apply with the side&apos;s sign, so port and starboard stay symmetric.
      </p>
    </section>
  )
}
