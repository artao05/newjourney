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
import { useState } from 'react'
import { parseTable } from '@/lib/instruments/calibration'
import { DEFAULT_ROUTE_SETTINGS, type RouteSettings } from '@/lib/routing/settings'
import type { RouteResolution } from '@/lib/types'
import { MODELS, type ModelId } from '@/lib/weather/openmeteo'

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
  // Colours are the chart's, not the router's: in the app settings, so they never make a route stale.
  const routeColour = useStore((st) => st.settings.routeColour)
  const markColour = useStore((st) => st.settings.markColour)
  const keepRoutes = useStore((st) => st.settings.keepRoutes)
  const updateSettings = useStore((st) => st.updateSettings)
  const [waveError, setWaveError] = useState<string | null>(null)
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
      <h2>Weather</h2>
      <div className="field">
        <label htmlFor="rs-model">Forecast to download</label>
        <select id="rs-model" value={s.model} onChange={(e) => update({ model: e.target.value as ModelId })}>
          {MODELS.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
      </div>
      <div className="seg" role="group" aria-label="Route on" style={{ marginBottom: 6 }}>
        <button aria-pressed={s.source === 'merged'} onClick={() => update({ source: 'merged' })}>Merged</button>
        <button aria-pressed={s.source === 'download'} onClick={() => update({ source: 'download' })}>Download only</button>
        <button aria-pressed={s.source === 'files'} onClick={() => update({ source: 'files' })}>GRIB files only</button>
      </div>
      <p className="note" style={{ marginBottom: 12 }}>
        {s.source === 'merged'
          ? 'The download and every ticked GRIB file, the finest grid answering first where they overlap.'
          : s.source === 'download'
            ? 'Only the downloaded forecast; GRIB files are left out.'
            : 'Only the ticked GRIB files, the finest first. Tick just one to route on that file alone.'}
      </p>
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

      <div className="field">
        <label htmlFor="rs-now">Blend in the wind now, fading over <span className="note">min, 0 off</span></label>
        <input
          id="rs-now"
          type="number"
          min="0"
          max="1440"
          step="15"
          value={s.nowDecayMin}
          onChange={(e) => update({ nowDecayMin: Math.max(0, Math.min(1440, Number(e.target.value) || 0)) })}
          inputMode="numeric"
        />
      </div>
      <p className="note">
        The difference between the wind now (instruments or manual) and the forecast at the start, applied in full now
        and fading to the forecast over that time.
      </p>

      <h2>Algorithm</h2>
      <div className="seg" role="group" aria-label="Routing algorithm" style={{ marginBottom: 6 }}>
        <button aria-pressed={s.algorithm === 'isochrone'} onClick={() => update({ algorithm: 'isochrone' })}>Isochrones</button>
        <button aria-pressed={s.algorithm === 'grid'} onClick={() => update({ algorithm: 'grid' })}>Grid</button>
      </div>
      {s.algorithm === 'grid' && (
        <label className="field" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input type="checkbox" checked={s.greatCircle} aria-label="Grid along the great circle"
            onChange={(e) => update({ greatCircle: e.target.checked })} />
          <span>Lay the grid along the great circle, for long ocean legs.</span>
        </label>
      )}
      <p className="note">
        The grid is a second opinion: simpler, with no tack costs and no going back, so the isochrones are usually a
        little faster. No isochrones or sensitivity band are drawn for it.
      </p>
      <label className="field" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <input type="checkbox" checked={s.firstLegOnly} aria-label="First leg only" onChange={(e) => update({ firstLegOnly: e.target.checked })} />
        <span>First leg only: route to the active mark, not round the whole course. Quicker, for the leg in hand.</span>
      </label>

      <h2>Waves</h2>
      <p className="note">
        {s.waveTable
          ? `Wave table: ${s.waveTable.heights.length} heights by ${s.waveTable.angles.length} angles.`
          : 'No wave table: waves change nothing but the wave limit above.'}
      </p>
      <div className="actions" style={{ background: 'none', border: 'none', padding: '0 0 8px' }}>
        <label className="btn btn--sm btn--ghost" style={{ cursor: 'pointer' }}>
          IMPORT WAVE TABLE
          <input
            type="file"
            accept=".txt,.csv,text/plain,text/csv"
            aria-label="Import a wave table"
            style={{ display: 'none' }}
            onChange={async (e) => {
              const f = e.target.files?.[0]
              e.target.value = ''
              if (!f) return
              try {
                const t = parseTable(await f.text())
                update({ waveTable: { heights: t.rows, angles: t.cols, pct: t.values } })
                setWaveError(null)
              } catch (err) {
                setWaveError(err instanceof Error ? err.message : String(err))
              }
            }}
          />
        </label>
        {s.waveTable && (
          <button className="btn btn--sm btn--ghost" onClick={() => update({ waveTable: null })}>
            CLEAR
          </button>
        )}
      </div>
      {waveError && <p className="warnbox" role="alert">{waveError}</p>}
      <p className="note">
        A line of wave angles to the boat (0 head seas, 180 following), then a line per wave height in metres
        with the percentage of polar speed at each angle.
      </p>
      {num('swellPct', 'Slower in swell', '% at the reference height', '1')}
      {num('windWavePct', 'Slower in wind sea', '% at the reference height; the polar usually has it already', '1')}
      {num('waveRefHeightM', 'Reference height', 'm, full effect here and above', '0.5')}
      {num('crossedSeaPct', 'Slower in a crossed sea', '% more where swell and wind sea cross near 90°', '1')}
      {s.crossedSeaPct > 0 && (
        <>
          {num('crossedMinM', 'Crossed sea: each train above', 'm', '0.1')}
          {num('crossedTotalM', 'Crossed sea: together above', 'm', '0.1')}
          {num('crossedMarginDeg', 'Crossed sea: within', '° of 90°', '5')}
        </>
      )}
      <p className="note">
        The swell is the forecast's swell where it gives one, else its main sea. With no sea state in the forecast these
        change nothing, and the route says so.
      </p>

      <h2>Tidal streams</h2>
      <label style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 6 }}>
        <input type="checkbox" checked={s.tidalStreams} onChange={(e) => update({ tidalStreams: e.target.checked })} />
        Route with NOAA's tidal streams
      </label>
      {s.tidalStreams && num('tidalRadiusNm', 'Within', 'nm of a current station, over the forecast current', '1')}
      <p className="note">
        Predicted from the harmonic current stations near the course, weighted by distance; farther out the forecast's current
        stands.
      </p>

      <h2>Air</h2>
      <label style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 6 }}>
        <input type="checkbox" checked={s.airDensity} onChange={(e) => update({ airDensity: e.target.checked })} />
        Correct the wind for air density
      </label>
      <p className="note">
        Denser air pushes harder: the polar reads the wind as √(ρ/ρ₀) times it, against 1013 hPa, 15 °C and 80 % humidity,
        from the forecast's pressure, air temperature and humidity.
      </p>

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
      <div className="field">
        <label htmlFor="rs-keep">Keep the last <span className="note">routes, to compare</span></label>
        <input id="rs-keep" type="number" min="1" max="10" step="1" value={keepRoutes} onChange={(e) => updateSettings({ keepRoutes: Math.max(1, Math.min(10, Number(e.target.value) || 1)) })} />
      </div>
      <div className="field">
        <label htmlFor="rs-route-colour">Route colour</label>
        <input id="rs-route-colour" type="color" value={routeColour} onChange={(e) => updateSettings({ routeColour: e.target.value })} />
      </div>
      <div className="field">
        <label htmlFor="rs-mark-colour">Mark colour</label>
        <input id="rs-mark-colour" type="color" value={markColour} onChange={(e) => updateSettings({ markColour: e.target.value })} />
      </div>

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
