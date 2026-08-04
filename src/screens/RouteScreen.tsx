/**
 * Route screen — chart, wind, and the isochrone router.
 *
 * The headline is not the magenta line: it is the confidence band around it
 * (docs/03-algorithms/routing-isochrone.md §8). A beginner's failure mode is
 * treating the route as truth, so the sensitivity envelope is shown by default.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import { useStore } from '@/state/store'
import { cubeNotes, fetchWindCube } from '@/lib/weather/openmeteo'
import { RoutingClient } from '@/lib/routing/client'
import { bboxOf, distance } from '@/lib/geo'
import type { RouteRequest, RouteResult, WeatherCube } from '@/lib/types'
import { fmtClock } from '@/components/Tile'
import { PILOT_VENUE } from '@/data/venues'
import { landFractionOf, loadVenueLandMask, type LoadedLandMask } from '@/data/landmask'

// The map data is not yet a routing-grade coastline package. Never represent
// an OSM basemap as an obstacle mask: land avoidance stays explicitly disabled
// until the Portland venue pack supplies its verified vector geometry.
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

export function RouteScreen() {
  const mapRef = useRef<maplibregl.Map | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const clientRef = useRef<RoutingClient | null>(null)
  const [ready, setReady] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [progress, setProgress] = useState(0)
  const [cube, setCube] = useState<WeatherCube | null>(null)
  const [showResults, setShowResults] = useState(false)
  const [landPack, setLandPack] = useState<LoadedLandMask | null>(null)
  const [landError, setLandError] = useState<string | null>(null)

  const state = useStore((s) => s.state)
  const boat = useStore((s) => s.boat)
  const course = useStore((s) => s.course)
  const polar = useStore((s) => s.polar)
  const route = useStore((s) => s.route)
  const setRoute = useStore((s) => s.setRoute)
  const routeError = useStore((s) => s.routeError)
  const setRouteError = useStore((s) => s.setRouteError)

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
    setSource(
      map,
      'marks',
      {
        type: 'FeatureCollection',
        features: course.marks.map((m, i) => ({
          type: 'Feature' as const,
          properties: { name: `${i + 1}` },
          geometry: { type: 'Point' as const, coordinates: [m.position.lon, m.position.lat] },
        })),
      },
    )
  }, [ready, state, course.marks])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return
    if (!route || !route.ok || route.legs.length === 0) {
      setSource(map, 'route', emptyFC())
      setSource(map, 'route-beat', emptyFC())
      setSource(map, 'iso', emptyFC())
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
    const beatSegs: [number, number][][] = []
    let run: [number, number][] = []
    for (const l of route.legs) {
      if (l.isBeating) run.push([l.position.lon, l.position.lat])
      else if (run.length > 1) {
        beatSegs.push(run)
        run = []
      } else run = []
    }
    if (run.length > 1) beatSegs.push(run)
    setSource(map, 'route-beat', {
      type: 'FeatureCollection',
      features: beatSegs.map((c) => ({
        type: 'Feature' as const,
        properties: {},
        geometry: { type: 'LineString' as const, coordinates: c },
      })),
    })
    setSource(map, 'iso', {
      type: 'FeatureCollection',
      features: route.isochrones.map((iso) => ({
        type: 'Feature' as const,
        properties: {},
        geometry: {
          type: 'LineString' as const,
          coordinates: iso.points.map((p) => [p.lon, p.lat] as [number, number]),
        },
      })),
    })
    setSource(map, 'sens', sensitivityFC(route))

    if (coords.length > 1) {
      const b = new maplibregl.LngLatBounds(coords[0], coords[0])
      for (const c of coords) b.extend(c)
      map.fitBounds(b, { padding: 56, maxZoom: 12, duration: 600 })
    }
  }, [ready, route])

  // ------------------------------------------------------------------ actions
  const loadWeather = useCallback(async (): Promise<WeatherCube | null> => {
    if (!state) return null
    setBusy('Downloading forecast…')
    setRouteError(null)
    try {
      const pts = [state.position, ...course.marks.map((m) => m.position)]
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
      const map = mapRef.current
      if (map && ready) setSource(map, 'wind', windFC(c))
      return c
    } catch (e) {
      setRouteError(e instanceof Error ? e.message : 'Forecast download failed')
      return null
    } finally {
      setBusy(null)
    }
  }, [state, course.marks, ready, setRouteError])

  const run = useCallback(async () => {
    if (!state || !polar || course.marks.length === 0) return
    let workingCube = cube
    if (!workingCube) {
      workingCube = await loadWeather()
    }
    if (!workingCube) {
      setRouteError('No forecast loaded — tap Forecast first.')
      return
    }
    setBusy('Routing…')
    setProgress(0)
    setRouteError(null)
    try {
      clientRef.current ??= new RoutingClient()
      const req: RouteRequest = {
        start: state.position,
        startTime: Date.now(),
        marks: course.marks.map((m) => m.position),
        constraints: {
          avoidLand: landPack != null,
          tackPenaltyS: boat.tackPenaltyS,
          gybePenaltyS: boat.gybePenaltyS,
        },
        scalings: {
          polarPct: boat.polarPct,
          polarPctNight: boat.polarPctNight,
          windScalePct: 100,
          windRotateDeg: 0,
          windTimeShiftS: 0,
          currentScalePct: 100,
        },
        resolution: 'balanced',
        computeSensitivity: true,
      }
      const result = await clientRef.current.route(
        req,
        {
          cube: workingCube,
          polar,
          landRaster: landPack
            ? {
                bbox: landPack.meta.bbox,
                nx: landPack.meta.nx,
                ny: landPack.meta.ny,
                bits: landPack.bits,
              }
            : undefined,
        },
        (f) => setProgress(f),
      )
      if (!landPack) {
        result.diagnostics.warnings.unshift(
          landError
            ? `Land avoidance is OFF — the coastline pack failed to load (${landError}). This route may cross land.`
            : 'Land avoidance is OFF — the coastline pack has not loaded yet. This route may cross land.',
        )
      } else {
        // State the limits of the thing that is now on, rather than implying it
        // is a substitute for looking at a chart.
        result.diagnostics.warnings.push(
          `Land avoided using a ${Math.round(
            landPack.meta.cellDeg * 111000,
          )} m OSM coastline raster over the Portland venue only. Outside that box, and for anything narrower than a cell, it does not apply. Not a depth check.`,
        )
      }
      setRoute(result)
      if (!result.ok) setRouteError(result.error ?? 'Routing failed')
    } catch (e) {
      setRouteError(e instanceof Error ? e.message : 'Routing failed')
    } finally {
      setBusy(null)
    }
  }, [state, polar, course.marks, cube, boat, loadWeather, setRoute, setRouteError])

  useEffect(() => () => clientRef.current?.dispose(), [])

  const legNm = useMemo(() => {
    if (!state || course.marks.length === 0) return null
    let total = 0
    let prev = state.position
    for (const m of course.marks) {
      total += distance(prev, m.position)
      prev = m.position
    }
    return total
  }, [state, course.marks])

  const canRoute = !!state && !!polar && course.marks.length > 0 && !busy
  const forecastNotes = useMemo(() => (cube ? cubeNotes(cube) : []), [cube])

  return (
    <div className="screen screen--flush" style={{ position: 'relative' }}>
      <div ref={containerRef} className="map" />

      <div className="canvas-overlay">
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <span className={`chip ${cube ? 'chip--good' : ''}`}>
            <span className="dot" />
            {cube ? `${cube.model} · ${cube.nt}h` : 'no forecast'}
          </span>
          <span className="chip">{PILOT_VENUE.name}</span>
          {legNm != null && <span className="chip">{legNm.toFixed(1)} nm rhumb</span>}
          {landPack ? (
            <span className="chip chip--good" title={landPack.meta.attribution}>
              land pack {Math.round(landPack.meta.cellDeg * 111000)} m
            </span>
          ) : (
            <span className="chip chip--bad">{landError ? 'land pack failed' : 'no land pack'}</span>
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
            <div className="legend">
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
                within 10 min of optimal
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="actions" style={{ position: 'relative', zIndex: 2 }}>
        <button className="btn btn--sm" onClick={loadWeather} disabled={!state || !!busy}>
          FORECAST
        </button>
        <button className="btn btn--sm btn--primary" onClick={run} disabled={!canRoute}>
          ROUTE
        </button>
        <button
          className="btn btn--sm btn--ghost"
          onClick={() => setShowResults(true)}
          disabled={!route?.ok}
        >
          RESULTS
        </button>
      </div>

      {!polar && (
        <div className="warnbox" style={{ position: 'absolute', left: 12, right: 12, bottom: 74, zIndex: 3 }}>
          No polar loaded — pick a boat class in <b>Setup</b> before routing.
        </div>
      )}

      {showResults && route?.ok && (
        <ResultsSheet route={route} onClose={() => setShowResults(false)} />
      )}
    </div>
  )
}

// ------------------------------------------------------------------- sheets

function ResultsSheet({ route, onClose }: { route: RouteResult; onClose: () => void }) {
  const step = Math.max(1, Math.floor(route.legs.length / 40))
  const rows = route.legs.filter((_, i) => i % step === 0)
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
        <div className="row">
          <span>Elapsed</span>
          <span>{fmtClock(route.elapsedS) ?? '—'}</span>
        </div>
        <div className="row">
          <span>vs. direct</span>
          <span style={{ color: saved && saved > 0 ? 'var(--stbd)' : undefined }}>
            {saved == null ? '—' : `${saved > 0 ? '-' : '+'}${fmtClock(Math.abs(saved))}`}
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
          </tr>
        </thead>
        <tbody>
          {rows.map((l, i) => (
            <tr key={i} className={l.isBeating ? 'beating' : undefined}>
              <td>{new Date(l.t).toISOString().slice(11, 16)}</td>
              <td>{l.twd.toFixed(0)}</td>
              <td>{l.tws.toFixed(1)}</td>
              <td>
                {l.isBeating ? '(' : ''}
                {l.twa.toFixed(0)}
                {l.isBeating ? ')' : ''}
              </td>
              <td>{l.bsp.toFixed(2)}</td>
              <td>{l.heading.toFixed(0)}</td>
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

function setSource(map: maplibregl.Map, id: string, data: FC) {
  const src = map.getSource(id) as maplibregl.GeoJSONSource | undefined
  if (src) src.setData(data)
}

function addEmptyLayers(map: maplibregl.Map) {
  const add = (id: string) => map.addSource(id, { type: 'geojson', data: emptyFC() })
  ;['sens', 'wind', 'iso', 'route', 'route-beat', 'marks', 'boat'].forEach(add)

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
}

/** Thin the cube down to a readable arrow field. */
function windFC(c: WeatherCube): FC {
  const features: GeoJSON.Feature[] = []
  const u = c.data.u10
  const v = c.data.v10
  if (!u || !v) return emptyFC()
  const strideX = Math.max(1, Math.floor(c.nx / 18))
  const strideY = Math.max(1, Math.floor(c.ny / 18))
  for (let j = 0; j < c.ny; j += strideY) {
    for (let i = 0; i < c.nx; i += strideX) {
      const idx = j * c.nx + i // time index 0
      const uu = u[idx]
      const vv = v[idx]
      if (!Number.isFinite(uu) || !Number.isFinite(vv)) continue
      const kn = Math.hypot(uu, vv)
      // Arrow glyph points "up"; rotate to the direction the wind blows TOWARD.
      const rot = (Math.atan2(uu, vv) * 180) / Math.PI
      features.push({
        type: 'Feature',
        properties: { kn: Math.round(kn * 10) / 10, rot },
        geometry: {
          type: 'Point',
          coordinates: [c.bbox.west + i * c.dx, c.bbox.south + j * c.dy],
        },
      })
    }
  }
  return { type: 'FeatureCollection', features }
}

/** Cells within 10 minutes of optimal, as a coarse polygon soup. */
function sensitivityFC(route: RouteResult): FC {
  const s = route.sensitivity
  if (!s) return emptyFC()
  const dx = (s.bbox.east - s.bbox.west) / s.nx
  const dy = (s.bbox.north - s.bbox.south) / s.ny
  const features: GeoJSON.Feature[] = []
  for (let j = 0; j < s.ny; j++) {
    for (let i = 0; i < s.nx; i++) {
      const loss = s.loss[j * s.nx + i]
      if (!Number.isFinite(loss) || loss > 10) continue
      const x0 = s.bbox.west + i * dx
      const y0 = s.bbox.south + j * dy
      features.push({
        type: 'Feature',
        properties: { loss },
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [x0, y0],
              [x0 + dx, y0],
              [x0 + dx, y0 + dy],
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
