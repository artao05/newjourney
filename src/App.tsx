/**
 * App shell: sensor wiring, wind resolution, track recording, and four tabs.
 *
 * The wind-resolution precedence here is the one specified in
 * docs/05-spec/technical-spec.md §6 — instrument, then held/manual, then
 * forecast, then estimated. Whichever is in use is displayed at all times,
 * because every downstream number inherits its uncertainty.
 */

import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { useStore, type ChartTab, type PanelTab, type Tab } from '@/state/store'
import { LayoutContext, useWide } from '@/hooks/useWide'
import { toggleFullscreen, useShortcuts } from '@/hooks/useShortcuts'
import { NumberBoxes } from '@/components/NumberBoxes'
import { useGeolocation, usePhoneOrientation, useSimulation, useWakeLock, useTick } from '@/hooks/useSensors'
import { useInstruments, type InstrumentSource } from '@/hooks/useInstruments'
import { StartScreen } from '@/screens/StartScreen'
import { RaceScreen } from '@/screens/RaceScreen'
import { SetupScreen } from '@/screens/SetupScreen'
import { StripchartScreen } from '@/screens/StripchartScreen'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { NotForNavigationDialog } from '@/components/NotForNavigation'
import { useTrackPersistence } from '@/state/trackPersistence'
import { WindSheet, windChip } from '@/components/WindSheet'
import { ChannelLogRecorder } from '@/components/ChannelLogRecorder'
import { ChannelsOutBridge } from '@/components/ChannelsOutBridge'
import { startMarkHistory } from '@/state/markHistory'
import { useAutoAdvance } from '@/hooks/useAutoAdvance'
import { PlaybackBar } from '@/components/PlaybackBar'
import { AlarmBanner, AlarmWatcher } from '@/components/Alarms'
import { usePlayback } from '@/hooks/usePlayback'
import { findPolar } from '@/data/polars'
import { estimateCurrent } from '@/lib/wind'
import { fixQuality } from '@/lib/startline'
import { declinationAt } from '@/lib/magnetic'
import type { WindEstimate } from '@/lib/types'
import { fetchPointForecast } from '@/lib/weather/openmeteo'
import { PILOT_VENUE } from '@/data/venues'
import { beepsBetween, rollGun } from '@/lib/timer'
import { beep } from '@/lib/beep'

// Undo and redo for the marks record from the first change on.
startMarkHistory()

const FORECAST_REFRESH_MS = 15 * 60_000

/**
 * The map is by far the heaviest thing we ship (MapLibre is ~800 kB), and the
 * start-line user never opens it. Code-splitting it keeps first load small on
 * the dockside 3G connection this app is actually used on.
 *
 * These are created inside the component via useMemo, not at module scope,
 * because React.lazy caches a rejected import forever — if the chunk fails to
 * load on a bad connection, "TRY AGAIN" in the ErrorBoundary would re-throw
 * the cached rejection without ever retrying the import. Recreating the lazy
 * wrapper (by bumping `lazyGen`) gives React a fresh object whose factory
 * will actually call import() again.
 */
const makeRouteScreen = () =>
  lazy(() => import('@/screens/RouteScreen').then((m) => ({ default: m.RouteScreen })))

const makeWeatherScreen = () =>
  lazy(() => import('@/screens/WeatherScreen').then((m) => ({ default: m.WeatherScreen })))

export function App() {
  const tab = useStore((s) => s.tab)
  const setTab = useStore((s) => s.setTab)
  const settings = useStore((s) => s.settings)
  const boat = useStore((s) => s.boat)
  const updateSettings = useStore((s) => s.updateSettings)
  const state = useStore((s) => s.state)
  const gpsError = useStore((s) => s.gpsError)
  const polar = useStore((s) => s.polar)
  const polarId = useStore((s) => s.polarId)
  const setPolar = useStore((s) => s.setPolar)
  const manualWind = useStore((s) => s.manualWind)
  const manualWindSetAt = useStore((s) => s.manualWindSetAt)
  const windSheetOpen = useStore((s) => s.windSheetOpen)
  const setWindSheetOpen = useStore((s) => s.setWindSheetOpen)
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

  const wide = useWide()
  useShortcuts(wide)
  const navPanel = useStore((s) => s.navPanel)
  const navChart = useStore((s) => s.navChart)
  const setNav = useStore((s) => s.setNav)

  const [lazyGen, setLazyGen] = useState(0)
  const retryLazy = useCallback(() => setLazyGen((g) => g + 1), [])
  const RouteScreen = useMemo(makeRouteScreen, [lazyGen])
  const WeatherScreen = useMemo(makeWeatherScreen, [lazyGen])
  // Avoid creating a new forecast request for every GPS fix. A 0.01° cell is
  // comfortably finer than the source model yet stable while the boat is moving.
  const forecastLat = Math.round((state?.position.lat ?? PILOT_VENUE.center.lat) * 100) / 100
  const forecastLon = Math.round((state?.position.lon ?? PILOT_VENUE.center.lon) * 100) / 100

  const instruments = useStore((s) => s.instruments)
  // A replaying log is the boat: every live source stands aside while it plays.
  const replaying = useStore((s) => s.playback != null)
  const hasAlarms = useStore((s) => s.alarms.length > 0)
  const channelsOutOn = useStore((s) => s.settings.channelsOut.enabled)
  useAutoAdvance()
  // The night palette is the whole page's: styles.css reads it from <html>.
  const palette = useStore((s) => s.settings.palette)
  useEffect(() => {
    document.documentElement.dataset.palette = palette
  }, [palette])
  usePlayback()
  const instrumentSource: InstrumentSource = settings.simulate || replaying
    ? null
    : instruments.signalKOn
      ? { kind: 'signalk', url: instruments.signalKUrl }
      : instruments.serialOn
        ? { kind: 'serial', baud: instruments.serialBaud, format: instruments.serialFormat }
        : null
  useGeolocation(!settings.simulate && !instrumentSource && !replaying)
  const phoneSensors = useStore((s) => s.phoneSensors)
  usePhoneOrientation(phoneSensors.on && !settings.simulate && !instrumentSource && !replaying)
  const pipeline = useStore((s) => s.pipeline)
  const calibration = useStore((s) => s.calibration)
  useInstruments(instrumentSource, pipeline, calibration)
  // Start the simulated boat afloat, not on the island the map centre sits on.
  useSimulation(settings.simulate && !replaying, PILOT_VENUE.waterStart)
  useWakeLock(settings.keepAwake)
  useTrackPersistence()
  const now = useTick(1)

  // Hold wind and current release at the gun, when that is what was asked for.
  const hold = useStore((s) => s.hold)
  const gunTime = useStore((s) => s.course.startLine.gunTime)
  const timer = useStore((s) => s.timer)
  // The gun as an event, once per gun, for the log and the stripchart.
  const gunLogged = useRef<number | null>(null)
  useEffect(() => {
    if (gunTime == null || now < gunTime || gunLogged.current === gunTime || now - gunTime > 60_000) return
    gunLogged.current = gunTime
    useStore.getState().addEvent('gun', timer.classesBefore > 0 ? 'Gun (another class)' : 'Gun', gunTime)
  }, [now, gunTime, timer.classesBefore])
  useEffect(() => {
    if (gunTime == null || now < gunTime) return
    // Another class's gun: roll on to the next start, and keep holding.
    if (timer.classesBefore > 0) {
      const st = useStore.getState()
      st.setGunTime(rollGun(gunTime, now, timer.rollMin))
      st.setTimer({ classesBefore: timer.classesBefore - 1 })
      return
    }
    if (!hold.releaseAtGun) return
    if (hold.wind) useStore.getState().holdWind(false)
    if (hold.current) useStore.getState().holdCurrent(false)
  }, [now, gunTime, hold, timer])

  // The countdown's sounds, on the minutes and for the last ten seconds.
  const lastToGun = useRef<number | null>(null)
  useEffect(() => {
    const toGun = gunTime == null ? null : (gunTime - now) / 1000
    const prev = lastToGun.current
    lastToGun.current = toGun
    if (!timer.sound || toGun == null || prev == null) return
    for (const [i, b] of beepsBetween(prev, toGun).entries()) beep(b, i * 0.35)
  }, [now, gunTime, timer.sound])

  // Load the class polar on first run / after a rehydrate.
  useEffect(() => {
    if (polar) return
    const entry = findPolar(polarId) ?? findPolar('j70')
    if (entry) setPolar(entry.id, entry.polar)
  }, [polar, polarId, setPolar])

  // Manual is the honest default with no instrument. Do not overwrite a selected
  // forecast every second — that was making the Forecast switch a cosmetic control.
  useEffect(() => {
    if (windMode !== 'manual' || replaying) return
    // Nobody has set it: then there is no wind, and the Start tab says so, rather
    // than a placeholder quietly deciding which end of the line is favoured.
    if (manualWindSetAt == null) {
      setWind(null)
      return
    }
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
  }, [manualWind.twd, manualWind.tws, manualWindSetAt, now, windMode, setWind, setWindError, pushWind, replaying])

  // Instrument wind comes from useInstruments. With nothing from them for ten
  // seconds there is no wind, said so, rather than one left over from another source.
  useEffect(() => {
    if (windMode !== 'instrument' || replaying) return
    const w = useStore.getState().wind
    if (w && w.source === 'instrument' && now - w.t <= 10_000) return
    setWind(null)
    setWindError('No wind from the instruments. Connect Signal K in Setup.')
  }, [windMode, now, setWind, setWindError, replaying])

  // A point forecast is useful for tactics but never substitutes for the route's
  // gridded field. Refresh deliberately and retain the previous estimate if the
  // network drops, rather than changing the displayed wind source silently.
  useEffect(() => {
    if (windMode !== 'forecast' || replaying) return
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
  }, [windMode, forecastLat, forecastLon, setWind, setWindError, pushWind, replaying])

  // Estimated set & drift, gated on rate of turn — see navigation-math.md §5.
  // With instruments connected, their pipeline does this, with leeway and the gate.
  const instrumentsOwnCurrent = instrumentSource != null || replaying
  useEffect(() => {
    if (instrumentsOwnCurrent) return
    if (!state || state.bsp == null || state.heading == null) {
      /*
       * Clear it. The early return used to just leave the previous value in place,
       * so a set and drift measured while the instruments were reporting stayed on
       * screen indefinitely after they stopped, still labelled "measured".
       *
       * Not cosmetic: `tactics.ts` corrects the laylines with this and
       * `startline.ts` uses it for time-to-line, so a stale estimate quietly bends
       * every tactical number toward a tide that is no longer there. The path is
       * ordinary - run the simulator, which supplies a boat speed, then switch to
       * phone GPS, which does not.
       */
      setCurrent(null)
      return
    }
    const c = estimateCurrent({
      cog: state.cog,
      sog: state.sog,
      heading: state.heading,
      bsp: state.bsp,
    })
    setCurrent(c ? { ...c, source: 'measured' } : null)
  }, [state, setCurrent, instrumentsOwnCurrent])

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
    // Against this boat, not a fixed number of metres: see `fixQuality`.
    const q = fixQuality(acc, boat.loaMetres)
    return {
      cls: q === 'good' ? 'chip--good' : q === 'poor' ? 'chip--warn' : 'chip--bad',
      text: `±${acc.toFixed(0)} m`,
    }
  }, [gpsError, state, fixAge, boat.loaMetres])

  // Until the notice is accepted the app sits behind it, `inert` so no tap or
  // tab-key can reach a number the sailor has not yet been told how far to trust.
  const mustAccept = !settings.acceptedNotForNavigation

  /**
   * One screen, in its error boundary, the charts behind Suspense. Shared by both
   * layouts: the phone shows one at a time, the nav station a panel and a chart.
   */
  const renderScreen = (id: Tab): ReactElement => {
    const loading = (what: string) => (
      <div className="screen panel" style={{ display: 'grid', placeItems: 'center' }}>
        <span className="chip">
          <span className="spinner" /> loading {what}…
        </span>
      </div>
    )
    switch (id) {
      case 'start':
        return (
          <ErrorBoundary name="Start" key="start">
            <StartScreen />
          </ErrorBoundary>
        )
      case 'race':
        return (
          <ErrorBoundary name="Race" key="race">
            <RaceScreen />
          </ErrorBoundary>
        )
      case 'weather':
        return (
          <ErrorBoundary name="Weather" key="weather" onReset={retryLazy}>
            <Suspense fallback={loading('map')}>
              <WeatherScreen />
            </Suspense>
          </ErrorBoundary>
        )
      case 'route':
        return (
          <ErrorBoundary name="Route" key="route" onReset={retryLazy}>
            <Suspense fallback={loading('chart')}>
              <RouteScreen />
            </Suspense>
          </ErrorBoundary>
        )
      case 'strip':
        return (
          <ErrorBoundary name="Stripchart" key="strip">
            <StripchartScreen />
          </ErrorBoundary>
        )
      case 'setup':
        return (
          <ErrorBoundary name="Setup" key="setup">
            <SetupScreen />
          </ErrorBoundary>
        )
    }
  }
  const windChipState = windChip(
    wind,
    manualWindSetAt,
    now,
    settings.northRef === 'magnetic' ? declinationAt(PILOT_VENUE.declination, now) : null,
  )

  return (
    <>
      <div className="app" inert={mustAccept || undefined}>
        <div className="topbar">
          <span className={`chip ${gpsChip.cls}`}>
            <span className="dot dot--pulse" />
            {replaying ? 'LOG' : settings.simulate ? 'SIM' : 'GPS'} {gpsChip.text}
          </span>
          <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button
              className={`chip ${windChipState.warn ? 'chip--warn' : ''}`}
              onClick={() => setWindSheetOpen(true)}
              aria-label={`Wind: ${windChipState.text}. Tap to set.`}
            >
              {windChipState.text}
            </button>
            {typeof document !== 'undefined' && document.fullscreenEnabled && (
              <button
                className="chip"
                onClick={() => toggleFullscreen(wide)}
                title="Full-screen chart (Ctrl-Shift-F)"
                aria-label="Full screen"
              >
                ⛶
              </button>
            )}
            <button
              className={`chip${palette === 'night' ? ' chip--on' : ''}`}
              onClick={() => useStore.getState().updateSettings({ palette: palette === 'night' ? 'normal' : 'night' })}
              title="Night palette: the whole app red on black"
              aria-label="Night palette"
              aria-pressed={palette === 'night'}
            >
              ☾
            </button>
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
        <PlaybackBar />
        <AlarmBanner />

        {gpsError && !settings.simulate && !replaying && (
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

        {wide ? (
          <LayoutContext.Provider value="station">
            <div className="navstation">
              <section className="navstation__panel" aria-label="Panel">
                <nav className="tabbar tabbar--pane">
                  {TABS.filter((t) => PANEL_TABS.includes(t.id as PanelTab)).map((t) => (
                    <button
                      key={t.id}
                      aria-current={navPanel === t.id}
                      onClick={() => setNav({ navPanel: t.id as PanelTab })}
                    >
                      {t.icon}
                      {t.label}
                    </button>
                  ))}
                </nav>
                {renderScreen(navPanel)}
              </section>
              <section className="navstation__chart" aria-label="Chart">
                <nav className="tabbar tabbar--pane">
                  {TABS.filter((t) => CHART_TABS.includes(t.id as ChartTab)).map((t) => (
                    <button
                      key={t.id}
                      aria-current={navChart === t.id}
                      onClick={() => setNav({ navChart: t.id as ChartTab })}
                    >
                      {t.icon}
                      {t.label}
                    </button>
                  ))}
                </nav>
                {renderScreen(navChart)}
              </section>
              <aside className="navstation__boxes" aria-label="Number boxes">
                <NumberBoxes />
              </aside>
            </div>
          </LayoutContext.Provider>
        ) : (
          <>
            {renderScreen(tab)}
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
          </>
        )}

        {windSheetOpen && <WindSheet onClose={() => setWindSheetOpen(false)} />}
        {/* Not while replaying, or the replay would be logged again as today. */}
        {recording && !replaying && <ChannelLogRecorder />}
        {hasAlarms && <AlarmWatcher />}
        {channelsOutOn && <ChannelsOutBridge />}
      </div>
      {mustAccept && (
        <NotForNavigationDialog onAccept={() => updateSettings({ acceptedNotForNavigation: true })} />
      )}
    </>
  )
}

const PANEL_TABS: PanelTab[] = ['start', 'race', 'setup']
const CHART_TABS: ChartTab[] = ['route', 'weather', 'strip']

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
    id: 'strip',
    label: 'Strip',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9">
        <path d="M3 8l4-3 4 4 4-5 6 4" strokeLinejoin="round" strokeLinecap="round" />
        <path d="M3 18l4-2 4 1 4-3 6 2" strokeLinejoin="round" strokeLinecap="round" opacity="0.6" />
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
