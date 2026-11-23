/**
 * The forecast overlay, drawn on a canvas laid over the map: a smooth colour
 * field for wind speed and arrows for direction, sampled from the forecast at
 * the scrubbed time. Redrawn on every map move and every time change.
 */
import type maplibregl from 'maplibre-gl'
import { windFromUv } from '@/lib/weather/cube'
import type { WeatherField } from '@/lib/types'
import { windRgb } from '../engine/windColor'

export interface WindDrawOptions {
  field: WeatherField
  t: number
  colors: boolean
  arrows: boolean
  opacity: number
}

const CELL = 10 // px per colour sample before smoothing
const ARROW_GAP = 54

export function drawWind(canvas: HTMLCanvasElement, map: maplibregl.Map, o: WindDrawOptions): void {
  const dpr = Math.min(2, window.devicePixelRatio || 1)
  const w = map.getContainer().clientWidth
  const h = map.getContainer().clientHeight
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr)
    canvas.height = Math.round(h * dpr)
  }
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, w, h)

  const sample = (x: number, y: number) => {
    const ll = map.unproject([x, y])
    const s = o.field.wind(ll.lat, ll.lng, o.t)
    return s ? windFromUv(s.u, s.v) : null
  }

  if (o.colors) {
    const nx = Math.ceil(w / CELL) + 1
    const ny = Math.ceil(h / CELL) + 1
    const off = document.createElement('canvas')
    off.width = nx
    off.height = ny
    const octx = off.getContext('2d')!
    const img = octx.createImageData(nx, ny)
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const s = sample(i * CELL, j * CELL)
        const k = (j * nx + i) * 4
        if (!s) {
          img.data[k + 3] = 0
          continue
        }
        const [r, g, b] = windRgb(s.speed)
        img.data[k] = r
        img.data[k + 1] = g
        img.data[k + 2] = b
        img.data[k + 3] = Math.round(255 * o.opacity)
      }
    }
    octx.putImageData(img, 0, 0)
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(off, 0, 0, nx, ny, 0, 0, nx * CELL, ny * CELL)
  }

  if (o.arrows) {
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    const bearingOffset = map.getBearing()
    for (let y = ARROW_GAP / 2; y < h; y += ARROW_GAP) {
      for (let x = ARROW_GAP / 2 + ((y / ARROW_GAP) % 2) * (ARROW_GAP / 2); x < w; x += ARROW_GAP) {
        const s = sample(x, y)
        if (!s) continue
        // Arrow points the way the wind blows (from `dir` towards dir+180).
        const to = ((s.dir + 180 - bearingOffset) * Math.PI) / 180
        const len = 10 + Math.min(14, s.speed * 0.6)
        const dx = Math.sin(to)
        const dy = -Math.cos(to)
        const x0 = x - (dx * len) / 2
        const y0 = y - (dy * len) / 2
        const x1 = x + (dx * len) / 2
        const y1 = y + (dy * len) / 2
        ctx.strokeStyle = 'rgba(8,20,34,0.55)'
        ctx.lineWidth = 3.6
        arrow(ctx, x0, y0, x1, y1, dx, dy)
        ctx.strokeStyle = 'rgba(255,255,255,0.95)'
        ctx.lineWidth = 1.6
        arrow(ctx, x0, y0, x1, y1, dx, dy)
        if (s.speed >= 1) {
          ctx.font = '600 10px Inter, system-ui, sans-serif'
          ctx.fillStyle = 'rgba(8,20,34,0.75)'
          ctx.fillText(String(Math.round(s.speed)), x1 + 3, y1 + 3)
        }
      }
    }
  }
}

function arrow(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number, dx: number, dy: number): void {
  const hx = -dy
  const hy = dx
  ctx.beginPath()
  ctx.moveTo(x0, y0)
  ctx.lineTo(x1, y1)
  ctx.moveTo(x1, y1)
  ctx.lineTo(x1 - dx * 6 + hx * 4, y1 - dy * 6 + hy * 4)
  ctx.moveTo(x1, y1)
  ctx.lineTo(x1 - dx * 6 - hx * 4, y1 - dy * 6 - hy * 4)
  ctx.stroke()
}
