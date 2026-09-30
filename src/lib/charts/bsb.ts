/**
 * BSB/KAP raster charts (NOAA's RNCs and many other offices' raster charts).
 *
 * A KAP file is a text header, ended by Ctrl-Z and a NUL, then the picture:
 * a byte giving the bits per pixel, then each row as its row number (seven
 * bits a byte, high bit set on all but the last) and runs of palette colours
 * ended by a zero byte, then a table of where each row starts. A run's first
 * byte has a continuation bit, the colour in the next `depth` bits and the
 * top of the count in the rest; each following byte adds seven more bits of
 * count while its high bit says more follow. Colours count from one.
 *
 * The header carries the palettes (RGB for day, and DAY, DSK, NGT and the
 * rest), reference points (REF: pixel and latitude, longitude), the chart's
 * border (PLY), a datum shift (DTM, seconds of arc) and, often, polynomials
 * between pixels and positions (WPX, WPY, PWX, PWY).
 */
import type { LatLon } from '../types'

export interface BsbPolynomial {
  order: number
  c: number[]
}

export interface BsbHeader {
  name: string
  number: string
  width: number
  height: number
  /** 1:n, from KNP/SC. */
  scale: number
  projection: string
  /** The projection parameter (KNP/PP): for Mercator, the latitude of true scale. */
  projectionParam: number | null
  datum: string
  /** Palettes by name (RGB, DAY, DSK, NGT, NGR, GRY, PRC, PRG); index 0 unused, as colours count from one. */
  palettes: Record<string, Array<[number, number, number]>>
  refs: Array<{ x: number; y: number; lat: number; lon: number }>
  border: LatLon[]
  /** Datum shift in seconds of arc, added to positions from the chart. */
  dtm: { lat: number; lon: number }
  /** World to pixel (WPX, WPY: pixel x and y from longitude and latitude) and pixel to world (PWX, PWY), when the header has them. */
  wpx: BsbPolynomial | null
  wpy: BsbPolynomial | null
  pwx: BsbPolynomial | null
  pwy: BsbPolynomial | null
  /** Bits per pixel from IFM, if given. */
  depth: number | null
}

export interface BsbChart {
  header: BsbHeader
  width: number
  height: number
  /** Palette index per pixel, row by row from the top. */
  pixels: Uint8Array
  warnings: string[]
}

const PALETTES = new Set(['RGB', 'DAY', 'DSK', 'NGT', 'NGR', 'GRY', 'PRC', 'PRG'])

/** The header's records, continuation lines (starting with spaces) joined on. */
function records(text: string): Array<{ tag: string; body: string }> {
  const out: Array<{ tag: string; body: string }> = []
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim() || raw.startsWith('!')) continue
    if (/^\s/.test(raw) && out.length) {
      // A continuation is the record's next item. NOAA's charts wrap between items
      // without a comma at either end, so one is put back when neither side has it.
      const prev = out[out.length - 1]
      const more = raw.trim()
      prev.body += prev.body.endsWith(',') || more.startsWith(',') ? more : `,${more}`
      continue
    }
    const m = /^([A-Z0-9]{3})\/(.*)$/.exec(raw.trim())
    if (m) out.push({ tag: m[1], body: m[2] })
  }
  return out
}

/** KEY=VALUE pairs, where values can themselves hold commas (RA=w,h). */
function keyed(body: string): Record<string, string> {
  const out: Record<string, string> = {}
  let key = ''
  for (const part of body.split(',')) {
    const m = /^\s*([A-Z]{2})=(.*)$/.exec(part)
    if (m) {
      key = m[1]
      out[key] = m[2].trim()
    } else if (key) out[key] += `,${part.trim()}`
  }
  return out
}

const nums = (body: string) => body.split(',').map((v) => Number(v.trim()))

function polynomial(body: string): BsbPolynomial | null {
  const v = nums(body)
  if (v.length < 4 || v.some((x) => !Number.isFinite(x))) return null
  return { order: v[0], c: v.slice(1) }
}

export function parseBsbHeader(text: string): BsbHeader {
  const h: BsbHeader = {
    name: '', number: '', width: 0, height: 0, scale: 0, projection: '', projectionParam: null, datum: '',
    palettes: {}, refs: [], border: [], dtm: { lat: 0, lon: 0 }, wpx: null, wpy: null, pwx: null, pwy: null, depth: null,
  }
  for (const { tag, body } of records(text)) {
    if (tag === 'BSB' || tag === 'NOS') {
      const k = keyed(body)
      h.name = k.NA ?? h.name
      h.number = k.NU ?? h.number
      if (k.RA) {
        const [w, hh] = nums(k.RA)
        h.width = w
        h.height = hh
      }
    } else if (tag === 'KNP') {
      const k = keyed(body)
      h.scale = Number(k.SC) || h.scale
      h.projection = (k.PR ?? h.projection).toUpperCase()
      h.projectionParam = k.PP != null && Number.isFinite(Number(k.PP)) ? Number(k.PP) : h.projectionParam
      h.datum = k.GD ?? h.datum
    } else if (PALETTES.has(tag)) {
      const [i, r, g, b] = nums(body)
      if (i > 0 && i < 256) (h.palettes[tag] ??= [])[i] = [r, g, b]
    } else if (tag === 'REF') {
      const [, x, y, lat, lon] = nums(body)
      if ([x, y, lat, lon].every(Number.isFinite)) h.refs.push({ x, y, lat, lon })
    } else if (tag === 'PLY') {
      const [, lat, lon] = nums(body)
      if (Number.isFinite(lat) && Number.isFinite(lon)) h.border.push({ lat, lon })
    } else if (tag === 'DTM') {
      const [lat, lon] = nums(body)
      h.dtm = { lat: lat || 0, lon: lon || 0 }
    } else if (tag === 'IFM') {
      h.depth = Number(body) || null
    } else if (tag === 'WPX') h.wpx = polynomial(body)
    else if (tag === 'WPY') h.wpy = polynomial(body)
    else if (tag === 'PWX') h.pwx = polynomial(body)
    else if (tag === 'PWY') h.pwy = polynomial(body)
  }
  return h
}

/** Where the header ends: after its Ctrl-Z (0x1A), and the NUL that follows it. */
function headerEnd(b: Uint8Array): number {
  for (let i = 0; i < b.length - 1; i++) if (b[i] === 0x1a && b[i + 1] === 0x00) return i + 2
  return -1
}

export function isBsb(b: Uint8Array): boolean {
  const head = String.fromCharCode(...b.subarray(0, 256))
  return /(^|\n)(BSB|NOS|VER)\//.test(head) || /^!/.test(head)
}

export function decodeBsb(input: Uint8Array | ArrayBuffer): BsbChart {
  const b = input instanceof Uint8Array ? input : new Uint8Array(input)
  const end = headerEnd(b)
  if (end < 0) throw new Error('not a BSB/KAP chart: no end to the header')
  let text = ''
  for (let i = 0; i < end - 2; i++) text += String.fromCharCode(b[i])
  const header = parseBsbHeader(text)
  const { width, height } = header
  if (!(width > 0 && height > 0)) throw new Error('not a BSB/KAP chart: no size (BSB/RA)')
  const warnings: string[] = []
  const depth = b[end]
  if (!(depth >= 1 && depth <= 7)) throw new Error(`BSB/KAP: ${depth} bits per pixel is not a depth this reads`)
  if (header.depth && header.depth !== depth) warnings.push(`IFM says ${header.depth} bits a pixel, the picture ${depth}`)
  const shift = 7 - depth
  const valueMask = ((1 << depth) - 1) << shift
  const countMask = (1 << shift) - 1
  const pixels = new Uint8Array(width * height)
  let at = end + 1
  let row = 0
  let first: number | null = null
  while (row < height && at < b.length) {
    // The row number, seven bits a byte.
    let n = 0
    let byte: number
    do {
      byte = b[at++]
      n = n * 128 + (byte & 0x7f)
    } while (byte & 0x80 && at < b.length)
    // Rows count from one in most files, from zero in some.
    first ??= n
    if (n - first !== row && !warnings.some((w) => w.startsWith('rows out of order'))) warnings.push(`rows out of order: row ${row + first} is numbered ${n}`)
    let x = 0
    const base = row * width
    while (at < b.length) {
      byte = b[at++]
      if (byte === 0) break
      const value = (byte & valueMask) >> shift
      let count = byte & countMask
      while (byte & 0x80 && at < b.length) {
        byte = b[at++]
        count = count * 128 + (byte & 0x7f)
      }
      const stop = Math.min(width, x + count + 1)
      pixels.fill(value, base + x, base + stop)
      x = stop
    }
    row++
  }
  if (row < height) warnings.push(`the picture stops after ${row} of ${height} rows`)
  return { header, width, height, pixels, warnings }
}

// ------------------------------------------------------------ georeferencing

const RAD = Math.PI / 180
const mercY = (lat: number) => Math.log(Math.tan(Math.PI / 4 + (lat * RAD) / 2))
const invMercY = (y: number) => (2 * Math.atan(Math.exp(y)) - Math.PI / 2) / RAD

/** A least-squares fit of v = a + b·u, with its residuals. */
function fit1(u: number[], v: number[]): { a: number; b: number } {
  const n = u.length
  const mu = u.reduce((s, x) => s + x, 0) / n
  const mv = v.reduce((s, x) => s + x, 0) / n
  let suu = 0
  let suv = 0
  for (let i = 0; i < n; i++) {
    suu += (u[i] - mu) ** 2
    suv += (u[i] - mu) * (v[i] - mv)
  }
  const b = suu ? suv / suu : 0
  return { a: mv - b * mu, b }
}

/** BSB's cubic: c0 + c1·a + c2·b + c3·a² + c4·ab + c5·b² + c6·a³ + c7·a²b + c8·ab² + c9·b³. */
function poly(p: BsbPolynomial, a: number, b: number): number {
  const t = [1, a, b, a * a, a * b, b * b, a * a * a, a * a * b, a * b * b, b * b * b]
  let s = 0
  for (let i = 0; i < p.c.length && i < t.length; i++) s += p.c[i] * t[i]
  return s
}

export interface BsbGeoref {
  /** A pixel (x right, y down, from the top-left corner) to a position, datum shift applied. */
  toLatLon(x: number, y: number): LatLon
  toPixel(p: LatLon): { x: number; y: number }
  /** How far the reference points sit from where the fit puts them, pixels (RMS). */
  rmsPx: number
  method: 'mercator' | 'polynomial' | 'linear'
}

/**
 * The chart's georeferencing: for a Mercator chart, a fit of the reference
 * points in Mercator (longitude and Mercator latitude each linear in pixels);
 * otherwise the header's polynomials; failing those, a linear fit.
 */
export function bsbGeoref(h: BsbHeader): BsbGeoref {
  const sh = { lat: h.dtm.lat / 3600, lon: h.dtm.lon / 3600 }
  const refs = h.refs
  const usePoly = h.projection !== 'MERCATOR' && h.wpx && h.wpy && h.pwx && h.pwy
  if (refs.length < 2 && !usePoly) throw new Error('BSB/KAP: fewer than two reference points (REF)')
  let toLatLon: (x: number, y: number) => LatLon
  let toPixel: (p: LatLon) => { x: number; y: number }
  let method: BsbGeoref['method']
  if (usePoly) {
    method = 'polynomial'
    toLatLon = (x, y) => ({ lat: poly(h.pwy!, x, y) + sh.lat, lon: poly(h.pwx!, x, y) + sh.lon })
    toPixel = (p) => ({ x: poly(h.wpx!, p.lon - sh.lon, p.lat - sh.lat), y: poly(h.wpy!, p.lon - sh.lon, p.lat - sh.lat) })
  } else {
    const merc = h.projection === 'MERCATOR' || !h.projection
    method = merc ? 'mercator' : 'linear'
    const f = (lat: number) => (merc ? mercY(lat) : lat)
    const g = (v: number) => (merc ? invMercY(v) : v)
    const lonFit = fit1(refs.map((r) => r.x), refs.map((r) => r.lon))
    const latFit = fit1(refs.map((r) => r.y), refs.map((r) => f(r.lat)))
    toLatLon = (x, y) => ({ lat: g(latFit.a + latFit.b * y) + sh.lat, lon: lonFit.a + lonFit.b * x + sh.lon })
    toPixel = (p) => ({ x: (p.lon - sh.lon - lonFit.a) / lonFit.b, y: (f(p.lat - sh.lat) - latFit.a) / latFit.b })
  }
  let ss = 0
  for (const r of refs) {
    const q = toPixel({ lat: r.lat + sh.lat, lon: r.lon + sh.lon })
    ss += (q.x - r.x) ** 2 + (q.y - r.y) ** 2
  }
  return { toLatLon, toPixel, rmsPx: refs.length ? Math.sqrt(ss / refs.length) : 0, method }
}

/** The chart's corners, top-left, top-right, bottom-right, bottom-left, as [lon, lat] for a map image source. */
export function bsbCorners(c: { width: number; height: number }, geo: BsbGeoref): [[number, number], [number, number], [number, number], [number, number]] {
  const at = (x: number, y: number): [number, number] => {
    const p = geo.toLatLon(x, y)
    return [p.lon, p.lat]
  }
  return [at(0, 0), at(c.width, 0), at(c.width, c.height), at(0, c.height)]
}

/**
 * The chart as RGBA in one of its palettes, shrunk by a whole factor so its
 * longer side is at most `maxSide` (a map texture has a limit). Nearest pixel,
 * so the chart's colours stay its own.
 */
export function bsbToRgba(c: BsbChart, palette = 'RGB', maxSide = 4096): { width: number; height: number; data: Uint8ClampedArray; factor: number } {
  const pal = c.header.palettes[palette] ?? c.header.palettes.RGB ?? []
  const factor = Math.max(1, Math.ceil(Math.max(c.width, c.height) / maxSide))
  const w = Math.floor(c.width / factor)
  const h = Math.floor(c.height / factor)
  const data = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) {
    const src = y * factor * c.width
    for (let x = 0; x < w; x++) {
      const rgb = pal[c.pixels[src + x * factor]]
      const i = (y * w + x) * 4
      if (rgb) {
        data[i] = rgb[0]
        data[i + 1] = rgb[1]
        data[i + 2] = rgb[2]
        data[i + 3] = 255
      }
    }
  }
  return { width: w, height: h, data, factor }
}
