/**
 * The app's palettes: day (the plain nav-station look, black on white), dusk (the
 * dark chart it was drawn for) and night (dusk under a red filter, styles.css).
 *
 * Everything drawn in code (map layers, canvases) was chosen for the dark
 * chart: light lines and text on a dark ground, dark halos. For day the same
 * colours are turned over in lightness and kept in hue: white text goes black,
 * a dark halo goes white, a yellow line goes dark gold, a cyan one deep blue.
 * One rule, so every overlay follows without each being redrawn by hand.
 */
import type maplibregl from 'maplibre-gl'

export type Palette = 'day' | 'dusk' | 'night'

/** The palette for the sun's height: day with it up, dusk in civil twilight (to 6° below), night after. */
export function paletteForSun(elevationDeg: number): Palette {
  return elevationDeg >= 0 ? 'day' : elevationDeg >= -6 ? 'dusk' : 'night'
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255
  g /= 255
  b /= 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  if (max === min) return [0, 0, l]
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  return [h / 6, s, l]
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) return [l * 255, l * 255, l * 255]
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  const f = (t: number) => {
    t = (t + 1) % 1
    if (t < 1 / 6) return p + (q - p) * 6 * t
    if (t < 1 / 2) return q
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6
    return p
  }
  return [f(h + 1 / 3) * 255, f(h) * 255, f(h - 1 / 3) * 255]
}

/**
 * The day lightness for a colour chosen for the dark chart. A light colour (a
 * line, a label) comes out dark enough to read on white, never lighter than
 * 42 %; a dark one (a ground, a halo) comes out light.
 */
function dayLightness(l: number): number {
  return l >= 0.5 ? Math.min(1 - l, 0.42) : 1 - l
}

const hex2 = (v: number) => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, '0')

/** A dark-chart colour as the day palette draws it: #rgb, #rrggbb, rgb() or rgba(); anything else is returned as it is. */
export function dayTone(colour: string): string {
  const c = colour.trim().toLowerCase()
  let r: number
  let g: number
  let b: number
  let a: number | null = null
  let m = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(c)
  if (m) [r, g, b] = [m[1], m[2], m[3]].map((x) => parseInt(x + x, 16))
  else if ((m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})?$/.exec(c))) {
    ;[r, g, b] = [m[1], m[2], m[3]].map((x) => parseInt(x, 16))
    if (m[4]) a = parseInt(m[4], 16) / 255
  } else if ((m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(c))) {
    ;[r, g, b] = [m[1], m[2], m[3]].map(Number)
    if (m[4] != null) a = Number(m[4])
  } else return colour
  const [h, s, l] = rgbToHsl(r, g, b)
  const [R, G, B] = hslToRgb(h, s, dayLightness(l))
  if (a != null) return `rgba(${Math.round(R)},${Math.round(G)},${Math.round(B)},${a})`
  return `#${hex2(R)}${hex2(G)}${hex2(B)}`
}

/** A colour for the palette on show: turned for day, as drawn for dusk and night (night's red is a filter over the page). */
export function tone(colour: string, palette: Palette): string {
  return palette === 'day' ? dayTone(colour) : colour
}

/** Every string in a paint value (a colour or an expression holding colours), toned. */
export function tonePaint(value: unknown, palette: Palette): unknown {
  if (palette !== 'day') return value
  if (typeof value === 'string') return dayTone(value)
  if (Array.isArray(value)) return value.map((v) => tonePaint(v, palette))
  return value
}

/**
 * A canvas context that draws in the palette: on day every fill, stroke and
 * shadow colour set on it is toned as it is set; on dusk and night it is the
 * context itself. So a drawing written for the dark chart needs no change.
 */
export function tonedContext(ctx: CanvasRenderingContext2D, palette: Palette): CanvasRenderingContext2D {
  if (palette !== 'day') return ctx
  const bound = new Map<PropertyKey, unknown>()
  return new Proxy(ctx, {
    get(t, k) {
      const v = Reflect.get(t, k, t)
      if (typeof v !== 'function') return v
      let f = bound.get(k)
      if (!f) bound.set(k, (f = (v as (...a: unknown[]) => unknown).bind(t)))
      return f
    },
    set(t, k, v) {
      const colour = (k === 'fillStyle' || k === 'strokeStyle' || k === 'shadowColor') && typeof v === 'string'
      return Reflect.set(t, k, colour ? dayTone(v) : v, t)
    },
  })
}

const COLOUR_PAINT = [
  'background-color',
  'fill-color',
  'fill-outline-color',
  'line-color',
  'circle-color',
  'circle-stroke-color',
  'text-color',
  'text-halo-color',
  'icon-color',
  'icon-halo-color',
] as const

/** A raster layer's paint on the day and dusk palettes. */
export interface BasePaint {
  day: Record<string, number>
  dusk: Record<string, number>
}

/** The Route chart's base map: on day the plain chart, on dusk dimmed and greyed under the overlays. */
export const CHART_BASE: BasePaint = {
  day: { 'raster-opacity': 1, 'raster-saturation': -0.15, 'raster-brightness-max': 1, 'raster-contrast': 0 },
  dusk: { 'raster-opacity': 0.55, 'raster-saturation': -0.6, 'raster-brightness-max': 0.75, 'raster-contrast': 0 },
}

interface Kept {
  /** The layer's own value, as its code set it (for dusk). */
  own: unknown
  /** What was set for day, to tell it from a later change of the code's. */
  set: unknown
}

/**
 * Keep a map's layers in the palette: tone every colour paint for day, and put
 * each layer's own colours back for dusk. Layers added later are caught as they
 * come (styledata). `base` gives raster layers, by id, their paint on each
 * palette. Returns `apply`, to call when the palette changes, and `stop`.
 */
export function followPalette(
  map: maplibregl.Map,
  palette: () => Palette,
  base: Record<string, BasePaint> = {},
): { apply: () => void; stop: () => void } {
  const kept = new Map<string, Kept>()
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
  let busy = false
  const apply = () => {
    if (busy) return
    const style = (() => {
      try {
        return map.getStyle()
      } catch {
        return null
      }
    })()
    if (!style) return
    busy = true
    try {
      const p = palette()
      for (const layer of style.layers) {
        for (const prop of COLOUR_PAINT) {
          let now: unknown
          try {
            now = map.getPaintProperty(layer.id, prop)
          } catch {
            continue
          }
          if (now == null) continue
          const key = `${layer.id}\u0000${prop}`
          const k = kept.get(key)
          // A value the code set since (a new layer, or a colour changed in Settings) is the layer's own again.
          const own = k && (same(now, k.set) || same(now, k.own)) ? k.own : now
          const want = p === 'day' ? tonePaint(own, 'day') : own
          kept.set(key, { own, set: want })
          if (!same(now, want)) map.setPaintProperty(layer.id, prop, want as never)
        }
        const raster = base[layer.id]
        if (raster && layer.type === 'raster') {
          const paint = p === 'day' ? raster.day : raster.dusk
          for (const [prop, v] of Object.entries(paint)) {
            try {
              if (map.getPaintProperty(layer.id, prop) !== v) map.setPaintProperty(layer.id, prop as never, v as never)
            } catch {
              /* a property this layer does not take */
            }
          }
        }
      }
    } finally {
      busy = false
    }
  }
  let queued = 0
  const soon = () => {
    if (queued) return
    queued = requestAnimationFrame(() => {
      queued = 0
      apply()
    })
  }
  map.on('styledata', soon)
  apply()
  return {
    apply,
    stop: () => {
      map.off('styledata', soon)
      if (queued) cancelAnimationFrame(queued)
    },
  }
}
