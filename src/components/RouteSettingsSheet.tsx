/**
 * Routing settings: the forecast corrections, hard limits, penalties and
 * resolution that Expedition keeps under its optimal-routing options.
 *
 * Every field maps one to one onto the kernel's RouteRequest through
 * `requestParts` (src/lib/routing/settings.ts). Nothing here is computed on the
 * screen. A limit left blank is no limit. A limit set to zero would make the
 * whole sea impassable, and that is what an empty field used to become.
 */

import { useStore } from '@/state/store'
import { DEFAULT_ROUTE_SETTINGS, type RouteSettings } from '@/lib/routing/settings'
import type { RouteResolution } from '@/lib/types'

const RESOLUTIONS: Array<{ id: RouteResolution; label: string }> = [
  { id: 'fast', label: 'Fast' },
  { id: 'balanced', label: 'Balanced' },
  { id: 'best', label: 'Best' },
]

/** A number from a field, or the fallback when it is blank or not a number. */
export function numberOr(raw: string, fallback: number): number {
  const v = Number(raw.trim())
  return raw.trim() === '' || !Number.isFinite(v) ? fallback : v
}

/** An optional positive limit: blank, zero or negative means "no limit". */
export function limitFrom(raw: string): number | null {
  const v = Number(raw.trim())
  return raw.trim() === '' || !Number.isFinite(v) || v <= 0 ? null : v
}

export function RouteSettingsSheet({ onClose }: { onClose: () => void }) {
  const s = useStore((st) => st.routeSettings)
  const update = useStore((st) => st.updateRouteSettings)
  const boat = useStore((st) => st.boat)
  const updateBoat = useStore((st) => st.updateBoat)

  const num = (key: keyof RouteSettings, label: string, unit: string, step: string) => (
    <div className="field">
      <label htmlFor={`rs-${key}`}>
        {label} <span className="note">{unit}</span>
      </label>
      <input
        id={`rs-${key}`}
        type="number"
        step={step}
        value={s[key] as number}
        onChange={(e) =>
          update({ [key]: numberOr(e.target.value, DEFAULT_ROUTE_SETTINGS[key] as number) })
        }
        inputMode="decimal"
      />
    </div>
  )

  const limit = (
    key: 'maxTws' | 'minTws' | 'maxGust' | 'maxWaveHeightM' | 'maxTwsUpwind' | 'maxTwsDownwind' | 'motorSpeedKn' | 'motorBelowKn',
    label: string,
    unit: string,
  ) => (
    <div className="field">
      <label htmlFor={`rs-${key}`}>
        {label} <span className="note">{unit}</span>
      </label>
      <input
        id={`rs-${key}`}
        type="number"
        step="0.5"
        min="0"
        placeholder="no limit"
        value={s[key] ?? ''}
        onChange={(e) => update({ [key]: limitFrom(e.target.value) })}
        inputMode="decimal"
      />
    </div>
  )

  return (
    <div className="sheet" role="dialog" aria-label="Routing settings">
      <div className="sheet__grip" onClick={onClose} />
      <h2>Resolution</h2>
      <div className="seg" style={{ marginBottom: 6 }} role="group" aria-label="Resolution">
        {RESOLUTIONS.map((r) => (
          <button
            key={r.id}
            aria-pressed={s.resolution === r.id}
            onClick={() => update({ resolution: r.id })}
          >
            {r.label}
          </button>
        ))}
      </div>
      <p className="note">
        The time step is chosen from the forecast, the leg and the boat. Best halves it
        again, and takes several times longer.
      </p>

      <h2>Forecast corrections</h2>
      {num('windScalePct', 'Wind speed', '%', '1')}
      {num('windRotateDeg', 'Wind direction', '° (+ veers)', '1')}
      {num('windTimeShiftMin', 'Weather timing', 'min (+ late)', '15')}
      {num('currentScalePct', 'Current', '%', '5')}
      <p className="note">
        Use these when the forecast is visibly wrong: lighter than the water shows,
        backed, or an hour behind the front. A +60 min shift uses the 17:00 forecast at
        18:00. They apply to every route until you set them back.
      </p>

      <h2>Avoid</h2>
      {limit('maxTws', 'Wind above', 'kn')}
      {limit('minTws', 'Wind below', 'kn')}
      {limit('maxGust', 'Gusts above', 'kn')}
      {limit('maxWaveHeightM', 'Waves above', 'm')}
      {limit('maxTwsUpwind', 'Beating in wind above', 'kn')}
      {limit('maxTwsDownwind', 'Running in wind above', 'kn')}

      <h2>Display</h2>
      <div className="field">
        <label htmlFor="rs-band">Shade water within <span className="note">min of the best route</span></label>
        <input
          id="rs-band"
          type="number"
          min="1"
          max="120"
          step="1"
          value={s.bandMin}
          onChange={(e) => update({ bandMin: Math.max(1, Math.min(120, Number(e.target.value) || 10)) })}
          inputMode="numeric"
        />
      </div>
      <div className="field">
        <label htmlFor="rs-iso-every">Draw an isochrone every</label>
        <select id="rs-iso-every" value={s.isoEveryMin} onChange={(e) => update({ isoEveryMin: Number(e.target.value) })}>
          <option value={0}>time step</option>
          <option value={15}>15 min</option>
          <option value={30}>30 min</option>
          <option value={60}>hour</option>
          <option value={180}>3 hours</option>
          <option value={360}>6 hours</option>
        </select>
      </div>

      <label className="field" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <input
          type="checkbox"
          checked={s.showExplored}
          aria-label="Draw every explored path"
          onChange={(e) => update({ showExplored: e.target.checked })}
        />
        <span>Draw every path the search kept, not only the best. On from the next route.</span>
      </label>

      <h2>Motor</h2>
      {limit('motorBelowKn', 'Motor when sailing is slower than', 'kn')}
      {limit('motorSpeedKn', 'Motoring speed', 'kn')}
      <p className="note">
        Both, or neither: with a motoring speed and a least sailing speed, the route motors wherever the polar is slower.
      </p>

      <h2>Manoeuvres</h2>
      <div className="field">
        <label htmlFor="rs-tack">
          Tack costs <span className="note">s</span>
        </label>
        <input
          id="rs-tack"
          type="number"
          step="1"
          min="0"
          value={boat.tackPenaltyS}
          onChange={(e) => updateBoat({ tackPenaltyS: Math.max(0, numberOr(e.target.value, 0)) })}
          inputMode="numeric"
        />
      </div>
      <div className="field">
        <label htmlFor="rs-gybe">
          Gybe costs <span className="note">s</span>
        </label>
        <input
          id="rs-gybe"
          type="number"
          step="1"
          min="0"
          value={boat.gybePenaltyS}
          onChange={(e) => updateBoat({ gybePenaltyS: Math.max(0, numberOr(e.target.value, 0)) })}
          inputMode="numeric"
        />
      </div>

      <div className="actions">
        <button
          className="btn btn--sm btn--ghost"
          onClick={() => update({ ...DEFAULT_ROUTE_SETTINGS })}
        >
          RESET
        </button>
        <button className="btn btn--sm" onClick={onClose}>
          DONE
        </button>
      </div>
    </div>
  )
}
