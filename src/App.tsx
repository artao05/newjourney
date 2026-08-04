/**
 * App shell: sensor wiring, wind resolution, track recording, and four tabs.
 *
 * The wind-resolution precedence here is the one specified in
 * docs/05-spec/technical-spec.md §6 — instrument, then held/manual, then
 * forecast, then estimated. Whichever is in use is displayed at all times,
 * because every downstream number inherits its uncertainty.
 */

import { Suspense, lazy, useEffect, useMemo, type ReactElement } from 'react'
import { useStore, type Tab } from '@/state/store'
import { useGeolocation, useSimulation, useWakeLock, useTick } from '@/hooks/useSensors'
import { StartScreen } from '@/screens/StartScreen'
import { RaceScreen } from '@/screens/RaceScreen'
import { SetupScreen } from '@/screens/SetupScreen'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { findPolar } from '@/data/polars'
import { estimateCurrent } from '@/lib/wind'
import type { WindEstimate } from '@/lib/types'
import { fetchPointForecast } from '@/lib/weather/openmeteo'
import { PILOT_VENUE } from '@/data/venues'

const FORECAST_REFRESH_MS = 15 * 60_000

/**
 * The map is by far the heaviest thing we ship (MapLibre is ~800 kB), and the
 * start-line user never opens it. Code-splitting it keeps first load small on
 * the dockside 3G connection this app is actually used on.
 */
const RouteScreen = lazy(() =>
  import('@/screens/RouteScreen').then((m) => ({ default: m.RouteScreen })),
)

/** Shares the MapLibre chunk with RouteScreen, so it is lazy for the same reason. */
const WeatherScreen = lazy(() =>
  import('@/screens/WeatherScreen').then((m) => ({ default: m.WeatherScreen })),
)

export function App() {
  const tab = useStore((s) => s.tab)
  const setTab = useStore((s) => s.setTab)
  const settings = useStore((s) => s.settings)
  const state = useStore((s) => s.state)
  const gpsError = useStore((s) => s.gpsError)
  const polar = useStore((s) => s.polar)
  const polarId = useStore((s) => s.polarId)
  const setPolar = useStore((s) => s.setPolar)
  const manualWind = useStore((s) => s.manualWind)
  const windMode = useStore((s) => s.windMode)
  const wind = useStore((s) => s.wind)
  const windError = useStore((s) => s.windError)
  const setWind = useStore((s) => s.setWind)
  const setWindError = useStore((s) => s.setWindError)
  const pushWind = useStore((s) => s.pushWind)
  const setCurrent = useStore((s) => s.setCurrent)
  const recording = useStore((s) => s.recording)
  const toggleRecording = useStore((s) => s.toggleRecording)
  const pushTrack = useStore((s) => s.pushTrack)
  // Avoid creating a new forecast request for every GPS fix. A 0.01° cell is
  // comfortably finer than the source model yet stable while the boat is moving.
  const forecastLat = Math.round((state?.position.lat ?? PILOT_VENUE.center.lat) * 100) / 100
  const forecastLon = Math.round((state?.position.lon ?? PILOT_VENUE.center.lon) * 100) / 100

  useGeolocation(!settings.simulate)
  // Start the simulated boat afloat, not on the island the map centre sits on.
  useSimulation(settings.simulate, PILOT_VENUE.waterStart)
  useWakeLock(settings.keepAwake)
  const now = useTick(1)

  // Load the class polar on first run / after a rehydrate.
  useEffect(() => {
    if (polar) return
    const entry = findPolar(polarId) ?? findPolar('j70')
    if (entry) setPolar(entry.id, entry.polar)
  }, [polar, polarId, setPolar])

  // Manual is the honest default with no instrument. Do not overwrite a selected
  // forecast every second — that was making the Forecast switch a cosmetic control.
  useEffect(() => {
    if (windMode !== 'manual') return
    const w: WindEstimate = {
      twd: manualWind.twd,
      tws: manualWind.tws,
      source: 'manual',
      uncertaintyDeg: 8,
      t: now,
    }
    setWind(w)
    setWindError(null)
    pushWind({ t: now, twd: w.twd, tws: w.tws })
  }, [manualWind.twd, manualWind.tws, now, windMode, setWind, setWindError, pushWind])

  // A point forecast is useful for tactics but never substitutes for the route's
  // gridded field. Refresh deliberately and retain the previous estimate if the
  // network drops, rather than changing the displayed wind source silently.
  useEffect(() => {
    if (windMode !== 'forecast') return
    const at = { lat: forecastLat, lon: forecastLon }
    const controller = new AbortController()
    let cancelled = false
    const refresh = async () => {
      try {
        const forecast = await fetchPointForecast({ ...at, hours: 6, signal: controller.signal })
        if (cancelled || forecast.t.length === 0) return
        let best = 0
        for (let i = 1; i < forecast.t.length; i++) {
          if (Math.abs(forecast.t[i] - Date.now()) < Math.abs(forecast.t[best] - Date.now())) best = i
        }
        const w: WindEstimate = {
          twd: forecast.twd[best],
          tws: forecast.tws[best],
          source: 'forecast',
          uncertaintyDeg: 18,
          t: Date.now(),
        }
        setWind(w)
        setWindError(null)
        pushWind({ t: w.t, twd: w.twd, tws: w.tws })
      } catch (e) {
        if (!cancelled && !(e instanceof DOMException && e.name === 'AbortError')) {
          setWindError('Forecast unavailable — showing the last wind estimate.')
        }
      }
    }
    void refresh()
    const timer = window.setInterval(() => void refresh(), FORECAST_REFRESH_MS)
    return () => {
      cancelled = true
      controller.abort()
      window.clearInterval(timer)
    }
  }, [windMode, forecastLat, forecastLon, setWind, setWindError, pushWind])

  // Estimated set & drift, gated on rate of turn — see navigation-math.md §5.
  useEffect(() => {
    if (!state || state.bsp == null || state.heading == null) return
    const c = estimateCurrent({
      cog: state.cog,
      sog: state.sog,
      heading: state.heading,
      bsp: state.bsp,
    })
    setCurrent(c ? { ...c, source: 'measured' } : null)
  }, [state, setCurrent])

  // Track recording.
  useEffect(() => {
    if (!recording || !state) return
    pushTrack({
      t: state.t,
      lat: state.position.lat,
      lon: state.position.lon,
      sog: state.sog,
      cog: state.cog,
    })
  }, [recording, state, pushTrack])

  const fixAge = state ? (now - state.t) / 1000 : null
  const gpsChip = useMemo(() => {
    if (gpsError) return { cls: 'chip--bad', text: 'no fix' }
    if (!state) return { cls: '', text: 'waiting…' }
    if (fixAge != null && fixAge > 8) return { cls: 'chip--warn', text: `stale ${Math.round(fixAge)}s` }
    const acc = state.accuracyM
    if (acc == null) return { cls: 'chip--good', text: 'fix' }
    return {
      cls: acc <= 6 ? 'chip--good' : acc <= 15 ? 'chip--warn' : 'chip--bad',
      text: `±${acc.toFixed(0)} m`,
    }
  }, [gpsError, state, fixAge])

  return (
    <div className="app">
      <div className="topbar">
        <span className={`chip ${gpsChip.cls}`}>
          <span className="dot dot--pulse" />
          {settings.simulate ? 'SIM' : 'GPS'} {gpsChip.text}
        </span>
        <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <span className="chip">
            {wind ? `${wind.twd.toFixed(0)}° · ${wind.tws.toFixed(0)} kn` : 'wind unavailable'}
          </span>
          <button
            className={`chip ${recording ? 'chip--bad' : ''}`}
            onClick={toggleRecording}
            title="Record track"
          >
            <span className="dot" />
            {recording ? 'REC' : 'rec'}
          </button>
        </span>
      </div>

      {gpsError && !settings.simulate && (
        <div className="warnbox" style={{ margin: '10px var(--pad) 0' }}>
          {gpsError} — turn on <b>Simulate a boat</b> in Setup to try the app
          without a GPS fix.
        </div>
      )}
      {windError && (
        <div className="warnbox" style={{ margin: '10px var(--pad) 0' }}>
          {windError}
        </div>
      )}

      {tab === 'start' && (
        <ErrorBoundary name="Start" key="start">
          <StartScreen />
        </ErrorBoundary>
      )}
      {tab === 'race' && (
        <ErrorBoundary name="Race" key="race">
          <RaceScreen />
        </ErrorBoundary>
      )}
      {tab === 'weather' && (
        <ErrorBoundary name="Weather" key="weather">
          <Suspense
            fallback={
              <div className="screen panel" style={{ display: 'grid', placeItems: 'center' }}>
                <span className="chip">
                  <span className="spinner" /> loading map…
                </span>
              </div>
            }
          >
            <WeatherScreen />
          </Suspense>
        </ErrorBoundary>
      )}
      {tab === 'route' && (
        <ErrorBoundary name="Route" key="route">
          <Suspense
            fallback={
              <div className="screen panel" style={{ display: 'grid', placeItems: 'center' }}>
                <span className="chip">
                  <span className="spinner" /> loading chart…
                </span>
              </div>
            }
          >
            <RouteScreen />
          </Suspense>
        </ErrorBoundary>
      )}
      {tab === 'setup' && (
        <ErrorBoundary name="Setup" key="setup">
          <SetupScreen />
        </ErrorBoundary>
      )}

      <nav className="tabbar">
        {TABS.map((t) => (
          <button
            key={t.id}
            aria-current={tab === t.id}
            onClick={() => setTab(t.id)}
          >
            {t.icon}
            {t.label}
          </button>
        ))}
      </nav>
    </div>
  )
}

const TABS: Array<{ id: Tab; label: string; icon: ReactElement }> = [
  {
    id: 'start',
    label: 'Start',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9">
        <path d="M4 4v16M4 6h15l-3 4 3 4H4" strokeLinejoin="round" />
      </svg>
    ),
  },
  {
    id: 'race',
    label: 'Race',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9">
        <path d="M12 3v18M12 6l8 5-8 5" strokeLinejoin="round" />
        <path d="M6 21h12" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    id: 'weather',
    label: 'Weather',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9">
        <path d="M3 9c4-3 7 2 11-1s5 1 7 1" strokeLinecap="round" />
        <path d="M3 14c4-3 7 2 11-1s5 1 7 1" strokeLinecap="round" opacity="0.65" />
        <path d="M3 19c4-3 7 2 11-1s5 1 7 1" strokeLinecap="round" opacity="0.35" />
      </svg>
    ),
  },
  {
    id: 'route',
    label: 'Route',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9">
        <path d="M3 18c6 0 4-12 10-12s5 6 8 6" strokeLinecap="round" />
        <circle cx="4" cy="18" r="2" />
        <circle cx="20" cy="12" r="2" />
      </svg>
    ),
  },
  {
    id: 'setup',
    label: 'Setup',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9">
        <circle cx="12" cy="12" r="3.2" />
        <path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9L17 7M7 17l-2.1 2.1" strokeLinecap="round" />
      </svg>
    ),
  },
]
