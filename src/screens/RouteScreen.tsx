/**
 * Route screen — chart, wind, and the isochrone router.
 *
 * The headline is not the magenta line: it is the confidence band around it
 * (docs/03-algorithms/routing-isochrone.md §8). A beginner's failure mode is
 * treating the route as truth, so the sensitivity envelope is shown by default.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { RouteMeteogram } from '@/components/RouteMeteogram'
import { turningPoints, windAlongRouteFC } from '@/lib/routing/results'
import { sailAt } from '@/lib/sailchart'
import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import { NOTE_MIN_POINTS, useStore, type RaceNote } from '@/state/store'
import { cubeNotes, fetchWindCube } from '@/lib/weather/openmeteo'
import { sampleCube } from '@/lib/weather/cube'
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
import { bboxOf, distance, lonSpan } from '@/lib/geo'
import { fmtDeg, wrap180 } from '@/lib/angles'
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
      // A plain tap reads out that point: the only pointer a phone has.
      if (!mode) {
        setPointer(at)
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
  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return
    setSource(map, 'boat', state ? pointFC(state.position.lon, state.position.lat) : emptyFC())
    setSource(map, 'marks', marksFC(course.marks))
  }, [ready, state, course.marks])

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
  }, [origin, course.marks, setRouteError])

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
      const marks = marksOverride ?? course.marks.map((m) => m.position)
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

  const landPayload = useCallback(
    () =>
      landPack
        ? {
            bbox: landPack.meta.bbox,
            nx: landPack.meta.nx,
            ny: landPack.meta.ny,
            bits: landPack.bits,
          }
        : undefined,
    [landPack],
  )

  /** Route the course, or, given marks, those instead: to or via the pointer. */
  const run = useCallback(async (leaveAt?: Millis, marksOverride?: LatLon[]) => {
    if (!origin || !polar || (marksOverride?.length ?? course.marks.length) === 0) return
    const thisRun = ++runIdRef.current
    let workingCube = cube
    if (!workingCube) {
      workingCube = await loadWeather()
    }
    if (thisRun !== runIdRef.current) return
    if (!workingCube) {
      setRouteError('No forecast loaded — tap Forecast first.')
      return
    }
    setBusy('Routing…')
    setProgress(0)
    setRouteError(null)
    try {
      clientRef.current ??= new RoutingClient()
      const startTime = leaveAt ?? Date.now()
      const req = buildRequest(startTime, true, marksOverride)
      if (!req) return
      const result = await clientRef.current.route(
        req,
        { cube: workingCube, polar, polarPort, landRaster: landPayload() },
        (f) => { if (thisRun === runIdRef.current) setProgress(f) },
      )
      if (thisRun !== runIdRef.current) return
      // Follow what the kernel actually did, not what this side hoped it would.
      // The two disagree when the pack loads here but the worker rejects it as
      // corrupt, and that disagreement used to resolve in favour of the
      // reassuring message — telling a sailor land was avoided on a route that
      // was never checked against it.
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
    let workingCube = cube
    if (!workingCube) workingCube = await loadWeather()
    if (!workingCube) {
      setRouteError('No forecast loaded — tap Forecast first.')
      return
    }

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
        { cube: workingCube, polar, polarPort, landRaster: landPayload() },
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
      <div className="chart-area">
        <div ref={containerRef} className="map" />

        <div className="canvas-overlay">
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <span className={`chip ${cube ? 'chip--good' : ''}`}>
              <span className="dot" />
              {cube ? `${cube.model} · ${cube.nt}h` : 'no forecast'}
            </span>
            <span className="chip">{PILOT_VENUE.name}</span>
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
            </span>
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
        />
      )}

      {showSettings && <RouteSettingsSheet onClose={() => setShowSettings(false)} />}
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
}: {
  route: RouteResult
  depth: DepthAdvisory | null
  levels: WaterLevelPrediction | null
  onClose: () => void
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
  ;['laylines', 'notes', 'draft', 'sens', 'wind', 'explored', 'iso', 'riso', 'kept', 'route', 'route-beat', 'route-wind', 'marks', 'boat', 'start', 'measure'].forEach(add)

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
