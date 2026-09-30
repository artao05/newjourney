/**
 * Setup — boat, polar, wind source, and the honest disclaimer.
 *
 * Product rule (docs/05-spec/product-spec.md §3): the first useful answer
 * arrives with zero setup. Everything on this screen has a working default,
 * and nothing here blocks the start screen.
 */

import { clearErrors, errorsText, readErrors } from '@/lib/errorLog'
import { useChannelsOutStatus } from '@/components/ChannelsOutBridge'
import { useMemo, useState } from 'react'
import { MAX_TRACK_POINTS, useStore } from '@/state/store'
import { POLAR_LIBRARY, findPolar } from '@/data/polars'
import { buildLattice, parsePolar, serialiseExpeditionPolar, validatePolar } from '@/lib/polar'
import { PolarWithLog } from '@/components/PolarWithLog'
import { PolarEditor } from '@/components/PolarEditor'
import { TargetsTable } from '@/components/TargetsTable'
import { SailChartView } from '@/components/SailChartView'
import { twaFrom } from '@/lib/angles'

/** The wind speeds the polar plot can draw at once: light, the usual spread, heavy. */
const PLOT_SETS: number[][] = [
  [2, 4, 6, 8],
  [6, 10, 14, 20],
  [16, 20, 25, 30],
]
import { NotForNavigationText } from '@/components/NotForNavigation'
import { PILOT_VENUE } from '@/data/venues'
import { PORTLAND_DATUM } from '@/lib/tides/datum'
import { windHeightFactor } from '@/lib/routing/settings'
import { SHORTCUT_HELP } from '@/lib/shortcuts'
import { ConfigError, exportConfig, parseConfig } from '@/lib/config'
import { InstrumentsSection } from '@/components/InstrumentsSection'
import { CalibrationSection } from '@/components/CalibrationSection'
import { GpsSection } from '@/components/GpsSection'
import { LogsSection } from '@/components/LogsSection'
import { AlarmsSection } from '@/components/Alarms'
import { useVariation } from '@/hooks/useVariation'

/**
 * How to name the tide station on the venue panel.
 *
 * Takes both sources rather than reading them, because the whole point is which
 * one wins: the station the app queries is the datum's, and the manifest only
 * supplies a human name for it. Exported because the interesting branch is the
 * one where they disagree, and that branch is unreachable while they do not.
 */
export function tideStationLabel(
  venue: { tideStations: ReadonlyArray<{ id: string; name: string }> },
  datum: { stationId: string },
): string {
  const id = datum.stationId
  const listed = venue.tideStations.find((st) => st.id === id)
  return listed ? `${id} · ${listed.name}` : `${id} · not listed in the venue manifest`
}

/** A local `YYYY-MM-DD-HHMM` for a file name: sortable, and the sailor's own clock. */
export function fileStamp(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`
}

export function SetupScreen() {
  const variation = useVariation()
  const boat = useStore((s) => s.boat)
  const updateBoat = useStore((s) => s.updateBoat)
  const polarId = useStore((s) => s.polarId)
  const polar = useStore((s) => s.polar)
  const polarRoles = useStore((s) => s.polarRoles)
  const [editingPolar, setEditingPolar] = useState(false)
  const liveWind = useStore((s) => s.wind)
  const liveState = useStore((s) => s.state)
  const liveCourse = liveState ? liveState.heading ?? liveState.cog : null
  const liveTwa =
    liveWind && liveCourse != null && Number.isFinite(liveCourse) ? twaFrom(liveCourse, liveWind.twd) : null
  const [plotSpeeds, setPlotSpeeds] = useState<number[]>(PLOT_SETS[1])
  const setPolarRole = useStore((s) => s.setPolarRole)
  const setPolar = useStore((s) => s.setPolar)
  const settings = useStore((s) => s.settings)
  const updateSettings = useStore((s) => s.updateSettings)
  const manualWind = useStore((s) => s.manualWind)
  // Unset shows as empty, not as the placeholder values - a field reading 270
  // looks exactly like a wind somebody chose.
  const manualWindSetAt = useStore((s) => s.manualWindSetAt)
  const setManualWind = useStore((s) => s.setManualWind)
  const windMode = useStore((s) => s.windMode)
  const setWindMode = useStore((s) => s.setWindMode)
  const track = useStore((s) => s.track)
  const clearTrack = useStore((s) => s.clearTrack)
  const exportTrack = async () => {
    if (track.length === 0) return
    const { trackToGpx, downloadText } = await import('@/lib/gpx')
    const stamp = fileStamp(track[0].t)
    downloadText(`newjourney-track-${stamp}.gpx`, trackToGpx(track, `newjourney track ${stamp}`))
  }

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

  /** Everything configured, as one file: Expedition's "Save user configuration". */
  const exportSettings = async () => {
    const { downloadText } = await import('@/lib/gpx')
    const cfg = exportConfig(useStore.getState())
    const stamp = cfg.exportedAt.slice(0, 10)
    const who = boat.name.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'boat'
    downloadText(`newjourney-${who}-${stamp}.json`, JSON.stringify(cfg, null, 2), 'application/json')
  }

  const importSettings = async (file: File) => {
    try {
      useStore.getState().applyConfig(parseConfig(await file.text()))
    } catch (e) {
      alert(e instanceof ConfigError ? e.message : `Could not read that file: ${e}`)
    }
  }

  /** Save the loaded polar as an Expedition .txt, the format it reads back in. */
  const exportPolar = async () => {
    if (!polar) return
    const { downloadText } = await import('@/lib/gpx')
    const safe = polar.name.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'polar'
    downloadText(`${safe}.txt`, serialiseExpeditionPolar(polar), 'text/plain')
  }

  const polarPort = useStore((s) => s.polarPort)
  const setPolarPort = useStore((s) => s.setPolarPort)
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
            {/*
              * The station the app actually queries, which is the datum's, not the
              * manifest's. They are the same station and `venues.test.ts` keeps
              * them that way — but this line is provenance, and provenance read
              * from a different source than the one in use is not provenance. If
              * they ever diverge this shows the truth and says the manifest does
              * not list it, rather than quietly naming the wrong station.
              */}
            <span>{tideStationLabel(PILOT_VENUE, PORTLAND_DATUM)}</span>
          </div>
        </div>
        <p className="note">
          Portland &amp; Casco Bay is the MVP pilot. Forecast, chart, tide/current,
          observation, coastline, and bathymetry sources are tracked in the venue
          manifest; the app remains advisory only.
        </p>

        <h2>Units</h2>
        <div className="seg" style={{ marginBottom: 6 }} role="group" aria-label="Units">
          {(['metric', 'imperial'] as const).map((u) => (
            <button key={u} aria-pressed={settings.units === u} onClick={() => updateSettings({ units: u })}>
              {u === 'metric' ? 'Metres' : 'Feet'}
            </button>
          ))}
        </div>
        <p className="note">
          For depth, draft and the start line. Speed stays in knots and distance in
          nautical miles either way, as on the chart. Boat dimensions below are
          entered in metres.
        </p>

        <h2>Configuration</h2>
        <div className="actions" style={{ background: 'none', border: 'none', padding: 0 }}>
          <button className="btn btn--sm btn--ghost" onClick={() => void exportSettings()}>
            EXPORT SETTINGS
          </button>
          <label className="btn btn--sm btn--ghost" style={{ display: 'block', textAlign: 'center' }}>
            IMPORT SETTINGS
            <input
              type="file"
              accept=".json,application/json"
              aria-label="Import settings file"
              style={{ display: 'none' }}
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) void importSettings(f)
                e.target.value = ''
              }}
            />
          </label>
        </div>
        <p className="note">
          One file with the boat, its polar, the course, units, routing options and
          number boxes. Use it to move to another device, or to switch between
          boats. The live position, routes and the track are not in it.
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
        {/*
          This note used to say mast height scaled the forecast, and nothing did.
          It now describes what routing actually does with the loaded polar.
        */}
        <p className="note" data-testid="mast-height-note">
          Forecasts give wind at 10&nbsp;m, and masthead wind blows harder:{' '}
          <strong>TWS(h) = TWS(10m)·(h/10)^0.12</strong>, about 9% more on a
          20&nbsp;m rig. Routing lifts the forecast to your mast height when the
          polar is referenced to masthead wind, as one tuned from your own
          instruments usually is.{' '}
          {polar?.reference === 'masthead' ? (
            <>
              This polar is, so the forecast is scaled by{' '}
              <strong>×{windHeightFactor('masthead', boat.mastHeightMetres).toFixed(2)}</strong>.
            </>
          ) : (
            <>This polar is referenced to 10&nbsp;m, like the forecast, so nothing is scaled.</>
          )}
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
        <div className="field">
          <label htmlFor="wind-weight">Wind weight <span className="note">×, heavier air over 1</span></label>
          <input
            id="wind-weight"
            type="number"
            step="0.01"
            min="0.7"
            max="1.3"
            value={boat.windWeight ?? 1}
            onChange={(e) => {
              const v = Number(e.target.value)
              if (v >= 0.7 && v <= 1.3) updateBoat({ windWeight: v })
            }}
            inputMode="decimal"
          />
        </div>
        <p className="note">
          How well are you actually sailing today? 100% is the book. Most crews
          most of the time are somewhere between 88 and 96.
        </p>

        <h2>Polar</h2>
        {polar ? (
          <>
            <div className="seg" role="group" aria-label="Plot wind speeds" style={{ marginBottom: 6 }}>
              {PLOT_SETS.map((set) => (
                <button
                  key={set.join(',')}
                  aria-pressed={plotSpeeds.join(',') === set.join(',')}
                  onClick={() => setPlotSpeeds(set)}
                >
                  {set.join('/')} kn
                </button>
              ))}
            </div>
            <PolarWithLog lattice={lattice} speeds={plotSpeeds} />
            <TargetsTable polar={polar} polarPct={boat.polarPct} />
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
        <button
          className="btn btn--sm btn--ghost"
          style={{ display: 'block', width: '100%', marginTop: 8 }}
          onClick={() => setEditingPolar(true)}
          disabled={!polar}
        >
          EDIT POLAR
        </button>
        {editingPolar && <PolarEditor onClose={() => setEditingPolar(false)} />}

        <SailChartView twa={liveTwa} tws={liveWind?.tws ?? null} />

        <h2>Polar roles</h2>
        {(['performance', 'start'] as const).map((role) => (
          <div className="field field--wide" key={role}>
            <label htmlFor={'role-' + role}>{role === 'performance' ? 'Performance polar' : 'Start polar'}</label>
            <select
              id={'role-' + role}
              value={polarRoles[role]}
              onChange={(e) => setPolarRole(role, e.target.value)}
            >
              <option value="navigation">Same as the navigation polar</option>
              {POLAR_LIBRARY.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
        ))}
        <p className="note">
          As in Expedition, the polar above is the navigation polar, used for routing,
          laylines and mark times. The performance polar gives Polar BSP, Polar % and the
          targets, and can be the book polar while navigation uses today&apos;s. The start
          polar drives the start numbers, and can be a slower one for a downwind start.
        </p>

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
        <button
          className="btn btn--sm btn--ghost"
          style={{ display: 'block', width: '100%', marginTop: 8 }}
          onClick={() => void exportPolar()}
          disabled={!polar}
        >
          EXPORT POLAR (.TXT)
        </button>
        <p className="note">
          Reads Expedition <code>.txt</code> polars (TWS in the first column,
          then TWA/BSP pairs) and qtVlm/ORC CSV, and saves in the Expedition
          format. An imported polar is kept on this device until you pick another.
        </p>

        <div className="rows" aria-label="Port tack polar" style={{ marginTop: 8 }}>
          <div className="row">
            <span>Port tack polar</span>
            <span>{polarPort ? polarPort.name : 'the same as starboard'}</span>
          </div>
        </div>
        <div className="actions" style={{ background: 'none', border: 'none', padding: '8px 0 0' }}>
          <label className="btn btn--sm btn--ghost" style={{ cursor: 'pointer' }}>
            IMPORT PORT POLAR
            <input
              type="file"
              accept=".txt,.pol,.csv"
              aria-label="Import a port tack polar"
              style={{ display: 'none' }}
              onChange={async (e) => {
                const f = e.target.files?.[0]
                e.target.value = ''
                if (!f) return
                try {
                  setPolarPort(parsePolar(await f.text(), f.name.replace(/\.[^.]+$/, '')))
                } catch (err) {
                  alert(`Could not read that polar: ${err instanceof Error ? err.message : err}`)
                }
              }}
            />
          </label>
          {polarPort && (
            <button className="btn btn--sm btn--ghost" onClick={() => setPolarPort(null)}>
              SAME BOTH TACKS
            </button>
          )}
        </div>
        <p className="note">
          For a boat whose tacks differ (a canting keel, a foil on one side): the router sails port tack on this
          polar, and a zigzag mixes the two.
        </p>

        <InstrumentsSection />
        <CalibrationSection />
        <GpsSection />
        <LogsSection />
        <AlarmsSection />

        <h2>Wind</h2>
        <div className="seg" style={{ marginBottom: 10 }}>
          {(['manual', 'forecast', 'instrument'] as const).map((m) => (
            <button
              key={m}
              aria-pressed={windMode === m}
              onClick={() => setWindMode(m)}
            >
              {m === 'manual' ? 'Manual' : m === 'forecast' ? 'Forecast' : 'Instruments'}
            </button>
          ))}
        </div>
        <div className="seg" style={{ marginBottom: 6 }} role="group" aria-label="North reference">
          {(['true', 'magnetic'] as const).map((n) => (
            <button
              key={n}
              aria-pressed={settings.northRef === n}
              onClick={() => updateSettings({ northRef: n })}
            >
              {n === 'true' ? 'True north' : 'Magnetic north'}
            </button>
          ))}
        </div>
        <p className="note">
          Magnetic is what a compass reads. With it on, the wind sheet takes a compass bearing
          and the wind chip shows one, marked M. Variation where the boat is, from NOAA's World
          Magnetic Model (WMM-2025), is {Math.abs(variation).toFixed(1)}° {variation < 0 ? 'W' : 'E'}.
          Every other bearing in the app stays true.
        </p>
        <div className="field">
          <label>TWD</label>
          <input
            type="number"
            step="1"
            value={manualWindSetAt == null ? '' : manualWind.twd}
            placeholder="not set"
            onChange={(e) => setManualWind(Number(e.target.value), manualWind.tws)}
            inputMode="numeric"
          />
        </div>
        <div className="field">
          <label>TWS</label>
          <input
            type="number"
            step="0.5"
            value={manualWindSetAt == null ? '' : manualWind.tws}
            placeholder="not set"
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
        <p className="note">
          Kept across a reload, up to {MAX_TRACK_POINTS.toLocaleString()} points (about five and
          a half hours at one fix a second), oldest dropped first. Export it as GPX to keep it or
          send it on.
        </p>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn--sm" onClick={exportTrack} disabled={track.length === 0}>
            EXPORT TRACK (GPX)
          </button>
          <button className="btn btn--sm btn--ghost" onClick={clearTrack}>
            CLEAR TRACK
          </button>
        </div>

        <DisplaySection />

        <ChannelsOutSection />

        <ErrorLogSection />

        <h2>Keyboard</h2>
        <div className="rows" aria-label="Keyboard shortcuts">
          {SHORTCUT_HELP.map(([keys, does]) => (
            <div className="row" key={keys}>
              <span>{does}</span>
              <span>
                <kbd>{keys}</kbd>
              </span>
            </div>
          ))}
        </div>
        <p className="note">
          Expedition&apos;s keys where a browser allows them. Ctrl-W closes the tab in
          every browser, so weather is Alt-W.
        </p>

        <h2>Safety</h2>
        <div className="warnbox">
          <b>Not for navigation.</b> <NotForNavigationText />
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

/** Setup → Channels out: the live channels over a WebSocket, to a server named here. */
function ChannelsOutSection() {
  const out = useStore((s) => s.settings.channelsOut)
  const updateSettings = useStore((s) => s.updateSettings)
  const { status, sent } = useChannelsOutStatus()
  const set = (p: Partial<typeof out>) => updateSettings({ channelsOut: { ...out, ...p } })
  const insecure = typeof location !== 'undefined' && location.protocol === 'https:' && /^ws:\/\/(?!localhost|127\.0\.0\.1)/.test(out.url)
  return (
    <section aria-label="Channels out">
      <h2>Channels out</h2>
      <div className="field">
        <label htmlFor="co-on">Send channels</label>
        <input id="co-on" type="checkbox" checked={out.enabled} onChange={(e) => set({ enabled: e.target.checked })} style={{ width: 26, height: 26 }} />
      </div>
      <div className="field">
        <label htmlFor="co-url">WebSocket</label>
        <input id="co-url" type="text" value={out.url} spellCheck={false} onChange={(e) => set({ url: e.target.value.trim() })} placeholder="ws://192.168.1.10:8765" />
      </div>
      <div className="field">
        <label htmlFor="co-format">Form</label>
        <select id="co-format" value={out.format} onChange={(e) => set({ format: e.target.value as typeof out.format })}>
          <option value="json">newjourney JSON (every channel)</option>
          <option value="signalk">Signal K delta</option>
        </select>
      </div>
      <div className="field">
        <label htmlFor="co-rate">Rate</label>
        <select id="co-rate" value={out.rateHz} onChange={(e) => set({ rateHz: Number(e.target.value) })}>
          <option value={0.2}>every 5 s</option>
          <option value={1}>1 a second</option>
        </select>
      </div>
      {out.enabled && (
        <p className="note" aria-label="Channels out status">
          {status === 'open' ? `Connected · ${sent.toLocaleString()} sent` : status === 'connecting' ? 'Connecting…' : status === 'closed' ? 'Not connected: trying again' : 'Off'}
        </p>
      )}
      {insecure && <p className="warnbox">This page is served over https, so the browser will only connect to wss:// (or ws://localhost).</p>}
      <p className="note">
        A web app cannot take connections, so it makes one: to a logger, a display, a script or a Signal K server on the boat&apos;s
        network. The JSON form sends a hello with the channel list, then the channels at the rate set; the far end may subscribe to
        some of them. The schema is in docs/09-api/channels-out.md.
      </p>
    </section>
  )
}

/** Setup → Display: chart label size, the layout lock, and named layouts. */
function DisplaySection() {
  const settings = useStore((s) => s.settings)
  const updateSettings = useStore((s) => s.updateSettings)
  const [name, setName] = useState('')
  const layouts = settings.layouts ?? []
  const save = () => {
    const s = useStore.getState()
    const n = name.trim() || `Layout ${layouts.length + 1}`
    const entry = { name: n, numberBoxes: s.numberBoxes.map((b) => ({ ...b, channels: [...b.channels] })), navPanel: s.navPanel, navChart: s.navChart }
    updateSettings({ layouts: [...layouts.filter((l) => l.name !== n), entry] })
    setName('')
  }
  const load = (i: number) => {
    const l = layouts[i]
    if (!l) return
    useStore.setState({ numberBoxes: l.numberBoxes.map((b) => ({ ...b, channels: [...b.channels] })) })
    useStore.getState().setNav({ navPanel: l.navPanel, navChart: l.navChart })
  }
  return (
    <section aria-label="Display">
      <h2>Display</h2>
      <div className="field">
        <label>Palette</label>
        <div className="seg" role="group" aria-label="Palette">
          {(['day', 'dusk', 'night'] as const).map((p) => (
            <button key={p} aria-pressed={!settings.paletteBySun && settings.palette === p} onClick={() => updateSettings({ palette: p, paletteBySun: false })}>
              {p === 'day' ? 'Day' : p === 'dusk' ? 'Dusk' : 'Night'}
            </button>
          ))}
          <button aria-pressed={!!settings.paletteBySun} onClick={() => updateSettings({ paletteBySun: true })}>
            By the sun
          </button>
        </div>
      </div>
      <p className="note">
        Day is black on white, the plain chart. Dusk is the dark chart. Night is red on black, to keep night vision.
        By the sun, it follows the sun where the boat is: day while it is up, dusk to 6° below the horizon, then night.
      </p>
      <div className="field">
        <label htmlFor="disp-text">Chart text</label>
        <select id="disp-text" value={settings.chartTextScale ?? 1} onChange={(e) => updateSettings({ chartTextScale: Number(e.target.value) })}>
          <option value={0.8}>small</option>
          <option value={1}>normal</option>
          <option value={1.25}>large</option>
          <option value={1.5}>larger</option>
        </select>
      </div>
      <div className="field">
        <label htmlFor="disp-lock">Lock the layout</label>
        <input id="disp-lock" type="checkbox" checked={!!settings.layoutLocked} onChange={(e) => updateSettings({ layoutLocked: e.target.checked })} style={{ width: 26, height: 26 }} />
      </div>
      <p className="note">Locked, the number boxes cannot be edited, added or removed by a stray tap in a seaway.</p>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <input aria-label="Layout name" placeholder="e.g. Pre-start" value={name} onChange={(e) => setName(e.target.value)} style={{ flex: 1, minWidth: 120 }} />
        <button className="btn btn--sm btn--ghost" onClick={save}>
          SAVE LAYOUT
        </button>
      </div>
      {layouts.length > 0 && (
        <table className="targets" aria-label="Layouts" style={{ width: '100%' }}>
          <tbody>
            {layouts.map((l, i) => (
              <tr key={l.name}>
                <td>{l.name}</td>
                <td className="note">{l.numberBoxes.length} boxes</td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  <button className="btn btn--sm btn--ghost" aria-label={`Load layout ${l.name}`} onClick={() => load(i)}>
                    LOAD
                  </button>
                  <button className="btn btn--sm btn--ghost" aria-label={`Delete layout ${l.name}`} onClick={() => updateSettings({ layouts: layouts.filter((_, j) => j !== i) })}>
                    ✕
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}

/** Setup → Error log: what went wrong on this device, the last 60 days, to read or send on. */
function ErrorLogSection() {
  const [entries, setEntries] = useState(() => readErrors())
  return (
    <section aria-label="Error log">
      <h2>Error log</h2>
      {entries.length === 0 ? (
        <p className="note">Nothing has gone wrong that the app caught.</p>
      ) : (
        <ul aria-label="Errors" style={{ fontSize: 12, maxHeight: 160, overflow: 'auto' }}>
          {entries
            .slice(-20)
            .reverse()
            .map((e, i) => (
              <li key={i}>
                {new Date(e.t).toLocaleString()} [{e.where}] {e.message}
              </li>
            ))}
        </ul>
      )}
      <div className="actions" style={{ background: 'none', border: 'none', padding: 0 }}>
        <button className="btn btn--sm btn--ghost" onClick={() => setEntries(readErrors())}>
          REFRESH
        </button>
        <button
          className="btn btn--sm btn--ghost"
          disabled={!entries.length}
          onClick={async () => {
            const { downloadText } = await import('@/lib/gpx')
            downloadText('newjourney-errors.txt', errorsText(entries), 'text/plain')
          }}
        >
          EXPORT
        </button>
        <button
          className="btn btn--sm btn--ghost"
          disabled={!entries.length}
          onClick={() => {
            clearErrors()
            setEntries([])
          }}
        >
          CLEAR
        </button>
      </div>
      <p className="note">Kept on this device only, for 60 days. Nothing is sent anywhere unless you export it.</p>
    </section>
  )
}
