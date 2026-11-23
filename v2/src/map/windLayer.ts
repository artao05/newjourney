/**
 * The forecast overlay, pinned to the map so it pans and zooms with the chart:
 *
 *  - colour: one image of the whole forecast area, sampled at the scrubbed time
 *    and laid over the forecast's own bounding box (so it only needs redrawing
 *    when the time changes, never when the map moves);
 *  - arrows: points on a fixed grid of the world, thinned with zoom, drawn by a
 *    MapLibre symbol layer. A fixed grid means an arrow stays on its patch of
 *    water while you pan, and zooming in fills in more of them.
 */
import { windFromUv } from '@/lib/weather/cube'
import type { BBox, WeatherField } from '@/lib/types'
import { windRgb } from '../engine/windColor'

type Quad = [[number, number], [number, number], [number, number], [number, number]]

const MAX_SIDE = 640 // px on the image's long side; the data is far coarser than this

const mercY = (lat: number) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))
const latOf = (y: number) => (360 / Math.PI) * Math.atan(Math.exp(y)) - 90

/**
 * Paints the wind-speed colours for `bbox` at time `t` into `canvas` and returns
 * the corners to pin it to. Rows are spaced evenly in Mercator, the map's own
 * projection, so the image lines up with the chart at every latitude.
 */
export function drawWindField(canvas: HTMLCanvasElement, field: WeatherField, bbox: BBox, t: number): Quad {
  const y0 = mercY(bbox.north)
  const y1 = mercY(bbox.south)
  const spanX = ((bbox.east - bbox.west) * Math.PI) / 180
  const spanY = y0 - y1
  const scale = MAX_SIDE / Math.max(spanX, spanY)
  const w = Math.max(2, Math.round(spanX * scale))
  const h = Math.max(2, Math.round(spanY * scale))
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w
    canvas.height = h
  }
  const ctx = canvas.getContext('2d')
  if (!ctx) return corners(bbox)
  const img = ctx.createImageData(w, h)
  for (let j = 0; j < h; j++) {
    const lat = latOf(y0 - ((j + 0.5) / h) * spanY)
    for (let i = 0; i < w; i++) {
      const lon = bbox.west + ((i + 0.5) / w) * (bbox.east - bbox.west)
      const s = field.wind(lat, lon, t)
      const k = (j * w + i) * 4
      if (!s) continue
      const [r, g, b] = windRgb(Math.hypot(s.u, s.v))
      img.data[k] = r
      img.data[k + 1] = g
      img.data[k + 2] = b
      img.data[k + 3] = 255
    }
  }
  ctx.putImageData(img, 0, 0)
  return corners(bbox)
}

function corners(b: BBox): Quad {
  return [
    [b.west, b.north],
    [b.east, b.north],
    [b.east, b.south],
    [b.west, b.south],
  ]
}

/** About this many screen pixels between arrows, whatever the zoom. */
const ARROW_PX = 60

/**
 * Arrow points for the area around the view, on a grid fixed to the world:
 * at each whole zoom level the grid cell is a fixed fraction of the world's
 * width, so panning never moves an arrow relative to the water.
 */
export function windArrows(field: WeatherField, t: number, view: BBox, zoom: number): GeoJSON.FeatureCollection {
  const cov = field.coverage().bbox
  // Cells across the world at this zoom (MapLibre's world is 512 px at zoom 0).
  const level = Math.max(0, Math.round(zoom + Math.log2(512 / ARROW_PX)))
  const cells = 2 ** level
  const step = 1 / cells // in normalised Mercator units (0..1 across the world)
  const toX = (lon: number) => (lon + 180) / 360
  const toY = (lat: number) => 0.5 - mercY(lat) / (2 * Math.PI)
  const lonOf = (x: number) => x * 360 - 180
  const latOfY = (y: number) => latOf((0.5 - y) * 2 * Math.PI)

  // The view plus a margin of one view on each side, so a pan reveals arrows
  // that are already there; clipped to the forecast.
  const vw = view.east - view.west
  const vh = view.north - view.south
  const west = Math.max(cov.west, view.west - vw)
  const east = Math.min(cov.east, view.east + vw)
  const south = Math.max(cov.south, view.south - vh)
  const north = Math.min(cov.north, view.north + vh)
  const features: GeoJSON.Feature[] = []
  if (west >= east || south >= north) return { type: 'FeatureCollection', features }

  const ix0 = Math.floor(toX(west) / step)
  const ix1 = Math.ceil(toX(east) / step)
  const iy0 = Math.floor(toY(north) / step)
  const iy1 = Math.ceil(toY(south) / step)
  if ((ix1 - ix0) * (iy1 - iy0) > 6000) return { type: 'FeatureCollection', features }
  for (let iy = iy0; iy <= iy1; iy++) {
    // Every other row shifted by half a cell: reads as a field, not a grid.
    const shift = iy % 2 === 0 ? 0 : 0.5
    const lat = latOfY((iy + 0.5) * step)
    if (lat < cov.south || lat > cov.north) continue
    for (let ix = ix0; ix <= ix1; ix++) {
      const lon = lonOf((ix + 0.5 + shift) * step)
      if (lon < cov.west || lon > cov.east) continue
      const s = field.wind(lat, lon, t)
      if (!s) continue
      const { speed, dir } = windFromUv(s.u, s.v)
      features.push({
        type: 'Feature',
        properties: { to: (dir + 180) % 360, kn: Math.round(speed), size: 0.75 + Math.min(0.55, speed * 0.022) },
        geometry: { type: 'Point', coordinates: [lon, lat] },
      })
    }
  }
  return { type: 'FeatureCollection', features }
}

/** A white arrow with a dark halo, pointing up (north): the symbol layer rotates it. */
export function arrowImage(): ImageData {
  const s = 48 // drawn at pixelRatio 2, so 24 px on screen
  const c = document.createElement('canvas')
  c.width = s
  c.height = s
  const ctx = c.getContext('2d')!
  const path = () => {
    ctx.beginPath()
    ctx.moveTo(s / 2, s - 6)
    ctx.lineTo(s / 2, 6)
    ctx.moveTo(s / 2 - 9, 17)
    ctx.lineTo(s / 2, 6)
    ctx.lineTo(s / 2 + 9, 17)
  }
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  path()
  ctx.strokeStyle = 'rgba(8,20,34,0.6)'
  ctx.lineWidth = 7
  ctx.stroke()
  path()
  ctx.strokeStyle = 'rgba(255,255,255,0.96)'
  ctx.lineWidth = 3.2
  ctx.stroke()
  return ctx.getImageData(0, 0, s, s)
}
