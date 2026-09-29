/**
 * Weather overlay — the data-layer viewer.
 *
 * Structurally this is the PredictWind equivalent, built from the pieces in
 * `src/lib/maplayers`: a basemap, one primary data layer, three render modes for
 * vector fields (streamlines / barbs / arrows), a time axis, model selection, and
 * a legend that always states its provenance.
 *
 * The map, the forecast cube and the clock are not owned here — they belong to
 * `ChartSurface`, which Start, Race and Route will share
 * (docs/05-spec/start-on-chart.md §2). What is owned here is a *reading* of that
 * chart: which field, which symbols, which legend, which caveats.
 *
 * See docs/07-map-layers/competitor-teardown.md for what we are matching and,
 * more importantly, what we are deliberately not chasing: PredictWind's 1 km
 * PWG/PWE runs are compute, not code, and no amount of front-end work replaces
 * them. What we can match is the rendering and the honesty.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import type maplibregl from 'maplibre-gl'
import {
  BOAT_LAYER_ID,
  ChartSurface,
  emptyFC,
  setVisible,
  useChart,
} from '@/components/ChartSurface'
import { PILOT_VENUE } from '@/data/venues'
import {
  DEPTH_NOT_FOR_NAVIGATION,
  PORTLAND_MSL_ABOVE_MLLW_M,
  depthAt,
  depthRenderCube,
  loadVenueDepthGrid,
  waterFractionOf,
  type LoadedDepthGrid,
} from '@/data/bathymetry'
import { MODELS, cubeNotes, type ModelId } from '@/lib/weather/openmeteo'
import { sampleCube } from '@/lib/weather/cube'
import {
  LAYERS,
  layerById,
  layersFor,
  COLOUR_MODES,
  modesFor,
  rampForMode,
  rampToLUT,
  type ColourMode,
  rampToMapLibreExpression,
} from '@/lib/maplayers/colormap'
import {
  PROP_FROM,
  PROP_MAGNITUDE,
  PROP_TOWARD,
  thinVectorField,
  vectorSamplesToFC,
} from '@/lib/maplayers/vectorSymbols'
import { barbImageExpression } from '@/lib/maplayers/barbs'
import { Legend } from '@/components/Legend'
import { CurrentChart } from '@/components/CurrentChart'
import {
  fetchCurrentPrediction,
  flowAt,
  nextSlack,
  type CurrentPrediction,
} from '@/lib/tides/coops'
import { uvToWind } from '@/lib/wind'
import { fmtDeg } from '@/lib/angles'
import type { LayerSpec, VectorMode } from '@/lib/maplayers/types'
import type { WeatherCube } from '@/lib/types'
import { useStore } from '@/state/store'
import { fmtLength } from '@/lib/units'
import { WeatherFilesSheet } from '@/components/WeatherFiles'
import { PointMeteogram } from '@/components/PointMeteogram'
import { ObservationsSheet, type ObsStation } from '@/components/ObservationsSheet'
import { fetchCoopsObservations, type Observation } from '@/lib/weather/observations'
import { RADAR_INDEX, SAT_TILES, latestRadar } from '@/lib/weather/overlays'
import { useEnsembleView } from '@/state/ensembleView'
import { contourFeatures, type ContourField } from '@/lib/maplayers/contours'
import { DEFAULT_CONTOURS, type ContourKind } from '@/state/store'
import { useWeatherFiles } from '@/state/weatherFiles'

/** The venue's observing stations: NOS stations answer a browser, buoys wait for the proxy. */
const OBS_STATIONS: ObsStation[] = [
  ...PILOT_VENUE.tideStations.map((s) => ({ ...s, kind: 'coops' as const })),
  ...PILOT_VENUE.observationStations.map((s) => ({ ...s, kind: 'ndbc' as const })),
]

/** The contours the Weather chart can draw, and what each needs in the forecast. */
const CONTOURS: Array<{ id: ContourKind; label: string; field: ContourField; needs: string[]; unit: string; decimals: number }> = [
  { id: 'isobar', label: 'Isobars', field: { param: 'prmsl' }, needs: ['prmsl'], unit: 'hPa', decimals: 0 },
  { id: 'isotach', label: 'Isotachs', field: { speedOf: ['u10', 'v10'] }, needs: ['u10', 'v10'], unit: 'kn', decimals: 0 },
  { id: 'rain', label: 'Rain lines', field: { param: 'rain' }, needs: ['rain'], unit: 'mm/h', decimals: 1 },
]

/** Readout rows for the parameters only some forecasts have. */
const EXTRA_READOUT = [
  { param: 'hs', label: 'waves', unit: ' m', dp: 1 },
  { param: 'sst', label: 'sea', unit: ' °C', dp: 1 },
  { param: 't2m', label: 'air', unit: ' °C', dp: 1 },
  { param: 'rain', label: 'rain', unit: ' mm/h', dp: 1 },
]

const MODES: Array<{ id: VectorMode; label: string }> = [
  { id: 'particles', label: 'Streamlines' },
  { id: 'barbs', label: 'Barbs' },
  { id: 'arrows', label: 'Arrows' },
]

/**
 * Layers and sources this overlay adds to the shared map.
 *
 * Listed so unmount can take them back off again. Layers first: MapLibre refuses
 * to remove a source that a layer still references.
 */
const OWNED_LAYERS = [
  'wx-sat',
  'wx-radar',
  'wx-obs-pt',
  'wx-obs-label',
  'wx-contour-line',
  'wx-contour-label',
  'wx-barbs',
  'wx-arrows',
  'wx-speed-labels',
  'wx-station-pt',
  'wx-station-label',
]
const OWNED_SOURCES = ['wx-symbols', 'wx-station', 'wx-contours', 'wx-obs', 'wx-sat', 'wx-radar']

export function WeatherScreen() {
  return (
    <ChartSurface>
      <WeatherOverlay />
    </ChartSurface>
  )
}

function WeatherOverlay() {
  const { map, ready, scalar, particles, cube, fileName, model, setModel, modelLabel, busy, error, t } =
    useChart()
  const fileCount = useWeatherFiles((s) => s.files.length)
  const [showFiles, setShowFiles] = useState(false)
  const units = useStore((s) => s.settings.units)

  const [layerId, setLayerId] = useState<string>('wind')
  const [mode, setMode] = useState<VectorMode>('particles')
  const [windOverlay, setWindOverlay] = useState(true)
  const [probe, setProbe] = useState<{ lat: number; lon: number } | null>(null)
  const [tide, setTide] = useState<CurrentPrediction | null>(null)
  const [tideError, setTideError] = useState<string | null>(null)
  const [showChart, setShowChart] = useState(true)
  const [depthGrid, setDepthGrid] = useState<LoadedDepthGrid | null>(null)
  const [depthError, setDepthError] = useState<string | null>(null)

  const [moreLayers, setMoreLayers] = useState(false)
  const [meteo, setMeteo] = useState<'point' | 'boat' | null>(null)
  const [obsOn, setObsOn] = useState(false)
  const [radarOn, setRadarOn] = useState(false)
  const ens = useEnsembleView()
  const [satOn, setSatOn] = useState(false)
  const [radar, setRadar] = useState<{ tiles: string; time: number } | null>(null)
  const [radarError, setRadarError] = useState<string | null>(null)
  const [showObsSheet, setShowObsSheet] = useState(false)
  const [obs, setObs] = useState<Record<string, Observation[]>>({})
  const [obsErrors, setObsErrors] = useState<Record<string, string>>({})
  const boatNow = useStore((s) => s.state)
  const [showContourSheet, setShowContourSheet] = useState(false)
  const contourSettings = useStore((s) => s.settings.contours) ?? DEFAULT_CONTOURS
  const updateSettings = useStore((s) => s.updateSettings)
  const contourChoices = useMemo(() => CONTOURS.filter((c) => c.needs.every((p) => cube?.params.includes(p))), [cube])
  // From the store as it is now, not as this render saw it, so two quick taps both count.
  const setContour = (id: ContourKind, patch: Partial<(typeof DEFAULT_CONTOURS)[ContourKind]>) => {
    const cur = useStore.getState().settings.contours ?? DEFAULT_CONTOURS
    updateSettings({ contours: { ...cur, [id]: { ...(cur[id] ?? DEFAULT_CONTOURS[id]), ...patch } } })
  }
  const available = useMemo(() => layersFor(cube?.params, moreLayers), [cube, moreLayers])
  // A layer whose parameter the forecast on the chart no longer has falls back to wind.
  const layer: LayerSpec = (available.includes(layerId) ? layerById(layerId) : undefined) ?? LAYERS.wind
  const displayModes = useStore((s) => s.settings.displayModes) ?? {}
  const shown = displayModes[layer.id]
  const ramp = useMemo(() => rampForMode(layer, shown?.mode, shown?.colour), [layer, shown])
  const windShown = displayModes.wind
  const setDisplayMode = (patch: Partial<{ mode: ColourMode; colour: string }>) => {
    const cur = useStore.getState().settings.displayModes ?? {}
    const was = cur[layer.id] ?? { mode: 'default' as ColourMode, colour: '#ffd54f' }
    updateSettings({ displayModes: { ...cur, [layer.id]: { ...was, ...patch } } })
  }
  const isVector = layer.kind === 'vector'
  const isDepth = layer.id === 'depth'
  /** Wind streamlines can sit on top of any scalar field, which is the useful combo. */
  const showParticles = (isVector && mode === 'particles') || (!isVector && windOverlay)
  // Memoised: a fresh array literal every render would re-upload the field to the
  // GPU on every render rather than when the field actually changes.
  const particleParams = useMemo<[string, string]>(
    () => (isVector ? (layer.params as [string, string]) : ['u10', 'v10']),
    [isVector, layer],
  )

  /*
   * Depth comes from a static venue asset, not the forecast, so the scalar
   * renderer is fed from whichever of the two the open layer belongs to.
   */
  const depthCube = useMemo(() => (depthGrid ? depthRenderCube(depthGrid) : null), [depthGrid])
  const scalarCube = isDepth ? depthCube : cube

  // -------------------------------------------------------- own map resources
  useEffect(() => {
    if (!map || !ready) return

    // Contours under everything else of ours: a line with its level along it, the bold level heavier.
    map.addSource('wx-contours', { type: 'geojson', data: emptyFC() })
    map.addLayer(
      {
        id: 'wx-contour-line',
        type: 'line',
        source: 'wx-contours',
        paint: {
          'line-color': ['match', ['get', 'field'], 'isotach', '#9fe3c4', 'rain', '#7fd4ff', '#f2f2f2'] as never,
          'line-width': ['case', ['get', 'bold'], ['*', ['get', 'width'], 2], ['get', 'width']] as never,
          'line-opacity': 0.85,
        },
      },
      BOAT_LAYER_ID,
    )
    map.addLayer(
      {
        id: 'wx-contour-label',
        type: 'symbol',
        source: 'wx-contours',
        layout: {
          'symbol-placement': 'line',
          'text-field': ['get', 'label'] as never,
          'text-font': ['Open Sans Regular'],
          'text-size': 11,
          'symbol-spacing': 220,
        },
        paint: { 'text-color': '#eaf2fa', 'text-halo-color': '#04101c', 'text-halo-width': 1.4 },
      },
      BOAT_LAYER_ID,
    )

    // Observing stations with their latest wind.
    map.addSource('wx-obs', { type: 'geojson', data: emptyFC() })
    map.addLayer(
      {
        id: 'wx-obs-pt',
        type: 'circle',
        source: 'wx-obs',
        paint: { 'circle-radius': 5, 'circle-color': '#ffd54f', 'circle-stroke-color': '#04101c', 'circle-stroke-width': 1.5 },
      },
      BOAT_LAYER_ID,
    )
    map.addLayer(
      {
        id: 'wx-obs-label',
        type: 'symbol',
        source: 'wx-obs',
        layout: {
          'text-field': ['get', 'label'] as never,
          'text-font': ['Open Sans Regular'],
          'text-size': 11,
          'text-offset': [0, 1.2],
          'text-anchor': 'top',
        },
        paint: { 'text-color': '#ffe9a8', 'text-halo-color': '#04101c', 'text-halo-width': 1.4 },
      },
      BOAT_LAYER_ID,
    )

    map.addSource('wx-symbols', { type: 'geojson', data: emptyFC() })
    map.addLayer(
      {
        id: 'wx-barbs',
        type: 'symbol',
        source: 'wx-symbols',
        layout: {
          'icon-image': barbImageExpression(PROP_MAGNITUDE) as never,
          'icon-rotate': ['get', PROP_FROM],
          // `icon-rotate` is a compass bearing, and only 'map' keeps it one once
          // the chart is rotated: under 'viewport' it is measured from the top of
          // the screen, so every barb is wrong by the map bearing and still looks
          // plausible. Pitch stays 'viewport' so a barb stands upright when tilted
          // (barbs.ts, render-architecture.md §4).
          'icon-rotation-alignment': 'map',
          'icon-pitch-alignment': 'viewport',
          'icon-allow-overlap': true,
          'icon-ignore-placement': true,
          'icon-size': 0.9,
          visibility: 'none',
        },
      },
      BOAT_LAYER_ID,
    )
    map.addLayer(
      {
        id: 'wx-arrows',
        type: 'symbol',
        source: 'wx-symbols',
        layout: {
          'text-field': '➤',
          'text-font': ['Open Sans Regular'],
          'text-size': ['interpolate', ['linear'], ['get', PROP_MAGNITUDE], 0, 11, 40, 26],
          // Arrow glyph points right at rotate 0, so aim it where the flow GOES.
          'text-rotate': ['-', ['get', PROP_TOWARD], 90],
          // A bearing, so aligned to the map for the same reason as the barbs.
          // Pitch is pinned to 'viewport' because it would otherwise follow the
          // rotation alignment and lay the glyph flat on a tilted chart.
          'text-rotation-alignment': 'map',
          'text-pitch-alignment': 'viewport',
          'text-allow-overlap': true,
          'text-ignore-placement': true,
          visibility: 'none',
        },
        paint: { 'text-halo-color': '#04101c', 'text-halo-width': 1 },
      },
      BOAT_LAYER_ID,
    )
    /*
     * Numeric speed beside each arrow — Expedition's "tidal stream labels"
     * (docs/01-expedition-analysis/feature-inventory.md §5). A 0.4 kn set is a
     * tactical fact you act on, and no arrow length conveys it precisely enough.
     *
     * Shares the `wx-symbols` source, so it inherits the thinning already done by
     * `thinVectorField` and costs no extra sampling. Unlike the arrows this layer
     * does NOT allow overlap: MapLibre then drops colliding labels by itself, so
     * a dense grid stays readable instead of turning into a smear of digits.
     */
    map.addLayer(
      {
        id: 'wx-speed-labels',
        type: 'symbol',
        source: 'wx-symbols',
        layout: {
          'text-field': ['number-format', ['get', PROP_MAGNITUDE], {
            'min-fraction-digits': 1,
            'max-fraction-digits': 1,
          }] as never,
          'text-font': ['Open Sans Regular'],
          'text-size': 11,
          'text-offset': [0, 1.3],
          'text-anchor': 'top',
          'text-rotation-alignment': 'viewport',
          'text-allow-overlap': false,
          'text-optional': true,
          visibility: 'none',
        },
        paint: {
          'text-color': '#eaf2fa',
          'text-halo-color': '#04101c',
          'text-halo-width': 1.4,
        },
      },
      BOAT_LAYER_ID,
    )

    // NOAA station: drawn as a distinct diamond-ish marker so it reads as a
    // different kind of thing from the model arrows around it.
    map.addSource('wx-station', { type: 'geojson', data: emptyFC() })
    map.addLayer(
      {
        id: 'wx-station-pt',
        type: 'circle',
        source: 'wx-station',
        paint: {
          'circle-radius': 6,
          'circle-color': '#ffd54a',
          'circle-stroke-color': '#04101c',
          'circle-stroke-width': 2,
        },
      },
      BOAT_LAYER_ID,
    )
    map.addLayer(
      {
        id: 'wx-station-label',
        type: 'symbol',
        source: 'wx-station',
        layout: {
          'text-field': ['get', 'label'],
          'text-font': ['Open Sans Regular'],
          'text-size': 11,
          'text-offset': [0, -1.4],
          'text-anchor': 'bottom',
          'text-allow-overlap': true,
        },
        paint: {
          'text-color': '#ffd54a',
          'text-halo-color': '#04101c',
          'text-halo-width': 1.6,
        },
      },
      BOAT_LAYER_ID,
    )

    return () => {
      /*
       * The surface may have torn the map down first, in which case every one of
       * these throws and there is nothing left to clean up. Removing what we
       * added matters in the other case: this overlay unmounting while the map
       * survives, which is what a tab switch becomes once Start and Race are
       * overlays too.
       */
      try {
        for (const id of OWNED_LAYERS) if (map.getLayer(id)) map.removeLayer(id)
        for (const id of OWNED_SOURCES) if (map.getSource(id)) map.removeSource(id)
      } catch {
        /* the map went away first */
      }
    }
  }, [map, ready])

  // Probe on tap. Which overlay is mounted decides what a tap means, so this is
  // registered here rather than on the surface.
  useEffect(() => {
    if (!map) return
    const handler = (e: maplibregl.MapMouseEvent) =>
      setProbe({ lat: e.lngLat.lat, lon: e.lngLat.lng })
    map.on('click', handler)
    return () => {
      map.off('click', handler)
    }
  }, [map])

  /*
   * Venue bathymetry, once per session. 49 kB, and small enough to fetch
   * eagerly rather than on first tap of the chip.
   *
   * Cross-checked against its own metadata before it is trusted, exactly as the
   * Route screen does with the land pack: a payload that decodes but disagrees
   * about how much of the box is water is a payload we have misread.
   */
  useEffect(() => {
    let cancelled = false
    loadVenueDepthGrid()
      .then((g) => {
        if (cancelled) return
        const frac = waterFractionOf(g.elevDm)
        if (Math.abs(frac - g.meta.waterFraction) > 0.01) {
          throw new Error(
            `depth grid is ${(frac * 100).toFixed(1)}% water, expected ${(
              g.meta.waterFraction * 100
            ).toFixed(1)}%`,
          )
        }
        setDepthGrid(g)
        setDepthError(null)
      })
      .catch((e) => {
        if (!cancelled) setDepthError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      cancelled = true
    }
  }, [])

  // The radar index, when radar is on, and every ten minutes after: frames come every ten.
  useEffect(() => {
    if (!radarOn) return
    let cancelled = false
    const load = () =>
      fetch(RADAR_INDEX)
        .then((r) => r.json())
        .then((j) => {
          if (cancelled) return
          const got = latestRadar(j)
          setRadar(got)
          setRadarError(got ? null : 'Radar index had no frames')
        })
        .catch((e) => !cancelled && setRadarError(`Radar unavailable: ${e instanceof Error ? e.message : String(e)}`))
    void load()
    const id = window.setInterval(load, 10 * 60_000)
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [radarOn])

  // Satellite and radar as raster layers under the contours and symbols.
  useEffect(() => {
    if (!map || !ready) return
    const put = (id: string, tiles: string | null, attribution: string, opacity: number) => {
      if (map.getLayer(id)) map.removeLayer(id)
      if (map.getSource(id)) map.removeSource(id)
      if (!tiles) return
      map.addSource(id, { type: 'raster', tiles: [tiles], tileSize: 256, maxzoom: 7, attribution })
      map.addLayer({ id, type: 'raster', source: id, paint: { 'raster-opacity': opacity } }, 'wx-contour-line')
    }
    put('wx-sat', satOn ? SAT_TILES : null, 'Satellite: NASA GIBS / NOAA GOES-East', 0.85)
    put('wx-radar', radarOn && radar ? radar.tiles : null, 'Radar: RainViewer', 0.75)
  }, [map, ready, satOn, radarOn, radar])

  // Observations: fetched when switched on, and every ten minutes after.
  useEffect(() => {
    if (!obsOn) return
    let cancelled = false
    const load = () => {
      for (const s of OBS_STATIONS) {
        if (s.kind !== 'coops') continue
        fetchCoopsObservations(s.id)
          .then((o) => !cancelled && setObs((m) => ({ ...m, [s.id]: o })))
          .catch((e) => !cancelled && setObsErrors((m) => ({ ...m, [s.id]: e instanceof Error ? e.message : String(e) })))
      }
    }
    load()
    const id = window.setInterval(load, 10 * 60_000)
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [obsOn])

  useEffect(() => {
    if (!map || !ready) return
    const src = map.getSource('wx-obs') as maplibregl.GeoJSONSource | undefined
    if (!src) return
    const features = obsOn
      ? OBS_STATIONS.flatMap((s) => {
          const last = obs[s.id]?.[obs[s.id].length - 1]
          if (!last) return []
          const mins = Math.round((Date.now() - last.t) / 60_000)
          const wind = last.tws == null ? '—' : `${last.twd == null ? 'calm' : `${Math.round(last.twd)}°`} ${last.tws.toFixed(0)} kn`
          return [{ type: 'Feature' as const, properties: { id: s.id, label: `${wind} · ${mins} min ago` }, geometry: { type: 'Point' as const, coordinates: [s.position.lon, s.position.lat] } }]
        })
      : []
    src.setData({ type: 'FeatureCollection', features } as GeoJSON.FeatureCollection)
  }, [map, ready, obs, obsOn])

  // Contours of whatever is switched on and in the forecast, at the displayed time.
  useEffect(() => {
    if (!map || !ready) return
    const src = map.getSource('wx-contours') as maplibregl.GeoJSONSource | undefined
    if (!src) return
    const features = cube
      ? contourChoices
          .filter((c) => contourSettings[c.id]?.on)
          .flatMap((c) =>
            contourFeatures(cube, c.field, t, contourSettings[c.id], c.id, c.decimals).map((f) => ({
              ...f,
              properties: { ...f.properties, width: contourSettings[c.id].width ?? 1.2 },
            })),
          )
      : []
    src.setData({ type: 'FeatureCollection', features } as GeoJSON.FeatureCollection)
  }, [map, ready, cube, t, contourChoices, contourSettings])

  // --------------------------------------------------------- push data to GL
  /*
   * A static field ignores the clock, so pin its time: otherwise a playing
   * timeline re-encodes and re-uploads the depth texture on every tick to
   * produce the identical image.
   */
  const scalarT = scalarCube && scalarCube.nt > 1 ? t : 0

  useEffect(() => {
    if (!ready || !scalar) return

    if (!isVector && scalarCube) {
      scalar.setParam(layer.params[0], layer.domain)
      scalar.setColorRamp(rampToLUT(ramp, layer.domain))
      scalar.setData(scalarCube, scalarT)
      scalar.setVisible(true)
    } else {
      scalar.setVisible(false)
    }
  }, [ready, scalar, scalarCube, scalarT, layer, ramp, isVector])

  useEffect(() => {
    if (!ready || !cube || !particles) return

    if (showParticles) {
      const speedLayer = isVector ? layer : LAYERS.wind
      particles.setOptions({
        params: particleParams,
        /*
         * Streamlines are an overlay, not the subject. At full opacity and full
         * density they bury the coastline, which is the one thing a sailor needs
         * to locate themselves against. Lighter and sparser reads better on a
         * dark chart and costs less GPU.
         */
        opacity: isVector ? 0.9 : 0.55,
        count: isVector ? 9000 : 5000,
      })
      particles.setColorRamp(particleRampLUT(speedLayer, speedLayer.id === layer.id ? shown : windShown), speedLayer.domain[1])
      particles.setData(cube, t)
      particles.setVisible(true)
    } else {
      particles.setVisible(false)
    }
  }, [ready, particles, cube, t, layer, isVector, showParticles, particleParams, shown, windShown])

  /*
   * Station current prediction, fetched only when the Current layer is open.
   *
   * This is a different source from the arrows, deliberately. Open-Meteo's global
   * ocean model gives Casco Bay 0.05-0.54 kn and never reverses in 48 hours, so it
   * cannot answer "when does the current turn". NOAA's harmonic prediction can.
   * They will disagree, and the UI says so rather than blending them — see the
   * precedence rule in docs/02-data-sources/portland-maine-pilot.md.
   */
  useEffect(() => {
    if (layerId !== 'current' || tide) return
    const station = PILOT_VENUE.currentStations[0]
    if (!station) return
    const controller = new AbortController()
    let cancelled = false
    fetchCurrentPrediction({ stationId: station.id, rangeHours: 48, signal: controller.signal })
      .then((p) => {
        if (!cancelled) {
          setTide(p)
          setTideError(null)
        }
      })
      .catch((e) => {
        if (cancelled || (e instanceof DOMException && e.name === 'AbortError')) return
        // The rest of the view still works without it; say what is missing.
        setTideError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      cancelled = true
      controller.abort()
    }
  }, [layerId, tide])

  /** Station flow at the displayed time, for the map marker and the caption. */
  const stationFlow = useMemo(() => (tide ? flowAt(tide, t) : null), [tide, t])
  const turnsNext = useMemo(() => (tide ? nextSlack(tide, t) : null), [tide, t])

  // Station marker: the tidal truth, sitting next to the model arrows.
  useEffect(() => {
    if (!map || !ready) return
    const src = map.getSource('wx-station') as maplibregl.GeoJSONSource | undefined
    if (!src) return
    const station = PILOT_VENUE.currentStations[0]
    if (layerId !== 'current' || !station || !stationFlow) {
      src.setData(emptyFC())
      return
    }
    src.setData({
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: {
            label: `${stationFlow.kn.toFixed(2)} kn ${stationFlow.label} ${Math.round(
              stationFlow.dir,
            )}°`,
          },
          geometry: { type: 'Point', coordinates: [station.position.lon, station.position.lat] },
        },
      ],
    })
  }, [map, ready, layerId, stationFlow])

  // Barbs / arrows are thinned per view, so they refresh on move as well as time.
  const refreshSymbols = useCallback(() => {
    if (!map || !cube) return
    const src = map.getSource('wx-symbols') as maplibregl.GeoJSONSource | undefined
    if (!src) return

    const wantSymbols = isVector && (mode === 'barbs' || mode === 'arrows')
    setVisible(map, 'wx-barbs', wantSymbols && mode === 'barbs')
    setVisible(map, 'wx-arrows', wantSymbols && mode === 'arrows')
    /*
     * Speed labels for current only.
     *
     * A barb already encodes wind speed in its feathers, and putting a number on
     * every wind arrow buries the chart in digits. Current is the case where the
     * exact figure matters and nothing else conveys it — half a knot decides which
     * side of a channel you take.
     */
    setVisible(map, 'wx-speed-labels', wantSymbols && layer.id === 'current')
    if (!wantSymbols) {
      src.setData(emptyFC())
      return
    }

    const b = map.getBounds()
    const samples = thinVectorField(cube, layer.params as [string, string], t, {
      targetAcross: 18,
      bounds: { west: b.getWest(), south: b.getSouth(), east: b.getEast(), north: b.getNorth() },
    })
    src.setData(vectorSamplesToFC(samples) as never)
    map.setPaintProperty(
      'wx-arrows',
      'text-color',
      rampToMapLibreExpression(ramp, layer.domain, PROP_MAGNITUDE) as never,
    )
  }, [map, cube, isVector, mode, layer, t, ramp])

  useEffect(() => {
    refreshSymbols()
  }, [refreshSymbols])

  useEffect(() => {
    if (!map || !ready) return
    const handler = () => refreshSymbols()
    map.on('moveend', handler)
    return () => {
      map.off('moveend', handler)
    }
  }, [map, ready, refreshSymbols])

  // Reset the render mode when switching to a layer that prefers another.
  useEffect(() => {
    if (isVector && layer.defaultMode) setMode(layer.defaultMode)
  }, [layerId, isVector, layer.defaultMode])

  // ------------------------------------------------------------------ readout
  const probeValues = useMemo(() => {
    if (!probe) return null
    // Depth needs no forecast, so a tap still answers when the download failed —
    // the forecast rows go to em-dashes rather than taking the readout with them.
    return {
      wind: cube ? readVector(cube, ['u10', 'v10'], probe, t) : null,
      gust: cube ? sampleCube(cube, 'gust', probe.lat, probe.lon, t) : null,
      prmsl: cube ? sampleCube(cube, 'prmsl', probe.lat, probe.lon, t) : null,
      current: cube ? readVector(cube, ['uo', 'vo'], probe, t) : null,
      /*
       * Sampled from the grid, never through `sampleCube`: the depth cube is a
       * one-step container for the renderer and every query at a real clock time
       * falls outside its coverage. See `depthRenderCube`.
       */
      depth: depthGrid ? depthAt(depthGrid, probe.lat, probe.lon) : null,
      // Only what the forecast carries: a row for a parameter it lacks would read as a gap.
      extra: EXTRA_READOUT.filter((x) => cube?.params.includes(x.param)).map((x) => ({
        ...x,
        value: cube ? sampleCube(cube, x.param, probe.lat, probe.lon, t) : null,
      })),
    }
  }, [cube, probe, t, depthGrid])

  const notes = cube ? cubeNotes(cube) : []
  const modelInfo = MODELS.find((m) => m.id === model)
  /*
   * Report the MODEL's native resolution, not our sample grid.
   *
   * Those are different numbers and only one of them is a claim about accuracy.
   * Sampling a 25 km model onto a 1 km grid produces a smooth picture and no
   * extra information, and labelling that "1 km" is exactly the sort of implied
   * precision this project exists to avoid.
   */
  const resolutionNote =
    // A GRIB file is on its own model's grid, so here the grid is the resolution.
    fileName && cube
      ? ` · ${cube.dx}° grid`
      : // `best_match` switches model by location, so it has no single resolution to
        // quote. Saying "varies" is the honest answer; quoting one number is not.
        model === 'best_match'
      ? ' · resolution varies by location'
      : modelInfo
        ? ` · ~${modelInfo.resolutionKm} km model`
        : ''
  /*
   * The current field gets an extra caveat, and it is not a small one.
   *
   * Measured over Casco Bay, this source runs 0.05-0.54 kn and reverses zero times
   * in 48 hours, while the NOAA station 4 km away predicts 1.17 kn reversing every
   * six. The arrows are resolving ocean drift, not tide. A legend that just said
   * "Current" would be quietly wrong, so it says which one this is.
   */
  const layerCaveat =
    layer.id === 'current' && !fileName ? ' · ocean model, does not resolve tidal reversal' : ''
  /*
   * Depth answers to a different source, a different datum and a different set of
   * caveats from anything on the forecast clock, so it gets its own provenance
   * line rather than a suffix on the model's.
   *
   * The datum sentence is the one a sailor has to read: GEBCO is referenced to
   * mean sea level, charts are referenced to MLLW, and at Portland that is 1.5 m
   * of water this layer shows and the tide can take away.
   */
  const depthSource =
    `GEBCO 2020 · ~450 m grid, no ledges or channels · depths below MSL, ` +
    `~${PORTLAND_MSL_ABOVE_MLLW_M.toFixed(1)} m less at MLLW · not for navigation`
  const source = isDepth
    ? depthSource
    : cube
      ? `${modelLabel}${resolutionNote}${layerCaveat} · ${new Date(t)
          .toISOString()
          .slice(0, 16)
          .replace('T', ' ')}Z`
      : undefined

  return (
    <>
      {/* ---- top controls ---- */}
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          padding: 'var(--pad)',
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
          pointerEvents: 'none',
        }}
      >
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', pointerEvents: 'auto' }}>
          {available.map((id) => {
            const l = layerById(id)
            if (!l) return null
            const active = id === layerId
            return (
              <button
                key={id}
                className={`chip${active ? ' chip--good' : ''}`}
                style={active ? { borderColor: 'var(--accent)', color: 'var(--accent)' } : undefined}
                onClick={() => setLayerId(id)}
              >
                {l.label}
              </button>
            )
          })}
          <button
            className={`chip${moreLayers ? ' chip--good' : ''}`}
            aria-pressed={moreLayers}
            onClick={() => setMoreLayers((v) => !v)}
            title="Gust, pressure, waves, temperature and rain, where the forecast has them"
          >
            {moreLayers ? 'Fewer' : 'More'}
          </button>
        </div>
        {moreLayers && (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', pointerEvents: 'auto' }} aria-label="Contours">
            {contourChoices.map((c) => {
              const on = contourSettings[c.id]?.on ?? false
              return (
                <button key={c.id} className={`chip${on ? ' chip--good' : ''}`} aria-pressed={on} onClick={() => setContour(c.id, { on: !on })}>
                  {c.label}
                </button>
              )
            })}
            <button className="chip" onClick={() => setShowContourSheet(true)}>
              Contour steps…
            </button>
          </div>
        )}

        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', pointerEvents: 'auto' }}>
          {isVector ? (
            <div className="seg" style={{ maxWidth: 320 }}>
              {MODES.map((m) => (
                <button key={m.id} aria-pressed={mode === m.id} onClick={() => setMode(m.id)}>
                  {m.label}
                </button>
              ))}
            </div>
          ) : (
            <button
              className={`chip${windOverlay ? ' chip--good' : ''}`}
              onClick={() => setWindOverlay((v) => !v)}
            >
              wind streamlines {windOverlay ? 'on' : 'off'}
            </button>
          )}
          <select
            className="chip"
            aria-label="Colours"
            value={shown?.mode ?? 'default'}
            onChange={(e) => setDisplayMode({ mode: e.target.value as ColourMode })}
            style={{ maxWidth: 150 }}
          >
            {COLOUR_MODES.filter((m) => modesFor(layer).includes(m.id)).map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
          {shown?.mode === 'single' && (
            <input
              type="color"
              aria-label="Layer colour"
              value={shown.colour}
              onChange={(e) => setDisplayMode({ colour: e.target.value })}
              style={{ width: 34, height: 28, padding: 0, border: 'none', background: 'none' }}
            />
          )}
          <select
            className="chip"
            aria-label="Forecast model"
            value={model}
            onChange={(e) => setModel(e.target.value as ModelId)}
            style={{ maxWidth: 190 }}
            disabled={fileName != null}
            title={fileName ? `Showing ${fileName}; untick it under GRIB files to go back to the download` : undefined}
          >
            {MODELS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
          <button
            className={`chip${ens.members ? ' chip--good' : ''}`}
            aria-pressed={ens.members != null}
            disabled={ens.busy}
            onClick={() => {
              if (ens.members) return ens.clear()
              const b = cube?.bbox ?? PILOT_VENUE.bbox
              void ens.load(b, cube ? Math.max(6, Math.round(((cube.nt - 1) * cube.dtMs) / 3_600_000)) : 48)
            }}
            title="Ten members of the GFS ensemble: their mean, their spread, or any one of them"
          >
            {ens.busy ? 'Ensemble…' : 'Ensemble'}
          </button>
          {ens.members && (
            <select
              className="chip"
              aria-label="Ensemble view"
              value={String(ens.view)}
              onChange={(e) => ens.setView(e.target.value === 'mean' ? 'mean' : Number(e.target.value))}
              style={{ maxWidth: 170 }}
            >
              <option value="mean">Mean of {ens.members.length}</option>
              {ens.members.map((m, i) => (
                <option key={m.model} value={i}>
                  {m.model}
                </option>
              ))}
            </select>
          )}
          <button className={`chip${radarOn ? ' chip--good' : ''}`} aria-pressed={radarOn} onClick={() => setRadarOn((v) => !v)}>
            Radar
          </button>
          {radarOn && radar && <span className="chip">radar {new Date(radar.time).toISOString().slice(11, 16)}Z</span>}
          <button className={`chip${satOn ? ' chip--good' : ''}`} aria-pressed={satOn} onClick={() => setSatOn((v) => !v)}>
            Satellite
          </button>
          <button
            className={`chip${obsOn ? ' chip--good' : ''}`}
            aria-pressed={obsOn}
            onClick={() => setObsOn((v) => !v)}
            title="What the venue's stations are reporting"
          >
            Observations
          </button>
          {obsOn && (
            <button className="chip" onClick={() => setShowObsSheet(true)}>
              Reports…
            </button>
          )}
          <button
            className="chip"
            disabled={!cube || (!boatNow && !probe)}
            onClick={() => setMeteo(boatNow ? 'boat' : 'point')}
            title="The forecast over time at the boat, or at the point tapped"
          >
            Meteogram
          </button>
          <button
            className={`chip${fileName ? ' chip--good' : ''}`}
            onClick={() => setShowFiles(true)}
            title={fileName ? `Showing ${fileName}` : 'Open GRIB files, or drop them on the chart'}
          >
            GRIB files{fileCount ? ` (${fileCount})` : ''}
          </button>
          {busy && (
            <span className="chip chip--warn">
              <span className="spinner" /> {busy}
            </span>
          )}
        </div>

        {ens.error && (
          <div className="warnbox" style={{ pointerEvents: 'auto', marginBottom: 0 }}>
            {ens.error}
          </div>
        )}
        {radarOn && radarError && (
          <div className="warnbox" style={{ pointerEvents: 'auto', marginBottom: 0 }}>
            {radarError}
          </div>
        )}
        {error && (
          <div className="errbox" style={{ pointerEvents: 'auto', marginBottom: 0 }}>
            {error}
          </div>
        )}
        {notes.map((n) => (
          <div key={n} className="warnbox" style={{ pointerEvents: 'auto', marginBottom: 0 }}>
            {n}
          </div>
        ))}
        {isDepth && depthError && (
          // Say what is missing rather than showing an empty chart with a legend.
          <div className="warnbox" style={{ pointerEvents: 'auto', marginBottom: 0 }}>
            Depth data unavailable ({depthError}). Nothing is drawn for it.
          </div>
        )}
        {isDepth && depthGrid && (
          /*
           * GEBCO's own sentence, and only that. The datum and the resolution are
           * in the legend and the readout already, and a caveat repeated three
           * times on a phone screen is a caveat nobody reads.
           */
          <div className="warnbox" style={{ pointerEvents: 'auto', marginBottom: 0 }}>
            {DEPTH_NOT_FOR_NAVIGATION}
          </div>
        )}
      </div>

      {/* ---- legend ---- */}
      {(isDepth ? depthGrid != null : cube != null) && (
        // An explicit width is required: inside an absolutely-positioned box with
        // no width the legend shrink-wraps to its narrowest possible column and
        // the tick labels wrap to one character per line.
        <div style={{ position: 'absolute', left: 10, bottom: 122, width: 188 }}>
          <Legend
            ramp={ramp}
            domain={layer.domain}
            label={layer.label}
            unit={layer.unit}
            source={source}
            compact
          />
        </div>
      )}

      {/* ---- point readout ---- */}
      {probeValues && probe && (
        <div
          className="legend"
          style={{ position: 'absolute', right: 10, bottom: 118, maxWidth: 210, pointerEvents: 'auto' }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
            <b>
              {probe.lat.toFixed(3)}, {probe.lon.toFixed(3)}
            </b>
            <button onClick={() => setProbe(null)} style={{ color: 'var(--ink-faint)' }}>
              ✕
            </button>
          </div>
          <div>
            wind{' '}
            {probeValues.wind
              ? `${fmtDeg(probeValues.wind.dirFrom)}° ${probeValues.wind.speed.toFixed(1)} kn`
              : '—'}
          </div>
          <div>gust {fmt(probeValues.gust, 1, ' kn')}</div>
          {/* "(MSL)" is not clutter: the number is 1.5 m optimistic at low water. */}
          <div>depth {withMsl(fmtLength(probeValues.depth, units))}</div>
          <div>
            current{' '}
            {probeValues.current
              ? `${fmtDeg(probeValues.current.dirFrom)}° ${probeValues.current.speed.toFixed(2)} kn`
              : '—'}
          </div>
          <div>mslp {fmt(probeValues.prmsl, 0, ' hPa')}</div>
          {cube && (
            <button className="btn btn--sm btn--ghost" onClick={() => setMeteo('point')} style={{ marginTop: 4 }}>
              Meteogram
            </button>
          )}
          {probeValues.extra.map((x) => (
            <div key={x.param}>
              {x.label} {fmt(x.value, x.dp, x.unit)}
            </div>
          ))}
        </div>
      )}

      {/* ---- tidal current chart, above the time axis, Current layer only ---- */}
      {layerId === 'current' && (tide || tideError) && (
        <div
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            bottom: 96,
            padding: '0 var(--pad)',
            pointerEvents: 'auto',
          }}
        >
          <div
            style={{
              background: 'rgba(5,13,22,0.92)',
              border: '1px solid var(--line)',
              borderRadius: 'var(--r)',
              padding: showChart ? '8px 10px 4px' : '6px 10px',
            }}
          >
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                gap: 8,
                flexWrap: 'wrap',
                fontSize: 11,
                color: 'var(--ink-dim)',
              }}
            >
              <span>
                <b style={{ color: 'var(--ink)' }}>Tidal current</b>{' '}
                {PILOT_VENUE.currentStations[0]?.name} ·{' '}
                <span style={{ color: 'var(--ink-faint)' }}>NOAA harmonic prediction</span>
              </span>
              <span style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                {stationFlow && (
                  <span className="chip">
                    {stationFlow.kn.toFixed(2)} kn {stationFlow.label}
                  </span>
                )}
                {turnsNext && (
                  /*
                   * Local AND UTC. "Local" here is the device's zone, which is the
                   * venue's only if you are actually at the venue — plan this race
                   * from another timezone and a bare local time is off by hours
                   * without saying so. The turn of the tide is exactly the number
                   * you must not get wrong.
                   */
                  <span className="chip">
                    turns{' '}
                    {new Date(turnsNext.t).toLocaleTimeString([], {
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                    {' · '}
                    {`${String(new Date(turnsNext.t).getUTCHours()).padStart(2, '0')}:${String(
                      new Date(turnsNext.t).getUTCMinutes(),
                    ).padStart(2, '0')}Z`}
                  </span>
                )}
                <button
                  className="chip"
                  onClick={() => setShowChart((v) => !v)}
                  aria-label={showChart ? 'Hide chart' : 'Show chart'}
                >
                  {showChart ? '▾' : '▴'}
                </button>
              </span>
            </div>
            {tideError && (
              <div className="warnbox" style={{ marginTop: 6, marginBottom: 2 }}>
                Tidal current prediction unavailable ({tideError}). The arrows on the
                map are an ocean model and do not resolve the tide.
              </div>
            )}
            {showChart && tide && <CurrentChart prediction={tide} t={t} windowHours={12} />}
            {showChart && tide && (
              <p className="note" style={{ margin: '2px 0 0' }}>
                Station prediction at one point, not a field. The map arrows are a
                separate ocean model and will disagree — they do not resolve tide.
              </p>
            )}
          </div>
        </div>
      )}
      {showContourSheet && (
        <div className="sheet" role="dialog" aria-label="Contours">
          <div className="sheet__grip" onClick={() => setShowContourSheet(false)} />
          <h2>Contours</h2>
          {CONTOURS.map((c) => {
            const cs = contourSettings[c.id] ?? DEFAULT_CONTOURS[c.id]
            const here = contourChoices.includes(c)
            return (
              <section key={c.id} aria-label={c.label} style={{ marginBottom: 10 }}>
                <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <input type="checkbox" checked={cs.on} onChange={(e) => setContour(c.id, { on: e.target.checked })} />
                  <b>{c.label}</b>
                  {!here && <span className="note">not in this forecast</span>}
                </label>
                <div className="field">
                  <label htmlFor={`ct-${c.id}-step`}>
                    Every <span className="note">{c.unit}</span>
                  </label>
                  <input
                    id={`ct-${c.id}-step`}
                    type="number"
                    min="0"
                    step="any"
                    inputMode="decimal"
                    value={cs.step}
                    onChange={(e) => {
                      const v = parseFloat(e.target.value)
                      if (v > 0) setContour(c.id, { step: v })
                    }}
                  />
                </div>
                <div className="field">
                  <label htmlFor={`ct-${c.id}-width`}>
                    Line width <span className="note">px</span>
                  </label>
                  <input
                    id={`ct-${c.id}-width`}
                    type="number"
                    min="0.5"
                    max="6"
                    step="0.5"
                    inputMode="decimal"
                    value={cs.width ?? 1.2}
                    onChange={(e) => {
                      const v = parseFloat(e.target.value)
                      if (v > 0) setContour(c.id, { width: Math.min(6, v) })
                    }}
                  />
                </div>
                <div className="field">
                  <label htmlFor={`ct-${c.id}-bold`}>
                    Bold at <span className="note">{c.unit}, blank for none</span>
                  </label>
                  <input
                    id={`ct-${c.id}-bold`}
                    type="number"
                    step="any"
                    inputMode="decimal"
                    value={cs.bold ?? ''}
                    onChange={(e) => {
                      const v = parseFloat(e.target.value)
                      setContour(c.id, { bold: Number.isFinite(v) ? v : null })
                    }}
                  />
                </div>
              </section>
            )
          })}
          <button className="btn btn--sm" onClick={() => setShowContourSheet(false)}>
            Done
          </button>
        </div>
      )}
      {meteo && cube && (meteo === 'boat' ? boatNow : probe) && (
        <div className="sheet sheet--tall" role="dialog" aria-label="Meteogram">
          <div className="sheet__grip" onClick={() => setMeteo(null)} />
          <h2>Meteogram</h2>
          <div className="seg" role="group" aria-label="Meteogram at" style={{ marginBottom: 8 }}>
            <button aria-pressed={meteo === 'point'} disabled={!probe} onClick={() => setMeteo('point')}>
              Tapped point
            </button>
            <button aria-pressed={meteo === 'boat'} disabled={!boatNow} onClick={() => setMeteo('boat')}>
              Boat
            </button>
          </div>
          <PointMeteogram
            cube={cube}
            at={meteo === 'boat' ? boatNow!.position : probe!}
            t={t}
            place={meteo === 'boat' ? 'the boat' : `${probe!.lat.toFixed(3)}, ${probe!.lon.toFixed(3)}`}
          />
          <button className="btn btn--sm" onClick={() => setMeteo(null)} style={{ marginTop: 8 }}>
            Done
          </button>
        </div>
      )}
      {showObsSheet && (
        <ObservationsSheet stations={OBS_STATIONS} obs={obs} errors={obsErrors} cube={cube} onClose={() => setShowObsSheet(false)} />
      )}
      {showFiles && <WeatherFilesSheet onClose={() => setShowFiles(false)} />}
    </>
  )
}

// ---------------------------------------------------------------- helpers

/** A depth with its datum, or a dash: never "null (MSL)". */
function withMsl(depth: string | null): string {
  return depth == null ? '—' : `${depth} (MSL)`
}

function fmt(v: number | null, dp: number, unit: string): string {
  return v == null || !Number.isFinite(v) ? '—' : `${v.toFixed(dp)}${unit}`
}

/** Sample a u/v pair and convert once, through the tested convention. */
function readVector(
  cube: WeatherCube,
  params: [string, string],
  at: { lat: number; lon: number },
  t: number,
): { dirFrom: number; speed: number } | null {
  const u = sampleCube(cube, params[0], at.lat, at.lon, t)
  const v = sampleCube(cube, params[1], at.lat, at.lon, t)
  if (u == null || v == null) return null
  return uvToWind(u, v)
}

/**
 * Colour ramp for the particle layer.
 *
 * The particle shader uploads its ramp as a 16x16 texture and indexes it with
 * `vec2(fract(16*t), floor(16*t)/16)`, which walks a 256-entry table in order:
 * entry `i` lands at row `floor(i/16)`, column `i%16`. So a flat 256-entry 1-D
 * LUT is exactly the right bytes — 256 * 4 == 16 * 16 * 4 — and needs no
 * rearranging, only reinterpreting.
 */
function particleRampLUT(spec: LayerSpec, how?: { mode: ColourMode; colour: string }): Uint8Array {
  return rampToLUT(rampForMode(spec, how?.mode, how?.colour), spec.domain, 256)
}
