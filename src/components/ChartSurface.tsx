/**
 * The shared chart surface.
 *
 * One MapLibre instance, one forecast cube, one time axis — with the tab-specific
 * drawing supplied as children. Weather, and after it Start, Race and Route, are
 * overlays on this rather than screens that each stand up their own map.
 *
 * The split is: this file owns everything that is *the chart* (basemap, camera,
 * the two custom GL layers, barb sprites, own-boat, the forecast download and the
 * clock), and an overlay owns everything that is *a reading of it* (which field,
 * which symbols, which legend, which controls). See
 * docs/05-spec/start-on-chart.md §2.
 *
 * Overlays reach the map through `useChart()`. The map arrives asynchronously and
 * its layers arrive later still, so consumers must gate on `ready` and not merely
 * on `map` being non-null — `ready` is set once the `load` handler has registered
 * the shared sources and layers, which is when it becomes safe to add more.
 */

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import { useStore } from '@/state/store'
import { PILOT_VENUE } from '@/data/venues'
import { MODELS, fetchWindCube, type ModelId } from '@/lib/weather/openmeteo'
import { ParticleLayer } from '@/lib/maplayers/particleLayer'
import { ScalarLayer } from '@/lib/maplayers/scalarLayer'
import { barbToImageData, buildBarbSprites } from '@/lib/maplayers/barbs'
import { Timeline } from '@/components/Timeline'
import type { WeatherCube } from '@/lib/types'

/**
 * A deliberately quiet basemap. The data is the subject; the chart is context.
 * PredictWind does the same thing, and it is why their layers read so clearly.
 */
const STYLE: maplibregl.StyleSpecification = {
  version: 8,
  glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
  sources: {
    osm: {
      type: 'raster',
      tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
      tileSize: 256,
      maxzoom: 18,
      attribution: '© OpenStreetMap contributors',
    },
  },
  layers: [
    { id: 'bg', type: 'background', paint: { 'background-color': '#061320' } },
    {
      id: 'osm',
      type: 'raster',
      source: 'osm',
      paint: {
        // Bright enough that the coastline survives a streamline layer on top,
        // desaturated enough that it never competes with the data for attention.
        'raster-opacity': 0.62,
        'raster-saturation': -0.85,
        'raster-brightness-max': 0.72,
        'raster-contrast': 0.2,
      },
    },
  ],
}

export const emptyFC = () => ({ type: 'FeatureCollection' as const, features: [] })

/**
 * Own-boat, and the layer every overlay must insert before.
 *
 * Passing `beforeId: BOAT_LAYER_ID` to `addLayer` keeps the boat on top no matter
 * what an overlay draws. Overlays mount after the surface, so without it their
 * layers land above the boat and hide it.
 */
export const BOAT_LAYER_ID = 'chart-boat-pt'

/**
 * Set a layer's visibility, tolerating a layer that is not there.
 *
 * MapLibre raises "Cannot style non-existing layer" as a map `error` event, which
 * the surface surfaces as a red banner. During development that fires every time
 * HMR swaps an overlay module after `load` has already run, and in production it
 * would turn a layer-ordering slip into an alarming message about nothing the
 * user can act on. Missing layer means nothing to show — that is not an error.
 */
export function setVisible(map: maplibregl.Map, id: string, visible: boolean) {
  if (!map.getLayer(id)) return
  map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none')
}

interface ChartValue {
  map: maplibregl.Map | null
  /** True once the shared sources and layers exist. Gate every overlay effect on it. */
  ready: boolean
  scalar: ScalarLayer | null
  particles: ParticleLayer | null

  cube: WeatherCube | null
  model: ModelId
  setModel(m: ModelId): void
  modelLabel: string
  busy: string | null
  error: string | null

  /** Displayed valid time, epoch ms UTC. */
  t: number
  setT(t: number): void
}

const ChartContext = createContext<ChartValue | null>(null)

export function useChart(): ChartValue {
  const v = useContext(ChartContext)
  if (!v) throw new Error('useChart must be used inside <ChartSurface>')
  return v
}

interface Props {
  children?: ReactNode
  /**
   * Render the shared time axis along the bottom. Overlays that need the bottom
   * band for their own controls — Start, once it has a gun-relative scrubber —
   * turn this off and drive `t` themselves.
   */
  showTimeline?: boolean
}

export function ChartSurface({ children, showTimeline = true }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<maplibregl.Map | null>(null)
  const spritesAdded = useRef(false)

  const [map, setMap] = useState<maplibregl.Map | null>(null)
  const [scalar, setScalar] = useState<ScalarLayer | null>(null)
  const [particles, setParticles] = useState<ParticleLayer | null>(null)
  const [ready, setReady] = useState(false)

  const [cube, setCube] = useState<WeatherCube | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [model, setModel] = useState<ModelId>('best_match')
  const [t, setT] = useState<number>(() => Date.now())
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(1)

  const boatState = useStore((s) => s.state)

  // ------------------------------------------------------------------ map init
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return
    const m = new maplibregl.Map({
      container: containerRef.current,
      style: STYLE,
      center: [PILOT_VENUE.center.lon, PILOT_VENUE.center.lat],
      zoom: PILOT_VENUE.defaultZoom,
      attributionControl: { compact: true },
    })
    mapRef.current = m
    setMap(m)
    if (import.meta.env.DEV) {
      // Console handle, set at construction rather than on `load`: when the map
      // is stuck the handle is the thing you need most, and hanging it off the
      // load callback means it is missing in exactly that case.
      ;(window as unknown as Record<string, unknown>).__wx = { map: m }
    }

    m.on('load', () => {
      const sc = new ScalarLayer({ id: 'wx-scalar' })
      const pt = new ParticleLayer({ id: 'wx-particles' })
      m.addLayer(sc as unknown as maplibregl.LayerSpecification)
      m.addLayer(pt as unknown as maplibregl.LayerSpecification)
      setScalar(sc)
      setParticles(pt)

      // Own boat. Every overlay wants it, so it lives here.
      //
      // It must stay the topmost layer — nothing on the chart is more important
      // than where you are — but overlays mount later and would therefore draw
      // over it. So overlays insert with `beforeId: BOAT_LAYER_ID`, and this is
      // the only ordering rule the surface imposes on them.
      m.addSource('chart-boat', { type: 'geojson', data: emptyFC() })
      m.addLayer({
        id: BOAT_LAYER_ID,
        type: 'circle',
        source: 'chart-boat',
        paint: {
          'circle-radius': 5,
          'circle-color': '#35d07f',
          'circle-stroke-color': '#eaf2fa',
          'circle-stroke-width': 2,
        },
      })

      setReady(true)
      if (import.meta.env.DEV) {
        // Now the GL layers exist, so the handle can carry them too — this is
        // what you reach for when tuning symbol sizes or inspecting the field.
        ;(window as unknown as Record<string, unknown>).__wx = { map: m, scalar: sc, particles: pt }
      }
    })

    m.on('error', (e) => setError(e.error?.message ?? 'map error'))

    return () => {
      m.remove()
      mapRef.current = null
      setMap(null)
      setScalar(null)
      setParticles(null)
      spritesAdded.current = false
      setReady(false)
    }
  }, [])

  // Barb sprites are shape-per-speed, so they must be registered as images once.
  // They live here rather than in the weather overlay because they are map
  // resources, not a reading: an overlay that unmounts must not take them with it.
  useEffect(() => {
    if (!map || !ready || spritesAdded.current) return
    spritesAdded.current = true
    let cancelled = false
    void (async () => {
      for (const sprite of buildBarbSprites({ color: '#eaf2fa' })) {
        try {
          const img = await barbToImageData(sprite, 2)
          if (cancelled || map.hasImage(sprite.id)) continue
          map.addImage(sprite.id, img, { pixelRatio: 2 })
        } catch {
          /* a missing sprite degrades one speed bucket, not the whole layer */
        }
      }
      if (!cancelled) map.triggerRepaint()
    })()
    return () => {
      cancelled = true
    }
  }, [map, ready])

  // ------------------------------------------------------------------- fetch
  useEffect(() => {
    let cancelled = false
    const run = async () => {
      setBusy('Downloading forecast…')
      setError(null)
      try {
        const v = PILOT_VENUE.bbox
        const padX = (v.east - v.west) * 0.35
        const padY = (v.north - v.south) * 0.35
        const bbox = {
          west: v.west - padX,
          south: v.south - padY,
          east: v.east + padX,
          north: v.north + padY,
        }
        const span = Math.max(bbox.east - bbox.west, bbox.north - bbox.south)
        const stepDeg = Math.max(0.02, span / 40)
        const c = await fetchWindCube({
          bbox,
          stepDeg,
          hours: 72,
          model,
          includeWaves: false,
          includeCurrent: true,
        })
        if (cancelled) return
        setCube(c)
        setT((prev) => Math.min(Math.max(prev, c.t0), c.t0 + (c.nt - 1) * c.dtMs))
      } catch (e) {
        if (cancelled) return
        setError(e instanceof Error ? e.message : 'Forecast download failed')
      } finally {
        if (!cancelled) setBusy(null)
      }
    }
    void run()
    return () => { cancelled = true }
  }, [model])

  // Own boat, when there is a fix.
  useEffect(() => {
    if (!map || !ready) return
    const src = map.getSource('chart-boat') as maplibregl.GeoJSONSource | undefined
    if (!src) return
    src.setData(
      boatState
        ? {
            type: 'FeatureCollection',
            features: [
              {
                type: 'Feature',
                properties: {},
                geometry: {
                  type: 'Point',
                  coordinates: [boatState.position.lon, boatState.position.lat],
                },
              },
            ],
          }
        : emptyFC(),
    )
  }, [map, ready, boatState])

  const modelLabel = MODELS.find((m) => m.id === model)?.label ?? model

  const value = useMemo<ChartValue>(
    () => ({
      map,
      ready,
      scalar,
      particles,
      cube,
      model,
      setModel,
      modelLabel,
      busy,
      error,
      t,
      setT,
    }),
    [map, ready, scalar, particles, cube, model, modelLabel, busy, error, t],
  )

  return (
    <ChartContext.Provider value={value}>
      <div className="screen screen--flush" style={{ position: 'relative' }}>
        <div ref={containerRef} className="map" />

        {children}

        {cube && showTimeline && (
          <div
            style={{
              position: 'absolute',
              left: 0,
              right: 0,
              bottom: 0,
              // Extra bottom padding keeps the speed control clear of MapLibre's
              // attribution, which is legally required to stay legible.
              padding: 'var(--pad) var(--pad) 26px',
              background: 'linear-gradient(to top, rgba(5,13,22,0.96), rgba(5,13,22,0))',
            }}
          >
            <Timeline
              t0={cube.t0}
              dtMs={cube.dtMs}
              nt={cube.nt}
              value={t}
              onChange={setT}
              playing={playing}
              onPlayingChange={setPlaying}
              speed={speed}
              onSpeedChange={setSpeed}
              runLabel={modelLabel}
            />
          </div>
        )}
      </div>
    </ChartContext.Provider>
  )
}
