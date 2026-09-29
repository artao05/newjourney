/**
 * Simplified chart symbols for buoys, beacons, lights and dangers, after
 * S-52's simplified set: the buoy's shape from BOYSHP, its colours in bands
 * from COLOUR and COLPAT, the cardinal, isolated danger, safe water and
 * special topmarks, lateral daymarks on beacons, and a light's flare at 135°.
 *
 * Each symbol is named by a key that carries its whole spec, so the map can
 * ask for any key it meets and have it drawn. Drawing is plain TypeScript into
 * RGBA, so it needs no canvas and runs the same in tests.
 */
import type { EncFeature } from './s57'

export type SymbolShape =
  | 'cone' | 'can' | 'sphere' | 'pillar' | 'spar' | 'barrel' | 'super'
  | 'stake' | 'tower' | 'flare' | 'rock' | 'wreck' | 'obstruction' | 'landmark'

export type Topmark = '' | 'north' | 'east' | 'south' | 'west' | 'isolated' | 'safe' | 'special' | 'port' | 'starboard'

export interface SymbolSpec {
  shape: SymbolShape
  /** Fill colours, top band first, as #rrggbb. */
  colours: string[]
  /** Bands: horizontal, vertical, or none. */
  pattern: '' | 'h' | 'v'
  topmark: Topmark
  night: boolean
}

/** S-57 COLOUR codes, for the chart's dark palette. */
export const SYMBOL_COLOURS: Record<string, string> = {
  '1': '#f5f5f5', '2': '#212121', '3': '#e53935', '4': '#43a047', '5': '#1e88e5', '6': '#fdd835', '7': '#9e9e9e',
  '8': '#8d6e63', '9': '#ffb300', '10': '#8e24aa', '11': '#fb8c00', '12': '#e040fb', '13': '#f48fb1',
}
const BLACK = SYMBOL_COLOURS['2']
const RED = SYMBOL_COLOURS['3']
const YELLOW = SYMBOL_COLOURS['6']
const DANGER = '#ff5252'
const OUTLINE = '#9fb3c0'

/** The symbol image's size in CSS pixels; the object's position is its centre. */
export const SYMBOL_W = 32
export const SYMBOL_H = 48

const BUOY_SHAPES: Record<string, SymbolShape> = { '1': 'cone', '2': 'can', '3': 'sphere', '4': 'pillar', '5': 'spar', '6': 'barrel', '7': 'super', '8': 'super' }
const BEACON_SHAPES: Record<string, SymbolShape> = { '1': 'stake', '2': 'stake', '3': 'tower', '4': 'tower', '5': 'stake', '6': 'tower', '7': 'stake' }
const CARDINAL: Record<string, Topmark> = { '1': 'north', '2': 'east', '3': 'south', '4': 'west' }

function coloursOf(attr: string | undefined): string[] {
  return (attr ?? '').split(',').map((c) => SYMBOL_COLOURS[c.trim()]).filter((c): c is string => !!c)
}

/** The symbol for a point object, or null when it has none (it keeps its dot). */
export function symbolFor(f: Pick<EncFeature, 'cls' | 'attrs'>, night = false): SymbolSpec | null {
  const a = f.attrs
  const cls = f.cls
  const spec = (shape: SymbolShape, colours: string[], topmark: Topmark = '', pattern?: SymbolSpec['pattern']): SymbolSpec => ({
    shape,
    colours,
    // Several colours without a pattern are horizontal bands, as buoys mostly are.
    pattern: colours.length > 1 ? (pattern ?? (a.COLPAT?.split(',')[0] === '2' ? 'v' : 'h')) : '',
    topmark,
    night,
  })
  if (cls.startsWith('BOY')) {
    const colours = coloursOf(a.COLOUR)
    const shape = BUOY_SHAPES[a.BOYSHP ?? ''] ?? (cls === 'BOYLAT' && a.CATLAM === '1' ? 'can' : cls === 'BOYLAT' && a.CATLAM === '2' ? 'cone' : 'pillar')
    if (cls === 'BOYCAR') return spec(shape, colours.length ? colours : [BLACK, YELLOW], CARDINAL[a.CATCAM ?? ''] ?? '')
    if (cls === 'BOYISD') return spec(shape, colours.length ? colours : [BLACK, RED, BLACK], 'isolated')
    if (cls === 'BOYSAW') return spec(shape === 'pillar' && !a.BOYSHP ? 'sphere' : shape, colours.length ? colours : [RED, SYMBOL_COLOURS['1']], 'safe', a.COLPAT ? undefined : 'v')
    if (cls === 'BOYSPP') return spec(shape, colours.length ? colours : [YELLOW], 'special')
    return spec(shape, colours.length ? colours : [SYMBOL_COLOURS['7']])
  }
  if (cls.startsWith('BCN')) {
    const colours = coloursOf(a.COLOUR)
    const shape = BEACON_SHAPES[a.BCNSHP ?? ''] ?? 'stake'
    if (cls === 'BCNCAR') return spec(shape, colours.length ? colours : [BLACK, YELLOW], CARDINAL[a.CATCAM ?? ''] ?? '')
    if (cls === 'BCNISD') return spec(shape, colours.length ? colours : [BLACK, RED, BLACK], 'isolated')
    if (cls === 'BCNSAW') return spec(shape, colours.length ? colours : [RED, SYMBOL_COLOURS['1']], 'safe')
    if (cls === 'BCNSPP') return spec(shape, colours.length ? colours : [YELLOW], 'special')
    // A lateral beacon's colour is on its daymark: a square to port, a triangle to starboard.
    const daymark: Topmark = a.CATLAM === '1' ? 'port' : a.CATLAM === '2' ? 'starboard' : ''
    return spec(shape, colours.length ? colours : [SYMBOL_COLOURS['7']], daymark)
  }
  if (cls === 'LIGHTS') {
    // Red and green flares in their colour; white, yellow and the rest in yellow.
    const c = (a.COLOUR ?? '').split(',')[0]
    return spec('flare', [c === '3' ? RED : c === '4' ? SYMBOL_COLOURS['4'] : YELLOW])
  }
  if (cls === 'UWTROC') return spec('rock', [DANGER])
  if (cls === 'WRECKS') return spec('wreck', [DANGER])
  if (cls === 'OBSTRN') return spec('obstruction', [DANGER])
  if (cls === 'LNDMRK') return spec('landmark', ['#d7ccc8'])
  return null
}

/** The image name for a spec: `enc:` then every field, so it can be drawn from the name alone. */
export function symbolKey(s: SymbolSpec): string {
  return ['enc', s.shape, s.colours.map((c) => c.slice(1)).join(','), s.pattern, s.topmark, s.night ? 'n' : ''].join('|')
}

const SHAPES = new Set<string>(['cone', 'can', 'sphere', 'pillar', 'spar', 'barrel', 'super', 'stake', 'tower', 'flare', 'rock', 'wreck', 'obstruction', 'landmark'])

export function parseSymbolKey(key: string): SymbolSpec | null {
  const p = key.split('|')
  if (p.length !== 6 || p[0] !== 'enc' || !SHAPES.has(p[1])) return null
  const colours = p[2].split(',').filter((c) => /^[0-9a-f]{6}$/i.test(c)).map((c) => `#${c}`)
  if (!colours.length) return null
  return { shape: p[1] as SymbolShape, colours, pattern: p[3] === 'h' || p[3] === 'v' ? p[3] : '', topmark: p[4] as Topmark, night: p[5] === 'n' }
}

// ---------------------------------------------------------------- drawing

type Pt = [number, number]
type Poly = Pt[]

interface Raster {
  width: number
  height: number
  ratio: number
  data: Uint8ClampedArray
}

function rgb(hex: string, night: boolean): [number, number, number] {
  const v = parseInt(hex.slice(1), 16)
  const k = night ? 0.35 : 1
  return [((v >> 16) & 255) * k, ((v >> 8) & 255) * k, (v & 255) * k]
}

function inside(poly: Poly, x: number, y: number): boolean {
  let c = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]
    const [xj, yj] = poly[j]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c
  }
  return c
}

/**
 * Fill the union of polygons (CSS pixels, symbol centre at 0,0), antialiased
 * with 4×4 samples a pixel, optionally clipped to a box.
 */
function fill(r: Raster, polys: Poly[], hex: string, night: boolean, clip?: [number, number, number, number]) {
  const [cr, cg, cb] = rgb(hex, night)
  const ox = SYMBOL_W / 2
  const oy = SYMBOL_H / 2
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const p of polys) for (const [x, y] of p) {
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y)
  }
  if (clip) {
    x0 = Math.max(x0, clip[0]); y0 = Math.max(y0, clip[1]); x1 = Math.min(x1, clip[2]); y1 = Math.min(y1, clip[3])
  }
  const px0 = Math.max(0, Math.floor((x0 + ox) * r.ratio))
  const py0 = Math.max(0, Math.floor((y0 + oy) * r.ratio))
  const px1 = Math.min(r.width - 1, Math.ceil((x1 + ox) * r.ratio))
  const py1 = Math.min(r.height - 1, Math.ceil((y1 + oy) * r.ratio))
  for (let py = py0; py <= py1; py++) {
    for (let px = px0; px <= px1; px++) {
      let n = 0
      for (let sy = 0; sy < 4; sy++) {
        for (let sx = 0; sx < 4; sx++) {
          const x = (px + (sx + 0.5) / 4) / r.ratio - ox
          const y = (py + (sy + 0.5) / 4) / r.ratio - oy
          if (clip && (x < clip[0] || x > clip[2] || y < clip[1] || y > clip[3])) continue
          if (polys.some((p) => inside(p, x, y))) n++
        }
      }
      if (!n) continue
      // Source over, in straight (not premultiplied) alpha.
      const a = n / 16
      const i = (py * r.width + px) * 4
      const da = r.data[i + 3] / 255
      const oa = a + da * (1 - a)
      r.data[i] = (cr * a + r.data[i] * da * (1 - a)) / oa
      r.data[i + 1] = (cg * a + r.data[i + 1] * da * (1 - a)) / oa
      r.data[i + 2] = (cb * a + r.data[i + 2] * da * (1 - a)) / oa
      r.data[i + 3] = oa * 255
    }
  }
}

function circle(cx: number, cy: number, rad: number, n = 24): Poly {
  return Array.from({ length: n }, (_, k): Pt => [cx + rad * Math.cos((2 * Math.PI * k) / n), cy + rad * Math.sin((2 * Math.PI * k) / n)])
}

function ellipse(cx: number, cy: number, rx: number, ry: number, n = 24): Poly {
  return Array.from({ length: n }, (_, k): Pt => [cx + rx * Math.cos((2 * Math.PI * k) / n), cy + ry * Math.sin((2 * Math.PI * k) / n)])
}

function rect(x0: number, y0: number, x1: number, y1: number): Poly {
  return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]
}

/** A stroke as polygons: a quad for each segment and a disc at each joint. */
function stroke(pts: Pt[], width: number, closed: boolean): Poly[] {
  const out: Poly[] = []
  const h = width / 2
  const n = closed ? pts.length : pts.length - 1
  for (let i = 0; i < n; i++) {
    const [ax, ay] = pts[i]
    const [bx, by] = pts[(i + 1) % pts.length]
    const len = Math.hypot(bx - ax, by - ay) || 1
    const nx = (-(by - ay) / len) * h
    const ny = ((bx - ax) / len) * h
    out.push([[ax + nx, ay + ny], [bx + nx, by + ny], [bx - nx, by - ny], [ax - nx, ay - ny]])
  }
  for (const [x, y] of pts) out.push(circle(x, y, h, 8))
  return out
}

/** Each body's outline, with the y of its top for a topmark to sit on. */
function body(shape: SymbolShape): { poly: Poly; top: number } | null {
  switch (shape) {
    case 'cone': return { poly: [[-6, 0], [6, 0], [0, -13]], top: -13 }
    case 'can': return { poly: rect(-5, -10, 5, 0), top: -10 }
    case 'sphere': return { poly: circle(0, -5.5, 5.5), top: -11 }
    case 'pillar': return { poly: [[-5, 0], [5, 0], [2, -13], [-2, -13]], top: -13 }
    case 'spar': return { poly: rect(-1.7, -13, 1.7, 0), top: -13 }
    case 'barrel': return { poly: ellipse(0, -4, 7, 4), top: -8 }
    case 'super': return { poly: circle(0, -7, 7), top: -14 }
    case 'stake': return { poly: rect(-0.9, -13, 0.9, 0), top: -13 }
    case 'tower': return { poly: [[-4, 0], [4, 0], [2, -12], [-2, -12]], top: -12 }
    default: return null
  }
}

function up(b: number, h: number, w = 3): Poly {
  return [[-w, b], [w, b], [0, b - h]]
}
function down(b: number, h: number, w = 3): Poly {
  return [[0, b], [w, b - h], [-w, b - h]]
}

/** The topmark or daymark above a body whose top is at `top`. */
function topmarkPolys(t: Topmark, top: number): Poly[] {
  const b = top - 1.2
  switch (t) {
    case 'north': return [up(b, 4.5), up(b - 5, 4.5)]
    case 'south': return [down(b, 4.5), down(b - 5, 4.5)]
    case 'east': return [down(b, 4.5), up(b - 4.5, 4.5)]
    case 'west': return [up(b, 4.5), down(b - 4.5, 4.5)]
    case 'isolated': return [circle(0, b - 2.2, 2.2, 16), circle(0, b - 7, 2.2, 16)]
    case 'safe': return [circle(0, b - 2.6, 2.6, 16)]
    case 'special': return [...stroke([[-3, b], [3, b - 6]], 1.6, false), ...stroke([[3, b], [-3, b - 6]], 1.6, false)]
    case 'port': return [rect(-3.5, b - 7, 3.5, b)]
    case 'starboard': return [[[-4, b], [4, b], [0, b - 7]]]
    default: return []
  }
}

function topmarkColour(t: Topmark, s: SymbolSpec): string {
  if (t === 'safe') return RED
  if (t === 'special') return YELLOW
  if (t === 'port' || t === 'starboard') return s.colours[0]
  return BLACK
}

/** A light's flare: a teardrop from the light's position out at 135°. */
function flarePoly(): Poly {
  const side: Pt[] = []
  for (let u = 0; u <= 13; u += 0.5) {
    const w = u < 9 ? (3.2 * u) / 9 : 3.2 * Math.sqrt(Math.max(0, 1 - ((u - 9) / 4) ** 2))
    side.push([u, w])
  }
  const outline = [...side, ...side.slice().reverse().map(([u, w]): Pt => [u, -w])]
  // Along 135° true: south-east on the screen, y down.
  const th = Math.PI / 4
  return outline.map(([u, w]): Pt => [u * Math.cos(th) - w * Math.sin(th), u * Math.sin(th) + w * Math.cos(th)])
}

/** Draw a symbol as RGBA pixels, for `map.addImage(key, image, { pixelRatio: ratio })`. */
export function rasterSymbol(s: SymbolSpec, ratio = 2): { width: number; height: number; data: Uint8ClampedArray } {
  const r: Raster = { width: SYMBOL_W * ratio, height: SYMBOL_H * ratio, ratio, data: new Uint8ClampedArray(SYMBOL_W * ratio * SYMBOL_H * ratio * 4) }
  const n = s.night
  const c0 = s.colours[0]
  switch (s.shape) {
    case 'flare':
      fill(r, [flarePoly()], c0, n)
      fill(r, stroke(flarePoly(), 0.6, true), OUTLINE, n)
      break
    case 'rock':
      fill(r, [...stroke([[-5, 0], [5, 0]], 1.4, false), ...stroke([[0, -5], [0, 5]], 1.4, false)], c0, n)
      fill(r, [circle(-3.5, -3.5, 1, 8), circle(3.5, -3.5, 1, 8), circle(-3.5, 3.5, 1, 8), circle(3.5, 3.5, 1, 8)], c0, n)
      break
    case 'wreck':
      fill(r, [...stroke([[-6.5, 0], [6.5, 0]], 1.4, false), ...[-3, 0, 3].flatMap((x) => stroke([[x, -3], [x, 3]], 1.2, false))], c0, n)
      break
    case 'obstruction':
      fill(r, stroke(circle(0, 0, 5, 20), 1.2, true), c0, n)
      break
    case 'landmark':
      fill(r, stroke(circle(0, 0, 3.5, 16), 1.1, true), c0, n)
      fill(r, [circle(0, 0, 1.2, 10)], c0, n)
      break
    default: {
      const b = body(s.shape)
      if (!b) break
      const stake = s.shape === 'stake'
      // A stake is dark; its colours are on the daymark.
      const bandColours = stake && (s.topmark === 'port' || s.topmark === 'starboard') ? [BLACK] : s.colours
      const xs = b.poly.map((p) => p[0])
      const ys = b.poly.map((p) => p[1])
      const [bx0, bx1, by0, by1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]
      const k = bandColours.length
      for (const [i, c] of bandColours.entries()) {
        const clip: [number, number, number, number] =
          s.pattern === 'v'
            ? [bx0 + ((bx1 - bx0) * i) / k, -99, bx0 + ((bx1 - bx0) * (i + 1)) / k, 99]
            : [-99, by0 + ((by1 - by0) * i) / k, 99, by0 + ((by1 - by0) * (i + 1)) / k]
        fill(r, [b.poly], c, n, k > 1 ? clip : undefined)
      }
      fill(r, stroke(b.poly, 0.8, true), OUTLINE, n)
      const tm = topmarkPolys(s.topmark, b.top)
      if (tm.length) {
        // A short staff from the body to the topmark.
        fill(r, stroke([[0, b.top], [0, b.top - 1.2]], 0.8, false), OUTLINE, n)
        fill(r, tm, topmarkColour(s.topmark, s), n)
        if (s.topmark !== 'special') fill(r, tm.flatMap((p) => stroke(p, 0.5, true)), OUTLINE, n)
      }
      // The position circle at the base.
      fill(r, stroke(circle(0, 0, 1.4, 10), 0.7, true), OUTLINE, n)
    }
  }
  return { width: r.width, height: r.height, data: r.data }
}
