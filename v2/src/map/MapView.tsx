import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import { useEffect, useRef } from 'react'
import { destination } from '@/lib/geo'
import { boatModel } from '../engine/boats'
import { laylinesTo, lineBias } from '../engine/course'
import { actions, useUi, world, HOME } from '../state'
import { boatImage } from './icons'
import { arrowImage, drawWindField, windArrows } from './windLayer'

type FC = GeoJSON.FeatureCollection
const fc = (features: GeoJSON.Feature[]): FC => ({ type: 'FeatureCollection', features })
const pt = (lon: number, lat: number, props: Record<string, unknown> = {}): GeoJSON.Feature => ({ type: 'Feature', properties: props, geometry: { type: 'Point', coordinates: [lon, lat] } })
const line = (coords: Array<[number, number]>, props: Record<string, unknown> = {}): GeoJSON.Feature => ({ type: 'Feature', properties: props, geometry: { type: 'LineString', coordinates: coords } })

// Esri's ocean basemap shows depth shading and coastlines the way a sailor
// expects; the dark-grey canvas keeps night mode quiet.
const TILES = {
  night: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}',
  day: 'https://server.arcgisonline.com/ArcGIS/rest/services/Ocean/World_Ocean_Base/MapServer/tile/{z}/{y}/{x}',
}

function style(theme: 'night' | 'day'): maplibregl.StyleSpecification {
  return {
    version: 8,
    glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
    sources: {
      base: { type: 'raster', tiles: [TILES[theme]], tileSize: 256, maxzoom: theme === 'night' ? 16 : 13, attribution: 'Tiles © Esri, GEBCO, NOAA, Garmin, HERE and contributors' },
      seamarks: { type: 'raster', tiles: ['https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png'], tileSize: 256, minzoom: 9, maxzoom: 18, attribution: '© OpenSeaMap' },
    },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': theme === 'night' ? '#0b1724' : '#dfe9f1' } },
      { id: 'base', type: 'raster', source: 'base', paint: { 'raster-opacity': theme === 'night' ? 0.9 : 1 } },
      { id: 'seamarks', type: 'raster', source: 'seamarks', minzoom: 11, paint: { 'raster-opacity': 0.9 } },
    ],
  }
}

export function MapView() {
  const el = useRef<HTMLDivElement>(null)
  const mapRef = useRef<maplibregl.Map | null>(null)
  const windCanvas = useRef<HTMLCanvasElement>(document.createElement('canvas'))
  const windKey = useRef('')
  const arrowsKey = useRef('')
  const theme = useUi((s) => s.theme)

  useEffect(() => {
    if (!el.current) return
    const map = new maplibregl.Map({
      container: el.current,
      style: style(useUi.getState().theme),
      center: [HOME.lon, HOME.lat],
      zoom: 12.6,
      attributionControl: { compact: true },
      dragRotate: false,
      pitchWithRotate: false,
    })
    mapRef.current = map
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right')
    map.addControl(new maplibregl.ScaleControl({ unit: 'nautical' }), 'bottom-left')
    map.on('load', () => setup(map, windCanvas.current))
    map.on('style.load', () => setup(map, windCanvas.current))

    // The overlay is pinned to the map, so a pan needs nothing; once the map
    // settles, refill the arrows around the new view and tell the store where
    // we are looking (it fetches a forecast if the view has left the old one).
    const settled = () => {
      arrowsKey.current = ''
      const b = map.getBounds()
      actions.viewSettled({ west: b.getWest(), east: b.getEast(), south: b.getSouth(), north: b.getNorth() })
    }
    map.on('moveend', settled)
    map.once('idle', settled)

    // Clicks: place things in click modes; drag marks.
    let dragging: string | null = null
    map.on('mousedown', 'marks', (e) => {
      const id = e.features?.[0]?.properties?.id as string | undefined
      if (!id || useUi.getState().clickMode) return
      e.preventDefault()
      dragging = id
      useUi.setState({ selectedMarkId: id })
      map.getCanvas().style.cursor = 'grabbing'
    })
    map.on('mousemove', (e) => {
      if (dragging) actions.moveMark(dragging, { lat: e.lngLat.lat, lon: e.lngLat.lng })
    })
    map.on('mouseup', () => {
      if (dragging) map.getCanvas().style.cursor = ''
      dragging = null
    })
    map.on('mouseenter', 'marks', () => {
      if (!useUi.getState().clickMode) map.getCanvas().style.cursor = 'grab'
    })
    map.on('mouseleave', 'marks', () => {
      if (!dragging) map.getCanvas().style.cursor = ''
    })
    map.on('click', (e) => {
      actions.mapClick({ lat: e.lngLat.lat, lon: e.lngLat.lng })
    })

    let raf = 0
    const loop = () => {
      // For checking the map from the browser console while developing.
      if (import.meta.env.DEV) (window as unknown as { __map: maplibregl.Map }).__map = map
      update(map, windCanvas.current, windKey, arrowsKey)
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => {
      cancelAnimationFrame(raf)
      map.remove()
    }
  }, [])

  useEffect(() => {
    const map = mapRef.current
    if (map) {
      map.setStyle(style(theme))
      windKey.current = ''
      arrowsKey.current = ''
    }
  }, [theme])

  // Fly to requests from panels.
  const flyTo = useUi((s) => s.flyTo)
  useEffect(() => {
    if (flyTo && mapRef.current) mapRef.current.flyTo({ center: [flyTo.at.lon, flyTo.at.lat], zoom: flyTo.zoom ?? mapRef.current.getZoom(), duration: 900 })
  }, [flyTo])

  const clickMode = useUi((s) => s.clickMode)
  useEffect(() => {
    const map = mapRef.current
    if (map) map.getCanvas().style.cursor = clickMode ? 'crosshair' : ''
  }, [clickMode])

  return <div ref={el} className="map" data-click-mode={clickMode ?? ''} />
}

const SOURCES = ['wind-edge', 'wind-arrows', 'gates', 'tracks', 'highlight', 'course', 'laylines', 'route', 'startline', 'marks', 'boats', 'wind-tip'] as const

function setup(map: maplibregl.Map, canvas: HTMLCanvasElement): void {
  if (map.getSource('marks')) return
  lastDataVersion = -1
  for (const id of SOURCES) map.addSource(id, { type: 'geojson', data: fc([]) })
  const night = useUi.getState().theme === 'night'
  const cov = world.forecast.field.coverage().bbox
  map.addSource('wind', {
    type: 'canvas',
    canvas,
    animate: true,
    coordinates: [
      [cov.west, cov.north],
      [cov.east, cov.north],
      [cov.east, cov.south],
      [cov.west, cov.south],
    ],
  })
  map.addLayer({ id: 'wind', type: 'raster', source: 'wind', paint: { 'raster-opacity': night ? 0.55 : 0.4, 'raster-fade-duration': 0, 'raster-resampling': 'linear' } }, 'seamarks')
  // Where the forecast ends, so an empty patch of map reads as "no data here".
  map.addLayer({ id: 'wind-edge', type: 'line', source: 'wind-edge', paint: { 'line-color': night ? '#94a3b8' : '#475569', 'line-width': 1.2, 'line-dasharray': [4, 4], 'line-opacity': 0.7 } })
  if (!map.hasImage('wind-arrow')) map.addImage('wind-arrow', arrowImage(), { pixelRatio: 2 })
  map.addLayer({
    id: 'wind-arrows',
    type: 'symbol',
    source: 'wind-arrows',
    layout: {
      'icon-image': 'wind-arrow',
      'icon-rotate': ['get', 'to'],
      'icon-rotation-alignment': 'map',
      'icon-size': ['get', 'size'],
      'icon-allow-overlap': true,
      'icon-ignore-placement': true,
      'text-field': ['to-string', ['get', 'kn']],
      'text-font': ['Open Sans Semibold'],
      'text-size': 10,
      'text-anchor': 'left',
      'text-offset': [1.1, 0.4],
      'text-allow-overlap': true,
      'text-ignore-placement': true,
    },
    paint: { 'text-color': '#0b1724', 'text-halo-color': 'rgba(255,255,255,0.75)', 'text-halo-width': 1.2 },
  })

  for (const c of ['#22d3ee', '#f472b6', '#60a5fa', '#fbbf24', '#a78bfa', '#34d399', '#fb923c']) {
    const img = boatImage(c, c === '#22d3ee')
    if (!map.hasImage(`boat-${c}`)) map.addImage(`boat-${c}`, img, { pixelRatio: 2 })
  }

  map.addLayer({ id: 'tracks', type: 'line', source: 'tracks', paint: { 'line-color': ['get', 'color'], 'line-width': ['case', ['get', 'own'], 2.2, 1.2], 'line-opacity': ['case', ['get', 'own'], 0.85, 0.45] } })
  map.addLayer({ id: 'highlight', type: 'line', source: 'highlight', paint: { 'line-color': '#fde047', 'line-width': 6, 'line-opacity': 0.85, 'line-blur': 1 } })
  map.addLayer({ id: 'course', type: 'line', source: 'course', paint: { 'line-color': '#e2e8f0', 'line-width': 1.4, 'line-dasharray': [3, 3], 'line-opacity': 0.7 } })
  map.addLayer({ id: 'laylines', type: 'line', source: 'laylines', paint: { 'line-color': ['get', 'color'], 'line-width': 1.6, 'line-dasharray': [6, 3], 'line-opacity': 0.9 } })
  map.addLayer({ id: 'route', type: 'line', source: 'route', filter: ['==', ['geometry-type'], 'LineString'], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#facc15', 'line-width': 3.2, 'line-opacity': 0.95 } })
  // Says what the yellow line is, where it starts. (Along the line itself the
  // zigzags of a beat are too sharp for text to follow.)
  map.addLayer({
    id: 'route-label',
    type: 'symbol',
    source: 'route',
    filter: ['==', ['geometry-type'], 'Point'],
    layout: { 'text-field': ['get', 'label'], 'text-font': ['Open Sans Semibold'], 'text-size': 11.5, 'text-anchor': 'top', 'text-offset': [0, 0.8], 'text-allow-overlap': true },
    paint: { 'text-color': '#fde047', 'text-halo-color': '#0b1724', 'text-halo-width': 1.6 },
  })
  // Gates: green and dashed when open (sail between), red and solid when closed.
  map.addLayer({
    id: 'gates',
    type: 'line',
    source: 'gates',
    paint: { 'line-color': ['case', ['get', 'open'], '#22c55e', '#ef4444'], 'line-width': ['case', ['get', 'open'], 2, 3], 'line-dasharray': ['case', ['get', 'open'], ['literal', [2, 1.5]], ['literal', [1, 0]]], 'line-opacity': 0.9 },
  })
  map.addLayer({ id: 'startline', type: 'line', source: 'startline', paint: { 'line-color': ['get', 'color'], 'line-width': 3.5 } })
  map.addLayer({
    id: 'marks',
    type: 'circle',
    source: 'marks',
    paint: {
      'circle-radius': ['case', ['get', 'selected'], 9, 7],
      'circle-color': ['match', ['get', 'role'], 'pin', '#f97316', 'committee', '#f8fafc', '#fb923c'],
      'circle-stroke-color': ['case', ['get', 'selected'], '#fde047', '#0f172a'],
      'circle-stroke-width': ['case', ['get', 'selected'], 3, 2],
    },
  })
  map.addLayer({
    id: 'mark-labels',
    type: 'symbol',
    source: 'marks',
    layout: { 'text-field': ['get', 'label'], 'text-font': ['Open Sans Semibold'], 'text-size': 12, 'text-offset': [0, 1.3], 'text-anchor': 'top', 'text-allow-overlap': true },
    paint: { 'text-color': '#f8fafc', 'text-halo-color': '#0b1724', 'text-halo-width': 1.6 },
  })
  map.addLayer({
    id: 'boats',
    type: 'symbol',
    source: 'boats',
    layout: {
      'icon-image': ['concat', 'boat-', ['get', 'color']],
      'icon-rotate': ['get', 'hdg'],
      'icon-rotation-alignment': 'map',
      'icon-allow-overlap': true,
      'icon-ignore-placement': true,
      'icon-size': ['case', ['get', 'own'], 1.15, 0.95],
      'text-field': ['get', 'label'],
      'text-font': ['Open Sans Semibold'],
      'text-size': 11,
      'text-offset': [0, 1.6],
      'text-anchor': 'top',
      'text-allow-overlap': false,
      'text-optional': true,
    },
    paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#0b1724', 'text-halo-width': 1.6 },
  })
}

function setData(map: maplibregl.Map, id: string, data: FC): void {
  const s = map.getSource(id) as maplibregl.GeoJSONSource | undefined
  s?.setData(data)
}

let lastDataVersion = -1

function update(map: maplibregl.Map, canvas: HTMLCanvasElement, windKey: { current: string }, arrowsKey: { current: string }): void {
  if (!map.getSource('marks')) return
  const ui = useUi.getState()
  const f = world.forecast
  const forecastKey = `${f.cube.run}|${f.source}|${f.cube.bbox.west},${f.cube.bbox.south},${f.cube.bbox.east},${f.cube.bbox.north}`
  const timeKey = Math.round(ui.viewT / 20_000)

  // Colours: one image of the whole forecast area, redrawn only when the time
  // (to 20 s) or the forecast changes. Panning just moves it with the map.
  const key = `${timeKey}|${forecastKey}|${ui.colors}`
  if (windKey.current !== key) {
    windKey.current = key
    map.setLayoutProperty('wind', 'visibility', ui.colors ? 'visible' : 'none')
    if (ui.colors) {
      const corners = drawWindField(canvas, f.field, f.field.coverage().bbox, ui.viewT)
      ;(map.getSource('wind') as maplibregl.CanvasSource | undefined)?.setCoordinates(corners)
    }
    const b = f.field.coverage().bbox
    setData(map, 'wind-edge', fc([line([[b.west, b.north], [b.east, b.north], [b.east, b.south], [b.west, b.south], [b.west, b.north]])]))
    map.triggerRepaint()
  }

  // Arrows: refilled when the map settles somewhere new, the zoom level
  // changes, or the time or forecast changes.
  const aKey = `${timeKey}|${forecastKey}|${ui.arrows}|${Math.round(map.getZoom())}`
  if (arrowsKey.current !== aKey) {
    arrowsKey.current = aKey
    map.setLayoutProperty('wind-edge', 'visibility', ui.colors || ui.arrows ? 'visible' : 'none')
    if (ui.arrows) {
      const b = map.getBounds()
      setData(map, 'wind-arrows', windArrows(f.field, ui.viewT, { west: b.getWest(), east: b.getEast(), south: b.getSouth(), north: b.getNorth() }, map.getZoom()))
    } else setData(map, 'wind-arrows', fc([]))
  }

  if (ui.version === lastDataVersion) return
  lastDataVersion = ui.version

  // Boats and tracks.
  const boats = world.boats.map((b) =>
    pt(b.pos.lon, b.pos.lat, {
      color: b.color,
      hdg: b.hdg,
      own: b.own,
      label: b.own ? '' : `${b.name}${b.phase === 'finished' ? ' ✓' : ''}`,
    }),
  )
  setData(map, 'boats', fc(boats))
  setData(
    map,
    'tracks',
    fc(world.boats.filter((b) => b.track.length > 1).map((b) => line([...b.track.map((p) => [p.lon, p.lat] as [number, number]), [b.pos.lon, b.pos.lat]], { color: b.color, own: b.own }))),
  )

  // Coach highlight: the stretch of track a finding is about.
  const hl = ui.highlight
  if (hl) {
    const seg = world.samples.filter((s) => s.t >= hl.tFrom && s.t <= hl.tTo).map((s) => [s.lon, s.lat] as [number, number])
    setData(map, 'highlight', fc(seg.length > 1 ? [line(seg)] : []))
  } else setData(map, 'highlight', fc([]))

  // Marks and course.
  const seq = world.sequence
  const order = new Map<string, number[]>()
  const gateOf = new Map((world.course.gates ?? []).map((g) => [g.id, g]))
  world.course.sequence.forEach((id, i) => {
    const g = gateOf.get(id)
    for (const m of g ? [g.aId, g.bId] : [id]) order.set(m, [...(order.get(m) ?? []), i + 1])
  })
  setData(
    map,
    'gates',
    fc(
      (world.course.gates ?? []).flatMap((g) => {
        const a = world.marks.find((m) => m.id === g.aId)
        const b = world.marks.find((m) => m.id === g.bId)
        return a && b ? [line([[a.lon, a.lat], [b.lon, b.lat]], { open: g.open })] : []
      }),
    ),
  )
  setData(
    map,
    'marks',
    fc(
      world.marks.map((m) => {
        const n = order.get(m.id)
        return pt(m.lon, m.lat, { id: m.id, role: m.role, selected: ui.selectedMarkId === m.id, label: n ? `${m.name} (${n.join(', ')})` : m.name })
      }),
    ),
  )
  const ln = world.line
  const startMid: [number, number] | null = ln ? [(ln.pin.lon + ln.committee.lon) / 2, (ln.pin.lat + ln.committee.lat) / 2] : null
  const coursePts: Array<[number, number]> = [...(startMid ? [startMid] : []), ...seq.map((m) => [m.lon, m.lat] as [number, number])]
  setData(map, 'course', fc(coursePts.length > 1 ? [line(coursePts)] : []))
  if (ln) {
    const bias = lineBias(ln, world.own.twd)
    const fav = Math.abs(bias) < 2 ? '#e2e8f0' : '#22c55e'
    const mid = { lat: (ln.pin.lat + ln.committee.lat) / 2, lon: (ln.pin.lon + ln.committee.lon) / 2 }
    const favEnd = bias > 0 ? ln.pin : ln.committee
    setData(
      map,
      'startline',
      fc([
        line([[ln.pin.lon, ln.pin.lat], [ln.committee.lon, ln.committee.lat]], { color: '#f8fafc' }),
        ...(Math.abs(bias) >= 2 ? [line([[mid.lon, mid.lat], [favEnd.lon, favEnd.lat]], { color: fav })] : []),
      ]),
    )
  } else setData(map, 'startline', fc([]))

  // Laylines to the own boat's next mark (beats and runs).
  const feats: GeoJSON.Feature[] = []
  const own = world.own
  const next = own.phase === 'racing' ? seq[own.leg] : own.phase === 'prestart' ? seq[0] : null
  if (ui.showLaylines && next) {
    const tg = boatModel(world.boatId).lattice.targetsAt(own.tws)
    const kind = own.legKind === 'run' ? 'run' : 'beat'
    const ll = laylinesTo(next, own.twd, kind === 'beat' ? tg.upTwa : tg.downTwa, kind, 1.4)
    feats.push(line(ll.starboard.map((p) => [p.lon, p.lat] as [number, number]), { color: '#22c55e' }))
    feats.push(line(ll.port.map((p) => [p.lon, p.lat] as [number, number]), { color: '#ef4444' }))
  }
  // A short wind indicator from the own boat.
  if (own.tws > 0) {
    const tip = destination(own.pos, own.twd, 0.08)
    feats.push(line([[tip.lon, tip.lat], [own.pos.lon, own.pos.lat]], { color: '#e2e8f0' }))
  }
  setData(map, 'laylines', fc(feats))

  // The router's optimal route.
  const r = ui.route
  setData(
    map,
    'route',
    fc(r && r.legs.length > 1 ? [line(r.legs.map((l) => [l.position.lon, l.position.lat] as [number, number])), pt(r.legs[0]!.position.lon, r.legs[0]!.position.lat, { label: ui.routeInfo?.label ?? 'Route' })] : []),
  )
}
