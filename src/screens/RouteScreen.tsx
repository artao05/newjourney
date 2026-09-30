/**
 * Route screen — chart, wind, and the isochrone router.
 *
 * The headline is not the magenta line: it is the confidence band around it
 * (docs/03-algorithms/routing-isochrone.md §8). A beginner's failure mode is
 * treating the route as truth, so the sensitivity envelope is shown by default.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { RouteMeteogram } from '@/components/RouteMeteogram'
import { memberRoute, summariseEnsemble, type MemberRoute } from '@/lib/routing/ensemble'
import { fetchEnsembleCubes } from '@/lib/weather/openmeteo'
import { turningPoints, windAlongRouteFC } from '@/lib/routing/results'
import { sailAt } from '@/lib/sailchart'
import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import { NOTE_MIN_POINTS, useStore, type RaceNote } from '@/state/store'
import { cubeNotes, fetchWindCube } from '@/lib/weather/openmeteo'
import { sampleCube } from '@/lib/weather/cube'
import { gribDrop, useWeatherFiles } from '@/state/weatherFiles'
import { useAis } from '@/state/ais'
import { useTracking } from '@/state/tracking'
import { cellKey, installChartFiles, openRasterFile, restoreCharts, uninstallAllCells, uninstallCell, useCharts } from '@/state/charts'
import type { EncBounds } from '@/lib/charts/s57'
import { fleetPositions, fleetRouteJobs, fleetRouteRow, rankFleet, type FleetRouteRow } from '@/lib/routing/fleetRoute'
import { fleetPolar } from '@/lib/fleet'
import { POLAR_LIBRARY } from '@/data/polars'
import { encDrawFeatures, encObjectsAt, scaleAtZoom } from '@/lib/charts/s52'
import { parseSymbolKey, rasterSymbol } from '@/lib/charts/symbols'
import { offsetCorners, offsetFeatures } from '@/lib/charts/georef'
import { checkRoute, withEncHazards } from '@/lib/charts/encRouting'
import { captureMap, chartCaption, chartFileName, downloadCanvas, printCanvas, withCaption } from '@/lib/mapExport'
import { cpaPoints, dangerOf, shownTargets, type Danger } from '@/lib/ais/targets'
import { nearestLegInsert } from '@/lib/courseEdit'
import { legFeatures } from '@/lib/legsOnChart'
import { dnmPct, isochroneNear, isochroneThrough, routeAt, routeSteps } from '@/lib/routing/routeStep'
import type { EncFeature } from '@/lib/charts/s57'
import { AisSheet } from '@/components/AisSheet'
import { currentStations, nearestCurrentStations, stationStreams, type StreamSource } from '@/lib/tides/currents'
import { RoutingClient } from '@/lib/routing/client'
import { departureAdvice, type DepartureSweep } from '@/lib/routing/departure'
import { depthAdvisory, type DepthAdvisory } from '@/lib/routing/depthAdvisory'
import { nonDefaultLabels, requestParts, windHeightFactor, zonesFromNotes } from '@/lib/routing/settings'
import { courseLegs } from '@/lib/legs'
import { laylineLines } from '@/lib/laylineGeo'
import { applyWhatIfWind, describeWhatIf, whatIfActive } from '@/lib/whatif'
import { boundsFrom } from '@/lib/tactics'
import { buildLattice } from '@/lib/polar'
import { fmtPosition } from '@/components/MarkSheet'
import { RaceNoteSheet } from '@/components/RaceNotes'
import { fmtLength } from '@/lib/units'
import { RouteSettingsSheet } from '@/components/RouteSettingsSheet'
import { fetchWaterLevelPrediction, type WaterLevelPrediction } from '@/lib/tides/coops'
import { PORTLAND_DATUM, datumNote } from '@/lib/tides/datum'
import { bboxOf, destination, distance, lonSpan } from '@/lib/geo'
import { angdiff, fmtDeg, wrap180 } from '@/lib/angles'
import { MOTIONS, MOTION_LABEL, ORIENTATIONS, ORIENTATION_LABEL, motionTarget, shouldReframe, steadyBearing, upBearing } from '@/lib/chartView'
import type { Isochrone, LatLon, Millis, RouteRequest, RouteResult, WeatherCube } from '@/lib/types'
import { fmtDuration } from '@/components/Tile'
import { DepartureChart } from '@/components/DepartureChart'
import { PILOT_VENUE } from '@/data/venues'
import { landFractionOf, loadVenueLandMask, type LoadedLandMask } from '@/data/landmask'
import {
  DEPTH_NOT_FOR_NAVIGATION,
  depthAt,
  loadVenueDepthGrid,
  type LoadedDepthGrid,
} from '@/data/bathymetry'

/*
 * The Portland venue land pack now exists — a 111 m OSM-derived raster,
 * validated against known-water station coordinates. See src/data/landmask.ts.
 *
 * This stays a runtime check rather than a constant: land avoidance is only
 * genuinely on once the mask has actually loaded. If the fetch fails we must say
 * so and route without it, not quietly claim a safety feature we do not have.
 */

/**
 * A minimal raster style. OpenSeaMap's seamark layer over an OSM basemap —
 * both free, both attributed. Production would render our own vector tiles from
 * NOAA ENC (see docs/02-data-sources/charts-and-bathymetry.md §1).
 */
const STYLE: maplibregl.StyleSpecification = {
  version: 8,
  // Glyphs for ENC sounding labels, from the same source the other charts use.
  glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
  sources: {
    osm: {
      type: 'raster',
      tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
      tileSize: 256,
      maxzoom: 18,
      attribution: '© OpenStreetMap contributors',
    },
    seamark: {
      type: 'raster',
      tiles: ['https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png'],
      tileSize: 256,
      maxzoom: 18,
      attribution: '© OpenSeaMap (CC-BY-SA)',
    },
  },
  layers: [
    { id: 'bg', type: 'background', paint: { 'background-color': '#0a1a2a' } },
    {
      id: 'osm',
      type: 'raster',
      source: 'osm',
      paint: { 'raster-opacity': 0.55, 'raster-saturation': -0.6, 'raster-brightness-max': 0.75 },
    },
    { id: 'seamark', type: 'raster', source: 'seamark', paint: { 'raster-opacity': 0.95 } },
  ],
}

/**
 * How far ahead the departure sweep looks, hours.
 *
 * Twelve covers a full tidal cycle at Portland (~12 h 25 min between successive
 * high waters) plus the sea-breeze cycle, which are the two things that make one
 * morning departure genuinely better than another inshore. It is also 13 solves,
 * which is the most that finishes in a tolerable wait.
 */
const SWEEP_HOURS = 12

export function RouteScreen() {
  const mapRef = useRef<maplibregl.Map | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const clientRef = useRef<RoutingClient | null>(null)
  const runIdRef = useRef(0)
  const [ready, setReady] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [progress, setProgress] = useState(0)
  const [cube, setCube] = useState<WeatherCube | null>(null)
  // Ticked GRIB files are merged with the download, the finest grid answering first.
  const weatherFiles = useWeatherFiles((s) => s.files)
  const fileCubes = useMemo(() => weatherFiles.filter((f) => f.enabled && f.cube).map((f) => f.cube as WeatherCube), [weatherFiles])
  const routeModel = useStore((s) => s.routeSettings.model)
  const routeSource = useStore((s) => s.routeSettings.source)
  // A forecast downloaded for another model is not the one asked for.
  useEffect(() => setCube(null), [routeModel])
  /** The forecasts a route is sailed on, by the source chosen in the settings. */
  const pickSources = useCallback(
    (download: WeatherCube | null): { cube: WeatherCube; extraCubes: WeatherCube[] } | null => {
      const all = routeSource === 'download' ? [download] : routeSource === 'files' ? fileCubes : [download, ...fileCubes]
      const got = all.filter((c): c is WeatherCube => c != null)
      return got.length ? { cube: got[0], extraCubes: got.slice(1) } : null
    },
    [routeSource, fileCubes],
  )
  /** Download first only when the source needs it and nothing else will do. */
  const needsDownload = routeSource === 'download' || (routeSource === 'merged' && fileCubes.length === 0)
  const noWeather =
    routeSource === 'files'
      ? 'No GRIB file ticked: open one under Weather → GRIB files, or route on the download in SETTINGS.'
      : 'No forecast loaded — tap Forecast first, or open a GRIB file.'
  const [showResults, setShowResults] = useState(false)
  const [landPack, setLandPack] = useState<LoadedLandMask | null>(null)
  const [landError, setLandError] = useState<string | null>(null)
  const [sweep, setSweep] = useState<DepartureSweep | null>(null)
  const [showDepart, setShowDepart] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  /**
   * Reverse isochrones: lines of equal time *to the finish*, from the backward
   * pass. Off by default, because two sets of curves on a phone screen are one too
   * many until someone asks.
   */
  const [showReverse, setShowReverse] = useState(false)
  /** Departure the drawn route was solved for. Null means "now". */
  const [departAt, setDepartAt] = useState<Millis | null>(null)
  const [depthGrid, setDepthGrid] = useState<LoadedDepthGrid | null>(null)
  const [levels, setLevels] = useState<WaterLevelPrediction | null>(null)

  const state = useStore((s) => s.state)
  const boat = useStore((s) => s.boat)
  const course = useStore((s) => s.course)
  const polar = useStore((s) => s.polar)
  const route = useStore((s) => s.route)
  const keptRoutes = useStore((s) => s.keptRoutes)
  const setRoute = useStore((s) => s.setRoute)
  const routeError = useStore((s) => s.routeError)
  const setRouteError = useStore((s) => s.setRouteError)
  const routeSettings = useStore((s) => s.routeSettings)
  const whatIf = useStore((s) => s.whatIf)
  // Laylines and the pointer readout follow What-if; the router follows the forecast.
  const wind = applyWhatIfWind(useStore((s) => s.wind), whatIf)
  const units = useStore((s) => s.settings.units)
  const routeStart = useStore((s) => s.routeStart)
  const setRouteStart = useStore((s) => s.setRouteStart)
  /**
   * Where routes start: a point picked on the chart for planning, or the live fix.
   * Expedition plans from anywhere. Requiring a GPS fix meant a navigator could not
   * route tomorrow's race from the dock, or at all with location turned off.
   */
  const origin = routeStart ?? state?.position ?? null
  /**
   * Waiting for a tap on the chart: to become the planned start, or a new mark at
   * the end of the course.
   */
  const [picking, setPicking] = useState<'start' | 'mark' | 'measure' | 'note' | null>(null)
  const pickingRef = useRef<'start' | 'mark' | 'measure' | 'note' | null>(null)
  pickingRef.current = picking
  /** A race note being drawn: its kind, and the points tapped so far. */
  const [draft, setDraft] = useState<{ kind: RaceNote['kind']; points: LatLon[] }>({ kind: 'area', points: [] })
  const [editingNote, setEditingNote] = useState<string | null>(null)
  const raceNotes = useStore((s) => s.raceNotes)
  /** Dividers: two tapped points, and the range and bearing between them. */
  const [measure, setMeasure] = useState<{ a: LatLon; b: LatLon | null } | null>(null)
  const measureRef = useRef(measure)
  measureRef.current = measure
  /** Where the pointer is over the chart (desktop), or the last tapped point (touch). */
  const [pointer, setPointer] = useState<LatLon | null>(null)
  const lattice = useMemo(() => {
    if (!polar) return null
    try {
      return buildLattice(polar)
    } catch {
      return null
    }
  }, [polar])

  // ---------------------------------------------------------------- map init
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: STYLE,
      center: [PILOT_VENUE.center.lon, PILOT_VENUE.center.lat],
      zoom: PILOT_VENUE.defaultZoom,
      attributionControl: { compact: true },
    })
    map.on('load', () => {
      addEmptyLayers(map)
      setReady(true)
    })
    // Dragging the chart by hand sets it free of the boat.
    map.on('dragstart', (e: { originalEvent?: unknown }) => {
      if (e.originalEvent && useStore.getState().settings.chartMotion !== 'free') useStore.getState().updateSettings({ chartMotion: 'free' })
    })
    // Chart symbols are drawn when the map first asks for one: the key says what to draw.
    map.on('styleimagemissing', (e: { id: string }) => {
      const spec = parseSymbolKey(e.id)
      if (spec && !map.hasImage(e.id)) map.addImage(e.id, rasterSymbol(spec, 2), { pixelRatio: 2 })
    })

    /*
     * Drag a mark: press its symbol, move, let go. The map stops panning while a
     * mark is held, only the drawing follows the pointer, and the store changes
     * once, on release. A press that never moves is a tap, and moves nothing, so
     * tapping a mark does not throw away the route.
     */
    let held: string | null = null
    let moved = false
    const at = (e: { lngLat: maplibregl.LngLat }) => ({ lat: e.lngLat.lat, lon: e.lngLat.lng })
    const onDown = (e: maplibregl.MapLayerMouseEvent | maplibregl.MapLayerTouchEvent) => {
      const id = e.features?.[0]?.properties?.id
      if (typeof id !== 'string' || pickingRef.current) return
      if ('points' in e && e.points.length !== 1) return
      e.preventDefault()
      held = id
      moved = false
      map.dragPan.disable()
      map.getCanvas().style.cursor = 'grabbing'
    }
    const onMove = (e: maplibregl.MapMouseEvent | maplibregl.MapTouchEvent) => {
      if (!held) return
      moved = true
      const marks = useStore
        .getState()
        .course.marks.map((m) => (m.id === held ? { ...m, position: at(e) } : m))
      setSource(map, 'marks', marksFC(marks))
    }
    const onUp = (e: maplibregl.MapMouseEvent | maplibregl.MapTouchEvent) => {
      if (!held) return
      if (moved) useStore.getState().updateMark(held, { position: at(e) })
      held = null
      map.dragPan.enable()
      map.getCanvas().style.cursor = ''
    }
    map.on('mousedown', 'marks-pt', onDown)
    map.on('touchstart', 'marks-pt', onDown)
    map.on('mousemove', onMove)
    map.on('touchmove', onMove)
    map.on('mouseup', onUp)
    map.on('touchend', onUp)
    // One tap after "pick start" or "+ mark" places it. Read through refs and
    // getState, because this handler outlives every render.
    map.on('click', (e: maplibregl.MapMouseEvent) => {
      const mode = pickingRef.current
      const at = { lat: e.lngLat.lat, lon: e.lngLat.lng }
      // A plain tap reads out that point: the only pointer a phone has. With
      // charts open, it also says what the chart has there.
      if (!mode) {
        setPointer(at)
        const cells = useCharts.getState().cells
        if (cells.length) {
          const found = encObjectsAt(cells, at)
          setEncQuery(found.length ? { at, objects: found } : null)
        }
        return
      }
      if (mode === 'measure') {
        const m = measureRef.current
        setMeasure(!m || m.b ? { a: at, b: null } : { a: m.a, b: at })
        return
      }
      if (mode === 'note') {
        setDraft((d) => ({ ...d, points: d.kind === 'point' ? [at] : [...d.points, at] }))
        return
      }
      const s = useStore.getState()
      if (mode === 'start') s.setRouteStart(at)
      else s.addMark(`Mark ${s.course.marks.length + 1}`, at)
      setPicking(null)
    })
    // The pointer readout follows the mouse, at most once a frame.
    let frame = 0
    map.on('mousemove', (e: maplibregl.MapMouseEvent) => {
      const at = { lat: e.lngLat.lat, lon: e.lngLat.lng }
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        setPointer(at)
      })
    })
    mapRef.current = map
    return () => {
      map.remove()
      mapRef.current = null
      setReady(false)
    }
  }, [])

  // Load the venue land pack once. Small (4.8 kB gzipped) and cached for the session.
  useEffect(() => {
    let cancelled = false
    loadVenueLandMask()
      .then((p) => {
        if (cancelled) return
        // Cross-check the payload against its own metadata before trusting it.
        const frac = landFractionOf(p.bits, p.meta.nx, p.meta.ny)
        if (Math.abs(frac - p.meta.landFraction) > 0.01) {
          throw new Error(
            `land mask is ${(frac * 100).toFixed(1)}% land, expected ${(
              p.meta.landFraction * 100
            ).toFixed(1)}%`,
          )
        }
        setLandPack(p)
        setLandError(null)
      })
      .catch((e) => {
        if (!cancelled) setLandError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      cancelled = true
    }
  }, [])

  /*
   * Depth grid and tide curve for the grounding advisory.
   *
   * Both are best-effort and neither blocks routing: a failure here costs the
   * advisory, not the route. Silently, too — the advisory itself reports what it
   * could not check, which is the honest place for it. Announcing "tide fetch
   * failed" over the chart before anyone has asked for a route is noise.
   */
  useEffect(() => {
    let cancelled = false
    loadVenueDepthGrid()
      .then((g) => !cancelled && setDepthGrid(g))
      .catch(() => undefined)
    fetchWaterLevelPrediction({ stationId: PORTLAND_DATUM.stationId, rangeHours: 48 })
      .then((p) => !cancelled && setLevels(p))
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [])

  /*
   * A departure sweep belongs to a course too.
   *
   * The store drops the route when the marks change, because a route computed for
   * marks that no longer exist is describing someone else's race. The sweep is the
   * same claim on a different axis - "leave at 14:20 and you save eleven minutes" -
   * and it lives in local state here, so it needs clearing alongside or the panel
   * keeps recommending a departure for a course that is gone.
   */
  useEffect(() => {
    setSweep(null)
    setDepartAt(null)
  }, [course.marks, routeStart])

  // Follow the boat once, on first fix.
  const centred = useRef(false)
  useEffect(() => {
    if (!ready || !state || centred.current) return
    mapRef.current?.jumpTo({ center: [state.position.lon, state.position.lat], zoom: 12 })
    centred.current = true
  }, [ready, state])

  // ------------------------------------------------------------ draw updates
  const legActive = useStore((s) => s.activeMarkIndex)
  /*
   * Stepping through the route: the time shown, from the start to each routing step. The
   * boat's place on the route then, and the isochrone of that step, are drawn over it.
   */
  const [stepT, setStepT] = useState<number | null>(null)
  useEffect(() => setStepT(null), [route])
  const steps = useMemo(() => (route?.ok ? routeSteps(route) : []), [route])
  const step = useCallback(
    (by: -1 | 0 | 1) => {
      if (!steps.length) return
      if (by === 0) return setStepT(steps[0])
      const i = stepT == null ? -1 : steps.findIndex((t) => t >= stepT)
      const next = by > 0 ? steps[Math.min(steps.length - 1, i + 1)] : steps[Math.max(0, (i < 0 ? steps.length : i) - 1)]
      setStepT(next)
    },
    [steps, stepT],
  )
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.shiftKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return
      const tag = (e.target as HTMLElement | null)?.tagName
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return
      e.preventDefault()
      step(e.key === 'ArrowUp' ? 1 : -1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [step])
  const stepAt = route?.ok && stepT != null ? routeAt(route.legs, stepT) : null
  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return
    const features: GeoJSON.Feature[] = []
    if (route?.ok && stepT != null && stepAt) {
      features.push({ type: 'Feature', properties: { kind: 'boat' }, geometry: { type: 'Point', coordinates: [stepAt.position.lon, stepAt.position.lat] } })
      const iso = isochroneNear(route.isochrones, stepT)
      if (iso && iso.points.length > 1) features.push({ type: 'Feature', properties: { kind: 'iso' }, geometry: { type: 'LineString', coordinates: iso.points.map((p) => [p.lon, p.lat]) } })
    }
    setSource(map, 'route-step', { type: 'FeatureCollection', features } as FC)
  }, [ready, route, stepT, stepAt])

  // Chart labels at the size set in Setup.
  const textScale = useStore((s) => s.settings.chartTextScale ?? 1)
  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return
    for (const [id, size] of [['marks-label', 11], ['legs-label', 10], ['ais-label', 10], ['route-wind-label', 10]] as const) if (map.getLayer(id)) map.setLayoutProperty(id, 'text-size', size * textScale)
  }, [ready, textScale])

  // The route's and the marks' colours, as set in the route settings.
  const routeColour = useStore((s) => s.settings.routeColour)
  const markColour = useStore((s) => s.settings.markColour)
  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return
    map.setPaintProperty('route-line', 'line-color', routeColour)
    map.setPaintProperty('marks-pt', 'circle-color', markColour)
  }, [ready, routeColour, markColour])
  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return
    setSource(map, 'boat', state ? pointFC(state.position.lon, state.position.lat) : emptyFC())
    setSource(map, 'marks', marksFC(course.marks))
    // The legs with range and bearing, the boat's line to the active mark, and range circles.
    setSource(map, 'legs', { type: 'FeatureCollection', features: legFeatures(course.marks, state?.position ?? null, legActive) } as FC)
  }, [ready, state, course.marks, legActive])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return
    setSource(map, 'start', routeStart ? pointFC(routeStart.lon, routeStart.lat) : emptyFC())
  }, [ready, routeStart])

  const divider = measure?.b ? courseLegs({
    start: { name: 'A', position: measure.a },
    marks: [{ name: 'B', position: measure.b }],
    wind: null,
    lattice: null,
    boat,
  })[0] : null
  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return
    if (!measure) {
      setSource(map, 'measure', emptyFC())
      return
    }
    const pts = measure.b ? [measure.a, measure.b] : [measure.a]
    setSource(map, 'measure', {
      type: 'FeatureCollection',
      features: [
        ...pts.map((p) => ({
          type: 'Feature' as const,
          properties: {},
          geometry: { type: 'Point' as const, coordinates: [p.lon, p.lat] },
        })),
        ...(measure.b
          ? [{
              type: 'Feature' as const,
              properties: {},
              geometry: {
                type: 'LineString' as const,
                coordinates: [[measure.a.lon, measure.a.lat], [measure.b.lon, measure.b.lat]],
              },
            }]
          : []),
      ],
    })
  }, [ready, measure])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return
    setSource(map, 'notes', notesFC(raceNotes))
  }, [ready, raceNotes])

  // Laylines to the active mark, with the wind's oscillation either side, as
  // Expedition draws them on its chart. Only with a wind and a polar to set them.
  const activeMarkIndex = useStore((s) => s.activeMarkIndex)
  const windHistory = useStore((s) => s.windHistory)
  const activeMark = course.marks[activeMarkIndex]

  /*
   * Orientation and motion. North up turns the chart back to north when chosen
   * and then leaves it (a gesture may still turn it); course up and head up
   * turn it on every fix. Follow, look ahead and boat + mark move it on every
   * fix, the framing modes only when what they frame has left the view.
   */
  const orientation = useStore((s) => s.settings.chartOrientation)
  // The chart as a picture, captioned: saved as a PNG or printed.
  const exportChart = async (how: 'save' | 'print') => {
    const map = mapRef.current
    if (!map) return
    try {
      const at = new Date()
      const caption = chartCaption(at, course.name || 'Route chart')
      const pic = withCaption(await captureMap(map), caption)
      if (how === 'save') await downloadCanvas(pic, chartFileName(at))
      else printCanvas(pic, caption)
    } catch (e) {
      setRouteError(e instanceof Error ? e.message : String(e))
    }
  }
  const motion = useStore((s) => s.settings.chartMotion)
  const updateSettings = useStore((s) => s.updateSettings)
  const legFrom = course.marks[activeMarkIndex - 1]?.position ?? null
  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready || orientation !== 'north') return
    if (Math.abs(map.getBearing()) > 0.1) map.easeTo({ bearing: 0, duration: 300 })
  }, [ready, orientation])
  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return
    const now = map.getBearing()
    let brg = now
    if (orientation !== 'north') {
      const up = upBearing(orientation, state, activeMark ? { from: legFrom, to: activeMark.position } : null)
      if (up != null) brg = orientation === 'head' ? steadyBearing(now, up) : up
    }
    const turn = Math.abs(angdiff(brg, now)) > 0.5
    const t = motionTarget(motion, state, activeMark?.position ?? null)
    if (t && 'center' in t) {
      map.easeTo({ center: [t.center.lon, t.center.lat], bearing: brg, duration: 400 })
    } else if (t) {
      const lons = t.frame.map((p) => p.lon)
      const lats = t.frame.map((p) => p.lat)
      const cam = map.cameraForBounds(
        [
          [Math.min(...lons), Math.min(...lats)],
          [Math.max(...lons), Math.max(...lats)],
        ],
        // Close to a mark, not closer than a harbour chart.
        { padding: 60, bearing: brg, maxZoom: 16 },
      )
      if (!cam) return
      const c = map.getCanvas()
      const px = t.frame.map((p) => map.project([p.lon, p.lat]))
      if (turn || shouldReframe(px, c.clientWidth, c.clientHeight, map.getZoom(), cam.zoom ?? map.getZoom())) {
        map.easeTo({ center: cam.center, zoom: cam.zoom, bearing: brg, duration: 400 })
      }
    } else if (turn) {
      map.easeTo({ bearing: brg, duration: 400 })
    }
  }, [ready, state, orientation, motion, activeMark, legFrom])
  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return
    if (!wind || !lattice || !activeMark) {
      setSource(map, 'laylines', emptyFC())
      return
    }
    const l = laylineLines({
      mark: activeMark.position,
      from: origin,
      wind,
      lattice,
      boundsDeg: boundsFrom(wind, windHistory),
    })
    const line = (c: [LatLon, LatLon], side: string, bound: boolean) => ({
      type: 'Feature' as const,
      properties: { side, bound },
      geometry: { type: 'LineString' as const, coordinates: c.map((p) => [p.lon, p.lat]) },
    })
    setSource(map, 'laylines', {
      type: 'FeatureCollection',
      features: [
        line(l.port, 'port', false),
        line(l.starboard, 'starboard', false),
        ...l.bounds.map((b) => line(b.line, b.side, true)),
      ],
    })
    // origin moves every fix; rounded, so the lines do not redraw at 1 Hz for metres.
  }, [ready, wind, lattice, activeMark, windHistory, origin && Math.round(origin.lat * 2e4), origin && Math.round(origin.lon * 2e4)])
  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return
    const n = draft.points.length
    // Drawn as far as it has got: a point, then a line, then an area.
    const kind: RaceNote['kind'] =
      draft.kind === 'area' && n >= 3 ? 'area' : draft.kind !== 'point' && n >= 2 ? 'line' : 'point'
    setSource(
      map,
      'draft',
      picking === 'note' && n > 0
        ? notesFC([{ id: 'draft', kind, points: draft.points, text: '', avoid: false, speedPct: null }])
        : emptyFC(),
    )
  }, [ready, picking, draft])
  const finishNote = () => {
    if (draft.points.length < NOTE_MIN_POINTS[draft.kind]) return
    const id = useStore
      .getState()
      .addRaceNote({ kind: draft.kind, points: draft.points, text: '', avoid: false, speedPct: null })
    setDraft({ kind: draft.kind, points: [] })
    setPicking(null)
    setEditingNote(id)
  }

  // On an isochrone of the route: its time, and how this point stands against its best (DNM %).
  const pointerIso = useMemo(() => {
    if (!pointer || !route?.ok || !route.isochrones.length) return null
    const through = isochroneThrough(route.isochrones, pointer)
    const mark = course.marks[useStore.getState().activeMarkIndex]?.position ?? route.legs.at(-1)?.position
    return through ? { iso: through.iso, dnm: mark ? dnmPct(pointer, through.iso, mark) : null } : null
  }, [pointer, route, course.marks])
  /** From the boat (or planned start) to the pointer: range, bearing, polar time. */
  const toPointer = pointer && origin ? courseLegs({
    start: { name: 'from', position: origin },
    marks: [{ name: 'pointer', position: pointer }],
    wind,
    lattice,
    boat,
  })[0] : null

  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return
    if (!route || !route.ok || route.legs.length === 0) {
      setSource(map, 'route', emptyFC())
      setSource(map, 'route-beat', emptyFC())
      setSource(map, 'route-wind', emptyFC())
      setSource(map, 'iso', emptyFC())
      setSource(map, 'riso', emptyFC())
      setSource(map, 'sens', emptyFC())
      return
    }
    const coords = route.legs.map((l) => [l.position.lon, l.position.lat] as [number, number])
    setSource(map, 'route', {
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: coords } },
      ],
    })
    // Beating segments drawn dashed, exactly as Expedition marks implicit tacking.
    const beatSegs = extractBeatSegments(route.legs)
    setSource(map, 'route-beat', {
      type: 'FeatureCollection',
      features: beatSegs.map((c) => ({
        type: 'Feature' as const,
        properties: {},
        geometry: { type: 'LineString' as const, coordinates: c },
      })),
    })
    setSource(map, 'route-wind', windAlongRouteFC(route.legs))

    if (coords.length > 1) {
      const b = new maplibregl.LngLatBounds(coords[0], coords[0])
      for (const c of coords) b.extend(c)
      map.fitBounds(b, { padding: 56, maxZoom: 12, duration: 600 })
    }
  }, [ready, route])

  // The isochrones and the band, redrawn when their display settings change,
  // without refitting the map as a new route does.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready || !route?.ok) return
    setSource(map, 'iso', isochroneFC(route.isochrones, routeSettings.isoEveryMin))
    setSource(map, 'sens', sensitivityFC(route, routeSettings.bandMin))
    setSource(map, 'explored', routeSettings.showExplored ? exploredFC(route.explored) : emptyFC())
  }, [ready, route, routeSettings.isoEveryMin, routeSettings.bandMin, routeSettings.showExplored])

  // ENC cells the user opened, drawn against the safety depth.
  const encCells = useCharts((s) => s.cells)
  // The zoom to a whole level, so the chart is redrawn for its scale only when that changes.
  const [encZoom, setEncZoom] = useState(12)
  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return
    const on = () => setEncZoom(Math.round(map.getZoom()))
    on()
    map.on('zoomend', on)
    return () => {
      map.off('zoomend', on)
    }
  }, [ready])
  const rasters = useCharts((s) => s.rasters)
  const chartOffset = useStore((s) => s.settings.chartOffset)
  // Raster charts: an image source a tile, under the ENC cells and everything else.
  const shownRasters = useRef(new Map<string, { opacity: number; offset: typeof chartOffset; tiles: number }>())
  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return
    const shown = shownRasters.current
    const tileId = (id: string, k: number) => `${id}:${k}`
    for (const [id, was] of [...shown]) {
      if (rasters.some((r) => r.id === id && r.on)) continue
      for (let k = 0; k < was.tiles; k++) {
        if (map.getLayer(tileId(id, k))) map.removeLayer(tileId(id, k))
        if (map.getSource(tileId(id, k))) map.removeSource(tileId(id, k))
      }
      shown.delete(id)
    }
    for (const r of rasters) {
      if (!r.on) continue
      const was = shown.get(r.id)
      r.tiles.forEach((t, k) => {
        const id = tileId(r.id, k)
        if (!was) {
          map.addSource(id, { type: 'image', url: t.url, coordinates: offsetCorners(t.corners, chartOffset) })
          map.addLayer({ id, type: 'raster', source: id, paint: { 'raster-opacity': r.opacity, 'raster-fade-duration': 0 } }, 'enc-area')
        } else {
          if (was.opacity !== r.opacity) map.setPaintProperty(id, 'raster-opacity', r.opacity)
          if (was.offset !== chartOffset) (map.getSource(id) as maplibregl.ImageSource | undefined)?.setCoordinates(offsetCorners(t.corners, chartOffset))
        }
      })
      shown.set(r.id, { opacity: r.opacity, offset: chartOffset, tiles: r.tiles.length })
    }
  }, [ready, rasters, chartOffset])
  // Installed cells come back once a session.
  useEffect(() => {
    void restoreCharts()
  }, [])
  const safetyDepthM = useCharts((s) => s.safetyDepthM)
  const encDisplay = useCharts((s) => s.display)
  const [showEnc, setShowEnc] = useState(false)
  const fleetCount = useStore((s) => s.fleet.length)
  const [encQuery, setEncQuery] = useState<{ at: LatLon; objects: Array<EncFeature & { cell: string }> } | null>(null)
  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return
    // Each cell's bounds, faint, so its coverage shows when zoomed out.
    const outlines = encCells.flatMap((c) =>
      c.bounds
        ? [{ type: 'Feature', properties: { layer: 'bounds', name: cellKey(c.name) }, geometry: { type: 'LineString', coordinates: [[c.bounds.west, c.bounds.south], [c.bounds.east, c.bounds.south], [c.bounds.east, c.bounds.north], [c.bounds.west, c.bounds.north], [c.bounds.west, c.bounds.south]] } }]
        : [],
    )
    // Moved by the chart offset, at the charts' own latitude.
    const b = encCells.find((c) => c.bounds)?.bounds
    // The scale shown, for anti-clutter and for drawing sector arcs a set size on screen.
    const scale = scaleAtZoom(encZoom, b ? (b.south + b.north) / 2 : 45)
    const features = offsetFeatures([...encDrawFeatures(encCells, { safetyDepthM, ...encDisplay, scale }), ...outlines] as Array<{ geometry: { type: string; coordinates: unknown } | null }>, chartOffset, b ? (b.south + b.north) / 2 : 45)
    setSource(map, 'enc', { type: 'FeatureCollection', features } as unknown as FC)
    const big = (encDisplay.largeText ? 1.4 : 1) * textScale
    map.setLayoutProperty('enc-sounding', 'text-size', 10 * big)
    map.setLayoutProperty('enc-text', 'text-size', 10 * big)
  }, [ready, encCells, safetyDepthM, encDisplay, chartOffset, encZoom, textScale])

  // The fleet's tracks from tracking files, in each boat's colour.
  const fleetTracks = useTracking((s) => s.tracks)
  const fleetBoats = useStore((s) => s.fleet)
  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return
    const features: GeoJSON.Feature[] = []
    for (const tr of fleetTracks) {
      if (!tr.points.length) continue
      const boat = fleetBoats.find((b) => b.id === tr.boatId)
      const props = { key: tr.key, color: boat?.colour ?? '#90a4ae', name: boat?.name ?? tr.key }
      if (tr.points.length > 1) features.push({ type: 'Feature', properties: props, geometry: { type: 'LineString', coordinates: tr.points.map((p) => [p.lon, p.lat]) } })
      const last = tr.points[tr.points.length - 1]
      features.push({ type: 'Feature', properties: props, geometry: { type: 'Point', coordinates: [last.lon, last.lat] } })
    }
    setSource(map, 'fleet', { type: 'FeatureCollection', features } as FC)
  }, [ready, fleetTracks, fleetBoats])

  // AIS targets on the chart as the AIS sheet's filter shows them: a dot, its name, a course
  // vector, its trail, and for a vessel closing on us, where each of us will be at the CPA.
  const aisTargets = useAis((s) => s.targets)
  const aisFilter = useAis((s) => s.filter)
  const [showAis, setShowAis] = useState(false)
  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return
    const own = state && Number.isFinite(state.sog) && Number.isFinite(state.cog) ? { position: state.position, sog: state.sog, cog: state.cog } : null
    const features: GeoJSON.Feature[] = []
    const byClass = (t: { cls: string; alert: unknown }) => (t.alert ? '#ff5252' : t.cls === 'B' ? '#b0bec5' : t.cls === 'AtoN' ? '#ce93d8' : '#ffcc80')
    // By risk and motion: red coming inside the CPA limit, white with no recent fix, green under
    // way (1 kn or more), yellow stopped.
    const byRisk = (t: { positionAt: number | null; sog: number | null }, d: Danger) =>
      d === 'danger' ? '#ff5252' : t.positionAt == null || Date.now() - t.positionAt > 3 * 60_000 ? '#eceff1' : (t.sog ?? 0) >= 1 ? '#66bb6a' : '#fdd835'
    for (const t of shownTargets(aisTargets, own, aisFilter)) {
      if (!t.position) continue
      const danger = dangerOf(t.a)
      const color = t.alert ? '#ff5252' : aisFilter.colourBy === 'danger' && t.cls !== 'AtoN' && t.cls !== 'base' ? byRisk(t, danger) : byClass(t)
      const props = { mmsi: t.mmsi, cls: t.cls, alert: t.alert != null, name: aisFilter.labels ? (t.name ?? String(t.mmsi)) : '', color, kind: 'target' }
      features.push({ type: 'Feature', properties: props, geometry: { type: 'Point', coordinates: [t.position.lon, t.position.lat] } })
      if (t.sog && t.sog > 0.2 && t.cog != null && aisFilter.vectorMin > 0) {
        const ahead = destination(t.position, t.cog, (t.sog * aisFilter.vectorMin) / 60)
        features.push({ type: 'Feature', properties: { ...props, kind: 'vector' }, geometry: { type: 'LineString', coordinates: [[t.position.lon, t.position.lat], [ahead.lon, ahead.lat]] } })
      }
      if (aisFilter.trails && t.trail && t.trail.length > 1) {
        features.push({ type: 'Feature', properties: { ...props, kind: 'trail' }, geometry: { type: 'LineString', coordinates: t.trail.map((p) => [p[2], p[1]]) } })
      }
      // The CPA, for a vessel that will come close: us and them then, and the gap between.
      const cpa = own && t.a && danger !== 'clear' ? cpaPoints(own, t, t.a) : null
      if (cpa) {
        features.push({ type: 'Feature', properties: { ...props, kind: 'cpa', name: `CPA ${t.a!.cpaNm.toFixed(2)} nm in ${Math.round(t.a!.tcpaMin)} min` }, geometry: { type: 'LineString', coordinates: [[cpa.us.lon, cpa.us.lat], [cpa.them.lon, cpa.them.lat]] } })
      }
    }
    setSource(map, 'ais', { type: 'FeatureCollection', features } as FC)
  }, [ready, aisTargets, aisFilter, state])

  // The ensemble members' routes.
  const ensembleRoutes = useStore((s) => s.ensembleRoutes)
  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return
    setSource(map, 'ensemble', keptFC((ensembleRoutes ?? []).filter((m) => m.ok).map((m) => ({ id: m.member, track: m.track }))))
  }, [ready, ensembleRoutes])

  // Earlier routes, for comparison: their own source, so a new route does not refit for them.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return
    setSource(map, 'kept', keptFC(keptRoutes))
  }, [ready, keptRoutes])

  // Its own effect, so the toggle redraws one layer without refitting the map.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return
    setSource(
      map,
      'riso',
      showReverse && route?.ok ? isochroneFC(route.reverseIsochrones) : emptyFC(),
    )
  }, [ready, route, showReverse])

  /*
   * The arrows describe the route that is drawn: the wind it leaves into, or the
   * wind now when there is no route. Not the cube's first hour — that is the hour
   * of the download, and a departure picked from the sweep can be twelve hours
   * after it. An effect rather than a call in `loadWeather`, so a forecast
   * requested before the map finished loading is still drawn once it has.
   */
  const windAt = route?.ok && route.legs.length > 0 ? route.legs[0].t : null
  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return
    setSource(map, 'wind', cube ? windFC(cube, windAt ?? Date.now()) : emptyFC())
  }, [ready, cube, windAt])

  // ------------------------------------------------------------------ actions
  const loadWeather = useCallback(async (): Promise<WeatherCube | null> => {
    if (!origin) return null
    setBusy('Downloading forecast…')
    setRouteError(null)
    try {
      const pts = [origin, ...course.marks.map((m) => m.position)]
      const bbox = pts.length > 1 ? bboxOf(pts, 60) : PILOT_VENUE.bbox
      /*
       * Derive the sample step from the span instead of taking the library
       * default of 0.25°, which is ~27 km — wider than Casco Bay, and it produced
       * a 4x2 grid for the whole venue. A router given a spatially uniform wind
       * field has nothing to optimise: every heading looks equally good, so the
       * "optimal" route is an artefact of the discretisation.
       */
      const span = Math.max(bbox.east - bbox.west, bbox.north - bbox.south)
      const stepDeg = Math.max(0.02, span / 40)
      const c = await fetchWindCube({
        bbox,
        stepDeg,
        hours: 72,
        model: routeModel,
        includeWaves: true,
        includeCurrent: true,
      })
      setCube(c)
      return c
    } catch (e) {
      setRouteError(e instanceof Error ? e.message : 'Forecast download failed')
      return null
    } finally {
      setBusy(null)
    }
  }, [origin, course.marks, setRouteError, routeModel])

  /*
   * Declared before the callbacks that list it as a dependency. A dependency array
   * is evaluated during render, so a `useCallback` above this line referencing
   * `legNm` would read it in its temporal dead zone and throw on first paint.
   */
  const legNm = useMemo(() => {
    if (!origin || course.marks.length === 0) return null
    let total = 0
    let prev = origin
    for (const m of course.marks) {
      total += distance(prev, m.position)
      prev = m.position
    }
    return total
  }, [origin, course.marks])

  /**
   * The request shared by a single route and a departure sweep.
   *
   * Built in one place on purpose: a sweep that ranked departures under different
   * constraints or scalings from the route the user then sails would recommend a
   * time for a boat that is not theirs.
   */
  const liveWind = useStore((s) => s.wind)
  const polarPort = useStore((s) => s.polarPort)
  const buildRequest = useCallback(
    (startTime: Millis, computeSensitivity: boolean, marksOverride?: LatLon[]): RouteRequest | null => {
      // The whole course, or with first leg only, the active mark alone.
      const active = course.marks[useStore.getState().activeMarkIndex]
      const marks = marksOverride ?? (routeSettings.firstLegOnly ? (active ? [active.position] : []) : course.marks.map((m) => m.position))
      if (!origin || marks.length === 0) return null
      const parts = requestParts(
        routeSettings,
        boat,
        landPack != null,
        windHeightFactor(polar?.reference, boat.mastHeightMetres),
      )
      return {
        start: origin,
        startTime,
        marks,
        ...parts,
        // Race notes steer the route: keep-out areas and slow areas.
        constraints: { ...parts.constraints, ...zonesFromNotes(raceNotes) },
        computeSensitivity,
        returnExplored: routeSettings.showExplored,
        algorithm: routeSettings.algorithm,
        greatCircle: routeSettings.greatCircle,
        // The wind now, if it was measured or set, and not the forecast itself.
        scalings:
          routeSettings.nowDecayMin > 0 && liveWind && liveWind.source !== 'forecast'
            ? {
                ...parts.scalings,
                nowCorrection: {
                  t0: startTime,
                  observedTwd: liveWind.twd,
                  observedTws: liveWind.tws,
                  decayMin: routeSettings.nowDecayMin,
                },
              }
            : parts.scalings,
      }
    },
    [origin, course.marks, landPack, boat, routeSettings, polar?.reference, raceNotes, liveWind],
  )
  const heightFactor = windHeightFactor(polar?.reference, boat.mastHeightMetres)

  // The venue's land, and with ENC cells open, water under the safety depth and the dangers.
  const routeBySafety = useCharts((s) => s.routeBySafety)
  const landPayload = useCallback(() => {
    const base = landPack ? { bbox: landPack.meta.bbox, nx: landPack.meta.nx, ny: landPack.meta.ny, bits: landPack.bits } : undefined
    return routeBySafety && encCells.length ? withEncHazards(base, encCells, safetyDepthM) : base
  }, [landPack, routeBySafety, encCells, safetyDepthM])

  // The route checked against the ENC: land, shallow water and dangers it meets.
  const hazards = useMemo(() => (route?.ok && encCells.length ? checkRoute(route.legs.map((l) => l.position), encCells, safetyDepthM) : null), [route, encCells, safetyDepthM])
  const [showHazards, setShowHazards] = useState(false)
  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return
    setSource(map, 'route-hazards', { type: 'FeatureCollection', features: (hazards ?? []).map((h) => ({ type: 'Feature', properties: { what: h.what }, geometry: { type: 'Point', coordinates: [h.at.lon, h.at.lat] } })) } as FC)
  }, [ready, hazards])

  /** Route the course, or, given marks, those instead: to or via the pointer. */
  /** The course through each member of an ensemble forecast, one after another in the worker. */
  const runEnsemble = useCallback(async () => {
    if (!origin || !polar || course.marks.length === 0 || !cube) return
    setBusy('Ensemble: downloading members…')
    setRouteError(null)
    try {
      const members = await fetchEnsembleCubes({ bbox: cube.bbox, hours: Math.max(6, Math.round(((cube.nt - 1) * cube.dtMs) / 3_600_000)), members: 10 })
      const req = buildRequest(Date.now(), false)
      if (!req) return
      clientRef.current ??= new RoutingClient()
      const out: MemberRoute[] = []
      for (const [i, m] of members.entries()) {
        setBusy(`Ensemble: member ${i + 1} of ${members.length}…`)
        const r = await clientRef.current.route(req, { cube: m, polar, polarPort, landRaster: landPayload() })
        out.push(memberRoute(m.model, r))
      }
      useStore.getState().setEnsembleRoutes(out)
    } catch (e) {
      setRouteError(`Ensemble unavailable: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(null)
    }
  }, [origin, polar, polarPort, course.marks, cube, buildRequest, landPayload, setRouteError])

  // Fleet routing: every boat with a polar and a position, routed with her own polar.
  const [fleetRows, setFleetRows] = useState<{ rows: FleetRouteRow[]; skipped: Array<{ name: string; why: string }> } | null>(null)
  const [showFleet, setShowFleet] = useState(false)
  const runFleet = useCallback(async () => {
    const marks = course.marks.slice(useStore.getState().activeMarkIndex).map((m) => m.position)
    if (!marks.length) return
    const s = useStore.getState()
    const now = Date.now()
    const positions = fleetPositions(s.fleet, useTracking.getState().tracks, useAis.getState().targets, now)
    const { jobs, skipped } = fleetRouteJobs(s.fleet, positions, (b) => fleetPolar(b, POLAR_LIBRARY, polar))
    // A new run clears the last one's rows, so a failure never leaves them showing.
    setFleetRows(null)
    if (!jobs.length) {
      setFleetRows({ rows: [], skipped })
      setShowFleet(true)
      return
    }
    let download = cube
    if (!download && needsDownload) download = await loadWeather()
    const sources = pickSources(download)
    if (!sources) {
      setRouteError(noWeather)
      return
    }
    setShowFleet(true)
    clientRef.current ??= new RoutingClient()
    const rows: FleetRouteRow[] = []
    try {
      for (const [i, job] of jobs.entries()) {
        setBusy(`Fleet: ${job.name}, ${i + 1} of ${jobs.length}…`)
        const req = buildRequest(now, false, marks)
        if (!req) break
        const r = await clientRef.current.route({ ...req, start: job.start }, { ...sources, polar: job.polar, polarPort: null, landRaster: landPayload() })
        rows.push(fleetRouteRow(job, r, route?.ok ? route.etaMs : null))
      }
    } finally {
      setBusy(null)
    }
    setFleetRows({ rows: rankFleet(rows), skipped })
  }, [course.marks, polar, cube, needsDownload, loadWeather, pickSources, noWeather, buildRequest, landPayload, route, setRouteError])
  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return
    const features: GeoJSON.Feature[] = (fleetRows?.rows ?? [])
      .filter((r) => r.ok && r.track.length > 1)
      .map((r) => ({ type: 'Feature', properties: { color: r.colour, name: r.name }, geometry: { type: 'LineString', coordinates: r.track.map((p) => [p.lon, p.lat]) } }))
    setSource(map, 'fleet-route', { type: 'FeatureCollection', features } as FC)
  }, [ready, fleetRows])

  const tidalOn = useStore((s) => s.routeSettings.tidalStreams)
  const tidalRadius = useStore((s) => s.routeSettings.tidalRadiusNm)
  /** NOAA's harmonic current stations around the course, when tidal streams are on. */
  const tidalFor = useCallback(
    async (marks: LatLon[]): Promise<{ sources: StreamSource[]; radiusNm: number } | undefined> => {
      if (!tidalOn || !origin) return undefined
      const pts = [origin, ...marks]
      const lat = pts.reduce((a, p) => a + p.lat, 0) / pts.length
      const lon = pts.reduce((a, p) => a + p.lon, 0) / pts.length
      const reach = Math.max(...pts.map((p) => distance({ lat, lon }, p))) + (tidalRadius ?? 5) + 2
      const near = nearestCurrentStations(await currentStations(), { lat, lon }, reach, 40)
      const got = await Promise.all(
        near.map(async (st) => {
          const bins = await stationStreams(st.id)
          const bin = bins.find((b) => b.bin === st.bin) ?? [...bins].sort((a, b) => (a.depthM ?? 99) - (b.depthM ?? 99))[0]
          return bin ? { position: st.position, bin } : null
        }),
      )
      const sources: StreamSource[] = []
      for (const g of got) if (g) sources.push(g)
      return { sources, radiusNm: tidalRadius ?? 5 }
    },
    [tidalOn, tidalRadius, origin],
  )
  const run = useCallback(async (leaveAt?: Millis, marksOverride?: LatLon[]) => {
    if (!origin || !polar || (marksOverride?.length ?? course.marks.length) === 0) return
    const thisRun = ++runIdRef.current
    let download = cube
    if (!download && needsDownload) download = await loadWeather()
    if (thisRun !== runIdRef.current) return
    const sources = pickSources(download)
    if (!sources) {
      setRouteError(noWeather)
      return
    }
    const { cube: workingCube, extraCubes } = sources
    setBusy('Routing…')
    setProgress(0)
    setRouteError(null)
    try {
      clientRef.current ??= new RoutingClient()
      const startTime = leaveAt ?? Date.now()
      const req = buildRequest(startTime, true, marksOverride)
      if (!req) return
      let tidalProblem: string | null = null
      const tidal = await tidalFor(req.marks).catch((e) => {
        tidalProblem = e instanceof Error ? e.message : String(e)
        return undefined
      })
      if (thisRun !== runIdRef.current) return
      const result = await clientRef.current.route(
        req,
        { cube: workingCube, extraCubes, tidal, polar, polarPort, landRaster: landPayload() },
        (f) => { if (thisRun === runIdRef.current) setProgress(f) },
      )
      if (thisRun !== runIdRef.current) return
      // Follow what the kernel actually did, not what this side hoped it would.
      // The two disagree when the pack loads here but the worker rejects it as
      // corrupt, and that disagreement used to resolve in favour of the
      // reassuring message — telling a sailor land was avoided on a route that
      // was never checked against it.
      if (tidalProblem) result.diagnostics.warnings.unshift(`Tidal streams unavailable (${tidalProblem}); the forecast current was used.`)
      if (!result.diagnostics.landAvoided) {
        result.diagnostics.warnings.unshift(
          landError
            ? `Land avoidance is OFF — the coastline pack failed to load (${landError}). This route may cross land.`
            : !landPack
              ? 'Land avoidance is OFF — the coastline pack has not loaded yet. This route may cross land.'
              : 'Land avoidance is OFF — the router rejected the coastline pack as unusable. This route may cross land.',
        )
      } else if (landPack) {
        // State the limits of the thing that is now on, rather than implying it
        // is a substitute for looking at a chart.
        result.diagnostics.warnings.push(
          `Land avoided using a ${Math.round(
            landPack.meta.cellDeg * 111000,
          )} m OSM coastline raster over the Portland venue only. Outside that box, and for anything narrower than a cell, it does not apply. Not a depth check.`,
        )
      }
      setRoute(result)
      setDepartAt(leaveAt ?? null)
      if (!result.ok) setRouteError(result.error ?? 'Routing failed')
    } catch (e) {
      if (thisRun !== runIdRef.current) return
      setRouteError(e instanceof Error ? e.message : 'Routing failed')
    } finally {
      if (thisRun === runIdRef.current) setBusy(null)
    }
    /*
     * `landPack` and `landError` belong here, and their absence was a real bug.
     *
     * The mask loads asynchronously after mount. Without them in the deps this
     * callback keeps the closure from the render before the pack arrived, so a
     * route fired after loading would run with `avoidLand: false` AND print
     * "Land avoidance is OFF — the coastline pack has not loaded yet" over a pack
     * that had in fact loaded. Both halves wrong, in the unsafe direction, and
     * invisible unless some other dependency happened to change first.
     */
  }, [
    origin,
    polar,
    polarPort,
    course.marks,
    cube,
    pickSources,
    tidalFor,
    needsDownload,
    noWeather,
    buildRequest,
    landPayload,
    landPack,
    landError,
    loadWeather,
    setRoute,
    setRouteError,
  ])

  /**
   * Sweep the next `SWEEP_HOURS` for a better time to leave.
   *
   * Hourly, which is both the forecast cadence and about as fine as a departure
   * recommendation can honestly be — the wind field itself only changes hourly, so
   * a 15-minute sweep would be ranking interpolation artefacts.
   */
  const runSweep = useCallback(async () => {
    if (!origin || !polar || course.marks.length === 0) return
    let download = cube
    if (!download && needsDownload) download = await loadWeather()
    const sources = pickSources(download)
    if (!sources) {
      setRouteError(noWeather)
      return
    }
    const { cube: workingCube, extraCubes } = sources

    /*
     * Never sweep past the forecast. The cube ends at a hard edge, and a departure
     * close to it would be solved against a field that runs out mid-passage: the
     * kernel would either fail it or extrapolate, and either way the ranking would
     * be an artefact of where the download stopped rather than of the weather.
     * Reserve the direct-rhumb time as the minimum passage left after departure.
     */
    const from = Date.now()
    const cubeEndMs = workingCube.t0 + (workingCube.nt - 1) * workingCube.dtMs
    const reserveMs = Math.max(2, Math.min(24, (legNm ?? 10) / 4)) * 3_600_000
    const to = Math.min(from + SWEEP_HOURS * 3_600_000, cubeEndMs - reserveMs)
    if (to <= from) {
      setRouteError(
        'The loaded forecast does not reach far enough ahead to compare departure times. Download a longer forecast first.',
      )
      return
    }

    setBusy('Comparing departures…')
    setProgress(0)
    setRouteError(null)
    try {
      clientRef.current ??= new RoutingClient()
      const req = buildRequest(from, false)
      if (!req) return
      const s = await clientRef.current.sweep(
        req,
        { cube: workingCube, extraCubes, tidal: await tidalFor(course.marks.map((m) => m.position)).catch(() => undefined), polar, polarPort, landRaster: landPayload() },
        { from, to, stepMs: 3_600_000, maxSolves: SWEEP_HOURS + 1 },
        (f) => setProgress(f),
      )
      if (!landPack) {
        s.warnings.unshift(
          'Land avoidance is OFF for this comparison — departures were ranked without a coastline.',
        )
      }
      setSweep(s)
      setShowDepart(true)
      if (!s.best) setRouteError(s.warnings[0] ?? 'No departure in the window produced a route.')
    } catch (e) {
      setRouteError(e instanceof Error ? e.message : 'Departure comparison failed')
    } finally {
      setBusy(null)
    }
  }, [
    origin,
    polar,
    polarPort,
    course.marks,
    cube,
    pickSources,
    tidalFor,
    needsDownload,
    noWeather,
    legNm,
    buildRequest,
    landPayload,
    landPack,
    loadWeather,
    setRouteError,
  ])

  useEffect(() => () => clientRef.current?.dispose(), [])

  const canRoute = !!origin && !!polar && course.marks.length > 0 && !busy
  const forecastNotes = useMemo(() => (cube ? cubeNotes(cube) : []), [cube])

  /*
   * Derived rather than computed inside `run`, so it re-runs when the depth grid
   * or the tide curve lands after the route, and when the draft is entered in
   * Setup afterwards. Cheap: a few hundred bilinear samples over an in-memory grid.
   */
  const depth = useMemo<DepthAdvisory | null>(() => {
    if (!route?.ok || route.legs.length === 0) return null
    if (!depthGrid) return null
    return depthAdvisory({
      route,
      depthAt: (lat, lon) => depthAt(depthGrid, lat, lon),
      levels,
      datum: PORTLAND_DATUM,
      draftM: boat.draftMetres ?? null,
    })
  }, [route, depthGrid, levels, boat.draftMetres])

  return (
    <div className="screen screen--flush" style={{ position: 'relative' }}>
      {/*
        The map and its overlay share one flexing area, and the actions row gets
        its own space below it. With the map directly in the screen, MapLibre's
        stylesheet made it position: relative at full height (see .map in
        styles.css). That pushed FORECAST, ROUTE, WHEN and RESULTS below the
        screen's clipped edge, where nobody could see them.
      */}
      <div className="chart-area" onDragOver={gribDrop.onDragOver} onDrop={gribDrop.onDrop}>
        <div ref={containerRef} className="map" />

        <div className="canvas-overlay">
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {(() => {
              // What the next route will sail on, by the source chosen in SETTINGS.
              const s = pickSources(cube)
              const label = !s ? 'no forecast' : `${s.cube.model}${s.cube === cube ? ` · ${cube.nt}h` : ''}`
              const more = s?.extraCubes.length ?? 0
              return (
                <span className={`chip ${s ? 'chip--good' : ''}`} title={`Route on: ${routeSource}`}>
                  <span className="dot" />
                  {label}
                  {more ? ` + ${more} GRIB file${more === 1 ? '' : 's'}` : ''}
                  {routeSource !== 'merged' ? ` · ${routeSource === 'download' ? 'download only' : 'files only'}` : ''}
                </span>
              )
            })()}
            <span className="chip">{PILOT_VENUE.name}</span>
            <button className={`chip${encCells.length ? ' chip--good' : ''}`} onClick={() => setShowEnc(true)} style={{ pointerEvents: 'auto' }}>
              ENC{encCells.length ? ` · ${encCells.length}` : ''}
            </button>
            {aisTargets.length > 0 && (
              <button
                className={`chip${aisTargets.some((t) => t.alert) ? ' chip--warn' : ''}`}
                onClick={() => setShowAis(true)}
                style={{ pointerEvents: 'auto' }}
              >
                {aisTargets.some((t) => t.alert) ? 'AIS ALERT · ' : 'AIS · '}
                {aisTargets.length}
              </button>
            )}
          {picking === 'start' || picking === 'mark' ? (
            <button className="chip chip--warn" onClick={() => setPicking(null)}>
              tap the chart for the {picking === 'start' ? 'start' : 'new mark'} · cancel
            </button>
          ) : routeStart ? (
            <button
              className="chip chip--warn"
              onClick={() => setRouteStart(null)}
              title="Routes start from the point you picked. Tap to route from the boat again."
            >
              from planned start ✕
            </button>
          ) : (
            <button
              className="chip"
              onClick={() => setPicking('start')}
              title="Plan from anywhere: pick a start on the chart"
            >
              {state ? 'from the boat · pick start' : 'no fix · pick a start'}
            </button>
          )}
          {!picking && (
            <button className="chip" onClick={() => setPicking('mark')} title="Tap the chart to add a mark">
              + mark
            </button>
          )}
          {/*
            The pointer readout: where the mouse is (or the last tap), and from the
            boat or planned start, the range, true bearing and polar time to it.
          */}
          {pointer && picking !== 'measure' && (
            <span className="chip" aria-label="Pointer readout" title="Pointer: position, then range, bearing and polar time from the boat">
              {fmtPosition(pointer)}
              {toPointer && ` · ${toPointer.distanceNm.toFixed(2)} nm ${fmtDeg(toPointer.bearing)}°T`}
              {toPointer?.timeS != null && ` · ${fmtDuration(toPointer.timeS)}`}
              {pointerIso && ` · isochrone T+${fmtDuration((pointerIso.iso.t - (route?.legs[0]?.t ?? pointerIso.iso.t)) / 1000)}${pointerIso.dnm != null ? ` · DNM ${Math.round(pointerIso.dnm)}%` : ''}`}
            </span>
          )}
          {pointer && picking == null && (
            <>
              <button
                className="chip"
                onClick={() => useStore.getState().insertMark('Go here', pointer, activeMarkIndex, true)}
                title="A mark at the pointer, sailed to next: the rest of the course stays"
              >
                go here
              </button>
              {course.marks.length > 0 && (
                <button
                  className="chip"
                  onClick={() => {
                    const i = nearestLegInsert(course.marks.map((m) => m.position), pointer, origin)
                    useStore.getState().insertMark(`Mark ${course.marks.length + 1}`, pointer, i)
                  }}
                  title="A mark at the pointer, put into the leg it is nearest"
                >
                  + into leg
                </button>
              )}
            </>
          )}
          {pointer && origin && polar && picking == null && (
            <>
              <button className="chip" onClick={() => void run(undefined, [pointer])} title="Optimal route from the boat to this point">
                route here
              </button>
              {course.marks.length > 0 && (
                <button
                  className="chip"
                  onClick={() => void run(undefined, [pointer, ...course.marks.slice(activeMarkIndex).map((m) => m.position)])}
                  title="Optimal route through this point, then on round the course from the active mark"
                >
                  route via here
                </button>
              )}
            </>
          )}
          {picking === 'note' ? (
            <>
              {(['area', 'line', 'point'] as const).map((k) => (
                <button
                  key={k}
                  className={'chip' + (draft.kind === k ? ' chip--good' : '')}
                  aria-pressed={draft.kind === k}
                  onClick={() => setDraft({ kind: k, points: k === 'point' ? draft.points.slice(0, 1) : draft.points })}
                >
                  {k}
                </button>
              ))}
              <button
                className="chip chip--warn"
                disabled={draft.points.length < NOTE_MIN_POINTS[draft.kind]}
                onClick={finishNote}
              >
                {draft.points.length < NOTE_MIN_POINTS[draft.kind]
                  ? 'tap ' + (NOTE_MIN_POINTS[draft.kind] - draft.points.length) + ' more'
                  : 'finish (' + draft.points.length + ')'}
              </button>
              <button
                className="chip"
                onClick={() => {
                  setPicking(null)
                  setDraft({ kind: draft.kind, points: [] })
                }}
              >
                cancel
              </button>
            </>
          ) : (
            !picking && (
              <button className="chip" onClick={() => setPicking('note')} title="Draw a race note: a point, line or area">
                + note
              </button>
            )
          )}
          {picking === 'measure' ? (
            <button
              className="chip chip--warn"
              onClick={() => {
                setPicking(null)
                setMeasure(null)
              }}
            >
              {divider
                ? `${divider.distanceNm.toFixed(2)} nm ${fmtDeg(divider.bearing)}°T · done`
                : measure
                  ? 'tap the second point · done'
                  : 'tap the first point · done'}
            </button>
          ) : (
            !picking && (
              <button className="chip" onClick={() => setPicking('measure')} title="Dividers: range and bearing between two points">
                measure
              </button>
            )
          )}
          {hazards && (
            <button
              className={`chip${hazards.length ? ' chip--warn' : ''}`}
              aria-label={hazards.length ? `Route check: ${hazards.length} hazard${hazards.length === 1 ? '' : 's'}` : 'Route check: clear'}
              title="The route checked against the ENC cells: land, water under the safety depth, and dangers within 50 m"
              onClick={() => setShowHazards((v) => !v)}
            >
              {hazards.length ? `⚠ ${hazards.length} on route` : '✓ route clear'}
            </button>
          )}
          <button
            className={`chip${orientation !== 'north' ? ' chip--on' : ''}`}
            aria-label={`Chart orientation: ${ORIENTATION_LABEL[orientation]}`}
            title="What is up: north, the active leg, or the boat's head. Tap to change."
            onClick={() => updateSettings({ chartOrientation: ORIENTATIONS[(ORIENTATIONS.indexOf(orientation) + 1) % ORIENTATIONS.length] })}
          >
            {ORIENTATION_LABEL[orientation].toLowerCase()}
          </button>
          <button
            className={`chip${motion !== 'free' ? ' chip--on' : ''}`}
            aria-label={`Chart motion: ${MOTION_LABEL[motion]}`}
            title="What the chart keeps in view: nothing, the boat, the boat and ten minutes ahead, or the boat and the active mark. Dragging the chart sets it free. Tap to change."
            onClick={() => updateSettings({ chartMotion: MOTIONS[(MOTIONS.indexOf(motion) + 1) % MOTIONS.length] })}
          >
            {MOTION_LABEL[motion].toLowerCase()}
          </button>
          <button className="chip" onClick={() => void exportChart('save')} title="Save the chart as a picture (PNG)" aria-label="Save chart image">
            image
          </button>
          <button className="chip" onClick={() => void exportChart('print')} title="Print the chart" aria-label="Print chart">
            print
          </button>
          {route?.ok && steps.length > 1 && (
            <>
              <button className="chip" aria-label="Route start" title="The route's start (Shift-Up and Shift-Down step)" onClick={() => step(0)}>
                ⏮
              </button>
              <button className="chip" aria-label="Previous routing step" onClick={() => step(-1)}>
                ◀
              </button>
              <button className="chip" aria-label="Next routing step" onClick={() => step(1)}>
                ▶
              </button>
              {stepAt && stepT != null && (
                <span className="chip chip--on" aria-label="Route step">
                  T+{fmtDuration((stepT - route.legs[0].t) / 1000)} · {stepAt.leg.bsp.toFixed(1)} kn · TWS {stepAt.leg.tws.toFixed(0)} · TWA {Math.round(Math.abs(stepAt.leg.twa))}°
                </span>
              )}
            </>
          )}
            {/*
              A correction applied to the forecast changes every route, and nothing
              on the map shows it. Name each one, so a wind rotated for yesterday's
              race is not still quietly steering today's.
            */}
            {heightFactor !== 1 && (
            <span
              className="chip"
              title="The polar is referenced to masthead wind, so the 10 m forecast is lifted to your mast height"
            >
              masthead wind ×{heightFactor.toFixed(2)}
            </span>
          )}
          {(() => {
            const z = zonesFromNotes(raceNotes)
            const n = (z.avoidAreas?.length ?? 0) + (z.slowAreas?.length ?? 0)
            return n > 0 ? (
              <span className="chip chip--warn" title="Race notes the router keeps out of, or slows down in">
                {n} race note{n === 1 ? '' : 's'} steer routes
              </span>
            ) : null
          })()}
          {whatIfActive(whatIf) && (
            <span className="chip chip--warn" title="What-if is on: laylines show it, routes do not">
              what-if: {describeWhatIf(whatIf)}
            </span>
          )}
          {nonDefaultLabels(routeSettings).map((label) => (
              <span className="chip chip--warn" key={label} title="Routing setting — change in SETTINGS">
                {label}
              </span>
            ))}
            {legNm != null && <span className="chip">{legNm.toFixed(1)} nm rhumb</span>}
            {landPack ? (
              <span className="chip chip--good" title={landPack.meta.attribution}>
                land pack {Math.round(landPack.meta.cellDeg * 111000)} m
              </span>
            ) : (
              <span className="chip chip--bad">{landError ? 'land pack failed' : 'no land pack'}</span>
            )}
            {/*
              Say which departure the drawn route belongs to whenever it is not
              "now". A route solved for 14:00 looks identical to one solved for the
              current minute, and quietly showing yesterday's plan as today's is the
              same class of mistake as the stale gun timer on the Start tab.
            */}
            {departAt != null && route?.ok && (
              <span className="chip chip--warn" title="This route was solved for a future departure">
                leaves {fmtLocalHm(departAt)}
              </span>
            )}
            {/*
              The shallowest water on the route, as a headline. `chip--bad` only when
              something is actually close: a permanent red badge over deep water would
              train the reader to ignore it, which is worse than not showing it.
            */}
            {depth?.shallowest && (
              <span
                className={`chip ${depth.concerns.length > 0 ? 'chip--bad' : ''}`}
                title={
                  depth.shallowest.underKeelM != null
                    ? 'Shallowest modelled water under the keel on this route'
                    : 'Shallowest modelled depth on this route — no draft set'
                }
              >
                min{' '}
                {depth.shallowest.underKeelM != null
                  ? `${fmtLength(depth.shallowest.underKeelM, units)} keel`
                  : `${fmtLength(depth.shallowest.depthNowM ?? depth.shallowest.depthMslM, units)} deep`}
              </span>
            )}
            {busy && (
              <span className="chip chip--warn">
                <span className="spinner" /> {busy}
                {progress > 0 ? ` ${Math.round(progress * 100)}%` : ''}
              </span>
            )}
          </div>

          <div>
            {forecastNotes.map((note) => (
              <div className="warnbox" key={note}>
                {note}
              </div>
            ))}
            {routeError && <div className="errbox">{routeError}</div>}
            {route?.ok && route.legs.length > 0 && (
              // In flow under the forecast notes, not absolute over them: a long
              // note used to sit on top of the legend and swallow its toggle.
              <div className="legend legend--inline">
                <div>
                  <span className="swatch" style={{ background: '#ff3ea5' }} />
                  <b>optimal route</b>
                </div>
                <div>
                  <span className="swatch" style={{ background: '#ff9ad2' }} />
                  beating (implicit tacks)
                </div>
                <div>
                  <span className="swatch" style={{ background: 'rgba(79,195,247,.55)' }} />
                  isochrones
                </div>
                <div>
                  <span className="swatch" style={{ background: 'rgba(255,213,74,.35)' }} />
                  within {routeSettings.bandMin} min of optimal
                </div>
                {route.reverseIsochrones.length > 0 && (
                  <button
                    className="legend__toggle"
                    aria-pressed={showReverse}
                    onClick={() => setShowReverse((v) => !v)}
                  >
                    <span className="swatch" style={{ background: '#ffb74d' }} />
                    reverse isochrones {showReverse ? 'on' : 'off'}
                  </button>
                )}
                {showReverse && route.reverseIsochrones.length > 0 && (
                  <div className="legend__note">
                    Amber: equal time <b>to</b> the finish. Parallel to the blue over a long
                    stretch, the exact route matters little. Touching only briefly, it matters
                    a lot.
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

      </div>

      <div className="actions" style={{ position: 'relative', zIndex: 2 }}>
        <button className="btn btn--sm" onClick={loadWeather} disabled={!origin || !!busy}>
          FORECAST
        </button>
        {/*
          `() => run()` rather than `run`: `run` takes an optional departure time,
          and passing the handler directly would hand it a MouseEvent as the
          departure — a number-shaped argument that is not a number.
        */}
        <button className="btn btn--sm btn--primary" onClick={() => run()} disabled={!canRoute}>
          ROUTE
        </button>
        <button className="btn btn--sm btn--ghost" onClick={runSweep} disabled={!canRoute}>
          WHEN
        </button>
        <button className="btn btn--sm btn--ghost" onClick={() => void runFleet()} disabled={!canRoute || fleetCount === 0 || !!busy} title="Route every boat in the fleet with her own polar">
          FLEET
        </button>
        <button
          className="btn btn--sm btn--ghost"
          onClick={() => setShowResults(true)}
          disabled={!route?.ok}
        >
          RESULTS
        </button>
        <button className="btn btn--sm btn--ghost" onClick={() => setShowSettings(true)}>
          SETTINGS
        </button>
      </div>

      {!polar && (
        <div className="warnbox" style={{ position: 'absolute', left: 12, right: 12, bottom: 74, zIndex: 3 }}>
          No polar loaded — pick a boat class in <b>Setup</b> before routing.
        </div>
      )}

      {showResults && route?.ok && (
        <ResultsSheet
          route={route}
          depth={depth}
          levels={levels}
          onClose={() => setShowResults(false)}
          onEnsemble={() => void runEnsemble()}
          busy={busy != null}
        />
      )}

      {showSettings && <RouteSettingsSheet onClose={() => setShowSettings(false)} />}
      {showAis && <AisSheet onClose={() => setShowAis(false)} />}
      {showHazards && hazards && (
        <div className="sheet" role="dialog" aria-label="Route check">
          <div className="sheet__grip" onClick={() => setShowHazards(false)} />
          <h2>Route check</h2>
          {hazards.length === 0 ? (
            <p className="note">The route keeps off land, in water of at least {safetyDepthM} m, and 50 m or more from charted dangers, on the cells open.</p>
          ) : (
            <ol aria-label="Hazards on the route">
              {hazards.map((h, i) => (
                <li key={i}>
                  Leg {h.leg + 1}: {h.what}
                </li>
              ))}
            </ol>
          )}
          <p className="note">Only as good as the cells open and their survey. Not for navigation.</p>
          <button className="btn btn--sm" onClick={() => setShowHazards(false)}>
            Done
          </button>
        </div>
      )}
      {showEnc && <EncSheet onClose={() => setShowEnc(false)} onShow={(b) => mapRef.current?.fitBounds([[b.west, b.south], [b.east, b.north]], { padding: 40, duration: 0 })} />}
      {showFleet && fleetRows && <FleetRoutesSheet rows={fleetRows.rows} skipped={fleetRows.skipped} onClose={() => setShowFleet(false)} />}
      {encQuery && (
        <div className="legend" role="dialog" aria-label="Chart objects" style={{ position: 'absolute', right: 10, top: 90, maxWidth: 260, maxHeight: 260, overflow: 'auto', pointerEvents: 'auto', zIndex: 5 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
            <b>Chart objects</b>
            <button onClick={() => setEncQuery(null)} aria-label="Close chart objects" style={{ color: 'var(--ink-faint)' }}>
              ✕
            </button>
          </div>
          {encQuery.objects.map((o, i) => (
            <div key={i} style={{ marginTop: 4 }}>
              <b>{o.cls}</b>
              {o.attrs.OBJNAM ? ` · ${o.attrs.OBJNAM}` : ''}{' '}
              <button
                className="btn btn--sm btn--ghost"
                aria-label={`Mark ${o.attrs.OBJNAM || o.cls}`}
                title="A mark on this object, at the end of the course"
                onClick={() => {
                  const g = o.geometry
                  const at = g?.type === 'Point' ? { lat: g.coordinates[1], lon: g.coordinates[0] } : encQuery.at
                  useStore.getState().addMark(o.attrs.OBJNAM || o.cls, at)
                }}
              >
                MARK IT
              </button>
              <div className="note">
                {Object.entries(o.attrs)
                  .filter(([k]) => k !== 'OBJNAM')
                  .map(([k, v]) => `${k} ${v}`)
                  .join(', ') || 'no attributes'}{' '}
                · {o.cell}
              </div>
            </div>
          ))}
          <p className="note" style={{ marginTop: 6 }}>Not for navigation.</p>
        </div>
      )}
      {editingNote && raceNotes.some((n) => n.id === editingNote) && (
        <RaceNoteSheet note={raceNotes.find((n) => n.id === editingNote)!} onClose={() => setEditingNote(null)} />
      )}

      {showDepart && sweep && (
        <DepartureSheet
          sweep={sweep}
          selected={departAt}
          busy={!!busy}
          onClose={() => setShowDepart(false)}
          onPick={(t) => {
            setShowDepart(false)
            void run(t)
          }}
        />
      )}
    </div>
  )
}

// ------------------------------------------------------------------- sheets

function fmtLocalHm(ms: Millis): string {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/**
 * The departure comparison.
 *
 * Led by the advice line rather than the winner, because "it does not matter"
 * is a legitimate and common answer, and one this view has to be willing to give.
 * A screen that always names a best time trains you to believe there always is
 * one.
 */
function DepartureSheet({
  sweep,
  selected,
  busy,
  onClose,
  onPick,
}: {
  sweep: DepartureSweep
  selected: Millis | null
  busy: boolean
  onClose: () => void
  onPick: (t: Millis) => void
}) {
  const advice = departureAdvice(sweep)
  const best = sweep.best
  return (
    <div className="sheet">
      <div className="sheet__grip" onClick={onClose} />

      {advice && (
        <div className={advice.matters ? 'legend' : 'warnbox'} style={{ marginBottom: 10 }}>
          {advice.text}
        </div>
      )}

      <DepartureChart sweep={sweep} selected={selected} />

      <div className="rows" style={{ margin: '12px 0' }}>
        <div className="row">
          <span>Best departure</span>
          <span>{best ? `${fmtLocalHm(best.departAt)} local` : '—'}</span>
        </div>
        <div className="row">
          <span>Passage then</span>
          <span>{fmtDuration(best?.elapsedS ?? null) ?? '—'}</span>
        </div>
        <div className="row">
          <span>Spread over window</span>
          {/*
            Explicitly "not enough data" rather than a dash, which this app also
            uses for a forecast hole. One successful solve cannot support a spread,
            and the reader should be told which of the two it is looking at.
          */}
          <span>
            {sweep.spreadS == null
              ? sweep.succeeded < 2
                ? 'needs 2+ departures'
                : '—'
              : (fmtDuration(sweep.spreadS) ?? '—')}
          </span>
        </div>
        <div className="row">
          <span>Router resolution</span>
          <span>
            {sweep.stepFloorS == null ? '—' : `±${Math.round(sweep.stepFloorS / 60)} min`}
          </span>
        </div>
        <div className="row">
          <span>Departures solved</span>
          <span>
            {sweep.succeeded} of {sweep.attempted}
          </span>
        </div>
      </div>

      {sweep.warnings.map((w) => (
        <div className="warnbox" key={w}>
          {w}
        </div>
      ))}

      <table className="results">
        <thead>
          <tr>
            <th>leave</th>
            <th>arrive</th>
            <th>passage</th>
            <th>cost</th>
          </tr>
        </thead>
        <tbody>
          {sweep.options.map((d) => (
            <tr
              key={d.departAt}
              style={
                best && d.departAt === best.departAt
                  ? { color: 'var(--stbd)', fontWeight: 600 }
                  : undefined
              }
            >
              <td>{fmtLocalHm(d.departAt)}</td>
              <td>{d.etaMs == null ? '—' : fmtLocalHm(d.etaMs)}</td>
              <td>{fmtDuration(d.elapsedS) ?? '—'}</td>
              <td>
                {d.costS == null
                  ? (d.error ?? 'no route')
                  : d.costS === 0
                    ? 'best'
                    : `+${Math.round(d.costS / 60)} min`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="note">
        Each row is a full route solve from that time, using the same boat, polar
        and constraints as the ROUTE button. Ranked on elapsed passage time —
        differences smaller than the router resolution above are not real.
      </p>

      <div className="actions" style={{ background: 'none', border: 'none', padding: 0 }}>
        <button
          className="btn btn--sm btn--primary"
          disabled={!best || busy}
          onClick={() => best && onPick(best.departAt)}
        >
          ROUTE FROM {best ? fmtLocalHm(best.departAt) : '—'}
        </button>
        <button className="btn btn--sm" onClick={onClose}>
          CLOSE
        </button>
      </div>
    </div>
  )
}

/**
 * The grounding advisory.
 *
 * Ends on the limits rather than opening with them. A caveat printed above a number
 * gets skipped; a caveat printed under one gets read after the number has raised
 * the question. But it is `errbox` when a leg is genuinely close and `note` when it
 * is not, because the strength of the wording has to track the situation or it
 * stops meaning anything.
 */
function DepthPanel({
  depth,
  levels,
}: {
  depth: DepthAdvisory
  levels: WaterLevelPrediction | null
}) {
  const units = useStore((st) => st.settings.units)
  const s = depth.shallowest
  if (!s) return null
  const tideLine = datumNote(levels, PORTLAND_DATUM, s.t)
  return (
    <>
      <div className="rows" style={{ marginBottom: 12 }}>
        <div className="row">
          <span>Shallowest on route</span>
          {/*
            "local" spelled out. The warning below this quotes the same instant in
            UTC with a Z, and an unlabelled 09:58 next to a labelled 14:58Z reads as
            two different times rather than one time in two zones.
          */}
          <span style={{ color: depth.concerns.length > 0 ? 'var(--port)' : undefined }}>
            {s.depthNowM != null
              ? `${fmtLength(s.depthNowM, units)} at ${fmtLocalHm(s.t)} local`
              : `${fmtLength(s.depthMslM, units)} (uncorrected)`}
          </span>
        </div>
        <div className="row">
          <span>Under the keel</span>
          {/*
            "no draft set" rather than an em dash. Pass 3's lesson: a dash means
            "no data" everywhere else in this app, and this is "bad state" — a
            question the user can answer in Setup in ten seconds.
          */}
          <span style={{ color: s.underKeelM != null && s.underKeelM < 1 ? 'var(--port)' : undefined }}>
            {s.underKeelM != null ? fmtLength(s.underKeelM, units) : 'no draft set'}
          </span>
        </div>
        <div className="row">
          <span>At leg</span>
          <span>
            {s.legIndex + 1} · {s.lat.toFixed(4)}, {s.lon.toFixed(4)}
          </span>
        </div>
        <div className="row">
          <span>Legs sampled</span>
          <span>
            {depth.samples.length}
            {depth.concerns.length > 0 ? ` · ${depth.concerns.length} shallow` : ''}
          </span>
        </div>
      </div>

      {tideLine && <div className="warnbox">{tideLine}</div>}
      {depth.warnings.map((w) => (
        <div className={depth.concerns.length > 0 ? 'errbox' : 'warnbox'} key={w}>
          {w}
        </div>
      ))}
      <p className="note">
        Advisory only, and <strong>not a depth check</strong>. Depths are GEBCO 2020
        on a 450&nbsp;m grid, which reads 18&nbsp;m shallow at the one nearby buoy
        where a surveyed figure exists and cannot see a ledge, rock or dredged
        channel at all. The router does <strong>not</strong> avoid shallow water.{' '}
        {DEPTH_NOT_FOR_NAVIGATION}
      </p>
    </>
  )
}

/** The course through each ensemble member: the spread of arrivals is the ETA's error bar. */
function EnsembleSection({ onRun, busy }: { onRun?: () => void; busy: boolean }) {
  const members = useStore((s) => s.ensembleRoutes)
  const summary = members ? summariseEnsemble(members) : null
  return (
    <section aria-label="Ensemble" style={{ marginBottom: 12 }}>
      <h2>Ensemble</h2>
      {summary ? (
        <div className="rows" aria-label="Ensemble spread">
          <div className="row"><span>Members routed</span><span>{summary.count}{summary.failed ? ` (${summary.failed} failed)` : ''}</span></div>
          <div className="row"><span>Earliest</span><span>{fmtDuration(summary.minS)}</span></div>
          <div className="row"><span>Mean</span><span>{fmtDuration(summary.meanS)}</span></div>
          <div className="row"><span>Latest</span><span>{fmtDuration(summary.maxS)}</span></div>
          <div className="row"><span>Spread (1 SD)</span><span>±{fmtDuration(summary.sdS)}</span></div>
          <div className="row"><span>Nearest the mean</span><span>{summary.typical}</span></div>
        </div>
      ) : members ? (
        <p className="note">No member could be routed.</p>
      ) : (
        <p className="note">Route the course through each member of an ensemble forecast, up to ten, to see how sure the ETA is.</p>
      )}
      {onRun && (
        <button className="btn btn--sm btn--ghost" disabled={busy} onClick={onRun}>
          RUN ENSEMBLE
        </button>
      )}
    </section>
  )
}

/** The earlier routes against this one: how much longer or shorter, and what was different. */
function CompareRoutes({ route }: { route: RouteResult }) {
  const kept = useStore((s) => s.keptRoutes)
  const clear = useStore((s) => s.clearKeptRoutes)
  if (kept.length === 0) return null
  return (
    <section aria-label="Compare routes" style={{ marginBottom: 12 }}>
      <h2>Compare</h2>
      <table className="results" aria-label="Earlier routes">
        <tbody>
          {kept.map((k, i) => {
            const d = k.elapsedS != null && route.elapsedS != null ? k.elapsedS - route.elapsedS : null
            return (
              <tr key={k.id}>
                <td>{i === 0 ? 'previous' : new Date(k.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</td>
                <td>{fmtDuration(k.elapsedS) ?? '—'}</td>
                <td>
                  {d == null
                    ? '—'
                    : Math.abs(d) < 30
                      ? 'about the same'
                      : `this one ${d > 0 ? fmtDuration(d) + ' faster' : fmtDuration(-d) + ' slower'}`}
                </td>
                <td>{k.settings.length ? k.settings.join(', ') : 'default settings'}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
      <button className="btn btn--sm btn--ghost" onClick={clear}>
        CLEAR EARLIER ROUTES
      </button>
    </section>
  )
}

function ResultsSheet({
  route,
  depth,
  levels,
  onClose,
  onEnsemble,
  busy,
}: {
  route: RouteResult
  depth: DepthAdvisory | null
  levels: WaterLevelPrediction | null
  onClose: () => void
  onEnsemble?: () => void
  busy?: boolean
}) {
  const step = Math.max(1, Math.floor(route.legs.length / 40))
  const rows = route.legs.filter((_, i) => i % step === 0)
  const sailChart = useStore((s) => s.sailChart)
  const addToLibrary = useStore((s) => s.addToLibrary)
  const [savedMarks, setSavedMarks] = useState<string | null>(null)
  const saved =
    route.directTimeS != null && route.elapsedS != null
      ? route.directTimeS - route.elapsedS
      : null
  return (
    <div className="sheet">
      <div className="sheet__grip" onClick={onClose} />
      <div className="rows" style={{ marginBottom: 12 }}>
        <div className="row">
          <span>ETA</span>
          <span>{route.etaMs ? new Date(route.etaMs).toUTCString().slice(5, 22) + ' UTC' : '—'}</span>
        </div>
        {/*
          `fmtDuration`, not `fmtClock`. These were showing a five-hour passage as
          "309:14" — the start-timer format applied to a passage length. Found while
          building the departure sheet next door, which had inherited the same
          mistake.
        */}
        <div className="row">
          <span>Elapsed</span>
          <span>{fmtDuration(route.elapsedS) ?? '—'}</span>
        </div>
        <div className="row">
          <span>vs. direct</span>
          <span style={{ color: saved && saved > 0 ? 'var(--stbd)' : undefined }}>
            {saved == null ? '—' : `${saved > 0 ? '-' : '+'}${fmtDuration(Math.abs(saved))}`}
          </span>
        </div>
        <div className="row">
          <span>Nodes explored</span>
          <span>{route.diagnostics.nodesExplored.toLocaleString()}</span>
        </div>
        <div className="row">
          <span>Compute</span>
          <span>{route.diagnostics.computeMs.toFixed(0)} ms</span>
        </div>
        <div className="row">
          <span>Time step</span>
          <span>{(route.diagnostics.timeStepS / 60).toFixed(0)} min</span>
        </div>
      </div>

      {depth?.shallowest && <DepthPanel depth={depth} levels={levels} />}

      <RouteMeteogram legs={route.legs} />
      <div className="actions" style={{ background: 'none', border: 'none', padding: '0 0 10px' }}>
        <button
          className="btn btn--sm btn--ghost"
          onClick={() => {
            const pts = turningPoints(route.legs)
            const folder = `Route ${new Date(route.legs[0].t).toISOString().slice(0, 16).replace('T', ' ')}`
            addToLibrary(folder, pts.map((l, i) => ({ name: i === 0 ? 'Start' : i === pts.length - 1 ? 'Finish' : `R${i}`, position: l.position })))
            setSavedMarks(`${pts.length} turning points filed in the marks library as "${folder}".`)
          }}
        >
          SAVE AS MARKS
        </button>
      </div>
      {savedMarks && <p className="note" role="status">{savedMarks}</p>}

      <CompareRoutes route={route} />
      <EnsembleSection onRun={onEnsemble} busy={busy ?? false} />

      {route.diagnostics.warnings.map((w) => (
        <div className="warnbox" key={w}>
          {w}
        </div>
      ))}

      <table className="results">
        <thead>
          <tr>
            <th>time</th>
            <th>twd</th>
            <th>tws</th>
            <th>twa</th>
            <th>bsp</th>
            <th>hdg</th>
            <th>current</th>
            <th>sail</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((l, i) => (
            <tr key={i} className={l.isBeating ? 'beating' : undefined}>
              <td>{new Date(l.t).toISOString().slice(11, 16)}</td>
              <td>{fmtDeg(l.twd)}</td>
              <td>{l.tws.toFixed(1)}</td>
              <td>
                {l.isBeating ? '(' : ''}
                {l.twa.toFixed(0)}
                {l.isBeating ? ')' : ''}
              </td>
              <td>{l.bsp.toFixed(2)}</td>
              <td>{fmtDeg(l.heading)}</td>
              <td>{l.currentSet != null && l.currentDrift != null ? `${fmtDeg(l.currentSet)} ${l.currentDrift.toFixed(1)}` : '—'}</td>
              <td>{sailAt(sailChart, Math.abs(l.twa), l.tws) ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="note">
        TWA in parentheses means the router is tacking or gybing through that
        stretch — the drawn line is a VMG-equivalent path, not a course to steer.
      </p>
      <div className="actions" style={{ background: 'none', border: 'none', padding: 0 }}>
        <button
          className="btn btn--sm btn--ghost"
          onClick={async () => {
            const { routeToGpx, downloadText } = await import('@/lib/gpx')
            downloadText('route.gpx', routeToGpx(route))
          }}
        >
          GPX
        </button>
        <button
          className="btn btn--sm btn--ghost"
          onClick={async () => {
            const { routeToCsv, downloadText } = await import('@/lib/gpx')
            downloadText('route.csv', routeToCsv(route), 'text/csv')
          }}
        >
          CSV
        </button>
        <button className="btn btn--sm" onClick={onClose}>
          CLOSE
        </button>
      </div>
    </div>
  )
}

// ----------------------------------------------------------------- map utils

type FC = GeoJSON.FeatureCollection

const emptyFC = (): FC => ({ type: 'FeatureCollection', features: [] })

const pointFC = (lon: number, lat: number): FC => ({
  type: 'FeatureCollection',
  features: [{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [lon, lat] } }],
})

/** Race notes as GeoJSON: an area is a closed polygon, a line a line, a point a point. */
function notesFC(notes: RaceNote[]): FC {
  return {
    type: 'FeatureCollection',
    features: notes.map((n) => {
      const c = n.points.map((p) => [p.lon, p.lat] as [number, number])
      const properties = {
        text: n.text,
        avoid: n.kind === 'area' && n.avoid,
        slow: n.kind === 'area' && !n.avoid && n.speedPct != null,
      }
      if (n.kind === 'area' && c.length >= 3) {
        return { type: 'Feature' as const, properties, geometry: { type: 'Polygon' as const, coordinates: [[...c, c[0]]] } }
      }
      if (n.kind !== 'point' && c.length >= 2) {
        return { type: 'Feature' as const, properties, geometry: { type: 'LineString' as const, coordinates: c } }
      }
      return { type: 'Feature' as const, properties, geometry: { type: 'Point' as const, coordinates: c[0] ?? [0, 0] } }
    }),
  }
}

/** The course marks, numbered in order, carrying their ids for dragging. */
function marksFC(
  marks: Array<{ id: string; position: { lat: number; lon: number }; gate?: { left: LatLon; right: LatLon } }>,
): FC {
  return {
    type: 'FeatureCollection',
    features: marks.flatMap((m, i) => {
      const pt = (p: LatLon, name: string, id: string) => ({
        type: 'Feature' as const,
        properties: { name, id },
        geometry: { type: 'Point' as const, coordinates: [p.lon, p.lat] },
      })
      // A gate is drawn as its two buoys, labelled from the left looking upwind.
      return m.gate
        ? [pt(m.gate.left, `${i + 1}L`, m.id), pt(m.gate.right, `${i + 1}R`, m.id)]
        : [pt(m.position, `${i + 1}`, m.id)]
    }),
  }
}

/** Forward or reverse isochrones as lines, one feature per curve. */
/** The isochrones, every `everyMin` minutes of the route (the first in each), or every step at 0. */
export function isochroneFC(isochrones: Isochrone[], everyMin = 0): FC {
  let shown = isochrones
  if (everyMin > 0 && isochrones.length) {
    const t0 = isochrones[0].t
    const every = everyMin * 60_000
    let lastBucket = -1
    shown = isochrones.filter((iso) => {
      const b = Math.floor((iso.t - t0 + 1000) / every)
      if (b === lastBucket) return false
      lastBucket = b
      return true
    })
  }
  return {
    type: 'FeatureCollection',
    features: shown.map((iso) => ({
      type: 'Feature' as const,
      properties: { t: iso.t },
      geometry: {
        type: 'LineString' as const,
        coordinates: iso.points.map((p) => [p.lon, p.lat] as [number, number]),
      },
    })),
  }
}

/** The explored tree as one multi-line: a feature per segment would be tens of thousands. */
export function exploredFC(flat: Float32Array | undefined): FC {
  if (!flat || flat.length < 4) return emptyFC()
  const lines: Array<Array<[number, number]>> = []
  for (let i = 0; i + 3 < flat.length; i += 4) {
    lines.push([
      [flat[i + 1], flat[i]],
      [flat[i + 3], flat[i + 2]],
    ])
  }
  return {
    type: 'FeatureCollection',
    features: [{ type: 'Feature', properties: {}, geometry: { type: 'MultiLineString', coordinates: lines } }],
  }
}

/** Kept routes as lines, the newest marked as the previous one. */
export function keptFC(kept: ReadonlyArray<{ id: string; track: Array<{ lat: number; lon: number }> }>): FC {
  return {
    type: 'FeatureCollection',
    features: kept
      .filter((k) => k.track.length > 1)
      .map((k, i) => ({
        type: 'Feature' as const,
        properties: { id: k.id, previous: i === 0 },
        geometry: { type: 'LineString' as const, coordinates: k.track.map((p) => [p.lon, p.lat]) },
      })),
  }
}

function setSource(map: maplibregl.Map, id: string, data: FC) {
  const src = map.getSource(id) as maplibregl.GeoJSONSource | undefined
  if (src) src.setData(data)
}

function addEmptyLayers(map: maplibregl.Map) {
  const add = (id: string) => map.addSource(id, { type: 'geojson', data: emptyFC() })
  // ENC cells first, so everything else draws over the chart.
  add('enc')
  map.addLayer({ id: 'enc-area', type: 'fill', source: 'enc', filter: ['==', ['get', 'layer'], 'area'], paint: { 'fill-color': ['get', 'color'] as never, 'fill-opacity': 0.85 } })
  map.addLayer({ id: 'enc-line', type: 'line', source: 'enc', filter: ['==', ['get', 'layer'], 'line'], paint: { 'line-color': ['get', 'color'] as never, 'line-width': ['get', 'width'] as never } })
  map.addLayer({ id: 'enc-bounds', type: 'line', source: 'enc', filter: ['==', ['get', 'layer'], 'bounds'], paint: { 'line-color': '#7f9bb3', 'line-width': 1, 'line-dasharray': [3, 3], 'line-opacity': 0.6 } })
  map.addLayer({
    id: 'enc-symbol',
    type: 'symbol',
    source: 'enc',
    filter: ['all', ['==', ['get', 'layer'], 'point'], ['has', 'icon']],
    layout: { 'icon-image': ['get', 'icon'] as never, 'icon-allow-overlap': true, 'icon-ignore-placement': true },
  })
  map.addLayer({ id: 'enc-point', type: 'circle', source: 'enc', filter: ['all', ['==', ['get', 'layer'], 'point'], ['!', ['has', 'icon']]], paint: { 'circle-color': ['get', 'color'] as never, 'circle-radius': ['get', 'radius'] as never, 'circle-stroke-color': '#04101c', 'circle-stroke-width': 1 } })
  map.addLayer({ id: 'enc-sector-arc', type: 'line', source: 'enc', filter: ['all', ['==', ['get', 'layer'], 'sector'], ['==', ['get', 'part'], 'arc']], paint: { 'line-color': ['get', 'color'] as never, 'line-width': 3, 'line-opacity': 0.85 } })
  map.addLayer({ id: 'enc-sector-leg', type: 'line', source: 'enc', filter: ['all', ['==', ['get', 'layer'], 'sector'], ['==', ['get', 'part'], 'leg']], paint: { 'line-color': ['get', 'color'] as never, 'line-width': 1, 'line-dasharray': [4, 3] } })
  map.addLayer({
    id: 'enc-text',
    type: 'symbol',
    source: 'enc',
    filter: ['==', ['get', 'layer'], 'text'],
    layout: { 'text-field': ['get', 'label'] as never, 'text-size': 10, 'text-offset': [0.8, -0.6], 'text-anchor': 'left', 'text-optional': true },
    paint: { 'text-color': ['case', ['==', ['get', 'group'], 'light'], '#f8bbd0', '#cfd8dc'] as never, 'text-halo-color': '#04101c', 'text-halo-width': 1.2 },
  })
  map.addLayer({
    id: 'enc-sounding',
    type: 'symbol',
    source: 'enc',
    filter: ['==', ['get', 'layer'], 'sounding'],
    layout: { 'text-field': ['get', 'label'] as never, 'text-font': ['Open Sans Regular'], 'text-size': 10, 'text-allow-overlap': false },
    // Shallower than the safety depth stands out; deeper recedes, as S-52 has it.
    paint: { 'text-color': ['case', ['get', 'shallow'], '#ffffff', '#7f9bb3'] as never, 'text-halo-color': '#04101c', 'text-halo-width': 1 },
  })
  ;['laylines', 'notes', 'draft', 'sens', 'wind', 'explored', 'iso', 'riso', 'kept', 'ensemble', 'fleet', 'fleet-route', 'legs', 'route', 'route-beat', 'route-wind', 'marks', 'boat', 'start', 'measure', 'ais', 'route-hazards', 'route-step'].forEach(add)

  // Race notes under everything else. Keep-out areas are red, slow areas amber,
  // plain notes grey, so the colour says what the router will do with each.
  const noteColor: maplibregl.ExpressionSpecification = [
    'case',
    ['get', 'avoid'],
    '#ff4d4d',
    ['get', 'slow'],
    '#ffb020',
    '#8ba7c2',
  ]
  for (const src of ['notes', 'draft']) {
    map.addLayer({
      id: src + '-fill',
      type: 'fill',
      source: src,
      filter: ['==', ['geometry-type'], 'Polygon'],
      paint: { 'fill-color': noteColor, 'fill-opacity': 0.18 },
    })
    map.addLayer({
      id: src + '-line',
      type: 'line',
      source: src,
      filter: ['!=', ['geometry-type'], 'Point'],
      paint: { 'line-color': noteColor, 'line-width': 1.5 },
    })
    map.addLayer({
      id: src + '-pt',
      type: 'circle',
      source: src,
      filter: ['==', ['geometry-type'], 'Point'],
      paint: { 'circle-radius': 4, 'circle-color': noteColor },
    })
  }
  map.addLayer({
    id: 'layline-line',
    type: 'line',
    source: 'laylines',
    paint: {
      'line-color': ['match', ['get', 'side'], 'port', '#ff4d4d', '#35d07f'],
      'line-width': ['case', ['get', 'bound'], 1, 1.8],
      'line-opacity': ['case', ['get', 'bound'], 0.35, 0.85],
      'line-dasharray': [4, 2],
    },
  })
  map.addLayer({
    id: 'notes-label',
    type: 'symbol',
    source: 'notes',
    layout: { 'text-field': ['get', 'text'], 'text-size': 11, 'text-offset': [0, 1.2] },
    paint: { 'text-color': '#eaf2fa', 'text-halo-color': '#0a1a2a', 'text-halo-width': 1.4 },
  })

  map.addLayer({
    id: 'sens-fill',
    type: 'fill',
    source: 'sens',
    paint: { 'fill-color': '#ffd54a', 'fill-opacity': 0.16 },
  })
  map.addLayer({
    id: 'wind-arrows',
    type: 'symbol',
    source: 'wind',
    layout: {
      'text-field': '↑',
      'text-size': ['interpolate', ['linear'], ['get', 'kn'], 0, 11, 30, 24],
      'text-rotate': ['get', 'rot'],
      // Unset, this defaults to 'viewport' for a point symbol, which measures the
      // bearing from the top of the screen and is wrong on a rotated chart.
      // Pitch pinned so the glyph stays upright, matching the Weather arrows.
      'text-rotation-alignment': 'map',
      'text-pitch-alignment': 'viewport',
      'text-allow-overlap': true,
      'text-ignore-placement': true,
    },
    paint: {
      'text-color': [
        'interpolate',
        ['linear'],
        ['get', 'kn'],
        0,
        '#7fd4ff',
        12,
        '#4fc3f7',
        20,
        '#ffd54a',
        28,
        '#ff8a4a',
        35,
        '#ff4d4d',
      ],
      'text-opacity': 0.85,
    },
  })
  map.addLayer({
    id: 'iso-line',
    type: 'line',
    source: 'iso',
    paint: { 'line-color': '#4fc3f7', 'line-width': 1, 'line-opacity': 0.5 },
  })
  map.addLayer({
    id: 'riso-line',
    type: 'line',
    source: 'riso',
    paint: {
      'line-color': '#ffb74d',
      'line-width': 1,
      'line-opacity': 0.6,
      'line-dasharray': [3, 2],
    },
  })
  // Each ensemble member's route, faint, so their spread reads as a band.
  map.addLayer({
    id: 'ensemble-line',
    type: 'line',
    source: 'ensemble',
    paint: { 'line-color': '#b388ff', 'line-width': 1.2, 'line-opacity': 0.5 },
  })
  // Every path the search kept, faintest of all, when asked for.
  map.addLayer({
    id: 'explored-line',
    type: 'line',
    source: 'explored',
    paint: { 'line-color': '#6ea8d6', 'line-width': 0.6, 'line-opacity': 0.35 },
  })
  // Earlier routes under the current one: the previous dashed and bright, older faint.
  map.addLayer({
    id: 'kept-old-line',
    type: 'line',
    source: 'kept',
    filter: ['!', ['get', 'previous']],
    paint: { 'line-color': '#9fb3c8', 'line-width': 1.5, 'line-opacity': 0.45 },
  })
  map.addLayer({
    id: 'kept-prev-line',
    type: 'line',
    source: 'kept',
    filter: ['get', 'previous'],
    paint: { 'line-color': '#eaf2fa', 'line-width': 2.5, 'line-opacity': 0.85, 'line-dasharray': [2, 1.5] },
  })
  map.addLayer({
    id: 'route-line',
    type: 'line',
    source: 'route',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#ff3ea5', 'line-width': 3.5 },
  })
  map.addLayer({
    id: 'route-beat-line',
    type: 'line',
    source: 'route-beat',
    paint: { 'line-color': '#ff9ad2', 'line-width': 3.5, 'line-dasharray': [1.6, 1.4] },
  })
  // The wind at each leg, at the time the boat is there: a line downwind and the speed.
  map.addLayer({
    id: 'route-wind-line',
    type: 'line',
    source: 'route-wind',
    paint: { 'line-color': '#4fc3f7', 'line-width': 1.6, 'line-opacity': 0.85 },
  })
  map.addLayer({
    id: 'route-wind-label',
    type: 'symbol',
    source: 'route-wind',
    layout: { 'text-field': ['get', 'label'], 'text-size': 10, 'text-offset': [0, -0.9], 'symbol-placement': 'point' },
    paint: { 'text-color': '#4fc3f7', 'text-halo-color': '#0a1a2a', 'text-halo-width': 1.2 },
  })
  // The course's legs under the route: thin, the active one brighter, the boat's line to it dashed.
  map.addLayer({ id: 'legs-line', type: 'line', source: 'legs', filter: ['==', ['get', 'kind'], 'leg'], paint: { 'line-color': '#eaf2fa', 'line-width': ['case', ['get', 'active'], 1.8, 1] as never, 'line-opacity': ['case', ['get', 'active'], 0.75, 0.4] as never } })
  map.addLayer({ id: 'legs-current', type: 'line', source: 'legs', filter: ['==', ['get', 'kind'], 'current'], paint: { 'line-color': '#ffd54a', 'line-width': 1.6, 'line-dasharray': [4, 3], 'line-opacity': 0.9 } })
  map.addLayer({ id: 'legs-circle', type: 'line', source: 'legs', filter: ['==', ['get', 'kind'], 'circle'], paint: { 'line-color': '#ffd54a', 'line-width': 1, 'line-opacity': 0.6 } })
  map.addLayer({
    id: 'legs-label',
    type: 'symbol',
    source: 'legs',
    filter: ['==', ['get', 'kind'], 'leg-label'],
    layout: { 'text-field': ['get', 'label'] as never, 'text-size': 10, 'text-allow-overlap': true },
    paint: { 'text-color': '#cfd8dc', 'text-halo-color': '#0a1a2a', 'text-halo-width': 1.2 },
  })
  map.addLayer({
    id: 'marks-pt',
    type: 'circle',
    source: 'marks',
    paint: {
      'circle-radius': 7,
      'circle-color': '#ffd54a',
      'circle-stroke-color': '#0a1a2a',
      'circle-stroke-width': 2,
    },
  })
  map.addLayer({
    id: 'marks-label',
    type: 'symbol',
    source: 'marks',
    layout: { 'text-field': ['get', 'name'], 'text-size': 11, 'text-offset': [0, 1.4] },
    paint: { 'text-color': '#eaf2fa', 'text-halo-color': '#0a1a2a', 'text-halo-width': 1.4 },
  })
  map.addLayer({
    id: 'boat-pt',
    type: 'circle',
    source: 'boat',
    paint: {
      'circle-radius': 6,
      'circle-color': '#35d07f',
      'circle-stroke-color': '#eaf2fa',
      'circle-stroke-width': 2,
    },
  })
  map.addLayer({
    id: 'measure-line',
    type: 'line',
    source: 'measure',
    filter: ['==', ['geometry-type'], 'LineString'],
    paint: { 'line-color': '#eaf2fa', 'line-width': 1.5, 'line-dasharray': [2, 2] },
  })
  map.addLayer({
    id: 'measure-pt',
    type: 'circle',
    source: 'measure',
    filter: ['==', ['geometry-type'], 'Point'],
    paint: { 'circle-radius': 4, 'circle-color': '#eaf2fa' },
  })
  // The fleet's tracks, each in her own colour, with a dot at her last fix.
  map.addLayer({
    id: 'fleet-line',
    type: 'line',
    source: 'fleet',
    filter: ['==', ['geometry-type'], 'LineString'],
    paint: { 'line-color': ['get', 'color'] as never, 'line-width': 1.6, 'line-opacity': 0.85 },
  })
  map.addLayer({
    id: 'fleet-pt',
    type: 'circle',
    source: 'fleet',
    filter: ['==', ['geometry-type'], 'Point'],
    paint: { 'circle-radius': 4.5, 'circle-color': ['get', 'color'] as never, 'circle-stroke-color': '#04101c', 'circle-stroke-width': 1.2 },
  })
  // Each fleet boat's optimal route, dashed, in her colour.
  map.addLayer({
    id: 'fleet-route-line',
    type: 'line',
    source: 'fleet-route',
    paint: { 'line-color': ['get', 'color'] as never, 'line-width': 1.4, 'line-dasharray': [3, 2], 'line-opacity': 0.8 },
  })
  // Stepping through the route: the isochrone of the step, bright, and the boat then.
  map.addLayer({ id: 'route-step-iso', type: 'line', source: 'route-step', filter: ['==', ['get', 'kind'], 'iso'], paint: { 'line-color': '#ffd54a', 'line-width': 2.5, 'line-opacity': 0.9 } })
  map.addLayer({ id: 'route-step-pt', type: 'circle', source: 'route-step', filter: ['==', ['get', 'kind'], 'boat'], paint: { 'circle-radius': 6, 'circle-color': '#ffd54a', 'circle-stroke-color': '#04101c', 'circle-stroke-width': 2 } })
  // Where the route meets a hazard on the ENC: a red ring.
  map.addLayer({ id: 'route-hazards', type: 'circle', source: 'route-hazards', paint: { 'circle-radius': 9, 'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-color': '#ff5252', 'circle-stroke-width': 2.5 } })
  // AIS targets: a six-minute course vector, and a dot by class, red for a distress beacon.
  map.addLayer({
    id: 'ais-vector',
    type: 'line',
    source: 'ais',
    filter: ['==', ['get', 'kind'], 'vector'],
    paint: { 'line-color': ['get', 'color'] as never, 'line-width': 1.5 },
  })
  map.addLayer({ id: 'ais-trail', type: 'line', source: 'ais', filter: ['==', ['get', 'kind'], 'trail'], paint: { 'line-color': ['get', 'color'] as never, 'line-width': 1, 'line-opacity': 0.5, 'line-dasharray': [1, 2] } })
  map.addLayer({ id: 'ais-cpa', type: 'line', source: 'ais', filter: ['==', ['get', 'kind'], 'cpa'], paint: { 'line-color': ['get', 'color'] as never, 'line-width': 2, 'line-dasharray': [2, 1] } })
  map.addLayer({
    id: 'ais-label',
    type: 'symbol',
    source: 'ais',
    filter: ['any', ['==', ['get', 'kind'], 'target'], ['==', ['get', 'kind'], 'cpa']],
    layout: { 'text-field': ['get', 'name'] as never, 'text-size': 10, 'text-offset': [0, 1.2], 'text-optional': true },
    paint: { 'text-color': ['get', 'color'] as never, 'text-halo-color': '#04101c', 'text-halo-width': 1.2 },
  })
  map.addLayer({
    id: 'ais-pt',
    type: 'circle',
    source: 'ais',
    filter: ['==', ['get', 'kind'], 'target'],
    paint: {
      'circle-radius': ['case', ['get', 'alert'], 8, 5] as never,
      'circle-color': ['get', 'color'] as never,
      'circle-stroke-color': '#04101c',
      'circle-stroke-width': 1.5,
    },
  })
  // The planned start: hollow, so it never reads as the boat.
  map.addLayer({
    id: 'start-pt',
    type: 'circle',
    source: 'start',
    paint: {
      'circle-radius': 7,
      'circle-color': 'rgba(0,0,0,0)',
      'circle-stroke-color': '#35d07f',
      'circle-stroke-width': 3,
    },
  })
}

/**
 * Collect contiguous runs of beating legs into LineString coordinate arrays.
 *
 * `isBeating` on leg *i* means the segment FROM leg *i* TO leg *i + 1* is a
 * beat, so every beat run must include the *next* non-beating position as its
 * terminal endpoint.
 */
export function extractBeatSegments(
  legs: ReadonlyArray<{ position: { lon: number; lat: number }; isBeating: boolean }>,
): [number, number][][] {
  const segs: [number, number][][] = []
  let run: [number, number][] = []
  for (const l of legs) {
    if (l.isBeating) {
      run.push([l.position.lon, l.position.lat])
    } else {
      if (run.length > 0) {
        run.push([l.position.lon, l.position.lat])
        segs.push(run)
      }
      run = []
    }
  }
  if (run.length > 1) segs.push(run)
  return segs
}

/**
 * Thin the cube down to a readable arrow field, as the wind stands at `t`.
 *
 * Sampled through `sampleCube`, the same interpolation the router's `CubeField`
 * uses, so each arrow is the wind the route was computed against. A time the
 * cube does not cover draws no arrows rather than the nearest hour's.
 */
export function windFC(c: WeatherCube, t: Millis): FC {
  const features: GeoJSON.Feature[] = []
  if (!c.data.u10 || !c.data.v10) return emptyFC()
  const strideX = Math.max(1, Math.floor(c.nx / 18))
  const strideY = Math.max(1, Math.floor(c.ny / 18))
  for (let j = 0; j < c.ny; j += strideY) {
    for (let i = 0; i < c.nx; i += strideX) {
      const lon = c.bbox.west + i * c.dx
      const lat = c.bbox.south + j * c.dy
      const uu = sampleCube(c, 'u10', lat, lon, t)
      const vv = sampleCube(c, 'v10', lat, lon, t)
      if (uu === null || vv === null) continue
      const kn = Math.hypot(uu, vv)
      // Arrow glyph points "up"; rotate to the direction the wind blows TOWARD.
      const rot = (Math.atan2(uu, vv) * 180) / Math.PI
      features.push({
        type: 'Feature',
        properties: { kn: Math.round(kn * 10) / 10, rot },
        geometry: { type: 'Point', coordinates: [lon, lat] },
      })
    }
  }
  return { type: 'FeatureCollection', features }
}

/** Cells within `bandMin` minutes of optimal, as a coarse polygon soup. */
export function sensitivityFC(route: RouteResult, bandMin = 10): FC {
  const s = route.sensitivity
  if (!s) return emptyFC()
  const dx = lonSpan(s.bbox.west, s.bbox.east) / s.nx
  const dy = (s.bbox.north - s.bbox.south) / s.ny
  const features: GeoJSON.Feature[] = []
  for (let j = 0; j < s.ny; j++) {
    for (let i = 0; i < s.nx; i++) {
      const loss = s.loss[j * s.nx + i]
      if (!Number.isFinite(loss) || loss > bandMin) continue
      const x0 = wrap180(s.bbox.west + i * dx)
      const x1 = wrap180(s.bbox.west + (i + 1) * dx)
      const y0 = s.bbox.south + j * dy
      features.push({
        type: 'Feature',
        properties: { loss },
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [x0, y0],
              [x1, y0],
              [x1, y0 + dy],
              [x0, y0 + dy],
              [x0, y0],
            ],
          ],
        },
      })
    }
  }
  return { type: 'FeatureCollection', features }
}

/** Open S-57 cells, see what each holds, and set the safety depth they are drawn against. */
function EncSheet({ onClose, onShow }: { onClose: () => void; onShow: (b: EncBounds) => void }) {
  const cells = useCharts((s) => s.cells)
  const rasters = useCharts((s) => s.rasters)
  const [busy, setBusy] = useState<string | null>(null)
  const offset = useStore((s) => s.settings.chartOffset)
  const updateSettings = useStore((s) => s.updateSettings)
  const routeBySafety = useCharts((s) => s.routeBySafety)
  const install = async (input: HTMLInputElement) => {
    const files = [...(input.files ?? [])]
    input.value = ''
    if (!files.length) return
    setError(null)
    setBusy(`Installing ${files.length} file${files.length === 1 ? '' : 's'}…`)
    try {
      const got = await Promise.all(files.map(async (f) => ({ name: f.webkitRelativePath || f.name, bytes: new Uint8Array(await f.arrayBuffer()) })))
      const r = await installChartFiles(got)
      if (r.errors.length) setError(r.errors.join('; '))
      else if (!r.installed.length) setError('No chart cells there: a cell is a .000 file, with updates .001 on.')
    } finally {
      setBusy(null)
    }
  }
  const safety = useCharts((s) => s.safetyDepthM)
  const display = useCharts((s) => s.display)
  const setDisplay = useCharts((s) => s.setDisplay)
  const [error, setError] = useState<string | null>(null)
  return (
    <div className="sheet" role="dialog" aria-label="Electronic charts">
      <div className="sheet__grip" onClick={onClose} />
      <h2>Electronic charts</h2>
      <p className="note">S-57 ENC cells, such as NOAA's, drawn in a simplified S-52 style under the course. Not for navigation.</p>
      <div className="actions" style={{ background: 'none', border: 'none', padding: '0 0 8px' }}>
        <label className="btn btn--sm btn--ghost" style={{ cursor: 'pointer' }}>
          OPEN CELLS
          <input type="file" multiple aria-label="Chart cells to open" style={{ display: 'none' }} onChange={(e) => void install(e.target)} />
        </label>
        <label className="btn btn--sm btn--ghost" style={{ cursor: 'pointer' }}>
          OPEN FOLDER
          <input type="file" multiple aria-label="Chart folder to open" style={{ display: 'none' }} {...{ webkitdirectory: '' }} onChange={(e) => void install(e.target)} />
        </label>
        <label className="btn btn--sm btn--ghost" style={{ cursor: 'pointer' }}>
          OPEN RASTER
          <input
            type="file"
            multiple
            accept=".kap,.KAP"
            aria-label="Raster charts to open"
            style={{ display: 'none' }}
            onChange={async (e) => {
              const files = [...(e.target.files ?? [])]
              e.target.value = ''
              setError(null)
              for (const f of files) {
                setBusy(`Opening ${f.name}…`)
                try {
                  await openRasterFile(f.name, new Uint8Array(await f.arrayBuffer()), display.night ? 'NGT' : 'RGB')
                } catch (err) {
                  setError(`${f.name}: ${err instanceof Error ? err.message : String(err)}`)
                }
              }
              setBusy(null)
            }}
          />
        </label>
        {cells.length > 0 && (
          <button className="btn btn--sm btn--ghost" onClick={() => void uninstallAllCells()}>
            REMOVE ALL
          </button>
        )}
      </div>
      {busy && <p className="note">{busy}</p>}
      {error && <p className="warnbox">{error}</p>}
      <div className="field">
        <label htmlFor="enc-safety">
          Safety depth <span className="note">m, shallower is shaded and its soundings stand out</span>
        </label>
        <input
          id="enc-safety"
          type="number"
          min="0"
          step="0.5"
          value={safety}
          onChange={(e) => {
            const v = Number(e.target.value)
            if (v >= 0) useCharts.getState().setSafetyDepth(v)
          }}
        />
      </div>
      <div className="seg" role="group" aria-label="Display category" style={{ marginBottom: 6 }}>
        {(['base', 'standard', 'all'] as const).map((k) => (
          <button key={k} aria-pressed={display.category === k} onClick={() => setDisplay({ category: k })}>
            {k === 'base' ? 'Base' : k === 'standard' ? 'Standard' : 'All'}
          </button>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center', marginBottom: 8 }}>
        <label>
          <input type="checkbox" checked={display.twoShades} onChange={(e) => setDisplay({ twoShades: e.target.checked })} /> Two shades
        </label>
        {!display.twoShades && (
          <>
            <label>
              Shallow{' '}
              <input aria-label="Shallow contour" type="number" min="0" step="0.5" value={display.shallowM} onChange={(e) => setDisplay({ shallowM: Math.max(0, Number(e.target.value) || 0) })} style={{ width: 56 }} /> m
            </label>
            <label>
              Deep{' '}
              <input aria-label="Deep contour" type="number" min="0" step="1" value={display.deepM} onChange={(e) => setDisplay({ deepM: Math.max(0, Number(e.target.value) || 0) })} style={{ width: 56 }} /> m
            </label>
          </>
        )}
        <label>
          <input type="checkbox" checked={display.night} onChange={(e) => setDisplay({ night: e.target.checked })} /> Night palette
        </label>
      </div>
      <div role="group" aria-label="Lights and text" style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center', marginBottom: 8 }}>
        {(
          [
            ['lightText', 'Light descriptions'],
            ['sectors', 'Light sectors'],
            ['fullLegs', 'Sector legs to full range'],
            ['smallSectors', 'Small sectors'],
            ['names', 'Names'],
            ['largeText', 'Large text'],
            ['antiClutter', 'Hide detail for the scale'],
          ] as const
        ).map(([k, label]) => (
          <label key={k}>
            <input type="checkbox" checked={display[k]} onChange={(e) => setDisplay({ [k]: e.target.checked })} /> {label}
          </label>
        ))}
      </div>
      <label style={{ display: 'block', marginBottom: 8 }} title="The router keeps out of water shallower than the safety depth and 50 m clear of dangers shallower than it, on the cells open">
        <input type="checkbox" checked={routeBySafety} onChange={(e) => useCharts.getState().setRouteBySafety(e.target.checked)} /> Route by the safety depth
      </label>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center', marginBottom: 8 }} title="Where a chart is off against GPS, move it: the boat stays where GPS puts her. Moves the ENC and raster charts, not the base map.">
        <span>Chart offset</span>
        <label>
          N{' '}
          <input aria-label="Chart offset north" type="number" step="1" value={offset.northM} onChange={(e) => updateSettings({ chartOffset: { ...offset, northM: Number(e.target.value) || 0 } })} style={{ width: 64 }} /> m
        </label>
        <label>
          E{' '}
          <input aria-label="Chart offset east" type="number" step="1" value={offset.eastM} onChange={(e) => updateSettings({ chartOffset: { ...offset, eastM: Number(e.target.value) || 0 } })} style={{ width: 64 }} /> m
        </label>
        {(offset.northM !== 0 || offset.eastM !== 0) && (
          <button className="btn btn--sm btn--ghost" onClick={() => updateSettings({ chartOffset: { northM: 0, eastM: 0 } })}>
            RESET
          </button>
        )}
      </div>
      {cells.length > 0 && (
        <table className="targets" aria-label="Installed cells" style={{ width: '100%' }}>
          <thead>
            <tr>
              <th style={{ textAlign: 'left' }}>Cell</th>
              <th>Edition</th>
              <th>Scale</th>
              <th>Objects</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {[...cells]
              .sort((a, b) => cellKey(a.name).localeCompare(cellKey(b.name)))
              .map((c) => (
                <tr key={c.name} aria-label={`Cell ${cellKey(c.name)}`}>
                  <td title={c.warnings.join('\n') || undefined}>
                    {cellKey(c.name)}
                    {c.warnings.length > 0 && <span className="note"> ⚠ {c.warnings.length}</span>}
                  </td>
                  <td style={{ textAlign: 'center' }}>
                    {c.edition}
                    {Number(c.update) > 0 ? `.${c.update}` : ''}
                  </td>
                  <td style={{ textAlign: 'center' }}>{c.scale ? `1:${c.scale.toLocaleString('en-US')}` : '—'}</td>
                  <td style={{ textAlign: 'center' }}>{c.features.length}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <button className="btn btn--sm btn--ghost" disabled={!c.bounds} onClick={() => c.bounds && onShow(c.bounds)} aria-label={`Show ${cellKey(c.name)}`}>
                      SHOW
                    </button>
                    <button className="btn btn--sm btn--ghost" onClick={() => void uninstallCell(c.name)} aria-label={`Remove ${cellKey(c.name)}`}>
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      )}
      {rasters.map((r) => (
        <div key={r.id} className="note" aria-label={`Raster ${r.name}`} style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <label>
            <input type="checkbox" checked={r.on} onChange={(e) => useCharts.getState().updateRaster(r.id, { on: e.target.checked })} /> <b>{r.name}</b>
          </label>
          <span>
            {r.number && `${r.number} · `}
            {r.scale ? `1:${r.scale.toLocaleString('en-US')}` : ''}
            {r.warnings.length > 0 && ` · ⚠ ${r.warnings.join('; ')}`}
          </span>
          <button className="btn btn--sm btn--ghost" onClick={() => useCharts.getState().removeRaster(r.id)} aria-label={`Remove ${r.name}`}>
            ✕
          </button>
        </div>
      ))}
      <p className="note">Open base cells (.000) with their updates (.001 on), a folder of them, or NOAA's zipped cells. They stay installed; open a cell's new updates to bring it up to date.</p>
      <button className="btn btn--sm" onClick={onClose}>
        Done
      </button>
    </div>
  )
}

/** The fleet's optimal routes: who gets there first, and by how much against us. */
function FleetRoutesSheet({ rows, skipped, onClose }: { rows: FleetRouteRow[]; skipped: Array<{ name: string; why: string }>; onClose: () => void }) {
  const signed = (s: number) => `${s < 0 ? '−' : '+'}${fmtDuration(Math.abs(s))}`
  return (
    <div className="sheet" role="dialog" aria-label="Fleet routes">
      <div className="sheet__grip" onClick={onClose} />
      <h2>Fleet routes</h2>
      {rows.length === 0 ? (
        <p className="note">No boat could be routed: each needs a polar (Race → Boats) and a position from tracking or AIS.</p>
      ) : (
        <table className="targets" aria-label="Fleet arrivals" style={{ width: '100%' }}>
          <thead>
            <tr>
              <th style={{ textAlign: 'left' }}>Boat</th>
              <th>Arrives</th>
              <th>Sailing</th>
              <th>Against us</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.boatId}>
                <td style={{ color: r.colour }}>{r.name}</td>
                <td style={{ textAlign: 'center' }}>{r.ok && r.etaMs != null ? new Date(r.etaMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—'}</td>
                <td style={{ textAlign: 'center' }}>{r.ok && r.elapsedS != null ? fmtDuration(r.elapsedS) : r.error ?? 'failed'}</td>
                <td style={{ textAlign: 'center' }}>{r.vsUsS != null ? signed(r.vsUsS) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {skipped.length > 0 && (
        <p className="note" aria-label="Not routed">
          Not routed: {skipped.map((s) => `${s.name} (${s.why})`).join(', ')}
        </p>
      )}
      <p className="note">Each boat from where she is now, with her own polar, to the rest of the course, in the same weather as us. Against us needs our own route.</p>
      <button className="btn btn--sm" onClick={onClose}>
        Done
      </button>
    </div>
  )
}
