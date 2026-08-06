/**
 * Setup — boat, polar, wind source, and the honest disclaimer.
 *
 * Product rule (docs/05-spec/product-spec.md §3): the first useful answer
 * arrives with zero setup. Everything on this screen has a working default,
 * and nothing here blocks the start screen.
 */

import { useMemo } from 'react'
import { useStore } from '@/state/store'
import { POLAR_LIBRARY, findPolar } from '@/data/polars'
import { buildLattice, parsePolar, validatePolar } from '@/lib/polar'
import { PolarPlot } from '@/components/PolarPlot'
import { PILOT_VENUE } from '@/data/venues'

export function SetupScreen() {
  const boat = useStore((s) => s.boat)
  const updateBoat = useStore((s) => s.updateBoat)
  const polarId = useStore((s) => s.polarId)
  const polar = useStore((s) => s.polar)
  const setPolar = useStore((s) => s.setPolar)
  const settings = useStore((s) => s.settings)
  const updateSettings = useStore((s) => s.updateSettings)
  const manualWind = useStore((s) => s.manualWind)
  const setManualWind = useStore((s) => s.setManualWind)
  const windMode = useStore((s) => s.windMode)
  const setWindMode = useStore((s) => s.setWindMode)
  const track = useStore((s) => s.track)
  const clearTrack = useStore((s) => s.clearTrack)

  const issues = useMemo(() => (polar ? validatePolar(polar) : []), [polar])
  const lattice = useMemo(() => {
    if (!polar) return null
    try {
      return buildLattice(polar)
    } catch {
      return null
    }
  }, [polar])

  const pickClass = (id: string) => {
    const entry = findPolar(id)
    if (!entry) return
    setPolar(id, entry.polar)
    updateBoat({ className: entry.name, loaMetres: entry.loaM })
  }

  const importPolar = async (file: File) => {
    const text = await file.text()
    try {
      const p = parsePolar(text, file.name.replace(/\.[^.]+$/, ''))
      setPolar('custom', p)
    } catch (e) {
      alert(`Could not read that polar: ${e instanceof Error ? e.message : e}`)
    }
  }

  return (
    <div className="screen">
      <div className="panel">
        <h2>Pilot venue</h2>
        <div className="rows">
          <div className="row">
            <span>Area</span>
            <span>{PILOT_VENUE.name}</span>
          </div>
          <div className="row">
            <span>Tide station</span>
            <span>{PILOT_VENUE.tideStations[0].id} · {PILOT_VENUE.tideStations[0].name}</span>
          </div>
        </div>
        <p className="note">
          Portland &amp; Casco Bay is the MVP pilot. Forecast, chart, tide/current,
          observation, coastline, and bathymetry sources are tracked in the venue
          manifest; the app remains advisory only.
        </p>

        <h2>Boat</h2>
        <div className="field">
          <label>Name</label>
          <input
            value={boat.name}
            onChange={(e) => updateBoat({ name: e.target.value })}
            inputMode="text"
          />
        </div>
        <div className="field">
          <label>Class</label>
          <select value={polarId} onChange={(e) => pickClass(e.target.value)}>
            {POLAR_LIBRARY.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
            {polarId === 'custom' && <option value="custom">Custom (imported)</option>}
          </select>
        </div>
        <div className="field">
          <label>Length overall</label>
          <input
            type="number"
            step="0.1"
            value={boat.loaMetres}
            onChange={(e) => updateBoat({ loaMetres: Number(e.target.value) })}
            inputMode="decimal"
          />
        </div>
        <div className="field">
          <label>Bow to GPS</label>
          <input
            type="number"
            step="0.1"
            value={boat.bowToGpsMetres}
            onChange={(e) => updateBoat({ bowToGpsMetres: Number(e.target.value) })}
            inputMode="decimal"
          />
        </div>
        <div className="field">
          <label>Mast height</label>
          <input
            type="number"
            step="0.5"
            value={boat.mastHeightMetres}
            onChange={(e) => updateBoat({ mastHeightMetres: Number(e.target.value) })}
            inputMode="decimal"
          />
        </div>
        <p className="note">
          Mast height is used to scale forecast wind from 10&nbsp;m to masthead
          height — <strong>TWS(h) = TWS(10m)·(h/10)^0.12</strong>. A 20&nbsp;m rig
          reads about 9% more breeze than the model says. Getting this wrong
          quietly poisons every target number.
        </p>
        <div className="field">
          <label>Draft</label>
          {/*
            Deliberately blank rather than defaulted, and not filled in from the
            class list the way length is. A boat's real draft depends on the keel
            fitted and the board being down, and a clearance number computed from a
            guessed draft looks exactly like one computed from a measurement.
          */}
          <input
            type="number"
            step="0.05"
            min="0"
            placeholder="not set"
            value={boat.draftMetres ?? ''}
            onChange={(e) => {
              const raw = e.target.value.trim()
              const v = Number(raw)
              updateBoat({
                draftMetres: raw === '' || !Number.isFinite(v) || v <= 0 ? undefined : v,
              })
            }}
            inputMode="decimal"
          />
        </div>
        <p className="note">
          Draft is the deepest point with the keel or board down. Leave it blank if
          you are not sure — the route depth check then reports water depth rather
          than water under the keel, and says so, instead of inventing a clearance
          from a number nobody entered.
        </p>

        <h2>Performance</h2>
        <div className="field">
          <label>Polar %</label>
          <input
            type="number"
            step="1"
            value={boat.polarPct}
            onChange={(e) => updateBoat({ polarPct: Number(e.target.value) })}
            inputMode="numeric"
          />
        </div>
        <div className="field">
          <label>Night polar %</label>
          <input
            type="number"
            step="1"
            value={boat.polarPctNight}
            onChange={(e) => updateBoat({ polarPctNight: Number(e.target.value) })}
            inputMode="numeric"
          />
        </div>
        <p className="note">
          How well are you actually sailing today? 100% is the book. Most crews
          most of the time are somewhere between 88 and 96.
        </p>

        <h2>Polar</h2>
        {polar ? (
          <>
            <PolarPlot lattice={lattice} />
            <div className="rows" style={{ marginTop: 8 }}>
              <div className="row">
                <span>Source</span>
                <span>{polar.source ?? polar.name}</span>
              </div>
              <div className="row">
                <span>Wind speeds</span>
                <span>{polar.tws.length} rows</span>
              </div>
              <div className="row">
                <span>Reference height</span>
                <span>{polar.reference}</span>
              </div>
            </div>
          </>
        ) : (
          <div className="warnbox">No polar loaded. Pick a class above.</div>
        )}
        {issues.map((i: { severity: string; message: string }, n: number) => (
          <div key={n} className={i.severity === 'error' ? 'errbox' : 'warnbox'}>
            {i.message}
          </div>
        ))}
        <label className="btn btn--sm" style={{ display: 'block', marginTop: 8 }}>
          IMPORT POLAR FILE
          <input
            type="file"
            accept=".txt,.pol,.csv"
            style={{ display: 'none' }}
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) void importPolar(f)
            }}
          />
        </label>
        <p className="note">
          Reads Expedition <code>.txt</code> polars (TWS in the first column,
          then TWA/BSP pairs) and qtVlm/ORC CSV.
        </p>

        <h2>Wind</h2>
        <div className="seg" style={{ marginBottom: 10 }}>
          {(['manual', 'forecast'] as const).map((m) => (
            <button
              key={m}
              aria-pressed={windMode === m}
              onClick={() => setWindMode(m)}
            >
              {m === 'manual' ? 'Manual' : 'Forecast'}
            </button>
          ))}
        </div>
        <div className="field">
          <label>TWD</label>
          <input
            type="number"
            step="1"
            value={manualWind.twd}
            onChange={(e) => setManualWind(Number(e.target.value), manualWind.tws)}
            inputMode="numeric"
          />
        </div>
        <div className="field">
          <label>TWS</label>
          <input
            type="number"
            step="0.5"
            value={manualWind.tws}
            onChange={(e) => setManualWind(manualWind.twd, Number(e.target.value))}
            inputMode="decimal"
          />
        </div>
        <p className="note">
          With no wind instrument, manual is usually the honest answer: luff head
          to wind once, read your heading, type it in. Forecast uses the current
          GPS position (or Portland when no fix exists) and refreshes every 15 minutes.
          The app shows the wind source on every screen so you always know what the
          numbers rest on.
        </p>

        <h2>Session</h2>
        <div className="field">
          <label>Simulate a boat</label>
          <input
            type="checkbox"
            checked={settings.simulate}
            onChange={(e) => updateSettings({ simulate: e.target.checked })}
            style={{ width: 26, height: 26 }}
          />
        </div>
        <div className="field">
          <label>Keep screen awake</label>
          <input
            type="checkbox"
            checked={settings.keepAwake}
            onChange={(e) => updateSettings({ keepAwake: e.target.checked })}
            style={{ width: 26, height: 26 }}
          />
        </div>
        <p className="note">
          Simulation replaces the GPS with a synthetic boat that sails your polar,
          tacks through the no-go zone and drifts with current — so you can try
          everything without leaving the dock.
        </p>

        <div className="field">
          <label>Track points</label>
          <span style={{ fontSize: 14 }}>{track.length.toLocaleString()}</span>
        </div>
        <button className="btn btn--sm btn--ghost" onClick={clearTrack}>
          CLEAR TRACK
        </button>

        <h2>Safety</h2>
        <div className="warnbox">
          <b>Not for navigation.</b> This is a prototype. Nothing here replaces
          official charts, official tide tables, or your own judgment. Routing
          output is derived from weather forecasts, which are uncertain by nature.
          The skipper is responsible for the safety of the vessel and crew.
        </div>
        <p className="note">
          Weather: Open-Meteo (GFS / ECMWF / ICON). Charts: OpenStreetMap ©
          contributors, OpenSeaMap (CC-BY-SA). See{' '}
          <code>docs/02-data-sources/licensing-matrix.md</code>.
        </p>
      </div>
    </div>
  )
}
