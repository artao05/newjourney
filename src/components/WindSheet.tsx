/**
 * Set the wind by hand, from anywhere: the top-bar chip opens this on every tab,
 * and the Start tab asks for it while no wind is set.
 *
 * Line bias, the favoured end and the laylines all rest on the wind, and with no
 * instrument it is a number the sailor types. So this has to be quick - big
 * steps, wet-finger targets, no trip to Setup mid-sequence - and it has to say
 * what the number in use is resting on.
 */

import { useState } from 'react'
import { useStore } from '@/state/store'
import { fmtDeg, wrap360 } from '@/lib/angles'
import { declinationAt, magneticToTrue, trueToMagnetic } from '@/lib/magnetic'
import { PILOT_VENUE } from '@/data/venues'

const DIR_STEPS = [-10, -5, -1, 1, 5, 10]

export function WindSheet({ onClose }: { onClose: () => void }) {
  const manualWind = useStore((s) => s.manualWind)
  const setAt = useStore((s) => s.manualWindSetAt)
  const setManualWind = useStore((s) => s.setManualWind)
  const windMode = useStore((s) => s.windMode)
  const setWindMode = useStore((s) => s.setWindMode)
  const wind = useStore((s) => s.wind)
  const magnetic = useStore((s) => s.settings.northRef === 'magnetic')
  const updateSettings = useStore((s) => s.updateSettings)
  const decl = declinationAt(PILOT_VENUE.declination, Date.now())

  // A first guess to step from: a set manual wind, else the forecast in use, else
  // the placeholder - which the sailor still has to confirm before it counts.
  const start =
    setAt != null
      ? manualWind
      : wind
        ? { twd: Math.round(wind.twd), tws: Math.round(wind.tws) }
        : manualWind
  // Held in the north on show, because that is the number the sailor read off the
  // compass; converted to true only when it is set.
  const [dir, setDir] = useState(magnetic ? Math.round(trueToMagnetic(start.twd, decl)) : start.twd)
  const [tws, setTws] = useState(start.tws)

  const showNorth = (toMagnetic: boolean) => {
    if (toMagnetic === magnetic) return
    setDir((d) => Math.round(toMagnetic ? trueToMagnetic(d, decl) : magneticToTrue(d, decl)))
    updateSettings({ northRef: toMagnetic ? 'magnetic' : 'true' })
  }

  const commit = () => {
    setManualWind(magnetic ? magneticToTrue(dir, decl) : wrap360(dir), Math.max(0, tws))
    if (windMode !== 'manual') setWindMode('manual')
    onClose()
  }
  const useForecast = () => {
    setWindMode('forecast')
    onClose()
  }

  return (
    <div className="sheet wind-sheet" role="dialog" aria-label="Set the wind">
      <div className="sheet__grip" />
      <h2 className="wind-sheet__title">Wind</h2>
      <p className="note">
        {windMode === 'forecast'
          ? 'In use: the Open-Meteo forecast at your position. Setting it here switches to manual.'
          : setAt == null
            ? 'Not set yet. Luff head to wind, read your heading, and set it here.'
            : 'In use: the wind you set by hand.'}
      </p>

      <div className="wind-sheet__value" aria-live="polite">
        <label>
          <span>FROM</span>
          <input
            type="number"
            inputMode="numeric"
            aria-label={`Wind direction, degrees ${magnetic ? 'magnetic' : 'true'}`}
            value={dir}
            onChange={(e) => setDir(Number(e.target.value))}
          />
        </label>
        <div className="seg wind-sheet__north" role="group" aria-label="North reference">
          <button aria-pressed={!magnetic} onClick={() => showNorth(false)}>
            °T
          </button>
          <button aria-pressed={magnetic} onClick={() => showNorth(true)}>
            °M
          </button>
        </div>
      </div>
      {magnetic && (
        <p className="note">
          = {fmtDeg(magneticToTrue(dir, decl))}°T. Variation {Math.abs(decl).toFixed(1)}°{' '}
          {decl < 0 ? 'W' : 'E'} here (NOAA {PILOT_VENUE.declination.model}).
        </p>
      )}
      <div className="wind-sheet__steps">
        {DIR_STEPS.map((d) => (
          <button key={d} className="btn btn--sm" onClick={() => setDir((v) => wrap360(v + d))}>
            {d > 0 ? `+${d}` : d}
          </button>
        ))}
      </div>

      <div className="wind-sheet__value">
        <label>
          <span>SPEED</span>
          <input
            type="number"
            inputMode="decimal"
            aria-label="True wind speed, knots"
            value={tws}
            onChange={(e) => setTws(Number(e.target.value))}
          />
          <span>kn</span>
        </label>
      </div>
      <div className="wind-sheet__steps wind-sheet__steps--2">
        <button className="btn btn--sm" onClick={() => setTws((v) => Math.max(0, v - 1))}>
          −1 kn
        </button>
        <button className="btn btn--sm" onClick={() => setTws((v) => v + 1)}>
          +1 kn
        </button>
      </div>

      <button className="btn btn--primary" onClick={commit}>
        SET WIND {fmtDeg(dir)}°{magnetic ? 'M' : ''} · {Math.max(0, tws)} kn
      </button>
      <div className="wind-sheet__steps wind-sheet__steps--2">
        <button className="btn btn--sm btn--ghost" onClick={useForecast} disabled={windMode === 'forecast'}>
          USE FORECAST
        </button>
        <button className="btn btn--sm btn--ghost" onClick={onClose}>
          CANCEL
        </button>
      </div>
    </div>
  )
}

/**
 * What the top-bar chip says about the wind in use: where it comes from, and,
 * for a wind typed by hand, how long ago - a sequence of starts runs well past
 * the half hour in which a breeze can swing twenty degrees.
 */
export function windChip(
  wind: { twd: number; tws: number; source: string } | null,
  manualSetAt: number | null,
  now: number,
  /** East-positive declination to show the direction in magnetic, or null for true. */
  magneticDecl: number | null = null,
): { text: string; warn: boolean } {
  if (!wind) return { text: manualSetAt == null ? 'set wind' : 'wind unavailable', warn: true }
  // Unmarked degrees are true, as everywhere else in the app; magnetic is marked M.
  const dir =
    magneticDecl == null ? `${fmtDeg(wind.twd)}°` : `${fmtDeg(trueToMagnetic(wind.twd, magneticDecl))}°M`
  const base = `${dir} · ${wind.tws.toFixed(0)} kn · ${wind.source}`
  if (wind.source !== 'manual' || manualSetAt == null) return { text: base, warn: false }
  const ageMin = (now - manualSetAt) / 60_000
  if (ageMin < STALE_MANUAL_MIN) return { text: base, warn: false }
  const age = ageMin < 90 ? `${Math.round(ageMin)} min` : `${Math.round(ageMin / 60)} h`
  return { text: `${base} · ${age} old`, warn: true }
}

/** A hand-set wind older than this is shown with its age, in the warning colour. */
export const STALE_MANUAL_MIN = 20
