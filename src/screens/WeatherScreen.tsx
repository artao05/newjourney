/**
 * Weather screen — the data-layer viewer.
 *
 * Structurally this is the PredictWind equivalent, built from the pieces in
 * `src/lib/maplayers`: a basemap, one primary data layer, three render modes for
 * vector fields (streamlines / barbs / arrows), a time axis, model selection, and
 * a legend that always states its provenance.
 *
 * See docs/07-map-layers/competitor-teardown.md for what we are matching and,
 * more importantly, what we are deliberately not chasing: PredictWind's 1 km
 * PWG/PWE runs are compute, not code, and no amount of front-end work replaces
 * them. What we can match is the rendering and the honesty.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import { useStore } from '@/state/store'
import { PILOT_VENUE } from '@/data/venues'
import { MODELS, cubeNotes, fetchWindCube, type ModelId } from '@/lib/weather/openmeteo'
import { sampleCube } from '@/lib/weather/cube'
import { ParticleLayer } from '@/lib/maplayers/particleLayer'
import { ScalarLayer } from '@/lib/maplayers/scalarLayer'
import { LAYERS, rampFor, rampToLUT, rampToMapLibreExpression } from '@/lib/maplayers/colormap'
import {
  PROP_FROM,
  PROP_MAGNITUDE,
  PROP_TOWARD,
  thinVectorField,
  vectorSamplesToFC,
} from '@/lib/maplayers/vectorSymbols'
import { barbImageExpression, barbToImageData, buildBarbSprites } from '@/lib/maplayers/barbs'
import { Legend } from '@/components/Legend'
import { Timeline } from '@/components/Timeline'
import { uvToWind } from '@/lib/wind'
import type { LayerSpec, VectorMode } from '@/lib/maplayers/types'
import type { WeatherCube } from '@/lib/types'

/** Order shown in the layer picker. Wind first: it is why anyone opens this. */
const LAYER_ORDER = ['wind', 'gust', 'waveHeight', 'current', 'pressure'] as const

const MODES: Array<{ id: VectorMode; label: string }> = [
  { id: 'particles', label: 'Streamlines' },
  { id: 'barbs', label: 'Barbs' },
  { id: 'arrows', label: 'Arrows' },
]

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

const emptyFC = () => ({ type: 'FeatureCollection' as const, features: [] })

export function WeatherScreen() {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<maplibregl.Map | null>(null)
  const particleRef = useRef<ParticleLayer | null>(null)
  const scalarRef = useRef<ScalarLayer | null>(null)
  const spritesAdded = useRef(false)

  const [ready, setReady] = useState(false)
  const [cube, setCube] = useState<WeatherCube | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [model, setModel] = useState<ModelId>('best_match')
  const [layerId, setLayerId] = useState<string>('wind')
  const [mode, setMode] = useState<VectorMode>('particles')
  const [windOverlay, setWindOverlay] = useState(true)
  const [t, setT] = useState<number>(() => Date.now())
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(1)
  const [probe, setProbe] = useState<{ lat: number; lon: number } | null>(null)

  const boatState = useStore((s) => s.state)

  const layer: LayerSpec = LAYERS[layerId] ?? LAYERS.wind
  const ramp = useMemo(() => rampFor(layer), [layer])
  const isVector = layer.kind === 'vector'
  /** Wind streamlines can sit on top of any scalar field, which is the useful combo. */
  const showParticles = (isVector && mode === 'particles') || (!isVector && windOverlay)
  const particleParams: [string, string] = isVector
    ? (layer.params as [string, string])
    : ['u10', 'v10']

  // ------------------------------------------------------------------ map init
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: STYLE,
      center: [PILOT_VENUE.center.lon, PILOT_VENUE.center.lat],
      zoom: PILOT_VENUE.defaultZoom,
      attributionControl: { compact: true },
    })
    mapRef.current = map

    map.on('load', () => {
      const scalar = new ScalarLayer({ id: 'wx-scalar' })
      const particles = new ParticleLayer({ id: 'wx-particles' })
      map.addLayer(scalar as unknown as maplibregl.LayerSpecification)
      map.addLayer(particles as unknown as maplibregl.LayerSpecification)
      scalarRef.current = scalar
      particleRef.current = particles

      map.addSource('wx-symbols', { type: 'geojson', data: emptyFC() })
      map.addLayer({
        id: 'wx-barbs',
        type: 'symbol',
        source: 'wx-symbols',
        layout: {
          'icon-image': barbImageExpression(PROP_MAGNITUDE) as never,
          'icon-rotate': ['get', PROP_FROM],
          'icon-rotation-alignment': 'viewport',
          'icon-pitch-alignment': 'viewport',
          'icon-allow-overlap': true,
          'icon-ignore-placement': true,
          'icon-size': 0.9,
          visibility: 'none',
        },
      })
      map.addLayer({
        id: 'wx-arrows',
        type: 'symbol',
        source: 'wx-symbols',
        layout: {
          'text-field': '➤',
          'text-font': ['Open Sans Regular'],
          'text-size': ['interpolate', ['linear'], ['get', PROP_MAGNITUDE], 0, 11, 40, 26],
          // Arrow glyph points right at rotate 0, so aim it where the flow GOES.
          'text-rotate': ['-', ['get', PROP_TOWARD], 90],
          'text-rotation-alignment': 'viewport',
          'text-allow-overlap': true,
          'text-ignore-placement': true,
          visibility: 'none',
        },
        paint: { 'text-halo-color': '#04101c', 'text-halo-width': 1 },
      })

      map.addSource('wx-boat', { type: 'geojson', data: emptyFC() })
      map.addLayer({
        id: 'wx-boat-pt',
        type: 'circle',
        source: 'wx-boat',
        paint: {
          'circle-radius': 5,
          'circle-color': '#35d07f',
          'circle-stroke-color': '#eaf2fa',
          'circle-stroke-width': 2,
        },
      })

      setReady(true)
      if (import.meta.env.DEV) {
        // Console handle for tuning symbol sizes and inspecting the field.
        ;(window as unknown as Record<string, unknown>).__wx = { map, scalar, particles }
      }
    })

    map.on('click', (e) => setProbe({ lat: e.lngLat.lat, lon: e.lngLat.lng }))
    map.on('error', (e) => setError(e.error?.message ?? 'map error'))

    return () => {
      map.remove()
      mapRef.current = null
      particleRef.current = null
      scalarRef.current = null
      spritesAdded.current = false
      setReady(false)
    }
  }, [])

  // Barb sprites are shape-per-speed, so they must be registered as images once.
  useEffect(() => {
    const map = mapRef.current
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
  }, [ready])

  // ------------------------------------------------------------------- fetch
  const load = useCallback(
    async (which: ModelId) => {
      setBusy('Downloading forecast…')
      setError(null)
      try {
        /*
         * Pad the venue so panning a little does not run off the data, then pick
         * a sample step from the span rather than taking the library default.
         *
         * The default is 0.25 degrees, about 27 km — wider than Casco Bay itself,
         * which produced a 4x2 grid for the entire venue and a wind field with no
         * spatial structure at all. Aim for roughly 40 samples across instead.
         */
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
          model: which,
          includeWaves: true,
          includeCurrent: true,
        })
        setCube(c)
        // Snap the clock into the cube's window rather than leaving it outside.
        setT((prev) => Math.min(Math.max(prev, c.t0), c.t0 + (c.nt - 1) * c.dtMs))
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Forecast download failed')
      } finally {
        setBusy(null)
      }
    },
    [],
  )

  useEffect(() => {
    void load(model)
  }, [model, load])

  // --------------------------------------------------------- push data to GL
  useEffect(() => {
    if (!ready || !cube) return
    const scalar = scalarRef.current
    const particles = particleRef.current
    if (!scalar || !particles) return

    if (!isVector) {
      scalar.setParam(layer.params[0], layer.domain)
      scalar.setColorRamp(rampToLUT(ramp, layer.domain))
      scalar.setData(cube, t)
      scalar.setVisible(true)
    } else {
      scalar.setVisible(false)
    }

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
      particles.setColorRamp(particleRampLUT(speedLayer))
      particles.setData(cube, t)
      particles.setVisible(true)
    } else {
      particles.setVisible(false)
    }
  }, [ready, cube, t, layer, ramp, isVector, showParticles, particleParams])

  // Barbs / arrows are thinned per view, so they refresh on move as well as time.
  const refreshSymbols = useCallback(() => {
    const map = mapRef.current
    if (!map || !cube) return
    const src = map.getSource('wx-symbols') as maplibregl.GeoJSONSource | undefined
    if (!src) return

    const wantSymbols = isVector && (mode === 'barbs' || mode === 'arrows')
    map.setLayoutProperty('wx-barbs', 'visibility', wantSymbols && mode === 'barbs' ? 'visible' : 'none')
    map.setLayoutProperty('wx-arrows', 'visibility', wantSymbols && mode === 'arrows' ? 'visible' : 'none')
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
  }, [cube, isVector, mode, layer, t, ramp])

  useEffect(() => {
    refreshSymbols()
  }, [refreshSymbols])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return
    const handler = () => refreshSymbols()
    map.on('moveend', handler)
    return () => {
      map.off('moveend', handler)
    }
  }, [ready, refreshSymbols])

  // Own boat, when there is a fix.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return
    const src = map.getSource('wx-boat') as maplibregl.GeoJSONSource | undefined
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
  }, [ready, boatState])

  // Reset the render mode when switching to a layer that prefers another.
  useEffect(() => {
    if (isVector && layer.defaultMode) setMode(layer.defaultMode)
  }, [layerId, isVector, layer.defaultMode])

  // ------------------------------------------------------------------ readout
  const probeValues = useMemo(() => {
    if (!cube || !probe) return null
    const wind = readVector(cube, ['u10', 'v10'], probe, t)
    const cur = readVector(cube, ['uo', 'vo'], probe, t)
    return {
      wind,
      gust: sampleCube(cube, 'gust', probe.lat, probe.lon, t),
      hs: sampleCube(cube, 'hs', probe.lat, probe.lon, t),
      prmsl: sampleCube(cube, 'prmsl', probe.lat, probe.lon, t),
      current: cur,
    }
  }, [cube, probe, t])

  const notes = cube ? cubeNotes(cube) : []
  const modelInfo = MODELS.find((m) => m.id === model)
  const modelLabel = modelInfo?.label ?? model
  /*
   * Report the MODEL's native resolution, not our sample grid.
   *
   * Those are different numbers and only one of them is a claim about accuracy.
   * Sampling a 25 km model onto a 1 km grid produces a smooth picture and no
   * extra information, and labelling that "1 km" is exactly the sort of implied
   * precision this project exists to avoid.
   */
  const resolutionNote =
    // `best_match` switches model by location, so it has no single resolution to
    // quote. Saying "varies" is the honest answer; quoting one number is not.
    model === 'best_match'
      ? ' · resolution varies by location'
      : modelInfo
        ? ` · ~${modelInfo.resolutionKm} km model`
        : ''
  const source = cube
    ? `${modelLabel}${resolutionNote} · ${new Date(t)
        .toISOString()
        .slice(0, 16)
        .replace('T', ' ')}Z`
    : undefined

  return (
    <div className="screen screen--flush" style={{ position: 'relative' }}>
      <div ref={containerRef} className="map" />

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
          {LAYER_ORDER.map((id) => {
            const l = LAYERS[id]
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
        </div>

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
            value={model}
            onChange={(e) => setModel(e.target.value as ModelId)}
            style={{ maxWidth: 190 }}
          >
            {MODELS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
          {busy && (
            <span className="chip chip--warn">
              <span className="spinner" /> {busy}
            </span>
          )}
        </div>

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
      </div>

      {/* ---- legend ---- */}
      {cube && (
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
              ? `${probeValues.wind.dirFrom.toFixed(0)}° ${probeValues.wind.speed.toFixed(1)} kn`
              : '—'}
          </div>
          <div>gust {fmt(probeValues.gust, 1, ' kn')}</div>
          <div>waves {fmt(probeValues.hs, 1, ' m')}</div>
          <div>
            current{' '}
            {probeValues.current
              ? `${probeValues.current.dirFrom.toFixed(0)}° ${probeValues.current.speed.toFixed(2)} kn`
              : '—'}
          </div>
          <div>mslp {fmt(probeValues.prmsl, 0, ' hPa')}</div>
        </div>
      )}

      {/* ---- time axis ---- */}
      {cube && (
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
  )
}

// ---------------------------------------------------------------- helpers

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
function particleRampLUT(spec: LayerSpec): Uint8Array {
  return rampToLUT(rampFor(spec), spec.domain, 256)
}
